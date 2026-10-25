# Baselines

What the agent has to beat. The legacy fork, played headless from a BitNode start a player can reach, sets the bar. M1 records its time-to-destroy, and the M4 exit criterion compares the agent's planner with it ([architecture §12.3](../architecture.md#123-migration-from-the-fork-strangler-pattern), [§13](../architecture.md#13-milestones)). A baseline runs on each release ([releasing](../releasing.md), step 2) and adds a row below.

## The BN1 baseline

`baselineScenario()` from `@bitburner-agent/legacy` ([README](../../packages/legacy/README.md#the-baseline), [owner decisions log](../decisions/owner-decisions.md) #28):
- **Start:** BN1 with SF1.1 and SF4.3, the least a player can hold along with SF4.3 (earning SF4 means destroying BN1 first). The game makes it BN1.2. SF1 starts home at 32 GB of RAM (`Prestige.ts:248-249`), more than the 16 GB the fork needs to run unattended, and SF4.3 lets it use Singularity at no extra RAM cost.
- **Play:** the fork's game files on home, and `autopilot.js --disable-casino`, as a player starts it. The casino is off because `casino.js` plays through the game's page, which a headless run doesn't have.
- **End:** a seed passes when the fork destroys the BitNode. The run stops there, or at the BitVerse if that comes first, and otherwise gives up after 30 virtual days.
- **Seeds:** 1–8, each in its own simulation.

## Running it

```
npm run baseline -w @bitburner-agent/legacy [-- --seeds a..b | a,b,c] [--workers k] [--json out.json]
```

It prints:
- the scenario table, one row per seed ([scenarios](scenarios.md));
- each seed's heap: at the start, at the end, the largest sample, and the growth per virtual day (below). The heap is sampled after a full collection at the start and at the end of each virtual day; `--json` has every sample (`checkpoints[].heapMb`);
- the run's row for the results table below.

`--json` paths are relative to where you ran npm. The command exits 0 if every seed destroyed the BitNode, 1 if any didn't, and 2 if it couldn't run.

**It's heavy.** Measured on one seed ([#33](https://github.com/UnderMyBed/bitburner-agent/issues/33), [#74](https://github.com/UnderMyBed/bitburner-agent/issues/74)):
- The fork plays IPvGO all the time. The game paces Go moves with virtual-time sleeps, which cost nothing in the simulator, while each move's CPU work is real. That holds the fork to about 100× real time, about 14 real minutes per virtual day.
- From about one virtual day in, the fork's batching runs tens of thousands of scripts, and the speed falls to 3–11×: several real hours per virtual day ([#74](https://github.com/UnderMyBed/bitburner-agent/issues/74)).
- Each simulation process grew to about 3.4 GB.

So it runs one seed at a time unless `--workers` says otherwise. Until [#75](https://github.com/UnderMyBed/bitburner-agent/issues/75) it prints nothing until every seed ends and has no real-time limit: stop it by hand if it overruns.

## What a row records

| Column | What |
|---|---|
| Date | UTC, the day of the run |
| Commit, Node | The commit run, and the Node version |
| Rig | The machine, as [benchmarks](benchmarks.md#regressions) name it: `BENCH_RIG` if set, otherwise its CPU model, logical CPU count and memory |
| Passed | Seeds that destroyed the BitNode, of those run |
| Time to destroy | Virtual hours from the start to the destroy, over the seeds that passed: min / median / p90 / max |
| Speed | Virtual ms per real ms, the median over the seeds that didn't crash, passed or not, measured with heap sampling on |
| Real time per seed | The median over the same seeds |
| Heap growth per virtual day | The median over seeds of each seed's growth, measured as benchmarks measure it: the median day-to-day change, day 1's warm-up left out, from whole-day samples only. Some growth is expected: the simulator keeps one module per distinct script source compiled ([#73](https://github.com/UnderMyBed/bitburner-agent/issues/73)), and the fork compiles temp scripts all the time |

The command prints the row. Paste it at the end of the table, and add the run's failures below.

## Failures

Every seed that didn't pass is explained here, per run: what stopped it, and whether the fork, the simulator or the scenario was at fault, with an issue where it's ours to fix.

None recorded yet.

## Results

The reference rig is the owner's machine. No runs are recorded yet: the first follows [#74](https://github.com/UnderMyBed/bitburner-agent/issues/74) and [#75](https://github.com/UnderMyBed/bitburner-agent/issues/75). Rows are appended at the end of this file, so keep the results table last.

| Date | Commit | Rig | Node | Passed | Time to destroy (min / median / p90 / max) | Speed | Real time per seed | Heap growth per virtual day |
|---|---|---|---|---|---|---|---|---|
