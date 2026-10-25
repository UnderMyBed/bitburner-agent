# @bitburner-agent/legacy

> **Status:** the fork is vendored ([#32](https://github.com/UnderMyBed/bitburner-agent/issues/32)), and its BN1 baseline runs ([#33](https://github.com/UnderMyBed/bitburner-agent/issues/33), [baselines](../../docs/sim/baselines.md)). The reflex adapters come later.

The legacy fork's scripts, vendored unchanged, for:
- **The baseline now.** The fork's BN1 time-to-destroy from a BN1 + SF4.3 start is what the agent is measured against ([architecture §12.3](../../docs/architecture.md#123-migration-from-the-fork-strangler-pattern)).
- **Legacy reflexes later.** Its proven managers (the batcher in `daemon.js`, `stockmaster.js`, `gangs.js`, `bladeburner.js`) will run under the agent through adapters in this package, until our own replacements prove at least as good (architecture §12.3).

The files are in [`fork/`](fork/), exactly as recorded. [`PROVENANCE.md`](PROVENANCE.md) says where they came from and the rules: `fork/` is never edited in place, and a change would be a patch. They're MIT-licensed, © 2021 Alain Bryden ([`fork/LICENSE`](fork/LICENSE)). `fork/README.md` and `fork/CLAUDE.md` are the fork's own docs, about the fork as it was, not about this repository. The repository's [`.claude/settings.json`](../../.claude/settings.json) excludes `fork/CLAUDE.md` from Claude Code's memory (`claudeMdExcludes`), for sessions started at the repository root, where Claude Code reads that file.

```ts
import { Simulation } from "@bitburner-agent/sim";
import { gameFiles } from "@bitburner-agent/legacy";

const sim = await Simulation.start({ seed: 1, epochMs, fixture: { kind: "bitnode", n: 1, sourceFiles: { 4: 3 } } });
for (const { path, content } of gameFiles()) {
  await sim.writeFile("home", path, content);
}
await sim.run("home", "autopilot.js", { args: ["--disable-casino"] });
```

- `gameFiles()`: what a game needs: the scripts (`.js`) and the text files they read (`.txt`).
- `forkFiles()`: every vendored file, in path order, as text (the fork is all UTF-8; some files keep CRLF line endings).
- `forkManifest()`, `FORK`: the source, commit, tree and per-file sha256, from [`manifest.json`](manifest.json).
- `FORK_DIR`: where the files are.

## The baseline

`baselineScenario()` (`src/baseline.ts`) is the fork's BN1 baseline: what the agent's planner has to beat (M4). Results and how to read them: [docs/sim/baselines.md](../../docs/sim/baselines.md).
- **Start:** BN1 entered with SF4.3, a fresh BitNode with 8 GB of home RAM and $1,000. The fork's game files and `bootstrap.js` are on home.
- **Scripted early game** (`src/bootstrap.js`, owner decisions log #25): an in-game script a player could write. With SF4.3, Singularity costs only a few GB, so it fits in 8 GB. It hacks n00dles and buys home RAM until home has 16 GB, the least the fork runs unattended on, then spawns `autopilot.js --disable-casino`. Its time counts in the baseline.
- **End:** the run passes when the fork destroys the BitNode, and stops at the BitVerse either way. It gives up after 30 virtual days. Seeds 1–8.

```
npm run baseline -w @bitburner-agent/legacy [-- --seeds a..b | a,b,c] [--workers k] [--json out.json]
```

It prints the scenario table ([scenarios](../../docs/sim/scenarios.md)) and each run's heap, measured at the start and every virtual day. It exits 0 if every seed destroyed the BitNode, 1 if any didn't, and 2 if it couldn't run.

## Checks

`test/baseline.test.ts`, the baseline's CI smoke test:
- the scenario is a fresh BN1 with SF4.3, and runs the bootstrap
- the bootstrap fits in 8 GB and makes progress within a virtual hour
- with 16 GB, the bootstrap hands over to `autopilot.js`

`test/fork.test.ts`:
- every file matches the manifest byte for byte, with nothing missing or extra; `forkFiles()` gives exactly those bytes; `PROVENANCE.md` agrees with the manifest
- every script parses and resolves its imports in the simulator, and the game's RAM calculator costs it (this doesn't run the scripts)
- `autopilot.js --disable-casino`, on 64 GB of home RAM, runs 10 virtual minutes with its managers (`daemon.js`, `stockmaster.js`, `go.js`) and no `ReferenceError`. `stats.js` gets past `eval("document")`, then fails on the game's HUD elements, which a headless game doesn't render. `--disable-casino`: `casino.js` plays through the game's page and reloads the game, which a headless run can't.

Biome and the typecheck skip `fork/`: it's someone else's code, kept as it is.

## How the fork behaves headless

- **On 8 GB of home RAM without SF4,** `autopilot.js` starts `daemon.js` and exits, saying home RAM is too small to keep it running and that a player should run it again after buying RAM (`autopilot.js` `shouldWeKeepRunning`).
- **On 8 GB with SF4 (the baseline's BN1 + SF4.3),** it stays up in principle, but its temp scripts (`getNsDataThroughFile`) don't fit in RAM: it can't read its Source-Files, falls back to "no SF4", and exits the same way. `daemon.js` then schedules nothing, because its `analyze-hack.js` helper doesn't fit beside it on home either. Both are the game's own RAM checks. In the fork's design, the player buys the first home RAM upgrades by hand; from 16 GB it runs unattended. The baseline therefore starts with a scripted early game, `src/bootstrap.js`, that buys home RAM to 16 GB, then hands over ([The baseline](#the-baseline)).
- **The page:** scripts that draw on the game's page (`stats.js`'s HUD, `casino.js`, `scan.js`) find nothing to draw on headless.
