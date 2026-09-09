# Brother Speedio schema

Reads a Brother Speedio control over its native protocol on **TCP 10000** and
feeds the values into the Ladder99 pipeline as SHDR.

Driver: [`src/drivers/brother/`](../../drivers/brother/).

## Status — read this first

| Piece | State |
|---|---|
| Request framing, checksum, response parsing | **Verified** against the 2018 reference, 21 unit tests |
| Driver behaviour: polling, queueing, availability, recovery | **Verified**, 6 integration tests against a fake control |
| That **CNC-D00** still speaks this protocol | **Unverified** — no machine has been probed |
| Field order inside `L01` / `G01` / `M01` | From the reference (B00/C00 era). Plausible, unconfirmed on D00 |
| Field order for positions, feedrate, tool no. (`X01`) | **Unknown** — shipped commented out |
| Field layout of `WKCNTR`, `ALARM` | **Unknown** — captured raw |

Nothing here has met a machine. The framing is the part worth trusting; the maps
are a starting point, and `probe.js` exists to replace guesses with fact.

## Grace machines

| Machine | Host | What |
|---|---|---|
| 879 | `cnc23` | Brother Speedio U500Xd1-5AX |
| 880 | `cnc27` | Brother Speedio U500Xd1-5AX |
| 884 | `cnc25` | RobotFlex S2 handler — *not* a Brother control, won't answer this protocol |

879 and 880 are a robot-tended cell with 884 between them. A Brother sitting idle
because the robot is loading the other one is not the same as one idle because
nothing is scheduled — read utilisation across the cell, not per spindle.

## 1. Probe before configuring anything

```bash
cd services/adapter
node src/drivers/brother/probe.js --host cnc23 --out ./probe-cnc23
```

No Docker, no agent, no database — just Node and a network path. It prints the
exact bytes it sends before sending them, so a silent control can be diagnosed
without a packet capture.

If nothing answers, work through this in order:

1. Can you reach the host at all from where you're standing? These controls
   often drop ICMP — check ARP, not just ping.
2. At the panel: `DATA BANK > 6. Communication Parameters > Ethernet / FTP` —
   `Port No = 10000`, `Remote Operation = 1`, `Reset Slave = 1`,
   `Data Overwrite = 1`, `Use DHCP = 0`, `Restrict Ethernet Access = 0`.
   **`Remote Operation = 1` is the usual miss.**
3. Addresses are keyed **without dots and with leading zeros** —
   `192.168.0.50` is entered as `192168000050`.

Probe everything the reference knew about with `--all`. Keep the `.raw`
captures; they are the source material for every field map you write next.

## 2. Turn captures into field maps

`probe.js` prints each line's symbol and field count. `inputs.yaml` maps them:

```yaml
- symbol: M01
  items:
    - { name: m_spindle, type: number }   # first field after the symbol
    - { name: m_coolant, type: number }   # second
```

Item `[0]` aligns to the **first field after the symbol token**. If a control
turns out to be offset by one, set `skip: 1` on the line rather than editing
code. Matching is by symbol, so line order in the response doesn't matter.

Types: `number` (with optional `decimals`), `enum` (with a `values` index map),
`bool`, `string`. An enum index that isn't in the map surfaces as
`UNMAPPED_<code>` rather than vanishing — that's how you discover a wrong map.

Anything not yet mapped can be captured whole with `raw: true`. Raw values land
in the cache but are **not** sent to the agent unless you add them to
`outputs.yaml`, which is what you want while you're still working things out.

Keep `inputs.yaml`, `outputs.yaml` and `module.xml` in step. An output with no
DataItem is dropped by the agent; a DataItem with no output reads `UNAVAILABLE`
forever, which looks like a broken machine rather than an unfinished map.

## 3. Wire it into a setup

In your setup's `setup.yaml`:

```yaml
adapter:
  devices:
    - id: cnc23 # must match id in agent.xml
      name: Brother879 # must match name in agent.cfg and agent.xml
      sources:
        - driver: brother
          schema: brother
          connect:
            host: cnc23 # hostname, or an ip once one is measured
            port: 10000
      outputs:
        agent:
          host: adapter
          port: 7890

    - id: cnc27
      name: Brother880
      sources:
        - driver: brother
          schema: brother
          connect:
            host: cnc27
            port: 10000
      outputs:
        agent:
          host: adapter
          port: 7891 # each device needs its own agent port

relay:
  agents:
    - alias: Main
      url: http://agent:5000
      devices:
        - id: cnc23
          alias: Brother879
          retention: 1week
        - id: cnc27
          alias: Brother880
          retention: 1week
```

In `agent.cfg`, one adapter block per device — the block name must match the
device `name`, and the port must match `outputs.agent.port`:

```
Adapters {
   Brother879 {
      Host = adapter
      Port = 7890
   }
   Brother880 {
      Host = adapter
      Port = 7891
   }
}
```

In `agent.xml`, a `<Device>` per machine whose `id` matches the device `id` and
whose DataItem ids match the keys in `outputs.yaml` — `${deviceId}-${key}`, eg
`cnc23-avail`. See `module.xml` here for the DataItem set this schema produces.

Mismatched ids between these three files are the classic Ladder99 failure: the
agent restarts in a loop and the logs are unhelpful about why.

## Tests

```bash
cd services/adapter
npm run test:brother
```

27 tests, no hardware and no Docker. The codec is deliberately pure and separate
from the driver so it can be exercised on a laptop; the driver tests stand up a
fake Speedio on localhost and cover the socket, the request queue, availability
transitions and recovery.

## Design notes

**One socket per request, strictly serialized.** The reference opens and closes
a connection per `LOD`, and a CNC control is not a web server — assume it holds
one conversation at a time. The request queue releases its slot only after the
socket has fully closed, so the control never briefly sees two.

**A slow control can't build a backlog.** If a file's previous poll is still
outstanding when the next tick arrives, that tick is skipped rather than queued.

**Failures are tolerated before they're reported.** A single miss is noise — a
control mid-reboot, or busy. Only after `failuresBeforeUnavailable` consecutive
misses does the device go `UNAVAILABLE` with a `FAULT` condition, so dashboards
don't flicker.

**Starts `UNAVAILABLE`.** The first successful poll flips it. A dashboard should
say "not talking to the machine" rather than show values from before it was
switched off.

**The checksum is weak by design of the protocol, not by ours.** It's the ASCII
sum mod 16 — sixteen possible values. Treat a match as "probably not garbled",
never as integrity.

## Provenance

Wire format read from
[`Lathejockey81/BrotherAdapter`](https://github.com/Lathejockey81/BrotherAdapter)
(MIT, C#, 2018). Control parameters from FactoryWiz's Brother configuration
notes, documented there for the C Series. Port 10000 is corroborated by both.

Two deviations from the reference, both deliberate:

- It starts its item loop at index 1, silently dropping the first field of every
  line. We align from 0 and offer `skip` for controls that disagree.
- It tests `startsWith('%') && endsWith('%')` on the raw buffer, which only
  terminates if the control sends no trailing CRLF. We tolerate trailing
  whitespace and require enough bytes that a lone `%` can't satisfy both ends.
