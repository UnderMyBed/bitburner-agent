# @bitburner-agent/brain

The long-running brain process (architecture D1): the bridge to the game, the telemetry store, and from M4 the planner. In M2 it runs the control channel and stores what the in-game Agent reports, and serves the Remote File API, over which it deploys the in-game code ([#91](https://github.com/UnderMyBed/bitburner-agent/issues/91)) and backs up the game's save ([#92](https://github.com/UnderMyBed/bitburner-agent/issues/92)). The dashboard ([#93](https://github.com/UnderMyBed/bitburner-agent/issues/93)) and supervisor ([#94](https://github.com/UnderMyBed/bitburner-agent/issues/94)) join it next.

## Running it

```
npm run brain -- --data-dir D:\bitburner-agent
```

Or set `BITBURNER_AGENT_DATA_DIR` instead of passing `--data-dir`.

- **There's no default data directory.** It holds bulk data (the store, the save backups), so it belongs on a non-system drive the owner picks ([ADR 0006](../../docs/decisions/0006-tech-stack-and-compute.md)). Without one, the brain refuses to start and says how to give it. A relative path is taken from the directory the command was run in.
- **Logs** go to stdout, one line per event, each cut at 500 characters; fatal errors go to stderr. A fatal error exits non-zero, so whatever runs the brain restarts it ([#95](https://github.com/UnderMyBed/bitburner-agent/issues/95)). The startup lines name the release, the deployment it deploys, the two ports, and where the save backups go.
- **At start it builds the in-game code** from its own checkout (`packages/ingame`, with esbuild from `npm ci`) into `<data dir>/ingame-build/`, rebuilt from scratch every start, and checks each file against the build's manifest. So it always deploys the code it was started from, with no separate build step. It also reads the pinned game's definition file, for the version check: the checkout needs the `vendor/bitburner-src` submodule (`git clone --recurse-submodules`), or the brain stops at start, saying which file is missing.
- **Deploying:** whenever the game connects to the Remote File API (on load, and after a drop, by its own reconnection setting), the brain checks the game's version and deploys if `agent/current.txt` names another deployment ([the steps](../../docs/bridge/protocol.md#deploying)). The very first start of the Agent on a save is by hand: `run agent/boot.js` in the game's terminal; autoexec does it on every load after that (#95).

## The data directory

| File | What |
|---|---|
| `config.json` | Created with defaults on first run, then read |
| `telemetry.sqlite` | The store (below), with its WAL files |
| `ingame-build/` | The in-game code built at start, which the brain deploys |
| `saves/<environment>/` | The game's save backups ([below](#save-backups)) |

`config.json`:

| Field | Default | What |
|---|---|---|
| `environment` | `E0` | Which environment this brain serves: `E0` Steam, `E2` a source build under test ([architecture §9.4](../../docs/architecture.md#94-environments)). A simulator's brain (`E1`) runs from code, with no config |
| `controlPort` | 12526 | The control channel ([docs/bridge/protocol.md](../../docs/bridge/protocol.md)) |
| `remoteFileApiPort` | 12525 | The Remote File API server: the game's RFA settings must name it (#91, #95) |
| `dashboardPort` | 12527 | The dashboard (#93) |
| `allowedOrigins` | `["file://"]` | `Origin` headers allowed to connect; `file://` is Steam's page |
| `token` | 32 random bytes, hex | The control channel's shared secret, generated once |
| `saveBackupIntervalMinutes` | 30 | How often the game's save is backed up, besides once on each RFA connection |
| `saveBackupsKept` | 96 | How many save backups to keep per environment, the newest: two days at 30 minutes |

A config that isn't valid stops the brain, naming the file and the problem:
- invalid JSON, or not an object;
- another environment;
- ports out of range, or two the same;
- no allowed origins;
- a token that isn't 64 hex digits;
- a backup interval that isn't a number of minutes above 0 and at most 35791 (the longest a timer can wait, about 24.8 days), or a count kept that isn't a whole number of at least 1.

A config from before the backup fields existed is refused too, naming one missing field and its default at a time. Add both (`"saveBackupIntervalMinutes": 30, "saveBackupsKept": 96`), or start from a fresh data directory.

A port of 0 picks any free port, which is for tests only: the game's RFA settings can't name it, and a control port of 0 changes at every start, so every start would be a new deployment.

## The telemetry store

SQLite through Node's built-in `node:sqlite`, in WAL mode so the dashboard can read while the brain writes (architecture §7, §11).

| Table | Rows |
|---|---|
| `snapshots` | Every snapshot the control channel passes on: `environment`, `release`, `agent_session_id`, `tier`, `sequence_number`, `game_time_ms`, `received_at_ms`, `missed_before`, `data` (JSON) |
| `events` | Everything else the brain's parts report: the channel's `agentConnected`, `agentDisconnected`, `connectionRejected`, `versionDrift`; the deployer's `deployed`, `deployFailed`, `versionDrift`; and the save backups' `saveBackup`, `saveBackupRotationFailed`. Columns: `environment`, `release`, `at_ms`, `kind`, `detail` (JSON) |
| `settings` | Switches the dashboard sets, e.g. pausing supervision (#93, #94) |

- **Every row is tagged** with its environment and its release, so releases and environments can be compared directly (§7). The release is:
  - the brain's `git describe` ("unknown" without git, which the startup log shows);
  - plus the deployment of the Agent connected when the row arrived, or `none` while no Agent is. A deployer or save-backup event's is the deployment the brain deploys.

  For example, `v0.2.0+3f2a1b…`.
- **Writes wait up to 5 s** for a reader's lock, so a reader never fails a write.
- **Timestamps** (`received_at_ms`, `at_ms`) come from the brain's clock: the system clock live, virtual time under the simulator.
- **No thinning yet:** a day of snapshots is about 50,000 rows. Thinning comes with the campaign's months of data (M4, [#15](https://github.com/UnderMyBed/bitburner-agent/issues/15)).

## Save backups

The brain backs up the game's save over the Remote File API (`getSaveFile`; architecture §6). The backups are insurance against a bug or a corrupted save (game issue #2809 is open on 3.0.1), and real starting states for the simulator.

- **When:** once on each RFA connection (the game connects on load and after a drop), and every `saveBackupIntervalMinutes` from the brain's start, over the newest open connection.
  - One at a time: a backup asked for while one is under way follows it (several such become one).
  - With no open connection (none yet, or the last one closed), the interval's backup fails and is recorded, so a stretch with no backups shows.
  - The backups share the RFA connection with the deployer, each on its own client (request ids are unique per connection).
- **What:** the game's save at that moment, in the format Steam writes to `bitburnerSave_*.json.gz` (gzip bytes). It's a fresh save, not a copy of Steam's file. The brain checks it is what the game's own Import Game accepts before keeping it:
  - the game sent it as bytes (`binary: true`). A page without CompressionStream sends text instead, which isn't Steam's;
  - every character is a byte;
  - it gunzips into valid UTF-8, then JSON, then a `BitburnerSaveObject` with a player (`data.PlayerSave`).
- **Where:** `<data dir>/saves/<environment>/<UTC time>.json.gz`, for example `saves/E0/2026-10-27T03-30-00.000Z.json.gz` (`-` for `:`, which Windows doesn't allow).
  - Each environment has its own folder, so a simulator's or source build's backup (`E1`, `E2`) never sits beside Steam's (`E0`).
  - Each is written under a temporary name, then renamed. A half-written backup is only ever a `<name>.partial` file: it's removed when the write fails, and by the next rotation after a crash.
  - Two backups in the same millisecond: the second replaces the first.
- **Rotation:** after each backup the brain keeps the newest `saveBackupsKept` in that environment's folder and deletes the rest.
  - Only files named as backups count; anything else in the folder is left alone.
  - The backup just written is never deleted, even if the clock went back and its name sorts first.
  - An old backup that can't be deleted (in use, say) is reported as a `saveBackupRotationFailed` event, and the rest are still rotated.
- **Recorded:** every backup is a `saveBackup` event in the store, with the file (relative to the data directory) and its size, or with the failure. A failed or damaged backup is never kept. Failures include:
  - no open connection;
  - no reply in 30 s;
  - a save that isn't valid;
  - a disk error.

  Anything else is a bug, and stops the brain (fail fast).
- **Size:** the RFA server takes frames up to 128 MiB. A save reply is about twice the gzip save's size, so saves up to about 60 MB gzipped come through. A larger one would close the connection.
- **Restoring one:**
  1. **First, stop the brain, or copy the backup you want out of `saves/`.** A running brain keeps backing up whatever the game holds, on every reconnect and every interval, and rotation deletes the oldest. After a bad bug, or a corruption that still loads, that would push the good backups out.
  2. In the game: Options → Import Game, pick the `.json.gz`, then confirm. The game replaces the current save and reloads. It accepts these gzip files as they are (`src/SaveObject.ts:338-355`).
  3. When the brain runs again, the reload's RFA connection backs up the restored save.
  - **Only `E0` backups may ever go into Steam.** Saves flow one way: nothing from the simulator or a source build goes back (architecture §9.4).
  - Backups are personal data. They live in the data directory, outside the repository; never commit one.
- **In the simulator:** a backup loads as a save fixture as it is (`{ kind: "save", path }`), to the same state as the game's own save at that moment (`test/save-backup-round-trip.test.ts`).
- **Backups before irreversible intents** (R8) come with intents, in M3 (#11).

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
await game.runUntil(() => channel.connectedAgent() !== null, 10_000);   // or fail after 10 virtual s
```

- **Each step:**
  1. the brain's queued frames and closes go to the page;
  2. the simulation advances one step;
  3. what the page's sockets did comes back in order, each handed to the brain at its own virtual time, with the brain's timers fired in between;
  4. the brain's clock moves to the simulation's time.
- **Determinism:** the same seed and step size give the same run, however long the brain's work takes in real time. Tests check it with a deliberately slow brain.
  - **The brain's handlers must be synchronous.** A batch of frames is handed over without yielding, so the continuation of an `await` on real I/O would land in whichever step real time put it in. Awaiting only replies that come through the driver is fine, as the deployer does.
- **Closes:**
  - A connection the brain closes stops carrying frames at once, but is reported closed only once the close reaches the page (the next step), as a live socket reports it after the closing handshake.
  - A close by the page is reported at the virtual time it happened.
- **Fail fast:**
  - Steps can't overlap: await each one.
  - A reload can't happen mid-step.
  - A page socket to a URL nothing listens on fails the step, once the whole batch has been handled.
- **The brain's clock** takes delays as Node does: under 1 ms, or not a number, waits 1 ms, so a timer that re-arms itself can't spin.
- **Fix the step size per test:** the brain's replies reach the page at the start of the next step, so the step size is part of what makes a run.
- **Waiting (`runUntil`):** steps until a condition holds, checked before each step, and fails once more than the given virtual time has passed.
- **Faults (`deliveredCopies`):** a test can say how many copies of each frame from the page reach the brain: 0 drops it, 2 duplicates it, both copies back to back.
  - The function is called once per frame, in order, so a seeded one gives a reproducible run.
  - It isn't asked about frames on a connection the brain has already closed: the brain would discard them anyway.
  - An answer that isn't a whole number of copies fails the step.
- **Reloads (`replaceSimulation`):** for a save loaded into a new simulation; start it with the same `network.listenUrls`.
  - Every socket of the old page closes at once, as a reload closes them, and frames still queued for it are dropped.
  - The steps then drive the new simulation, and the brain stays as it was.
  - The brain's clock never goes back: if the save's time is a moment behind it, the clock waits for the reloaded game to catch up.

## The skeleton suite

`test/skeleton.test.ts` is M2's exit criterion in the simulator (environment E1): "connect, snapshot, reload, reconnect, Agent RAM in an 8 GB fresh start" ([architecture §13](../../docs/architecture.md#13-milestones)). It runs on every PR, in about 25 s in CI, against a budget of 60 s.

- **What runs:** the brain is wired like `main.ts` (`test/helpers/brain-in-simulation.ts`): its control channel, deployer, store and save backups, in `main.ts`'s order, with the deployer and the backups sharing the game's RFA connection. The game deploys through its own Remote File API client, and the built Agent and workers play their part. Everything is on the lockstep driver at a fixed 100 ms step. `main.ts`'s own wiring, on real sockets, is tested by `brain-process.test.ts`.
- **The start:** a new game with 8 GB of home RAM, the tutorial skipped, and settings naming the brain's Remote File API and running `agent/boot.js` on autoexec. The brain deploys; the one-time `run agent/boot.js` brings the Agent up.

| Scenario | What it shows |
|---|---|
| 8 GB fresh start | For 10 virtual minutes every tier arrives in the right number, each its period apart. Home never holds more than the Agent and one worker. The store holds every snapshot exactly once, numbered with none missed, and the gap report finds no gap. A save backup is taken beside the deploy, on the same connection |
| Reload | The game's save, loaded into a new simulation, brings the Agent back through autoexec alone: the Agent is a temporary script, so the save doesn't hold it. It's a new session, from the same deployment, and it sends a full snapshot. The reloaded game's RFA client reconnects, nothing is deployed again, and a new backup is taken |
| Reconnect | The brain drops the connection. The same Agent session comes back after its first backoff (1 s) with a full snapshot, its numbering carrying on, and there's no gap |
| The Agent stopped for 30 s | The gap report finds exactly that one gap |
| Faults on the wire | For 5 virtual minutes, snapshot frames are dropped (30%) and duplicated (15%) at random, seeded, and three heartbeats in a row are always dropped. Every snapshot that got through is stored once, and each records how many of its tier were dropped since the one stored before it. The gap report finds the gaps the drops made and no others |
| Determinism | The faulty run, a minute long, run twice with the same seed and step, stores identical rows and events, timestamps included |

- **Home's RAM:** a snapshot worker starts and exits within one timer, so checking between steps would never see it. The suite reads the simulator's `homePeak` instead, which is taken as RAM in use and the script count change. Home must have run exactly two scripts at most (the Agent and a worker, which also shows a worker ran), and used at most the RAM of the Agent plus the largest worker, by the game's own figures.
- **Faults are on snapshot frames from the page only.** Over a WebSocket a frame can't be lost or repeated while the connection stays up, so the faults are there to try the store and the gap report, which only snapshots reach. A lost hello is the hello timeout's case, which the control channel's own tests cover, as they cover a duplicate that arrives late.
- **What it doesn't model:** a reload here loads a save taken that moment; a real one loads the last save, which may be older. The old page's sockets also close before the new Agent says hello.

## Layout

| Path | What |
|---|---|
| `src/main.ts` | The process (`npm run brain`) |
| `src/config.ts` | The data directory and `config.json` |
| `src/telemetry-store.ts` | The store |
| `src/record-channel-events.ts` | The control channel's, the deployer's and the save backups' events into the store |
| `src/in-game-build.ts` | Reads the in-game build (checked against its manifest) and the pinned definitions |
| `src/gap-report.ts`, `src/gaps-cli.ts` | The gap report and its command (`npm run gaps`) |
| `src/simulated-game.ts` | The lockstep driver |
| `src/save-backups.ts` | The save backups |
| `src/release.ts` | The brain's release, from `git describe` |
| `test/skeleton.test.ts` | The skeleton suite |
| `test/helpers/brain-in-simulation.ts` | The brain wired like `main.ts`, on the lockstep driver |
