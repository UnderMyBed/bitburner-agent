# @bitburner-agent/ingame

The code that runs inside the game: `boot.js`, the Agent and its workers (architecture §5). Each script is a self-contained bundle held to a RAM budget, measured with the game's own calculator in CI.

> **Status:** built in M2 ([v0.2.0](https://github.com/UnderMyBed/bitburner-agent/releases/tag/v0.2.0)): `boot.js` ([#85](https://github.com/UnderMyBed/bitburner-agent/issues/85)), the Agent's connection and lifecycle ([#88](https://github.com/UnderMyBed/bitburner-agent/issues/88)), and its snapshots ([#89](https://github.com/UnderMyBed/bitburner-agent/issues/89)). M3 adds the Agent's first actions: [the hack loop](#the-hack-loop) ([#134](https://github.com/UnderMyBed/bitburner-agent/issues/134)), [buying the hacking programs](#the-hacking-programs) ([#136](https://github.com/UnderMyBed/bitburner-agent/issues/136)), [upgrading home's RAM](#home-ram) ([#138](https://github.com/UnderMyBed/bitburner-agent/issues/138)), [intents](#intents) with [travel](#travel) ([#141](https://github.com/UnderMyBed/bitburner-agent/issues/141)), the game's [dialogs](#dialogs) ([#143](https://github.com/UnderMyBed/bitburner-agent/issues/143)), the Singularity and simulator backends ([#145](https://github.com/UnderMyBed/bitburner-agent/issues/145)), [joining a faction](#joining-a-faction) ([#147](https://github.com/UnderMyBed/bitburner-agent/issues/147)), [buying augmentations](#buying-augmentations) ([#149](https://github.com/UnderMyBed/bitburner-agent/issues/149)), and [work](#work): faction work ([#151](https://github.com/UnderMyBed/bitburner-agent/issues/151)) company work ([#153](https://github.com/UnderMyBed/bitburner-agent/issues/153)), crime ([#156](https://github.com/UnderMyBed/bitburner-agent/issues/156)) and classes ([#158](https://github.com/UnderMyBed/bitburner-agent/issues/158)).

## Layout

| Path | What |
|---|---|
| `src/entries/<name>.ts` | One in-game script each, built to `dist/<name>.js`: `boot.js`, `agent.js`, `snapshot-<tier>.js`, the hack loop's `hack-loop.js`, `hack-loop-root.js` and `hack-loop-deploy.js`, `buy-program.js`, `upgrade-home-ram.js`, `travel.js`, `join-faction.js`, `buy-augmentation.js`, `faction-work.js`, `company-work.js`, `crime-work.js`, `class-work.js` and `buy-server.js`, and the Singularity workers `singularity-*.js` (#145) |
| `src/agent/` | The Agent's modules: `snapshotter.ts`, `hack-loop.ts`, `intent-runner.ts` and `effectors.ts` (the intents, #141), `dialog-watcher.ts` (#143), `work.ts` (#151, #153, #156, #158), `safe-mode.ts` (#160), and what they share: `effector-runner.ts`, which picks each try's backend and runs its effector, `run-worker.ts`, the runner for their home workers, and `activity.ts`, the round schedule and the log of changes |
| `src/page/` | The game's page, for the `ui` effectors and the dialog watcher: `game-page.ts`, `work-page.ts` (the work workers' reading and steps, #151, #153, #156, #158), and `page-effect.ts`, what every `ui` worker does around its own steps (the game first, never over a dialog left for the owner, the player's focus on work kept, back to the Terminal) |
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
| `agent.js` | `run` (1.0 GB), `isRunning`, `getScriptRam` (0.1 GB each), `getServerMaxRam` (0.05 GB, with `getScriptRam`, for whether a Singularity worker fits home beside the Agent); `read`, `write`, `sleep`, `asleep`, `atExit`, `getPortHandle`, `getScriptName`, `ui.getGameInfo`, `print`, `tprint` and the log switches cost nothing | 2.85 GB (3.0) |
| `snapshot-static.js` | `scan` (0.2 GB), `getServer` (2.0 GB) | 3.8 GB (3.8) |
| `snapshot-slow.js` | `getResetInfo` (1.0 GB), `cloud.getServerNames` (1.05 GB) | 3.65 GB (3.65) |
| `snapshot-medium.js` | `getPlayer` (0.5 GB), `scan` (0.2 GB), `getServer` (2.0 GB), `fileExists` (0.1 GB), `hasTorRouter` (0.05 GB) | 4.45 GB (4.45) |
| `snapshot-fast.js` | `ps` (0.2 GB), `getServerMoneyAvailable` (0.1 GB; on home it gives the player's money, where `getPlayer` costs 0.5), `getServerUsedRam`, `getServerMaxRam` (0.05 GB each) | 2.0 GB (2.0) |
| `hack-loop-root.js` | `scan` (0.2 GB), `fileExists`, `getServerNumPortsRequired` (0.1 GB each), `hasRootAccess`, `nuke` and the five port openers (0.05 GB each) | 2.35 GB (2.35) |
| `hack-loop-deploy.js` | `exec` (1.3 GB), `scp` (0.6 GB), `kill` (0.5 GB), `scan`, `ps` (0.2 GB each), `getScriptRam` (0.1 GB), `hasRootAccess`, `getServerMaxRam`, `getServerUsedRam` (0.05 GB each) | 4.65 GB (4.65) |
| `buy-program.js` | `fileExists` (0.1 GB), `hasTorRouter` (0.05 GB); the page costs nothing | 1.75 GB (1.75) |
| `upgrade-home-ram.js` | `getServerMaxRam` (0.05 GB); the page costs nothing | 1.65 GB (1.65) |
| `travel.js` | `getPlayer` (0.5 GB); the page costs nothing | 2.1 GB (2.1) |
| `join-faction.js` | `getPlayer` (0.5 GB); the page costs nothing | 2.1 GB (2.1) |
| `buy-augmentation.js` | `getResetInfo` (1.0 GB); the page costs nothing | 2.6 GB (2.6) |
| `faction-work.js` | nothing beyond the base; the page costs nothing | 1.6 GB (1.6) |
| `company-work.js` | `getPlayer` (0.5 GB), for the jobs held; the page costs nothing | 2.1 GB (2.1) |
| `buy-server.js` | `cloud.purchaseServer` (2.25 GB), `cloud.getServerCost` (0.25 GB), `serverExists`, `getServerMoneyAvailable`, `cloud.getServerUpgradeCost` (0.1 GB each), `getServerMaxRam`, `cloud.getServerLimit` (0.05 GB each); no page | 4.5 GB (4.5) |
| `crime-work.js` | nothing beyond the base; the page costs nothing | 1.6 GB (1.6) |
| `class-work.js` | `getPlayer` (0.5 GB), for the money and the city; the page costs nothing | 2.1 GB (2.1) |
| `singularity-travel.js` | `getPlayer` (0.5 GB), `singularity.travelToCity` (2 GB at SF4.3 or in BN4) | 4.1 GB (4.1) |
| `singularity-buy-tor.js` | `hasTorRouter` (0.05 GB), `singularity.purchaseTor` (2 GB) | 3.65 GB (3.65) |
| `singularity-buy-program.js` | `fileExists` (0.1 GB), `singularity.purchaseProgram` (2 GB) | 3.7 GB (3.7) |
| `singularity-upgrade-home-ram.js` | `getServerMaxRam` (0.05 GB), `singularity.upgradeHomeRam` (3 GB) | 4.65 GB (4.65) |
| `singularity-join-faction.js` | `getPlayer` (0.5 GB), `singularity.joinFaction` (3 GB) | 5.1 GB (5.1) |
| `singularity-buy-augmentation.js` | `getResetInfo` (1.0 GB), `singularity.getOwnedAugmentations`, `singularity.purchaseAugmentation` (5 GB each) | 12.6 GB (12.6) |
| `singularity-faction-work.js` | `singularity.getCurrentWork` (0.5 GB), `singularity.isFocused`, `singularity.setFocus` (0.1 GB each), `singularity.workForFaction` (3 GB) | 5.3 GB (5.3) |
| `singularity-company-work.js` | `getPlayer`, `singularity.getCurrentWork` (0.5 GB each), `singularity.isFocused`, `singularity.setFocus` (0.1 GB each), `singularity.applyToCompany`, `singularity.workForCompany` (3 GB each) | 8.8 GB (8.8) |
| `singularity-crime-work.js` | `singularity.getCurrentWork` (0.5 GB), `singularity.isFocused`, `singularity.setFocus` (0.1 GB each), `singularity.commitCrime` (5 GB) | 7.3 GB (7.3) |
| `singularity-class-work.js` | `getPlayer`, `singularity.getCurrentWork` (0.5 GB each), `singularity.isFocused`, `singularity.setFocus` (0.1 GB each), `singularity.universityCourse`, `singularity.gymWorkout` (2 GB each) | 6.8 GB (6.8) |
| `hack-loop.js` | `grow`, `weaken` (0.15 GB each), `hack`, `getServerMinSecurityLevel`, `getServerMaxMoney`, `getServerSecurityLevel`, `getServerMoneyAvailable` (0.1 GB each). It runs on the other servers, never home | 2.4 GB (2.4) |

The Singularity workers' figures are at SF4.3 or in BN4, where the test measures them (a BN4 simulation). With less of SF4 the game charges their Singularity calls 4× or 16×; the deployer allows for that (1.6 GB plus 16× the rest of the budget, as if every call were Singularity's), and the Agent then uses the page's worker for an action whose Singularity worker can never fit home beside it. No Singularity worker runs on a fresh save, so the fresh-save check (the Agent's budget plus the largest worker within 8 GB) leaves them out: the faction join's is 5.1 GB (#147), the augmentation purchase's 12.6 GB (#149), the faction work's 5.3 GB (#151), the company work's 8.8 GB (#153), the crime's 7.3 GB (#156), and the class's 6.8 GB (#158). The join's fits beside today's 2.85 GB Agent in an 8 GB home (were the Agent to grow past 2.9 GB, the fit check would leave joins to the page there); the purchase's and the work's need a home of 16 GB or more.

`buy-server.js` (#159, 4.5 GB) is a fresh-save worker: its NS calls need no Singularity.

The workers write to a port (`writePort`, free). The Agent plus the largest home worker a fresh save runs (`hack-loop-deploy.js`, 4.65 GB) is 7.5 GB, within its 8 GB home; a test checks the budgets (7.65 GB) keep it so, over every home worker a fresh save runs (all but the Singularity ones). The brain's [skeleton suite](../brain/README.md#the-skeleton-suite) and [hack loop suite](../brain/README.md#the-hack-loop) check home's RAM while the Agent actually runs, in a simulated 8 GB fresh start, and the E2 skeleton measures each script with the game's `mem` in a real one ([`packages/e2`](../e2/README.md#the-skeleton-on-e2)).

## Deploy layout

Where the in-game code lives on home (`@bitburner-agent/core`, `deploy-layout.ts`):

| Path | What |
|---|---|
| `agent/boot.js` | The one fixed-path script; autoexec runs it on every load of a save |
| `agent/current.txt` | The id of the deployment in use |
| `agent/desired-state.json` | The last desired state, kept for [safe mode](#safe-mode) (#160): `{ hackLoop, work, ttlMs, heardAtMs, lastAugReset }` (core's `SafeModeState`), never intents; empty when none is kept. Outside every deployment's folder, so the deployer's tidying never touches it |
| `agent/<deploymentId>/<name>.js` | A deployment's scripts: `agent.js`, its `snapshot-<tier>.js` workers, the hack loop's scripts, `buy-program.js`, `upgrade-home-ram.js`, `travel.js`, `join-faction.js`, `buy-augmentation.js`, `faction-work.js`, `company-work.js`, `crime-work.js`, `class-work.js`, `buy-server.js`, the Singularity workers (`singularity-*.js`), and a copy of `boot.js`, whose RAM the deployer checks there before it changes `agent/boot.js`. `hack-loop.js` is also copied, at the same path, to each server that runs it |
| `agent/<deploymentId>/config.json` | Its configuration for the Agent: `{ "deploymentId": …, "controlPort": … }` (`AgentConfig`, read with `parseAgentConfig`) |
| `agent/<deploymentId>/token.txt` | The control channel's token |

A deployment is a build plus its configuration, so a new token or port is a new deployment too. Its id is a folder name: letters, digits, `-` and `_` (`isValidDeploymentId`). Each one gets its own folder, so a deploy never overwrites a file a running script uses. The deployer ([#91](https://github.com/UnderMyBed/bitburner-agent/issues/91)) writes `current.txt` last.

## `boot.js`

It starts the deployed Agent if it isn't running, and does nothing else (architecture §5.7):
1. reads `agent/current.txt`;
2. given an Agent's pid (an Agent handing over passes its own), waits until that Agent has exited;
3. if `agent/<deploymentId>/agent.js` isn't running on home, runs it as a **temporary** script.

Why it waits: the game starts `boot.js` while the Agent that ran it is still running. Until that Agent exits, its 2.85 GB isn't free, and old Agent, `boot.js` and new Agent together need 8.4 GB, more than an 8 GB home has, so the new one couldn't start. And if the deployed Agent is the one handing over, `boot.js` would see it still running and start nothing.

It's safe to run any number of times. When nothing is deployed, `current.txt` doesn't hold a deployment id, or the Agent can't start, it says so in the terminal and in its log; for a failed start, the game's own reason (a missing file, too little RAM, a script it can't parse) is in the log too.

**It never stops an Agent.** An Agent from an earlier deployment keeps running until it restarts itself: the deployer tells it to, or, while disconnected, it finds `current.txt` names another deployment. Then it runs `boot.js` and exits ([the Agent](#the-agent), [#88](https://github.com/UnderMyBed/bitburner-agent/issues/88), [#91](https://github.com/UnderMyBed/bitburner-agent/issues/91)).

**Why temporary:** the game saves every running non-temporary script and restarts it on load (game source: `src/NetscriptWorker.ts:241-261`). A temporary Agent isn't saved. So after a load, autoexec (`boot.js`) is the one way back, and a load never starts an old Agent and its workers at once, which wouldn't fit in 8 GB.

## The Agent

`agent/<deploymentId>/agent.js` runs all the time, holds the control channel to the brain ([protocol](../../docs/bridge/protocol.md), architecture §5.1), and sends [snapshots](#snapshots).

**Lifecycle:**
1. **Start:** it finds its folder from its own path (`deploymentIdOfPath`), then reads `config.json` and `token.txt` there. `config.json`'s `deploymentId` must name that folder. If a file is missing, empty or invalid, it says which in the terminal and in its log, and exits. It makes a new `agentSessionId`, kept across its reconnects.
2. **Connect:** to `ws://127.0.0.1:<controlPort>`. When the socket opens, it sends `hello` with the game's version (`ns.ui.getGameInfo()`).
3. **`welcome`:** it stays connected, and its backoff goes back to 1 s. From then on it takes a round of snapshots every 2 s, the first one at once, then converges [the hack loop](#the-hack-loop) when that's due, then runs the [intents](#intents) that are due, and sleeps (`ns.sleep`) in between. It acts on what arrived (a `restart`, a `desiredState`, a close) at the start of each round, after the sleep. A round never runs past 2 s, so that's within 2 s. Last in the round, the [work activity](#work) converges the work when that's due. At the `welcome` it stops converging on any state a brain sent before: from then on, only this brain's states count.
4. **`desiredState`:** it keeps the latest: the hack loop converges on it, the intent runner does its intents, and the [work activity](#work) converges the work last. Every round, before them, the [dialog watcher](#dialogs) handles the game's dialogs. It also keeps it for [safe mode](#safe-mode), in `agent/desired-state.json`.
5. **`restart`:** it runs `agent/boot.js` with its own pid and exits; `boot.js` waits for it to go, then starts the deployed Agent. Its socket closes as it exits.
6. **Disconnected:**
   - closed with 4000 (a newer Agent replaced it): it exits for good;
   - otherwise, if `agent/current.txt` holds a valid id of another deployment, it runs `boot.js` and exits. An empty or invalid `current.txt` doesn't count: `boot.js` would refuse it, leaving no Agent;
   - otherwise it waits and reconnects: 1 s, doubling to 30 s. It forgets the intents. With a state kept for [safe mode](#safe-mode), its rounds go on while it waits and connects, without snapshots: the dialogs, the hack loop and the work, on that state.

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

**Workers** (`agent/<deploymentId>/snapshot-<tier>.js`) are short-lived and hold the costly NS calls, so the Agent stays at 2.85 GB:
- The Agent runs each as a **temporary** script (`ns.run(file, { temporary: true })`), with no arguments, so a save never holds one.
- The worker reads the game and writes `{ workerPid, gameTimeMs, data }` to port 89001 (`WORKER_REPORT_PORT`), then exits.
- The Agent takes the report carrying that worker's pid, skipping anything else on the port (such as a report that came too late), and waits for the worker to exit, so its RAM is free for the next one. It checks `ns.isRunning` every 20 ms, so a worker that exits without a report costs no more than that.
- **Every wait ends with the round**, 2 s after it started. So a round never runs past 2 s, and the heartbeat is never more than two rounds (4 s) apart, under the gap threshold (6 s), whatever the workers do.
- While it waits it uses `ns.asleep`, not `ns.sleep`: a `sleep` that lost the race would leave the script marked busy, and its next `ns` call would get it killed. And it calls `ns.isRunning` before reading the port, so an Agent that has been killed ends there, before it can read a report meant for the next Agent.
- **Never a second copy:** while a tier's last worker is still running, the tier isn't started again. The Agent doesn't kill a worker that hangs (that would need `kill`, 0.5 GB, over its budget). Only a bug could make one hang: each keeps its RAM until it exits, which can starve the larger workers meanwhile.

**Degraded:** a worker that can't start (home is full), exits without a report, doesn't report before the round ends, or is still running from before leaves its tier skipped that time. A tier with no time left in the round is skipped too. A skipped tier is named in the fast snapshot's `degradedTiers` until it next succeeds, and stays due, so it's tried again next round. When the fast worker itself is skipped, the fast snapshot is still sent, with `game: null`. So on a full home the brain sees a live but blind Agent, never a dead one. The Agent logs a tier being skipped or coming back, not every round.

While the new-game tutorial runs, finished scripts never free their RAM (architecture §5.7), so the workers would soon fail to start and every tier degrade. On the owner's and the brain's normal paths the Agent never runs alongside it, so it has no step to end it ([#168](https://github.com/UnderMyBed/bitburner-agent/issues/168)): the terminal refuses `run agent/boot.js` until the owner clicks "Exit Tutorial", and autoexec runs only when a save loads, which never brings the tutorial back. The exceptions are deliberate owner actions after Options' "Reset tutorial" (a killed Agent's log "Run" button, the script editor's Run) and a hand-edited tutorial `n00dles.js` (architecture §5.7).

## The hack loop

The Agent's first action, M3's first slice ([#134](https://github.com/UnderMyBed/bitburner-agent/issues/134), owner decision 34). The brain decides; the Agent carries it out (`src/agent/hack-loop.ts`). It's the thinnest version of the reconciler (architecture §5.3), and its first activity:
- **What the brain sends:** `desiredState { hackLoop: { enabled, target, hosts } }` ([protocol](../../docs/bridge/protocol.md#brain--agent)).
  - It's on unless the owner turns it off on the dashboard.
  - `target` and `hosts` come from the brain's starter rules ([packages/brain](../brain/README.md#the-hack-loop)). The hosts are the game's rooted servers, never home and never the player's own purchased or Hacknet servers.
- **Only from the brain it's connected to, or with none, [safe mode](#safe-mode).** While connected, the Agent acts only on what that brain sent. Without a state from it (just welcomed, or a brain that holds), it does nothing, and loops already running keep running. With no brain, it converges on the last state a brain sent, until its `ttlMs` passes.
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

## Intents

M3's fourth slice ([#141](https://github.com/UnderMyBed/bitburner-agent/issues/141), architecture §5.3, §5.6): one-shot actions, done at most once. The brain sends them in its desired state as `intents: [{ id, action, args }]` ([protocol](../../docs/bridge/protocol.md#brain--agent)): its purchase rules' next purchase, and the owner's manual queue ([packages/brain](../brain/README.md#intents)).
- **The intent runner** (`src/agent/intent-runner.ts`) keeps the intents until the Agent disconnects (never into [safe mode](#safe-mode): one-shot actions need the brain), and runs each through its effector:
  - in order, after the snapshots and the hack loop, each only with 1 s of the round left (else it waits a round);
  - a new intent is due at once; one not done is tried again every 15 rounds (30 s), logging why each time, with the backend ("travel to Aevum (ui): not done: …; trying again in 30 s");
  - one done ("travel to Aevum (ui): done") is never run again while the brain keeps sending it; the brain sees it done in its next medium snapshot and stops sending it. One that leaves the list and comes back is new;
  - a worker that doesn't run (home full, still running, no time left) is tried again next round; it counts as a try, so one that never runs shows as stuck.
- **The Effector table** (`src/agent/effectors.ts`): for each action, how each of the three backends does it (architecture §5.6, #145):

  | Action | `ui` worker (arguments) | `singularity` worker (arguments) | `sim` |
  |---|---|---|---|
  | `buyTor` | `buy-program.js` ("TOR router", the vendor) | `singularity-buy-tor.js` () | `buyTorRouter()` |
  | `buyProgram` | `buy-program.js` (the program, "") | `singularity-buy-program.js` (the program) | `buyDarkwebProgram(program)` |
  | `upgradeHomeRam` | `upgrade-home-ram.js` (`fromRam`, the vendor) | `singularity-upgrade-home-ram.js` (`fromRam`) | `buyHomeRam(fromRam)` |
  | `travel` | `travel.js` (the city) | `singularity-travel.js` (the city) | `travelTo(city)` |
  | `joinFaction` | `join-faction.js` (the faction) | `singularity-join-faction.js` (the faction) | `acceptFactionInvitation(faction)` |
  | `purchaseAugmentation` | `buy-augmentation.js` (the faction, the augmentation, the level) | `singularity-buy-augmentation.js` (the same) | `buyAugmentationFrom(faction, augmentation, level)` |
  | `buyServer` | `buy-server.js` (the hostname, the RAM): NS calls alone, no page | none: `buy-server.js` needs no Singularity | `buyCloudServer(hostname, ram)` |

  Each worker also gets a deadline 200 ms before the round's end, checks the game first (an intent already done is done without touching the page or calling anything), and reports `{ done, problem }` (`EffectorReport`).
- **The backend** is picked per try: the simulator's own effectors where the page's global object has them (`__bitburnerAgentSim`, packages/sim: the simulator renders no page; absent in a browser), called directly; else Singularity, once the Agent's own slow snapshot shows SF4 at any level or BN4, when that action's Singularity worker fits home beside the Agent, however empty home is (`getScriptRam` against home's RAM: the game charges it 4× at SF4.2 and 16× below); else the page, logged the first time. The fit is checked every try, so a home upgrade brings Singularity back. A Singularity worker that can't start for now (home full) or doesn't report is tried again, like any worker. The outcome and the done or not-done log line name the backend of the last try. An action the NS API does without Singularity (`buyServer`, #159) has no Singularity worker (its `singularity` is `null`): its `ui` worker runs in any game, and the outcome names `ui`.
- **Outcomes:** the fast snapshot carries every intent the runner holds, as `{ id, done, tries, problem, backend }`, for the brain's dashboard and its "intent stuck" alert.
- **Tests:** `test/agent/intent-runner.test.ts` covers the schedule, the order, the time rule, the logs, forgetting and the backend choice; `test/agent/singularity-available.test.ts` covers when the game has Singularity. Its property tests (fast-check) run random intent lists, worker reports and disconnects to check that the runner is idempotent (an intent reported done never runs again while it stays sent) and that it converges (every intent sent long enough, whose worker can do it, ends done).

## Dialogs

M3's fifth slice ([#143](https://github.com/UnderMyBed/bitburner-agent/issues/143), owner decision 35): the Agent handles the game's routine dialogs, so unattended play doesn't stall on them. The **dialog watcher** (`src/agent/dialog-watcher.ts`) runs every round, after the snapshots and before the hack loop and the intents, so their page work finds none of these in the way. It reaches the page itself (`globalThis.eval("document")` costs nothing), with no worker, and handles up to 10 dialogs a round. The game shows queued alerts (and invitations) one at a time in the same dialog, so after each it waits until the dialog has gone or shows the next:
- **A game alert** (`ui/React/AlertManager.tsx`: "Offline for…" after a load, purchase, travel and install notices, the Source-File and BitNode congratulations) is closed with its own close button. It's recognized by the AlertManager's own React state up the dialog's fibers, a list of `{ text, hash, canBeDismissedEasily }`, never by a component's name, which a production build minifies.
- **A faction invitation** ("You received a faction invitation.", `Faction/ui/FactionInvitationManager.tsx`) gets "Decide later": the invitation stays on the Factions page, and joining is the brain's call.
- **Anything else** is left alone: a dialog a script made (its `ns.prompt`, or its `ns.alert`, the one alert the game makes from HTML, so it's told apart), one the owner opened, one it doesn't know. A dropdown (MUI's `Popover`) isn't a dialog. A dialog fading out after a close (its content `inert`) is skipped.

What it did goes up in the next fast snapshot, as `dialogs: { handled: [{ kind, text }], blocking }` (the latest 100 handled, as with no brain there's no fast snapshot for a while, #160): each handled dialog's text without its buttons (up to 1,000 characters), and the text of one left open, or null. The brain stores the handled ones as `gameDialog` events and raises `dialogBlocking` for one left open. `test/agent/dialog-watcher.test.ts` covers each kind on a stand-in page in jsdom; E2 covers the real ones ([`packages/e2`](../e2/README.md)).

## The hacking programs

M3's second slice ([#136](https://github.com/UnderMyBed/bitburner-agent/issues/136)): the Agent buys the TOR router and the five port openers, so the [hack loop](#the-hack-loop) can root more servers. It was the first **`ui` effector** (architecture §5.6): BN1.1 has no Singularity API, so it buys through the game's own page (`src/page/game-page.ts`, `src/entries/buy-program.ts`). Since #141 the brain asks for each as an [intent](#intents), `buyTor` or `buyProgram` ([packages/brain](../brain/README.md#the-hacking-programs) picks which).
- **`buy-program.js`**, with the item, the vendor and a deadline, so it ends within the Agent's round like any other worker:
  1. **The game first:** the TOR router owned (`hasTorRouter`) or the program on home (`fileExists`) is done, without touching the page.
  2. **Never over an open dialog** the [dialog watcher](#dialogs) leaves alone (a script's prompt, one the owner opened): that's the owner's, so it does nothing and tries again later. A dialog that's just been closed is given the time its fade takes (400 ms) to go.
  3. **The TOR router:** the sidebar's City, the vendor (`span[aria-label]` on the ASCII map, or a button with ASCII art off; the page's `openCityLocation`), "Purchase TOR router" while it can be bought (not disabled), then the purchase's dialog closed with its own close button (never Escape, which closes every dialog). No dialog is left open (E2 checks).
  4. **A program:** the sidebar's Terminal, and `buy <program>` typed into it, unless the owner has a line typed there: that's left alone.
  5. **Back to the Terminal,** however it went, once it has moved the page (or focused on the player's work again, if they were: [Work](#work)).

  It reports `{ done, problem }`. A problem is a page that isn't as expected: no page, a dialog open, a sidebar section collapsed (its items unmount), a button missing (each named: "no TOR router to buy (is the money there?)"), or a line typed in the terminal. A problem on the way back to the Terminal is reported even when the item was bought.
- **The page** (`src/page/game-page.ts`): reached with `globalThis.eval("document")`, an indirect eval (a direct one would make the bundler rename other modules' names), never the identifiers `document` or `window`, which cost 25 GB each. A click calls the element's React `onClick` with `{ isTrusted: true }`, and the terminal takes React's own `onChange` and `onKeyDown`, as the legacy fork does. The Enter handler is read after the line is typed: the one from before would run the empty line. Every wait ends by the worker's deadline, and looks at least once. The steps end 300 ms before it, so the way back to the Terminal has its own time however long a step waited (`test/agent/game-page.test.ts`).
- **What the owner sees:** a few times a session, the page switches to the City and back to the Terminal, or a `buy` is typed into the terminal. The dashboard's "Stop buying programs" switch stops it.

E2 buys all six on the real page, each at its first try, and checks that a collapsed World section, or a dialog the Agent leaves alone, stops it until it's open again, or closed ([`packages/e2`](../e2/README.md)). `test/agent/game-page.test.ts` drives a stand-in page in jsdom.

## Home RAM

M3's third slice ([#138](https://github.com/UnderMyBed/bitburner-agent/issues/138)): the Agent doubles home's RAM at a tech vendor, the second `ui` effector, through the same page code as the TOR router (`src/entries/upgrade-home-ram.ts`). The brain asks for each doubling as an `upgradeHomeRam` [intent](#intents) ([packages/brain](../brain/README.md#home-ram) picks it, one purchase at a time with the programs, cheapest first).
- **`upgrade-home-ram.js`**, with home's RAM when the brain asked (`fromRam`), the vendor and a deadline:
  1. **The game first:** home with more RAM than `fromRam` (`getServerMaxRam`) is done, without touching the page. So a repeat never buys a second doubling.
  2. **Never over an open dialog** the dialog watcher leaves.
  3. The sidebar's City, the vendor, and "Upgrade 'home' RAM" while it can be bought (it's disabled when the player can't afford it, or home is at its limit). A purchase opens no dialog.
  4. **Back to the Terminal,** however it went (or focused on the player's work again, if they were: [Work](#work)).

  It reports `{ done, problem }`, as `buy-program.js` does ("no home RAM upgrade to buy (is the money there?)").
- **What the owner sees:** once per upgrade, the page switches to the City and back to the Terminal. The dashboard's "Stop upgrading home RAM" switch stops it.

E2 upgrades home from 8 GB to 16 GB on the real page and checks it goes no further, with no dialog left open.

## Travel

The third `ui` effector ([#141](https://github.com/UnderMyBed/bitburner-agent/issues/141)): the `travel` intent flies the player to one of the six cities (`src/entries/travel.ts`). A ticket costs $200k.
- **`travel.js`**, with the city and a deadline:
  1. **The game first:** the player already in the city (`getPlayer`) is done.
  2. **Never over an open dialog** the dialog watcher leaves.
  3. The sidebar's Travel, then the city: on the ASCII map, its first letter (the six differ, `ui/React/WorldMap.tsx`), or with ASCII art off, a "Travel to <city>" button.
  4. The confirmation's "Travel", then the "You are now in <city>!" alert closed with its own close button: each only if it's shown, since the player's Options can turn both off (`SuppressTravelConfirmation`). Without the ticket's money the game does nothing, and the worker reports it ("not in <city> after travelling (is the $200k ticket there?)").
  5. **Back to the Terminal,** however it went (or focused on the player's work again, if they were: [Work](#work)).
- **What the owner sees:** the page switches to the Travel Agency and back to the Terminal, once per travel queued.

E2 queues a travel to Aevum on the dashboard and checks the Agent flies there, with the confirmation and the alert shown and handled, and ends on the Terminal with no dialog open.

## Joining a faction

The fourth `ui` effector ([#147](https://github.com/UnderMyBed/bitburner-agent/issues/147)): the `joinFaction` intent accepts a faction's invitation (`src/entries/join-faction.ts`). Joining one of the six city factions bans its enemies, so the brain sends that only past its gate: the guard on two medium snapshots, then a save backup ([`packages/brain`](../brain/README.md#intents)). The Agent does what it's sent.
- **`join-faction.js`**, with the faction and a deadline:
  1. **The game first:** the player already a member (`getPlayer().factions`) is done.
  2. **Never over an open dialog** the dialog watcher leaves. The watcher answers each invitation "Decide later" (#143), so the invitation waits on the Factions page.
  3. The sidebar's Factions, then "Join!" on the faction's row under the invitations (`Faction/ui/FactionsRoot.tsx`, `span.factions-invites`). With no such row there's no invitation: "no invitation from <faction> on the Factions page".
  4. **Back to the Terminal,** however it went (or focused on the player's work again, if they were: [Work](#work)).
- **What the owner sees:** the page switches to Factions and back to the Terminal, once per try.
- **Without Singularity nothing lists invitations** (`getPlayer` has the factions joined, not those inviting), so the worker reads them from the page; the dialog watcher's `gameDialog` events say when one arrives.

E2 earns the Sector-12 invitation ($20m, travelling there), checks a join without an invitation says so, queues the join, and checks it's held at first, a save backup came before Sector-12 shows joined, and the page ends on the Terminal.

## Buying augmentations

The fifth `ui` effector ([#149](https://github.com/UnderMyBed/bitburner-agent/issues/149)): the `purchaseAugmentation` intent buys an augmentation from a faction joined (`src/entries/buy-augmentation.ts`). Its `level` is 1, or NeuroFlux Governor's level to buy, so each NeuroFlux level is its own intent.
- **`buy-augmentation.js`**, with the faction, the augmentation, the level and a deadline:
  1. **The game first:** installed (`getResetInfo().ownedAugs`; NeuroFlux at that level) is done. A queued augmentation is in no NS call without Singularity, so the page tells.
  2. **Never over an open dialog** the dialog watcher leaves.
  3. The sidebar's Factions, "Augments" on the faction's row, then the augmentation's row (`Augmentation/ui/PurchasableAugmentations.tsx`). "Owned" is done; NeuroFlux's title names the next level to buy, so a level past this one is done, and one before it says the levels before come first.
  4. **A disabled "Buy" is never clicked:** its handler would still run. The page disables it without the money, the reputation or a prerequisite, and the worker says so.
  5. "Buy", then the confirmation's "Purchase" and the "You purchased" alert's close button, each only if shown (Options can turn both off, `SuppressBuyAugmentationConfirmation`). The row then shows it bought.
  6. **Back to the Terminal,** however it went (or focused on the player's work again, if they were: [Work](#work)).
- **What the owner sees:** the page switches to the faction's augmentations and back to the Terminal, once per try.
- **Queued from another faction:** the page shows "Owned" only on the faction named, so an augmentation queued through another isn't seen as done there (the `sim` and `singularity` backends see it): "<faction> doesn't offer …" or "can't buy … yet", tried again every 30 s. The brain names the faction it's bought from, so this needs an owner's queue naming two.
- **Names with apostrophes** ("The Shadow's Simulacrum") are quoted for XPath by `xpathString` (`src/page/game-page.ts`).

E2 buys Neurotrainer I and NeuroFlux level 1 from CyberSec (a save the simulator sets up with the reputation), with the confirmation and alert handled, and checks a purchase the money doesn't cover opens no dialog: its disabled "Buy" is never clicked.

## Buying servers

[#159](https://github.com/UnderMyBed/bitburner-agent/issues/159): the `buyServer` intent buys a cloud server, `{ hostname, ram }` (`src/entries/buy-server.ts`). The game's API does it without Singularity (`ns.cloud.purchaseServer`, `NetscriptFunctions/Cloud.ts:35-93`), so there's no page to drive and no Singularity worker: `buy-server.js` is the `ui` backend's worker in any game.
- **`buy-server.js`**, with the hostname, the RAM and a deadline (unused: the calls are quick):
  1. **The game first:** a server of that name that's one of the player's cloud servers is done, whatever its RAM; upgrading isn't this intent. `cloud.getServerUpgradeCost` tells (it answers -1 for a server that isn't a cloud server, `Server/ServerPurchases.ts:44-54`), at 0.1 GB where `cloud.getServerNames` would cost 1.05 and no longer fit a fresh save beside the Agent.
  2. **A name taken by another server** (`n00dles`) is refused, and nothing is bought: the game would buy it as `n00dles-0` (`Server/ServerHelpers.ts:42-65`), and the next try another.
  3. **The price** (`cloud.getServerCost`; Infinity past this BitNode's most) against the money: "not enough money: the 8 GB server costs $440000".
  4. **The purchase.** With the name, the RAM and the money checked, its refusal leaves one cause: "the game's limit of 25 cloud servers is reached" (`cloud.getServerLimit`).
  5. **Bought under another name** all the same, because a server `serverExists` doesn't see held it: done, saying "bought as …", so it's never bought twice. The game has one such server, `w0r1d_d43m0n` (no network links before The Red Pill), and core refuses that name (found in #161's review: each try would have bought another).
  - Its logic is in `src/workers/cloud-server-purchase.ts`, which `test/agent/cloud-server-purchase.test.ts` drives with a stand-in NS for the branches BN1 can't reach.
- **What the owner sees:** nothing on the page; the server is in the next medium snapshot (its `scan` from home reaches it) and the slow one's `purchasedServers`.

## Work

The Agent's second activity ([#151](https://github.com/UnderMyBed/bitburner-agent/issues/151), owner decision 37), beside the hack loop: the work the player does, as the brain wants it (`src/agent/work.ts`). The brain sends `work`, or none, which leaves the game's work alone: faction work (the faction, and hacking, field or security), or company work ([#153](https://github.com/UnderMyBed/bitburner-agent/issues/153): the company, and the job field: "Software", "Waiter", …), or a crime ([#156](https://github.com/UnderMyBed/bitburner-agent/issues/156): "Shoplift", "Heist", …), or a class ([#158](https://github.com/UnderMyBed/bitburner-agent/issues/158): a university and a course, or a gym and a stat), and whether focused.
- **When:** when the work wanted changes, then every 15 rounds (30 s), last in the round after the intents, with a second of the round left. The outcome (`{ converged, problem, backend }`) is in the fast snapshot.
- **The effector** (`workEffectorFor`), through the same backends as intents (`src/agent/effector-runner.ts`):
  - `ui`, **`faction-work.js`**: without Singularity the page is the only witness. Focused, the Work page's title ("You are currently carrying out hacking contracts for CyberSec"); unfocused, the overview's "Working for CyberSec", whose "Doing hacking work" is only its tooltip (rendered on hover), so it's read from the overview's React props (`reactPropsAbove`, `reactText`). Already so: done, nothing touched. The right work at the wrong focus: the overview's "Focus", or "Do something else simultaneously" and back to the Terminal; the work isn't restarted. Otherwise the sidebar's Factions, "Details" on the faction's row, and the work's button ("Hacking Contracts", "Field Work", "Security Work"), which starts it focused; then unfocused if it shouldn't be. A faction that doesn't offer the work says so. Stopped on the way, the player is left as found: focused again on their own work, or on the Terminal.
  - `singularity`, `singularity-faction-work.js`: `getCurrentWork` and `isFocused`, then `workForFaction` or `setFocus`. At 5.3 GB it never fits beside the Agent in an 8 GB home (BN4's start), so work goes through the page there until home grows.
  - `sim`: `convergeFactionWork`, as the faction's page and the focus buttons do it.
- **Company work** (#153), the same way, with what the page shows and does for a company (`src/page/work-page.ts`):
  - `ui`, **`company-work.js`**: focused, the Work page's "You are currently working as a Waiter at Noodle Bar"; unfocused, the overview's "Working at Noodle Bar", whose job title is its tooltip, read the same way. Any of the field's job titles counts (`JOB_FIELDS`, `packages/core/src/companies.ts`, from the game's job tracks), as a player hired higher up the field holds another title. Otherwise, with a job in the field there (`getPlayer().jobs`), that job's "Work" on the sidebar's Job page, from any city: it lists each job held, in that order (`Locations/ui/JobRoot.tsx`). Without one, the sidebar's City and the company there, which the page shows only in its city: elsewhere it says "no Noodle Bar in the city (is the player in its city?)", and the owner queues a travel. Then the field's "Apply" button ("Apply to be a Waiter", "Apply for Software Engineering Intern Job", …), as the company's job listing shows it (`Company/ui/JobListings.tsx`): the highest job the player qualifies for (the game hires them there), or else the field's first job, disabled ("not qualified for a Software job at MegaCorp yet"); none where the company offers neither, as DeltaOne's Business, which starts at Operations Manager ("no Business job open to the player at DeltaOne (none offered, or not qualified yet)"). Then the hiring's alert closed ("Congratulations, you are now employed as a Waiter", "Congratulations, you got a contract as a …"), and "Work", which starts it focused, and unfocused if it shouldn't be. Applying where the player holds another job there replaces that job, as the game does. A job held is never applied for again, so there are no promotions yet ([#155](https://github.com/UnderMyBed/bitburner-agent/issues/155)).
  - `singularity`, `singularity-company-work.js`: `applyToCompany` if there's no job in the field there, then `workForCompany` or `setFocus`. Singularity doesn't ask where the player is. `applyToCompany` starts from the field's first job and climbs to the highest the player qualifies for, so it can't hire where a company doesn't offer the first (DeltaOne's Business, DefComm's), which the page can: "DeltaOne didn't hire for a Business job (not qualified yet, or not offered to applyToCompany)". At 8.8 GB it needs a home of 16 GB or more beside the Agent.
  - `sim`: `convergeCompanyWork`, as the page does it: a job held from the Job page, anywhere; otherwise the company's page in its city only, its job listing's rules included, so its problems read as the page's.
- **Crime** (#156), the same way:
  - `ui`, **`crime-work.js`**: focused, the Work page's "You are attempting to shoplift" (each crime's wording, `CRIMES` in `packages/core/src/crimes.ts`: "… larceny", "… a heist"); unfocused, the overview's "You are attempting to Shoplift". Otherwise the sidebar's City, The Slums (in every city), and the crime's button, "Shoplift (45.20% chance of success)", never disabled, which starts it focused; then unfocused if it shouldn't be (the game's "Do something else simultaneously" goes to the City for a crime, and the worker back to the Terminal). A crime is committed again and again until other work replaces it (`Work/CrimeWork.ts:35-50`), and ends with no dialog. Started again, it loses its progress, so a focus change never starts it again. Focus matters: unfocused, a crime gains 80% of the experience and karma (`Work/CrimeWork.ts:64-84`), so the brain sends it focused unless the implant is installed.
  - `singularity`, `singularity-crime-work.js`: `getCurrentWork` and `isFocused`, then `commitCrime` (from any city) or `setFocus`. At 7.3 GB it needs a home of 16 GB or more beside the Agent.
  - `sim`: `convergeCrimeWork`, as the Slums page does it.
- **Classes** (#158), the same way, with what the game teaches where in `packages/core/src/classes.ts`: three universities (Computer Science, free, up to Leadership) and five gyms (strength, defense, dexterity, agility: "str", "def", "dex", "agi"), each in one city, each with its cost multiplier. Focus gains a class nothing (`Work/Formulas.ts:108-121`), so the brain sends them unfocused.
  - **Held back first**, by every backend, before starting one (core's `classStartProblem`): the location in another city ("Crush Fitness Gym is in Aevum, and the player is in Sector-12 (travel there first)"), or a paid class with less money than 10 minutes of it costs (its base money a second times the location's `costMult`, `Work/Formulas.ts:100-105`, the backdoor's 10% off left out): the game would start it anyway and let the money go negative. A class under way is never held back, whatever the money. The guard is the conservative choice, for the owner to confirm (#158).
  - `ui`, **`class-work.js`**: focused, the Work page's "You are currently studying Computer Science" (each class's `youAreCurrently`: "… taking a Data Structures course", "… training your strength at a gym"); unfocused, the overview's "You are studying Computer Science". Neither says where, so a class of the type wanted counts wherever it is: the page can't tell Iron Gym's strength training from Powerhouse Gym's. Otherwise `getPlayer` for the guard, then the sidebar's City, the university or gym (only in its city), and the class's button, "Study Computer Science (free)", "Take Networks course (… / sec)", "Train Strength (… / sec)", never disabled, which starts it focused; then unfocused ("Do something else simultaneously" goes to the location) and back to the Terminal. A class the page started ends, when other work replaces it, with an "After … you spent …" alert, which the dialog watcher closes.
  - `singularity`, `singularity-class-work.js`: `getCurrentWork` (its `classType` and `location`, so the location is checked exactly) and `isFocused`, then the guard (`getPlayer`), then `universityCourse` or `gymWorkout`, or `setFocus`. At 6.8 GB it needs a home of 16 GB or more beside the Agent.
  - `sim`: `convergeClassWork`, as the location's page does it, after the same guard, the location checked exactly.
- **Every page effector keeps the focus** (`src/page/page-effect.ts`): the Work page hides the sidebar, so a player focused on work is unfocused before the steps ("Do something else simultaneously") and focused again after (the overview's "Focus"), instead of returning to the Terminal. The work worker sets the focus itself.
- **What the owner sees:** the Work page while focused; a page action in between leaves it and comes back. Doing something else yourself is undone within 30 s while the brain manages work.

E2 starts CyberSec's hacking contracts on the real page, unfocuses as the owner would and sees the Agent focus again without restarting the work, travels while focused (unfocused for the sidebar, then focused again), stops managing work and sees it left alone; with the implant installed (a harness edit), it leaves the work unfocused and keeps seeing it so; and it asks for work a faction doesn't offer. For company work it starts from a save in New Tokyo, applies to be a waiter at Noodle Bar, closes the hiring alert and works focused, then is focused again after the owner unfocuses, neither restarted nor applied again; after a travel to Aevum and the owner stopping work there, it works the job held again from the Job page; from Sector-12 it says the player isn't in the company's city. For crime it shoplifts focused at the Slums and is focused again after the owner unfocuses, through the overview's "Focus" (never back to the Slums, which would start it again); with the implant it shoplifts unfocused on the Terminal. For classes it studies Computer Science at Rothman University from a Sector-12 save, left unfocused on the Terminal, then takes Data Structures in its place (the "After studying Computer Science…" alert closed); and with $1,000, a gym in Aevum and Data Structures are held back with their reasons, the page untouched. Tests: `test/agent/work.test.ts` (the activity's schedule and backends), `test/agent/game-page.test.ts` (`reactPropsAbove`, `reactText`), `test/agent/page-effect.test.ts` (the focus kept around the steps, and given back when the work can't start; company work's steps: hired (Apply, the hiring's alert closed whatever its wording, Work, unfocused), a disabled "Apply" never clicked, a job held worked from the Job page, a name with an apostrophe; a crime started at the Slums and unfocused, and how the page shows a crime; a course and a gym's stat started from their buttons, how the page shows a class, and a class held back), `packages/core/test/companies.test.ts`, `crimes.test.ts` and `classes.test.ts` (the companies, fields, titles, "Apply" texts, part-time fields, crimes and their wording, and the universities, gyms, class types, wording, buttons and costs, against the game's; the guard's sums and problems).

## Safe mode

M3's twelfth slice ([#160](https://github.com/UnderMyBed/bitburner-agent/issues/160), architecture §5.4): with the brain gone, a missing brain costs optimality, not progress. The Agent keeps converging on the last desired state a brain sent (`src/agent/safe-mode.ts`), until its `ttlMs` passes (12 hours, the brain's `SAFE_MODE_TTL_MS`).
- **What converges:** the [hack loop](#the-hack-loop) and the [work](#work), at their own cadence (a change at once, then every 30 s), and the [dialog watcher](#dialogs) runs first, so a reload's "Offline for…" alert doesn't stall the page's work effector. **Never the intents:** one-shot actions need the brain, so they're forgotten at the disconnect. No snapshots are taken, as nobody reads them, but the slow worker runs once, unsent, if the Agent has no slow snapshot yet: for the reset check below, and for whether Singularity can do the work. The dialogs handled meanwhile (the latest 100) reach the brain in the first fast snapshot after it's back.
- **When:** in rounds, every 2 s, while the Agent connects and while it waits to reconnect. A connected brain's word comes first: once welcomed, the Agent acts only on what that brain sends, as before. A brain that sends nothing (one that holds with the hack loop on, before it has sent anything; with it off, a hold sends the loop off, which replaces the kept state) leaves loops running untended; if it then goes, safe mode picks up again, the clock still running from the last brain that sent the state. A brain back sends a fresh state, which replaces the kept one.
- **The clock** runs from when the Agent was last connected to the brain that sent the state, not from when it was sent: a state sent once stands for as long as its brain is there.
- **Kept on home** in `agent/desired-state.json`, so the next Agent has it: after a reload, an install's restart, or a new deployment. Written when a state arrives, every 30 rounds (60 s) while connected to the brain that sent it, and at the disconnect, with its time. `ns.write` and `ns.read` cost no RAM, and one `write` replaces the whole text. The save holds what was there at its autosave, so a reload can lose up to about 2 minutes of writes (a write every 60 s, an autosave every 60 s): the clock then starts up to that much early, never late. A state heard before the Agent knows the game's last reset (no slow snapshot yet) empties the file until it can be stamped, so the file never holds an older state than the last heard. A file that doesn't parse is ignored, and the log says why.
- **Dropped,** logged, and the file emptied (`rm` would cost 0.6 GB):
  - `ttlMs` after that clock's last moment;
  - after a reset: a state from the file waits until the Agent has the game's `lastAugReset` from a slow worker, and is dropped if it's not the one it was kept with. An install or a new BitNode may have made its target unhackable, its work gone. A reset always means a new Agent, so a state the running Agent heard itself is never checked.
  - when the brain's latest has no `ttlMs` (a brain from before #160).

  Once dropped, the loops and the work carry on as the game has them, untended, as after any disconnect before #160.
- **The owner taking over by hand:** before stopping the brain, click **Stop managing work** on the dashboard (and turn the hack loop off if you want it gone): safe mode then keeps that. With the brain already stopped, the Agent keeps re-converging the work for up to 12 hours. `kill` stops it only until the next load, when autoexec's Agent resumes from the file; to stop it for good, `rm agent/desired-state.json`, then kill it ([setup](../../docs/setup.md)).
- **A game other than the pinned release** (Steam updated it overnight, say): only what a hold would send goes on, the hack loop as kept and no work, since the work effectors drive the game's page and nobody has checked this version (architecture §12.4). The log says so.
- **RAM:** none; the Agent stays at 2.85 GB.

Tests: `test/agent/safe-mode.test.ts` covers what's kept and written and when, the clock, expiry, the reset check and a file that doesn't parse; its property tests (fast-check) run random states, rounds, disconnects, reconnects, time, restarts and resets, and check safe mode never converges on a state past its `ttlMs`, from before a reset, other than the last one a brain sent, or with intents, and that it does converge while none of those applies. The brain's [safe mode suite](../brain/README.md#safe-mode) runs the chaos tests in the simulator, and E2 refocuses the work on the real page with the brain stopped, before and after a reload.

## Hygiene and tests

**Hygiene:** no state at module level, since the game may or may not reuse a module (architecture R10); time from `Date.now()` and randomness from `Math.random()` only, both virtual in the simulator (R11).

**Tests:** `packages/brain/test/agent.test.ts` (the connection and lifecycle) and `snapshots.test.ts` (the tiers, a full home, workers that crash, hang or report late, a reload) run the built Agent and its workers in the simulator against the brain's real `ControlChannel`, on the lockstep driver, in virtual time. They live in `brain` because they need both sides, and `ingame` doesn't depend on the brain. `ingame` exports its build (`@bitburner-agent/ingame/build`) for them.
