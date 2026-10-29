# bitburner-agent

An autonomous agent that plays [Bitburner](https://github.com/bitburner-official/bitburner-src) from a fresh save to **every Source-File maxed**, unattended and repeatably.

> **Status: pre-alpha.** M2 is done ([v0.2.0](https://github.com/UnderMyBed/bitburner-agent/releases/tag/v0.2.0)): the walking skeleton runs on Steam. M2's brain deploys an observe-only Agent into the game, stores what it reports, backs up the save, serves a local dashboard and, on Windows, keeps Steam's game running. Its first live hour on Steam had no gaps. M1 ([v0.1.0](https://github.com/UnderMyBed/bitburner-agent/releases/tag/v0.1.0)) built the simulator and recorded the legacy fork's BN1 baseline, the bar the agent must beat. M3 is under way on `main`: the agent runs a hack loop on the servers it can root (#134), buys the TOR router and the port-opening programs through the game's page (#136), upgrades home's RAM the same way (#138), and does one-shot actions the owner can queue from the dashboard, travel among them (#141), and handles the game's routine dialogs (#143). See [Roadmap](#roadmap).

---

## Why this exists

Bitburner is a programming game: you write JavaScript that hacks servers, trades stocks, runs gangs and corporations, and eventually "destroys" BitNodes to earn permanent Source-Files. Community automation scripts already handle much of the game. They are hand-tuned rule sets, though: they follow a fixed BitNode order, make generic decisions, and need a human when something unexpected happens.

This project treats the game as a **control problem**. Almost every mechanic is either a closed-form formula or something we can simulate, so the agent can *calculate* the best move instead of following a script:

- **One system for every BitNode.** Per-node behaviour comes from data (multipliers, enabled mechanics, available win routes), not `if BN == x` branches.
- **Plans against a model of the game.** It estimates how long each route to victory will take, allocates scarce resources (player focus, RAM, money, sleeves) to the fastest one, and re-plans continuously.
- **Robust by construction.** Everything is crash-only and idempotent, survives reloads, aug installs and BitNode changes, and keeps making progress even when its planner is offline.
- **Proven in simulation.** A headless copy of the real game engine runs seeded scenarios, so "repeatable" is a measured pass rate, not a hope.

## How it works

```
┌──────────── Node.js "brain" ─────────────┐        ┌──────────── Bitburner (Steam) ────────────┐
│ world model → estimators → planner       │  WS    │ agent: snapshots state, reconciles toward │
│        → desired state ──────────────────┼───────►│        the desired state                  │
│ telemetry, decision log, dashboard       │◄───────┼─ reflexes: HWGW batcher, stocks, gang,    │
│ deployer (Remote File API)               │        │   Bladeburner, Go, Dark Net, corp …       │
└──────────────────────────────────────────┘        └───────────────────────────────────────────┘
                 ▲ same brain + same in-game code
┌────────────────┴─────────────────────────┐
│ simulator: real game engine in Node,     │
│ virtual clock, seeded RNG                │
└──────────────────────────────────────────┘
```

- **Brain (outside the game):** TypeScript. Reads game state, estimates rates using the game's own formula code, chooses a win route, decides when to install augmentations and which BitNode to enter next, and publishes a declarative *desired state*.
- **Agent (inside the game):** a tiny script (≤ 3 GB RAM) that converges the game toward that desired state with idempotent steps, and runs real-time "reflex" loops that need millisecond timing.
- **Simulator:** the real game engine (pinned as a submodule) running headless with a virtual clock. The same brain and in-game code run against it.

Full design: [`docs/architecture.md`](docs/architecture.md).

## Rules it plays by

| Allowed | Not allowed |
|---|---|
| Anything reachable from inside the game through the Netscript API or the page's DOM/React state | Browser DevTools or the Chrome DevTools Protocol against the live game |
| Predicting seeded game RNG from in-game state | Editing save files |
| Official API parameters, e.g. `sourceFileOverrides` | Modifying game code, or using the dev menu |

Test harnesses (simulator, source builds) may use any tooling. The rules govern the agent playing a real game.

## Roadmap

| Milestone | Deliverable | Status |
|---|---|---|
| Design | Mechanics analysis, architecture, decision records | ✅ |
| S1 | Simulator spike: prove the real engine runs headless in Node, deterministically, fast | ✅ [report](docs/spikes/s1-headless-engine.md) |
| M1 | Toolchain and CI, then the simulator core: headless engine, virtual clock, seeded RNG, worker pool; the legacy fork's BN1 baseline | ✅ [v0.1.0](https://github.com/UnderMyBed/bitburner-agent/releases/tag/v0.1.0) |
| M2 | Walking skeleton: bridge, in-game agent, telemetry, dashboard (observe-only), automatic recovery | ✅ [v0.2.0](https://github.com/UnderMyBed/bitburner-agent/releases/tag/v0.2.0) |
| M3 | Effectors (UI and Singularity backends), the reconciler, restart-after-reset | ⏳ in progress: the hack loop (#134), its move to a better target without an income stall, and the `incomeStalled` alert (#184), and its hacks kept from draining the target (#187), buying the hacking programs (#136), upgrading home RAM (#138), intents and travel (#141), the game's dialogs (#143), the Singularity and simulator backends (#145), joining factions behind the irreversible intent gate (#147), buying augmentations (#149), faction work as an activity, focus kept through page actions (#151), company work (#153) and its promotions (#155), crime (#156), classes (#158), buying cloud servers (#159), safe mode with the brain down (#160), backdoors through the terminal (#162), and the fresh-save tutorial shown to be the owner's one click, since the game won't start the Agent while it runs (#168), installing augmentations and the restart after it, through the page too (#164, #167), and destroying the BitNode and the restart after it, through the page too (#175, #177); and `npm run report`, the run report a live run is checked with (#185) |
| M4 | Phase A, a playable BN1: choices computed from the game's formulas, slice by slice, each measured by a live Steam run; **the live campaign starts at BN1.1 from a fresh save** with it. Phase B: the fast model and planner v0, which replace phase A's choices where they do better in sim | ⏳ phase A started ([owner decision 46](docs/decisions/owner-decisions.md)) |
| M5+ | More activities and actions: gangs, Bladeburner, stocks, hacknet, corporations, Dark Net, sleeves, Stanek, IPvGO … | |
| M6 | Campaign selector, calibration loop | |

Working plan: [`docs/plan.md`](docs/plan.md). Detailed work is tracked in [GitHub milestones](https://github.com/UnderMyBed/bitburner-agent/milestones) and issues.

## Documentation

| Doc | What's in it |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | System design, requirements, test strategy, milestones |
| [`docs/decisions/`](docs/decisions/) | Architecture decision records, and the [owner decisions log](docs/decisions/owner-decisions.md) |
| [`docs/synthesis.md`](docs/synthesis.md) | The analysis in one page: what the game is and how to beat it |
| [`docs/mechanics/`](docs/mechanics/) | First-principles mechanics references with `file:line` citations into the game source |
| [`docs/research/`](docs/research/) | Community tooling, benchmarks and strategies |
| [`docs/releasing.md`](docs/releasing.md) | How a release is made: versions, the pre-release checklist, notes, commands |
| [`docs/m3-smoke-test.md`](docs/m3-smoke-test.md) | M3's Steam smoke test: each effector on the owner's own game, in one sitting, and the decisions still open |
| [`docs/spikes/`](docs/spikes/) | Spike reports; the throwaway code is in [`spikes/`](spikes/) |
| [`docs/bridge/`](docs/bridge/) | The brain's connections to the game: the control channel's [protocol](docs/bridge/protocol.md), and deploying over the Remote File API |
| [`docs/sim/`](docs/sim/) | The simulator: its browser [parity audit](docs/sim/parity.md) (what the browser and UI provide, and what the simulator does about each), [scenarios](docs/sim/scenarios.md) (running workloads across seeds), [benchmarks](docs/sim/benchmarks.md) (speed and memory per release) and [baselines](docs/sim/baselines.md) (the legacy fork's progress, which the agent must beat) |

## Supported game version

Bitburner **v3.0.1** (VersionNumber 51), the current Steam release. The game source is pinned at `vendor/bitburner-src`. Every release runs two workflows that watch upstream: `stable` for the next Steam release ([ADR 0003](docs/decisions/0003-game-version-pinning.md)) and `dev` for changes further ahead ([ADR 0005](docs/decisions/0005-forward-compat-dev-branch.md), [`tools/upstream-watch`](tools/upstream-watch/README.md)).

## Getting started

Since M2 ([v0.2.0](https://github.com/UnderMyBed/bitburner-agent/releases/tag/v0.2.0)), the brain (`npm run brain`, [packages/brain](packages/brain/README.md)) deploys the in-game Agent, stores what it reports, backs up the save, serves a dashboard at http://127.0.0.1:12527/, and on Windows keeps Steam's game running while it runs. On `main` (M3), it also runs a hack loop on the servers it can root, and buys the hacking programs, both on by default; the dashboard's switches stop them. Everything runs from the repo, and nothing is installed outside it (npm's own download cache aside): to run it against Steam, follow **[docs/setup.md](docs/setup.md)**. The simulator runs too, with the legacy fork's baseline in it. You need Node 24 (`.node-version`) and git.

```sh
git clone https://github.com/UnderMyBed/bitburner-agent.git
cd bitburner-agent
npm run bootstrap   # the game's source (submodule), the packages, the game's own dependencies; again after a game bump
```

Then:

```sh
# Four seeds of a 6-virtual-hour hack loop, one at a time: each seed takes about a second.
# The first run builds the engine bundle before it starts, which takes longer.
npm run sim -- packages/sim/scenarios/lean.json --workers 1

# One seed of the legacy fork's BN1 baseline, to 12 virtual hours: about 6 real minutes.
npm run baseline -w @bitburner-agent/legacy -- --seeds 1
```

The simulator is deterministic: a seed gives the same state hash every time, on any machine. More in [scenarios](docs/sim/scenarios.md), [baselines](docs/sim/baselines.md) and the [simulator's README](packages/sim/README.md). [CONTRIBUTING](CONTRIBUTING.md) covers the checks (`npm run check`).

The end-to-end tests run the real game, built from the same pinned source, in a browser: [`packages/e2`](packages/e2/README.md).

## Contributing

This is a personal project made public. Issues and PRs are welcome, but there is no support commitment. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the development process, which is strict test-first with automated merge gates.

## Acknowledgements

- The [Bitburner](https://github.com/bitburner-official/bitburner-src) developers and community.
- [alainbryden/bitburner-scripts](https://github.com/alainbryden/bitburner-scripts), the automation suite this project grew out of. Parts of it run as legacy reflexes during migration.

## License

[MIT](LICENSE). Bitburner itself is licensed separately (Apache 2.0 with Commons Clause). It is referenced as a submodule and is not part of this project's source. Any code ported from the game lives under a clearly marked directory carrying the game's license notice. [`packages/legacy/fork/`](packages/legacy/fork/) is the retired legacy fork's code, MIT © 2021 Alain Bryden, vendored unchanged with its license ([provenance](packages/legacy/PROVENANCE.md)).

*Not affiliated with or endorsed by the Bitburner developers.*
