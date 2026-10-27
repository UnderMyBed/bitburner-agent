# Contributing

This is a personal project made public. Contributions are welcome, but nobody is obliged to review or merge them quickly. Please read this before opening a PR.

## Development process

### Test first, always
Every change to logic starts with a failing test. The bar is "a test would catch this regression", not a coverage number.

| Layer | What it checks | When it runs |
|---|---|---|
| Unit | Pure logic: estimators, planner, reconciler diffing | Every PR (CI) |
| Formula parity | Our estimators match the game's own formula functions exactly | Every PR (CI) |
| Property | Planner, reconciler and protocol invariants under randomised inputs | Every PR (CI) |
| Contract | In-game bundles type-check against the pinned game's API definitions; static RAM within budget | Every PR (CI) |
| Integration | The brain, bridge and in-game code together in the headless simulator, including the skeleton suite (`packages/brain`) | Every PR (CI) |
| Scenario / chaos | Seeded full runs in the headless simulator; injected failures | On demand, and before every release; the BN1 baseline only when it can change ([releasing](docs/releasing.md) step 2) |
| End-to-end | Real game UI in a source build, driven by Playwright | On demand, and before every release |

Mutation testing runs periodically on core logic to check that the tests actually catch broken code.

### How work flows
This section is the canonical procedure. [ADR 0008](docs/decisions/0008-work-tracking-and-reviews.md) records why it works this way.

