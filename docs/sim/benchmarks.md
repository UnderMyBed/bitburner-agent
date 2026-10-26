# Simulator benchmarks

How fast the simulator runs and whether its memory stays flat, measured on each release ([releasing](../releasing.md), step 2). The M1 target is at least 1000× real time on the lean workload ([architecture §13](../architecture.md#13-milestones)).

## Running it

```
npm run bench -w @bitburner-agent/sim                  # measure, append a row below, flag regressions
npm run bench -w @bitburner-agent/sim -- --dry-run     # measure and print the row, without recording it
npm run bench -w @bitburner-agent/sim -- --accept      # record the row even if it regressed
npm run bench -w @bitburner-agent/sim -- --profile lean [--out lean.cpuprofile]
```

It takes a few minutes and isn't part of CI: CI machines vary too much for the numbers to mean anything. Close other heavy programs first.

## What it measures

- **Speed** for each workload in [`packages/sim/scenarios/`](../../packages/sim/scenarios/) ([scenarios](scenarios.md)). Every seed the scenario lists runs, one simulation at a time. The row records the median of their speeds: with an even number of seeds, the lower middle value, as the scenario runner's aggregate takes it. Speed is virtual ms per real ms, booting and setup excluded.

  | Workload | What it runs |
  |---|---|
  | lean | one 3-thread hack loop on n00dles: the M1 target |
  | batch | a controller `exec()`ing short-lived workers of up to 20 threads, one every 200 ms |
  | churn | the same controller `exec()`ing 125 one-thread workers a second, thousands running at once: the heavy script-churn class |
  | copies | 100 copies of the hack loop, each its own module |

- **Heap** over a long lean run: seed 1, 7 virtual days.
  - The host's V8 heap is sampled after a full garbage collection when the scripts start, then at the end of each virtual day.
  - The row shows the first and last samples, and the growth per day: the median day-to-day change from day 1 on. The first day is left out because it's mostly warm-up.
  - A one-off step, such as a cache emptying once, doesn't move the median. A leak moves every day's change, so it does.
  - Lean runs a fixed set of scripts, so this catches leaks in the game's loop and in running scripts. Leaks that grow with each new script module show in the legacy fork's run, which compiles temp scripts all the time: the [baseline](baselines.md) samples its heap the same way, after a full collection, at each of its checkpoints, on each release ([#64](https://github.com/UnderMyBed/bitburner-agent/issues/64)). Its rows record the median at each checkpoint rather than a growth per day: read them against the earlier rows from the same rig. Some growth there is expected: the simulator keeps one module per distinct script source it compiles ([#73](https://github.com/UnderMyBed/bitburner-agent/issues/73)), so only growth beyond that counts as a leak.

The legacy fork isn't one of these workloads: it lives in `@bitburner-agent/legacy`, which builds on the simulator, and a benchmark of it here would make the simulator depend on it. Its speed and heap are recorded in the [baseline](baselines.md)'s rows instead.

Measurements come from inside the simulation's host process (`Simulation.diagnostics.heap()` and `.profile()`), not the process running the benchmark.

## Regressions

A row is compared only with the last row from the same **rig**. The rig is the machine, named by `BENCH_RIG` if set, otherwise by its CPU model, logical CPU count and memory. Set `BENCH_RIG` to keep one name if those details shift, for example memory reported a little differently after a driver update. The run says when it found no earlier row from its rig to compare with.

These count as a regression:
- a workload more than 20% slower;
- heap growth per day more than 20% higher than before, when it's also over 1 MB a day.

A regressed run prints what regressed, exits 1 and **doesn't record its row**, so the last good row stays the baseline. Then:
1. Re-run it to rule out noise, for example another program using the CPU.
2. Find the cause: profile the workload and compare with a profile from the previous commit.
3. Fix it, or, if it's accepted (for example a game bump that does more work), say why on the release's review issue. Then record it with `--accept`, and it becomes the new baseline.

Exit codes: 0 nothing regressed, 1 something did, 2 it couldn't run.

## Profiling

`--profile <workload>` runs the workload's first seed once, with a CPU profile of the host covering the run (setup excluded). It writes the profile to `.reports/<workload>.cpuprofile` (gitignored), or to `--out`, relative to where you ran npm. Open the profile in Chrome DevTools' Performance panel or in VS Code. It also prints the 15 functions with the most self time: time spent in the function itself, not in what it calls, with each sample's time running to the next sample, as DevTools counts it. It doesn't record a row.

## Scaling with running scripts

Each running script that sleeps is a pending timer in the virtual clock. Until [#74](https://github.com/UnderMyBed/bitburner-agent/issues/74), once a step's due timers had fired, the earliest timer left was past the range, and fake-timers then scanned every pending timer to find nothing, twice. So the clock's share of each step grew with the timers pending, and its share of a run with the square of the scripts running. The legacy fork's baseline fell to 3–6× real time with about 23,000 to 144,000 scripts. The clock now skips that scan ([`clock.ts`](../../packages/sim/src/host/clock.ts), `skipEmptyTimerScans`). Its cost per step no longer grows in proportion to the timers pending ([`clock.test.ts`](../../packages/sim/test/clock.test.ts) checks it with 20,000). With the patch on or off the results are the same, and the golden state hashes are unchanged: the two agree while no delay reaches fake-timers as NaN, which the host ensures ([#80](https://github.com/UnderMyBed/bitburner-agent/issues/80)).

Measured on the reference rig in the same commit (343c05b), with the patch switched off by a local edit, then on. The first four rows are `--dry-run`'s median over each workload's seeds 1–4. The last is seed 1 of churn with `homeRamGb: 65536` and `ctl.js` args `[1, 125]` (625 workers a second), for 10 virtual minutes:

| Workload | What runs | Off | On |
|---|---|---|---|
| lean | one script | 26,341× | 26,634× |
| copies | 100 scripts | 9,574× | 12,040× |
| batch | short-lived workers of up to 20 threads | 9,445× | 10,232× |
| churn | thousands of one-thread workers (its 8 TB holds about 4,700) | 281× | 476× |
| churn, the variant above | 12,000–37,000 workers at once (measured) | 49× | 100× |

Where the time goes now:
- **That last run, 12,000–37,000 scripts:**
  - the game 56%, fake-timers 17%, garbage collection 11%, V8 itself 7%, the scripts 4%, idle 3%, the host 1%;
  - about half the game's share is a log line for every NS call (`formatNumber`, `log`, `formatSize`) and the loop updating every running script (`updateOnlineScriptTimes`). It grows with the game's work per script, which a browser pays too;
  - fake-timers' remaining cost is per timer: adding one, and removing it from the heap in O(log n).
- **The legacy fork from its 23-hour save, up to about 4,700 scripts:** its own scripts 48%, the game 37%, fake-timers 4%, garbage collection 4%, V8 itself 3%, the host 2%.
- **The host's after-every-timer hook** (a real macrotask for the import barrier, and the BitNode-entry check) costs the same per timer whatever the script count. Stop conditions are checked once per step, and are constant-time except `scriptExited`, which looks through the running scripts.

The legacy fork also plays IPvGO, whose CPU work holds it to about 100× however few scripts run ([baselines](baselines.md#running-it)).

## Results

The reference rig is the owner's machine. Dates are UTC. The commit is the one benchmarked; a pull request's commits stay reachable from the pull request after it's squashed.

Reading the first row (2026-10-25, the reference rig):
- **lean** runs at about 26× the 1000× target.
- **churn** is the heavy script-churn class. Spike S1 measured 50–700× for that class ([architecture §9.1](../architecture.md#91-design)), and it isn't held to the target.
- **The heap doesn't grow.** It drops once between days 2 and 3 (about 104 to 93 MB), then stays within 0.2 MB through day 7.

Reading the second row (5457a1c, the reference rig):
- It includes the clock patch ([#74](https://github.com/UnderMyBed/bitburner-agent/issues/74)) and the changes merged since the first row (#68–#70, #72, #76–#78). The patch's own effect, measured alone, is in [Scaling with running scripts](#scaling-with-running-scripts).
- **churn** nearly doubles (259× to 479×), **copies** gains about 30% and **batch** about 10%. **lean** is unchanged.
- **The heap still doesn't grow.**

Reading the third row (3cf08f9, the M1 release, the reference rig):
- Every workload is within 2% of the second row (lean −2%, batch −0.4%, churn +1.7%, copies +0.3%), which is run-to-run noise: nothing merged since #79 changed the hot paths.
- **The heap still doesn't grow.**

Rows are appended at the end of this file, so keep the results table last. When a workload is added or removed, the next run starts a new table with the new columns, and older rows still compare on the workloads they share.

| Date | Commit | Rig | Node | lean | batch | churn | copies | Heap start | Heap end | Heap growth per day |
|---|---|---|---|---|---|---|---|---|---|---|
| 2026-10-25 | 8149ce0 | amd-ryzen-7-9800x3d-16c-62g | v24.22.1 | 26406x | 9038x | 259x | 9137x | 102.9 MB | 93.0 MB | +0.0 MB |
| 2026-10-25 | 5457a1c | amd-ryzen-7-9800x3d-16c-62g | v24.22.1 | 27034x | 10028x | 479x | 12040x | 103.6 MB | 93.5 MB | +0.0 MB |
| 2026-10-26 | 3cf08f9 | amd-ryzen-7-9800x3d-16c-62g | v24.22.1 | 26503x | 9991x | 487x | 12081x | 103.7 MB | 93.5 MB | +0.0 MB |
