# 0009 — The upstream watchers run on demand

- **Status:** Accepted (2026-10-24)
- **Amends:** [0003](0003-game-version-pinning.md) (when the `stable` watcher runs), [0005](0005-forward-compat-dev-branch.md) (when and how the `dev` forward check runs)

## Context
ADR 0003 has a scheduled workflow watch upstream `stable`. ADR 0005 has the forward check against `dev` run weekly and on demand. The owner decided this project has no scheduled runs: heavy suites already run on demand and before every release (owner decisions log #7). The watchers are now included too (#24).

Building the forward check ([`tools/upstream-watch`](../../tools/upstream-watch/README.md), #21) also settled two details that ADR 0005's table got wrong:
- It sparse-fetches nothing. It makes a blobless clone of the game's repository: full history, with file contents fetched only when read. That is cheap, and `git log pinned..dev` needs the history anyway.
- It reports every function's RAM cost change, not only those of functions we use. We have no list of the functions we use until the in-game code exists (#42), and the full list is short.

## Decision
- **Both watchers run only on demand** (`workflow_dispatch`), never on a schedule: the `dev` forward check and the `stable` watcher.
- **Every release runs them**, as part of the heavy suites in [releasing](../releasing.md) step 2. Anyone can also run them at any time, for example before bumping the pinned game or when a game update is announced.
- The forward check works as built: a blobless clone, the whole RAM cost table, and one tracking issue. Everything else in ADR 0005 stands: it is advisory and never blocks a merge.

## Consequences
- An upstream change is seen at the next release or manual run, not within a week. The `stable` watcher may notice a Steam update only after Steam ships it. Then the runtime **hold** (ADR 0003) is what keeps the agent safe until the bump lands.
- No scheduled job uses Actions minutes, and none fails unnoticed between releases.
