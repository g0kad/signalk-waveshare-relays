'use strict'

const path = require('path')
const { RelayBank } = require('./lib/bank')
const { N2kSwitchBank } = require('./lib/n2k')
const { Discovery } = require('./lib/discovery')
const { PasswordStore, ADMIN_USER } = require('./lib/security')

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
      description: 'Hostname or IP address of the board, e.g. waveshare-relays-21e150.local. Use the hostname if the board has both Ethernet and Wi-Fi, so the plugin follows it from one to the other.',
      default: ''
    },
    bankId: {
      type: 'string',
      title: 'Bank ID',
      description: 'Unique per board. Relays are published at electrical.switches.bank.<Bank ID>.<channel>.state',
      default: 'waveshare'
    },
    password: {
      type: 'string',
      title: 'Admin password',
      description: 'Prebuilt firmware: choose a password (8 to 63 characters) and the plugin sets it on the board. To change it, change it here. Other ESPHome configs: the web_server auth password, if any.',
      default: ''
    },
    username: {
      type: 'string',
      title: 'Web server username',
      description: `Leave empty for the prebuilt firmware, which uses "${ADMIN_USER}". Other ESPHome configs: the web_server auth username, if any.`,
      default: ''
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

// The schema shown in the admin UI, listing boards found on the network.
function schemaWithDiscovered (found, configuredHosts) {
  if (!found.length) {
    return {
      ...schema,
      description: 'No boards with the prebuilt firmware were found on the network yet. Boards with other ESPHome configs can still be added by address.'
    }
  }
  const lines = found.map(b => {
    const where = b.addresses.length ? ` (${b.addresses.join(', ')})` : ''
    const added = configuredHosts.has(b.host) ? '' : ' (not added yet)'
    return `${b.host}${where}${added}`
  })
  const host = { ...boardSchema.properties.host, examples: found.map(b => b.host) }
  const items = { ...boardSchema, properties: { ...boardSchema.properties, host } }
  return {
    ...schema,
    description: `Boards found on the network: ${lines.join('; ')}`,
    properties: { ...schema.properties, boards: { ...schema.properties.boards, items } }
  }
}

const uiSchema = {
  boards: {
    items: {
      password: { 'ui:widget': 'password' }
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
    board.username = String(board.username || '').trim()
    board.relays = validChannels(board.relays)
    board.inputs = validChannels(board.inputs)
    board.stateFormat = opts.stateFormat
    board.nmea2000.statusInterval = opts.n2kStatusInterval
    return board
  })
  return opts
}

module.exports = function (app, options = {}) {
  let runs = []
  let problems = []
  let configuredHosts = new Set()
  const discovery = options.discovery || new Discovery(msg => app.debug(msg))
  const passwordStore = typeof app.getDataDirPath === 'function'
    ? new PasswordStore(path.join(app.getDataDirPath(), 'passwords.json'))
    : null

  const plugin = {
    id: PLUGIN_ID,
    name: 'Waveshare Relay Control',
    description: 'Control Waveshare ESP32-S3-ETH-8DI-8RO relays (ESPHome firmware) from Signal K and NMEA 2000',
    // A function so the admin UI shows the boards found so far. Opening the
    // configuration also starts discovery if the plugin isn't running.
    schema () {
      discovery.start()
      return schemaWithDiscovered(discovery.list(), configuredHosts)
    },
    uiSchema
  }

  function reportStatus () {
    const parts = [...problems, ...runs.map(r => `${r.bank.opts.bankId}: ${r.bank.status.text}`)]
    if (!parts.length) return app.setPluginStatus('No boards enabled')
    if (problems.length || runs.some(r => r.bank.status.error)) app.setPluginError(parts.join('; '))
    else app.setPluginStatus(parts.join('; '))
  }

  plugin.start = function (options) {
    const opts = normalize(options)
    discovery.start()
    configuredHosts = new Set(opts.boards.map(b => b.host.toLowerCase()))
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

      const bank = new RelayBank(app, PLUGIN_ID, board, null, passwordStore)
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
    discovery.stop()
  }

  return plugin
}
