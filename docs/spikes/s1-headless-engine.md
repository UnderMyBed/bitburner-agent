# Spike S1: headless engine

- **Date:** 2026-10-24
- **Question:** can the real game engine (`vendor/bitburner-src` @ `1da7316ff`, v3.0.1) run headless in plain Node, outside Jest, under a virtual clock, deterministically, and fast enough to iterate on?
- **Verdict: PASS.** Every exit criterion in architecture §13 (S1) is met. The simulator design in §9 stands, with the corrections listed below. Decision recorded in [ADR 0007](../decisions/0007-headless-engine-simulator.md).
- **Code:** [`spikes/s1-headless-engine/`](../../spikes/s1-headless-engine/) (throwaway; M1 rebuilds it test-first).

## How it works
| Piece | What the spike does |
|---|---|
| Engine bundle | esbuild bundles the game source plus a ~100-line entry module into one CommonJS file. The module mapping copies the game's own `jest.config.js`: `?raw` imports as text, CSS/images empty, `@player`/`@enums` aliases, Monaco stubbed. The game's dependencies come from its own lockfile (`npm ci` in the submodule). |
| DOM | jsdom globals, with the same two patches as the game's `FixJSDOMEnvironment.ts` (`adoptedStyleSheets`, `replaceSync`). |
| Clock | `@sinonjs/fake-timers` fakes `setTimeout`/`setInterval`/`Date`/`performance` from a fixed epoch. The game's own `Engine.start` loop runs unmodified on the fake clock, and `clock.tickAsync` advances time. Microtasks, `setImmediate` and `nextTick` stay real. |
| RNG | `Math.random` replaced by a seeded sfc32 generator. |
| Script modules | The engine imports player scripts from `blob:` URLs, which Node can't import. A synchronous module hook (`module.registerHooks`) serves short in-memory `blob:sim/N` URLs, which is what the browser does. |
| Boot | The game's own `Engine.load()`: the new-game path, or the real save-load path (migration, offline progress). Then the harness emits `MainUILoaded`, as `GameRoot` does when the UI mounts. |

## Results
Reference rig (Ryzen 7 9800X3D). "Speed" = virtual time ÷ wall time for one process.

| Workload | Speed |
|---|---|
| 1 looping hack script, 3 threads (early game) | **30,000–37,000×** |
| Batcher-style controller, `exec`s workers every 200 ms, ~40 processes | **~12,000×** |
| Same, 12 seeds in parallel (worker pool) | ~6,500× each, **~55,000× aggregate** |
| ~3,100 concurrent processes, 125 `exec`/s | 453× (687× with `disableLog("ALL")`) |
| ~11,000 concurrent processes, 500 `exec`/s | 105× |
| **Legacy fork from a real Steam BN4 save** (autopilot, daemon, IPvGO, stocks, temp scripts) | **50–78×** |

Other numbers:
- Bundle load 0.33 s; new-game boot 3 ms; loading a real save ~1.1 s.
- Heap 120–450 MB per engine, so a pool of 12–14 needs ~5 GB.

**Determinism:**
- Same seed gives an identical state hash (player + all servers + factions) in every scenario, including the legacy fork run from a Steam save.
- Different seeds give different hashes.
- Results are invariant to the driver's step size (200 ms to 1 h).

**Save round trip:**
- Saving with the game's own serialiser and loading in a fresh process restores the state exactly, including all 38 running scripts.
- The continuation is deterministic.

**Real Steam saves:**
- March 2026 BN1 and BN4 saves (pre-v3) load through the real migration path.
- The legacy fork's scripts then run headless. They installed augmentations, which exercises the engine's prestige path, and rebuilt to hacking 560 and $243M in 6 virtual hours.

