#!/usr/bin/env node
//
// brother probe
//
// standalone. no docker, no agent, no database - just node and a network path
// to the control. this is the tool that answers the one question the whole
// brother plan rests on: does a CNC-D00 still speak the protocol the 2018
// reference documented?
//
//   node src/drivers/brother/probe.js --host cnc23
//   node src/drivers/brother/probe.js --host cnc23 --files PDSP,WKCNTR,ALARM
//   node src/drivers/brother/probe.js --host cnc23 --all --out ./probe-cnc23
//
// it prints the exact bytes it sends before sending them, so if a control
// answers with nothing you can tell a framing problem from a network problem
// without a packet capture.

import fs from 'fs'
import path from 'path'

import { BrotherConnection } from './connection.js'
import { encodeLoad, parseResponse, expandFileName } from './protocol.js'

// the three that carry utilisation - the default probe set
const OEE_FILES = ['PDSP', 'WKCNTR', 'ALARM']

// everything the 2018 reference knew how to ask for. '#' iterates 1..9,0.
const ALL_FILES = [
  'PDSP', 'PRD1', 'PRDC2', 'PRD3', 'WKCNTR', 'MAINTC', 'ALARM', 'OPLOG',
  'LOG', 'LOGBK', 'PANEL', 'MEM', 'IO', 'EXIO', 'VER', 'ATCTL', 'GCOMT',
  'PLCDAT', 'PLCMON', 'CSTPL1', 'CSTTP1', 'SHTCUT', 'WVPRM', 'PAINT',
  'PRTCTC', 'MSRRSC', 'SYSC89', 'SYSC94', 'SYSC95', 'SYSC96', 'SYSC97',
  'SYSC98', 'SYSC99', 'POSNI#', 'POSSI#', 'TOLSI#', 'MCRNI#', 'MCRSI#',
]

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.help || !args.host) {
    usage()
    process.exit(args.host ? 0 : 1)
  }

  const port = Number(args.port ?? 10000)
  const files = resolveFiles(args)

  console.log()
  console.log('Brother probe')
  console.log(`  target   ${args.host}:${port}`)
  console.log(`  files    ${files.length} (${files.slice(0, 6).join(', ')}${files.length > 6 ? ', ...' : ''})`)
  if (args.out) console.log(`  saving   ${args.out}`)
  console.log('-'.repeat(70))

  // show the frame for the first file before we touch the network, so a silent
  // control can be diagnosed against the reference by eye.
  const sample = encodeLoad(files[0])
  console.log()
  console.log(`Request frame for ${files[0]}:`)
  console.log(`  literal  ${visible(sample)}`)
  console.log(`  hex      ${hex(sample)}`)
  console.log(`  ${sample.length} bytes`)

  if (args.out) fs.mkdirSync(args.out, { recursive: true })

  const connection = new BrotherConnection({
    host: args.host,
    port,
    connectTimeout: Number(args.connectTimeout ?? 4000),
    readTimeout: Number(args.readTimeout ?? 6000),
    connectRetries: Number(args.retries ?? 2),
  })

  const results = []
  for (const file of files) {
    process.stdout.write(`\n${'='.repeat(70)}\n${file}\n${'='.repeat(70)}\n`)
    const started = Date.now()
    try {
      const raw = await connection.load(file)
      const ms = Date.now() - started
      const parsed = parseResponse(raw)
      results.push({ file, ok: true, bytes: raw.length, lines: parsed.lines.length, ms })

      console.log(`  ${raw.length} bytes, ${parsed.lines.length} lines, ${ms}ms`)
      console.log()
      for (const line of parsed.lines.slice(0, args.maxLines ?? 40)) {
        const fields = line.fields.length
        console.log(
          `  [${String(line.index).padStart(3)}] ${line.symbol.padEnd(8)} ` +
            `${String(fields).padStart(3)} fields  ${truncate(line.raw, 120)}`
        )
      }
      if (parsed.lines.length > (args.maxLines ?? 40)) {
        console.log(`  ... ${parsed.lines.length - (args.maxLines ?? 40)} more lines`)
      }

      if (args.out) {
        fs.writeFileSync(path.join(args.out, `${file}.raw`), raw, 'ascii')
      }
    } catch (error) {
      const ms = Date.now() - started
      results.push({ file, ok: false, error: error.message, ms })
      console.log(`  FAILED after ${ms}ms: ${error.message}`)
      // a refused or timed-out connection on the FIRST file means the path or
      // the ethernet option is the problem, not the file - stop rather than
      // grinding through forty timeouts.
      if (results.length === 1 && !args.keepGoing) {
        console.log()
        console.log('  First request failed. Stopping - fix the path before probing further.')
        console.log('  Check, in this order:')
        console.log('    1. can you ping/arp the host at all, from this machine')
        console.log('    2. DATA BANK > 6. Communication Parameters > Ethernet / FTP')
        console.log('       Port No = 10000, Remote Operation = 1, Reset Slave = 1,')
        console.log('       Data Overwrite = 1, Use DHCP = 0, Restrict Ethernet Access = 0')
        console.log('    3. that you are on a network segment the control answers on')
        console.log('  Re-run with --keep-going to probe every file regardless.')
        break
      }
    }
  }

  summarize(results, args)
}

