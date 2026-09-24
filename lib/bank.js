'use strict'

const EventEmitter = require('events')
const { EspHomeClient, entityKeys, parseState } = require('./esphome')

// Pause between sequential poll requests; the ESP32 web server copes badly
// with bursts of concurrent requests.
const REQUEST_GAP_MS = 100

function toBool (value) {
  if (value === true || value === 1) return true
  if (value === false || value === 0) return false
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (['on', 'true', '1'].includes(v)) return true
    if (['off', 'false', '0'].includes(v)) return false
  }
  return null
}

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Runtime for one Waveshare board: Signal K PUT handlers, ESPHome event
// stream and polling, and delta publishing.
//
// Emits 'relay' (channel, on, previous) whenever a relay's known state
// changes, for other bridges (e.g. NMEA 2000) to follow.
class RelayBank extends EventEmitter {
  constructor (app, pluginId, opts, client) {
    super()
    this.app = app
    this.pluginId = pluginId
    this.opts = opts
    this.client = client || new EspHomeClient(opts)
    this.relays = opts.relays
    this.inputs = opts.publishInputs ? opts.inputs : []
    this.relayState = new Map()
    this.inputState = new Map()
    this.index = new Map()
    for (const relay of this.relays) {
      for (const key of entityKeys('switch', relay.entity)) this.index.set(key, { kind: 'relay', channel: relay.channel })
    }
    for (const input of this.inputs) {
      for (const key of entityKeys('binary_sensor', input.entity)) this.index.set(key, { kind: 'input', channel: input.channel })
    }
    this.unmapped = new Set()
    this.running = false
    this.polling = false
    this.pollTimer = null
    this.stopEvents = null
    this.streamConnected = false
    this.streamError = null
    this.pollError = null
    this.pollOk = false
    this.lastStatus = null
  }

  relayPath (channel) {
    return `electrical.switches.bank.${this.opts.bankId}.${channel}.state`
  }

  inputPath (channel) {
    return `electrical.digitalInputs.${this.opts.bankId}.${channel}.state`
  }

  start () {
    this.running = true
    this.publishMeta()

    for (const relay of this.relays) {
      this.app.registerPutHandler('vessels.self', this.relayPath(relay.channel),
        (context, path, value, cb) => this.handlePut(relay, value, cb))
    }

    if (this.opts.useEventStream) {
      this.stopEvents = this.client.startEvents(
        event => this.handleEvent(event),
        (connected, err) => this.handleStreamStatus(connected, err))
    }

    if (this.opts.pollInterval > 0) {
      this.pollTimer = setInterval(() => this.poll(), this.opts.pollInterval * 1000)
    }
    this.poll()
    this.reportStatus()
  }

  stop () {
    this.running = false
    clearInterval(this.pollTimer)
    if (this.stopEvents) this.stopEvents()
    this.removeAllListeners()
  }

  handlePut (relay, value, cb) {
    const on = toBool(value)
    if (on === null) {
      return {
        state: 'COMPLETED',
        statusCode: 400,
        message: `Invalid value ${JSON.stringify(value)}: expected true/false, 1/0 or "on"/"off"`
      }
    }
    this.setRelay(relay.channel, on)
      .then(() => cb({ state: 'COMPLETED', statusCode: 200 }))
      .catch(err => cb({ state: 'COMPLETED', statusCode: 502, message: err.message }))
    return { state: 'PENDING' }
  }

  async setRelay (channel, on) {
    const relay = this.relays.find(r => r.channel === channel)
    if (!relay) throw new Error(`No relay configured on channel ${channel}`)
    if (!this.running) throw new Error('Plugin is stopped')
    await this.client.setSwitch(relay.entity, on)
    let actual = on
    try {
      const reported = await this.client.getSwitch(relay.entity)
      if (reported !== null) actual = reported
    } catch (err) {
      this.app.debug(`Read-back of ${relay.entity} failed: ${err.message}`)
    }
    if (actual !== on) this.app.debug(`${relay.entity} reports ${actual ? 'on' : 'off'} after turning it ${on ? 'on' : 'off'}`)
    this.updateRelay(channel, actual)
  }

