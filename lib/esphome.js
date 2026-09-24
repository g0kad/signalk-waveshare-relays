'use strict'

// Minimal client for the ESPHome web_server REST API and its /events
// (Server-Sent Events) stream. Uses Node's built-in fetch (Node 18+).

const DEFAULT_TIMEOUT_MS = 5000
// ESPHome sends a "ping" event roughly every 10 s; if nothing arrives for
// this long the connection is assumed dead and re-established.
const STREAM_IDLE_MS = 35000
const MAX_BACKOFF_MS = 30000

// ESPHome's object_id: the entity name lower-cased, with anything that is
// not a letter or digit collapsed to "_" ("Relay 1" -> "relay_1").
function objectId (name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

// Every id an ESPHome state event may use for an entity: "switch-relay_1"
// (web_server v1/v2) or "switch/Relay 1" (web_server v3 name_id).
function entityKeys (domain, name) {
  return [`${domain}-${objectId(name)}`, `${domain}/${name}`]
}

// Extracts on/off from an ESPHome entity JSON body or state event.
function parseState (body) {
  if (!body || typeof body !== 'object') return null
  if (typeof body.value === 'boolean') return body.value
  if (body.state === 'ON') return true
  if (body.state === 'OFF') return false
  return null
}

function normalizeBaseUrl (host) {
  let url = String(host || '').trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`
  return url
}

// Incremental text/event-stream parser. Call push() with decoded text as it
// arrives; onEvent({ event, data }) fires once per complete event.
function createSseParser (onEvent) {
  let buf = ''
  let event = 'message'
  let data = []

  function line (text) {
    if (text === '') {
      if (data.length) onEvent({ event, data: data.join('\n') })
      event = 'message'
      data = []
      return
    }
    if (text.startsWith(':')) return
    const i = text.indexOf(':')
    const field = i === -1 ? text : text.slice(0, i)
    let value = i === -1 ? '' : text.slice(i + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
  }

  return {
    push (text) {
      buf += text
      let m
      while ((m = /\r\n|\r|\n/.exec(buf)) !== null) {
        // A trailing lone \r may be the first half of \r\n; wait for more.
        if (m[0] === '\r' && m.index === buf.length - 1) break
        line(buf.slice(0, m.index))
        buf = buf.slice(m.index + m[0].length)
      }
    }
  }
}

function sleep (ms, signal) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        resolve()
      }, { once: true })
    }
  })
}

class EspHomeClient {
  constructor ({ host, username, password, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    this.baseUrl = normalizeBaseUrl(host)
    this.timeoutMs = timeoutMs
    this.headers = {}
    if (username) {
      const token = Buffer.from(`${username}:${password || ''}`).toString('base64')
      this.headers.Authorization = `Basic ${token}`
    }
  }

  async request (method, path) {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: this.headers,
      signal: AbortSignal.timeout(this.timeoutMs)
    })
    if (!res.ok) throw new Error(`${method} ${path} returned HTTP ${res.status}`)
    return res
  }

  async getState (domain, name) {
    const res = await this.request('GET', `/${domain}/${encodeURIComponent(name)}`)
    return parseState(await res.json())
  }

  getSwitch (name) {
    return this.getState('switch', name)
  }

  getBinarySensor (name) {
    return this.getState('binary_sensor', name)
  }

  async setSwitch (name, on) {
    const action = on ? 'turn_on' : 'turn_off'
    const res = await this.request('POST', `/switch/${encodeURIComponent(name)}/${action}`)
    await res.arrayBuffer()
  }

  // Keeps an /events connection open, reconnecting with backoff.
  // onEvent({ event, data }) receives each SSE event; onStatus(connected, err)
  // reports connection changes. Returns a function that stops the stream.
  startEvents (onEvent, onStatus) {
    const stopper = new AbortController()
    let conn = null

    const run = async () => {
      let backoff = 1000
      while (!stopper.signal.aborted) {
        conn = new AbortController()
        let idleTimer = null
        const resetIdle = () => {
          clearTimeout(idleTimer)
          idleTimer = setTimeout(() => conn.abort(new Error('event stream idle')), STREAM_IDLE_MS)
        }
        try {
          resetIdle()
          const res = await fetch(this.baseUrl + '/events', {
            headers: { ...this.headers, Accept: 'text/event-stream' },
            signal: conn.signal
          })
          if (!res.ok) throw new Error(`GET /events returned HTTP ${res.status}`)
          onStatus(true)
          backoff = 1000
          const parser = createSseParser(onEvent)
          const decoder = new TextDecoder()
          for await (const chunk of res.body) {
            resetIdle()
            parser.push(decoder.decode(chunk, { stream: true }))
          }
          throw new Error('event stream closed by device')
        } catch (err) {
          if (stopper.signal.aborted) return
          const reason = conn.signal.aborted && conn.signal.reason instanceof Error ? conn.signal.reason : err
          onStatus(false, reason)
          await sleep(backoff, stopper.signal)
          backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
        } finally {
          clearTimeout(idleTimer)
        }
      }
    }

    run()
    return () => {
      stopper.abort()
      if (conn) conn.abort()
    }
  }
}

module.exports = {
  EspHomeClient,
  createSseParser,
  entityKeys,
  objectId,
  parseState,
  normalizeBaseUrl
}
