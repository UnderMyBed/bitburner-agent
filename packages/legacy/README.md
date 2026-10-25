# @bitburner-agent/legacy

> **Status:** the fork is vendored ([#32](https://github.com/UnderMyBed/bitburner-agent/issues/32)). The baseline scenario is [#33](https://github.com/UnderMyBed/bitburner-agent/issues/33); the reflex adapters come later.

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

## Checks

`test/fork.test.ts`:
- every file matches the manifest byte for byte, with nothing missing or extra; `forkFiles()` gives exactly those bytes; `PROVENANCE.md` agrees with the manifest
- every script parses and resolves its imports in the simulator, and the game's RAM calculator costs it (this doesn't run the scripts)
- `autopilot.js --disable-casino`, on 64 GB of home RAM, runs 10 virtual minutes with its managers (`daemon.js`, `stockmaster.js`, `go.js`) and no `ReferenceError`. `stats.js` gets past `eval("document")`, then fails on the game's HUD elements, which a headless game doesn't render. `--disable-casino`: `casino.js` plays through the game's page and reloads the game, which a headless run can't.

Biome and the typecheck skip `fork/`: it's someone else's code, kept as it is.

## How the fork behaves headless

- **On 8 GB of home RAM without SF4,** `autopilot.js` starts `daemon.js` and exits, saying home RAM is too small to keep it running and that a player should run it again after buying RAM (`autopilot.js` `shouldWeKeepRunning`).
- **On 8 GB with SF4 (the baseline's BN1 + SF4.3),** it stays up in principle, but its temp scripts (`getNsDataThroughFile`) don't fit in RAM: it can't read its Source-Files, falls back to "no SF4", and exits the same way. `daemon.js` then schedules nothing, because its `analyze-hack.js` helper doesn't fit beside it on home either. Both are the game's own RAM checks. In the fork's design, the player buys the first home RAM upgrades by hand; with 64 GB it runs as intended. What the baseline does about this is for #33.
- **The page:** scripts that draw on the game's page (`stats.js`'s HUD, `casino.js`, `scan.js`) find nothing to draw on headless.