  handleEvent ({ event, data }) {
    if (event !== 'state' || !this.running) return
    let msg
    try {
      msg = JSON.parse(data)
    } catch (err) {
      return
    }
    const target = this.lookup(msg)
    if (!target) {
      if (msg.id && !this.unmapped.has(msg.id)) {
        this.unmapped.add(msg.id)
        this.app.debug(`Ignoring ESPHome entity ${msg.id}${msg.name ? ` ("${msg.name}")` : ''}`)
      }
      return
    }
    const on = parseState(msg)
    if (on === null) return
    if (target.kind === 'relay') this.updateRelay(target.channel, on)
    else this.updateInput(target.channel, on)
  }

  lookup (msg) {
    for (const key of [msg.id, msg.name_id]) {
      if (typeof key === 'string' && this.index.has(key)) return this.index.get(key)
    }
    if (typeof msg.id === 'string' && typeof msg.name === 'string') {
      const domain = msg.id.split(/[-/]/)[0]
      return this.index.get(`${domain}/${msg.name}`) || null
    }
    return null
  }

  // True while relay state is known to be current.
  isOnline () {
    if (this.streamConnected) return true
    if (!(this.opts.pollInterval > 0)) return false
    return this.pollOk && !this.pollError
  }

  handleStreamStatus (connected, err) {
    this.streamConnected = connected
    this.streamError = connected ? null : (err && err.message) || 'disconnected'
    if (!connected) this.app.debug(`ESPHome event stream: ${this.streamError}`)
    this.reportStatus()
  }

  async poll () {
    if (this.polling || !this.running) return
    this.polling = true
    try {
      for (const relay of this.relays) {
        if (!this.running) return
        const on = await this.client.getSwitch(relay.entity)
        if (on !== null) this.updateRelay(relay.channel, on)
        await sleep(REQUEST_GAP_MS)
      }
      for (const input of this.inputs) {
        if (!this.running) return
        const on = await this.client.getBinarySensor(input.entity)
        if (on !== null) this.updateInput(input.channel, on)
        await sleep(REQUEST_GAP_MS)
      }
      this.pollError = null
      this.pollOk = true
    } catch (err) {
      this.pollError = err.cause ? `${err.message} (${err.cause.code || err.cause.message})` : err.message
    } finally {
      this.polling = false
      if (this.running) this.reportStatus()
    }
  }

  updateRelay (channel, on) {
    const previous = this.relayState.get(channel)
    this.relayState.set(channel, on)
    this.sendValue(this.relayPath(channel), on)
    if (previous !== on) this.emit('relay', channel, on, previous)
  }

  updateInput (channel, on) {
    this.inputState.set(channel, on)
    this.sendValue(this.inputPath(channel), on)
  }

  sendValue (path, on) {
    const value = this.opts.stateFormat === 'number' ? (on ? 1 : 0) : on
    this.app.handleMessage(this.pluginId, { updates: [{ values: [{ path, value }] }] })
  }

  publishMeta () {
    const meta = []
    for (const relay of this.relays) {
      if (relay.displayName) meta.push({ path: this.relayPath(relay.channel), value: { displayName: relay.displayName } })
    }
    for (const input of this.inputs) {
      if (input.displayName) meta.push({ path: this.inputPath(input.channel), value: { displayName: input.displayName } })
    }
    if (meta.length) this.app.handleMessage(this.pluginId, { updates: [{ meta }] })
  }

  reportStatus () {
    const { host, pollInterval } = this.opts
    let error = null
    let status = null
    if (this.streamConnected) {
      status = `Connected to ${host} (live updates)`
    } else if (this.pollError) {
      error = `Cannot reach ${host}: ${this.pollError}`
    } else if (this.streamError && !(pollInterval > 0)) {
      error = `Event stream from ${host} failed: ${this.streamError}`
    } else if (this.pollOk) {
      status = `Connected to ${host} (polling every ${pollInterval} s)`
    } else {
      status = `Connecting to ${host}…`
    }
    const key = error ? `E:${error}` : `S:${status}`
    if (key === this.lastStatus) return
    this.lastStatus = key
    if (error) this.app.setPluginError(error)
    else this.app.setPluginStatus(status)
  }
}

module.exports = { RelayBank, toBool }
