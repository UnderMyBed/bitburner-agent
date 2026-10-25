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
  - Lean runs a fixed set of scripts, so this catches leaks in the game's loop and in running scripts. Leaks that grow with each new script module show up once the fork-style run ([#64](https://github.com/UnderMyBed/bitburner-agent/issues/64)) is added.

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

## Results

The reference rig is the owner's machine. Dates are UTC. The commit is the one benchmarked; a pull request's commits stay reachable from the pull request after it's squashed.

Rows are appended at the end of this file, so keep the results table last. When a workload is added or removed, the next run starts a new table with the new columns, and older rows still compare on the workloads they share.

| Date | Commit | Rig | Node | lean | batch | churn | copies | Heap start | Heap end | Heap growth per day |
|---|---|---|---|---|---|---|---|---|---|---|
