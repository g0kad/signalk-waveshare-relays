'use strict'

// Admin password handling for boards running this project's prebuilt
// firmware (firmware/waveshare-relays.yaml). The password is stored on the
// board, and until one is set the board is open. The plugin sets the password
// from its configuration, and changes it when the configuration changes.
// Boards running other ESPHome configs are left alone.

const fs = require('fs')
const path = require('path')

const ADMIN_USER = 'admin'
const MIN_PASSWORD = 8
const MAX_PASSWORD = 63
const SECURITY_PATH = '/text_sensor/Security'
const PASSWORD_PATH = '/text/Admin%20Password/set'
const RESET_HINT = 'If the password has been forgotten, hold the board\'s BOOT button for 10 seconds to clear it.'

function basicAuth (username, password) {
  return { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` }
}

// Remembers the last password that worked for each board, so that changing
// the password in the plugin configuration can also change it on the board.
class PasswordStore {
  constructor (file) {
    this.file = file
  }

  read () {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch (err) {
      return {}
    }
  }

  get (host) {
    return this.read()[host]
  }

  set (host, password) {
    const all = this.read()
    if (all[host] === password) return
    all[host] = password
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(all, null, 2), { mode: 0o600 })
  }
}

// check() resolves to { level: 'ok' | 'warning' | 'error', text } where text
// is empty when there is nothing worth reporting.
class BoardSecurity {
  constructor (client, { host, username, password }, store, debug = () => {}) {
    this.client = client
    this.host = host
    this.username = username || ADMIN_USER
    this.password = password || ''
    this.store = store
    this.debug = debug
  }

  async securityState (headers) {
    const res = await this.client.send('GET', SECURITY_PATH, headers)
    let value = null
    if (res.ok) {
      try {
        const body = await res.json()
        value = typeof body.value === 'string' ? body.value : body.state
      } catch (err) {}
    } else {
      await res.arrayBuffer()
    }
    return { status: res.status, value }
  }

  async setPassword (headers) {
    const query = `?value=${encodeURIComponent(this.password)}`
    const res = await this.client.send('POST', PASSWORD_PATH + query, headers)
    await res.arrayBuffer()
    if (!res.ok) throw new Error(`setting the admin password returned HTTP ${res.status}`)
    const check = await this.securityState(basicAuth(ADMIN_USER, this.password))
    if (check.status !== 200 || check.value !== 'Protected') {
      throw new Error('the board did not accept the new admin password')
    }
    this.remember()
  }

  remember () {
    if (this.store && this.password) this.store.set(this.host, this.password)
  }

  async check () {
    const anon = await this.securityState({})

    // Not this project's firmware: nothing to manage.
    if (anon.status === 404) return { level: 'ok', text: '' }

    if (anon.status === 200) {
      if (!this.password) {
        return { level: 'warning', text: 'the board has no admin password, so anyone on the network can switch it. Set one under Admin password.' }
      }
      if (this.password.length < MIN_PASSWORD || this.password.length > MAX_PASSWORD) {
        return { level: 'error', text: `the admin password must be ${MIN_PASSWORD}–${MAX_PASSWORD} characters` }
      }
      await this.setPassword({})
      this.debug(`${this.host}: admin password set on the board`)
      return { level: 'ok', text: 'admin password set on the board' }
    }

    if (anon.status !== 401) throw new Error(`GET ${SECURITY_PATH} returned HTTP ${anon.status}`)

    const own = await this.securityState(basicAuth(this.username, this.password))
    if (own.status === 200 || own.status === 404) {
      if (own.status === 200) this.remember()
      return { level: 'ok', text: '' }
    }

    // The configured password was rejected. If the password that last worked
    // still does, the configuration has changed: change it on the board too.
    const previous = this.store && this.store.get(this.host)
    if (this.password && previous && previous !== this.password) {
      const old = basicAuth(ADMIN_USER, previous)
      if ((await this.securityState(old)).status === 200) {
        if (this.password.length < MIN_PASSWORD || this.password.length > MAX_PASSWORD) {
          return { level: 'error', text: `the admin password must be ${MIN_PASSWORD}–${MAX_PASSWORD} characters` }
        }
        await this.setPassword(old)
        this.debug(`${this.host}: admin password changed on the board`)
        return { level: 'ok', text: 'admin password changed on the board' }
      }
    }

    return {
      level: 'error',
      text: this.password
        ? `the board rejected the admin password. ${RESET_HINT}`
        : `the board needs a password. Enter it under Admin password. ${RESET_HINT}`
    }
  }
}

module.exports = { BoardSecurity, PasswordStore, basicAuth, ADMIN_USER, MIN_PASSWORD, MAX_PASSWORD }
