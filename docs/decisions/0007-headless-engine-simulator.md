# 0007 — Simulator: the real engine, headless, on a virtual clock

- **Status:** Accepted (2026-10-24)

## Context
The whole plan depends on iterating in simulation: scenario suites, fast-model fidelity, the M4 exit criterion. Architecture §9 assumed the real game engine could run headless, but nothing had proven it. The game's Jest tests run engine code under jsdom, Babel and module mocks, which is a long way from a fast, deterministic simulator.

Alternatives:
- **A reimplemented game model.** Fast, but it drifts from the game, and every mechanic must be ported and kept in sync.
- **The browser build driven by Playwright** (E2) with clock control. Real, but slower, heavier, and harder to parallelise.
- **The real engine bundled for Node.** Real code; speed and determinism unknown.

Spike S1 ([report](../spikes/s1-headless-engine.md)) tested the third option.

## Decision
The simulator (E1) runs **the real engine from `vendor/bitburner-src`, bundled for plain Node:**
- **Bundling:** esbuild, with the module mapping the game's `jest.config.js` uses; dependencies installed from the game's own lockfile.
- **Environment:** jsdom globals plus browser-parity shims.
- **Clock and RNG:** `@sinonjs/fake-timers` for the clock; a seeded PRNG for `Math.random`.
- **Script modules:** player scripts load through a synchronous `module.registerHooks` loader serving in-memory `blob:` URLs.
- **Boot:** the game's own `Engine.load`. The UI's side effects (`MainUILoaded`, router side effects) are reproduced by a headless router and boot sequence.

E2 (browser build + Playwright) stays the environment for anything that needs the rendered UI.

## Consequences
- **Fidelity by construction:** the engine is the game's own code, including the `Engine.start` loop and save/load/migration. Real Steam saves load and play.
- **Deterministic:** same seed gives the same state hash; independent of the driver's step size.
- **Speed is workload-bound:**
  - 10,000–37,000× for lean hacking workloads; ~55,000× aggregate across a 12-process pool.
  - 50–700× for heavy script churn or IPvGO-scale in-game compute.
  - Long-horizon planning search therefore stays on the fast model (§4.3). The engine validates and calibrates.
- **We own a browser-parity layer** (globals, router side effects, IndexedDB, UI events). Every gap is a fidelity risk, so each gets a test, and the list is re-checked when the pinned game version moves (ADR 0003).
- **No rendered UI:** DOM-reading code (our `ui` effectors, parts of the legacy fork) is tested on E2, not E1.
- **The bundle pulls in the whole UI** (React, MUI and more). That's harmless at runtime (0.3 s load), but it means formula-only imports into `core/` need separate work (Q8).
