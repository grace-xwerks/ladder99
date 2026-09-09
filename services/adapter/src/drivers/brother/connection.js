// brother tcp connection
//
// wraps the request/response cycle on tcp 10000.
//
// two deliberate choices here, both taken from how the control behaves rather
// than from what would be tidy:
//
// 1. one socket per request. the 2018 reference opens and closes a connection
//    for every LOD, and a cnc control is not a web server - assume it holds one
//    conversation at a time and nothing more.
//
// 2. requests are serialized through a queue. if two pollers come due in the
//    same tick we must not open two sockets at the machine. the queue is the
//    only thing standing between a polling schedule and a control that stops
//    answering.

import net from 'net'

import { encodeLoad, isCompleteResponse } from './protocol.js'

const defaults = {
  port: 10000,
  connectTimeout: 4000, // ms to get a socket up
  readTimeout: 6000, // ms of silence mid-response before we give up
  connectRetries: 2, // per request - the poll loop is the real retry
  connectRetryDelay: 100, // ms between connect attempts
}

export class BrotherConnection {
  constructor(options = {}) {
    this.host = options.host
    this.port = options.port ?? defaults.port
    this.connectTimeout = options.connectTimeout ?? defaults.connectTimeout
    this.readTimeout = options.readTimeout ?? defaults.readTimeout
    this.connectRetries = options.connectRetries ?? defaults.connectRetries
    this.connectRetryDelay =
      options.connectRetryDelay ?? defaults.connectRetryDelay

    // tail of the request queue - each new request chains onto it, so requests
    // run strictly in order and never overlap.
    this.queue = Promise.resolve()
  }

  // load a named data file, eg load('PDSP').
  // resolves with the raw response text, framing included.
  load(fileName) {
    return this.request(encodeLoad(fileName))
  }

  // send a pre-encoded frame. queued behind any request already in flight.
  request(frame) {
    const run = () => this.sendWithRetries(frame)
    // chain onto the queue but don't let one rejection poison the chain
    const result = this.queue.then(run, run)
    this.queue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  async sendWithRetries(frame) {
    let lastError
    for (let attempt = 1; attempt <= this.connectRetries; attempt++) {
      try {
        return await this.sendOnce(frame)
      } catch (error) {
        lastError = error
        // a refused connection usually means the control is off or the ethernet
        // option is not enabled - retrying fast is pointless but cheap, and it
        // rides out the moment a control spends rebooting.
        if (attempt < this.connectRetries) {
          await delay(this.connectRetryDelay)
        }
      }
    }
    throw lastError
  }

  // one connect / write / read-to-completion / close cycle.
  //
  // note this resolves on socket CLOSE, not on the last byte of the response.
  // holding the queue slot until the socket is really gone is the difference
  // between the control seeing one conversation at a time and briefly seeing
  // two - which is exactly the thing a cnc control is not expected to tolerate.
  sendOnce(frame) {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket()
      let response = ''
      let settled = false
      let complete = false
      let readTimer

      const finish = (error, value) => {
        if (settled) return
        settled = true
        clearTimeout(readTimer)
        socket.removeAllListeners()
        socket.destroy()
        error ? reject(error) : resolve(value)
      }

      // restart the silence timer on every chunk - the timeout is about the
      // control going quiet mid-reply, not about total transfer time.
      const bumpReadTimer = () => {
        clearTimeout(readTimer)
        readTimer = setTimeout(() => {
          finish(
            new Error(
              `Brother read timeout after ${this.readTimeout}ms ` +
                `(${response.length} bytes received)`
            )
          )
        }, this.readTimeout)
      }

      socket.setTimeout(this.connectTimeout)

      socket.once('timeout', () => {
        finish(new Error(`Brother connect timeout after ${this.connectTimeout}ms`))
      })

      socket.once('error', error => finish(error))

      socket.once('close', () => {
        // either we asked for the close after a complete frame, or the control
        // hung up early - which for some controls is itself the terminator.
        if (complete || isCompleteResponse(response)) finish(null, response)
        else {
          finish(
            new Error(
              `Brother connection closed with incomplete response ` +
                `(${response.length} bytes)`
            )
          )
        }
      })

      socket.connect(this.port, this.host, () => {
        // clear the connect timeout - from here the read timer governs
        socket.setTimeout(0)
        socket.setNoDelay(true)
        bumpReadTimer()
        socket.write(frame, 'ascii', error => {
          if (error) finish(error)
        })
      })

      socket.on('data', chunk => {
        response += chunk.toString('ascii')
        bumpReadTimer()
        if (isCompleteResponse(response)) {
          complete = true
          clearTimeout(readTimer)
          // close our side and let the 'close' handler settle the promise
          socket.end()
        }
      })
    })
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
