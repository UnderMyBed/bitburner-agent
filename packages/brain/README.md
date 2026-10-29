# @bitburner-agent/brain

The long-running brain process (architecture D1): the bridge to the game, the telemetry store, and from M4 the planner. Since M2 ([v0.2.0](https://github.com/UnderMyBed/bitburner-agent/releases/tag/v0.2.0)) it runs the control channel and stores what the in-game Agent reports, and serves the Remote File API, over which it deploys the in-game code ([#91](https://github.com/UnderMyBed/bitburner-agent/issues/91)) and backs up the game's save ([#92](https://github.com/UnderMyBed/bitburner-agent/issues/92)). It also serves the local [dashboard](#the-dashboard) ([#93](https://github.com/UnderMyBed/bitburner-agent/issues/93)), and, for Steam on Windows, [supervises](#supervision) the game itself ([#94](https://github.com/UnderMyBed/bitburner-agent/issues/94)). In M3 it starts telling the Agent what to run: first [the hack loop](#the-hack-loop) ([#134](https://github.com/UnderMyBed/bitburner-agent/issues/134)).

## Running it

```
npm run brain
```

From the repo, in a terminal, until stopped (Ctrl+C). Nothing is installed (owner decision 30). `npm run brain` runs `src/start.ts`, which runs the brain (`src/main.ts`) as a child process and starts it again after a crash: after 5 s, then 10, 30 and 60 s in a crash loop, back to 5 s after a run of 5 minutes (`src/restart-on-crash.ts`). Ctrl+C reaches both, the brain shuts down cleanly, and nothing is restarted. After a reboot, run it again. [docs/setup.md](../../docs/setup.md) has the owner's steps, from a clone (`npm run bootstrap`) to a running skeleton. One brain per game.

- **On Windows, an E0 brain (the default) runs the game itself.** Within 30 s it launches Bitburner through Steam. If no Agent reports for about 5 minutes, it kills and relaunches the game ([Supervision](#supervision)). Pause supervision on the dashboard while you set the game up.
- **The data directory is the repo's `.data/`** (gitignored), so everything stays in the repo ([#122](https://github.com/UnderMyBed/bitburner-agent/issues/122)). `--data-dir <dir>` or `BITBURNER_AGENT_DATA_DIR` picks another; a relative path is taken from the directory the command was run in. Tests always pass their own (with an E2 config): a brain started in `.data/` creates an E0 config, which on Windows launches Steam's game.
- **Logs** go to stdout, one line per event, each cut at 500 characters; fatal errors go to stderr, and the brain exits non-zero. The startup lines name the release, the deployment it deploys, the control channel's and the Remote File API's ports, where the save backups go, the dashboard's address, whether it supervises the game, and whether the hack loop, the program buying and the home RAM upgrades are on. Each switch flipped on the dashboard is logged too, and so is an income stall as it starts and as it ends (`incomeStalled`, #184).
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

SQLite through Node's built-in `node:sqlite`, in WAL mode so a reader (the gap report's and the run report's commands) never blocks the brain's writes (architecture §7, §11).

| Table | Rows |
|---|---|
| `snapshots` | Every snapshot the control channel passes on: `environment`, `release`, `agent_session_id`, `tier`, `sequence_number`, `game_time_ms`, `received_at_ms`, `missed_before` (numbers skipped before it; after a brain restart, counted from the highest stored for its session and tier, #119), `data` (JSON) |
| `events` | Everything else the brain's parts report: the brain's own `brainStarted` (at each start); the channel's `agentConnected`, `agentDisconnected`, `connectionRejected`, `versionDrift`; the deployer's `deployed`, `deploymentCurrent`, `deployFailed`, `versionDrift`; the save backups' `saveBackup`, `saveBackupRotationFailed`; and the supervisor's `relaunch`, `supervisionGaveUp`, `supervisionFailed`. The game's dialogs the Agent handled, as `gameDialog` (#143), with their kind and text. A promotion the Agent took, as `workPromotion` (#155), with the company, the titles before and after, and the game's time, stored once (and logged). Columns: `environment`, `release`, `at_ms`, `kind`, `detail` (JSON) |
| `settings` | Switches kept across restarts: `supervision.paused` (the dashboard's switch), `supervision.gaveUpAtMs` (the supervisor's give-up, #94), `hackLoop.enabled` (the hack loop's switch, on when unset, #134), `work.desired` (the work the owner set on the dashboard, #151, #153, #156, #158), `programs.enabled` (buying the hacking programs, likewise, #136), `homeRam.enabled` (upgrading home's RAM, likewise, #138), `intents.manual` (the owner's manual intents queue, as `[{ action, args }]`, #141), and `intents.resetSent` (the note of a sent install or destroy, `{ id, field, resetAt }`, #175) |

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
  - Before an irreversible intent goes out ([intents](#intents)), on the desired state's asking (`backupNow`).
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
- **A backup before an irreversible intent** (R8, #147): `backupNow()` takes one at once and resolves with its own event, saved or failed. Asked while one is under way, it waits for the next, so the event is never from a backup that began before the asking. The desired state's gate asks for it ([intents](#intents)).

## The dashboard

A local page showing whether the skeleton is healthy, its alerts, and its switches: supervision, the hack loop, buying the hacking programs and upgrading home's RAM ([#93](https://github.com/UnderMyBed/bitburner-agent/issues/93); architecture §7, §10.2). Open **http://127.0.0.1:12527/** (`dashboardPort`) while the brain runs.

- **What it shows,** refreshed every 2 s from the store:
  - **Alerts:** the ones holding now (below).
  - **Agent:** connected or not, and since when, as of this run of the brain; its deployment and session; the game's version, and whether it's the pinned one.
  - **Last snapshot per tier:** when each tier last arrived, and how long ago.
  - **Game:** from the latest fast and medium snapshots: money, hacking level, home RAM used of its total, scripts on home, the page's heap, and the tiers the Agent is skipping (`degradedTiers`); and the hacking ceiling and hacking's income over the last 10 minutes (#196, [the hacking ceiling](#the-hacking-ceiling)).
  - **Gaps in the last 24 h:** the gap report over the fast snapshots, from 24 h before now: how many gaps and their total time, with the newest 20 listed. Any time without snapshots in the window counts: from the window's start to the first snapshot with a new store, or while the brain or the Agent was down.
  - **Supervision:** off, running, paused, or gave up; the supervisor's recent relaunches; and the switch (hidden when off).
  - **Hack loop:** on or off; on, whether the brain is waiting for the Agent's snapshots, has no target yet (while servers are being rooted), or runs it against a target on so many servers, and the next target it prepares on so many more ("on, against n00dles, on 21 servers, hacking with at most 92 threads; preparing zer0 on 7 servers, hacking with at most 48 threads", #184, #187: the hosts' hack threads added up, "at most" as a host's loop may have fewer threads than its RAM holds); and its switch ([the hack loop](#the-hack-loop)).
  - **Hacking programs:** on or off; on, the item being bought, or what it waits for (the Agent's snapshots, money for the next item, travel, or a cheaper home RAM upgrade first); what's owned; and its switch ([the hacking programs](#the-hacking-programs)).
  - **Home RAM:** on or off; on, the size the upgrade being bought brings home to, or what it waits for (the Agent's snapshots, money for the next size, travel, a cheaper program first, or the BitNode's price), or that home is at its limit; home's RAM; and its switch ([home RAM](#home-ram)).
  - **Intents:** each intent sent, in order, with its source (the manual queue or a purchase) and how it went in the game: not reported yet, done, or its tries and last problem. An irreversible one the gate holds, or one queued after an install, says why instead ("not sent: waiting for a save backup", #147, #164). A manual one has a Cancel button, and a form queues a new one: an action and its arguments as JSON ([intents](#intents)).
  - **Work** (#151, #153, #156, #158): the work the brain manages, focused or not, and how the Agent last reported it (with the latest promotion it took, #155), or "Not managed"; a form sets faction work (a faction and a work type), another company work (a company and a job field, Noodle Bar and Waiter to start with), a third a crime, a fourth a class (a university or gym, Rothman University to start with, and a course or stat), and **Stop managing work** clears it.
  - **Recent events:** the last 50, newest first, including rejected connections and their origin.
- **When it can't show the status,** it says why in place of the data, rather than showing stale numbers:
  - "Brain unreachable": the brain stopped, or crashed;
  - "The brain couldn't answer": the brain failed to build the status (it logs why);
  - "The dashboard couldn't show the brain's status": the page itself failed.
- **The supervision switch:** while supervision runs, the button pauses it; otherwise (paused, or given up) it resumes it, and resuming also clears a give-up. Paused, the supervisor won't relaunch the game, so it can be closed on purpose. The switch is kept in the store's `settings`, so it survives restarts of the brain. A switch the brain refuses says so under the button.
  - **A brain that doesn't supervise** (anything but Steam's game on Windows) shows supervision "off": nothing reads the switch there.
  - **The contract with the supervisor** (`src/supervision.ts`): it reads the switch with `readSupervisionSwitch` at every check, and again before any kill or launch; it records a give-up with `recordSupervisionGaveUp` (the `supervision.gaveUpAtMs` setting); and it records each launch as a `relaunch` event (`RELAUNCH_EVENT_KIND`), with its cause as `{ cause }`. The dashboard lists the newest 10.
- **Alerts** are rules over the store, evaluated each time the page asks, so there's no alert state to get out of step. `incomeStalled`'s one fact the store can't give cheaply, the money's last rise, comes from the brain's `IncomeWatch` (`src/income-watch.ts`), which notes it as each medium snapshot arrives: reading back every medium snapshot of an hours-long stall, each with the whole network, at every status read would cost too much.
  - **"Since the brain started"** means after the brain's own `brainStarted` event, which it records once its in-game build is ready. That's this run of the brain, whatever the clock does.

  | Alert | When | Clears |
  |---|---|---|
  | `agentSilent` | No fast snapshot for over 60 s, counted from the brain's start if none came since | When the next one arrives |
  | `versionDrift` | The brain went on hold since it started: the game isn't the pinned version (#91) | When the brain restarts (a hold lasts the brain's run) |
  | `deployFailed` | The last deploy since the brain started failed | When a deploy succeeds, or a connection finds the deployment already in place (`deploymentCurrent`), or the brain restarts |
  | `supervisionGaveUp` | The supervisor stopped (#94): after 3 launches in an hour, or after 10 failed checks in a row with the last failure (#127) | When supervision is resumed |
  | `dialogBlocking` | A dialog the Agent leaves for the owner (a script's prompt, one the owner opened) is open, in the newest fast snapshot (#143), quoting its text: nothing is done on the page while it's open | When it's closed |
  | `incomeStalled` | The hack loop is on with a target, and the player's money in the medium snapshots hasn't risen for over 10 minutes (`INCOME_STALLED_AFTER_MS`, #184), with how long, the money and the target. A purchase lowers money, which isn't a rise. The 10 minutes count from the last rise, or from when the watch began: the Agent's connection, a medium snapshot that finds the loop off or without a target, or the switch flipped on the dashboard. The brain logs a line as it starts and as it ends | When money rises, the loop goes off or loses its target, or the Agent disconnects or connects again |
  | `intentStuck` | An intent tried 5 times (2 minutes) and still not done, in the newest fast snapshot (#141); one alert per intent, with its last problem | When it's done, or leaves the list |

  The route-stall alert (no progress on the route's critical path) needs a route, so it comes with the planner (M4).
- **Security** (owner decision 14, localhost only):
  - it listens on `127.0.0.1` only;
  - it refuses (403) a request whose `Host` isn't `127.0.0.1:<port>` or `localhost:<port>`, so a web page can't reach it by DNS rebinding;
  - it refuses (403) any request another site's page makes (`Sec-Fetch-Site`, or an `Origin` that isn't its own), so no page can even make the brain build its status;
  - it refuses (403) a `POST` without the dashboard's own `Origin`, so another page can't flip a switch;
  - the page can't be framed by another page, and everything from the brain is shown as text, never as HTML.
- **The API** (the page's; a script must follow the same rules):
  - `GET /api/status` gives the status as JSON (`src/dashboard/status.ts`, `DashboardStatus`).
  - `POST /api/supervision` with `{"paused": true}` or `{"paused": false}` sets the switch, and answers with the same. A script must send `Origin: http://127.0.0.1:12527` (with the dashboard's port) and `Content-Type: application/json`.
  - `POST /api/hack-loop` with `{"enabled": true}` or `{"enabled": false}` sets the hack loop's switch, the same way, `POST /api/programs` the hacking programs' (#136), and `POST /api/home-ram` home RAM's (#138).
  - `POST /api/intents` with `{"action": …, "args": {…}}` queues an intent (#141), answered with `{"id": …}`, or 400 with why it isn't valid. `POST /api/intents/cancel` with `{"id": …}` takes one off the queue, or 404 if it isn't there. Both the same way as the switches.
  - `POST /api/work` with `{"work": {"faction": …, "workType": …}}` sets the work (#151), or `{"work": {"kind": "company", "company": …, "field": …}}` company work (#153), or `{"work": {"kind": "crime", "crime": …}}` a crime (#156), or `{"work": {"kind": "class", "location": …, "classType": …}}` a class (#158), or with `{"work": null}` stops managing it; 400 with why for one that isn't valid.
  - Refusals:
    - 403: not the dashboard's Host or Origin;
    - 400: a body that isn't JSON, a switch's body that isn't exactly one of its two, an intent that isn't valid (or a full queue), work that isn't valid or a body without `work`, or a path that isn't valid;
    - 413: a body over 1 KiB;
    - 404: another path, or cancelling an intent that isn't in the queue;
    - 405: another method;
    - 500: the brain failed, and logs why. The server carries on.

## The hack loop

M3's first slice ([#134](https://github.com/UnderMyBed/bitburner-agent/issues/134), owner decision 34): the brain tells the Agent to run a hack loop on the game's servers, and the Agent does it ([`packages/ingame`](../ingame/README.md#the-hack-loop)). It's the first desired state (architecture D2), and the code is `src/hack-loop.ts`.

- **The switch:** on unless the owner turns it off on the dashboard. It's the store's setting `hackLoop.enabled`, so it survives restarts of the brain. Off is sent at once, and the Agent stops every loop at its next round: within two rounds (4 s).
- **The target** (`chooseHackTarget`): a starter rule, until the planner (M4) decides.
  - Among the game's rooted servers with money (not home, not the player's purchased or Hacknet servers) that need at most half the player's hacking level (at least 1), it takes the one with the highest maximum money times growth.
  - Growth counts because the loop hacks only once a server's money is back at 75% of its maximum, and servers start at 4%. Over an 8 GB fresh start's first virtual hour, n00dles (growth 3000) earned $15m. foodnstuff, joesguns and sigma-cosmetics, with more money but growth 5–20, earned nothing.
- **The hosts** (`chooseHackHosts`): the game's rooted servers with RAM. Never home, which is the Agent's, and never the player's own purchased or Hacknet servers.
- **The move to the next target** (`planHackLoop`, [#184](https://github.com/UnderMyBed/bitburner-agent/issues/184)): on Steam, `7990834`'s loop moved every host from n00dles to zer0 when hacking reached 150, with zer0 at 4% of its money. The loop hacks only at 75% of the maximum and within 5 of the minimum security, so every thread weakened and grew it, and money stayed flat for 24 minutes until the owner stopped it. Now:
  - `best` is the starter rule's target. `current` is the target last set while it's still a candidate, across the Agent's reconnects while the game hasn't reset (the slow snapshot's `lastAugReset`). With none (a brain restart, the switch turned on, or a reset), it's the best candidate that's **ready**; else the one with the most of its money, of its maximum, if more than a fresh start's 4% (Server.ts:74-75): that's the one being worked, caught between a hack and its weaken; else `best`. Judged afresh on a reconnect, a target between a hack and its weaken isn't ready, and every host would have moved to the next target, the Steam stall again (#184 review).
  - **Ready** is the loop's own thresholds, in core (`isHackLoopReady`, `HACK_LOOP_MONEY_FRACTION`, `HACK_LOOP_SECURITY_MARGIN`), which `hack-loop.js` uses too: the medium snapshot's money at least 75% of the maximum, and security at most the minimum + 5.
  - `current` **earns** once a medium snapshot has shown it ready since it became the target (the loop has hacked it), or when it was taken as the one being worked.
  - `best` is `current`, or ready, or `current` doesn't earn yet: every host goes on `best`. Nothing earning is given up.
  - Otherwise `current` keeps earning on most hosts, and the largest, in RAM order (ties by name), **prepare** `best` until they hold at least half the hosts' RAM. Preparing is the same loop: it weakens and grows `best`, and hacks once it's ready. With two hosts or more, some are always left to earn. The hosts that prepared last time stay while they still hold at least half the RAM and leave some to earn, so a larger host rooted since doesn't stop a weaken or grow under way. With no host at all, nothing is prepared. The next medium snapshot that shows `best` ready moves every host to it.
  - The rule may move on while a target is prepared. In the simulator, zer0 was still being prepared when max-hardware became `best` at about hacking 160, and the loop moved from n00dles to max-hardware.
- **Each host's hack threads** (`hackThreads`, [#187](https://github.com/UnderMyBed/bitburner-agent/issues/187)): the loop hacks once money is at 75% of the maximum, so every host's loop sees that at about the same time and hacks together. With all their threads, they took max-hardware from $124m to $111 in the simulator, and its growth of 30 took 25 minutes to bring it back. So the brain gives each host, earning or preparing, the threads its loop hacks with:
  - **The rule:** a round of hacks by every host takes no more than `HACK_REGROW_ROUNDS` (2) rounds of their grows bring back. A round of grows multiplies the target's money by e^g: g is the hosts' threads (their RAM over the loop's 2.4 GB budget, core's `HACK_LOOP_RAM_BUDGET_GB`) times one thread's log of growth at the target's minimum security plus 5, the slowest the loop lets it grow (core's `growthLogPerThread`, the game's `calculateServerGrowthLog`, grow.ts:8-28). A host's hack with t threads keeps 1 − t × p of what it finds, p being one thread's share at the target's minimum security, the most it ever is (core's `percentMoneyHackedPerThread`, the game's `calculatePercentMoneyHacked`, Hacking.ts:44-57). Each host's part of 2g is its part of the RAM, G, and its threads are the most whose hack keeps at least e^−G: (1 − e^−G) / p. Together the hosts' hacks keep at least e^−2g.
  - **n00dles** (growth 3000) grows back from anything: every host's count is over its threads, so all of them hack, as before. **zer0 or max-hardware** (growth 30 to 40): a fraction.
  - **Each count** is at least 1, then rounded down to a power of two, so the share's slow rise with the hacking level changes it, and restarts that host's loop, only now and then. Then it's at most the threads the host's RAM holds (n00dles's count is all of them), still at least 1. A count over the loop's threads (RAM used by other scripts), the deploy worker caps.
  - **BitNode multipliers** aren't in core yet: `ScriptHackMoney` and `ServerGrowthRate` are taken as 1. That's exact in BN1. Elsewhere both are at most 1 (BitNode.tsx): the share per thread is then overestimated (fewer hack threads, safe), and so is the growth. In BN2 (0.8), BN3 and BN11 (0.2) that makes the counts up to 5× too generous, the unsafe side; it's to revisit when BitNode multipliers come to core. The player's `hacking_money` and `hacking_grow` multipliers come from the medium snapshot, 1 where it doesn't say.
  - **Why 2:** see [the income suite](#the-income-suite).
- **The controller** (`DesiredStateController`, `src/desired-state.ts`; since #151 it also sends [work](#work); since #141 it also sends [intents](#intents): [the hacking programs](#the-hacking-programs), [home's RAM](#home-ram) and the owner's manual queue) keeps the control channel's desired state in step with the switches and the connected Agent's snapshots:
  - **Off** is sent at once, to each Agent as it connects too.
  - **On** waits for that Agent's own static and medium snapshots, which come in its first round, then sends the target (or none yet, while the servers get rooted) and the hosts. It never sends the last brain's or the last game's view:
    - a brain that restarts sends the running Agent the same state, which changes nothing;
    - an Agent after a reset is never given a target its game can't hack.
  - It keeps the target it last set, whether it earns, and the hosts preparing the next one, for the move to the next target (#184): across the Agent's connections while `lastAugReset` is unchanged. It forgets them on a reset or the switch off; a new brain starts without them.
  - The channel sends each connection a state once, then again on a change. It sends only to a welcomed Agent running the deployed code. While the brain holds, it sends only what starts nothing new: the hack loop off, or as last sent, and no intents or work ([protocol](../../docs/bridge/protocol.md#rules)).
  - The dashboard shows the controller's own view: on or off, waiting for the snapshots, the target and the number of hosts, and the target being prepared with its number of hosts, each with its hosts' hack threads added up (#187).
- **Wiring:** `main.ts` makes the controller before the control channel listens, with the save backups it asks before an irreversible intent. The simulator suite wires it the same way through `test/helpers/brain-in-simulation.ts` (`withDesiredState`). `brain-process.test.ts` doesn't cover it.
- **The suite** (`test/hack-loop-skeleton.test.ts`), in an 8 GB fresh start in the simulator:
  - The Agent roots the no-port servers and runs the loop on each against the brain's target (n00dles). The money grows by over $500,000 in 10 virtual minutes.
  - An owner's script already on foodnstuff is untouched, and the loop there has only the RAM it left.
  - Home never holds more than the Agent and one worker, the hack loop's included.
  - **A loop killed from outside** is back within one convergence (30 s) and a round.
  - **Off,** every loop is gone within two rounds and stays gone. On again, they're back.
  - **A brain restart** leaves the loops alone: the very same processes.
  - **After a disconnect,** once connected again, the Agent acts only on that brain's instructions. From a brain that sends none, a loop that stops stays stopped. (With no brain at all, it's [safe mode](#safe-mode).)
  - **With the desired state set directly:** only the named hosts run the loop, a new target restarts the loops against it, a dropped host's loop goes, and another deployment's loop is stopped.
  - **Each host its own target** (#184): five hosts earn on n00dles while foodnstuff and joesguns prepare joesguns. When all move to joesguns, only the five loops against n00dles are stopped and started, and the owner's script on foodnstuff is untouched. The Agent's log names both while preparing: "on, N threads (H hacking) on 5 servers, against n00dles; preparing joesguns on 2 servers (H hacking)".
  - **Each host's hack threads** (#187): a count over a host's loop threads is capped at them; a host the state doesn't name hacks with all its threads; a changed count, or a first count for a host that had none (as from an older safe-mode file), restarts that host's loop alone, and the others keep their pids; the Agent's log gives the threads hacking. With 13 threads hacking in all (1 to 6 a host), the hosts' hacks never take n00dles below 70% of its money once it's at 75%: `hack`'s `threads` option at work, in the game's own code. (All 37 threads would take about 15% a round, to about 64%: arithmetic, not something the test runs.)
  - **Home too full for the deploy worker:** home never holds more than the Agent, the owner's script and one worker, and the deploy worker runs within two rounds of there being room.
  - **A purchase the page can't make** (#136; the simulator's page has no sidebar): each try logs why, the next comes 30 s later, and home never holds more than the Agent and one worker. E2 buys on the real page ([packages/e2](../e2/README.md)).
  - **A home RAM upgrade already made** (#138; an upgrade from 4 GB on the fresh start's 8 GB): the worker reports it done from the game alone, without touching the page, so a repeat never buys a second doubling.

### The income suite

`test/hack-loop-income.test.ts` (#184, #187) starts from an 8 GB fresh start in BN1, with the brain's rules as on Steam: the loop, the programs and home RAM, all on. It runs until the loop leaves n00dles for a better target, within 3 virtual hours, then 45 virtual minutes more. It reproduced the Steam stall on `7990834`: the move to zer0 came at 45 to 48 virtual minutes on each of seeds 1 to 8, and money stayed flat for the 45 minutes after.

**What it checks** (in CI, seed 1, about 12 s):
- Money never goes more than 10 virtual minutes without rising (`INCOME_STALLED_AFTER_MS`): around the move (any stretch that overlaps the prepare's start to 10 minutes after the move), and over the whole run from money's first rise.
- The brain logs no income stall.
- The loop stays off n00dles.

Seed 1 prepares from 48 minutes, moves to max-hardware at 90, and goes 7.7 minutes at most without a rise: 2.3 minutes to spare.

**Other seeds:** set `HACK_LOOP_INCOME_SEEDS` to the seeds, `1,2,3,4,5,6,7,8`. In PowerShell that's `$env:HACK_LOOP_INCOME_SEEDS = "1,2,3,4,5,6,7,8"`; afterwards run `Remove-Item Env:HACK_LOOP_INCOME_SEEDS`, as it stays set for the session. Then run `npm test -- packages/brain/test/hack-loop-income.test.ts --silent=false`, which takes about 95 s. An empty entry, or one that isn't a whole number from 1, fails loudly. Each seed prints its prepare start, its move, its longest stretch around the move and over the run, its money at the end, and what it earned after the move (money's rises added up: the money at the end depends on when the last purchase came). Earned misses the income of any 10 s sample in which a purchase lands, since that sample's money falls.

**#187, the drain.** On `3d6e5a6` (#184), seeds 2 to 4 failed the whole run, after the move: once every host hacked max-hardware, the loops all saw 75% at once and hacked it together. Its money fell to almost nothing (seed 2: $124m to $111 at 96 minutes), and took over 20 minutes to grow back. With [each host's hack threads](#the-hack-loop), all 8 seeds pass:

| Seed | Longest without a rise, `3d6e5a6` → now (min) | Money at the end | Earned after the move |
|---|---|---|---|
| 1 | 8.0 → 7.7 | $983m → $997m | $1.55b → $1.62b |
| 2 | **28.2** → 4.7 | $499m → $58m | $1.13b → $1.66b |
| 3 | **13.0** → 6.3 | $426m → $755m | $1.05b → $1.35b |
| 4 | **24.3** → 5.8 | $144m → $972m | $0.73b → $1.61b |
| 5 | 7.0 → 5.7 | $659m → $262m | $2.28b → $1.84b |
| 6 | 6.8 → 5.5 | $989m → $931m | $1.61b → $1.57b |
| 7 | 6.0 → 5.5 | $937m → $830m | $1.47b → $1.35b |
| 8 | 8.7 → 6.2 | $597m → $984m | $1.19b → $1.60b |
| All 8 | | $5.23b → $5.79b | $11.0b → $12.6b |
| 1 and 5–8 (never stalled) | | | $8.10b → $7.98b |

**The income criterion** (#187, the owner's): over the 8 seeds, neither total, earned after the move nor money at the end, may fall. Both rose. The gain is the three seeds that stalled: on the five that never did, earned fell 1.5%, and seed 5's by 19.6% ($2.28b → $1.84b): the cost of capping hacks that didn't need it there.

- **`HACK_REGROW_ROUNDS`, tuned here:** at 0.5, nearly every hack capped, they earned about half; at 2, the table; at 3, the cap doesn't bind on max-hardware at the move, and seed 4 went 11.0 minutes without a rise.
- **Money at the end swings with purchase timing:** a purchase just before the end takes most of it (seed 2's $58m). In a trial with the rounds at 8, where it never binds on max-hardware, seeds 1 and 5 to 8 matched `3d6e5a6` to the dollar, while seeds 2 and 4, on a different path, ended lower ($474m and $77m) though they earned more ($1.93b and $1.63b).

## The hacking ceiling

"How good is our hacking" as a number (#196, M4 phase A slice A1): the most hacking income a second that the hack loop's hosts' RAM could earn at the player's hacking now, from the game's formulas, against what hacking actually earned. The batcher (A7) is scored against it.

- **Per GB-second** (core's `hackingIncomePerGigabyteSecond`, `packages/core/src/hacking-ceiling.ts`): on a target at its minimum security and maximum money M, where every figure is at its best, each dollar hacked costs at least
  - **hack:** 1/(c·p·M) threads of a 1.7 GB script for T, c the chance (`hackChance`, Hacking.ts:9-24), p one thread's share (`percentMoneyHackedPerThread`, Hacking.ts:44-57) and T the hack time (`hackTimeSeconds`, Hacking.ts:60-80); failed hacks cost their time too;
  - **grow:** 1/(M·k + 1) threads of a 1.75 GB script for 3.2T, k one thread's growth log with the hosts' best core bonus (`growthLogPerThread`, grow.ts:8-29; ServerHelpers.ts:287-290). Growing a share f back takes x with (M(1 − f) + x)·e^(kx) = M (grow.ts:38-58), and log(1 + u) ≤ u gives x ≥ f·M/(M·k + 1) for any f;
  - **weaken:** the 0.002 a successful hack thread adds and the 0.004 a grow thread adds (Constants.ts:9; ServerHelpers.ts:209-211), over 0.05 × the core bonus a thread (Constants.ts:10), of a 1.75 GB script for 4T.

  A batch taking a share f costs at least that a dollar, and gets there only as f goes to 0 (grow's log is convex), so the best over f is this limit, a closed form. The script RAM is the game's: 1.6 GB base, 0.1 for `hack`, 0.15 for `grow` or `weaken` (RamCostGenerator.ts:11-20), not the hack loop's 2.4.
- **It assumes,** and so ignores: continuous batching with no gaps, every operation landing at the right moment, fractional threads, security and money held at their best, the hosts' whole RAM free, one target at a time, and the hacking level as the snapshot has it. It's an upper bound: a batcher can approach it, never pass it.
- **BitNode multipliers** are taken as 1: exact in BN1. Elsewhere `ScriptHackMoney`, `ScriptHackMoneyGain`, `ServerGrowthRate` and `HackingSpeedMultiplier` are at most 1, so it errs high, the safe side for a ceiling; BN11's `ServerWeakenRate` of 2 errs low (BitNode.tsx:896). To revisit when BitNode multipliers come to core.
- **Over the snapshots** (`hackingCeiling`, `src/hacking-ceiling.ts`): the hack loop's hosts (`chooseHackHosts`: the game's rooted servers with RAM, never home or the player's own), their `maxRam` in the medium snapshot added up, times the best per-GB-second among the targets: the game's servers rooted, with money, needing at most the player's hacking. Unknown, saying why, without both snapshots or the player's skills (`hacking`, `intelligence`) and multipliers (`hacking_chance`, `hacking_speed`, `hacking_money`, `hacking_grow`).
- **What hacking earned:** the slow snapshot's `moneySources` (#196), `ns.getMoneySources().sinceInstall`, whose `hacking` counts every hack's money (NetscriptHelpers.tsx:599). It rises between slow snapshots; after a fall (an install resets it) what it says is what was earned since. Money's rises would count crime and work, and purchases would hide hacking.
- **The dashboard's rows:** "Hacking ceiling: $X/s on T, with N GB on K servers", from the newest static and medium snapshots, and "Hacking income: $Y/s over the last 10 min (Z% of the ceiling now)", from the last 10 minutes of slow snapshots.
- **The run report's section 5** (`HackingFold`, fed by the run report's own pass over the store): each medium snapshot's ceiling, with the static snapshot then, stepped across each interval between slow snapshots; what hacking earned in it; added up over the window and each hour, as $ a second and a percentage, and the ceiling now. An interval where the ceiling was unknown isn't judged, and the section says for how long.
  - **A failure:** hacking earned more over the window than the ceiling's $ plus what the game's servers' money fell by from the first medium snapshot to the last (money held at the start, hacked and not grown back, which no RAM paid for in the window). That means the formula, or the measure, is wrong. Hacks finishing early in the window that started before it aren't allowed for: a few minutes' worth, small against a run.
  - **No floor yet:** A7's batcher sets one.
- **Tests:**
  - `packages/core/test/hacking-ceiling.test.ts`: chance, time, the bonuses and the per-dollar cost by hand on zer0, their edges, each multiplier and the cores, and a batch at shares from 0.9 to 0.0001 (grow threads solved as the game's `numCycleForGrowthCorrected` does) always below the ceiling, rising towards it.
  - `test/hacking-ceiling-parity.test.ts`: in the simulator, Formulas.exe bought through the simulator's own effectors, core's chance, share, hack, grow and weaken times, growth log (1 and 4 cores) and weaken against `ns.formulas.hacking`, over four servers (n00dles, zer0, phantasy and one hard to hack, above its minimum) and two players (one with every hacking multiplier moved, and intelligence); the security a thread against `hackAnalyzeSecurity` and `growthAnalyzeSecurity`; the scripts' RAM by the game's calculator; and the ceiling above a whole-thread batch sized with the game's own `growThreads`, at shares from 0.9 to 0.01.
  - `test/hacking-ceiling.test.ts`: the targets and hosts counted, the cores, the multipliers, the unknowns, the income's rises and resets, the step across medium snapshots, the section's lines, the failure and its allowance.
  - `test/run-report.test.ts`, `test/dashboard-status.test.ts`, `test/dashboard-page.test.ts`: the section, its FAIL, and the rows.

### The ceiling suite

`test/hacking-ceiling-simulation.test.ts` (#196) runs the brain from an 8 GB fresh start in BN1, with the loop, the programs and home RAM on, for 90 virtual minutes: past the loop's move from n00dles. Over the store, the run report's section 5 says what hacking earned against the ceiling, with no failure; read directly, hacking never earns more than the ceiling over the run, each hour, or each 10 minutes. In CI it runs seed 1, in about 11 s.

**The hack loop's percentage**, the baseline the batcher (A7) must beat (`HACKING_CEILING_SEEDS` set to `1,2,3,4,5,6,7,8`, as for the income suite, about 85 s):

| Seed | Hacking income / the ceiling, over 90 min | First hour | Last half hour | Most in any 10 min | The ceiling at the end |
|---|---|---|---|---|---|
| 1 | $19,074/s / $1,553,692/s: **1.2%** | 2.3% | 0.8% | 15.3% | $3.84m/s on phantasy, 1500 GB |
| 2 | $74,339/s / $1,973,812/s: **3.8%** | 1.8% | 4.7% | 15.4% | $4.42m/s, 1596 GB |
| 3 | $30,735/s / $1,585,170/s: **1.9%** | 1.9% | 2.0% | 14.7% | $3.47m/s, 1316 GB |
| 4 | $76,279/s / $2,053,551/s: **3.7%** | 2.0% | 4.4% | 11.6% | $4.99m/s, 1740 GB |
| 5 | $79,568/s / $2,062,046/s: **3.9%** | 1.8% | 4.7% | 14.9% | $4.88m/s, 1748 GB |
| 6 | $59,861/s / $1,751,468/s: **3.4%** | 1.8% | 4.3% | 15.2% | $3.69m/s, 1420 GB |
| 7 | $18,762/s / $1,561,188/s: **1.2%** | 2.0% | 0.8% | 14.1% | $3.39m/s, 1324 GB |
| 8 | $18,176/s / $1,301,643/s: **1.4%** | 2.2% | 0.9% | 14.5% | $2.66m/s, 1012 GB |

The loop reaches 1.2% to 3.9% of the ceiling over the run, and at best 15% in a 10-minute stretch (on n00dles, early). It hacks at 75% of the maximum money and up to 5 over the minimum security, with a 2.4 GB script whose threads mostly wait, and every server prepares its target from 4% of its money; the ceiling allows for none of that.

## The hacking programs

M3's second slice ([#136](https://github.com/UnderMyBed/bitburner-agent/issues/136)): the brain tells the Agent which hacking program to buy next, and the Agent buys it through the game's page ([`packages/ingame`](../ingame/README.md#the-hacking-programs)). The code is `src/programs.ts`.

- **The switch:** "Stop buying programs" on the dashboard ("Start buying programs" when off), on unless the owner turns it off (the store's `programs.enabled`), like the hack loop's.
- **The next item** (`chooseNextPurchase`), from the connected Agent's medium snapshot (`hasTorRouter`, `programs`, the player's money and city):
  - the first not owned, in the order TOR router, BruteSSH.exe, FTPCrack.exe, relaySMTP.exe, HTTPWorm.exe, SQLInject.exe;
  - once the player's money covers its price: $200k, $500k, $1.5m, $5m, $30m, $250m (`Constants.ts:44`, `DarkWeb/DarkWebItems.ts`);
  - the TOR router needs a tech vendor in the player's city, one per city that has any (`TECH_VENDORS` in core): Sector-12 Alpha Enterprises, Aevum NetLink Technologies, Ishima Omega Software, Volhaven CompuTek. Chongqing and New Tokyo have none, and the dashboard says travel is needed.
- **The dashboard** shows what's owned, what's being bought, or what it waits for (money for an item, or travel).
- **Sent as an intent** (#141): `buyTor { vendor }` or `buyProgram { program }`, in the one desired state, with the hack loop's rules: nothing new until the connected Agent's own snapshots; while the brain holds, only a state that starts nothing new (`desiredStateWhileHolding` in core: the hack loop off, or as last sent, and no intents).

## Home RAM

M3's third slice ([#138](https://github.com/UnderMyBed/bitburner-agent/issues/138)): the brain tells the Agent when to double home's RAM, and the Agent buys it at a tech vendor through the game's page ([`packages/ingame`](../ingame/README.md#home-ram)). The code is `src/home-ram.ts`.

- **The switch:** "Stop upgrading home RAM" on the dashboard ("Start upgrading home RAM" when off), on unless the owner turns it off (the store's `homeRam.enabled`), like the others.
- **The next upgrade** (`chooseHomeRamUpgrade`), from the connected Agent's medium snapshot (home's `maxRam`, the player's money and city) and slow snapshot (the BitNode and its options):
  - home's RAM doubled, once the player's money covers the price: `ram × 32,000 × 1.58^log2(ram)` in BN1 (`PersonObjects/Player/PlayerObjectServerMethods.ts:30`), $1.01m for 8 GB to 16 GB, about 3.16× more each doubling;
  - **BN1 only, for now:** other BitNodes multiply the price (`HomeComputerRamCost`), so there nothing is bought, and the dashboard says the price isn't known yet. Nothing either until the Agent's slow snapshot says which BitNode (its first round);
  - up to the game's limit, 2^30 GB, or 128 GB with the BitNode option `restrictHomePCUpgrade`;
  - at the tech vendor in the player's city (`TECH_VENDORS`, as for the TOR router). Chongqing and New Tokyo have none, and the dashboard says travel is needed.
- **One purchase at a time, cheapest first:** of the next program and the next upgrade, both affordable, the controller sends the cheaper, and the other's view says it waits for it. Money covers the cheaper one first, so nothing is bought ahead of it. With both switches on, the order is TOR, BruteSSH.exe, 16 GB, FTPCrack.exe, 32 GB, relaySMTP.exe, 64 GB, HTTPWorm.exe, 128 GB, 256 GB, SQLInject.exe, then the rest of the doublings. A switch that's off takes its activity out of the comparison. With home RAM on, no program goes either until the slow snapshot says which BitNode, since until then the upgrade's price isn't known. And the cheaper purchase holds back the other while the page can't make it (a collapsed World section, say), even a program the terminal could buy; the dashboard says what each waits for.
- **The dashboard** shows home's RAM, the upgrade being bought, or what it waits for (money, travel, the cheaper purchase, the BitNode).
- **Sent as an intent** (#141): `upgradeHomeRam { fromRam, vendor }`, with the programs' purchase or instead of it.

## Intents

M3's fourth slice ([#141](https://github.com/UnderMyBed/bitburner-agent/issues/141)): one-shot actions the Agent does at most once, sent in the desired state as `intents` ([protocol](../../docs/bridge/protocol.md#brain--agent), [`packages/ingame`](../ingame/README.md#intents)). Each is an action and its arguments, with an id made from them ("travel(Aevum)"): `buyTor`, `buyProgram`, `upgradeHomeRam`, `travel`, `joinFaction` (#147), `purchaseAugmentation` (#149), `buyServer` (#159), `backdoor` (#162), `installAugmentations` (#164) and `destroyBitNode` (#175) so far. Core validates them (`parseIntentRequest`) and says which are irreversible (`isIrreversibleIntent`).

- **Where they come from,** in this order:
  1. **The owner's manual queue** (`src/manual-intents.ts`), in the order added. It's queued on the dashboard, or with `POST /api/intents`, and kept in the store (`intents.manual`), so it survives restarts of the brain. Any action may be queued, irreversible ones too, with no confirmation (owner decision 36). A queued intent leaves the queue once the connected Agent reports it done, or when it's cancelled. Not when a snapshot shows its result (but for an install or a destroy, below): that can change again (a travel there and back would lose its last leg). Queued twice, it's queued once; one that isn't valid is refused with why; and the queue holds 99 at most, leaving room in the protocol's 100 for the purchase. The dashboard lists the queue even with no Agent connected, so it can be cancelled.
  2. **The purchase rules:** [the hacking programs](#the-hacking-programs) and [home RAM](#home-ram), one purchase at a time, the cheaper first. If the owner queued the same purchase, it goes once, as the owner's.
- **When they go:** with the hack loop, in the one desired state. With the hack loop off, the manual queue goes before any snapshot: each intent checks the game first, so a stale one does nothing. While the brain holds, none go.
- **Irreversible ones** (R8, #147; so far, joining one of the six city factions, which bans its enemies, installing augmentations, #164, and destroying the BitNode, #175) go only past a gate (`src/irreversible-gate.ts`):
  1. the guard holds on two consecutive medium snapshots from the connected Agent, received after it was queued: for a join, none of the faction's enemies joined; for an install or a destroy (core's `resetsTheGame`), nothing queued before it undone (it resets the game, so what was queued before it was for this game; the augmentations queued can't be an install's guard, as no NS call shows them without Singularity); for a destroy, then, w0r1d_d43m0n's preconditions (core's `worldDaemonProblem`): among the medium snapshot's servers (reachable only once The Red Pill is installed), rooted there, and the hacking level at its required level, from the static snapshot (3000 times the BitNode's `WorldDaemonDifficulty`). The game also lets every Black Op done destroy it (`NetscriptFunctions/Singularity.ts:1176-1186`); the guard doesn't count that route, the conservative direction;
  2. then a save backup is asked for ([`backupNow`](#save-backups)), and the intent goes out once that backup succeeds.

  Around that:
  - **One at a time,** in the queue's order: the next one's guard is judged only once the first is done or cancelled, so two that conflict (Sector-12 and Chongqing) never go out together.
  - **The guard fails closed:** a medium snapshot without the factions joined, or without the hacking level, or a static one without w0r1d_d43m0n's required level, holds the intent.
  - **Only the backup asked for counts:** a backup asked for before the count started again releases nothing.
  - **Out, it's still watched:** its guard failing withdraws it, and so does staying out 60 medium snapshots (about 10 minutes) without being done; it goes out again past a new backup, so the backup is never older than that when the game acts.
  - **A failed backup** starts the count again, needing 6 medium snapshots (a minute) before the next.
  - A disconnect, a new Agent or a restarted brain starts every gate again.
  - A held intent doesn't hold up those queued after it, but for an install (#164) or a destroy (#175): what's queued after it waits until it's done, as it was queued for the game after the reset.
  - Each intent's view says why it isn't sent (`waitingFor`), and the dashboard shows it ("not sent: held: Sector-12's enemy Chongqing is joined", "not sent: waiting for installAugmentations() first: queued after an install, it's for the game after the reset", "not sent: held: hacking level 2500: w0r1d_d43m0n needs 3000"). A brain without save backups never sends one.
- **An install's or a destroy's done check** (#164, #175): it kills the Agent, so the one that sent it never reports it done, and a destroy can't be seen done in the game at all (another can follow). When the brain sends it, it notes the connected Agent's reset time (the slow snapshot's `lastAugReset` for an install, `lastNodeReset` for a destroy, which an install doesn't move); a slow snapshot with another one, from the next Agent, takes it off the queue (another, not only a later one: the game takes it from the clock, which can be set back, #167), so it isn't gated and backed up again for the new game. The note is kept in the store (`intents.resetSent`), so a brain restarted meanwhile still drops it on the reset: a destroy gated again in the next BitNode would wait for its requirements, then destroy that one too. Restarted before the reset, the same game's slow snapshot keeps it, and it's gated again. So that the note is always written, an install or a destroy past its gate goes out only once the connected Agent's slow snapshot has said the reset time ("not sent: waiting for the Agent's slow snapshot (the game's last reset), …").
- **How they went:** the Agent reports each intent it holds in the fast snapshot (done, tries, the last problem). The dashboard shows it beside each intent, and an intent tried 5 times without being done raises `intentStuck`: a worker that didn't run counts as a try. The outcome also names the backend the Agent used (`sim`, `singularity` or `ui`, #145), which the dashboard shows ("2 tries via ui: …"): the brain never chooses it.

## Work

M3's eighth slice ([#151](https://github.com/UnderMyBed/bitburner-agent/issues/151), owner decision 37): the brain's second activity for the Agent, the work the player does (`src/work.ts`, `src/desired-state.ts`).
- **What:** faction work, `{ faction, workType }` (hacking, field or security), or company work ([#153](https://github.com/UnderMyBed/bitburner-agent/issues/153)), `{ kind: "company", company, field }` (one of the game's companies, and one of its job fields: "Software", "Waiter", …), or a crime ([#156](https://github.com/UnderMyBed/bitburner-agent/issues/156)), `{ kind: "crime", crime }` (one of the game's 12), or a class ([#158](https://github.com/UnderMyBed/bitburner-agent/issues/158)), `{ kind: "class", location, classType }` (a university and a course, or a gym and a stat: "str", "def", "dex" or "agi"; `packages/core/src/classes.ts`), set on the dashboard (or `POST /api/work`) and kept in the store (`work.desired`), so it survives restarts of the brain. None set: no `work` goes, and the Agent leaves the game's work alone. Choosing work is M4's planner.
- **Focus:** worked out by the brain, not set by the owner: focused for full gains, unless they come unfocused too: the Neuroreceptor Management Implant installed, as the connected Agent's slow snapshot says, or a part-time job (#153: Part-time Waiter, Part-time Employee; `Work/CompanyWork.tsx:36`). A class (#158) always goes unfocused: focus changes nothing for it (`Work/Formulas.ts:108-121`). Before that snapshot, focused, unless it's part-time or a class.
- **When it goes:** in the one desired state, once the connected Agent's slow snapshot has said whether the implant is in (so the focus never flips on a connect), and with the hack loop on, once its static and medium snapshots are in too. While the brain holds, none goes, and the Agent leaves the work as it is.
- **How it went:** the Agent's `work` outcome in the fast snapshot (converged, the problem, the backend), shown on the dashboard. Just after a change it may still be the last work's, until the next fast snapshot.
- **Promotions** ([#155](https://github.com/UnderMyBed/bitburner-agent/issues/155), owner decision 44): the Agent takes any later title of the company work's field the game offers, checking when the work starts and every 10 minutes ([packages/ingame](../ingame/README.md#work)); the brain chooses the company and field, not the title. The outcome's `promotion` (the latest, `{ company, from, to, gameTimeMs }`, read only if well-formed) is shown on the dashboard's Work row ("…: converged via ui; promoted from IT Intern to IT Analyst"), stored as a `workPromotion` event and logged ("the Agent took a promotion at Carmichael Security: IT Intern to IT Analyst"), once: the outcome carries it snapshot after snapshot, so one already stored, after a restart of the brain too, isn't again.

## Safe mode

M3's twelfth slice ([#160](https://github.com/UnderMyBed/bitburner-agent/issues/160), architecture §5.4): with the brain gone, the Agent keeps converging the hack loop and the work on the last desired state, never its intents, until its `ttlMs` passes ([packages/ingame](../ingame/README.md#safe-mode)).
- **The brain's part:** every state it sends carries `ttlMs`, `SAFE_MODE_TTL_MS` (12 hours, `src/desired-state.ts`), counted from when the Agent was last connected to it. Nothing in a state turns harmful with time alone (a reset, which does, drops it at once), and the loops and the work carry on after it anyway: it bounds how long a stopped brain's choices outlive it, and covers a night or a working day with the brain stopped or crashed for good. While the brain holds, the held state carries it too: it starts nothing new.
- **The dashboard:** nothing new. With the brain down there is no dashboard; back, it sends a fresh state, and the dialogs the Agent handled meanwhile arrive in its first fast snapshot.
- **The chaos suite** (`test/safe-mode.test.ts`), in an 8 GB fresh start in the simulator, the brain stopped with `stop()` (`test/helpers/brain-in-simulation.ts`: its connections closed, and every new one closed as it's made):
  - **The brain down for an hour, with a reload in the middle:** the file holds the hack loop and the work (faction work for Sector-12), never the queued join of CyberSec; a loop killed and the work switched by the owner are put back within a convergence, before and after the reload; the join is never tried while the brain is down (checked every 10 minutes of the Agent's log); the reloaded Agent's clock is the same 12 hours from the disconnect; the brain back tries the join again, with the loops and the work as they were.
  - **Past `ttlMs`** (5 minutes, set directly): a loop killed within it is put back; past it, the state is dropped, the file emptied, and a loop killed stays killed.
  - **A reset with no brain** (a new BitNode, `boot.js` standing in for the restart path): the kept state is dropped, never converged on: no loops, no work.
  - **Deployed again while the brain is down** (a new deployment written by hand, after the owner switched the work): the new deployment's Agent carries on from the file, its own loops in place of the old, the work put back.
  - **A brain that accepts the connection and never answers:** while the Agent waits for its welcome, safe mode goes on, and a killed loop is put back.

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
- **A check that fails** (a command that errors or times out after 30 s, or a switch setting it didn't write) is recorded once, when a run of failures starts. Ten failed checks in a row (5 minutes) give up, with the same alert (its text says which cause, with the last failure: #127), so a broken Steam link doesn't fail silently for ever.
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

## The run report

What a run did and what went wrong, from the store alone (#185, owner decision 45): the "analyse" step of build, test, run, analyse, in place of a manual smoke test. What each section says, and what a FAIL means, is in [docs/setup.md](../../docs/setup.md#after-a-run-the-run-report).

```
npm run report -- [--data-dir <dir>] [--since <ISO time>] [--until <ISO time>] [--environment E0]
```

- **The window:** `--since` defaults to the newest `brainStarted` event, `--until` to now. Times need a `Z` or an offset, as for the gap report. The newest `brainStarted` includes the brain runner's own restart after a crash, so a run spanning a restart needs `--since`; section 1 notes a `brainStarted` in the 24 h before the window.
- **What it reads** (nothing new is recorded): the fast, medium, slow and static snapshots and the events in the window (section 5 recomputes the hacking ceiling from them, #196), through `iterateSnapshotsInWindow` and `eventsInWindow`, and the hack loop's switch. The snapshots are folded one row at a time (a day's are hundreds of MB once parsed), and every read is in one read transaction (`readTransaction`). It opens the store read-only, so it's safe while the brain runs.
- **The checks** (`src/run-report.ts`), each a line under FAIL:
  - **gaps** over 6 s in the fast snapshots (`findGaps`, as `npm run gaps`), from the first fast snapshot to the run's last record (its newest fast snapshot or event): the silence before the Agent first reports, and after the run stops, is shown, not counted. A window with no fast snapshot at all fails. Each gap names the restart events recorded in it (`brainStarted`, `relaunch`, `agentDisconnected`, `agentConnected`, deploys, supervision) and an `installAugmentations` or `destroyBitNode` intent the Agent held at the last fast snapshot before it: a restart is still a FAIL, but a self-explaining one.
  - **income stalls:** each stretch of `INCOME_STALLED_AFTER_MS` (10 minutes, `dashboard/alerts.ts`, the same as #184's `incomeStalled` alert) or more, after money first rose, in which the medium snapshots' money didn't rise. A drop (a purchase) isn't a rise. A stretch still going at the last snapshot says so, and one over a heartbeat gap names the gap. While the hack loop's switch (`hackLoop.enabled`, as it is now: the store keeps no history of it) is off, stalls are shown, not counted.
  - **stuck intents:** an intent whose latest outcome in the window is not done after `INTENT_STUCK_AFTER_TRIES` (5) tries or more, as the dashboard's `intentStuck`. Intents are tracked per episode: the same id seen not done after it was done, or with fewer tries, was given again (after a reset, say), and is listed again.
  - **blocking dialogs:** each stretch a `dialogs.blocking` text was shown, in a row, with when it was first and last seen.
  - **disconnects:** an `agentDisconnected` with no `agentConnected` within 60 s. A connect in the same millisecond counts (a replaced session). Not one under 60 s before the window ends (there's no telling yet), nor one that's the run's last record (the run ended there). The line names what was recorded meanwhile, as for gaps.
  - `deployFailed`, `versionDrift` and `supervisionGaveUp` events.
  - **hacking income above the ceiling** (#196), section 5: what hacking earned over the window more than the ceiling allows ([the hacking ceiling](#the-hacking-ceiling)).
- **Values the snapshots don't have**, or have malformed, read as "unknown".
- **The hack loop's target** is inferred, and says so: the game's servers (not home or purchased ones) whose money or security changed between consecutive medium snapshots, in stretches. Only scripts change them, so the owner's own would show too.
- **Exit codes:** 0 on PASS, 1 on FAIL, 2 when it couldn't run (no store, no brain start without `--since`, a window that ends before it starts, or one with nothing recorded).
- **Tests:** `test/run-report.test.ts` builds a store and checks each section, each failure and the command's exit codes and default window; `test/hacking-ceiling-simulation.test.ts` reads section 5 over 90 virtual minutes ([the ceiling suite](#the-ceiling-suite)); `test/run-report-simulation.test.ts` reads a 20-virtual-minute fresh start's store in the simulator (the hack loop on n00dles, TOR, two programs and home RAM bought) and gets PASS.

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

## The install suite

`test/install-restart.test.ts` (#164, architecture §5.7): installing augmentations and the restart after it, the Agent's side, in the simulator. The game starts with an augmentation queued (`diagnostics.queueAugmentation`, a harness edit) and the brain's desired state; the owner queues the install.

| Scenario | What it shows |
|---|---|
| Reconnecting to the reset game (`sim`) | One backup, then the install; `boot.js`, started 500 ms after the reset, starts the next Agent in a new session; its first slow snapshot shows the reset (the augmentation installed, `lastAugReset` later) and the brain takes the install off its queue with no second backup. A travel queued after the install waited for it, and is tried in the reset game (not done: the new start's money). The new session's medium snapshots show n00dles unrooted by the reset, then rooted again by the hack loop. No third session, and the same reset, 30 s on |
| Through Singularity (SF4.3) | The same through `singularity-install-augmentations.js`, which names `boot.js` for after the reset |
| Nothing queued | Through `sim` and `singularity`: done at the first try, with no reset (a slow snapshot after it shows the same `lastAugReset`), no disconnect and no alert |
| The brain down mid-install | As the old Agent dies, the brain goes (`stop()`: every connection refused) for 30 s; the next Agent, alone, drops the desired state kept on home for safe mode (#160), from before the reset, so nothing runs on the reset game's servers; a new brain with the same store has the queue and the note of the install sent (#175), and drops it on the next Agent's first slow snapshot: never sent again, installed once |
| A save-then-reload just after the install | Before `boot.js`'s 500 ms, the game reloads from a save taken then, as Options' "Force kill all active scripts" does: autoexec brings the Agent back, the brain sees the reset and takes the install off its queue, installed once |
| A reload of the last save from before the install | A plain reload loads the last save, from before the install (nothing saves on install). The next Agent's slow snapshot shows the same reset and the augmentation still queued, so the install stays queued: gated again, a new backup, installed. Three sessions, three backups (two installs' and the reloaded game's Remote File API connection's), installed once |

The `ui` backend's restart (the page timer, the terminal, save-and-reload) is E2's (#167, [`packages/e2`](../e2/README.md#what-the-tests-show)).

## The destroy suite

`test/destroy-restart.test.ts` (#175, architecture §5.7): destroying the BitNode and the restart after it, the Agent's side, in the simulator. The game is brought to The Red Pill's requirements by harness steps: The Red Pill queued (`diagnostics.queueAugmentation`) and installed by an owner's script through the simulator's own install, which links w0r1d_d43m0n; hacking exp for its level (`diagnostics.gainHackingExp`); the port openers bought (the simulator's own effectors) and run on it with NUKE.exe. The owner queues `destroyBitNode { nextBitNode: 2 }`.

| Scenario | What it shows |
|---|---|
| BN1 into BN2 (`sim`) | One backup, then the destroy: the terminal's backdoor on w0r1d_d43m0n, the BitVerse, the portal; `boot.js`, started 500 ms after entering BN2, starts the next Agent in a new session; its first slow snapshot shows BN2, SF1.1 and another `lastNodeReset`, and the brain takes the destroy off its queue with no second backup. One `bitnodeDestroyed`. A travel queued after the destroy waited for it, and is tried in BN2 (not done: the new start's money). No third session, and the same reset, 30 s on |
| Through Singularity (SF4.3, a 64 GB home) | The same through `singularity-destroy-bitnode.js`: SF1.1 raised to SF1.2 |
| The guard | Unrooted, or the level short: held, saying why, with no backup and nothing sent |
| The effector's own refusals | Sent past no gate, through `sim` and `singularity`: before The Red Pill, unrooted, the level short, each in the guard's words, nothing typed, still BN1 |
| The brain down mid-destroy | As the old Agent dies, the brain goes for 30 s; a new brain with the same store (the queue, and the note of the destroy sent) drops it on BN2's first slow snapshot: never sent to the next Agent, destroyed once |
| A save-then-reload just after the destroy | In BN2, before `boot.js`'s 500 ms, the game reloads from a save taken then: autoexec brings the Agent back, the brain takes the destroy off its queue, destroyed once |
| Into BN6 | The portal's effect for BitNode 6, its Bladeburner cinematic left as its Continue does: the next Agent starts on the Terminal, in BN6 |
| A save that starts at the BitVerse | The owner's backdoor on w0r1d_d43m0n reaches the BitVerse; the game saved there loads there (no cinematic), and autoexec starts the Agent; the destroy goes out past its gate, and the effector goes straight to the portal: BN2, a third session, destroyed once |

The `ui` backend's destroy (the terminal, the BitVerse page, the restart) is E2's (#177, [`packages/e2`](../e2/README.md#what-the-tests-show)).

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
| `src/record-channel-events.ts` | The control channel's, the deployer's and the save backups' events into the store, the game's dialogs (#143) and promotions (#155) the Agent reports included; and `brainChannel`, the control channel with its numbering seeded from the store (#119) |
| `src/in-game-build.ts` | Reads the in-game build (checked against its manifest) and the pinned definitions |
| `src/gap-report.ts`, `src/gaps-cli.ts` | The gap report and its command (`npm run gaps`) |
| `src/run-report.ts`, `src/report-cli.ts` | The run report and its command (`npm run report`, #185) |
| `src/simulated-game.ts` | The lockstep driver |
| `src/save-backups.ts` | The save backups |
| `src/dashboard/` | The dashboard: `server.ts` (HTTP), `status.ts` (what it shows), `alerts.ts` (the rules), `page.html` (the page) |
| `src/supervision.ts` | The supervision switch, in the store's settings |
| `src/hack-loop.ts` | The hack loop's switch and rules (target and hosts, the move to the next target, #184, and each host's hack threads, #187) |
| `src/hacking-ceiling.ts` | The hacking ceiling over the snapshots, what hacking earned, the dashboard's rows and the run report's section 5 (#196) |
| `src/income-watch.ts` | The money's last rise over the medium snapshots, for `incomeStalled`, and the brain's log lines as a stall starts and ends (#184) |
| `src/programs.ts` | Buying the hacking programs: the switch, the next item, the prices and vendors |
| `src/desired-state.ts` | The controller that sends the hack loop, the intents (purchases, the manual queue) and the work as one desired state |
| `src/work.ts` | The work the owner sets (#151, #153, #156, #158): kept in the store, its focus, and the Agent's outcome read, its promotion (#155) included |
| `src/irreversible-gate.ts` | The gate before an irreversible intent (#147, #164, #175): its guard on medium snapshots, then a save backup |
| `src/manual-intents.ts` | The owner's manual intents queue, and the note of a reset's intent sent (#175), in the store |
| `src/home-ram.ts` | Upgrading home's RAM: the switch, the price, the next upgrade |
| `src/switches.ts` | The dashboard's on/off switches, as settings in the store |
| `src/supervisor.ts`, `src/windows-game-process.ts` | The supervisor, and the game's process on Windows |
| `src/release.ts` | The brain's release, from `git describe` |
| `test/skeleton.test.ts` | The skeleton suite |
| `test/hack-loop-skeleton.test.ts` | The simulator suite for the hack loop and the intents |
| `test/hack-loop-income.test.ts` | The [income suite](#the-income-suite) (#184, #187) |
| `test/hacking-ceiling-simulation.test.ts` | The [ceiling suite](#the-ceiling-suite) (#196) |
| `test/hacking-ceiling-parity.test.ts` | The ceiling's formulas against the game's `ns.formulas.hacking` (#196) |
| `test/income-watch.test.ts` | The money's last rise, and the log lines, through a real control channel (#184) |
| `test/safe-mode.test.ts` | The simulator chaos suite for safe mode (#160): the brain down for an hour with a reload, expiry, a reset, a new deployment |
| `test/effector-backends.test.ts` | The simulator suite for the Effectors' `sim` and `singularity` backends (#145), and for the `ui` worker that needs no page (#159): each action with money and without, and in BN1 with SF4.3. Faction work (#151) in Sector-12: with `sim`, started focused, unfocused, switched, and left alone with none wanted; with `singularity`, started focused, unfocused and switched; and, with `sim`, not converged where a joined faction (CyberSec) doesn't offer it. Company work (#153), a Waiter at Noodle Bar: with `sim`, after a travel to New Tokyo, focused then unfocused, and worked again from Sector-12 as the job is held; not converged from Sector-12 (not in its city), where the player doesn't qualify (Software at MegaCorp), or where the company offers only later jobs (Business at DeltaOne); with `singularity`, from Sector-12 (Singularity doesn't ask the city), started unfocused, then focused, and not qualified likewise. Promotions (#155), an IT Intern at Carmichael Security (`diagnostics.employWithReputation`, hacking 168): with `sim`, from Aevum, the start's check takes nothing without the reputation; given 7,000, nothing 8 minutes on, then the check 10 minutes after the first makes them IT Analyst, the work focused and not restarted (its cycles carry on), the outcome naming the promotion; with `singularity`, nothing at the start, then, qualified, a change of focus checks at once and `applyToCompany` promotes. A Systems Administrator there qualified for Head of Engineering (`gainCharismaExp`, 800,000 reputation) keeps the title through both, the work converged: a promotion stays in the field. Crime (#156): with `sim`, shoplifting focused, unfocused, then mugging, still the work 20 s on (a crime repeats); with `singularity`, unfocused, focused, then a switch to homicide. Classes (#158): with `sim`, Computer Science at Rothman University unfocused, then focused without starting it again, a gym in Aevum and Data Structures with $1,000 held back with their reasons, then Data Structures with the money, kept once the money is gone, then Iron Gym's strength training and Powerhouse Gym's, told apart by the location, as the page can't; with `singularity`, the same course, then Iron Gym's, then Powerhouse Gym's, held back under its $1.44m guard and then started, its focus still set with the money gone, and a gym in another city held back. Each focus change is shown not to start the class again (its game cycles keep counting), and the guard's problems are core's own words (`classStartProblem`). Buying augmentations (#149) from CyberSec, set up with reputation: through each backend, NeuroFlux a level at a time, nothing paid twice, and a level out of turn or no money not done. Joining Sector-12 (#147) through each, past the gate: sent only after two medium snapshots and a save backup; then, with `sim`, Chongqing held by the guard, and CyberSec (no enemies) sent at once but not done without an invitation. Buying a cloud server (#159), with `sim` and with its NS worker (`buy-server.js`, the `ui` backend, the simulator's effectors taken away), on a fresh save's 8 GB home: `pserv-0` bought once and, sent again at 8 or 64 GB, done with nothing paid; `n00dles` refused with no money spent; not enough money refused, and neither bought in the next medium snapshot. At the limit of 25 (the owner's servers, bought before the Agent starts), refused by `sim` and by the worker, which with SF4.3 is still the same worker, reported `ui`. Backdoors (#162), on nectar-net (the owner's NUKE.exe, `gainHackingExp(500)`): with `sim`, the first try says "installing … s left" and a program purchase queued with it "terminal busy"; it's not installed 15 s on, then all are done and the terminal is home; sent again, done at its first try with nothing typed. The refusals (no root, the level, home, a cloud server, no server), each with its reason and nothing typed. With `singularity` (SF4.3), installed through its worker, the terminal left home, and the same refusals; and on a 16 GB home, while its worker holds 8 GB, crime work uses the page rather than a Singularity worker that couldn't start, then Singularity once the backdoor is in |
| `test/install-restart.test.ts` | The [install suite](#the-install-suite) (#164) |
| `test/destroy-restart.test.ts` | The [destroy suite](#the-destroy-suite) (#175) |
| `test/helpers/fresh-start.ts` | A game in the simulator with the brain and the built Agent in it, and the owner's setup before the Agent starts: the start of the suites above. `reload()` reloads it, from a save taken then or one given (#164) |
| `test/helpers/brain-in-simulation.ts` | The brain wired like `main.ts`, on the lockstep driver; the desired-state controller only when a test asks (`withDesiredState`), so the M2 suites see the observe-only skeleton they test; `stop()`, the brain gone (#160) |
