// brother protocol codec
//
// pure functions - no i/o, no state. everything here can be exercised without a
// machine on the bench, which matters because the only controls we can test
// against are on the shop floor. see protocol-test.js.
//
// brother speedio controls expose a proprietary request/response protocol on
// tcp 10000. the wire format below was read off Lathejockey81/BrotherAdapter
// (MIT, C#, 2018), corroborated by the port FactoryWiz configures for the same
// controls.
//
// IMPORTANT: that reference targets B00/C00 controls. grace is on CNC-D00.
// the framing is expected to have carried forward but is unverified - run
// probe.js against a real machine before trusting any of this.

// a request is built in two stages.
//
// stage 1 - the command string, which is what the checksum covers:
//   'C' + command.padEnd(7) + args.padEnd(8) + '  \r\n'
//
// stage 2 - wrap it:
//   '%' + <stage 1> + '\r\n' + <checksum, 2 digits> + '%' + '\r\n'
//
// note stage 1 already ends in CRLF, so the assembled frame carries two of them
// back to back. that is not a typo - it matches the reference byte for byte.

const COMMAND_WIDTH = 7
const ARGS_WIDTH = 8

// checksum
// sum of the ascii bytes of the stage-1 command string, modulo 16.
// only sixteen possible values, so this catches very little - treat a matching
// checksum as "probably not garbled", never as integrity.
export function checksum(commandString) {
  let sum = 0
  for (let i = 0; i < commandString.length; i++) {
    sum += commandString.charCodeAt(i)
  }
  return sum % 16
}

// build the stage-1 command string (the checksummed part)
export function buildCommandString(command, args = '') {
  if (command.length > COMMAND_WIDTH) {
    throw new Error(`Brother command too long (max ${COMMAND_WIDTH}): ${command}`)
  }
  if (args.length > ARGS_WIDTH) {
    throw new Error(`Brother args too long (max ${ARGS_WIDTH}): ${args}`)
  }
  return 'C' + command.padEnd(COMMAND_WIDTH) + args.padEnd(ARGS_WIDTH) + '  \r\n'
}

// encode a full request frame, ready to write to the socket.
// eg encodeRequest('LOD', 'PDSP') -> '%CLOD    PDSP      \r\n\r\n00%\r\n'
export function encodeRequest(command, args = '') {
  const commandString = buildCommandString(command, args)
  const cs = String(checksum(commandString)).padStart(2, '0')
  return `%${commandString}\r\n${cs}%\r\n`
}

// convenience - the only command we actually use. loads a named data file.
export function encodeLoad(fileName) {
  return encodeRequest('LOD', fileName)
}

// is the accumulated response complete?
//
// the reference tests `startsWith('%') && endsWith('%')` on the raw buffer. that
// only terminates if the control sends no trailing CRLF, which we can't confirm
// for D00 - so we tolerate trailing whitespace and require enough bytes that a
// lone leading '%' can't satisfy both ends at once.
export function isCompleteResponse(text) {
  if (!text) return false
  const trimmed = text.replace(/[\s﻿\0]+$/, '')
  return trimmed.length > 2 && trimmed.startsWith('%') && trimmed.endsWith('%')
}

// strip the framing and split into records.
//
// returns { lines: [{ index, symbol, fields, raw }], body }
// where symbol is the leading token of the line (eg 'L01', 'G01', 'X01') and
// fields are the comma-separated values that follow it.
export function parseResponse(text) {
  const trimmed = text.replace(/[\s﻿\0]+$/, '')
  // drop the wrapping '%' on each end if present, so callers can pass either a
  // full frame or an already-unwrapped body.
  const body = trimmed.replace(/^%/, '').replace(/%$/, '')
  const lines = []
  const rawLines = body.split(/\r\n|\r|\n/)
  for (let index = 0; index < rawLines.length; index++) {
    const raw = rawLines[index]
    if (raw.trim() === '') continue
    const parts = raw.split(',')
    const symbol = parts[0].trim()
    lines.push({ index, symbol, fields: parts.slice(1), raw })
  }
  return { lines, body }
}

// decode a parsed response against a line map from inputs.yaml.
//
// lineMaps is [{ symbol, line?, items: [{ name, type, decimals, values }] }].
// items[i] lines up with the i'th field AFTER the leading symbol token.
//
// note: the 2018 reference starts its item loop at i=1 rather than 0, which
// silently drops the first field of every line. we align from 0. if a real
// control turns out to disagree, set `skip: 1` on the line to shift the map
// rather than editing this function.
export function decodeLines(parsed, lineMaps) {
  const values = {}
  const misses = []

  for (const lineMap of lineMaps || []) {
    const { symbol, line, items = [], skip = 0 } = lineMap

    // prefer matching by symbol - it survives the control inserting or
    // reordering lines. fall back to a fixed line number only if asked.
    let match = parsed.lines.find(l => l.symbol === symbol)
    if (!match && typeof line === 'number') {
      match = parsed.lines[line]
      if (match && match.symbol !== symbol) match = undefined
    }
    if (!match) {
      misses.push(symbol)
      continue
    }

    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (!item || !item.name) continue
      const rawField = match.fields[i + skip]
      if (rawField === undefined) continue
      const value = decodeField(rawField, item)
      if (value !== undefined) values[item.name] = value
    }
  }

  return { values, misses }
}

// decode one field according to its declared type
export function decodeField(rawField, item) {
  const text = String(rawField).trim()
  const type = String(item.type || 'string').toLowerCase()

  if (type === 'number') {
    if (text === '') return undefined
    const n = Number(text)
    if (Number.isNaN(n)) return undefined
    return typeof item.decimals === 'number' ? round(n, item.decimals) : n
  }

  if (type === 'enum') {
    // values is a map of index -> label, eg { 0: NC, 1: Conversation }
    const table = item.values || {}
    // yaml gives us numeric-ish keys as strings; index by the trimmed text and
    // by its numeric form so both '0' and '00' resolve.
    if (Object.prototype.hasOwnProperty.call(table, text)) return table[text]
    const n = Number(text)
    if (!Number.isNaN(n) && Object.prototype.hasOwnProperty.call(table, n)) {
      return table[n]
    }
    // unmapped index - hand back the raw code so it shows up in grafana instead
    // of vanishing, which is how you find out the map is wrong.
    return text === '' ? undefined : `UNMAPPED_${text}`
  }

  if (type === 'bool' || type === 'boolean') {
    if (text === '') return undefined
    return text === '1' || text.toUpperCase() === 'TRUE'
  }

  return text === '' ? undefined : text
}

// expand a file name containing '#' into the set the control actually serves.
// the reference iterates 1..9 then 0, where '0' means the tenth - not a zeroth.
// eg 'MCRNI#' -> MCRNI1 ... MCRNI9, MCRNI0
export function expandFileName(fileName) {
  if (!fileName.includes('#')) return [fileName]
  const suffixes = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']
  return suffixes.map(s => fileName.replace('#', s))
}

// helpers

function round(value, decimals = 0) {
  const factor = Math.pow(10, decimals)
  return Math.round(value * factor) / factor
}
