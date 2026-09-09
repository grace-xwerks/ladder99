// brother protocol tests
//
//   node src/drivers/brother/protocol-test.js
//
// no machine and no docker required - the codec is pure, which is the whole
// reason it lives apart from the driver.

import assert from 'assert'

import {
  checksum,
  buildCommandString,
  encodeRequest,
  encodeLoad,
  isCompleteResponse,
  parseResponse,
  decodeLines,
  decodeField,
  expandFileName,
} from './protocol.js'

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ok    ${name}`)
  } catch (error) {
    failed++
    console.log(`  FAIL  ${name}`)
    console.log(`        ${error.message}`)
  }
}

console.log('\nBrother protocol\n')

// --- framing ---------------------------------------------------------------

test('command string pads command to 7 and args to 8', () => {
  const s = buildCommandString('LOD', 'PDSP')
  assert.strictEqual(s, 'CLOD    PDSP      \r\n')
  // 1 (C) + 7 (command) + 8 (args) + 2 (spaces) + 2 (crlf)
  assert.strictEqual(s.length, 20)
})

test('checksum is the ascii sum mod 16', () => {
  // 'CLOD    PDSP      \r\n' sums to 944; 944 = 59 * 16, so the checksum is 0.
  const s = buildCommandString('LOD', 'PDSP')
  let sum = 0
  for (let i = 0; i < s.length; i++) sum += s.charCodeAt(i)
  assert.strictEqual(sum, 944, `expected byte sum 944, got ${sum}`)
  assert.strictEqual(checksum(s), 0)
})

test('checksum is always in 0..15', () => {
  for (const file of ['PDSP', 'WKCNTR', 'ALARM', 'ATCTL', 'MCRNI1', 'VER']) {
    const cs = checksum(buildCommandString('LOD', file))
    assert.ok(cs >= 0 && cs <= 15, `${file} gave ${cs}`)
  }
})

test('encoded LOD PDSP frame matches the reference byte for byte', () => {
  // '%' + command + '\r\n' + checksum + '%' + '\r\n'
  // the command already ends in CRLF, hence the doubled CRLF - not a typo.
  assert.strictEqual(encodeLoad('PDSP'), '%CLOD    PDSP      \r\n\r\n00%\r\n')
})

test('checksum is zero padded to two digits', () => {
  const frame = encodeRequest('LOD', 'VER')
  const cs = frame.match(/\r\n(\d{2})%/)[1]
  assert.strictEqual(cs.length, 2)
})

test('over-long command or args are rejected rather than silently truncated', () => {
  assert.throws(() => buildCommandString('TOOLONGCMD', 'X'), /command too long/i)
  assert.throws(() => buildCommandString('LOD', 'TOOLONGARGS'), /args too long/i)
})

// --- response detection ----------------------------------------------------

test('a complete response starts and ends with %', () => {
  assert.strictEqual(isCompleteResponse('%L01,0\r\n%'), true)
})

test('trailing CRLF after the closing % still counts as complete', () => {
  assert.strictEqual(isCompleteResponse('%L01,0\r\n%\r\n'), true)
})

test('a partial response is not complete', () => {
  assert.strictEqual(isCompleteResponse('%L01,0\r\n'), false)
  assert.strictEqual(isCompleteResponse(''), false)
})

test('a lone % does not satisfy both ends at once', () => {
  // the naive startsWith && endsWith check would call this complete
  assert.strictEqual(isCompleteResponse('%'), false)
})

// --- parsing ---------------------------------------------------------------

const sample =
  '%\r\n' +
  'L01,0\r\n' +
  'G01,000,017,022,040,049,050,051,054,064,069,080,090,094,097,098\r\n' +
  'M01,005,009,097\r\n' +
  '%\r\n'

test('parses lines and splits fields after the symbol', () => {
  const parsed = parseResponse(sample)
  assert.strictEqual(parsed.lines.length, 3)
  assert.strictEqual(parsed.lines[0].symbol, 'L01')
  assert.strictEqual(parsed.lines[1].symbol, 'G01')
  assert.strictEqual(parsed.lines[1].fields.length, 15)
  assert.strictEqual(parsed.lines[2].fields[0], '005')
})

test('blank lines are skipped', () => {
  const parsed = parseResponse('%\r\n\r\nL01,0\r\n\r\n%')
  assert.strictEqual(parsed.lines.length, 1)
})

// --- decoding --------------------------------------------------------------

test('decodes by symbol, aligning item[0] to the first field after the symbol', () => {
  const parsed = parseResponse(sample)
  const { values, misses } = decodeLines(parsed, [
    {
      symbol: 'M01',
      items: [
        { name: 'm_spindle', type: 'number' },
        { name: 'm_coolant', type: 'number' },
        { name: 'm_subprogram', type: 'number' },
      ],
    },
  ])
  assert.deepStrictEqual(misses, [])
  // '005' is the FIRST field after M01 and must land on the first item.
  // the 2018 reference started its loop at 1 and would drop it.
  assert.strictEqual(values.m_spindle, 5)
  assert.strictEqual(values.m_coolant, 9)
  assert.strictEqual(values.m_subprogram, 97)
})

test('matching is by symbol, so line order does not matter', () => {
  const reordered = parseResponse('%\r\nM01,005\r\nL01,1\r\n%')
  const { values } = decodeLines(reordered, [
    { symbol: 'L01', items: [{ name: 'language', type: 'enum', values: { 0: 'NC', 1: 'CONVERSATION' } }] },
  ])
  assert.strictEqual(values.language, 'CONVERSATION')
})

test('a symbol the control did not send is reported, not silently dropped', () => {
  const parsed = parseResponse(sample)
  const { misses } = decodeLines(parsed, [{ symbol: 'X01', items: [{ name: 'abs_x' }] }])
  assert.deepStrictEqual(misses, ['X01'])
})

test('skip shifts the map without touching code', () => {
  const parsed = parseResponse('%\r\nM01,005,009\r\n%')
  const { values } = decodeLines(parsed, [
    { symbol: 'M01', skip: 1, items: [{ name: 'first', type: 'number' }] },
  ])
  assert.strictEqual(values.first, 9)
})

test('enum decodes by index and surfaces unmapped codes', () => {
  const item = { type: 'enum', values: { 0: 'NC', 1: 'CONVERSATION' } }
  assert.strictEqual(decodeField('0', item), 'NC')
  assert.strictEqual(decodeField('1', item), 'CONVERSATION')
  // an index the map doesn't know must be visible, not swallowed
  assert.strictEqual(decodeField('7', item), 'UNMAPPED_7')
})

test('numbers respect decimals and reject junk', () => {
  assert.strictEqual(decodeField('  12.3456 ', { type: 'number', decimals: 2 }), 12.35)
  assert.strictEqual(decodeField('005', { type: 'number' }), 5)
  assert.strictEqual(decodeField('----', { type: 'number' }), undefined)
  assert.strictEqual(decodeField('', { type: 'number' }), undefined)
})

test('empty fields decode to undefined so they never overwrite a good value', () => {
  assert.strictEqual(decodeField('   ', { type: 'string' }), undefined)
})

// --- file name expansion ---------------------------------------------------

test("'#' expands to 1..9 then 0, where 0 means the tenth", () => {
  assert.deepStrictEqual(expandFileName('MCRNI#'), [
    'MCRNI1', 'MCRNI2', 'MCRNI3', 'MCRNI4', 'MCRNI5',
    'MCRNI6', 'MCRNI7', 'MCRNI8', 'MCRNI9', 'MCRNI0',
  ])
})

test('a plain file name is left alone', () => {
  assert.deepStrictEqual(expandFileName('PDSP'), ['PDSP'])
})

// ---------------------------------------------------------------------------

console.log(`\n  ${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
