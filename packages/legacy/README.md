# @bitburner-agent/legacy

> **Status:** the fork is vendored ([#32](https://github.com/UnderMyBed/bitburner-agent/issues/32)), and its BN1 baseline runs ([#33](https://github.com/UnderMyBed/bitburner-agent/issues/33), [baselines](../../docs/sim/baselines.md)). The reflex adapters come later.

The legacy fork's scripts, vendored unchanged, for:
- **The baseline now.** The fork's BN1 time-to-destroy, from BN1 with SF1.1 and SF4.3, is what the agent is measured against ([architecture §12.3](../../docs/architecture.md#123-migration-from-the-fork-strangler-pattern)).
- **Legacy reflexes later.** Its proven managers (the batcher in `daemon.js`, `stockmaster.js`, `gangs.js`, `bladeburner.js`) will run under the agent through adapters in this package, until our own replacements prove at least as good (architecture §12.3).

The files are in [`fork/`](fork/), exactly as recorded. [`PROVENANCE.md`](PROVENANCE.md) says where they came from and the rules: `fork/` is never edited in place, and a change would be a patch. They're MIT-licensed, © 2021 Alain Bryden ([`fork/LICENSE`](fork/LICENSE)). `fork/README.md` and `fork/CLAUDE.md` are the fork's own docs, about the fork as it was, not about this repository. The repository's [`.claude/settings.json`](../../.claude/settings.json) excludes `fork/CLAUDE.md` from Claude Code's memory (`claudeMdExcludes`), for sessions started at the repository root, where Claude Code reads that file.

```ts
import { runSeed } from "@bitburner-agent/sim";
import { baselineScenario } from "@bitburner-agent/legacy";

// One seed of the baseline, for a virtual hour.
const result = await runSeed(baselineScenario({ durationMs: 60 * 60 * 1000 }), 1);
```

- `gameFiles()`: what a game needs: the scripts (`.js`) and the text files they read (`.txt`).
- `forkFiles()`: every vendored file, in path order, as text (the fork is all UTF-8; some files keep CRLF line endings).
- `forkManifest()`, `FORK`: the source, commit, tree and per-file sha256, from [`manifest.json`](manifest.json).
- `FORK_DIR`: where the files are.
- `baselineScenario(overrides?)`, `DAY`: the baseline ([below](#the-baseline)). `overrides` replace top-level fields, for tests.
- `formatHeaps(run)`, `baselineRow(run, meta)`, `seedHeapGrowth(result)`, `dailyHeapMb(result)`: the baseline's heap table and its row for `docs/sim/baselines.md` (`src/report.ts`).

## The baseline

`baselineScenario()` (`src/baseline.ts`) is the fork's BN1 baseline: what the agent's planner has to beat (M4). Results and how to read them: [docs/sim/baselines.md](../../docs/sim/baselines.md).
- **Start** (owner decisions log #28): BN1 with SF1.1 and SF4.3, the least a player can hold along with SF4.3; the game makes it BN1.2. SF1 starts home at 32 GB of RAM, so the fork runs unattended from the start.
- **Play:** the fork's game files on home, and `autopilot.js --disable-casino`, as a player starts it.
- **End:** the run passes when the fork destroys the BitNode, and stops there or at the BitVerse. It gives up after 30 virtual days. Seeds 1–8.

```
npm run baseline -w @bitburner-agent/legacy [-- --seeds a..b | a,b,c] [--workers k] [--json out.json]
```

It prints the scenario table ([scenarios](../../docs/sim/scenarios.md)), each seed's heap (start, end, largest, growth per virtual day), and the run's row for the baselines page. `--json` paths are relative to where you ran npm. It exits 0 if every seed destroyed the BitNode, 1 if any didn't, and 2 if it couldn't run. It runs one seed at a time unless `--workers` says otherwise: a seed is heavy, about 14 real minutes per virtual day at best and several hours once the fork runs tens of thousands of scripts ([baselines](../../docs/sim/baselines.md#running-it)).

## Checks

`test/baseline.test.ts`, the baseline's CI smoke tests:
- the scenario starts in BN1 with SF1.1 and SF4.3 and runs `autopilot.js --disable-casino`, stopping at the destroy, for up to 30 days, seeds 1–8
- home starts at 32 GB, and within 5 virtual minutes the fork runs unattended: `daemon.js` and the SF4-only `work-for-factions.js` start
- the fork makes progress (money, hacking level) within a virtual hour
- the CLI refuses bad arguments with exit 2

`test/report.test.ts`: the heap's daily samples and growth, the heap table, and the release row.

`test/fork.test.ts`:
- every file matches the manifest byte for byte, with nothing missing or extra; `forkFiles()` gives exactly those bytes; `PROVENANCE.md` agrees with the manifest
- every script parses and resolves its imports in the simulator, and the game's RAM calculator costs it (this doesn't run the scripts)
- `autopilot.js --disable-casino`, on 64 GB of home RAM, runs 10 virtual minutes with its managers (`daemon.js`, `stockmaster.js`, `go.js`) and no `ReferenceError`. `stats.js` gets past `eval("document")`, then fails on the game's HUD elements, which a headless game doesn't render. `--disable-casino`: `casino.js` plays through the game's page and reloads the game, which a headless run can't.

Biome and the typecheck skip `fork/`: it's someone else's code, kept as it is.

## How the fork behaves headless

- **On 8 GB of home RAM** (a start without SF1), `autopilot.js` can't stay up. Without SF4 it starts `daemon.js` and exits, saying home RAM is too small and that a player should run it again after buying RAM (`autopilot.js` `shouldWeKeepRunning`). With SF4, its temp scripts (`getNsDataThroughFile`) don't fit in RAM, so it can't read its Source-Files, falls back to "no SF4", and exits the same way; `daemon.js` then schedules nothing, because its `analyze-hack.js` helper doesn't fit beside it. Both are the game's own RAM checks. From 16 GB it runs unattended. The baseline starts with SF1.1, so home has 32 GB.
- **The page:** scripts that draw on the game's page (`stats.js`'s HUD, `casino.js`, `scan.js`) find nothing to draw on headless.
