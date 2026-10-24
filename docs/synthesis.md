# Synthesis: Phase 0 + Phase 1 findings

Sources: `docs/mechanics/*.md` (7 references) and `docs/scripts-compat-audit.md`. Everything was read from the v3.0.1 source; **none of it has been tested in-game yet**.

## 1. The core insight: this is an engineering problem, not an ML problem

Every subsystem turned out to be closed-form or simulable:

| Subsystem | Nature | Approach |
|---|---|---|
| Hacking / HWGW | Exact formulas, no hidden state | Analytical scheduler (exists; tune it) |
| Stock market | Fully known model; 4S forecast = exact up-probability | Rule-based trader (exists) |
| Corporation | Production and valuation deterministic; only market walks random | Simulator + optimizer for round timing |
| Dark Net (~24 puzzles) | Every puzzle leaks enough to solve in closed form | Hand-written solvers; **no LLM needed** |
| IPvGO | AI is public, looks one move ahead; cheat RNG predictable from `totalPlaytime` | Search (expectimax/MCTS) + guaranteed cheats; **no RL needed** |
| Casino | Deck/RNG sit in React component state | Read the state and win deterministically |
| Infiltration | No play API; untrusted keys hospitalise you | React-internals driver |

ML and LLMs have narrow roles. Their best uses are as a **supervisor** that recovers from unexpected states, and for **tuning parameters** against a simulator. The binding constraint is **real wall-clock time**: about 42 node clears plus BN12.

## 2. Facts that shape the campaign

- **Levels 2 and 3 of a BitNode are exactly as hard as level 1** (except BN12). Run each node 3× back-to-back while its strategy is loaded.
- **Effective world-daemon difficulty, in hacking levels** (normalised to a hacking-level multiplier of 1): BN1/BN8 3k, BN5 4.5k, BN3/BN11 7.5k, BN4 9k, BN15 10k, BN9 12k, BN6/BN7/BN10 17k, BN2 18.75k, BN13 36k, BN14 37.5k.
  - These are the nodes to **win through Bladeburner instead**: complete all 21 Black Ops, which needs no Red Pill and no hacking requirement. That requires SF6 or SF7 first, and the route is disabled in BN8.
- **Routes to The Red Pill**:
  - Daedalus (30+ augs, $100B, hacking 2500)
  - the gang faction, in BN2 only
  - the Dark Net labyrinth, the **only** source in BN15
  - donations from stock money in BN8
- **Singularity**: absent before SF4, RAM ×16 at SF4.1, ×4 at SF4.2, ×1 at SF4.3 or anywhere inside BN4. So: **BN4 ×3 early**.
- **Page access is free**: reaching `document` through `eval`/`globalThis` costs 0 GB of RAM. UI automation is viable from BN1.1, and `ns.bypass` treats it as sanctioned.
- **What persists across an aug install**: home RAM, karma, gang, corp, Bladeburner, sleeves, intelligence.
- **What an aug install wipes**: stocks (liquidate first), hacknet, TOR, programs.
  - The casino's $10B cap also resets on every install, so it's a repeatable bootstrap.
- **BN10 is a one-time window** to buy sleeves (1e13 to 1e17) and sleeve memory; both persist forever. Visit it when rich.
- **Stanek's Gift** must be accepted before any non-NeuroFlux aug is installed. Joining Bladeburner with SF7.3 silently auto-grants an aug and blocks the gift.
- **BN12 shortcut**: `destroyW0r1dD43m0n(..., {sourceFileOverrides: {12: 0}})` should keep every BN12 run at level-1 difficulty while still incrementing SF12. *Untested, and pending a rules ruling.*
- **SF-1 (exploits)** is worth only ×1.011 total and is not needed for BN_DESTROYER. Proposed: exclude it from goal B.

## 3. Draft campaign order (hypothesis, to be validated)

| # | Nodes | Why |
|---|---|---|
| 1 | BN1.1 | Forced start. Needs the UI driver (no Singularity). |
| 2 | BN4 ×3 | Singularity at ×1 RAM; full automation from here on |
| 3 | BN1.2–1.3 | Easiest clears, +multipliers |
| 4 | BN5 ×1 | Formulas.exe, intelligence, real BN multipliers |
| 5 | BN2 ×3 | Gangs everywhere; gang faction sells Red Pill in BN2 |
| 6 | BN6/BN7 ×3 | Bladeburner, the win route for hard nodes |
| 7 | BN3 ×3 | Corporations at full API (SF3.3 avoids $100B of unlock costs) |
| 8 | BN5.2–3, BN9, BN11, BN8, BN15, BN10 | Mid tier; BN10 timed for when rich |
| 9 | BN13, BN14 | Hardest; Bladeburner win |
| 10 | BN12 | Farm SF12 to the target (50 = CHALLENGE_BN12) |

## 4. Architecture

```
[Offline, Node/TS]                         [In game, Steam 3.0.1]
 bridge: Remote-API WS server  ──push──▶   bitburner-scripts (fork)
   └ telemetry: pulls save + server list     autopilot  (per-BN playbooks)
 sim: real engine (vendor/bitburner-src)     daemon     (HWGW)
   + fake clocks + seeded RNG                ui-driver  (NEW: factions/augs/install/BitVerse/casino/infiltration/restart)
 optimizers: corp rounds, BN order, params   dnet bot   (NEW: BN15)
 go engine: AI port + search                 corp bot   (NEW)
 (optional) LLM supervisor ──reads telemetry, adjusts autopilot config
```

## 5. Script fork status (from the audit)

- **Merge upstream** (6 commits, no conflicts). Fixes the gangs.js crash-loop (P0), the IP-contract solver, and the 2 missing contract solvers.
- **Ours to fix**:
  - TOR detection (`tor-manager.js:12`, `daemon.js:407`)
  - BN15 missing from `defaultBnOrder`
  - `ns.ui.time` → `ns.format.time` (`helpers.js:958`)
  - unnecessary WSE/4S purchases
  - `--use-hacknet-servers` startup failure
  - RAM check for `hacknet-upgrade-manager.js` on an 8 GB home
  - stale CLAUDE.md notes (sleeve memory now has an API)
- **New builds**: ui-driver, Dark Net bot, corp bot, Go engine, per-BN playbooks.

## 6. Decisions taken (2026-10-24)

1. **Legacy fork:** merge the upstream fixes, point its README at this project, delete its issues, archive it.
2. **Rules line:** anything reachable through NS or page/React state is allowed (BN12 overrides, Go RNG prediction, casino/infiltration state reading). DevTools, save editing and modifying game code are forbidden.
3. **SF-1** is excluded from the goal.
4. **BN1.1:** start the clock now on the patched legacy fork, with the owner doing the faction/aug/install clicks while the UI driver is built.
5. **Strategy:** not a per-BitNode scripted campaign but a general model-driven system (see [`architecture.md`](architecture.md)). The campaign order in §3 is the planner's prior, not hard-coded logic.
