'use strict'

const EventEmitter = require('events')
const { EspHomeClient, entityKeys, parseState } = require('./esphome')
const { BoardSecurity } = require('./security')

// Pause between sequential poll requests; the ESP32 web server copes badly
// with bursts of concurrent requests.
const REQUEST_GAP_MS = 100
// Minimum time between admin password checks.
const SECURITY_RECHECK_MS = 10000
// The prebuilt firmware's security status entity.
const SECURITY_KEYS = new Set(entityKeys('text_sensor', 'Security'))

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
  constructor (app, pluginId, opts, client, passwordStore) {
    super()
    this.app = app
    this.pluginId = pluginId
    this.opts = opts
    this.client = client || new EspHomeClient(opts)
    this.security = new BoardSecurity(this.client, opts, passwordStore, msg => app.debug(msg))
    this.securityResult = null
    this.securityRunning = false
    this.securityAgain = false
    this.securityLast = 0
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
    this.status = null
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
    this.checkSecurity(true)
    this.poll()
    this.reportStatus()
  }

  // Checks the board's admin password and sets or changes it to match the
  // configuration. Runs at most every SECURITY_RECHECK_MS unless forced.
  async checkSecurity (force = false) {
    if (!this.running) return
    if (this.securityRunning) {
      // E.g. the board was reset while its password was being set: check
      // again once this check finishes.
      if (force) this.securityAgain = true
      return
    }
    if (!force && Date.now() - this.securityLast < SECURITY_RECHECK_MS) return
    this.securityRunning = true
    this.securityAgain = false
    this.securityLast = Date.now()
    try {
      const result = await this.security.check()
      // Keep "admin password set on the board" until there is news.
      const previous = this.securityResult
      const quiet = result.level === 'ok' && !result.text && previous && previous.level === 'ok'
      if (!quiet) this.securityResult = result
    } catch (err) {
      // Usually the board can't be reached; the stream and poll report that.
      this.app.debug(`${this.opts.host}: admin password check failed: ${err.message}`)
    } finally {
      this.securityRunning = false
      if (this.running) this.reportStatus()
    }
    if (this.securityAgain) this.checkSecurity(true)
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
    if (SECURITY_KEYS.has(msg.id) || SECURITY_KEYS.has(msg.name_id)) {
      // The board was reset to no password (BOOT button): set it again.
      const value = typeof msg.value === 'string' ? msg.value : msg.state
      if (typeof value === 'string' && value.startsWith('OPEN')) this.checkSecurity(true)
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
    if (connected || (err && err.status === 401)) this.checkSecurity()
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
      if (err.status === 401) this.checkSecurity()
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

  // Updates this.status ({ error, text }) and emits 'status' when it changes.
  reportStatus () {
    const { host, pollInterval } = this.opts
    let error = false
    let text
    if (this.streamConnected) {
      text = `Connected to ${host} (live updates)`
    } else if (this.pollError) {
      error = true
      text = `Cannot reach ${host}: ${this.pollError}`
    } else if (this.streamError && !(pollInterval > 0)) {
      error = true
      text = `Event stream from ${host} failed: ${this.streamError}`
    } else if (this.pollOk) {
      text = `Connected to ${host} (polling every ${pollInterval} s)`
    } else {
      text = `Connecting to ${host}…`
    }
    const security = this.securityResult
    if (security && security.level === 'error') {
      error = true
      text = `${host}: ${security.text}`
    } else if (security && security.text) {
      text += `; ${security.text}`
    }
    if (this.status && this.status.error === error && this.status.text === text) return
    this.status = { error, text }
    this.emit('status', this.status)
  }
}

module.exports = { RelayBank, toBool }
