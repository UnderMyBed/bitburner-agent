# 0001 — The planning brain runs outside the game

- **Status:** Accepted (2026-10-24)

## Context
In-game scripts pay RAM for every Netscript identifier they reference. A fresh save starts with 8 GB of home RAM. Existing automation puts all logic in game, which forces RAM-dodging tricks, file-based IPC and untestable code.

Verified in the 3.0.1 source:
- Only the `document` and `window` identifiers carry a special RAM cost. `WebSocket` is free.
- Electron disables background throttling, so the game runs at full speed when minimised.

## Decision
The planner, estimators, campaign logic, telemetry and any supervisor run in a **Node.js/TypeScript process** (the "brain"). The game runs only:
- a small agent (≤ 3 GB) that snapshots state and reconciles toward the brain's desired state, and
- real-time "reflexes" that need millisecond timing or direct NS access (batcher, stock trader, gang ticker, …).

They communicate over a WebSocket that the in-game agent opens to the brain.

## Consequences
- **Positive:**
  - No RAM ceiling on decision logic.
  - Real types, tests and libraries.
  - The game's own formula code can be imported, so estimates are exact.
  - The same brain drives the real game and the simulator.
- **Negative:** a second process must be running. This is mitigated by safe mode: if the brain is absent, the agent keeps running the last desired state without irreversible actions, so progress continues and only optimality is lost.
- **Negative:** one more transport hop. Irrelevant at decision cadences of a second or more; sub-second loops stay in game.
