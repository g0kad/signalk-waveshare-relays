'use strict'

// Presents a RelayBank on NMEA 2000 as a binary switch bank:
//   PGN 127502 Switch Bank Control  -> switches the relays
//   PGN 127501 Binary Switch Bank Status <- reports relay state
// N2K traffic goes through the Signal K server's own N2K connection.

const PGN_STATUS = 127501
const PGN_CONTROL = 127502
// Collects bursts of relay changes (e.g. the event stream's initial dump)
// into a single status message.
const COALESCE_MS = 50

function switchCommand (value) {
  if (value === 'On' || value === 1) return true
  if (value === 'Off' || value === 0) return false
  return null // "Take no action (no change)", Error, missing
}

class N2kSwitchBank {
  constructor (app, bank, { instance, statusInterval }) {
    this.app = app
    this.bank = bank
    this.instance = instance
    this.statusInterval = statusInterval
    this.timer = null
    this.pending = null
    this.onN2k = msg => this.handleMessage(msg)
    this.onChange = () => this.scheduleStatus()
  }

  start () {
    this.app.on('N2KAnalyzerOut', this.onN2k)
    this.app.on('nmea2000OutAvailable', this.onChange)
    this.bank.on('relay', this.onChange)
    if (this.statusInterval > 0) {
      this.timer = setInterval(() => this.sendStatus(), this.statusInterval * 1000)
    }
    this.scheduleStatus()
  }

  stop () {
    this.app.removeListener('N2KAnalyzerOut', this.onN2k)
    this.app.removeListener('nmea2000OutAvailable', this.onChange)
    this.bank.removeListener('relay', this.onChange)
    clearInterval(this.timer)
    clearTimeout(this.pending)
  }

  handleMessage (msg) {
    if (!msg || msg.pgn !== PGN_CONTROL || !msg.fields) return
    const fields = msg.fields
    const instance = fields.instance !== undefined ? fields.instance : fields.Instance
    if (instance !== this.instance) return

    let acted = false
    for (const relay of this.bank.relays) {
      const key = `switch${relay.channel}`
      const on = switchCommand(fields[key] !== undefined ? fields[key] : fields[`Switch${relay.channel}`])
      if (on === null) continue
      acted = true
      if (this.bank.relayState.get(relay.channel) === on) continue
      this.app.debug(`N2K 127502 from ${msg.src}: channel ${relay.channel} ${on ? 'on' : 'off'}`)
      this.bank.setRelay(relay.channel, on).catch(err => {
        this.app.error(`N2K command for channel ${relay.channel} failed: ${err.message}`)
        this.scheduleStatus()
      })
    }
    // Controllers expect a status reply; if nothing changed no 'relay'
    // event will trigger one.
    if (acted) this.scheduleStatus()
  }

  scheduleStatus () {
    if (this.pending) return
    this.pending = setTimeout(() => {
      this.pending = null
      this.sendStatus()
    }, COALESCE_MS)
  }

  statusFields () {
    const fields = { instance: this.instance }
    const online = this.bank.isOnline()
    for (const relay of this.bank.relays) {
      const on = this.bank.relayState.get(relay.channel)
      fields[`indicator${relay.channel}`] = !online || on === undefined ? 'Unavailable' : on ? 'On' : 'Off'
    }
    return fields
  }

  sendStatus () {
    this.app.emit('nmea2000JsonOut', { pgn: PGN_STATUS, prio: 3, dst: 255, fields: this.statusFields() })
  }
}

module.exports = { N2kSwitchBank, switchCommand, PGN_STATUS, PGN_CONTROL }
