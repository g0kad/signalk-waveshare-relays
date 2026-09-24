'use strict'

// End-to-end tests against a mock ESPHome web server.

const test = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const EventEmitter = require('node:events')
const createPlugin = require('..')
const { objectId } = require('../lib/esphome')

function mockEsphome () {
  const switches = new Map(Array.from({ length: 8 }, (_, i) => [`Relay ${i + 1}`, false]))
  const streams = new Set()
  const body = (name, on) => ({ id: `switch-${objectId(name)}`, name, value: on, state: on ? 'ON' : 'OFF' })
  const sse = (res, name, on) => res.write(`event: state\r\ndata: ${JSON.stringify(body(name, on))}\r\n\r\n`)

  const server = http.createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    if (path === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      streams.add(res)
      req.on('close', () => streams.delete(res))
      for (const [name, on] of switches) sse(res, name, on)
      return
    }
    const m = path.match(/^\/switch\/([^/]+)(?:\/(turn_on|turn_off))?$/)
    if (!m || !switches.has(m[1])) {
      res.writeHead(404)
      return res.end()
    }
    if (m[2]) {
      if (req.method !== 'POST') {
        res.writeHead(405)
        return res.end()
      }
      const on = m[2] === 'turn_on'
      switches.set(m[1], on)
      for (const s of streams) sse(s, m[1], on)
      res.writeHead(200)
      return res.end()
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body(m[1], switches.get(m[1]))))
  })

  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    switches,
    host: `127.0.0.1:${server.address().port}`,
    close () {
      server.closeAllConnections()
      return new Promise(r => server.close(r))
    }
  })))
}

function fakeApp () {
  const app = Object.assign(new EventEmitter(), {
    deltas: [],
    puts: {},
    status: null,
    error: null,
    debug () {},
    setPluginStatus (s) { app.status = s; app.error = null },
    setPluginError (e) { app.error = e },
    handleMessage (id, delta) { app.deltas.push(delta) },
    registerPutHandler (context, path, fn) { app.puts[path] = fn },
    latest (path) {
      for (let i = app.deltas.length - 1; i >= 0; i--) {
        for (const u of app.deltas[i].updates) {
          const v = (u.values || []).find(x => x.path === path)
          if (v) return v.value
        }
      }
      return undefined
    }
  })
  return app
}

async function waitFor (fn, ms = 3000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return
    await new Promise(r => setTimeout(r, 20))
  }
  throw new Error('timed out waiting for condition')
}

const path = n => `electrical.switches.bank.waveshare.${n}.state`

test('event stream publishes initial state and PUT switches a relay', async (t) => {
  const device = await mockEsphome()
  const app = fakeApp()
  const plugin = createPlugin(app)
  t.after(async () => { plugin.stop(); await device.close() })

  plugin.start({ host: device.host, pollInterval: 0 })
  await waitFor(() => app.latest(path(8)) === false)
  assert.match(app.status, /live updates/)
  assert.strictEqual(Object.keys(app.puts).length, 8)

  const result = await new Promise(resolve => {
    const immediate = app.puts[path(3)]('vessels.self', path(3), true, resolve)
    assert.deepStrictEqual(immediate, { state: 'PENDING' })
  })
  assert.strictEqual(result.statusCode, 200)
  assert.strictEqual(device.switches.get('Relay 3'), true)
  assert.strictEqual(app.latest(path(3)), true)
})

test('invalid PUT value is rejected without touching the board', async (t) => {
  const device = await mockEsphome()
  const app = fakeApp()
  const plugin = createPlugin(app)
  t.after(async () => { plugin.stop(); await device.close() })

  plugin.start({ host: device.host, pollInterval: 0, useEventStream: false })
  const result = app.puts[path(1)]('vessels.self', path(1), 'maybe', () => {})
  assert.strictEqual(result.statusCode, 400)
  assert.strictEqual(device.switches.get('Relay 1'), false)
})

test('polling publishes all relays as numbers when configured', async (t) => {
  const device = await mockEsphome()
  device.switches.set('Relay 5', true)
  const app = fakeApp()
  const plugin = createPlugin(app)
  t.after(async () => { plugin.stop(); await device.close() })

  plugin.start({ host: device.host, useEventStream: false, stateFormat: 'number', bankId: 'deck' })
  const p = n => `electrical.switches.bank.deck.${n}.state`
  await waitFor(() => /polling every 10 s/.test(app.status))
  assert.strictEqual(app.latest(p(5)), 1)
  assert.strictEqual(app.latest(p(1)), 0)
  assert.strictEqual(app.latest(p(8)), 0)
})

test('unreachable board reports a plugin error', async (t) => {
  const device = await mockEsphome()
  const host = device.host
  await device.close()
  const app = fakeApp()
  const plugin = createPlugin(app)
  t.after(() => plugin.stop())

  plugin.start({ host, useEventStream: false })
  await waitFor(() => app.error)
  assert.match(app.error, /Cannot reach/)
})

test('NMEA 2000 127502 switches the board and 127501 reports it', async (t) => {
  const device = await mockEsphome()
  const app = fakeApp()
  const sent = []
  app.on('nmea2000JsonOut', msg => sent.push(msg))
  const plugin = createPlugin(app)
  t.after(async () => { plugin.stop(); await device.close() })

  plugin.start({ host: device.host, pollInterval: 0, nmea2000: { enabled: true, instance: 4 } })
  await waitFor(() => sent.some(m => m.fields.indicator8 === 'Off'))

  app.emit('N2KAnalyzerOut', { pgn: 127502, src: 20, dst: 255, fields: { instance: 4, switch2: 'On' } })
  await waitFor(() => sent.some(m => m.pgn === 127501 && m.fields.instance === 4 && m.fields.indicator2 === 'On'))
  assert.strictEqual(device.switches.get('Relay 2'), true)
  assert.strictEqual(app.latest(path(2)), true)
})

test('missing host reports a configuration error', () => {
  const app = fakeApp()
  createPlugin(app).start({})
  assert.match(app.error, /board address/)
})