**Where things are tracked**
- **Milestones** (M1–M6) are [GitHub milestones](https://github.com/UnderMyBed/bitburner-agent/milestones). Their exit criteria are canonical in [architecture §13](docs/architecture.md#13-milestones).
- Each milestone has **epics**. Each epic has **task** sub-issues; the sub-issue link is the canonical parent.
- The [project board](https://github.com/users/UnderMyBed/projects/3) shows every issue and PR by status: Todo, In Progress, In Review, Done. New issues are added to it when created.
- **Labels:**
  - `type:` epic, task, chore, bug, question or feedback
  - `area:` the package or concern
  - `from-review`: a deferred review finding
  - `blocked`
  - `upstream-watch`: the upstream watchers' tracking issues ([`tools/upstream-watch`](tools/upstream-watch/README.md)); `publish` needs it to exist
- Owner decisions too small for an ADR go in the [owner decisions log](docs/decisions/owner-decisions.md).

**The cycle**
1. **Plan.** When a milestone becomes active, write its tasks in full using the Task form: design, implementation plan, acceptance criteria, test plan, docs. Later milestones stay as epics until then.
   - A reviewer then checks the whole milestone plan against the architecture: complete, consistent, testable.
   - The plan review's findings and their resolution are posted on the milestone's **review issue** ("Mx reviews", label `area:process`), which also holds the milestone review at the end.
2. **Build.** Branch, test first, and open a PR that closes its issue (`Closes #n`), using the PR template.
   - If the spec turns out to be wrong, update the issue (and the architecture or ADR) in the same PR, so the change is visible.
3. **Review: three passes.** Each pass is a separate reviewer that sees only the diff, the issue and the docs it links. It never sees the author's reasoning; in this project the reviewers are fresh AI-agent sessions. The passes run in parallel.

   | Pass | Checks against | Looks for |
   |---|---|---|
   | 1. Spec | The issue and its linked architecture sections and ADRs | Every acceptance criterion met, with evidence; deviations justified and the spec updated; nothing missing; no scope creep |
   | 2. Correctness and tests | The code and its tests | Bugs, edge cases, failure modes, determinism, performance; whether tests would catch a regression |
   | 3. Docs and maintainability | Docs and code quality | Docs updated or created; clarity, simplicity, conventions; fit with the architecture |

   - **Severity:** each finding is a **blocker** (must fix before merge), **should-fix** (fix now unless answered with a reason) or **nit** (optional).
   - **Record:** all findings go into one PR comment, as a table:

     | # | Pass | Severity | Finding | Resolution |
     |---|---|---|---|---|
     | 1 | 2 | should-fix | Unused imports pass the gates | Fixed: `noUnusedLocals`; verified with a probe file |

   - Every finding is fixed, answered, or deferred to a `from-review` issue.
   - **Trivial changes** (typo, version bump) may run one combined pass; the PR says so.
4. **Merge** when CI passes and the review is resolved. Merges are squash only.
5. **Close the milestone.** Run a milestone review:
   - every exit criterion verified with evidence
   - all of the milestone's issues closed or explicitly moved
   - docs consistent with what was built

   Record it on the milestone's review issue, then tag a release: [docs/releasing.md](docs/releasing.md).

**Lighter paths**
- **Chores** (dependency bumps, CI tweaks) use the Chore form: what and why, and how it's verified.
- **Automated PRs** state their reason in the PR body instead of closing an issue.
- **Feedback** from play-testing (observations, requests) uses the Feedback form. It's triaged into tasks, bugs or questions.

### Merge gate
- `main` is protected by a repository ruleset with no bypass. Every change lands through a PR, and the `check` CI job must pass on an up-to-date branch.
- A PR merges only when **all required CI checks pass** *and* the **three-pass review** is resolved.
- Releases are tagged from `main` and include notes on what changed, what to try, and known issues ([docs/releasing.md](docs/releasing.md)).

### Code standards
- **The coding standards in [CLAUDE.md](CLAUDE.md#global-coding-standards) apply to all code:** YAGNI, DRY after the second duplication, fail fast, simple first, delete aggressively, and verbose, self-documenting names.
- **Clear and simple beats clever.** If a reviewer needs the PR description to understand the code, the code isn't clear yet.
- **Performance matters in game:** every in-game bundle has a RAM budget (`packages/ingame/ram-budget.json`) enforced in CI. In-game code never names anything like an NS function: the game charges RAM by name ([`packages/ingame`](packages/ingame/README.md#ram)).
- **Docs are part of done:** behaviour changes update the relevant doc in the same PR. Design changes get an ADR in [`docs/decisions/`](docs/decisions/).

## Setup

Requires Node 24 (see `.node-version`) and git.

```sh
git clone https://github.com/UnderMyBed/bitburner-agent.git
cd bitburner-agent
npm run bootstrap    # the submodule, npm ci, and the game's own dependencies (npm run setup:engine)
npm run check        # typecheck + lint/format + tests: the same gates CI runs
```

Everything stays in the repo: nothing is installed outside it, npm's own download cache aside (owner decision 30).

| Command | What it does |
|---|---|
| `npm run typecheck` | Two steps. First TypeScript, strict (unused locals/parameters are errors): every `tsconfig.json` in the repository, each in its own environment ([TypeScript configs](#typescript-configs)), failing if any `.ts` file isn't covered by one. Then the simulator's bundled sources, against the game's types with the game's own TypeScript and options; this needs `npm run setup:engine` (see [`packages/sim`](packages/sim/README.md#typecheck-boundary)). No emit: Node runs `.ts` directly |
| `npm run lint` / `npm run lint:fix` | Biome lint and format check, warnings are errors / apply fixes |
| `npm test` / `npm run test:watch` | Vitest: every `*.test.ts` under `packages/` and `tools/`, except E2's `*.e2.test.ts`. Builds the engine bundle first if it's stale, so it needs `npm run setup:engine` once |
| `npm run e2:build` / `npm run e2:install` / `npm run e2` | E2 ([`packages/e2`](packages/e2/README.md)): build the pinned game from the submodule into `.cache/e2/<commit>/` (once per commit, about 90 s) / download Playwright's Chromium headless shell into `.cache/e2/browsers/` (once) / run the E2 tests (`*.e2.test.ts`). A heavy tier: on demand when touching `ingame/` or `bridge/`, and before releases, not in CI |
| `npm run bootstrap` | A clone to working: the `vendor/bitburner-src` submodule, `npm ci`, then `npm run setup:engine`. Says each step, stops at the first failure, safe to run again ([`tools/bootstrap`](tools/bootstrap/bootstrap.ts)) |
| `npm run brain [-- --data-dir <dir>]` | Run the brain process, from the repo, until stopped (Ctrl+C), started again after a crash: the control channel, the deployer, the save backups, the telemetry store, the dashboard on `127.0.0.1:12527`, and (an E0 brain on Windows) the game's supervisor. Its data is in the repo's `.data/` unless given another ([`packages/brain`](packages/brain/README.md), [docs/setup.md](docs/setup.md)). Tests always give their own data directory |
| `npm run gaps -- [--data-dir <dir>] --since <ISO time>` | List gaps in the stored fast snapshots, and the page heap over the window; exits 0 only when there are no gaps ([`packages/brain`](packages/brain/README.md#the-gap-report)) |
| `npm run build -w @bitburner-agent/ingame` | Bundle the in-game scripts into `packages/ingame/dist/`, with a manifest ([`packages/ingame`](packages/ingame/README.md)). Tests build their own copy |
| `npm run setup:engine` / `npm run build:engine` | Install the game's dependencies / bundle the engine for the simulator ([`packages/sim`](packages/sim/README.md)) |
| `npm run sim -- <scenario.json>` | Run a simulator scenario across seeds and print the results ([docs/sim/scenarios.md](docs/sim/scenarios.md)) |
| `npm run bench -w @bitburner-agent/sim` | Benchmark the simulator's speed and memory and record a row ([docs/sim/benchmarks.md](docs/sim/benchmarks.md)); before releases, not in CI |
| `npm run baseline -w @bitburner-agent/legacy` | Run the legacy fork's BN1 baseline to 4, 8 and 12 virtual hours over seeds 1–8 and print its rows ([docs/sim/baselines.md](docs/sim/baselines.md)); about an hour on one core; when it can change ([releasing](docs/releasing.md) step 2), not in CI |

Code lives in npm workspaces under `packages/` (see architecture §12.2). `tools/` holds repository tooling run by Node, under the same gates, such as [`tools/upstream-watch`](tools/upstream-watch/README.md), the upstream `stable` and `dev` watchers. `spikes/` is throwaway and excluded from the gates. `packages/legacy/fork/` is vendored third-party JS: Biome skips it, it's never edited, `packages/legacy/test/fork.test.ts` checks its bytes, and `.claude/settings.json` keeps Claude Code from loading its `CLAUDE.md` as memory.

### TypeScript configs

Code runs in three environments, and each file is typechecked in its own (architecture §12.2):

| Files | Config | Environment |
|---|---|---|
| `packages/core/src` | `packages/core/tsconfig.json` | Neither: imported by in-game and Node code alike, so no DOM and no Node types |
| `packages/ingame/src` | `packages/ingame/src/tsconfig.json` | The game's page: the DOM, no Node, and the NS API from the pinned game's definitions as `@nsdefs` |
| `packages/ingame/test/agent` | `packages/ingame/test/agent/tsconfig.json` (extends `src`'s) | The same: unit tests of the Agent's modules, which import in-game sources (#136) |
| Everything else: other packages, the tests, build scripts, `tools/`, the root's own files | the package's `tsconfig.json` (for `ingame`, its build script and tests); `packages/core/test/tsconfig.json` for `core`'s tests; `tools/tsconfig.json`; the root `tsconfig.json` | Node (`packages/e2`: Node and the DOM) |

- Every config extends `tsconfig.base.json` (the shared strict options, environment-neutral) or `tsconfig.node.json` (the same, plus Node types).
- **Types can arrive through imports.** `@types/jsdom` brings the DOM into any program that imports it: `packages/sim` (its host emulates the game's page with jsdom), `packages/brain` (its dashboard page test) and the root's `vitest.config.ts` (through `vitest/config`). Their configs' own options are still Node's.
- **`packages/e2` is Node plus the DOM** (`lib: ["es2024", "dom"]`): its harness runs in Node, and the functions it passes to Playwright's `page.evaluate` run in the page. `tools/typecheck`'s tests expect both.
- **A new package or folder of TypeScript needs a config.** A package that isn't Node code also needs a separate one for its tests, which run in Node. `ingame`'s tests test the built bundles in the simulator, and don't import in-game sources, except `test/agent/`, which has the in-game config for that.
- `npm run typecheck` (`tools/typecheck`) finds every `tsconfig.json` and fails on any TypeScript file none of them covers. Its tests check each config's environment with probe files, so a change that lets Node or the DOM back in fails CI.

## Rules of engagement

The agent may only use what's reachable from inside the game: the Netscript API and the page's DOM/React state. No DevTools against a live game, no save editing, no game modifications. See the README. Test harnesses are exempt.

## Reporting issues

Use the issue forms:
- **Feedback** for play-testing observations and requests
- **Bug** for defects in this project's code
- **Task**, **Epic**, **Chore** and **Design question** for planned work

For gameplay problems, include the game version, the BitNode, and the agent's decision log around the event if you have it. Bugs in Bitburner itself belong in the [game's repo](https://github.com/bitburner-official/bitburner-src).
