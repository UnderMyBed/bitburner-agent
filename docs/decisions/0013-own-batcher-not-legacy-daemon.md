# 0013 — Our own batcher instead of legacy daemon.js

- **Status:** Accepted (2026-10-29), flagged to the owner, who may overrule it
- **Amends:** [architecture §5.5 and §12.3](../architecture.md#55-reflexes) ("Legacy `daemon.js` first; possible rewrite later")

## Context
The HWGW batcher is a reflex: real-time, in game (§5.5). The plan was to run the retired fork's `daemon.js` under the Agent through a `legacy/` adapter until a replacement proved at least as good in the simulator (§12.3). M4 phase A (#191) replaces the hack loop with a batcher (slice A7, #204–#206). Owner decision 46 says the brain's choices are computed from the game's formulas, tested and loud. Measured against that, `daemon.js`:
- **decides strategy itself:** it picks its targets, prepares several at once, and buys servers through its `host-manager.js` helper. §5.5 says a reflex never decides strategy, and decision 46 says the brain does. Its helpers can be turned off (`--disable-script host-manager.js`), but its targeting can't;
- **schedules nothing on an 8 GB home:** its `analyze-hack.js` helper doesn't fit beside it (`packages/legacy/README.md`), and it's built to keep `--reserved-ram 32` on home;
- **is quiet by default:** `--silent-misfires` is on, and misfires are absorbed by doubling the grow and weaken threads (`--recovery-thread-padding 2`);
- **can't be unit-tested:** 2,451 lines with `helpers.js`, whose temp scripts leak a compiled module each (R10, Q7).

## Decision
- **The batcher is our own:** core's batch maths (`packages/core/src/batcher.ts`), unit-tested and checked against the engine's formulas, and a thin in-game `batcher.js` with three operation scripts ([`packages/ingame`](../../packages/ingame/README.md#the-batcher)). The brain chooses target, share and spacing (#206); the batcher only times, launches and checks.
- **It's loud:** every landing is checked in order, the target against the bounds a batch in step keeps it within, and each desync, late, lost or skipped operation is counted in its health, which becomes an alert and a run-report failure (#205, #206).
- **`daemon.js` stays only in the baseline:** phase B's fork baseline runs it in the simulator (§12.3, ADR 0011).

## Consequences
- **§12.3's bar isn't checked yet.** Nothing has measured our batcher against `daemon.js`. #204 measures it against A1's batcher ceiling and the hack loop: 32.1–32.9% of the ceiling in 10 minutes on n00dles (the only no-port target a fresh start can prepare), against the hack loop's best 10 minutes of 18.3–19.9%. Until phase B's baseline compares the two, this is an exception to §12.3, not an instance of it.
- **New timing code carries risk** the fork's has already been through in play. The simulator's clock is virtual, so script starts take no time there; E2 on the real page (#205) and the batcher's own checks cover what it can't.
- **The batcher is about 3.85 GB** and runs anywhere: on a fresh start's no-port servers when home is full (#205 decides where).
- **If the owner overrules,** #205's adapter runs `daemon.js` with `--disable-script host-manager.js` instead, and the batcher's health checks stand in front of it.