**Where the time goes:**
- With many processes, the game's per-call work dominates: log formatting (~20%, mostly removed by `disableLog`) and per-cycle script bookkeeping. Fake-timer overhead is ~15% and heap-based (O(log n)).
- In the fork workload, IPvGO search (the fork's and the game's) takes ~45%. The 3.0 API-break scan on every script write also shows up.
- **Simulation speed is bounded by how much computing the in-game code does,** which the browser would spend in real time too. The harness isn't the bottleneck.

## What this changes
1. **Speed target (§9.1):**
   - "≥1000× for hacking-dominated phases" holds for lean workloads by 10–35×.
   - Heavy script churn and IPvGO-scale compute run at 50–700×.
   - The planner's long-horizon search stays on the fast model, as designed. The engine validates, calibrates and runs scenario suites, and the worker pool multiplies throughput.
   - Our own in-game workers should `disableLog("ALL")`, which is also good practice live.
2. **Browser parity is a real work item, not a footnote.** The headless harness must reproduce what the browser and UI provide implicitly:
   - **`window === globalThis`:** libraries leak globals that player scripts use. `sprintf-js` sets `window.sprintf`/`vsprintf`, and lodash sets `_` under webpack's AMD `define`.
   - **`MainUILoaded`:** emitted by `GameRoot` on mount. It starts the saved scripts **and autoexec**, so the boot path (§5.7, Q5) is testable in the simulator.
   - **The router:** the real `Router.toPage` has game-logic side effects. `Travel` calls `Player.gotoLocation`; `BitVerse` calls `prestigeWorkerScripts` and `calculateAchievements`. The sim router must reproduce these.
   - **IndexedDB:** missing. The pre-v3 save migration's backup export and `saveGame` fail harmlessly; M1 adds a fake IndexedDB.
   - **TS/JSX player scripts:** these need swc. The spike stubs it, since our bundles are plain JS; M1 maps to `@swc/core` if needed, as Jest does.
3. **A new game starts the interactive tutorial.** On v3.0.1, while it runs, `killWorkerScript` returns early (`src/Netscript/killWorkerScript.ts`), so **scripts that finish are never cleaned up and their RAM is never freed**.
   - Fixed on `dev`, but present on Steam.
   - **The agent's BN1.1 bootstrap on a fresh save must end the tutorial first** (the Skip button calls `iTutorialEnd`). This is an M3 requirement.
   - *Since (M3, #168):* the Agent can't run while the tutorial does (the terminal refuses `run agent/boot.js`, and autoexec runs only on a load, which never brings the tutorial back), so the owner's "Exit Tutorial" click ends it. Architecture §5.7.
4. **DOM-dependent scripts fail headless.** No UI is rendered, so anything reading game DOM fails. In the fork that's the HUD/stats overlay, the stock summary and the casino's save-button lookup; for us it's our `ui` effectors. As planned, those are covered by E2 (§9.2).
5. **Q8 (formula import), first answer:** the engine can't be imported without pulling in the whole UI. The bundle has 894 game source files plus React, MUI, Markdown and so on, but it runs in Node regardless. Extracting formula modules for `core/` without UI deps is still open.

## M1 work list (from the spike)
- Rebuild the harness test-first in `packages/sim`.
  - Same mechanisms.
  - A determinism regression test: same seed gives the same hash; step-size invariance.
  - A save round-trip test.
- **Import-timing guarantee.** Script imports resolve through Node's module loader, which is async. Determinism held in every run because `tickAsync` yields to the real event loop between timers, but nothing guarantees it. Add a quiescence barrier, so time doesn't advance while a script compile is pending, or prove it's unnecessary.
- **Headless router** with the real side effects; a browser-parity shim (globals); fake IndexedDB; `MainUILoaded` and tutorial-skip as explicit boot steps.
- **Worker pool and scenario fixtures** (new game; BN entry with a given Source-File set; Steam saves under the one-way rule, kept local and never committed).
- **Long-run memory check.** Compiled modules are cached by code and never collected, so scripts that write unique temp code grow the heap.
- **Timing fidelity.** The fake clock is exact, while the browser has timer jitter and throttling. Inject jitter as §9.2 says.
