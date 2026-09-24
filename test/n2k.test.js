'use strict'

const test = require('node:test')
const assert = require('node:assert')
const EventEmitter = require('node:events')
const { N2kSwitchBank, switchCommand } = require('../lib/n2k')

function fakeBank (online = true) {
  const bank = new EventEmitter()
  bank.relays = [1, 2, 3].map(channel => ({ channel, entity: `Relay ${channel}` }))
  bank.relayState = new Map([[1, false], [2, true]])
  bank.commands = []
  bank.isOnline = () => online
  bank.setRelay = async (channel, on) => {
    bank.commands.push([channel, on])
    const previous = bank.relayState.get(channel)
    bank.relayState.set(channel, on)
    bank.emit('relay', channel, on, previous)
  }
  return bank
}

function fakeApp () {
  const app = new EventEmitter()
  app.sent = []
  app.debug = () => {}
  app.error = () => {}
  app.on('nmea2000JsonOut', msg => app.sent.push(msg))
  return app
}

const control = (instance, fields) => ({ pgn: 127502, src: 42, dst: 255, fields: { instance, ...fields } })
const settle = () => new Promise(resolve => setTimeout(resolve, 80))

test('switchCommand maps N2K values', () => {
  assert.strictEqual(switchCommand('On'), true)
  assert.strictEqual(switchCommand('Off'), false)
  assert.strictEqual(switchCommand(1), true)
  assert.strictEqual(switchCommand(0), false)
  assert.strictEqual(switchCommand('Take no action (no change)'), null)
  assert.strictEqual(switchCommand(undefined), null)
})

test('127502 for our instance switches only the commanded relays', async (t) => {
  const app = fakeApp()
  const bank = fakeBank()
  const n2k = new N2kSwitchBank(app, bank, { instance: 7, statusInterval: 0 })
  n2k.start()
  t.after(() => n2k.stop())
  await settle()
  app.sent.length = 0

  app.emit('N2KAnalyzerOut', control(7, { switch1: 'On', switch2: 'Take no action (no change)', switch3: 'Off' }))
  await settle()

  assert.deepStrictEqual(bank.commands, [[1, true], [3, false]])
  assert.strictEqual(app.sent.length, 1, 'changes are coalesced into one status message')
  assert.deepStrictEqual(app.sent[0], {
    pgn: 127501,
    prio: 3,
    dst: 255,
    fields: { instance: 7, indicator1: 'On', indicator2: 'On', indicator3: 'Off' }
  })
})

test('127502 for another instance, or other PGNs, are ignored', async (t) => {
  const app = fakeApp()
  const bank = fakeBank()
  const n2k = new N2kSwitchBank(app, bank, { instance: 7, statusInterval: 0 })
  n2k.start()
  t.after(() => n2k.stop())
  await settle()
  app.sent.length = 0

  app.emit('N2KAnalyzerOut', control(8, { switch1: 'On' }))
  app.emit('N2KAnalyzerOut', { pgn: 127501, src: 42, fields: { instance: 7, indicator1: 'On' } })
  await settle()
  assert.deepStrictEqual(bank.commands, [])
  assert.strictEqual(app.sent.length, 0)
})

test('command matching current state is answered with a status only', async (t) => {
  const app = fakeApp()
  const bank = fakeBank()
  const n2k = new N2kSwitchBank(app, bank, { instance: 0, statusInterval: 0 })
  n2k.start()
  t.after(() => n2k.stop())
  await settle()
  app.sent.length = 0

  app.emit('N2KAnalyzerOut', control(0, { switch2: 'On' }))
  await settle()
  assert.deepStrictEqual(bank.commands, [])
  assert.strictEqual(app.sent.length, 1)
})

test('status reports Unavailable while the board is offline or state unknown', () => {
  const online = new N2kSwitchBank(fakeApp(), fakeBank(true), { instance: 0 })
  assert.deepStrictEqual(online.statusFields(),
    { instance: 0, indicator1: 'Off', indicator2: 'On', indicator3: 'Unavailable' })
  const offline = new N2kSwitchBank(fakeApp(), fakeBank(false), { instance: 0 })
  assert.deepStrictEqual(offline.statusFields(),
    { instance: 0, indicator1: 'Unavailable', indicator2: 'Unavailable', indicator3: 'Unavailable' })
})

test('stop removes all listeners', () => {
  const app = fakeApp()
  const bank = fakeBank()
  const n2k = new N2kSwitchBank(app, bank, { instance: 0, statusInterval: 5 })
  n2k.start()
  n2k.stop()
  assert.strictEqual(app.listenerCount('N2KAnalyzerOut'), 0)
  assert.strictEqual(app.listenerCount('nmea2000OutAvailable'), 0)
  assert.strictEqual(bank.listenerCount('relay'), 0)
})
