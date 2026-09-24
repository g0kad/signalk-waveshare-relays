'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { createSseParser, entityKeys, objectId, parseState, normalizeBaseUrl } = require('../lib/esphome')
const { toBool } = require('../lib/bank')

test('objectId matches ESPHome naming', () => {
  assert.strictEqual(objectId('Relay 1'), 'relay_1')
  assert.strictEqual(objectId('  Deck Lights #2 '), 'deck_lights_2')
})

test('entityKeys covers web_server v2 and v3 ids', () => {
  assert.deepStrictEqual(entityKeys('switch', 'Relay 3'), ['switch-relay_3', 'switch/Relay 3'])
})

test('parseState reads value or state', () => {
  assert.strictEqual(parseState({ value: true, state: 'ON' }), true)
  assert.strictEqual(parseState({ state: 'OFF' }), false)
  assert.strictEqual(parseState({ state: 'unknown' }), null)
  assert.strictEqual(parseState(null), null)
})

test('normalizeBaseUrl adds scheme and strips trailing slash', () => {
  assert.strictEqual(normalizeBaseUrl('192.168.1.129'), 'http://192.168.1.129')
  assert.strictEqual(normalizeBaseUrl('http://waveshare.local:8080/'), 'http://waveshare.local:8080')
})

test('toBool accepts common on/off forms', () => {
  for (const v of [true, 1, 'on', 'ON', 'true', '1']) assert.strictEqual(toBool(v), true)
  for (const v of [false, 0, 'off', 'false', '0']) assert.strictEqual(toBool(v), false)
  for (const v of [null, undefined, 2, 'maybe', {}]) assert.strictEqual(toBool(v), null)
})

test('SSE parser handles CRLF split across chunks', () => {
  const events = []
  const parser = createSseParser(e => events.push(e))
  parser.push('event: state\r\ndata: {"id":"switch-relay_1",')
  parser.push('"value":true}\r')
  parser.push('\n\r\n: comment\r\nevent: ping\r\ndata: a\r\ndata: b\r\n\r\n')
  assert.deepStrictEqual(events, [
    { event: 'state', data: '{"id":"switch-relay_1","value":true}' },
    { event: 'ping', data: 'a\nb' }
  ])
})
