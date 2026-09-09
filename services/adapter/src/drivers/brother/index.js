// brother driver
//
// polls a brother speedio control over its native protocol on tcp 10000,
// decodes the fixed-field responses, and writes values to the cache. the cache
// turns those into SHDR and hands them to the agent - see schemas/brother.
//
// setup.yaml looks like:
//
//   - id: cnc23
//     name: Brother879
//     sources:
//       - driver: brother
//         schema: brother
//         connect:
//           host: cnc23          # or an ip once one is measured
//           port: 10000
//     outputs:
//       agent:
//         host: adapter
//         port: 7890
//
// the field maps live in schemas/brother/inputs.yaml, NOT in this file. that is
// deliberate: the layouts are unverified against CNC-D00, and correcting a map
// at the machine should be a yaml edit, not a code change. run probe.js first.

import { BrotherConnection } from './connection.js'
import { parseResponse, decodeLines, expandFileName } from './protocol.js'

const defaultInterval = 5000 // ms
const defaultFailuresBeforeUnavailable = 3

export class AdapterDriver {
  //
  start({ device, cache, source, schema }) {
    this.device = device
    this.cache = cache
    this.timers = []

    // connection details. modbus.js uses source.connect, older drivers use
    // source.connection - accept either so a setup written against any existing
    // driver keeps working.
    const connect = source?.connect ?? source?.connection ?? {}
    this.host = connect.host
    this.port = connect.port ?? 10000

    if (!this.host) {
      console.log(
        `Brother error: no connect.host for device ${device.id} - ` +
          `set it in setup.yaml (eg cnc23) and restart.`
      )
      return
    }

    const inputs = schema?.inputs ?? {}
    const poll = inputs.poll ?? {}
    this.failureLimit =
      poll.failuresBeforeUnavailable ?? defaultFailuresBeforeUnavailable
    this.defaultInterval = poll.defaultInterval ?? defaultInterval

    this.connection = new BrotherConnection({
      host: this.host,
      port: this.port,
      connectTimeout: poll.connectTimeout,
      readTimeout: poll.readTimeout,
      // keep in-request retries low. when a control is unreachable the next
      // poll is along shortly anyway, and a long retry chain just delays the
      // UNAVAILABLE that tells you what is actually going on.
      connectRetries: poll.connectRetries,
    })

    console.log(
      `Brother start driver - device ${device.id} at ${this.host}:${this.port}`
    )

    // start unavailable. the first successful poll flips it, which means a
    // dashboard shows "not talking to the machine" rather than stale values
    // from before the control was switched off.
    this.consecutiveFailures = 0
    this.available = null // null so the first result always writes
    this.setValue('cond', 'NORMAL')
    this.setAvailability(false)

    // expand and schedule each file
    const files = expandFiles(inputs.files ?? [])
    if (files.length === 0) {
      console.log(`Brother warning: no files declared for ${device.id}`)
    }
    for (const file of files) {
      const interval = file.interval ?? this.defaultInterval
      // poll once straight away so the first values land without waiting out an
      // interval, then on schedule.
      this.pollFile(file)
      if (interval !== null) {
        this.timers.push(setInterval(() => this.pollFile(file), interval))
      }
    }
  }

  // stop all polling and drop timers - called on shutdown
  stop() {
    for (const timer of this.timers) clearInterval(timer)
    this.timers = []
  }

  // fetch one data file and write whatever we can decode from it
  async pollFile(file) {
    // if the previous poll of this file is still outstanding, skip this tick
    // rather than queueing behind it. a control that has gone slow or dark
    // would otherwise build an unbounded backlog of requests that are all
    // asking for the same thing.
    if (file.inFlight) return
    file.inFlight = true

    let raw
    try {
      raw = await this.connection.load(file.name)
    } catch (error) {
      this.onFailure(file, error)
      return
    } finally {
      file.inFlight = false
    }

    this.onSuccess()

    const parsed = parseResponse(raw)

    // raw mode - park the response body in the cache as a string. this is how a
    // file that has not been mapped yet still produces something visible, which
    // is usually how you work out what to map. store the body rather than the
    // frame: the '%' wrapper and checksum are transport, not data.
    if (file.raw) {
      this.setValue(file.rawKey ?? `${file.name.toLowerCase()}_raw`, parsed.body.trim())
      return
    }

    const { values, misses } = decodeLines(parsed, file.lines)

    if (misses.length > 0) {
      // a symbol the map expects but the control didn't send. on D00 this is
      // the most likely way the 2018 map is wrong, so say so loudly once per
      // poll rather than failing silently.
      console.log(
        `Brother ${file.name}: no line matched symbol(s) ${misses.join(', ')} - ` +
          `saw [${parsed.lines.map(l => l.symbol).join(', ')}]. ` +
          `Check schemas/brother/inputs.yaml against probe.js output.`
      )
    }

    for (const key of Object.keys(values)) {
      this.setValue(key, values[key])
    }
  }

  // a poll succeeded - clear the fault and mark available
  onSuccess() {
    if (this.consecutiveFailures > 0) {
      console.log(`Brother ${this.device.id} recovered`)
    }
    this.consecutiveFailures = 0
    this.setAvailability(true)
    this.setValue('cond', 'NORMAL')
  }

  // a poll failed. one failure is noise - a control can be mid-reboot, or busy.
  // only go unavailable once we've missed several in a row, otherwise every
  // dashboard flickers.
  onFailure(file, error) {
    this.consecutiveFailures++
    console.log(
      `Brother ${this.device.id} ${file.name} failed ` +
        `(${this.consecutiveFailures}/${this.failureLimit}): ${error.message}`
    )
    if (this.consecutiveFailures >= this.failureLimit) {
      this.setAvailability(false)
      this.setValue('cond', 'FAULT')
    }
  }

  setAvailability(isAvailable) {
    if (this.available === isAvailable) return
    this.available = isAvailable
    this.setValue('avail', isAvailable ? 'AVAILABLE' : 'UNAVAILABLE')
  }

  // write a value to the cache under this device's prefix
  setValue(key, value) {
    this.cache.set(`${this.device.id}-${key}`, value)
  }
}

// helpers

// expand any '#' in file names into the real set, keeping each file's own
// settings. eg { name: 'MCRNI#' } becomes MCRNI1..MCRNI9, MCRNI0.
function expandFiles(files) {
  const expanded = []
  for (const file of files) {
    if (!file || !file.name) continue
    if (file.ignore) continue
    for (const name of expandFileName(file.name)) {
      expanded.push({ ...file, name })
    }
  }
  return expanded
}
