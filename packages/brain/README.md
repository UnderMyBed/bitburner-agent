# @bitburner-agent/brain

The long-running brain process (architecture D1): the bridge to the game, the telemetry store, and from M4 the planner. Since M2 ([v0.2.0](https://github.com/UnderMyBed/bitburner-agent/releases/tag/v0.2.0)) it runs the control channel and stores what the in-game Agent reports, and serves the Remote File API, over which it deploys the in-game code ([#91](https://github.com/UnderMyBed/bitburner-agent/issues/91)) and backs up the game's save ([#92](https://github.com/UnderMyBed/bitburner-agent/issues/92)). It also serves the local [dashboard](#the-dashboard) ([#93](https://github.com/UnderMyBed/bitburner-agent/issues/93)), and, for Steam on Windows, [supervises](#supervision) the game itself ([#94](https://github.com/UnderMyBed/bitburner-agent/issues/94)). In M3 it starts telling the Agent what to run: first [the hack loop](#the-hack-loop) ([#134](https://github.com/UnderMyBed/bitburner-agent/issues/134)).

## Running it

```
npm run brain
```

From the repo, in a terminal, until stopped (Ctrl+C). Nothing is installed (owner decision 30). `npm run brain` runs `src/start.ts`, which runs the brain (`src/main.ts`) as a child process and starts it again after a crash: after 5 s, then 10, 30 and 60 s in a crash loop, back to 5 s after a run of 5 minutes (`src/restart-on-crash.ts`). Ctrl+C reaches both, the brain shuts down cleanly, and nothing is restarted. After a reboot, run it again. [docs/setup.md](../../docs/setup.md) has the owner's steps, from a clone (`npm run bootstrap`) to a running skeleton. One brain per game.

- **On Windows, an E0 brain (the default) runs the game itself.** Within 30 s it launches Bitburner through Steam. If no Agent reports for about 5 minutes, it kills and relaunches the game ([Supervision](#supervision)). Pause supervision on the dashboard while you set the game up.
- **The data directory is the repo's `.data/`** (gitignored), so everything stays in the repo ([#122](https://github.com/UnderMyBed/bitburner-agent/issues/122)). `--data-dir <dir>` or `BITBURNER_AGENT_DATA_DIR` picks another; a relative path is taken from the directory the command was run in. Tests always pass their own (with an E2 config): a brain started in `.data/` creates an E0 config, which on Windows launches Steam's game.
- **Logs** go to stdout, one line per event, each cut at 500 characters; fatal errors go to stderr, and the brain exits non-zero. The startup lines name the release, the deployment it deploys, the control channel's and the Remote File API's ports, where the save backups go, the dashboard's address, whether it supervises the game, and whether the hack loop is on. Each switch flipped on the dashboard is logged too.
- **At start it builds the in-game code** from its own checkout (`packages/ingame`, with esbuild from `npm ci`) into `<data dir>/ingame-build/`, rebuilt from scratch every start, and checks each file against the build's manifest. So it always deploys the code it was started from, with no separate build step. It also reads the pinned game's definition file, for the version check: the checkout needs the `vendor/bitburner-src` submodule (`npm run bootstrap` fetches it), or the brain stops at start, saying which file is missing.
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
| `steamAppId` | 1812820 | Bitburner's Steam app ID, which the [supervisor](#supervision) launches (E0 on Windows only) |
| `gameExecutable` | `bitburner.exe` | The game's executable, as tasklist shows it: a file name, no folder |

A config that isn't valid stops the brain, naming the file and the problem:
- invalid JSON, or not an object;
- another environment;
- ports out of range, or two the same;
- no allowed origins;
- a token that isn't 64 hex digits;
- a backup interval that isn't a number of minutes above 0 and at most 35791 (the longest a timer can wait, about 24.8 days), or a count kept that isn't a whole number of at least 1;
- a Steam app ID that isn't a whole number of at least 1, or a game executable that isn't a bare `.exe` file name.

A config from before the backup and supervision fields existed is refused too, naming one missing field and its default at a time. Add them (`"saveBackupIntervalMinutes": 30, "saveBackupsKept": 96, "steamAppId": 1812820, "gameExecutable": "bitburner.exe"`), or start from a fresh data directory.

A port of 0 picks any free port, which is for tests only: the game's RFA settings can't name it, and a control port of 0 changes at every start, so every start would be a new deployment.

## The telemetry store

SQLite through Node's built-in `node:sqlite`, in WAL mode so a reader (the gap report's command) never blocks the brain's writes (architecture §7, §11).

| Table | Rows |
|---|---|
| `snapshots` | Every snapshot the control channel passes on: `environment`, `release`, `agent_session_id`, `tier`, `sequence_number`, `game_time_ms`, `received_at_ms`, `missed_before`, `data` (JSON) |
| `events` | Everything else the brain's parts report: the brain's own `brainStarted` (at each start); the channel's `agentConnected`, `agentDisconnected`, `connectionRejected`, `versionDrift`; the deployer's `deployed`, `deploymentCurrent`, `deployFailed`, `versionDrift`; the save backups' `saveBackup`, `saveBackupRotationFailed`; and the supervisor's `relaunch`, `supervisionGaveUp`, `supervisionFailed`. Columns: `environment`, `release`, `at_ms`, `kind`, `detail` (JSON) |
| `settings` | Switches kept across restarts: `supervision.paused` (the dashboard's switch), `supervision.gaveUpAtMs` (the supervisor's give-up, #94), and `hackLoop.enabled` (the hack loop's switch, on when unset, #134) |

- **Every snapshot and event is tagged** with its environment and its release, so releases and environments can be compared directly (§7). The release is:
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
  - Backups are personal data. They live in the data directory, by default the repo's gitignored `.data/`; never commit one, and keep `.data/` ignored.
- **In the simulator:** a backup loads as a save fixture as it is (`{ kind: "save", path }`), to the same state as the game's own save at that moment (`test/save-backup-round-trip.test.ts`).
- **Backups before irreversible intents** (R8) come with intents, in M3 (#11).

## The dashboard

A local page showing whether the skeleton is healthy, its alerts, and its switches, supervision and the hack loop ([#93](https://github.com/UnderMyBed/bitburner-agent/issues/93); architecture §7, §10.2). Open **http://127.0.0.1:12527/** (`dashboardPort`) while the brain runs.

- **What it shows,** refreshed every 2 s from the store:
  - **Alerts:** the ones holding now (below).
  - **Agent:** connected or not, and since when, as of this run of the brain; its deployment and session; the game's version, and whether it's the pinned one.
  - **Last snapshot per tier:** when each tier last arrived, and how long ago.
  - **Game:** from the latest fast and medium snapshots: money, hacking level, home RAM used of its total, scripts on home, the page's heap, and the tiers the Agent is skipping (`degradedTiers`).
  - **Gaps in the last 24 h:** the gap report over the fast snapshots, from 24 h before now: how many gaps and their total time, with the newest 20 listed. Any time without snapshots in the window counts: from the window's start to the first snapshot with a new store, or while the brain or the Agent was down.
  - **Supervision:** off, running, paused, or gave up; the supervisor's recent relaunches; and the switch (hidden when off).
  - **Hack loop:** on or off; on, whether the brain is waiting for the Agent's snapshots, has no target yet (while servers are being rooted), or runs it against a target on so many servers; and its switch ([the hack loop](#the-hack-loop)).
  - **Recent events:** the last 50, newest first, including rejected connections and their origin.
- **When it can't show the status,** it says why in place of the data, rather than showing stale numbers:
  - "Brain unreachable": the brain stopped, or crashed;
  - "The brain couldn't answer": the brain failed to build the status (it logs why);
  - "The dashboard couldn't show the brain's status": the page itself failed.
- **The supervision switch:** while supervision runs, the button pauses it; otherwise (paused, or given up) it resumes it, and resuming also clears a give-up. Paused, the supervisor won't relaunch the game, so it can be closed on purpose. The switch is kept in the store's `settings`, so it survives restarts of the brain. A switch the brain refuses says so under the button.
  - **A brain that doesn't supervise** (anything but Steam's game on Windows) shows supervision "off": nothing reads the switch there.
  - **The contract with the supervisor** (`src/supervision.ts`): it reads the switch with `readSupervisionSwitch` at every check, and again before any kill or launch; it records a give-up with `recordSupervisionGaveUp` (the `supervision.gaveUpAtMs` setting); and it records each launch as a `relaunch` event (`RELAUNCH_EVENT_KIND`), with its cause as `{ cause }`. The dashboard lists the newest 10.
- **Alerts** are rules over the store, evaluated each time the page asks, so there's no alert state to get out of step.
  - **"Since the brain started"** means after the brain's own `brainStarted` event, which it records once its in-game build is ready. That's this run of the brain, whatever the clock does.

  | Alert | When | Clears |
  |---|---|---|
  | `agentSilent` | No fast snapshot for over 60 s, counted from the brain's start if none came since | When the next one arrives |
  | `versionDrift` | The brain went on hold since it started: the game isn't the pinned version (#91) | When the brain restarts (a hold lasts the brain's run) |
  | `deployFailed` | The last deploy since the brain started failed | When a deploy succeeds, or a connection finds the deployment already in place (`deploymentCurrent`), or the brain restarts |
  | `supervisionGaveUp` | The supervisor stopped after too many relaunches (#94) | When supervision is resumed |

  The stall alert (no progress on the route's critical path) needs a route, so it comes with the planner (M4).
- **Security** (owner decision 14, localhost only):
  - it listens on `127.0.0.1` only;
  - it refuses (403) a request whose `Host` isn't `127.0.0.1:<port>` or `localhost:<port>`, so a web page can't reach it by DNS rebinding;
  - it refuses (403) any request another site's page makes (`Sec-Fetch-Site`, or an `Origin` that isn't its own), so no page can even make the brain build its status;
  - it refuses (403) a `POST` without the dashboard's own `Origin`, so another page can't flip a switch;
  - the page can't be framed by another page, and everything from the brain is shown as text, never as HTML.
- **The API** (the page's; a script must follow the same rules):
  - `GET /api/status` gives the status as JSON (`src/dashboard/status.ts`, `DashboardStatus`).
  - `POST /api/supervision` with `{"paused": true}` or `{"paused": false}` sets the switch, and answers with the same. A script must send `Origin: http://127.0.0.1:12527` (with the dashboard's port) and `Content-Type: application/json`.
  - `POST /api/hack-loop` with `{"enabled": true}` or `{"enabled": false}` sets the hack loop's switch, the same way.
  - Refusals:
    - 403: not the dashboard's Host or Origin;
    - 400: a body that isn't exactly one of its switch's two, or a path that isn't valid;
    - 413: a body over 1 KiB;
    - 404 or 405: another path or method;
    - 500: the brain failed, and logs why. The server carries on.

## The hack loop

M3's first slice ([#134](https://github.com/UnderMyBed/bitburner-agent/issues/134), owner decision 34): the brain tells the Agent to run a hack loop on the game's servers, and the Agent does it ([`packages/ingame`](../ingame/README.md#the-hack-loop)). It's the first desired state (architecture D2), and the code is `src/hack-loop.ts`.

- **The switch:** on unless the owner turns it off on the dashboard. It's the store's setting `hackLoop.enabled`, so it survives restarts of the brain. Off is sent at once, and the Agent stops every loop at its next round: within two rounds (4 s).
- **The target** (`chooseHackTarget`): a starter rule, until the planner (M4) decides.
  - Among the game's rooted servers with money (not home, not the player's purchased or Hacknet servers) that need at most half the player's hacking level (at least 1), it takes the one with the highest maximum money times growth.
  - Growth counts because the loop hacks only once a server's money is back at 75% of its maximum, and servers start at 4%. Over an 8 GB fresh start's first virtual hour, n00dles (growth 3000) earned $15m. foodnstuff, joesguns and sigma-cosmetics, with more money but growth 5–20, earned nothing.
- **The hosts** (`chooseHackHosts`): the game's rooted servers with RAM. Never home, which is the Agent's, and never the player's own purchased or Hacknet servers.
- **The controller** (`HackLoopController`) keeps the control channel's desired state in step with the switch and the connected Agent's snapshots:
  - **Off** is sent at once, to each Agent as it connects too.
  - **On** waits for that Agent's own static and medium snapshots, which come in its first round, then sends the target (or none yet, while the servers get rooted) and the hosts. It never sends the last brain's or the last game's view:
    - a brain that restarts sends the running Agent the same state, which changes nothing;
    - an Agent after a reset is never given a target its game can't hack.
  - The channel sends each connection a state once, then again on a change. It sends only to a welcomed Agent running the deployed code, and while the brain holds, only "off" ([protocol](../../docs/bridge/protocol.md#rules)).
  - The dashboard shows the controller's own view: on or off, waiting for the snapshots, the target and the number of hosts.
- **Wiring:** `main.ts` makes the controller before the control channel listens. The simulator suite wires it the same way through `test/helpers/brain-in-simulation.ts` (`withHackLoop`). `brain-process.test.ts` doesn't cover it.
- **The suite** (`test/hack-loop-skeleton.test.ts`), in an 8 GB fresh start in the simulator:
  - The Agent roots the no-port servers and runs the loop on each against the brain's target (n00dles). The money grows by over $500,000 in 10 virtual minutes.
  - An owner's script already on foodnstuff is untouched, and the loop there has only the RAM it left.
  - Home never holds more than the Agent and one worker, the hack loop's included.
  - **A loop killed from outside** is back within one convergence (30 s) and a round.
  - **Off,** every loop is gone within two rounds and stays gone. On again, they're back.
  - **A brain restart** leaves the loops alone: the very same processes.
  - **After a disconnect,** the Agent acts only on the next brain's instructions. From a brain that sends none, a loop that stops stays stopped.
  - **With the desired state set directly:** only the named hosts run the loop, a new target restarts the loops against it, a dropped host's loop goes, and another deployment's loop is stopped.
  - **Home too full for the deploy worker:** it's tried again each round, never two at once, and runs as soon as there's room.

## Supervision

The brain keeps the game itself running, for unattended play ([#94](https://github.com/UnderMyBed/bitburner-agent/issues/94); architecture §10.2, R9). It's process management only: nothing touches the game's code or its save.

- **Only an E0 brain on Windows supervises** (Steam's game). A brain for a source build (E2), or one on another system, never launches or kills anything, and its dashboard shows supervision "off". Tests run the brain as E2 for that reason.
- **Setting up the game? Pause supervision on the dashboard first.** An E0 brain on Windows launches Bitburner within 30 s of starting. It kills and relaunches it if no Agent reports for about 5 minutes. That's always the case before the game's settings are made, before the first `run agent/boot.js`, and on a new save. Resume once the dashboard shows the Agent connected.
- **Every 30 s, unless paused or given up**, it looks, and waits are counted in checks, not by the clock. So the clock stepping (time sync, waking from sleep) can't make a healthy game look silent, or hide a frozen one:
  - **Not running** → launch it through Steam (`cmd /c start "" steam://rungameid/1812820`), as a player does. Cause: `notRunning`.
    - So starting the brain starts the game: after a reboot, `npm run brain` brings both back.
    - **After a launch it waits 10 checks (5 minutes) before doing anything else,** so Steam can start, log in or update the game. If the game still isn't running then, it launches again.
  - **Running, but no new heartbeat for 10 checks in a row** (the fast snapshot, every 2 s; about 5 minutes) → kill it (`taskkill /IM bitburner.exe /T /F`) and launch it. Cause: `silent`.
    - This covers a frozen page, and an Agent that died while the game runs: a reload brings it back through autoexec.
    - A heartbeat counts as new by being a new snapshot, not by its time.
    - At most the progress since the last autosave (60 s by default) is lost.
    - The heartbeat comes even when home is full and no worker can run, so a full home never looks silent.
    - If taskkill reports a failure but the game is gone anyway, it still launches.
  - **Grace:** silence counts only after 10 checks (5 minutes) since the brain started or supervision was resumed. After a launch, the 10 checks start once the launch's wait is over, so the earliest kill is 10 minutes after the launch (a brain restart or a resume in between starts a plain 10-check grace instead). That gives Steam time to start the game, and the Agent time to boot.
  - **Running** is what `tasklist /FI "IMAGENAME eq bitburner.exe" /FO CSV /NH` lists, matched by image name. Its "no tasks" message is in the system's language, so it isn't read. Any `bitburner.exe` counts, so don't run another copy of the game (a non-Steam download, say) alongside.
  - The three programs are run by their full path in System32, never through a shell's parsing.
  - The switch is read again just before anything is killed or launched, so a pause is never late.
- **At most 3 launches in any hour,** the first included. A 4th would mean a crash loop, so the supervisor gives up instead, which raises the dashboard's `supervisionGaveUp` alert.
  - It stays given up, across restarts of the brain, until you resume supervision on the dashboard. Resuming after a give-up starts the count afresh.
  - The count comes from the store, so a brain that keeps restarting can't get round it.
- **A check that fails** (a command that errors or times out after 30 s, or a switch setting it didn't write) is recorded once, when a run of failures starts. Ten failed checks in a row (5 minutes) give up, with the same alert, so a broken Steam link doesn't fail silently for ever.
- **Paused** (the dashboard's switch): nothing is launched or killed, so you can close the game on purpose, or set it up.
- **Recorded:**
  - each launch is a `relaunch` event, with its cause;
  - a give-up is a `supervisionGaveUp` event, with the cause and the launches in the last hour, or with the failure that kept happening;
  - the start of a run of failed checks is a `supervisionFailed` event, with the failure and the cause it was acting on.
- **Stopping the brain** stops the checks first, so the game isn't relaunched while the brain shuts down.
- **Config:** `steamAppId` (1812820, verified on the reference rig) and `gameExecutable` (`bitburner.exe`).
- **The owner's check** on the reference rig (game closed, Agent killed, paused) is [check 6 in docs/setup.md](../../docs/setup.md#the-owners-check), recorded on #94.

## The gap report

The evidence for M2's exit criterion, "live snapshots on Steam without gaps" (architecture §13), and for each release's live run ([releasing](../../docs/releasing.md) step 2):

```
npm run gaps -- --since 2026-10-27T00:00:00Z --until 2026-10-28T00:00:00Z
```

- **What it lists:** every interval between consecutive fast snapshots (the heartbeat, every 2 s) longer than the threshold, including from the window's start to the first snapshot and from the last one to its end. It also shows the count, the first and last snapshots, and the longest interval.
- **The page heap** over the same window, from the fast snapshots' `pageHeapUsedBytes`: the first and last values, the lowest and highest, and how many snapshots reported one, or "not reported" (E2 has none). Growth would show here first (architecture R10). It's for reading: it doesn't change the exit code.
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

- **What runs:** the brain is wired like `main.ts` (`test/helpers/brain-in-simulation.ts`): its control channel, deployer, store and save backups, in `main.ts`'s order (the hack loop aside: it has [its own suite](#the-hack-loop)), with the deployer and the backups sharing the game's RFA connection. The game deploys through its own Remote File API client, and the built Agent and workers play their part. Everything is on the lockstep driver at a fixed 100 ms step. `main.ts`'s own wiring, on real sockets, is tested by `brain-process.test.ts`.
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
- **What it doesn't model:** a reload here loads a save taken that moment; a real one loads the last save, which may be older. The old page's sockets also close before the new Agent says hello. E2's skeleton covers that, with the game's real autosave ([`packages/e2`](../e2/README.md#the-skeleton-on-e2)).

## Layout

| Path | What |
|---|---|
| `src/start.ts`, `src/restart-on-crash.ts` | `npm run brain`: runs `main.ts` and restarts it after a crash |
| `src/main.ts` | The brain's process |
| `src/config.ts` | The data directory and `config.json` |
| `src/telemetry-store.ts` | The store |
| `src/record-channel-events.ts` | The control channel's, the deployer's and the save backups' events into the store |
| `src/in-game-build.ts` | Reads the in-game build (checked against its manifest) and the pinned definitions |
| `src/gap-report.ts`, `src/gaps-cli.ts` | The gap report and its command (`npm run gaps`) |
| `src/simulated-game.ts` | The lockstep driver |
| `src/save-backups.ts` | The save backups |
| `src/dashboard/` | The dashboard: `server.ts` (HTTP), `status.ts` (what it shows), `alerts.ts` (the rules), `page.html` (the page) |
| `src/supervision.ts` | The supervision switch, in the store's settings |
| `src/hack-loop.ts` | The hack loop's switch, rules (target and hosts) and controller |
| `src/supervisor.ts`, `src/windows-game-process.ts` | The supervisor, and the game's process on Windows |
| `src/release.ts` | The brain's release, from `git describe` |
| `test/skeleton.test.ts` | The skeleton suite |
| `test/hack-loop-skeleton.test.ts` | The hack loop's suite |
| `test/helpers/brain-in-simulation.ts` | The brain wired like `main.ts`, on the lockstep driver; the hack loop's controller only when a test asks, so the M2 suites see the observe-only skeleton they test |
