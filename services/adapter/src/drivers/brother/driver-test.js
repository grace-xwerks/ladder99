// brother driver integration test
//
//   node src/drivers/brother/driver-test.js
//
// stands up a fake speedio on localhost that speaks the framing from
// protocol.js, then drives the real AdapterDriver against it with a stub cache.
// covers what the codec tests can't: the socket, the request queue, the polling
// loop, and availability transitions.
//
// still no hardware and no docker.

import assert from 'assert'
import net from 'net'

import { AdapterDriver } from './index.js'
import { isCompleteResponse } from './protocol.js'

let passed = 0
let failed = 0

async function test(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ok    ${name}`)
  } catch (error) {
    failed++
    console.log(`  FAIL  ${name}`)
    console.log(`        ${error.message}`)
  }
}

// a stand-in for the ladder99 Cache - records what the driver writes
function makeCache() {
  const map = {}
  const log = []
  return {
    map,
    log,
    set(key, value) {
      map[key] = value
      log.push({ key, value })
    },
  }
}

// a fake control. serves canned responses per file name, counts requests, and
// can be told to refuse or hang so the failure paths get exercised too.
function makeFakeControl(responses, options = {}) {
  const state = { requests: [], concurrent: 0, maxConcurrent: 0 }
  const server = net.createServer(socket => {
    state.concurrent++
    state.maxConcurrent = Math.max(state.maxConcurrent, state.concurrent)
    socket.on('close', () => state.concurrent--)

    let buffer = ''
    socket.on('data', chunk => {
      buffer += chunk.toString('ascii')
      if (!isCompleteResponse(buffer)) return
      // pull the 8-char argument field out of the request frame
      const match = buffer.match(/^%C(.{7})(.{8})/)
      const fileName = match ? match[2].trim() : ''
      state.requests.push(fileName)

      if (options.hang) return // never answer - exercises the read timeout

      const body = responses[fileName]
      if (body === undefined) {
        socket.end()
        return
      }
      // a real control is slow enough that the reply arrives in pieces; send it
      // split so the accumulate-until-complete path is actually exercised.
      const frame = `%\r\n${body}\r\n%\r\n`
      const half = Math.ceil(frame.length / 2)
      socket.write(frame.slice(0, half))
      setTimeout(() => socket.write(frame.slice(half)), 5)
      buffer = ''
    })
  })
  return { server, state }
}

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

function close(server) {
  return new Promise(resolve => server.close(resolve))
}

const wait = ms => new Promise(r => setTimeout(r, ms))

const PDSP_BODY = ['L01,1', 'G01,000,017,022,040,049,050,051,054,064,069,080,090,094,097,098', 'M01,005,009,097'].join('\r\n')

const schema = {
  inputs: {
    poll: {
      defaultInterval: 50,
      failuresBeforeUnavailable: 2,
      connectTimeout: 500,
      readTimeout: 500,
      connectRetries: 1, // keep the failure paths fast in tests
    },
    files: [
      {
        name: 'PDSP',
        interval: 50,
        lines: [
          { symbol: 'L01', items: [{ name: 'language', type: 'enum', values: { 0: 'NC', 1: 'CONVERSATION' } }] },
          { symbol: 'M01', items: [{ name: 'm_spindle', type: 'number' }, { name: 'm_coolant', type: 'number' }] },
        ],
      },
      { name: 'WKCNTR', interval: 50, raw: true, rawKey: 'wkcntr_raw' },
    ],
  },
}

console.log('\nBrother driver\n')

await test('decodes a poll into prefixed cache keys and goes AVAILABLE', async () => {
  const { server, state } = makeFakeControl({ PDSP: PDSP_BODY, WKCNTR: 'W01,00042,00007' })
  const port = await listen(server)
  const cache = makeCache()
  const driver = new AdapterDriver()

  driver.start({
    device: { id: 'cnc23', name: 'Brother879' },
    cache,
    source: { connect: { host: '127.0.0.1', port } },
    schema,
  })

  await wait(300)
  driver.stop()
  await close(server)

  assert.strictEqual(cache.map['cnc23-avail'], 'AVAILABLE', 'should be available')
  assert.strictEqual(cache.map['cnc23-cond'], 'NORMAL')
  assert.strictEqual(cache.map['cnc23-language'], 'CONVERSATION')
  assert.strictEqual(cache.map['cnc23-m_spindle'], 5)
  assert.strictEqual(cache.map['cnc23-m_coolant'], 9)
  assert.strictEqual(cache.map['cnc23-wkcntr_raw'], 'W01,00042,00007')
  assert.ok(state.requests.includes('PDSP'), 'should have asked for PDSP')
  assert.ok(state.requests.includes('WKCNTR'), 'should have asked for WKCNTR')
})

await test('never opens two sockets to the control at once', async () => {
  const { server, state } = makeFakeControl({ PDSP: PDSP_BODY, WKCNTR: 'W01,1' })
  const port = await listen(server)
  const driver = new AdapterDriver()

  // both files come due on the same tick at start - without the queue this is
  // where two sockets would land on the machine simultaneously.
  driver.start({
    device: { id: 'cnc23', name: 'Brother879' },
    cache: makeCache(),
    source: { connect: { host: '127.0.0.1', port } },
    schema,
  })

  await wait(300)
  driver.stop()
  await close(server)

  assert.strictEqual(state.maxConcurrent, 1, `saw ${state.maxConcurrent} concurrent connections`)
})

await test('starts UNAVAILABLE before the first successful poll', async () => {
  const cache = makeCache()
  const driver = new AdapterDriver()
  driver.start({
    device: { id: 'cnc23', name: 'Brother879' },
    cache,
    // nothing listening on this port
    source: { connect: { host: '127.0.0.1', port: 1 } },
    schema,
  })
  // the very first thing written must be UNAVAILABLE, not a stale value
  assert.strictEqual(cache.log[1].key, 'cnc23-avail')
  assert.strictEqual(cache.log[1].value, 'UNAVAILABLE')
  driver.stop()
})

await test('goes UNAVAILABLE and FAULT after repeated failures', async () => {
  const cache = makeCache()
  const driver = new AdapterDriver()
  driver.start({
    device: { id: 'cnc23', name: 'Brother879' },
    cache,
    source: { connect: { host: '127.0.0.1', port: 1 }, },
    schema,
  })
  await wait(400)
  driver.stop()
  assert.strictEqual(cache.map['cnc23-avail'], 'UNAVAILABLE')
  assert.strictEqual(cache.map['cnc23-cond'], 'FAULT')
})

await test('recovers to AVAILABLE when the control comes back', async () => {
  const { server } = makeFakeControl({ PDSP: PDSP_BODY, WKCNTR: 'W01,1' })
  const port = await listen(server)
  await close(server) // take it down first

  const cache = makeCache()
  const driver = new AdapterDriver()
  driver.start({
    device: { id: 'cnc23', name: 'Brother879' },
    cache,
    source: { connect: { host: '127.0.0.1', port } },
    schema,
  })
  await wait(250)
  assert.strictEqual(cache.map['cnc23-avail'], 'UNAVAILABLE', 'should be down first')

  // bring an identical control back up on the same port
  const revived = makeFakeControl({ PDSP: PDSP_BODY, WKCNTR: 'W01,1' })
  await new Promise(resolve => revived.server.listen(port, '127.0.0.1', resolve))
  await wait(350)
  driver.stop()
  await close(revived.server)

  assert.strictEqual(cache.map['cnc23-avail'], 'AVAILABLE', 'should have recovered')
  assert.strictEqual(cache.map['cnc23-cond'], 'NORMAL')
})

await test('missing connect.host is refused without throwing', async () => {
  const cache = makeCache()
  const driver = new AdapterDriver()
  driver.start({
    device: { id: 'cnc23', name: 'Brother879' },
    cache,
    source: {},
    schema,
  })
  // nothing polled, nothing written, no crash
  assert.strictEqual(cache.log.length, 0)
  driver.stop()
})

console.log(`\n  ${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
