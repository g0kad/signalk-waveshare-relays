'use strict'

// Finds boards running this project's prebuilt firmware, which advertise the
// _wsrelay._tcp service over mDNS.

const SERVICE = '_wsrelay._tcp.local'
const QUERY_INTERVAL_MS = 60000
// Boards not heard from for this long are dropped from the list.
const FORGET_MS = 10 * 60000

function sameName (a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase()
}

function parseTxt (record) {
  const out = {}
  const items = record && Array.isArray(record.data) ? record.data : []
  for (const item of items) {
    const text = Buffer.isBuffer(item) ? item.toString('utf8') : String(item)
    const i = text.indexOf('=')
    if (i > 0) out[text.slice(0, i)] = text.slice(i + 1)
  }
  return out
}

class Discovery {
  // createMdns defaults to the multicast-dns package; tests pass a fake.
  constructor (debug = () => {}, createMdns) {
    this.debug = debug
    this.createMdns = createMdns || (() => require('multicast-dns')())
    this.boards = new Map()
    this.mdns = null
    this.timer = null
  }

  start () {
    if (this.mdns) return
    try {
      this.mdns = this.createMdns()
    } catch (err) {
      this.debug(`mDNS discovery unavailable: ${err.message}`)
      return
    }
    this.mdns.on('response', packet => this.handleResponse(packet))
    this.mdns.on('error', err => this.debug(`mDNS: ${err.message}`))
    this.query()
    this.timer = setInterval(() => this.query(), QUERY_INTERVAL_MS)
  }

  stop () {
    clearInterval(this.timer)
    this.timer = null
    if (this.mdns) this.mdns.destroy()
    this.mdns = null
  }

  query (questions = [{ name: SERVICE, type: 'PTR' }]) {
    if (this.mdns) this.mdns.query({ questions })
  }

  handleResponse (packet) {
    const records = [...(packet.answers || []), ...(packet.additionals || [])]
    for (const ptr of records) {
      if (ptr.type !== 'PTR' || !sameName(ptr.name, SERVICE)) continue
      const instance = ptr.data
      const srv = records.find(r => r.type === 'SRV' && sameName(r.name, instance))
      if (!srv) {
        // Some responders send only the PTR record; ask for the rest.
        this.query([{ name: instance, type: 'SRV' }, { name: instance, type: 'TXT' }])
        continue
      }
      const host = String(srv.data.target).toLowerCase().replace(/\.$/, '')
      const txt = parseTxt(records.find(r => r.type === 'TXT' && sameName(r.name, instance)))
      const addresses = records
        .filter(r => r.type === 'A' && sameName(r.name, srv.data.target))
        .map(r => r.data)
      const known = this.boards.get(host)
      this.boards.set(host, {
        host,
        port: srv.data.port,
        version: txt.version || (known && known.version) || '',
        addresses: addresses.length ? addresses : (known ? known.addresses : []),
        seen: Date.now()
      })
      if (!known) this.debug(`Discovered ${host}${addresses.length ? ` (${addresses.join(', ')})` : ''}`)
    }
  }

  list () {
    const now = Date.now()
    for (const [host, board] of this.boards) {
      if (now - board.seen > FORGET_MS) this.boards.delete(host)
    }
    return [...this.boards.values()].sort((a, b) => a.host.localeCompare(b.host))
  }
}

module.exports = { Discovery, SERVICE, parseTxt }
