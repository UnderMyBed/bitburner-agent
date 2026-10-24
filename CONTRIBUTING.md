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

### Merge gate
- `main` is protected. Every change lands through a PR.
- A PR merges only when **all required CI checks pass** *and* an **independent review** has been addressed. Each finding is either fixed or answered.
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
| `npm run typecheck` | TypeScript, strict, across all packages (no emit; Node runs `.ts` directly) |
| `npm run lint` / `npm run lint:fix` | Biome lint and format check / apply fixes |
| `npm test` / `npm run test:watch` | Vitest |

Code lives in npm workspaces under `packages/` (see architecture §12.2). `spikes/` is throwaway and excluded from the gates.

## Rules of engagement

The agent may only use what's reachable from inside the game: the Netscript API and the page's DOM/React state. No DevTools against a live game, no save editing, no game modifications. See the README. Test harnesses are exempt.

## Reporting issues

Use the issue templates. For gameplay problems, include the game version, the BitNode, and the agent's decision log around the event if you have it.
