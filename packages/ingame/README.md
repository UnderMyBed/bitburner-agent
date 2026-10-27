# @bitburner-agent/ingame

The code that runs inside the game: `boot.js`, the Agent and its workers (architecture §5). Each script is a self-contained bundle held to a RAM budget, measured with the game's own calculator in CI.

> **Status:** built in M2 ([v0.2.0](https://github.com/UnderMyBed/bitburner-agent/releases/tag/v0.2.0)): `boot.js` ([#85](https://github.com/UnderMyBed/bitburner-agent/issues/85)), the Agent's connection and lifecycle ([#88](https://github.com/UnderMyBed/bitburner-agent/issues/88)), and its snapshots ([#89](https://github.com/UnderMyBed/bitburner-agent/issues/89)). M3 adds the Agent's first actions: [the hack loop](#the-hack-loop) ([#134](https://github.com/UnderMyBed/bitburner-agent/issues/134)), [buying the hacking programs](#the-hacking-programs) ([#136](https://github.com/UnderMyBed/bitburner-agent/issues/136)), and [upgrading home's RAM](#home-ram) ([#138](https://github.com/UnderMyBed/bitburner-agent/issues/138)).

## Layout

| Path | What |
|---|---|
| `src/entries/<name>.ts` | One in-game script each, built to `dist/<name>.js`: `boot.js`, `agent.js`, `snapshot-<tier>.js`, the hack loop's `hack-loop.js`, `hack-loop-root.js` and `hack-loop-deploy.js`, `buy-program.js` and `upgrade-home-ram.js` |
| `src/agent/` | The Agent's modules: `snapshotter.ts`, `hack-loop.ts`, `page-buyer.ts` (the programs' and home RAM's buyers), and what they share: `run-worker.ts`, the runner for their home workers, and `activity.ts`, the round schedule and the log of changes |
| `src/page/` | The game's page, for the `ui` effector: `game-page.ts` |
| `src/workers/` | What the home workers share: the network scan, the report to the Agent |
| `src/ns.ts` | The `NS` type, from `@nsdefs`, for entries to import |
| `src/` | In-game code, typechecked as the game's page sees it: the DOM, no Node, and the NS API from the pinned game's definitions as `@nsdefs` (`src/tsconfig.json`) |
| `scripts/` | The build (Node): `bundles.ts`, and `build.ts`, its command |
| `test/` | Tests (Node), which test the built bundles in the simulator; `test/agent/` unit-tests the Agent's modules, typechecked as in-game code (its own `tsconfig.json`) |
| `ram-budget.json` | Each bundle's RAM budget, in GB |

In-game code imports `@bitburner-agent/core` (for the deploy layout, the control protocol, and the snapshot types and port) and its own modules. The bundle includes them; nothing is imported at runtime.

## Build

```
npm run build -w @bitburner-agent/ingame
```

It writes `dist/<name>.js` for each entry, and `dist/manifest.json`:

```json
{ "buildId": "<12 hex digits>", "files": { "boot.js": { "sha256": "…", "bytes": … } } }
```

- **Self-contained:** each bundle includes what it imports. The build fails if an output would import anything at runtime. So the game's stale RAM cache for importers (game issue #2907) can't arise.
- **Not minified:** see [RAM](#ram).
- **`buildId`** is a short hash of the outputs: the same sources give the same id, on any machine, since comments in the output name sources relative to the repository (a test checks it).
- **What a bundle includes from imported modules:** what it uses, plus any top-level declaration esbuild can't prove unused, such as a computed constant. Its names are charged like the rest, so shared modules keep top-level constants plain literals (`core`'s deploy layout does).

## RAM

The game charges a script's RAM **by identifier name** (game source: `vendor/bitburner-src/src/Script/RamCalculations.ts`):
- the base cost of 1.6 GB;
- plus every NS function's cost whose name appears anywhere in the script's code: `ns.scan`, but also a property or local variable spelled the same way.

So two rules for in-game code:
- **Never name anything like an NS function.** A local `ps` costs 0.2 GB, `connect` 32 GB (Singularity), `attempt` 10 GB. Tests have tripped on all three. Use verbose names, as the coding standards say anyway.
- **Bundles aren't minified,** because a minifier's short names could become `ps` or `rm`. Size doesn't matter in game.

**Budgets:** `ram-budget.json` gives each bundle a budget in GB. `test/ram-budget.test.ts` builds the bundles, writes them into a simulation, and measures each with the game's own calculator (`sim.staticRamUsage`, the call `run` makes). CI fails when:
- a bundle is over its budget;
- a bundle has no budget, or a budget has no bundle.

The test prints each bundle's RAM against its budget. What each script calls that costs RAM:

| Script | Calls | RAM (budget) |
|---|---|---|
| `boot.js` | `isRunning` (0.1 GB), `run` (1.0 GB); `read`, `print`, `tprint` and the log switches cost nothing | 2.7 GB (2.7) |
| `agent.js` | `run` (1.0 GB), `isRunning` (0.1 GB); `read`, `sleep`, `asleep`, `atExit`, `getPortHandle`, `getScriptName`, `ui.getGameInfo`, `print`, `tprint` and the log switches cost nothing | 2.7 GB (3.0) |
| `snapshot-static.js` | `scan` (0.2 GB), `getServer` (2.0 GB) | 3.8 GB (3.8) |
| `snapshot-slow.js` | `getResetInfo` (1.0 GB), `cloud.getServerNames` (1.05 GB) | 3.65 GB (3.65) |
| `snapshot-medium.js` | `getPlayer` (0.5 GB), `scan` (0.2 GB), `getServer` (2.0 GB), `fileExists` (0.1 GB), `hasTorRouter` (0.05 GB) | 4.45 GB (4.45) |
| `snapshot-fast.js` | `ps` (0.2 GB), `getServerMoneyAvailable` (0.1 GB; on home it gives the player's money, where `getPlayer` costs 0.5), `getServerUsedRam`, `getServerMaxRam` (0.05 GB each) | 2.0 GB (2.0) |
| `hack-loop-root.js` | `scan` (0.2 GB), `fileExists`, `getServerNumPortsRequired` (0.1 GB each), `hasRootAccess`, `nuke` and the five port openers (0.05 GB each) | 2.35 GB (2.35) |
| `hack-loop-deploy.js` | `exec` (1.3 GB), `scp` (0.6 GB), `kill` (0.5 GB), `scan`, `ps` (0.2 GB each), `getScriptRam` (0.1 GB), `hasRootAccess`, `getServerMaxRam`, `getServerUsedRam` (0.05 GB each) | 4.65 GB (4.65) |
| `buy-program.js` | `fileExists` (0.1 GB), `hasTorRouter` (0.05 GB); the page costs nothing | 1.75 GB (1.75) |
| `upgrade-home-ram.js` | `getServerMaxRam` (0.05 GB); the page costs nothing | 1.65 GB (1.65) |
| `hack-loop.js` | `grow`, `weaken` (0.15 GB each), `hack`, `getServerMinSecurityLevel`, `getServerMaxMoney`, `getServerSecurityLevel`, `getServerMoneyAvailable` (0.1 GB each). It runs on the other servers, never home | 2.4 GB (2.4) |

The workers write to a port (`writePort`, free). The Agent plus its largest home worker (`hack-loop-deploy.js`, 4.65 GB) is 7.35 GB, within a fresh save's 8 GB home; a test checks the budgets (7.65 GB) keep it so, over every home worker. The brain's [skeleton suite](../brain/README.md#the-skeleton-suite) and [hack loop suite](../brain/README.md#the-hack-loop) check home's RAM while the Agent actually runs, in a simulated 8 GB fresh start, and the E2 skeleton measures each script with the game's `mem` in a real one ([`packages/e2`](../e2/README.md#the-skeleton-on-e2)).

## Deploy layout

Where the in-game code lives on home (`@bitburner-agent/core`, `deploy-layout.ts`):

| Path | What |
|---|---|
| `agent/boot.js` | The one fixed-path script; autoexec runs it on every load of a save |
| `agent/current.txt` | The id of the deployment in use |
| `agent/<deploymentId>/<name>.js` | A deployment's scripts: `agent.js`, its `snapshot-<tier>.js` workers, the hack loop's scripts, `buy-program.js`, `upgrade-home-ram.js`, and a copy of `boot.js`, whose RAM the deployer checks there before it changes `agent/boot.js`. `hack-loop.js` is also copied, at the same path, to each server that runs it |
| `agent/<deploymentId>/config.json` | Its configuration for the Agent: `{ "deploymentId": …, "controlPort": … }` (`AgentConfig`, read with `parseAgentConfig`) |
| `agent/<deploymentId>/token.txt` | The control channel's token |

A deployment is a build plus its configuration, so a new token or port is a new deployment too. Its id is a folder name: letters, digits, `-` and `_` (`isValidDeploymentId`). Each one gets its own folder, so a deploy never overwrites a file a running script uses. The deployer ([#91](https://github.com/UnderMyBed/bitburner-agent/issues/91)) writes `current.txt` last.

## `boot.js`

It starts the deployed Agent if it isn't running, and does nothing else (architecture §5.7):
1. reads `agent/current.txt`;
2. given an Agent's pid (an Agent handing over passes its own), waits until that Agent has exited;
3. if `agent/<deploymentId>/agent.js` isn't running on home, runs it as a **temporary** script.

Why it waits: the game starts `boot.js` while the Agent that ran it is still running. Until that Agent exits, its 2.7 GB isn't free, and old Agent, `boot.js` and new Agent together need 8.1 GB, more than an 8 GB home has, so the new one couldn't start. And if the deployed Agent is the one handing over, `boot.js` would see it still running and start nothing.

It's safe to run any number of times. When nothing is deployed, `current.txt` doesn't hold a deployment id, or the Agent can't start, it says so in the terminal and in its log; for a failed start, the game's own reason (a missing file, too little RAM, a script it can't parse) is in the log too.

**It never stops an Agent.** An Agent from an earlier deployment keeps running until it restarts itself: the deployer tells it to, or, while disconnected, it finds `current.txt` names another deployment. Then it runs `boot.js` and exits ([the Agent](#the-agent), [#88](https://github.com/UnderMyBed/bitburner-agent/issues/88), [#91](https://github.com/UnderMyBed/bitburner-agent/issues/91)).

**Why temporary:** the game saves every running non-temporary script and restarts it on load (game source: `src/NetscriptWorker.ts:241-261`). A temporary Agent isn't saved. So after a load, autoexec (`boot.js`) is the one way back, and a load never starts an old Agent and its workers at once, which wouldn't fit in 8 GB.

## The Agent

`agent/<deploymentId>/agent.js` runs all the time, holds the control channel to the brain ([protocol](../../docs/bridge/protocol.md), architecture §5.1), and sends [snapshots](#snapshots).

**Lifecycle:**
1. **Start:** it finds its folder from its own path (`deploymentIdOfPath`), then reads `config.json` and `token.txt` there. `config.json`'s `deploymentId` must name that folder. If a file is missing, empty or invalid, it says which in the terminal and in its log, and exits. It makes a new `agentSessionId`, kept across its reconnects.
2. **Connect:** to `ws://127.0.0.1:<controlPort>`. When the socket opens, it sends `hello` with the game's version (`ns.ui.getGameInfo()`).
3. **`welcome`:** it stays connected, and its backoff goes back to 1 s. From then on it takes a round of snapshots every 2 s, the first one at once, then converges [the hack loop](#the-hack-loop) when that's due, then buys [the next hacking program](#the-hacking-programs) when that's due, and sleeps (`ns.sleep`) in between. It acts on what arrived (a `restart`, a `desiredState`, a close) at the start of each round, after the sleep. A round never runs past 2 s, so that's within 2 s.
4. **`desiredState`:** it keeps the latest until it disconnects: the hack loop converges on it, and the program buyer buys what it names.
5. **`restart`:** it runs `agent/boot.js` with its own pid and exits; `boot.js` waits for it to go, then starts the deployed Agent. Its socket closes as it exits.
6. **Disconnected:**
   - closed with 4000 (a newer Agent replaced it): it exits for good;
   - otherwise, if `agent/current.txt` holds a valid id of another deployment, it runs `boot.js` and exits. An empty or invalid `current.txt` doesn't count: `boot.js` would refuse it, leaving no Agent;
   - otherwise it waits and reconnects: 1 s, doubling to 30 s.

   **If `boot.js` can't start** (home is too full), the Agent carries on instead of exiting, so one is always running: it stays connected after a `restart`, or reconnects. It tries again at its next disconnect. The game's reason is in the Agent's log.
7. **Exiting or killed:** an `atExit` callback closes the socket, since a socket outlives its script. The game runs it on every exit (`src/NetscriptWorker.ts:147-148`, `src/Netscript/killWorkerScript.ts:72-83`). The brain sees `agentDisconnected` at once.

Frames it can't parse, or of a type it doesn't know, are ignored.

**The event-queue rule: socket handlers never call `ns`.** While a script awaits a call the game delays (`ns.sleep`, `hack`, `grow`, `weaken`, `share`), the game kills it for any `ns` call made from another callback, such as a socket handler (game source: `src/Netscript/NetscriptHelpers.tsx:405-431`). `ns.asleep` doesn't set that guard (`src/NetscriptFunctions.ts:259-265`). So the handlers only put events on an in-memory queue, and the main loop takes them off and acts. Before a welcome, the main loop waits on that queue with a plain promise; after it, it sleeps between snapshot rounds, while frames keep arriving.

The tests show both sides: frames arriving while the Agent sleeps don't kill it (and a handler that calls `ns` makes that test fail), and a script that breaks the rule is killed.

## Snapshots

Each round (every 2 s while welcomed) the Agent runs the tiers that are due, one worker at a time, in this order (architecture §5.2; each tier's data: [protocol](../../docs/bridge/protocol.md#each-tiers-data)):
1. **fast**, every round, sent whatever happened: it's the heartbeat;
2. **medium** every 5th round (10 s) and **slow** every 30th (60 s), both in the first round after each welcome. Cadence counts rounds, not clock time, so a clock that steps doesn't skew it;
3. **static**, until it has it once. It keeps it for its life and resends it after each welcome, with the time it was read. Its server list is as of the Agent's start; servers that appear later (purchased ones, darkweb) are in medium, which also carries each server's RAM and cores, since those change.

**Workers** (`agent/<deploymentId>/snapshot-<tier>.js`) are short-lived and hold the costly NS calls, so the Agent stays at 2.7 GB:
- The Agent runs each as a **temporary** script (`ns.run(file, { temporary: true })`), with no arguments, so a save never holds one.
- The worker reads the game and writes `{ workerPid, gameTimeMs, data }` to port 89001 (`WORKER_REPORT_PORT`), then exits.
- The Agent takes the report carrying that worker's pid, skipping anything else on the port (such as a report that came too late), and waits for the worker to exit, so its RAM is free for the next one. It checks `ns.isRunning` every 20 ms, so a worker that exits without a report costs no more than that.
- **Every wait ends with the round**, 2 s after it started. So a round never runs past 2 s, and the heartbeat is never more than two rounds (4 s) apart, under the gap threshold (6 s), whatever the workers do.
- While it waits it uses `ns.asleep`, not `ns.sleep`: a `sleep` that lost the race would leave the script marked busy, and its next `ns` call would get it killed. And it calls `ns.isRunning` before reading the port, so an Agent that has been killed ends there, before it can read a report meant for the next Agent.
- **Never a second copy:** while a tier's last worker is still running, the tier isn't started again. The Agent doesn't kill a worker that hangs (that would need `kill`, 0.5 GB, over its budget). Only a bug could make one hang: each keeps its RAM until it exits, which can starve the larger workers meanwhile.

**Degraded:** a worker that can't start (home is full), exits without a report, doesn't report before the round ends, or is still running from before leaves its tier skipped that time. A tier with no time left in the round is skipped too. A skipped tier is named in the fast snapshot's `degradedTiers` until it next succeeds, and stays due, so it's tried again next round. When the fast worker itself is skipped, the fast snapshot is still sent, with `game: null`. So on a full home the brain sees a live but blind Agent, never a dead one. The Agent logs a tier being skipped or coming back, not every round.

While the new-game tutorial runs, finished scripts never free their RAM (architecture §5.7), so the workers soon can't start and every tier degrades. The tutorial is ended before the Agent starts.

## The hack loop

The Agent's first action, M3's first slice ([#134](https://github.com/UnderMyBed/bitburner-agent/issues/134), owner decision 34). The brain decides; the Agent carries it out (`src/agent/hack-loop.ts`). It's the thinnest version of the reconciler (architecture §5.3), and its first activity:
- **What the brain sends:** `desiredState { hackLoop: { enabled, target, hosts } }` ([protocol](../../docs/bridge/protocol.md#brain--agent)).
  - It's on unless the owner turns it off on the dashboard.
  - `target` and `hosts` come from the brain's starter rules ([packages/brain](../brain/README.md#the-hack-loop)). The hosts are the game's rooted servers, never home and never the player's own purchased or Hacknet servers.
- **Only from the brain it's connected to.** The Agent keeps the desired state until it disconnects, then forgets it: the next brain sends its own. Without one (after a start, or with a brain that holds), it does nothing, and loops already running keep running.
- **When it acts:**
  - On a change, at once.
  - While on, every 15 rounds (30 s) after that, so servers that become rootable and loops the game lost are picked up.
  - Off, it stops every loop once, then does nothing until the state changes.
- **How:** after the round's snapshots, within the round's time, it runs two home workers, one after the other. They share the snapshot workers' runner ([`run-worker.ts`](src/agent/run-worker.ts)), so home never holds two at once, nor two copies of one. A worker that can't start, or doesn't report, is tried again next round; a retry doesn't root again. The Agent logs why.
  1. **`hack-loop-root.js`** (only when on): for every server but home that it doesn't have root on, it opens the ports it can with the programs on home, then runs NUKE if that's enough. Rooting is what any player does first.
  2. **`hack-loop-deploy.js`**, with whether the loop should run, its target and the hosts. On every rooted server but home, it stops **only our loops**, any deployment's `agent/<id>/hack-loop.js` in a folder the deployer generated (12 hex digits, never a player's own `agent/<name>/`), that shouldn't run there:
     - another deployment's;
     - another target's;
     - on a server that isn't a host;
     - or every one, when off.

     On each host where the loop isn't running, it copies this deployment's `hack-loop.js` there and runs it with the threads the free RAM allows. It never touches any other script. It reports a problem (no deployment folder, no loop script on home) rather than failing silently.
- **The loop itself**, `hack-loop.js` with the target as its argument: weaken while security is more than 5 over the minimum, grow while money is under 75% of the maximum, hack otherwise.
- **RAM:** the loop uses only RAM left free when it starts, then holds it, so a script the owner starts there later may not fit; stop the loop first. Home is left alone: a fresh save's no-port servers have about 100 GB between them, while home has about 1 GB beside the Agent (architecture Q1).
- **Saved scripts:** the loops aren't temporary, so a reload brings them back by itself, and they keep running while the brain is down.

The Agent logs what it does when that changes: the servers it rooted, and the loop's threads, servers and target. The brain's [hack loop suite](../brain/README.md#the-hack-loop) tests it in an 8 GB fresh start, and E2 checks n00dles runs it in the real game.

## The hacking programs

M3's second slice ([#136](https://github.com/UnderMyBed/bitburner-agent/issues/136)): the Agent buys the TOR router and the five port openers, so the [hack loop](#the-hack-loop) can root more servers. It's the first **`ui` effector** (architecture §5.6): BN1.1 has no Singularity API, so it buys through the game's own page (`src/agent/page-buyer.ts`, `src/page/game-page.ts`, `src/entries/buy-program.ts`).
- **What the brain sends:** `desiredState { programs: { enabled, next } }`, `next` being `{ item, vendor }` or null ([protocol](../../docs/bridge/protocol.md#brain--agent); [packages/brain](../brain/README.md#the-hacking-programs) picks it). The Agent keeps it until it disconnects, like the hack loop.
- **When:** a new `next` is bought in the next round, after the snapshots and the hack loop, in what's left of the round; with under 1 s left, in the round after. Bought, it waits for the brain's next item, which the next medium snapshot shows owned. Not bought, it logs why, every try, and tries again every 15 rounds (30 s).
- **`buy-program.js`**, with the item, the vendor and a deadline, so it ends within the Agent's round like any other worker:
  1. **The game first:** the TOR router owned (`hasTorRouter`) or the program on home (`fileExists`) is done, without touching the page.
  2. **Never over an open dialog:** that's the owner's to read and close, so it does nothing and tries again later.
  3. **The TOR router:** the sidebar's City, the vendor (`span[aria-label]` on the ASCII map, or a button with ASCII art off; the page's `openCityLocation`), "Purchase TOR router" while it can be bought (not disabled), then the purchase's dialog closed with its own close button (never Escape, which closes every dialog). No dialog is left open (E2 checks).
  4. **A program:** the sidebar's Terminal, and `buy <program>` typed into it, unless the owner has a line typed there: that's left alone.
  5. **Back to the Terminal,** however it went, once it has moved the page.

  It reports `{ item, done, problem }`. A problem is a page that isn't as expected: no page, a dialog open, a sidebar section collapsed (its items unmount), a button missing (each named: "no TOR router to buy (is the money there?)"), or a line typed in the terminal. A problem on the way back to the Terminal is reported even when the item was bought.
- **The page** (`src/page/game-page.ts`): reached with `eval("document")`, never the identifiers `document` or `window`, which cost 25 GB each. A click calls the element's React `onClick` with `{ isTrusted: true }`, and the terminal takes React's own `onChange` and `onKeyDown`, as the legacy fork does. The Enter handler is read after the line is typed: the one from before would run the empty line. Every wait ends by the worker's deadline, and looks at least once. The steps end 300 ms before it, so the way back to the Terminal has its own time however long a step waited (`test/agent/game-page.test.ts`).
- **What the owner sees:** a few times a session, the page switches to the City and back to the Terminal, or a `buy` is typed into the terminal. The dashboard's "Stop buying programs" switch stops it.

E2 buys all six on the real page, each at its first try, and checks that a collapsed World section, or an open dialog, stops it until it's open again, or closed ([`packages/e2`](../e2/README.md)). `test/agent/page-buyer.test.ts` checks when the Agent runs the worker and what it logs; `test/agent/game-page.test.ts` drives a stand-in page in jsdom.

## Home RAM

M3's third slice ([#138](https://github.com/UnderMyBed/bitburner-agent/issues/138)): the Agent doubles home's RAM at a tech vendor, the second `ui` effector, through the same page code as the TOR router (`src/agent/page-buyer.ts`, `src/entries/upgrade-home-ram.ts`).
- **What the brain sends:** `desiredState { homeRam: { enabled, next } }`, `next` being `{ fromRam, vendor }` or null ([packages/brain](../brain/README.md#home-ram) picks it, one purchase at a time with the programs, cheapest first). The Agent keeps it until it disconnects.
- **When:** as for the programs, with its own buyer: a new `next` in the next round with 1 s of it left, after the program buyer; not bought, again every 30 s, logging why each time.
- **`upgrade-home-ram.js`**, with home's RAM when the brain asked (`fromRam`), the vendor and a deadline:
  1. **The game first:** home with more RAM than `fromRam` (`getServerMaxRam`) is done, without touching the page. So a repeat never buys a second doubling.
  2. **Never over an open dialog.**
  3. The sidebar's City, the vendor, and "Upgrade 'home' RAM" while it can be bought (it's disabled when the player can't afford it, or home is at its limit). A purchase opens no dialog.
  4. **Back to the Terminal,** however it went.

  It reports `{ item: "home RAM", done, problem }`, as `buy-program.js` does ("no home RAM upgrade to buy (is the money there?)").
- **What the owner sees:** once per upgrade, the page switches to the City and back to the Terminal. The dashboard's "Stop upgrading home RAM" switch stops it.

E2 upgrades home from 8 GB to 16 GB on the real page and checks it goes no further, with no dialog left open. `test/agent/page-buyer.test.ts` checks the upgrader's worker, its arguments and its log, and that both buyers share a round.

## Hygiene and tests

**Hygiene:** no state at module level, since the game may or may not reuse a module (architecture R10); time from `Date.now()` and randomness from `Math.random()` only, both virtual in the simulator (R11).

**Tests:** `packages/brain/test/agent.test.ts` (the connection and lifecycle) and `snapshots.test.ts` (the tiers, a full home, workers that crash, hang or report late, a reload) run the built Agent and its workers in the simulator against the brain's real `ControlChannel`, on the lockstep driver, in virtual time. They live in `brain` because they need both sides, and `ingame` doesn't depend on the brain. `ingame` exports its build (`@bitburner-agent/ingame/build`) for them.
