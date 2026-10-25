# Simulator benchmarks

How fast the simulator runs and whether its memory stays flat, measured on each release ([releasing](../releasing.md), step 2). The M1 target is at least 1000× real time on the lean workload ([architecture §13](../architecture.md#13-milestones)).

## Running it

```
npm run bench -w @bitburner-agent/sim                  # measure, append a row below, flag regressions
npm run bench -w @bitburner-agent/sim -- --dry-run     # measure and print the row, without recording it
npm run bench -w @bitburner-agent/sim -- --profile lean [--out lean.cpuprofile]
```

It takes a few minutes and isn't part of CI: CI machines vary too much for the numbers to mean anything. Close other heavy programs first.

## What it measures

- **Speed** for each workload in [`packages/sim/scenarios/`](../../packages/sim/scenarios/) ([scenarios](scenarios.md)): every seed the scenario lists, one simulation at a time, and the median of their speeds. Speed is virtual ms per real ms, booting excluded.

  | Workload | What it runs |
  |---|---|
  | lean | one 3-thread hack loop on n00dles: the M1 target |
  | batch | a controller `exec()`ing short-lived workers of up to 20 threads, one every 200 ms |
  | churn | the same controller `exec()`ing 125 one-thread workers a second, thousands running at once: the heavy script-churn class |
  | copies | 100 copies of the hack loop, each its own module |

- **Heap** over a long lean run: seed 1, 7 virtual days. The host's V8 heap is sampled after a full garbage collection when the scripts start and at the end of each virtual day. The row shows the first and last samples and the growth per day: the least-squares slope through days 1–7, leaving out the first day's warm-up. A leak shows as steady growth, for example from compiled script modules, which are never collected.

  The fork-style heavy run from [#33](https://github.com/UnderMyBed/bitburner-agent/issues/33) joins the table once that baseline runs.

Measurements come from inside the simulation's host process (`Simulation.diagnostics.heap()` and `.profile()`), not the process running the benchmark.

## Regressions

A row is compared only with the last row from the same **rig**: the machine, named by `BENCH_RIG` if set, otherwise its CPU model, core count and memory. A workload more than 20% slower, or heap growth per day more than 20% higher (and over 1 MB a day), is a regression. The run prints it and exits 1. Look into it before releasing: profile the workload, and compare with the previous commit's profile.

Exit codes: 0 nothing regressed, 1 something did, 2 it couldn't run.

## Profiling

`--profile <workload>` runs the workload's first seed once, with a CPU profile of the host covering the run (setup excluded). It writes the profile (open it in Chrome DevTools' Performance panel or VS Code) and prints the 15 functions with the most self time: time spent in the function itself, not in what it calls. It doesn't record a row.

## Results

The reference rig is the owner's machine. Rows are appended at the end of this file, so keep the table last.

| Date | Commit | Rig | Node | lean | batch | churn | copies | Heap start | Heap end | Heap growth per day |
|---|---|---|---|---|---|---|---|---|---|---|
