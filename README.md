# bitburner-agent

An autonomous agent that plays [Bitburner](https://github.com/bitburner-official/bitburner-src) from a fresh save to **every Source-File maxed**, unattended and repeatably.

> **Status: pre-alpha.** The architecture and a full mechanics analysis of the game are done, and a spike has proven the headless simulator. No agent code yet. See [Roadmap](#roadmap).

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
| M1 | Toolchain and CI, then the simulator core: headless engine, virtual clock, seeded RNG, worker pool | ⏳ active |
| M2 | Walking skeleton: bridge, in-game agent, telemetry, dashboard (observe-only), automatic recovery | |
| M3 | Effectors (UI and Singularity backends), restart-after-reset | |
| M4 | Fast model and planner v0: autonomous BitNode 1 clear in sim, then **the live campaign starts at BN1.1 from a fresh save** | |
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
| [`docs/spikes/`](docs/spikes/) | Spike reports; the throwaway code is in [`spikes/`](spikes/) |
| [`docs/sim/`](docs/sim/) | The simulator: its browser [parity audit](docs/sim/parity.md) (what the browser and UI provide, and what the simulator does about each), [scenarios](docs/sim/scenarios.md) (running workloads across seeds) and [benchmarks](docs/sim/benchmarks.md) (speed and memory per release) |

## Supported game version

Bitburner **v3.0.1** (VersionNumber 51), the current Steam release. The game source is pinned at `vendor/bitburner-src`. Every release runs two workflows that watch upstream: `stable` for the next Steam release ([ADR 0003](docs/decisions/0003-game-version-pinning.md)) and `dev` for changes further ahead ([ADR 0005](docs/decisions/0005-forward-compat-dev-branch.md), [`tools/upstream-watch`](tools/upstream-watch/README.md)).

## Getting started

Not usable yet. Once M1 lands this section will cover installing, connecting to the game, and running the simulator.

To browse the source with the pinned game engine:

```sh
git clone --recurse-submodules https://github.com/UnderMyBed/bitburner-agent.git
```

## Contributing

This is a personal project made public. Issues and PRs are welcome, but there is no support commitment. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the development process, which is strict test-first with automated merge gates.

## Acknowledgements

- The [Bitburner](https://github.com/bitburner-official/bitburner-src) developers and community.
- [alainbryden/bitburner-scripts](https://github.com/alainbryden/bitburner-scripts), the automation suite this project grew out of. Parts of it run as legacy reflexes during migration.

## License

[MIT](LICENSE). Bitburner itself is licensed separately (Apache 2.0 with Commons Clause). It is referenced as a submodule and is not part of this project's source. Any code ported from the game lives under a clearly marked directory carrying the game's license notice. [`packages/legacy/fork/`](packages/legacy/fork/) is the retired legacy fork's code, MIT © 2021 Alain Bryden, vendored unchanged with its license ([provenance](packages/legacy/PROVENANCE.md)).

*Not affiliated with or endorsed by the Bitburner developers.*
