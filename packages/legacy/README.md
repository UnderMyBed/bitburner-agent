# @bitburner-agent/legacy

The legacy fork's scripts, vendored unchanged, for:
- **the baseline now.** The fork's BN1 time-to-destroy from a BN1 + SF4.3 start is what the agent is measured against (architecture §12.3; the baseline scenario is #33).
- **reference behaviour later.** Its "reflexes" (contract solving, backdoors, hacknet spending) are known-good behaviour to compare ours with.

The files are in [`fork/`](fork/), exactly as recorded: [`PROVENANCE.md`](PROVENANCE.md) says where they came from, and the rules (never edited in place; a change is a patch). They're MIT-licensed, © 2021 Alain Bryden ([`fork/LICENSE`](fork/LICENSE)).

```ts
import { forkFiles, FORK } from "@bitburner-agent/legacy";

for (const { path, content } of forkFiles()) if (path.endsWith(".js")) await sim.writeFile("home", path, content);
```

- `forkFiles()`: every vendored file, in path order, as text.
- `forkManifest()`: the sha256 of each file.
- `FORK`: the source repository and commit.

## Checks

`test/fork.test.ts`:
- every file matches the manifest, byte for byte, and nothing is missing or extra
- every `.js` file compiles in the simulator, and the game computes its RAM cost
- `autopilot.js --disable-casino` runs 10 virtual minutes on a new game with no browser-global `ReferenceError` (the fork uses `_` and `sprintf` as globals), and leaves `daemon.js` running

Biome and the typecheck skip `fork/`: it's someone else's code, kept as it is.

## How the fork behaves headless

On a new game (8 GB of home RAM, no SF4), `autopilot.js` starts `daemon.js`, then exits: it says home RAM is too small to keep it running, and that a player should run it again after buying RAM. A baseline run has to allow for that (#33).