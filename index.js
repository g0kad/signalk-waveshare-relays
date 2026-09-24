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

const boardSchema = {
  type: 'object',
  required: ['host', 'bankId'],
  properties: {
    enabled: { type: 'boolean', title: 'Enabled', default: true },
    host: {
      type: 'string',
      title: 'Board address',
      description: 'IP address or hostname of the Waveshare board, e.g. 192.168.1.129 or waveshare001.local',
      default: ''
    },
    bankId: {
      type: 'string',
      title: 'Bank ID',
      description: 'Unique per board. Relays are published at electrical.switches.bank.<Bank ID>.<channel>.state',
      default: 'waveshare'
    },
    username: {
      type: 'string',
      title: 'Web server username',
      description: 'Only needed if auth is set in the ESPHome web_server config',
      default: ''
    },
    password: { type: 'string', title: 'Web server password', default: '' },
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
        }
      }
    }
  }
}

const schema = {
  type: 'object',
  properties: {
    boards: {
      type: 'array',
      title: 'Boards',
      items: boardSchema,
      default: [{}]
    },
    stateFormat: {
      type: 'string',
      title: 'State value format',
      enum: ['boolean', 'number'],
      enumNames: ['true / false', '1 / 0'],
      default: 'boolean'
    },
    n2kStatusInterval: {
      type: 'number',
      title: 'NMEA 2000 status interval (seconds)',
      description: 'How often PGN 127501 is repeated for each N2K-enabled board; it is also sent on every change',
      minimum: 1,
      default: 5
    }
  }
}

// Fills in schema defaults, recursing into nested objects (not arrays).
function applyDefaults (properties, value) {
  const out = {}
  for (const [key, prop] of Object.entries(properties)) {
    const v = value ? value[key] : undefined
    if (prop.type === 'object' && prop.properties) out[key] = applyDefaults(prop.properties, v)
    else out[key] = v !== undefined ? v : prop.default
  }
  return out
}

function validChannels (list) {
  const seen = new Set()
  return (Array.isArray(list) ? list : []).filter(item => {
    if (!item || !Number.isInteger(item.channel) || !item.entity || seen.has(item.channel)) return false
    seen.add(item.channel)
    return true
  })
}

function normalize (options) {
  const opts = applyDefaults(schema.properties, options)
  opts.boards = (Array.isArray(opts.boards) ? opts.boards : []).map(raw => {
    const board = applyDefaults(boardSchema.properties, raw)
    board.host = String(board.host || '').trim()
    board.bankId = String(board.bankId || '').trim()
    board.relays = validChannels(board.relays)
    board.inputs = validChannels(board.inputs)
    board.stateFormat = opts.stateFormat
    board.nmea2000.statusInterval = opts.n2kStatusInterval
    return board
  })
  return opts
}

module.exports = function (app) {
  let runs = []
  let problems = []

  const plugin = {
    id: PLUGIN_ID,
    name: 'Waveshare Relay Control',
    description: 'Control Waveshare ESP32-S3-ETH-8DI-8RO relays (ESPHome firmware) from Signal K and NMEA 2000',
    schema
  }

  function reportStatus () {
    const parts = [...problems, ...runs.map(r => `${r.bank.opts.bankId}: ${r.bank.status.text}`)]
    if (!parts.length) return app.setPluginStatus('No boards enabled')
    if (problems.length || runs.some(r => r.bank.status.error)) app.setPluginError(parts.join('; '))
    else app.setPluginStatus(parts.join('; '))
  }

  plugin.start = function (options) {
    const opts = normalize(options)
    const bankIds = new Set()
    const instances = new Set()
    runs = []
    problems = []

    opts.boards.forEach((board, i) => {
      const label = board.bankId || `Board ${i + 1}`
      if (!board.enabled) return
      if (!board.host) return problems.push(`${label}: set the board address`)
      if (!board.bankId) return problems.push(`${label}: set a bank ID`)
      if (bankIds.has(board.bankId)) return problems.push(`${label}: bank ID is used by another board`)
      bankIds.add(board.bankId)

      const bank = new RelayBank(app, PLUGIN_ID, board)
      bank.on('status', reportStatus)
      const run = { bank, n2k: null }
      runs.push(run)
      bank.start()

      if (board.nmea2000.enabled) {
        if (instances.has(board.nmea2000.instance)) {
          problems.push(`${label}: NMEA 2000 instance ${board.nmea2000.instance} is used by another board`)
        } else {
          instances.add(board.nmea2000.instance)
          run.n2k = new N2kSwitchBank(app, bank, board.nmea2000)
          run.n2k.start()
        }
      }
    })
    reportStatus()
  }

  plugin.stop = function () {
    for (const { bank, n2k } of runs) {
      if (n2k) n2k.stop()
      bank.stop()
    }
    runs = []
    problems = []
  }

  return plugin
}
