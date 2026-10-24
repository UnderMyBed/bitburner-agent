# 0005 — Forward-compatibility checks against upstream `dev`

- **Status:** Accepted (2026-10-24)
- **Extends:** [0003](0003-game-version-pinning.md)

## Context
Steam is deliberately **not** pinned: the owner takes game updates as Steam ships them. ADR 0003's `stable` watcher reacts when a release is cut, which can be close to when Steam updates. Upstream `dev` already shows what the next release will contain. Unreleased changes as of 2026-10:
- the darknet Red Pill removed in BN12
- `destroyW0r1dD43m0n` able to return to the BitVerse
- `promoteStock` requiring TIX access
- a new darknet augmentation

We want early warning about breaking changes without paying for full test runs against a moving target.

## Decision
A **cheap, advisory, non-blocking** forward check against upstream `dev`:

| Check | How | Cost |
|---|---|---|
| API surface diff | Sparse-fetch `src/ScriptEditor/NetscriptDefinitions.d.ts` from `dev` and diff it against the pinned version: added, removed and changed signatures, enums, constants | Seconds |
| Contract typecheck | Type-check our in-game bundles against `dev`'s definitions | Seconds |
| RAM cost diff | Sparse-fetch `src/Netscript/RamCostGenerator.ts`; report cost changes for functions we use | Seconds |
| Watched-source log | `git log pinned..dev` on a watchlist of game source files our estimators and mechanics docs depend on (formulas, BitNode multipliers, constants, darknet, corp…), listing commit titles | Seconds |

- **Advisory only.** It is never a required check and never blocks a merge.
- **Runs** weekly on a schedule and on demand. A full game checkout, build and simulator run against `dev` are out of scope.
- **Single output:** one tracking issue ("Upcoming game changes") updated in place, so there is never a stream of new issues. It is closed when the forward diff is empty.
- The watchlist lives in the repo and grows as capabilities come to depend on more game source.

## Consequences
- Breaking API and RAM changes are visible weeks before they reach Steam, so fixes can land ahead of time behind feature detection where needed.
- **Blind spot:** behaviour changes that don't touch the API (e.g. Red Pill sources) show up only as watched-source commit titles. They need human or agent judgement to assess.
- When a forward change is confirmed for release, the agent should handle both versions through runtime feature detection, keyed on `VersionNumber`, rather than branching code per version where possible.
