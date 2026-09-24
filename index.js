'use strict'

const { RelayBank } = require('./lib/bank')
const { N2kSwitchBank } = require('./lib/n2k')

const PLUGIN_ID = 'signalk-waveshare-relays'
const CHANNELS = 8

const defaultRelays = Array.from({ length: CHANNELS }, (_, i) => ({
  channel: i + 1,
  entity: `Relay ${i + 1}`,
  displayName: `Relay ${i + 1}`
}))

const defaultInputs = Array.from({ length: CHANNELS }, (_, i) => ({
  channel: i + 1,
  entity: `DI${i + 1}`,
  displayName: `Input ${i + 1}`
}))

const channelItems = (entityTitle, entityDescription) => ({
  type: 'object',
  required: ['channel', 'entity'],
  properties: {
    channel: { type: 'integer', title: 'Channel', minimum: 1, maximum: 28 },
    entity: { type: 'string', title: entityTitle, description: entityDescription },
    displayName: { type: 'string', title: 'Display name' }
  }
})

const schema = {
  type: 'object',
  required: ['host'],
  properties: {
    host: {
      type: 'string',
      title: 'Board address',
      description: 'IP address or hostname of the Waveshare board, e.g. 192.168.1.129 or waveshare001.local',
      default: ''
    },
    username: {
      type: 'string',
      title: 'Web server username',
      description: 'Only needed if auth is set in the ESPHome web_server config',
      default: ''
    },
    password: { type: 'string', title: 'Web server password', default: '' },
    bankId: {
      type: 'string',
      title: 'Bank ID',
      description: 'Relays are published at electrical.switches.bank.<Bank ID>.<channel>.state',
      default: 'waveshare'
    },
    stateFormat: {
      type: 'string',
      title: 'State value format',
      enum: ['boolean', 'number'],
      enumNames: ['true / false', '1 / 0'],
      default: 'boolean'
    },
    useEventStream: {
      type: 'boolean',
      title: 'Use the ESPHome event stream for instant state updates',
      default: true
    },
    pollInterval: {
      type: 'number',
      title: 'Poll interval (seconds)',
      description: 'Full state refresh from the board. 0 disables polling.',
      default: 10,
      minimum: 0
    },
    relays: {
      type: 'array',
      title: 'Relays',
      items: channelItems('ESPHome switch name', 'Name of the switch entity in the board\'s ESPHome config'),
      default: defaultRelays
    },
    publishInputs: {
      type: 'boolean',
      title: 'Publish digital inputs',
      description: 'Inputs are published at electrical.digitalInputs.<Bank ID>.<channel>.state',
      default: false
    },
    inputs: {
      type: 'array',
      title: 'Digital inputs',
      items: channelItems('ESPHome binary_sensor name', 'Name of the binary_sensor entity in the board\'s ESPHome config'),
      default: defaultInputs
    },
    nmea2000: {
      type: 'object',
      title: 'NMEA 2000 switch bank',
      description: 'Makes the relays appear on NMEA 2000 as a binary switch bank (PGN 127501 status, 127502 control), using the Signal K server\'s N2K connection.',
      properties: {
        enabled: { type: 'boolean', title: 'Enable', default: false },
        instance: {
          type: 'integer',
          title: 'Switch bank instance',
          description: 'Must be unique among switch banks on the bus',
          minimum: 0,
          maximum: 252,
          default: 0
        },
        statusInterval: {
          type: 'number',
          title: 'Status interval (seconds)',
          description: 'How often PGN 127501 is repeated; it is also sent on every change',
          minimum: 1,
          default: 5
        }
      }
    }
  }
}

function withDefaults (options) {
  const opts = {}
  for (const [key, prop] of Object.entries(schema.properties)) {
    opts[key] = options && options[key] !== undefined ? options[key] : prop.default
  }
  const n2k = schema.properties.nmea2000.properties
  opts.nmea2000 = Object.fromEntries(Object.entries(n2k).map(([key, prop]) => {
    const value = opts.nmea2000 && opts.nmea2000[key]
    return [key, value !== undefined ? value : prop.default]
  }))
  opts.host = String(opts.host || '').trim()
  opts.bankId = String(opts.bankId || '').trim() || 'waveshare'
  opts.relays = validChannels(opts.relays)
  opts.inputs = validChannels(opts.inputs)
  return opts
}

function validChannels (list) {
  const seen = new Set()
  return (Array.isArray(list) ? list : []).filter(item => {
    if (!item || !Number.isInteger(item.channel) || !item.entity || seen.has(item.channel)) return false
    seen.add(item.channel)
    return true
  })
}

module.exports = function (app) {
  let bank = null
  let n2k = null

  const plugin = {
    id: PLUGIN_ID,
    name: 'Waveshare Relay Control',
    description: 'Control Waveshare ESP32-S3-ETH-8DI-8RO relays (ESPHome firmware) from Signal K',
    schema
  }

  plugin.start = function (options) {
    const opts = withDefaults(options)
    if (!opts.host) {
      app.setPluginError('Set the board address in the plugin configuration')
      return
    }
    bank = new RelayBank(app, PLUGIN_ID, opts)
    bank.start()
    if (opts.nmea2000.enabled) {
      n2k = new N2kSwitchBank(app, bank, opts.nmea2000)
      n2k.start()
    }
  }

  plugin.stop = function () {
    if (n2k) n2k.stop()
    if (bank) bank.stop()
    n2k = null
    bank = null
  }

  return plugin
}
