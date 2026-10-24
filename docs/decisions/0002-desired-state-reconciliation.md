# 0002 — Desired-state reconciliation instead of command streams

- **Status:** Accepted (2026-10-24)

## Context
The brain and the game connect over a link that can drop, duplicate or reorder messages. In-game scripts die on every aug install and BitNode change. An imperative command stream ("buy X", "start Y") under those conditions produces double purchases, lost commands and drift.

## Decision
The brain publishes a versioned, declarative **desired state**: activity configurations, player focus, and one-shot **intents**. Each intent carries an idempotency key and a guard. The in-game reconciler diffs desired state against observed state and converges toward it with idempotent steps. Intent outcomes are persisted on `home`, which survives aug installs.

Irreversible intents (install, BitNode change, exclusive faction join) additionally require their guard to hold on two consecutive snapshots.

## Consequences
- Dropped, duplicated or replayed messages are harmless; the next reconcile recomputes the difference.
- Any component can restart at any time and rebuild its state from a snapshot (crash-only design).
- Reconciler logic must be written as "observe → diff → act", which is slightly more work than issuing commands but is directly property-testable.
