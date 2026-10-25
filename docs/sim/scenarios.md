# Simulator scenarios

A scenario describes runs: where they start, which scripts run, for how long, and what ends them. The runner runs it once per seed, each seed in its own simulation process, several at once. The aggregate over seeds is the repeatability metric of [architecture §9.3](../architecture.md#93-test-pyramid): the pass rate, and the time-to-stop distribution, which is time-to-destroy when the scenario stops on `bitnodeDestroyed`.

```
npm run sim -- packages/sim/scenarios/lean.json --seeds 1..2
scenario: lean: one hack loop on n00dles, 3 threads
seed  result  stopped by  virtual  wall   speed   uncaught  state hash
1     pass    -           6.00 h   0.7 s  30042x  0         faed52e8deb1
2     pass    -           6.00 h   0.7 s  30042x  0         ecd4bac17b0f

passed: 2/2 (100%)
time to stop: none
speed: min 30042x, median 30042x, p90 30042x, max 30042x
```

The code is in [`packages/sim/src/scenario/`](../../packages/sim/src/scenario/); the [simulator README](../../packages/sim/README.md) covers `Simulation` itself, including [`runUntil`](../../packages/sim/README.md#running-until-something-happens), which the runner uses.

## The scenario file

```json
{
  "name": "lean: one hack loop on n00dles, 3 threads",
  "fixture": { "kind": "new", "tutorial": "skipped" },
  "epochMs": 1767225600000,
  "files": { "home": "scripts" },
  "run": [{ "script": "hack.js", "threads": 3 }],
  "durationMs": 21600000,
  "checkpointEveryMs": 3600000,
  "seeds": { "from": 1, "to": 4 }
}
```

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Shown in the report. |
| `fixture` | yes | Where each run starts, as `Simulation.start` takes it: `{ "kind": "new", "tutorial" }`, `{ "kind": "bitnode", "n", "sourceFiles" }`, or `{ "kind": "save", "path", "offlineMs"? }` (the path is relative to the scenario file). |
| `epochMs` | unless a save | The virtual epoch. A save fixture takes its epoch from the save, and refuses this. |
| `files` | no | Files to write before the scripts start, per host: `{ "path": "content" }`, or a directory (relative to the scenario file, inside its directory) whose files are all written under their relative paths. |
| `run` | no | Scripts to start, in order: `{ "script", "host"?, "threads"?, "args"? }` (default host `home`, 1 thread). A script that can't start fails the seed. |
| `durationMs` | yes | The most virtual time a run takes, from when its scripts start. |
| `stopWhen` | no | Stop conditions: the first to hold ends the run, and it passes. |
| `failWhen` | no | Stop conditions: the first to hold ends the run, and it fails. |
| `onBitVerse` | no | `"stop"` ends the run when the game reaches the BitVerse; `{ "enter": n }` enters BitNode n there, as a player clicking its portal would. Without it the game waits at the BitVerse. |
| `prompts` | no | Prompt rules (`{ "match", "answer" }`), as `Simulation.start` takes them. |
| `checkpointEveryMs` | no | Take a summary every this many virtual ms, and at the end. |
| `seeds` | no | A list of distinct seeds, or `{ "from", "to" }`. Default `[1]`. |
| `homeRamGb` | no | Sets home's RAM (a power of 2 GB) before the scripts start: a harness edit for test and benchmark workloads. A run with it isn't a state a player can reach, so its results don't compare with real play; agent and baseline scenarios don't use it. |

Loading a scenario checks all of this, short of reading the files it names, and refuses a bad one with a message naming the field. So a mistake fails once, not on every seed.

### Stop conditions

`stopWhen` and `failWhen` take the conditions `runUntil` does, checked at the start and after each moment timers fire:
- `{ "event": "bitnodeDestroyed" | "bitnodeFlumed" | "bitverseReached" }`: an event of that type since the game booted. So a save that starts at the BitVerse holds `bitverseReached` from the start.
- `{ "scriptExited": "path/to/script.js" }`: a script with that filename (its full path, as `ps` shows it) has run, and none is running now, on any server. A script that hasn't started yet hasn't exited.
- `{ "summary": { "field", "op", "value" } }`: a numeric `GameSummary` field other than `virtualMs` (`playtimeMs`, `bitNodeN`, `bitNodeLevel`, `money`, `hackingLevel`, `hackingExp`, `homeRamUsed`, `homeRamMax`, `scripts`, `augsInstalled`, `augsQueued`) compared with `<`, `<=`, `==`, `>=` or `>`. How long a run takes is `durationMs`.

A run also fails, as an error, if the game goes into recovery mode or its loop stops (an uncaught error in the game loop stops it, as in a browser).

## Results

For each seed:

| Field | Meaning |
|---|---|
| `ok`, `error` | False, with the error, if the run failed: the process crashed, a script couldn't start, the game went into recovery mode or its loop stopped. A failure stays with its seed. |
| `passed` | `ok`, no `failWhen` condition stopped it, and, if the scenario has `stopWhen` conditions or `onBitVerse: "stop"`, one of those did. |
| `stoppedBy` | What ended the run early: `{ "list": "stopWhen" \| "failWhen", "index" }`, `"bitverse"`, or null if it ran the full duration. |
| `uncaught` | Uncaught errors the game logged (console events starting `Uncaught`), for instance a script's timer callback throwing. Reported; not a failure in itself. |
| `virtualMs` | Virtual time the run took, from when its scripts started. |
| `wallMs`, `speed` | Real time the run took (setup and the final hash excluded), and virtual ms per real ms. |
| `stateHash`, `summary` | The final state hash and summary. |
| `checkpoints` | `{ virtualMs, summary }` every `checkpointEveryMs`, and at the end; with `measureHeap`, also `heapMb`. |
| `heapStartMb` | With `measureHeap`: the host's heap after a full collection, in MB, as the run starts. |
| `events` | Every event. |

The results don't depend on how many seeds run at once: each has its own process.

**The aggregate:** the pass rate; the time to stop over the runs that passed by stopping (min, median, 90th percentile by nearest rank, max); and speed over the runs that didn't fail.

## The CLI

```
npm run sim -- <scenario.json> [--seeds a..b | a,b,c] [--workers k] [--wall-limit minutes] [--max-heap MB] [--json out.json]
```

- It builds the engine if needed, runs every seed, prints the table, and with `--json` writes the full results. While it runs, it prints a progress line per seed at each checkpoint on stderr: virtual and real time so far, speed, scripts, money and hacking level.
- `--seeds` overrides the scenario's seeds; `--workers` the pool size, which by default is `availableParallelism() − 2`, at least 1 (architecture §9.1, ADR 0006).
- `--wall-limit` is a hard limit on each seed's real time, in whole minutes; a seed past it is killed and fails ("wall limit: …"). `--max-heap` caps each simulation's V8 heap, in MB (at least 256). Neither is set by default.
- npm runs it from the repository root, so the scenario and `--json` paths are relative to that.
- It exits 0 if every seed passed, 1 if any didn't, and 2 if it couldn't run at all (bad usage, a bad scenario, a build failure).

From code, `@bitburner-agent/sim` exports these:
- `runScenario`, `runSeed`, `startScenario` (a simulation set up as a scenario says, not yet run), `loadScenario`, `formatRun`;
- `parseSeeds`, `parseWorkers`, `parseWallLimit` and `parseMaxHeap`, which parse the CLIs' options (this CLI's and the baseline's), and `formatProgress`, their progress line;
- `aggregate` and `distribution`, the run's aggregate and its min / median / p90 / max;
- `growthPerDay`, `rigId` and `commitId`, the benchmarks' heap statistic, machine name and commit ([benchmarks](benchmarks.md)), which the baseline reuses.

`runScenario`/`runSeed` take these options besides the seeds and workers:
- `wallLimitMs`: a hard limit on each seed's real time, counted once its setup is done. The parent enforces it with its own timer: past it, it kills the seed's simulation process, mid-piece if need be, and the seed fails with an error starting "wall limit:", keeping the checkpoints it had.
- `onCheckpoint(seed, checkpoint, wallMs)`: called with each checkpoint as it's taken, for progress output.
- `maxHeapMb`: each simulation's V8 heap cap (`SimulationOptions.maxHeapMb`). V8 grows its heap toward its limit before collecting, so a long run can hold far more memory than it uses; a cap makes it collect sooner. A run that needs more crashes, as out of memory.
- `measureHeap: true`, to sample the host's heap after a full collection, as the run starts and at every checkpoint. Each sample takes real time, so speeds read a little lower; it doesn't change the game ([#73](https://github.com/UnderMyBed/bitburner-agent/issues/73)).

The [fork baseline](baselines.md) is a scenario built in code (`baselineScenario()` from `@bitburner-agent/legacy`), since its files come from the vendored fork. It runs with `npm run baseline -w @bitburner-agent/legacy`.

## Workloads

[`packages/sim/scenarios/`](../../packages/sim/scenarios/) holds the S1 spike's workloads ([S1 report](../spikes/s1-headless-engine.md)), used to measure speed ([benchmarks](benchmarks.md)). They share the scripts in `scenarios/scripts/`.

| Scenario | What it runs | S1 equivalent |
|---|---|---|
| `lean.json` | One hack loop on n00dles, 3 threads, 6 virtual hours | The default `loop` run: the "lean hacking workload" of the M1 speed target |
| `batch.json` | A controller exec()ing weaken, grow or hack workers of up to 20 threads, one every 200 ms, on 1 TB of home RAM | `--scenario batch` with the default 20 threads and 1 per tick |
| `churn.json` | The same controller exec()ing 125 one-thread workers a second, thousands running at once, on 8 TB | `--scenario batch --max-threads 1 --per-tick 25`: the heavy script-churn class |
| `copies.json` | 100 copies of the hack loop, each its own module, on 1 TB | `--copies 100` |
