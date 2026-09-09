# Grace Engineering setup

A Ladder99 setup for Grace Engineering (Memphis, Michigan).

**There are no Grace machines on the network yet.** So this setup runs against the
six public Mazak demo MTConnect agents at `mtconnect.mazakcorp.com`. They are
real agents serving real machine data, which is enough to build and validate the
whole pipeline — adapter → agent → relay → postgres → grafana — before the first
cable is pulled on the shop floor.

## What it reads

| Agent alias | URL | Device | Alias |
|---|---|---|---|
| `Main` | `http://agent:5000` | `host` | `Host` |
| `Mazak5610` | `mtconnect.mazakcorp.com:5610` | `d1` | `MFMS10-MC2` |
| `Mazak5611` | `mtconnect.mazakcorp.com:5611` | `d1` | `Mazak-5611` [^1] |
| `Mazak5612` | `mtconnect.mazakcorp.com:5612` | `d1` | `MFMS18-MC1` |
| `Mazak5701` | `mtconnect.mazakcorp.com:5701` | `d1` | `M12345` |
| `Mazak5717` | `mtconnect.mazakcorp.com:5717` | `d1` | `M12346` |
| `Mazak5719` | `mtconnect.mazakcorp.com:5719` | `d1` | `HCN001` |

[^1]: The device aliases are the names each agent publishes on `/probe`, verified
against the live endpoints. 5611 is the exception — its device is literally named
`Mazak`, too vague for a path step, so it gets its port appended. Note also that
several of these agents publish the *same* device uuid as each other, so the
agent alias is the only thing separating them.

`Main` is the local agent, fed by the local adapter running the `host` driver —
cpu, memory, disk and temperature of the box the pipeline runs on. It is the
canary: if `Main/Host` goes stale, the problem is this box, not the network.

The six Mazak agents are remote and already speak MTConnect, so the relay reads
them directly over http. They are **not** in `volumes/agent/agent.xml` — only
devices we translate into SHDR ourselves go there.

Every alias in that table is baked into database paths (`Mazak5610/MFMS10-MC2/…`)
and therefore into every dashboard query. **Don't rename one** — it orphans all
of that device's history.

## Running it

Docker must be installed. From the repo root, with the CLI on your PATH
(`shell/install/cli` then `source ~/.bashrc`; otherwise call `shell/l99`):

```bash
l99 use grace   # make this the current setup - writes .l99_setup
l99 start       # start everything in the 'base' profile
```

The **first** `l99 start` copies `.env-example` to `.env` and stops, so you can
set the Grafana and Postgres passwords before anything initializes. Do that, then
run `l99 start` again. Both passwords are only read once, when their service
first creates its store — changing them in `.env` afterwards does nothing.

First run pulls and builds images and can take 10+ minutes.

Useful afterwards:

```bash
l99 list           # what's running
l99 logs relay     # follow a service's logs
l99 logs agent     # 'Cannot find device configuration file' etc shows up here
l99 restart
l99 stop
```

## Where to look

| URL | What |
|---|---|
| http://localhost:3000 | **Grafana** — the dashboards. Opens on the `fleet` dashboard. |
| http://localhost:5000/current | **MTConnect Agent** — current values for the local `host` device |
| http://localhost:5000/probe | the local agent's device model, ie what `agent.xml` produced |
| http://localhost:8080 | Dozzle — container logs in a browser |
| http://localhost:9000 | Portainer — container management |
| http://localhost:5050 | pgAdmin — postgres console |

Grafana's first login is the user/password from `.env`
(`GF_SECURITY_ADMIN_USER` / `GF_SECURITY_ADMIN_PASSWORD`); it prompts for a new
password after that.

Note Grafana is on **3000**, not 80. `setups/example` publishes on 80, which is a
bad default and clashed with something already bound there during testing.

The Mazak endpoints are public demo servers on the open internet. They go down,
they get restarted, and they are not ours — a gap in that data is a fact about
Mazak's demo server, not a fault in this pipeline. Sanity-check one in a browser
(eg http://mtconnect.mazakcorp.com:5701/current) before debugging the relay.

## No AngularJS

`volumes/grafana/etc/grafana.ini` sets `angular_support_enabled = false`, on
purpose. `setups/example` needs AngularJS — its dashboards use
`natel-discrete-panel` and the old `graph` panel — and that dependency is why the
Grafana image is pinned below 11, where Angular is off by default, and below 12,
where it is gone.

This setup does not carry that forward. Every panel here must be a React panel
(`timeseries`, `state-timeline`, `stat`, `table`, …). Turning the setting off is
the enforcement: a reintroduced Angular panel renders an "Angular plugin support
is disabled" error rather than quietly working today and going blank on the next
Grafana bump.

## The Brother machines

`setup.yaml` carries a **commented-out, ready-to-uncomment** block for the two
Brother Speedio U500Xd1-5AX machines:

| Machine | Host | |
|---|---|---|
| 879 | `cnc23` | Brother Speedio U500Xd1-5AX |
| 880 | `cnc27` | Brother Speedio U500Xd1-5AX |

**They are not cabled to the network yet.** The driver and schema already exist
in this repo. When the drops are in:

1. Probe first, before configuring anything —
   `node src/drivers/brother/probe.js --host cnc23 --out ./probe-cnc23` from
   `services/adapter`. No Docker, no agent, no database.
2. Uncomment the matching blocks in **all three** places that have to agree:
   `setup.yaml` (adapter device + relay device), `volumes/agent/agent.cfg` (an
   `Adapters` block per device, named after the device `name`), and
   `volumes/agent/agent.xml` (a `<Device>` per machine).
3. Note the ports: `7890` is already taken by `Host`, so the Brothers start at
   `7891`. Every adapter device needs its own tcp port to the agent.

Read `services/adapter/src/schemas/brother/README.md` first — it documents the
control parameters to set at the panel (`Remote Operation = 1` is the usual
miss), what is verified versus guessed in the field maps, and why 884 (`cnc25`,
the RobotFlex handler between them) is deliberately absent.

## Files

```
setup.yaml                          devices, agents, retention - the heart of it
.env-example                        template for .env (passwords, ports) - .env is gitignored
services/docker-compose.yaml        which services are in the 'base' profile
volumes/agent/agent.cfg             local agent config - SHDR adapter ports
volumes/agent/agent.xml             local agent device model - the 'host' device only
volumes/grafana/etc/grafana.ini     grafana settings
volumes/grafana/etc/dashboards/     this setup's dashboards (fleet.json is home)
volumes/grafana/etc/provisioning/   datasource + dashboard provisioning
```

The device `id`, `name` and agent `Adapters` block name must agree across
`setup.yaml`, `agent.cfg` and `agent.xml`. Mismatched ids are the classic
Ladder99 failure — the agent crash-loops with "Cannot find device configuration
file" or can't find dataitems, and the logs are unhelpful about why. Each of
those three files says so at the top; keep it that way.
