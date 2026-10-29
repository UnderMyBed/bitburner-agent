# Baselines

What the agent has to beat. The legacy fork, played headless from a BitNode start a player can reach, sets the bar. Both are compared at fixed checkpoints, since a full run to a destroy costs hours per seed ([ADR 0011](../decisions/0011-checkpointed-simulator-comparisons.md)). M1 records the fork's progress at each checkpoint, and the M4 exit criterion needs the agent to be at least as far along at every one ([architecture §12.3](../architecture.md#123-migration-from-the-fork-strangler-pattern), [§13](../architecture.md#13-milestones)). The baseline is deterministic: on the same code and Node version, every seed ends in the same state. So it runs only when something it runs on has changed since its last run, and at M4 ([releasing](../releasing.md), step 2; owner decision 32). Each run adds rows below.

## The BN1 baseline

`baselineScenario()` from `@bitburner-agent/legacy` ([README](../../packages/legacy/README.md#the-baseline), [owner decisions log](../decisions/owner-decisions.md) #28, #29):
- **Start:** BN1 with SF1.1 and SF4.3, the least a player can hold along with SF4.3 (earning SF4 means destroying BN1 first). The game makes it BN1.2. SF1 starts home at 32 GB of RAM (`Prestige.ts:248-249`), more than the 16 GB the fork needs to run unattended, and SF4.3 lets it use Singularity at no extra RAM cost.
- **Play:** the fork's game files on home, and `autopilot.js --disable-casino`, as a player starts it. The casino is off because `casino.js` plays through the game's page, which a headless run doesn't have.
- **Checkpoints:** 4, 8 and 12 virtual hours (`CHECKPOINTS_MS`). A seed passes if it gets to 12 hours without failing. There's no stop condition: the fork doesn't destroy BN1 that early.
- **Seeds:** 1–8, each in its own simulation.

## Why checkpoints, and why 12 hours

The simulator runs the real game, so it pays for the game's real work ([ADR 0011](../decisions/0011-checkpointed-simulator-comparisons.md)). Measured on seed 1 (reference rig):
- **To about 2 virtual hours:** 600–830× real time.
- **From then to about 14 hours:** about 100×, held there by the fork's constant IPvGO play. The game paces Go moves with virtual-time sleeps, which cost nothing here, while each move's CPU work is real.
- **From about 15 hours:** the fork has the RAM to run tens of thousands of batch scripts (28,339 at 16 h), and the speed falls to single digits (7× at 16 h). Most of that is the game's own work per script on every cycle ([benchmarks](benchmarks.md#scaling-with-running-scripts)).

So 12 virtual hours take about 6 real minutes per seed (54 minutes for all 8, in the first run below), and a full run to a destroy takes hours.

## Running it

```
npm run baseline -w @bitburner-agent/legacy [-- --seeds a..b | a,b,c] [--workers k] [--wall-limit minutes] [--max-heap MB] [--json out.json]
```

While it runs, it prints a progress line per seed at each checkpoint, on stderr: virtual and real time so far, speed, scripts, money and hacking level. At the end it prints:
- the scenario table, one row per seed ([scenarios](scenarios.md));
- each seed's heap at the start and at each checkpoint, after a full collection;
- the run's rows for the results table below, one per checkpoint.

`--json` paths are relative to where you ran npm. The command exits 0 if every seed reached 12 hours, 1 if any didn't, and 2 if it couldn't run. What the rows need (the commit, the rig's name, the `--json` folder) is checked before the run, and the JSON is written as soon as the run ends, so a late error can't lose a run.

By default ([#75](https://github.com/UnderMyBed/bitburner-agent/issues/75)):
- **One seed at a time** (`--workers` changes it).
- **A hard limit of 60 minutes of real time per seed** (`--wall-limit`, in minutes). A seed should take a few minutes, so one that hits the limit has gone wrong. The command kills its simulation, even part-way through, and the seed fails with "wall limit: …", keeping the checkpoints it reached.
- **A 2 GB heap per simulation** (`--max-heap`, in MB). V8 grows its heap toward its limit before collecting, so without a cap a long run holds far more memory than it uses ([scenarios](scenarios.md#the-cli)).

## What a row records

One row per checkpoint, so three per run.

| Column | What |
|---|---|
| Date | UTC, the day of the run |
| Commit, Node | The commit run, with "-dirty" if the working tree had changes, and the Node version |
| Rig | The machine, as [benchmarks](benchmarks.md#regressions) name it: `BENCH_RIG` if set, otherwise its CPU model, logical CPU count and memory |
| Seeds | The seeds run, as `--seeds` takes them: `npm run baseline -w @bitburner-agent/legacy -- --seeds <Seeds>` at the commit reproduces the rows (the simulator is deterministic) |
| At | The checkpoint: 4, 8 or 12 virtual hours |
| Reached | Seeds that reached it, of those run |
| Money | Money in hand: the median (min–max) over the seeds that reached it |
| Hacking | Hacking level: the median (min–max) |
| Augs | Augmentations installed: the median |
| Home RAM | The median |
| Heap | The simulator's heap after a full collection, the median: the check for leaks that grow with each new script module, which the benchmarks' lean run can't see ([#64](https://github.com/UnderMyBed/bitburner-agent/issues/64)). Some growth is expected: the simulator keeps one module per distinct script source compiled ([#73](https://github.com/UnderMyBed/bitburner-agent/issues/73)) |
| Speed | Virtual time per real time over the whole run, the median over the seeds that didn't fail (`ok`: no crash, refused script or request, recovery mode, stopped loop, or wall limit), measured with heap sampling on. The same on each of the run's rows |
| Real time per seed | The whole run's real time, the median over the seeds that didn't fail, as for Speed. The same on each of the run's rows: it isn't the time to reach that checkpoint |

Reached counts every seed that got to the checkpoint, including one that failed later, so the 12 h row's Reached can be higher than the pass rate; the CLI's `passed:` line gives that. Medians of an even count take the lower middle value, as the scenario aggregate does. Money in hand is a snapshot: the fork spends it on augmentations and RAM, so read it with the augmentations and home RAM beside it. The command prints the rows: paste them at the end of the table, and explain any failed seed below.

## Failures

Every seed that didn't pass is explained here, per run: what stopped it, and whether the fork, the simulator or the scenario was at fault, with an issue where it's ours to fix.

- **4799701 (the first run):** none; all 8 seeds reached 12 hours.
- **3cf08f9 (the M1 release):** none; all 8 seeds reached 12 hours.
- **58f0c4d (M2's run):** none; all 8 seeds reached 12 hours.
- **7990834 (M3's run):** none; all 8 seeds reached 12 hours.
- **Before the first run**, attempts to run the baseline to a destroy found four problems in the simulator, all fixed before it ([#33](https://github.com/UnderMyBed/bitburner-agent/issues/33) has the detail):
  - [#73](https://github.com/UnderMyBed/bitburner-agent/issues/73): results depended on when garbage collection ran, through the game's module cache.
  - [#74](https://github.com/UnderMyBed/bitburner-agent/issues/74): the virtual clock's cost grew with the timers pending, so tens of thousands of scripts slowed it to a crawl.
  - [#75](https://github.com/UnderMyBed/bitburner-agent/issues/75): the CLI had no real-time limit or heap cap, so a slow seed held the machine for hours.
  - [#80](https://github.com/UnderMyBed/bitburner-agent/issues/80): timers didn't clamp and nest as Steam's Chromium does.

  The cost that remained, single-digit speed once the fork runs tens of thousands of scripts, isn't a defect: it's why the baseline stops at 12 hours ([ADR 0011](../decisions/0011-checkpointed-simulator-comparisons.md)).

## Results

The reference rig is the owner's machine. Rows are appended at the end of this file, so keep the results table last.

Reading the first run (4799701, the reference rig):
- **All 8 seeds reached 12 hours** (`passed: 8/8`), in 54 real minutes in all: about 6 minutes a seed, at a median 117× real time.
- **The fork's progress, median (range):**
  - **4 h:** hacking 242 (163–285), 6 augmentations installed, home 64 GB.
  - **8 h:** hacking 323 (254–356), 11 augmentations, 128 GB.
  - **12 h:** hacking 411 (344–723), 14 augmentations, 512 GB.
  Money swings with each reset and purchase, so it's the least telling column.
- **The heap grows about 9 MB over 12 hours** (106 MB at the start, from the CLI's heap table, to 115 MB, median), which the modules the fork compiles account for. Seed 3 was the exception: it got furthest (hacking 723, $1.89t at 12 h), was already running heavy batches, and reached 159 MB. It was also the slowest seed, at 10 minutes.

Reading the second run (3cf08f9, the M1 release, [#44](https://github.com/UnderMyBed/bitburner-agent/issues/44)): every seed's final state hash equals the first run's, so the game columns are identical. Only the speed moved (117× to 116×), which is noise.

Reading the third run (58f0c4d, M2's run, [#100](https://github.com/UnderMyBed/bitburner-agent/issues/100)): every seed's final state hash again equals the first run's, so the game columns are identical. The speed is 118×, and the heap is 1–2 MB higher at each checkpoint. M2's candidate then moved on to 201e133. From 58f0c4d to 201e133, releasing step 2's check lists only `packages/core/src/game-version.ts`, which the simulator reads only for an unchanged constant, so the baseline didn't run again (releasing step 2, owner decision 32).

Reading the fourth run (7990834, M3's run, [#140](https://github.com/UnderMyBed/bitburner-agent/issues/140#issuecomment-6477585240)): M3 changed the simulator's engine build and bundle and `packages/core`, so it ran. It ran first on M3's first candidate, fa9c5dc, and again after #155 (company promotions) moved the candidate to 7990834; every seed's final state hash was the same both times. The game columns are identical to 58f0c4d's at every checkpoint: M3's changes didn't change what the fork's game does. The speed, 102×, isn't comparable: this run shared the machine with E2 and the workloads, three runs at once ([the benchmarks](benchmarks.md), run alone, are the speed check). The heap is 118 MB at 12 h (median), and seed 3 again went furthest, to 161 MB. M3's candidate then moved on to 33ec5d6 ([#184](https://github.com/UnderMyBed/bitburner-agent/issues/184), [#185](https://github.com/UnderMyBed/bitburner-agent/issues/185), [#187](https://github.com/UnderMyBed/bitburner-agent/issues/187)). From 7990834 to 33ec5d6, releasing step 2's check lists only `packages/core`'s `control-protocol.ts`, `hack-loop.ts` and `index.ts`, and the simulator loads only `PINNED_GAME` from core (`packages/sim/src/engine/build.ts`), so the baseline didn't run again: 7990834's rows stand for 33ec5d6 (releasing step 2, owner decision 32).

| Date | Commit | Rig | Node | Seeds | At | Reached | Money | Hacking | Augs | Home RAM | Heap | Speed | Real time per seed |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-10-25 | 4799701 | amd-ryzen-7-9800x3d-16c-62g | v24.22.1 | 1..8 | 4 h | 8/8 | $202m ($1.41m–$1.15b) | 242 (163–285) | 6 | 64 GB | 111 MB | 117x | 6 min |
| 2026-10-25 | 4799701 | amd-ryzen-7-9800x3d-16c-62g | v24.22.1 | 1..8 | 8 h | 8/8 | $2.04b ($8.81m–$3.05b) | 323 (254–356) | 11 | 128 GB | 113 MB | 117x | 6 min |
| 2026-10-25 | 4799701 | amd-ryzen-7-9800x3d-16c-62g | v24.22.1 | 1..8 | 12 h | 8/8 | $2.59b ($1.09b–$1.89t) | 411 (344–723) | 14 | 512 GB | 115 MB | 117x | 6 min |
| 2026-10-26 | 3cf08f9 | amd-ryzen-7-9800x3d-16c-62g | v24.22.1 | 1..8 | 4 h | 8/8 | $202m ($1.41m–$1.15b) | 242 (163–285) | 6 | 64 GB | 111 MB | 116x | 6 min |
| 2026-10-26 | 3cf08f9 | amd-ryzen-7-9800x3d-16c-62g | v24.22.1 | 1..8 | 8 h | 8/8 | $2.04b ($8.81m–$3.05b) | 323 (254–356) | 11 | 128 GB | 113 MB | 116x | 6 min |
| 2026-10-26 | 3cf08f9 | amd-ryzen-7-9800x3d-16c-62g | v24.22.1 | 1..8 | 12 h | 8/8 | $2.59b ($1.09b–$1.89t) | 411 (344–723) | 14 | 512 GB | 115 MB | 116x | 6 min |
| 2026-10-27 | 58f0c4d | amd-ryzen-7-9800x3d-16c-62g | v24.22.1 | 1..8 | 4 h | 8/8 | $202m ($1.41m–$1.15b) | 242 (163–285) | 6 | 64 GB | 112 MB | 118x | 6 min |
| 2026-10-27 | 58f0c4d | amd-ryzen-7-9800x3d-16c-62g | v24.22.1 | 1..8 | 8 h | 8/8 | $2.04b ($8.81m–$3.05b) | 323 (254–356) | 11 | 128 GB | 114 MB | 118x | 6 min |
| 2026-10-27 | 58f0c4d | amd-ryzen-7-9800x3d-16c-62g | v24.22.1 | 1..8 | 12 h | 8/8 | $2.59b ($1.09b–$1.89t) | 411 (344–723) | 14 | 512 GB | 117 MB | 118x | 6 min |
| 2026-10-28 | 7990834 | amd-ryzen-7-9800x3d-16c-62g | v24.22.1 | 1..8 | 4 h | 8/8 | $202m ($1.41m–$1.15b) | 242 (163–285) | 6 | 64 GB | 113 MB | 102x | 7 min |
| 2026-10-28 | 7990834 | amd-ryzen-7-9800x3d-16c-62g | v24.22.1 | 1..8 | 8 h | 8/8 | $2.04b ($8.81m–$3.05b) | 323 (254–356) | 11 | 128 GB | 116 MB | 102x | 7 min |
| 2026-10-28 | 7990834 | amd-ryzen-7-9800x3d-16c-62g | v24.22.1 | 1..8 | 12 h | 8/8 | $2.59b ($1.09b–$1.89t) | 411 (344–723) | 14 | 512 GB | 118 MB | 102x | 7 min |
