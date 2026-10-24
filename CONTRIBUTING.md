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

### How work flows ([ADR 0008](docs/decisions/0008-work-tracking-and-reviews.md))
1. **Milestones** (M1–M6) are GitHub milestones. Each has **epics**, and each epic has **task** sub-issues.
2. **A task issue is the spec:** design, implementation plan, acceptance criteria, test plan, docs to update. Tasks for a milestone are written in full when it becomes active, and the plan is reviewed against the architecture before building starts.
3. **Branch, build test-first, open a PR** that closes the task (`Closes #n`), using the PR template.
4. **Three-pass review**, each pass by a separate fresh-context reviewer:
   - **Spec:** acceptance criteria met, with evidence.
   - **Correctness and tests:** bugs, edge cases, and tests that would catch regressions.
   - **Docs and maintainability.**

   Findings are recorded in one PR comment. Each is fixed, answered, or deferred to a `from-review` issue.
5. **Merge** when CI passes and the review is resolved (squash only).
6. **Close the milestone** with a milestone review against its exit criteria, then tag a release.

Owner decisions too small for an ADR go in the [owner decisions log](docs/decisions/owner-decisions.md).

### Merge gate
- `main` is protected by a repository ruleset with no bypass. Every change lands through a PR, and the `check` CI job must pass on an up-to-date branch.
- A PR merges only when **all required CI checks pass** *and* the **three-pass review** has been addressed.
- Releases are tagged from `main` and include notes on what changed, what to try, and known issues.

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
npm run check        # typecheck + lint/format + tests: the same gates CI runs
```

| Command | What it does |
|---|---|
| `npm run typecheck` | TypeScript, strict (unused locals/parameters are errors), every `.ts` file under `packages/` (no emit; Node runs `.ts` directly) |
| `npm run lint` / `npm run lint:fix` | Biome lint and format check, warnings are errors / apply fixes |
| `npm test` / `npm run test:watch` | Vitest: every `*.test.ts` under `packages/` |

Code lives in npm workspaces under `packages/` (see architecture §12.2). `spikes/` is throwaway and excluded from the gates.

## Rules of engagement

The agent may only use what's reachable from inside the game: the Netscript API and the page's DOM/React state. No DevTools against a live game, no save editing, no game modifications. See the README. Test harnesses are exempt.

## Reporting issues

Use the issue forms: **Bug** for this project's code, **Task**/**Epic**/**Design question** for planned work. For gameplay problems, include the game version, the BitNode, and the agent's decision log around the event if you have it. Bugs in Bitburner itself belong in the [game's repo](https://github.com/bitburner-official/bitburner-src).
