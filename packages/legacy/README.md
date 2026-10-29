# @bitburner-agent/legacy

> **Status:** the fork is vendored ([#32](https://github.com/UnderMyBed/bitburner-agent/issues/32)), and its BN1 baseline runs ([#33](https://github.com/UnderMyBed/bitburner-agent/issues/33), [baselines](../../docs/sim/baselines.md)). The reflex adapters come later.

The legacy fork's scripts, vendored unchanged, for:
- **The baseline now.** The fork's progress in BN1, from BN1 with SF1.1 and SF4.3, at 4, 8 and 12 virtual hours, is what the agent is measured against ([architecture §12.3](../../docs/architecture.md#123-migration-from-the-fork-strangler-pattern), [ADR 0011](../../docs/decisions/0011-checkpointed-simulator-comparisons.md)).
- **Legacy reflexes later.** Its proven managers (`stockmaster.js`, `gangs.js`, `bladeburner.js`) will run under the agent through adapters in this package, until our own replacements prove at least as good (architecture §12.3). The batcher in `daemon.js` won't: ours replaces it from the start (#204, architecture §5.5, [ADR 0013](../../docs/decisions/0013-own-batcher-not-legacy-daemon.md)), and `daemon.js` runs only in the baseline, where the two can be compared.

The files are in [`fork/`](fork/), exactly as recorded. [`PROVENANCE.md`](PROVENANCE.md) says where they came from and the rules: `fork/` is never edited in place, and a change would be a patch. They're MIT-licensed, © 2021 Alain Bryden ([`fork/LICENSE`](fork/LICENSE)). `fork/README.md` and `fork/CLAUDE.md` are the fork's own docs, about the fork as it was, not about this repository. The repository's [`.claude/settings.json`](../../.claude/settings.json) excludes `fork/CLAUDE.md` from Claude Code's memory (`claudeMdExcludes`), for sessions started at the repository root, where Claude Code reads that file.

```ts
import { buildEngine, runSeed } from "@bitburner-agent/sim";
import { baselineScenario } from "@bitburner-agent/legacy";

await buildEngine(); // once, after a fresh clone or a game bump
const HOUR = 60 * 60 * 1000;
// One seed of the baseline, for a virtual hour.
const result = await runSeed(baselineScenario({ durationMs: HOUR, checkpointEveryMs: HOUR }), 1);
```

- `gameFiles()`: what a game needs: the scripts (`.js`) and the text files they read (`.txt`).
- `forkFiles()`: every vendored file, in path order, as text (the fork is all UTF-8; some files keep CRLF line endings).
- `forkManifest()`, `FORK`: the source, commit, tree and per-file sha256, from [`manifest.json`](manifest.json).
- `FORK_DIR`: where the files are.
- `baselineScenario(overrides?)`, `CHECKPOINTS_MS`: the baseline and its checkpoints ([below](#the-baseline)). `overrides` replace top-level fields, for shorter runs and tests.
- `formatHeaps(run)`, `baselineRows(run, meta: RowMeta)`, `formatSeeds(seeds)`, `formatMoney(n)`: the baseline's heap table and its rows for `docs/sim/baselines.md`, one per checkpoint (`src/report.ts`).

## The baseline

`baselineScenario()` (`src/baseline.ts`) is the fork's BN1 baseline: what the agent's planner has to beat (M4). Results and how to read them: [docs/sim/baselines.md](../../docs/sim/baselines.md).
- **Start** (owner decisions log #28): BN1 with SF1.1 and SF4.3, the least a player can hold along with SF4.3; the game makes it BN1.2. SF1 starts home at 32 GB of RAM, so the fork runs unattended from the start.
- **Play:** the fork's game files on home, and `autopilot.js --disable-casino`, as a player starts it.
- **Checkpoints:** 4, 8 and 12 virtual hours; the run passes if it gets to 12 hours without failing, and has no stop condition. Seeds 1–8.

```
npm run baseline -w @bitburner-agent/legacy [-- --seeds a..b | a,b,c] [--workers k] [--wall-limit minutes] [--max-heap MB] [--json out.json]
```

It prints the scenario table ([scenarios](../../docs/sim/scenarios.md)), each seed's heap (at the start and each checkpoint), and the run's rows for the baselines page, one per checkpoint. `--json` paths are relative to where you ran npm. The CLI is `src/cli.ts` (`baselineCli`), which `scripts/baseline.ts` calls with the real dependencies. It exits 0 if every seed reached 12 hours, 1 if any didn't, and 2 if it couldn't run. A seed takes a few real minutes: 12 virtual hours come before the fork runs tens of thousands of scripts, which is where the cost is ([baselines](../../docs/sim/baselines.md#why-checkpoints-and-why-12-hours)). By default it runs one seed at a time, kills a seed after 60 minutes of real time (`--wall-limit`, in minutes), caps each simulation's heap at 2 GB (`--max-heap`, in MB), and prints a progress line per seed per checkpoint on stderr.

## Checks

`test/baseline.test.ts`, the baseline's CI smoke tests:
- the scenario starts in BN1 with SF1.1 and SF4.3 and runs `autopilot.js --disable-casino` for 12 virtual hours, with a checkpoint every 4 and no stop condition, seeds 1–8
- home starts at 32 GB, and within 5 virtual minutes the fork runs unattended: `daemon.js` and the SF4-only `work-for-factions.js` start
- the fork makes progress (money, hacking level) within a virtual hour
- the script refuses bad arguments with exit 2

`test/cli.test.ts`, the CLI with a stubbed run: exit 0 (every seed reached 12 hours) and 1 (a seed's wall limit stopped it), its defaults (one worker, an hour, 2 GB) and the flags that change them, progress lines on stderr, the rows' details, `--json` written relative to where npm ran before anything prints, and exit 2 before any run for bad arguments, a missing `--json` folder, a bad rig name or no commit.

`test/report.test.ts`: money and `--seeds` formatting, the heap table at each checkpoint, and the rows, one per checkpoint. The rows' data is chosen so that only the median gives each value, a wall-limited seed's checkpoint counts in Reached, and only the seeds that didn't fail count for speed and real time.

`test/fork.test.ts`:
- every file matches the manifest byte for byte, with nothing missing or extra; `forkFiles()` gives exactly those bytes; `PROVENANCE.md` agrees with the manifest
- every script parses and resolves its imports in the simulator, and the game's RAM calculator costs it (this doesn't run the scripts)
- `autopilot.js --disable-casino`, on 64 GB of home RAM, runs 10 virtual minutes with its managers (`daemon.js`, `stockmaster.js`, `go.js`) and no `ReferenceError`. `stats.js` gets past `eval("document")`, then fails on the game's HUD elements, which a headless game doesn't render. `--disable-casino`: `casino.js` plays through the game's page and reloads the game, which a headless run can't.

Biome and the typecheck skip `fork/`: it's someone else's code, kept as it is.

## How the fork behaves headless

- **On 8 GB of home RAM** (a start without SF1), `autopilot.js` can't stay up. Without SF4 it starts `daemon.js` and exits, saying home RAM is too small and that a player should run it again after buying RAM (`autopilot.js` `shouldWeKeepRunning`). With SF4, its temp scripts (`getNsDataThroughFile`) don't fit in RAM, so it can't read its Source-Files, falls back to "no SF4", and exits the same way; `daemon.js` then schedules nothing, because its `analyze-hack.js` helper doesn't fit beside it. Both are the game's own RAM checks. From 16 GB it runs unattended. The baseline starts with SF1.1, so home has 32 GB.
- **The page:** scripts that draw on the game's page (`stats.js`'s HUD, `casino.js`, `scan.js`) find nothing to draw on headless.
