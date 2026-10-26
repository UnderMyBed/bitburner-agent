# @bitburner-agent/brain

The long-running brain process (architecture D1): the bridge to the game, the telemetry store, and from M4 the planner. In M2 it runs the control channel and stores what the in-game Agent reports, and serves the Remote File API, over which it deploys the in-game code ([#91](https://github.com/UnderMyBed/bitburner-agent/issues/91)). The dashboard ([#93](https://github.com/UnderMyBed/bitburner-agent/issues/93)) and supervisor ([#94](https://github.com/UnderMyBed/bitburner-agent/issues/94)) join it next.

## Running it

```
npm run brain -- --data-dir D:\bitburner-agent
```

Or set `BITBURNER_AGENT_DATA_DIR` instead of passing `--data-dir`.

- **There's no default data directory.** It holds bulk data (the store, later save backups), so it belongs on a non-system drive the owner picks ([ADR 0006](../../docs/decisions/0006-tech-stack-and-compute.md)). Without one, the brain refuses to start and says how to give it. A relative path is taken from the directory the command was run in.
- **Logs** go to stdout, one line per event, each cut at 500 characters; fatal errors go to stderr. A fatal error exits non-zero, so whatever runs the brain restarts it ([#95](https://github.com/UnderMyBed/bitburner-agent/issues/95)). The startup lines name the release, the deployment it deploys, and the two ports.
- **At start it builds the in-game code** from its own checkout (`packages/ingame`) into `<data dir>/ingame-build/`, and checks each file against the build's manifest. So it always deploys the code it was started from, with no separate build step. It also reads the pinned game's definition file from the `vendor/bitburner-src` submodule, for the version check.
- **Deploying:** whenever the game connects to the Remote File API (on load, and after a drop, by its own reconnection setting), the brain checks the game's version and deploys if `agent/current.txt` names another deployment ([the steps](../../docs/bridge/protocol.md#deploying)). The very first start of the Agent on a save is by hand: `run agent/boot.js` in the game's terminal; autoexec does it on every load after that (#95).

## The data directory

| File | What |
|---|---|
| `config.json` | Created with defaults on first run, then read |
| `telemetry.sqlite` | The store (below), with its WAL files |
| `ingame-build/` | The in-game code built at start, which the brain deploys |

`config.json`:

| Field | Default | What |
|---|---|---|
| `environment` | `E0` | Which environment this brain serves: `E0` Steam, `E2` a source build under test ([architecture §9.4](../../docs/architecture.md#94-environments)). A simulator's brain (`E1`) runs from code, with no config |
| `controlPort` | 12526 | The control channel ([docs/bridge/protocol.md](../../docs/bridge/protocol.md)) |
| `remoteFileApiPort` | 12525 | The Remote File API server: the game's RFA settings must name it (#91, #95) |
| `dashboardPort` | 12527 | The dashboard (#93) |
| `allowedOrigins` | `["file://"]` | `Origin` headers allowed to connect; `file://` is Steam's page |
| `token` | 32 random bytes, hex | The control channel's shared secret, generated once |

A config that isn't valid stops the brain, naming the file and the problem:
- invalid JSON, or not an object;
- another environment;
- ports out of range, or two the same;
- no allowed origins;
- a token that isn't 64 hex digits.

A port of 0 picks any free port, which is for tests only: the Agent couldn't find it.

## The telemetry store

SQLite through Node's built-in `node:sqlite`, in WAL mode so the dashboard can read while the brain writes (architecture §7, §11).

| Table | Rows |
|---|---|
| `snapshots` | Every snapshot the control channel passes on: `environment`, `release`, `agent_session_id`, `tier`, `sequence_number`, `game_time_ms`, `received_at_ms`, `missed_before`, `data` (JSON) |
| `events` | Everything else the bridge reports: the channel's `agentConnected`, `agentDisconnected`, `connectionRejected`, `versionDrift`, and the deployer's `deployed`, `deployFailed`, `versionDrift`. Columns: `environment`, `release`, `at_ms`, `kind`, `detail` (JSON) |
| `settings` | Switches the dashboard sets, e.g. pausing supervision (#93, #94) |

- **Every row is tagged** with its environment and its release, so releases and environments can be compared directly (§7). The release is:
  - the brain's `git describe` ("unknown" without git, which the startup log shows);
  - plus the deployment of the Agent connected when the row arrived, or `none` while no Agent is. A deployer event's is the deployment the brain deploys.

  For example, `v0.2.0+3f2a1b…`.
- **Writes wait up to 5 s** for a reader's lock, so a reader never fails a write.
- **Timestamps** (`received_at_ms`, `at_ms`) come from the brain's clock: the system clock live, virtual time under the simulator.
- **No thinning yet:** a day of snapshots is about 50,000 rows. Thinning comes with the campaign's months of data (M4, [#15](https://github.com/UnderMyBed/bitburner-agent/issues/15)).

## The gap report

The evidence for M2's exit criterion, "live snapshots on Steam for 24 h without gaps" (architecture §13):

```
npm run gaps -- --data-dir D:\bitburner-agent --since 2026-10-27T00:00:00Z --until 2026-10-28T00:00:00Z
```

- **What it lists:** every interval between consecutive fast snapshots (the heartbeat, every 2 s) longer than the threshold, including from the window's start to the first snapshot and from the last one to its end. It also shows the count, the first and last snapshots, and the longest interval.
- **What it proves:** that the Agent was alive. A fast snapshot counts even when its tiers are degraded (`game: null`, [degraded snapshots](../ingame/README.md#snapshots)); whether data arrived shows in each snapshot's `degradedTiers`.
- **Options:**
  - `--threshold-seconds`, default 6: three cadences. Exactly the threshold isn't a gap.
  - Times need a `Z` or an offset (`2026-10-27T00:00:00Z`): without one, JavaScript would read them as local time.
  - A window that ends before it starts (or a `--since` in the future) checks nothing, so it's an error (exit 2), never "no gaps".
  - It opens the store read-only, so it's safe while the brain runs.
  - `--environment`, default `E0`.
  - `--until`, default now.
- **Exit codes:** 0 with no gaps, 1 with gaps, 2 when it couldn't run.

## The lockstep driver

`SimulatedGame` (`src/simulated-game.ts`) runs a brain against a simulation ([ADR 0012](../../docs/decisions/0012-simulator-network-in-lockstep.md)). Every brain-plus-simulator test uses it; the live brain never loads it.

```ts
const simulation = await Simulation.start({ …, network: { listenUrls: ["ws://127.0.0.1:12526"] } });
const game = await SimulatedGame.create({ simulation, stepMs: 100 });
const channel = new ControlChannel({ token, clock: game.clock });
game.listen("ws://127.0.0.1:12526", (connection) => channel.accept(connection));
await game.run(60_000);   // virtual ms
```

- **Each step:**
  1. the brain's queued frames and closes go to the page;
  2. the simulation advances one step;
  3. what the page's sockets did comes back in order, each handed to the brain at its own virtual time, with the brain's timers fired in between;
  4. the brain's clock moves to the simulation's time.
- **Determinism:** the same seed and step size give the same run, however long the brain's work takes in real time. Tests check it with a deliberately slow brain.
  - **The brain's handlers must be synchronous.** A batch of frames is handed over without yielding, so the continuation of an `await` on real I/O would land in whichever step real time put it in.
- **Closes:**
  - A connection the brain closes stops carrying frames at once, but is reported closed only once the close reaches the page (the next step), as a live socket reports it after the closing handshake.
  - A close by the page is reported at the virtual time it happened.
- **Fail fast:**
  - Steps can't overlap: await each one.
  - A page socket to a URL nothing listens on fails the step, once the whole batch has been handled.
- **The brain's clock** takes delays as Node does: under 1 ms, or not a number, waits 1 ms, so a timer that re-arms itself can't spin.
- **Fix the step size per test:** the brain's replies reach the page at the start of the next step, so the step size is part of what makes a run.

## Layout

| Path | What |
|---|---|
| `src/main.ts` | The process (`npm run brain`) |
| `src/config.ts` | The data directory and `config.json` |
| `src/telemetry-store.ts` | The store |
| `src/record-channel-events.ts` | The control channel's events into the store |
| `src/gap-report.ts`, `src/gaps-cli.ts` | The gap report and its command (`npm run gaps`) |
| `src/simulated-game.ts` | The lockstep driver |
| `src/release.ts` | The brain's release, from `git describe` |
