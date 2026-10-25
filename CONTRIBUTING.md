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
| Scenario / chaos | Seeded full runs in the headless simulator; injected failures | On demand, and before every release |
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
- **Clear and simple beats clever.** If a reviewer needs the PR description to understand the code, the code isn't clear yet.
- **Performance matters in game:** every in-game bundle has a RAM budget enforced in CI.
- **Docs are part of done:** behaviour changes update the relevant doc in the same PR. Design changes get an ADR in [`docs/decisions/`](docs/decisions/).

## Setup

Requires Node 24 (see `.node-version`).

```sh
git clone --recurse-submodules https://github.com/UnderMyBed/bitburner-agent.git
cd bitburner-agent
npm ci
npm run setup:engine # the game's own dependencies, needed by the simulator (packages/sim)
npm run check        # typecheck + lint/format + tests: the same gates CI runs
```

| Command | What it does |
|---|---|
| `npm run typecheck` | Two steps. First TypeScript, strict (unused locals/parameters are errors), every `.ts` file under `packages/` and `tools/` except the simulator's bundled sources. Then those bundled sources, against the game's types with the game's own TypeScript and options; this needs `npm run setup:engine` (see [`packages/sim`](packages/sim/README.md#typecheck-boundary)). No emit: Node runs `.ts` directly |
| `npm run lint` / `npm run lint:fix` | Biome lint and format check, warnings are errors / apply fixes |
| `npm test` / `npm run test:watch` | Vitest: every `*.test.ts` under `packages/` and `tools/`. Builds the engine bundle first if it's stale, so it needs `npm run setup:engine` once |
| `npm run setup:engine` / `npm run build:engine` | Install the game's dependencies / bundle the engine for the simulator ([`packages/sim`](packages/sim/README.md)) |
| `npm run sim -- <scenario.json>` | Run a simulator scenario across seeds and print the results ([docs/sim/scenarios.md](docs/sim/scenarios.md)) |
| `npm run bench -w @bitburner-agent/sim` | Benchmark the simulator's speed and memory and record a row ([docs/sim/benchmarks.md](docs/sim/benchmarks.md)); before releases, not in CI |

Code lives in npm workspaces under `packages/` (see architecture §12.2). `tools/` holds repository tooling run by Node, under the same gates, such as [`tools/upstream-watch`](tools/upstream-watch/README.md), the upstream `stable` and `dev` watchers. `spikes/` is throwaway and excluded from the gates. `packages/legacy/fork/` is vendored third-party JS: Biome skips it, it's never edited, `packages/legacy/test/fork.test.ts` checks its bytes, and `.claude/settings.json` keeps Claude Code from loading its `CLAUDE.md` as memory.

## Rules of engagement

The agent may only use what's reachable from inside the game: the Netscript API and the page's DOM/React state. No DevTools against a live game, no save editing, no game modifications. See the README. Test harnesses are exempt.

## Reporting issues

Use the issue forms:
- **Feedback** for play-testing observations and requests
- **Bug** for defects in this project's code
- **Task**, **Epic**, **Chore** and **Design question** for planned work

For gameplay problems, include the game version, the BitNode, and the agent's decision log around the event if you have it. Bugs in Bitburner itself belong in the [game's repo](https://github.com/bitburner-official/bitburner-src).
