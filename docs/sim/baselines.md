# Baselines

What the agent has to beat. The legacy fork, played headless from a fresh BitNode, sets the bar: the M4 exit criterion compares the agent's planner with it ([architecture §12.3](../architecture.md#123-migration-from-the-fork-strangler-pattern), [§13](../architecture.md#13-milestones)). A baseline runs on each release ([releasing](../releasing.md), step 2) and adds a row below.

## The BN1 baseline

`baselineScenario()` in `@bitburner-agent/legacy` ([README](../../packages/legacy/README.md#the-baseline), owner decisions log #25):
- **Start:** BN1 entered with SF4.3, a fresh BitNode: 8 GB of home RAM, $1,000, the fork's game files on home.
- **Scripted early game:** `bootstrap.js`, an in-game script a player could write, hacks n00dles and buys home RAM until home has 16 GB, the least the fork runs unattended on. Then it hands over to `autopilot.js --disable-casino`. Its time counts.
- **End:** a seed passes when the fork destroys the BitNode. The run stops at the BitVerse either way, and gives up after 30 virtual days.
- **Seeds:** 1–8. Each seed runs in its own simulation.

## Running it

```
npm run baseline -w @bitburner-agent/legacy [-- --seeds a..b | a,b,c] [--workers k] [--json out.json]
```

It prints the scenario table ([scenarios](scenarios.md)) and each seed's heap, sampled after a full collection at the start and at the end of each virtual day. It exits 0 if every seed destroyed the BitNode, 1 if any didn't, and 2 if it couldn't run.

**It's heavy.** The fork plays IPvGO all the time. The game paces Go moves with virtual-time sleeps, which cost nothing in the simulator, while each move's CPU work is real. That caps a seed at roughly 100× real time, about 14 real minutes per virtual day. Later in the run, the fork's batching starts tens of thousands of scripts, and the speed falls further ([#74](https://github.com/UnderMyBed/bitburner-agent/issues/74)). Until the runner has a hard real-time limit and progress output ([#75](https://github.com/UnderMyBed/bitburner-agent/issues/75)), run one seed at a time (`--workers 1`) and watch it.

## What a row records

| Column | What |
|---|---|
| Date, Commit, Rig, Node | As in [benchmarks](benchmarks.md#results): the rig is the machine, named by `BENCH_RIG` if set |
| Passed | Seeds that destroyed the BitNode, of those run |
| Time to destroy | Virtual time from the start to the destroy, over the seeds that passed: min, median, p90, max |
| Speed | Virtual ms per real ms, median over the seeds that ran without failing |
| Real time per seed | Median |
| Heap growth per virtual day | Median over seeds of each seed's median day-to-day change, as benchmarks measure it. Some growth is expected: the simulator keeps one module per distinct script source compiled ([#73](https://github.com/UnderMyBed/bitburner-agent/issues/73)), and the fork compiles temp scripts all the time |

A failed seed is analysed in the release's review issue: what stopped it, and whether the fork, the simulator or the scenario was at fault.

## Results

No runs are recorded yet. The first follows [#74](https://github.com/UnderMyBed/bitburner-agent/issues/74) and [#75](https://github.com/UnderMyBed/bitburner-agent/issues/75). Rows are appended at the end of this file, so keep the results table last.

| Date | Commit | Rig | Node | Passed | Time to destroy (min / median / p90 / max) | Speed | Real time per seed | Heap growth per virtual day |
|---|---|---|---|---|---|---|---|---|
