'use strict'

const test = require('node:test')
const assert = require('node:assert')
const EventEmitter = require('node:events')
const { Discovery, SERVICE } = require('../lib/discovery')

function fakeMdns () {
  const mdns = Object.assign(new EventEmitter(), {
    queries: [],
    destroyed: false,
    query (q) { mdns.queries.push(q) },
    destroy () { mdns.destroyed = true }
  })
  return mdns
}

const instance = `waveshare-relays-21e150.${SERVICE}`

test('a full mDNS response adds the board with its addresses and version', (t) => {
  const mdns = fakeMdns()
  const discovery = new Discovery(() => {}, () => mdns)
  discovery.start()
  t.after(() => discovery.stop())
  assert.deepStrictEqual(mdns.queries[0].questions, [{ name: SERVICE, type: 'PTR' }])

  mdns.emit('response', {
    answers: [{ name: SERVICE, type: 'PTR', data: instance }],
    additionals: [
      { name: instance, type: 'SRV', data: { target: 'waveshare-relays-21e150.local', port: 80 } },
      { name: instance, type: 'TXT', data: [Buffer.from('project=g0kad.waveshare-relays'), Buffer.from('version=0.3.0')] },
      { name: 'waveshare-relays-21e150.local', type: 'A', data: '192.168.1.129' },
      { name: 'waveshare-relays-21e150.local', type: 'A', data: '192.168.1.126' }
    ]
  })
  const [board] = discovery.list()
  assert.strictEqual(board.host, 'waveshare-relays-21e150.local')
  assert.strictEqual(board.port, 80)
  assert.strictEqual(board.version, '0.3.0')
  assert.deepStrictEqual(board.addresses, ['192.168.1.129', '192.168.1.126'])
})

test('a PTR-only response triggers a follow-up query', (t) => {
  const mdns = fakeMdns()
  const discovery = new Discovery(() => {}, () => mdns)
  discovery.start()
  t.after(() => discovery.stop())

  mdns.emit('response', { answers: [{ name: SERVICE, type: 'PTR', data: instance }], additionals: [] })
  assert.strictEqual(discovery.list().length, 0)
  assert.deepStrictEqual(mdns.queries[1].questions.map(q => q.type), ['SRV', 'TXT'])
})

test('other services are ignored and stop() closes the socket', () => {
  const mdns = fakeMdns()
  const discovery = new Discovery(() => {}, () => mdns)
  discovery.start()
  mdns.emit('response', { answers: [{ name: '_http._tcp.local', type: 'PTR', data: 'x._http._tcp.local' }] })
  assert.strictEqual(discovery.list().length, 0)
  discovery.stop()
  assert.ok(mdns.destroyed)
})

test('discovery keeps working if mDNS cannot start', () => {
  const discovery = new Discovery(() => {}, () => { throw new Error('no multicast') })
  discovery.start()
  assert.deepStrictEqual(discovery.list(), [])
  discovery.stop()
})