function summarize(results, args) {
  const ok = results.filter(r => r.ok)
  const failed = results.filter(r => !r.ok)

  console.log()
  console.log('='.repeat(70))
  console.log('Summary')
  console.log('='.repeat(70))
  console.log(`  answered  ${ok.length}`)
  console.log(`  failed    ${failed.length}`)

  if (ok.length > 0) {
    console.log()
    console.log('  Files that answered:')
    for (const r of ok) {
      console.log(
        `    ${r.file.padEnd(10)} ${String(r.bytes).padStart(7)} bytes  ` +
          `${String(r.lines).padStart(4)} lines  ${r.ms}ms`
      )
    }
    console.log()
    console.log('  CNC-D00 speaks the protocol. Next: map the fields you need in')
    console.log('  schemas/brother/inputs.yaml, using the line symbols above.')
    if (args.out) console.log(`  Raw captures saved to ${args.out} - keep them, they are the map source.`)
  } else {
    console.log()
    console.log('  Nothing answered. Either the path is wrong or D00 dropped this')
    console.log('  protocol. Before concluding the latter, confirm the Ethernet')
    console.log('  parameters at the panel - Remote Operation = 1 is the usual miss.')
  }
  console.log()
}

// helpers

function resolveFiles(args) {
  if (args.files) {
    return args.files.split(',').flatMap(f => expandFileName(f.trim())).filter(Boolean)
  }
  if (args.all) return ALL_FILES.flatMap(expandFileName)
  return OEE_FILES
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = camel(arg.slice(2))
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      args[key] = true
    } else {
      args[key] = next
      i++
    }
  }
  return args
}

function camel(s) {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
}

// render control characters so a frame can be read in a terminal
function visible(s) {
  return s.replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/ /g, '·')
}

function hex(s) {
  return Array.from(s)
    .map(c => c.charCodeAt(0).toString(16).padStart(2, '0'))
    .join(' ')
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + '…' : s
}

function usage() {
  console.log(`
Brother Speedio protocol probe

  node src/drivers/brother/probe.js --host <host> [options]

Options
  --host <host>        control hostname or ip (eg cnc23) - required
  --port <n>           default 10000
  --files A,B,C        comma-separated file names ('#' expands to 1..9,0)
  --all                probe every file the 2018 reference knew about
  --out <dir>          save raw responses to this directory
  --max-lines <n>      lines to print per file (default 40)
  --keep-going         keep probing even if the first request fails
  --connect-timeout <ms>
  --read-timeout <ms>
  --retries <n>        connect attempts per request (default 2)

Grace machines
  cnc23  = 879  Brother Speedio U500Xd1-5AX
  cnc27  = 880  Brother Speedio U500Xd1-5AX
  cnc25  = 884  RobotFlex S2 handler (between them - not a Brother control)

Examples
  node src/drivers/brother/probe.js --host cnc23
  node src/drivers/brother/probe.js --host cnc23 --all --out ./probe-cnc23
`)
}

main().catch(error => {
  console.error()
  console.error(`Brother probe failed: ${error.message}`)
  process.exit(1)
})
