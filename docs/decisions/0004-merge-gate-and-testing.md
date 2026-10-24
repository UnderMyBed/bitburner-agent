# 0004 — Merge gate and test regime

- **Status:** Accepted (2026-10-24)

## Context
The project is built largely autonomously by an AI coding agent, with a human owner who designs and play-tests but doesn't review every change. Trust therefore has to come from tests and automated gates rather than from humans reading diffs.

## Decision
- **Test first.** Every logic change starts with a failing test.
- **Fast tiers in CI on every PR:** unit, formula-parity (estimators against the game's own functions), property-based, contract (types against the pinned API definitions, plus in-game RAM budgets), lint and typecheck.
- **Heavy tiers on demand and before every release:** simulator scenario and chaos suites, and end-to-end tests on a source build. **No scheduled nightly runs.**
- **Periodic mutation testing** on core logic, to verify the tests catch real breakage.
- **Merge gate:** `main` is protected and changes land only through PRs. A PR merges when all required checks pass *and* an independent review has been addressed. The review is done by a separate reviewer with fresh context that sees only the diff and the spec; every finding is fixed or answered. Human review is optional.
- **Releases** are tagged from `main` with notes covering what changed, what to try, and known issues. The owner play-tests releases and feeds results back as issues.

## Consequences
- Autonomous building is safe only to the extent the tests are good, so test quality is a first-class deliverable.
- Heavy suites rely on discipline (run before release) rather than a timer.
