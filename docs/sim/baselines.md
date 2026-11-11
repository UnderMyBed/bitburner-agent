# Baselines

What the agent has to beat. The legacy fork, played headless from a BitNode start a player can reach, sets the bar. Both are compared at fixed checkpoints, since a full run to a destroy costs hours per seed ([ADR 0011](../decisions/0011-checkpointed-simulator-comparisons.md)). M1 records the fork's progress at each checkpoint, and M4 phase B's exit criterion needed the agent to be at least as far along at every one ([owner decision 65](../decisions/owner-decisions.md) says what that means: [the brain against the fork](#the-brain-against-the-fork); [architecture §12.3](../architecture.md#123-migration-from-the-fork-strangler-pattern), [§13](../architecture.md#13-milestones)), until owner decision 67 (#337) retired that gate as the progress measure: the brain is ahead by multiples, so progress is the online hours to the destroy for each BitNode, and the comparison stays as a record. The baseline is deterministic: on the same code and Node version, every seed ends in the same state. So it runs only when something it runs on has changed since its last run, and at M4 phase B ([releasing](../releasing.md), step 2; owner decision 32). Each run adds rows below. Across Node majors it isn't deterministic, because their V8s sort differently ([#282](https://github.com/UnderMyBed/bitburner-agent/issues/282)), so it runs only on the repo's pinned Node major, `.node-version` (26).

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

It runs only on the repo's pinned Node major (`.node-version`): on another, it exits 2 before building anything, saying so. In a clone, the repo's `mise.toml` selects that Node for mise users ([setup](../setup.md#before-you-start)).

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
- **614978a (the 1.0.0 release, M4 phase A, the fifth and sixth runs):** none; all 8 seeds reached 12 hours, on Node 26.13.0 and on 24.22.1.
- **5238ab6 (the Node 26 pin, [#301](https://github.com/UnderMyBed/bitburner-agent/issues/301), the seventh run):** none; all 8 seeds reached 12 hours.
- **Before the first run**, attempts to run the baseline to a destroy found four problems in the simulator, all fixed before it ([#33](https://github.com/UnderMyBed/bitburner-agent/issues/33) has the detail):
  - [#73](https://github.com/UnderMyBed/bitburner-agent/issues/73): results depended on when garbage collection ran, through the game's module cache.
  - [#74](https://github.com/UnderMyBed/bitburner-agent/issues/74): the virtual clock's cost grew with the timers pending, so tens of thousands of scripts slowed it to a crawl.
  - [#75](https://github.com/UnderMyBed/bitburner-agent/issues/75): the CLI had no real-time limit or heap cap, so a slow seed held the machine for hours.
  - [#80](https://github.com/UnderMyBed/bitburner-agent/issues/80): timers didn't clamp and nest as Steam's Chromium does.

  The cost that remained, single-digit speed once the fork runs tens of thousands of scripts, isn't a defect: it's why the baseline stops at 12 hours ([ADR 0011](../decisions/0011-checkpointed-simulator-comparisons.md)).

## The brain against the fork

Our brain, measured where the fork is ([#319](https://github.com/UnderMyBed/bitburner-agent/issues/319)), and judged by [owner decision 65](../decisions/owner-decisions.md), Q10's answer ([#83](https://github.com/UnderMyBed/bitburner-agent/issues/83)):
- **The start:** the same as the baseline's, `baselineScenario()`'s fixture: BN1 with SF1.1 and SF4.3 (BN1.2, home at 32 GB), on the same seeds and epoch.
- **The play:** the brain plays with its rules as on Steam, but through the simulator's own effectors, not the Singularity workers SF4.3 would give it on Steam. So the Singularity workers' RAM on home isn't spent.
- **The readings:** the same summary as the baseline's checkpoints, at the same virtual times, on Node 26.13.0, the pin these rows compare with. Each run polls every virtual minute and goes on to a destroy, or to 16 virtual hours.
- **The seeds:** seeds 1 and 2 ran to their destroys. Seeds 3 and 4 were stopped part-way, when the owner stopped the long simulator runs (2026-11-09). Their 4 h and 8 h readings are kept, marked "stopped". Decision 65 settles it at seeds 1–2: the lead is a multiple, so more seeds run only if a gated measure comes within 25% of the fork's. A seed costs about 2 real hours to a destroy.

How to run it: [the brain README](../../packages/brain/README.md#the-brain-against-the-fork). Each row's columns are as [above](#what-a-row-records), with three differences:
- **The heap** isn't measured: the game runs in a child process.
- **Reached** counts the seeds that read the checkpoint in BN1.2, and names those destroyed before it and the stopped seeds that didn't get there. Speed and real time are over the runs that ended, since a stopped run's are cut short.
- **Seeds** reproduce the rows with `BRAIN_CHECKPOINTS_SEEDS`, which takes `a..b` as `--seeds` does, one seed a run.

Speed and real time aren't comparable with the fork's: the brain's game runs on the lockstep driver ([ADR 0012](../decisions/0012-simulator-network-in-lockstep.md)), and these runs shared the machine, three heavy runs at once. Two of the brain's seeds ran at once, each under its own 3-hour kill, within the owner's limit of three. [ADR 0011](../decisions/0011-checkpointed-simulator-comparisons.md) said one at a time, and decision 65 amends it.

**The verdict** in the per-seed table is decision 65's gate, per seed against the fork's same seed at the same checkpoint:
- **Ahead:** augmentations installed and home RAM each at least the fork's, and the highest hacking level the brain has read in the BitNode by then (its peak, over every poll) at least the fork's level at the checkpoint.
- **Destroyed:** the brain destroyed the BitNode before the checkpoint, so it's ahead on every measure.
- **Money** is shown, not gated.

The peak is lenient toward the brain: an install drops its level to 1, while the fork's level is the one read at the checkpoint, dip or not. Seeds 1–4 ran before the runner kept the peak, so theirs come from their 10-minute progress lines and the checkpoint's own reading. That's a lower bound, and for every one of them it's the checkpoint's own reading.

**The first run (seeds 1–4: 1–3 at e077960, 4 at 1a46031), against the fork's 5238ab6 rows on the same Node.** The brain's game is the same at both commits; between them only the test file and docs changed. Seed 3's run printed `e077960-dirty` (docs only), recorded as `e077960`. These four runs predate the runner writing its own metadata: each `seed-<n>.json`'s `meta` (date, commit, rig, Node) was added afterwards from the run's log and the commit times.

| Date | Commit | Rig | Node | Seeds | At | Reached | Money | Hacking | Augs | Home RAM | Heap | Speed | Real time per seed |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-11-08 | 5238ab6 (the fork) | amd-ryzen-7-9800x3d-16c-62g | v26.13.0 | 1..8 | 4 h | 8/8 | $61.7m ($17.6m–$1.27b) | 238 (210–279) | 6 | 64 GB | 83 MB | 118x | 6 min |
| 2026-11-08 | 5238ab6 (the fork) | amd-ryzen-7-9800x3d-16c-62g | v26.13.0 | 1..8 | 8 h | 8/8 | $1.69b ($1.2m–$6.9b) | 341 (259–374) | 11 | 128 GB | 86 MB | 118x | 6 min |
| 2026-11-08 | 5238ab6 (the fork) | amd-ryzen-7-9800x3d-16c-62g | v26.13.0 | 1..8 | 12 h | 8/8 | $14.6b ($9.06m–$1.11t) | 493 (208–662) | 15 | 2048 GB | 90 MB | 118x | 6 min |
| 2026-11-09 | e077960 + 1a46031 (the brain) | amd-ryzen-7-9800x3d-16c-62g | v26.13.0 | 1..4 | 4 h | 4/4 | $230t ($150t–$285t) | 1010 (1009–1022) | 10 | 1048576 GB | - | 6x | 103 min |
| 2026-11-09 | e077960 + 1a46031 (the brain) | amd-ryzen-7-9800x3d-16c-62g | v26.13.0 | 1..4 | 8 h | 3/4, stopped before it: 4 | $11q ($9.77q–$21.2q) | 1544 (1528–1559) | 21 | 16777216 GB | - | 6x | 103 min |
| 2026-11-09 | e077960 + 1a46031 (the brain) | amd-ryzen-7-9800x3d-16c-62g | v26.13.0 | 1..4 | 12 h | 0/4, 2 destroyed before it, stopped before it: 3, 4 | - | - | - | - | - | 6x | 103 min |

**Each seed against the fork's same seed.** The fork's per-seed values are its run's JSON, kept as `FORK_AT_CHECKPOINTS` in `packages/brain/test/helpers/checkpoints.ts`.

| Seed | At | Brain | Fork | Verdict |
|---|---|---|---|---|
| 1 | 4 h | $262t, hacking 1009, 10 augs, 1048576 GB, peak hacking 1009 | $54.6m, hacking 238, 6 augs, 128 GB | ahead |
| 1 | 8 h | $11q, hacking 1544, 21 augs, 16777216 GB, peak hacking 1544 | $105m, hacking 285, 11 augs, 128 GB | ahead |
| 1 | 12 h | destroyed at 10 h 59 min | $27.9b, hacking 491, 14 augs, 2048 GB | destroyed |
| 2 | 4 h | $150t, hacking 1010, 10 augs, 1048576 GB, peak hacking 1010 | $1.27b, hacking 279, 6 augs, 128 GB | ahead |
| 2 | 8 h | $21.2q, hacking 1528, 21 augs, 16777216 GB, peak hacking 1528 | $6.9b, hacking 374, 11 augs, 128 GB | ahead |
| 2 | 12 h | destroyed at 11 h 09 min | $1.11t, hacking 662, 16 augs, 32768 GB | destroyed |
| 3 (stopped) | 4 h | $285t, hacking 1022, 10 augs, 1048576 GB, peak hacking 1022 | $61.7m, hacking 246, 6 augs, 128 GB | ahead |
| 3 (stopped) | 8 h | $9.77q, hacking 1559, 21 augs, 16777216 GB, peak hacking 1559 | $2.91b, hacking 351, 11 augs, 128 GB | ahead |
| 4 (stopped) | 4 h | $230t, hacking 1017, 10 augs, 1048576 GB, peak hacking 1017 | $202m, hacking 244, 6 augs, 128 GB | ahead |

Seed 3 was stopped at 9 h 22 min virtual and seed 4 at 6 h 42 min, neither having destroyed.

**Reading it:**
- **On every seed the brain is ahead of the fork's same seed on every measure, at every checkpoint it reached.**
  - **At 4 h:** hacking 1009–1022 against the same seeds' 238–279 (3.6× to 4.2×), 10 augmentations against 6, and home 1 PB against 128 GB.
  - **At 8 h:** hacking 1528–1559 against 285–374 (4.1× to 5.4×), 21 augmentations against 11, and home 16 PB against 128 GB.
- **Seeds 1 and 2 destroyed BN1.2 before 12 h,** at 10 h 59 min and 11 h 09 min, into BN1.3 with SF1.2. That's the autonomous BN1→destroy in the simulator that [architecture §13](../architecture.md#13-milestones) asks for, run in full. Live, run #3 destroyed BN1.2 in 11 h 17 min. The fork destroys by 12 h on no seed. The time is the first poll after the game entered BN1.3, not the moment w0r1d_d43m0n was hacked, so it can be up to a minute late.
- **Every reading of "as far along" that can be measured now agrees, on these seeds:** per seed or medians, one measure or all four, money gated or not, the checkpoint's own hacking level or the peak. The progress score #83 also lists, the fast model's estimated time to a destroy, can't be computed yet (#13).
- **Installs and the hacking level:**
  - Seed 1 installs at about 40, 100, 180, 250, 380, 500, 520 and 560 minutes: every 1–2 hours, and closer near the end. Seed 2's are much the same.
  - Each install drops the level to 1, and it's back past the fork's 4 h level within 10–20 minutes.
  - Seeds 1 and 2's 4 h and 8 h readings came within about 20 minutes before an install, so on another seed a checkpoint can land in the dip. That's why decision 65 gates on the peak.
  - Augmentations installed and home RAM don't drop within a BitNode.
- **The open risk** (decision 65): a planner that installs later than the fork could fall behind on augmentations installed while being further along overall. Phase A's brain installs earlier and more often than the fork, so these seeds can't show it.

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

Reading the fifth run (614978a on Node 26.13.0, the 1.0.0 release, M4 phase A, [#276](https://github.com/UnderMyBed/bitburner-agent/issues/276#issuecomment-6703331699)): it ran because the simulator's engine build and bundle, its host and `packages/core` changed (#172, #267, and phase A's slices), and because the machine's Node moved from 24.22.1 to 26.13.0. **All 8 seeds reached 12 hours**, in about 57 real minutes, at a median 103× real time. **Every seed's final state hash differs from the earlier runs'**, which had matched the first run's through 7990834, so the game columns moved:
- **4 h:** money $61.7m against $202m; hacking 238 (210–279) against 242, the same 6 augmentations and 64 GB.
- **8 h:** money $1.69b against $2.04b; hacking 341 (259–374) against 323, the same 11 augmentations and 128 GB.
- **12 h:** money $14.6b against $2.59b; hacking 493 (208–662) against 411, 15 augmentations against 14, home 2048 GB against 512 GB.
- **The heap is about 28–30 MB lower** at every checkpoint (83, 86 and 90 MB against 113, 116 and 118 MB), as the [benchmarks](benchmarks.md)' Node 26 row is. Seed 2 was the exception at 12 h, at 134 MB, and the slowest seed, at 631 s.

The legacy fork's scripts didn't change, so the shift came from the Node bump, the simulator's changes, or both. The sixth run separates them.

Reading the sixth run (614978a on Node 24.22.1, the 1.0.0 release, [#276](https://github.com/UnderMyBed/bitburner-agent/issues/276#issuecomment-6704388377)): the same commit, rerun on the Node the earlier runs used. **All 8 seeds reached 12 hours**, at a median 106× real time. **The game columns are identical to 7990834's at every checkpoint** (money, hacking, augmentations and home RAM), and so is the heap (113, 116 and 118 MB); seed 3 again went furthest, to 162 MB, and was the slowest, at 667 s. So the simulator's changes since 7990834 don't move the fork's game, and **the fifth run's shift is Node 26's alone** ([#282](https://github.com/UnderMyBed/bitburner-agent/issues/282), which also covers the machine's global mise config overriding the repo's `.node-version`). **M4 phase B then compared with the baseline on the pinned Node 24** (CI's, `.node-version`, until the seventh run below): with these rows, not the fifth run's. The run printed its rows as `614978a-dirty`; they're recorded as `614978a`, since the only uncommitted change was the benchmarks row, a docs file the simulator doesn't load.

**Why Node 26's game differs** ([#282](https://github.com/UnderMyBed/bitburner-agent/issues/282)). The fork's IPvGO script sorts its moves with a random comparator (`() => Math.random() - Math.random()`, `packages/legacy/fork/go.js:1352-1353`), and V8 14.6 (Node 26) calls a comparator a different number of times than V8 13.6 (Node 24) on arrays of 3 to 7 elements. So the script draws `Math.random` a different number of times, and the seeded game diverges from there: on seed 1, first between 2 h 40 min 10 s and 2 h 40 min 15 s. With one plain merge sort in place of V8's on both Nodes, all 8 seeds' state hashes matched at every virtual hour to 12 (96 of 96), so the sort is the only cause the baseline reaches ([parity](parity.md) 4.17). The baseline, bench and sim scripts now refuse any Node major but the pinned one.

Reading the seventh run (5238ab6 on Node 26.13.0, the pin's move to Node 26, [#301](https://github.com/UnderMyBed/bitburner-agent/issues/301)): the owner moved the repo's pinned Node from 24 to 26 (2026-11-07), because Node 26's V8, 14.6, should be the one in Steam's Electron 41 (Chromium 146; inferred, [parity](parity.md) 4.17), so on 26 the fork's sorts match Steam's. The run is the first on the new pin. **All 8 seeds reached 12 hours**, in about 52 real minutes, at a median 118× real time; the slowest seed was seed 2, at 642 s. **Every seed's final state hash equals the fifth run's** (614978a on the same Node 26.13.0), so the game columns are identical at every checkpoint, and so is the heap (83, 86 and 90 MB; seed 2 again reached 135 MB at 12 h). That's what the sixth run predicted: the simulator's changes since 7990834 don't move the fork's game, so on one Node the game is the same, and the fifth run's shift from the earlier rows is the Node's alone. Since 614978a, [releasing](../releasing.md) step 2's check lists the Node check #282 added (`node-version.ts`, called first by the sim, baseline and bench scripts), the bench's comparison by Node major, `packages/core`'s `batcher.ts` and `index.ts` (the simulator loads only `PINNED_GAME` from core), and the lockfile's `@types/node` and `engines`: none reaches the simulated game, as the equal hashes confirm. The speed, 118× against the fifth run's 103×, isn't a speed check ([the benchmarks](benchmarks.md) are). **M4 phase B now compares with the baseline on Node 26, with these rows**, not the sixth run's Node 24 rows, which stay as the record of the old pin.

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
| 2026-11-07 | 614978a | amd-ryzen-7-9800x3d-16c-62g | v26.13.0 | 1..8 | 4 h | 8/8 | $61.7m ($17.6m–$1.27b) | 238 (210–279) | 6 | 64 GB | 83 MB | 103x | 6 min |
| 2026-11-07 | 614978a | amd-ryzen-7-9800x3d-16c-62g | v26.13.0 | 1..8 | 8 h | 8/8 | $1.69b ($1.2m–$6.9b) | 341 (259–374) | 11 | 128 GB | 86 MB | 103x | 6 min |
| 2026-11-07 | 614978a | amd-ryzen-7-9800x3d-16c-62g | v26.13.0 | 1..8 | 12 h | 8/8 | $14.6b ($9.06m–$1.11t) | 493 (208–662) | 15 | 2048 GB | 90 MB | 103x | 6 min |
| 2026-11-07 | 614978a | amd-ryzen-7-9800x3d-16c-62g | v24.22.1 | 1..8 | 4 h | 8/8 | $202m ($1.41m–$1.15b) | 242 (163–285) | 6 | 64 GB | 113 MB | 106x | 7 min |
| 2026-11-07 | 614978a | amd-ryzen-7-9800x3d-16c-62g | v24.22.1 | 1..8 | 8 h | 8/8 | $2.04b ($8.81m–$3.05b) | 323 (254–356) | 11 | 128 GB | 116 MB | 106x | 7 min |
| 2026-11-07 | 614978a | amd-ryzen-7-9800x3d-16c-62g | v24.22.1 | 1..8 | 12 h | 8/8 | $2.59b ($1.09b–$1.89t) | 411 (344–723) | 14 | 512 GB | 118 MB | 106x | 7 min |
| 2026-11-08 | 5238ab6 | amd-ryzen-7-9800x3d-16c-62g | v26.13.0 | 1..8 | 4 h | 8/8 | $61.7m ($17.6m–$1.27b) | 238 (210–279) | 6 | 64 GB | 83 MB | 118x | 6 min |
| 2026-11-08 | 5238ab6 | amd-ryzen-7-9800x3d-16c-62g | v26.13.0 | 1..8 | 8 h | 8/8 | $1.69b ($1.2m–$6.9b) | 341 (259–374) | 11 | 128 GB | 86 MB | 118x | 6 min |
| 2026-11-08 | 5238ab6 | amd-ryzen-7-9800x3d-16c-62g | v26.13.0 | 1..8 | 12 h | 8/8 | $14.6b ($9.06m–$1.11t) | 493 (208–662) | 15 | 2048 GB | 90 MB | 118x | 6 min |
