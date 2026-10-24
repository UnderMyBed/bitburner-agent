# Architecture: Autonomous Bitburner Agent

> Status: **DRAFT for review** · 2026-10-24
> Inputs: `docs/synthesis.md`, `docs/mechanics/*.md`, `docs/scripts-compat-audit.md`
> Conventions: **D#** = design decision, **Q#** = open question, **R#** = requirement.

---

## 1. Purpose

Build one piece of software that takes a Bitburner save from **any valid state** to **every Source-File maxed** (SF1–11 and SF13–15 at level 3, plus SF12 to a target). It should get there **unattended, repeatably, and as fast as wall-clock allows**.

It is **not** a scripted campaign. Behaviour that differs per BitNode should come from **data**: the multipliers, which mechanics are enabled, and which win routes are available. Hand-written `if BN == x` branches are not the approach.

### 1.1 Goals
- G1: Reach the goal from a fresh save with human input limited to things that are impossible to automate (§10.1).
- G2: Survive any interruption (script death, reload, aug install, BitNode change, offline time, our own crashes) with no human repair.
- G3: Prove repeatability in a simulator, as a measured pass rate across seeded scenarios.
- G4: Minimise total wall-clock time to the goal.
- G5: Make every decision explainable after the fact.

### 1.2 Non-goals
- Achievements beyond what the goal requires; SF-1 (exploits) is excluded.
- Supporting game versions other than the one pinned (§12.4).
- Pretty UI. A functional dashboard is enough.
- Claude (or any LLM) playing in the hot loop.

### 1.3 Rules of engagement
- **Allowed:** anything reachable through the NS API or page/React state from inside the game. That includes the UI driver, reading component state, seeded-RNG prediction, and `sourceFileOverrides`.
- **Forbidden:** DevTools/CDP, save-file editing, modifying game code, the dev menu.

---

## 2. Constraints that shape the design

| # | Constraint | Consequence |
|---|---|---|
| C1 | Steam build **v3.0.1** (VersionNumber 51); Steam may auto-update | Pin the version and detect drift (§12.4) |
| C2 | Fresh save means **8 GB home RAM** and every NS function costs RAM | In-game code must be tiny, and expensive calls go in throwaway worker scripts |
| C3 | RAM is charged by **identifier name** across all imported code; only `document`/`window` are special, and `eval("document")`, `WebSocket` and `fetch` are free | Bundling must be per-script and tree-shaken, with a RAM check in CI |
| C4 | No Singularity until SF4; ×16, ×4 and ×1 RAM at SF4.1, 4.2 and 4.3 | All player actions go through an **Action API** with a UI backend and a Singularity backend |
| C5 | All scripts die on aug install or BitNode change; autoexec runs only on game load; `installAugmentations(cb)` and `destroyW0r1dD43m0n(n, cb, opts)` take a callback script | Bootstrap must be re-entrant, with an explicit restart path per transition |
| C6 | hack/grow/weaken run on wall-clock `setTimeout`; hacknet, work and stocks run on 200 ms game cycles | Sub-second logic must live in game; the simulator needs a virtual clock |
| C7 | Electron sets `backgroundThrottling: false` | The game runs at full speed minimised. A brain process outside the game is viable. |
| C8 | Real wall-clock time is the binding cost (~42 node clears plus BN12) | Optimise for time-to-destroy, and start running early |

---

## 3. System overview

```
┌───────────────────────── Node process: "brain" (TypeScript) ─────────────────────────┐
│                                                                                      │
│  Bridge ──► World Model ──► Estimators ──► Planner ──► Desired State ──► Bridge      │
│    │          (snapshot      (capability    (route,      (per-capability     │       │
│    │           + derived)     rate models)   allocation,  configs + action   │       │
│    │                                         prestige)    intents)           │       │
│    ├── Telemetry store + Decision log ──► Dashboard                          │       │
│    └── Deployer (Remote File API) ──► pushes in-game bundles                 │       │
│                                                         (optional) LLM Supervisor    │
└──────────────────────────────▲───────────────────────────────────────────────┼───────┘
                               │ control channel (WebSocket, JSON)             │
┌──────────────────────────────┼─────── Steam game (in-page JS) ───────────────▼───────┐
│  Agent (always running, ~2–3 GB)                                                     │
│    ├─ Snapshotter    — runs worker scripts, assembles state                          │
│    ├─ Reconciler     — desired state → idempotent commands                           │
│    └─ Safe mode      — holds last desired state if the brain is away                 │
│  Reflexes (in-game, real-time): HWGW batcher, stock trader, gang ticker,             │
│    Bladeburner loop, Go player, Dark Net crawler, corp cycle, casino/infiltration    │
│  Action API: Singularity backend | UI-driver backend                                 │
│  Bootstrap: boot.js (autoexec + install/flume callbacks + terminal injection)       │
└──────────────────────────────────────────────────────────────────────────────────────┘

Simulator: same brain + same in-game bundles, running in Node against the real engine
           from vendor/bitburner-src, with a virtual clock and seeded RNG (§9).
```

### D1 — The brain lives outside the game; reflexes live inside
**Decision:** the planner, estimators, campaign logic, telemetry and supervisor run in a **Node/TypeScript process**. Only work that needs real-time behaviour or direct NS access runs in game.

**Why:**
- No RAM limit (C2).
- Real tests, types and libraries.
- The same brain drives the real game and the simulator.
- Telemetry is native.
- We can **import the game's own formula code** from `vendor/bitburner-src`, so the estimates are exact by construction.

**Costs and mitigation:**
- An extra process must be running. Mitigation: safe mode (§5.4) means a missing brain costs optimality, not progress. The brain also runs as an auto-start background task.
- An extra transport hop. Not a problem for decisions made on a cadence of seconds or more; sub-second loops stay in game.

**Alternative rejected:** everything in game, the way the fork works. It's RAM-starved, untestable, and needs file-based IPC.

### D2 — Desired-state reconciliation, not command streams
The brain publishes a **desired state**, a versioned, declarative document. The in-game Reconciler converges reality toward it with **idempotent** steps, Kubernetes-style.

A dropped message, a duplicate message or a restart therefore never corrupts anything: the next reconcile just recomputes the difference.

Example desired state:
```jsonc
{
  "version": 1842, "issuedAt": 1761300000000, "ttlMs": 600000,
  "playerFocus": { "kind": "factionWork", "faction": "CyberSec", "type": "hacking" },
  "capabilities": {
    "hwgw":   { "enabled": true, "targets": ["joesguns","phantasy"], "ramBudget": 0.85 },
    "stocks": { "enabled": false },
    "gang":   { "enabled": true, "mode": "respect", "warfare": "auto" }
  },
  "intents": [   // one-shot, each with an idempotency key
    { "id": "buy-aug:CyberSec:BitWire", "action": "purchaseAugmentation", "args": ["CyberSec","BitWire"] },
    { "id": "install:cycle-7", "action": "installAugmentations", "guard": { "queuedAugsAtLeast": 6 } }
  ]
}
```

---

## 4. The brain

### 4.1 World Model
- **Snapshot:** raw state from the game (player, servers, factions, augs, BitNode multipliers, gang, corp, Bladeburner, sleeves, Dark Net, stocks, running scripts and RAM). It is the **only source of truth**.
- **Derived model:** normalised and enriched, using the game's own functions imported from `vendor/bitburner-src`: hack chance and time, growth, rep gain, aug price escalation, w0r1d_d43m0n difficulty, and so on.
- Before SF5, BitNode multipliers come from a static table generated from the game source rather than the API.

### 4.2 Capabilities
A **capability** is any way of turning resources into progress. It's the unit of extension.

```ts
interface Capability {
  id: CapabilityId;                                   // "hwgw" | "gang" | "corp" | "bladeburner" | ...
  availability(m: Model): Availability;               // unlocked? missing prerequisites? (e.g. needs SF2, karma)
  options(m: Model): CapabilityOption[];               // discrete modes (gang: respect | money | territory)
  estimate(m: Model, opt: CapabilityOption, alloc: Allocation): RateVector;
  claims(opt: CapabilityOption): ResourceClaim;        // player focus? RAM? capex? sleeves?
  configFor(opt: CapabilityOption, alloc: Allocation): CapabilityConfig; // → desired state
  health(s: Snapshot): HealthReport;                   // actual vs estimated; stalls; errors
}

type RateVector = Partial<{
  money: number; hackExp: number; combatExp: number; chaExp: number; intExp: number;
  rep: Record<FactionName, number>; companyRep: Record<CompanyName, number>;
  karma: number; bbRank: number; hashes: number; corpValuation: number; /* … */
}>;
```

**Scarce resources** that the planner allocates:

| Resource | Notes |
|---|---|
| Player focus | Exclusive: faction work, company work, crime, class, grafting, infiltration, Bladeburner action, or idle |
| RAM | Home plus purchased plus rooted servers; worker cores matter for grow/weaken |
| Money | Capital spending versus saving for augs or Daedalus |
| Sleeves | Up to 8, each an independent focus |
| Hashes | If hacknet servers exist |

**Initial capability set** (first 6 build first; the rest as the campaign needs them):

`hwgw` · `factionWork` · `companyWork` · `crime` · `augPurchase` · `homeUpgrade` · `hacknet` · `stocks` · `contracts` · `gang` · `bladeburner` · `corp` · `sleeves` · `darknet` · `stanek` · `go` · `casino` · `infiltration` · `grafting`

### 4.3 Win routes as goal trees
A route is a requirement tree. Its leaves are quantities that capabilities produce. Routes are data and are checked against `availability`.

```
DestroyBN
├─ Route: HackWorldDaemon     [not BN15]
│   ├─ hackLevel ≥ 3000 × WorldDaemonDifficulty   (effective, after the hacking-level multiplier)
│   ├─ root(w0r1d_d43m0n)
│   └─ RedPillInstalled ── any of:
│        ├─ Daedalus: installedAugs ≥ N(BN), money ≥ 100B, hack ≥ 2500 | combat ≥ 1500 → rep ≥ 2.5M × mult
│        ├─ GangFaction (BN2 only)
│        ├─ DarkNetLabyrinth (not BN8)
│        └─ Donation (favor ≥ 150, or BN8's 0-favor donations)
├─ Route: BladeburnerBlackOps [needs BN6/7 or SF6/SF7; not BN8]
│   └─ all 21 Black Ops complete (Daedalus op: rank 400k)
└─ Route: DarkNet (BN15)       Red Pill only from the labyrinth → backdoor WD
```

### 4.4 Estimators
- An estimator maps `(model, option, allocation) → RateVector` over a time horizon.
- **v0:** closed-form, from game formulas (exact for hacking, rep, crime and stocks in expectation).
- **v1:** calibrated. A correction term is fitted from telemetry and simulator runs, wherever the closed form misses (batcher efficiency, gang territory dynamics, corp growth).
- Every estimate is compared with the observed rate. The error is logged per capability and fed into calibration (§11).

### 4.5 Planner (model-predictive control)
Every **planning tick** (default 30 s, plus an event-driven re-plan on a state transition):

1. **Score routes.** For each available route, estimate the time to reach every leaf under a candidate allocation. Route ETA is the critical path.
2. **Allocate.** Choose an allocation of scarce resources that minimises the chosen route's ETA, subject to resource limits and a **switching cost**. Switching cost covers lost focus bonus, gang task churn, re-batching cost and so on, and gives hysteresis against thrashing.
   - v0: greedy, by the marginal reduction in ETA per unit of resource.
   - Later: rollout search over the simulator's fast models.
3. **Decide prestige.** Compare the projected time to win if we **install now** against **continuing**, using estimators run with the post-install multipliers (§4.6).
4. **Emit** a desired state together with a **decision record**: inputs, options considered, scores, and the choice.

### 4.6 Prestige and campaign decisions
- **Aug install timing** is the hardest modelling problem. Formulate it explicitly: `argmin over t_install of [t_install + ETA_after(multipliers(augs bought by t_install))]`.
  - It includes the order in which augs are bought, under the 1.9× price escalation (most expensive first, Red Pill last).
  - The aug-buying itself is an optimisation: a knapsack problem over price, rep threshold and value per multiplier.
- **Next-BitNode choice:** pick the BitNode that minimises the **estimated remaining campaign time**, given the current Source-Files and the SF bonuses gained.
  - Per-BN duration estimates come from a table maintained by simulator runs and real telemetry.
  - The draft order in the synthesis becomes the **prior**, not hard-coded logic.
- **BN12:** use `sourceFileOverrides {12: 0}` to keep its difficulty at level 1, subject to verification (Q6).

### 4.7 Hard-coded knowledge
Some things genuinely can't be estimated cheaply: known traps (Stanek before Bladeburner with SF7.3), a sensible BN1.1 opening, and similar. These live in a **declarative rules file** of constraints and preferences consumed by the planner. They never become ad-hoc branches. Each rule cites its mechanics doc and is testable.

---

## 5. In-game runtime

### 5.1 Agent
- One persistent script, held to a **≤ 3 GB** budget that we enforce.
- It holds the WebSocket to the brain and runs the Snapshotter and Reconciler. It never calls expensive NS functions directly.
- Expensive calls go to **worker scripts**: tiny, single-purpose, short-lived. They write their results to a port or file. This is the fork's `getNsDataThroughFile` pattern, formalised.

### 5.2 Snapshotter
- **Tiered cadence:**
  - fast (2 s): money, player focus, running scripts
  - medium (10 s): player stats, servers
  - slow (60 s): factions, augs, the big subsystems
- Each tier is one worker batch. Snapshots carry a monotonic sequence number and game timestamps.

### 5.3 Reconciler
- For each capability config, it **diffs** desired against actual: is the script running, with which args, with what config.
- It starts, stops or reconfigures reflexes to close the diff.
- It executes intents at most once, using idempotency keys persisted to a file on home, which survives an install.
- It enforces guards such as "only install if ≥ N augs are queued".

### 5.4 Safe mode
If the brain has been silent longer than `ttlMs`, the agent **keeps running the last desired state**, minus intents. Reflexes keep producing money and XP; nothing irreversible happens (no installs, no BitNode changes). Progress continues; only optimality is lost.

### 5.5 Reflexes
Real-time loops that are configured by the brain and never decide strategy:

| Reflex | Why it's in game | Source |
|---|---|---|
| HWGW batcher | Millisecond landing precision | Fork `daemon.js` first; possible rewrite later (§13) |
| Stock trader | Reacts on stock ticks | Fork `stockmaster.js` (patched) |
| Gang ticker | Territory tick (~20 s) swap trick | Fork `gangs.js` (patched via the upstream merge) |
| Bladeburner loop | Action completion events | Fork `bladeburner.js` |
| Go player | Turn-by-turn play, cheat timing within one 200 ms tick | **New**: AI port plus search, predicted cheats |
| Dark Net crawler | Self-replicating onto frontier servers, sessions per process | **New** |
| Corp cycle | Five-state market cycle | **New** |
| Casino / infiltration | DOM/React-driven, real-time | **New** (UI driver) |

### 5.6 Action API
```ts
interface Actions {
  joinFaction(f): Result;  purchaseAug(f, aug): Result;  installAugs(cb): Result;
  workForFaction(f, type, focus): Result;  workForCompany(c, focus): Result;  commitCrime(c): Result;
  travel(city): Result;  purchaseTor(): Result;  purchaseProgram(p): Result;  upgradeHomeRam(): Result;
  backdoor(host): Result;  destroyWorldDaemon(nextBN, cb, opts): Result;  /* … */
}
```
- **Backends:**
  - `singularity`: SF4, or inside BN4
  - `ui`: page/React automation through `eval("document")`
  - `sim`: direct engine calls, simulator only
- Backend selection is automatic, by availability and RAM cost (C4).
- Capabilities and the planner never know which backend is in use.

### 5.7 Bootstrap and restart (C5)
| Transition | Restart path |
|---|---|
| Game load | Autoexec setting → `boot.js` (set once by hand, §10.1) |
| Aug install (SF4) | `installAugmentations("boot.js")` |
| BitNode change (SF4) | `destroyW0r1dD43m0n(n, "boot.js", opts)` |
| Aug install / BitNode change through the UI (before SF4) | The UI driver types `run boot.js` into `#terminal-input` from a page-level timer that outlives the dying script; fallback is save and reload, so autoexec fires |

`boot.js` is re-entrant: it is safe to run at any time and in any number of copies. It (re)starts the Agent; everything else follows from reconciliation.

---

## 6. Bridge

Two channels, because the game's Remote File API (RFA) only handles files:

| Channel | Direction | Use |
|---|---|---|
| **RFA** (WebSocket server; the game connects to us) | Brain → game requests | Deploy bundles (`pushFile`), `calculateRam` checks, `getDefinitionFile` (live API types for drift detection), `getSaveFile` (backups and simulator seeding) |
| **Control** (WebSocket server; the Agent connects to us) | Both ways | Snapshots up; desired state and intent acknowledgements down; heartbeats |

- The protocol is versioned JSON messages with sequence numbers. On reconnect, the Agent sends a full snapshot and the brain resends the current desired state.
- **Save backups:** `getSaveFile` every N minutes, with rotation. That's our insurance against a catastrophic bug, and the simulator's source of real starting states.

---

## 7. Telemetry and observability
- **Store:** an append-only time series of snapshots (thinned for old data), decision records, estimate-vs-actual errors, reflex health, and transitions. SQLite to start.
- **Dashboard:** a local web page showing the current route and ETA, the allocation, capability rates (estimated against actual), a timeline of BitNodes and installs, and alerts.
- **Alerts:** a stall (no progress on the route's critical path for X minutes), a reflex crash loop, estimate error above a threshold, brain disconnected, game version changed.

---

## 8. LLM and ML roles (deliberately narrow)
| Role | What | When |
|---|---|---|
| Estimator calibration (ML) | Fit correction terms from telemetry and simulator runs | Phase 4 |
| Planner search | Rollouts over fast models; learned value function only if search is too slow | Later, if needed |
| Go engine | Search with the exact ported AI as the opponent; **no reinforcement learning** | With the `go` capability |
| LLM supervisor (optional) | Reads the decision log and telemetry; diagnoses stalls; proposes rules-file changes **for human approval**; never in the control loop | Phase 4 experiment |

---

## 9. Simulator

### 9.1 Design
- **Engine:** the real `vendor/bitburner-src` code in Node, bootstrapped the way its Jest tests already do (`initGameEnvironment`, `setupBasicTestingEnvironment`, NS script execution).
- **Virtual clock:** fake `setTimeout`/`setInterval`/`Date`/`performance.now`. Game cycles are driven through `Engine.updateGame(numCycles)`. Time advances to the next event, discrete-event style.
- **Seeded RNG:** replace `Math.random` (and confirm the game's `WHRNG` sites) with a seeded PRNG per scenario.
- **Same code under test:** the brain connects through an in-process transport, and the in-game bundles run as real NS scripts inside the engine. The Action API uses its `sim` backend.
- **Speed target:** at least **1000×** real time for hacking-dominated phases; measured, not assumed.

### 9.2 Fidelity gaps (known and accepted)
- The headless simulator doesn't render the UI. UI-driver paths are covered by **E2 end-to-end tests on a source build** (§9.4), and only a final smoke check runs on Steam.
- Timing contention under load (batch landing jitter) is modelled with injected jitter that we calibrate from real telemetry.
- Offline progress and save/reload are exercised through the engine's real load path using serialised saves.

### 9.3 Test pyramid
| Level | What | Gate |
|---|---|---|
| Unit | Estimators against game formulas; the planner on fixed models; reconciler diffing | Every commit |
| Contract | In-game bundles type-check against the **live** `NetscriptDefinitions.d.ts`; static RAM ≤ budget | Every commit |
| Scenario (simulator) | Seeded runs: fresh BN1.1→destroy; entry into each BitNode with representative Source-File sets; odd mid-run states | On demand when touching brain/capabilities; before every release |
| Chaos (simulator) | Kill random scripts, drop the brain, reload mid-batch, offline gaps, duplicated messages | Before every release |
| End-to-end (E2 source build) | UI driver actions, bootstrap/restart paths (Q5), Agent RAM in a real 8 GB start (Q1), bridge connect/reconnect, RFA deploy, real save/reload | On demand when touching `ingame/` or `bridge/`; before every release |

No scheduled (nightly) runs. The heavy suites are run deliberately, not on a timer.
| Smoke (E0 Steam) | Short checklist confirming E2 results hold on the shipped binary | Before relying on a new UI path in the campaign |

**Repeatability metric:** the pass rate and the time-to-destroy distribution per scenario. A release can't regress either beyond a threshold.

### 9.4 Environments
| Env | What | Used for |
|---|---|---|
| **E0 Steam** | Vanilla 3.0.1 binary and the real campaign save | The campaign. Final smoke checks only. Never used as a test bed. |
| **E1 Simulator** | Engine from `vendor/bitburner-src` in Node; no UI; virtual clock; seeded RNG | Scenario and chaos suites, calibration, the speed target |
| **E2 Source build (browser)** | `vendor/bitburner-src` @ `1da7316ff` built with webpack, served locally, driven by Playwright (headless Chromium). Playwright's clock control lets the real UI run time-accelerated. | End-to-end tests of everything that touches the UI, the bootstrap or the bridge. Debugging game internals with breakpoints and logs. |
| **E3 Electron from source** *(only if needed)* | `npm run electron` from the same commit | Only if Electron-specific behaviour (file protocol, Steam hooks) diverges from E2 |

**Guardrails**
- **Parity:** E1 and E2 build from the exact commit Steam ships. On connect, the bridge compares `VersionNumber` and the live `getDefinitionFile` against the source tree's `NetscriptDefinitions.d.ts`.
- **Vanilla-only dependency:** the agent (in-game bundles and brain) must never rely on behaviour that doesn't exist in unmodified 3.0.1.
  - Instrumentation (clock, RNG seeding, observation hooks) lives in the **harness** and is injected from outside, either by the simulator harness or by Playwright.
  - The game build itself is never patched for E2 runs.
- **One-way saves:** Steam saves may be copied *into* E1/E2 as test fixtures. Nothing generated in E1/E2 is ever loaded into Steam, since that would be save editing by another name.
- **Rules scope:** the rules of engagement (§1.3) govern the agent playing on E0. Test harnesses on E1/E2 may use any tooling (CDP, debuggers, dev menu) because they're testing the agent, not playing the campaign.

---

## 10. Robustness requirements
| # | Requirement |
|---|---|
| R1 | **Crash-only.** Every component can be killed at any time; on restart it rebuilds from a snapshot plus persisted keys. No important state lives only in memory. |
| R2 | **Idempotent effects.** Every irreversible action (buy, install, flume, join an exclusive faction) is an intent with a key, a guard and a recorded outcome. |
| R3 | **Brain-optional progress** (§5.4). |
| R4 | **Bounded in-game RAM.** Agent ≤ 3 GB; every bundle's static RAM is checked in CI and verified live via RFA `calculateRam`. |
| R5 | **Graceful degradation.** A failing capability is marked unhealthy and the planner re-routes around it. |
| R6 | **Version pinning and drift detection** (§12.4). |
| R7 | **Explainability.** Every desired-state version links to its decision record. |
| R8 | **Rate-limited and confirmed irreversibles.** Installs and flumes require the guard to pass on two consecutive snapshots. |

### 10.1 Irreducible human steps
1. Install Steam, set the RFA port, and set autoexec to `boot.js` in game options. One time.
2. Before SF4 in BN1.1, by our earlier decision: faction/aug/install clicks **until the UI driver is ready**.
3. Anything the game gates behind a trusted click. None is known on the critical path so far; flag any we find.

---

## 11. Data and learning loop
```
real game ──telemetry──► store ◄──runs── simulator
                           │
                  calibration jobs (estimator corrections, per-BN duration table, jitter model)
                           │
                     versioned model params ──► brain
```

---

## 12. Engineering

### 12.1 Language and build
- TypeScript everywhere.
- In-game bundles are built per entry point with esbuild, tree-shaken and minified **without renaming NS identifiers**, then RAM-checked.
- The brain, bridge, simulator and dashboard are Node packages.

### 12.2 Repo shape (proposal — to be discussed)
```
packages/
  game-types/   generated from NetscriptDefinitions.d.ts (pinned) + live drift check
  core/         model types, capability interface, route definitions, formula shims → vendor/bitburner-src
  brain/        planner, estimators, campaign, rules file
  ingame/       agent, reconciler, workers, reflexes, action API (singularity|ui|sim), boot.js
  bridge/       RFA server + control channel
  sim/          engine harness, virtual clock, scenarios, chaos
  dashboard/    local web UI
  legacy/       adapters that run fork scripts as reflexes during migration
```

### 12.3 Migration from the fork (strangler pattern)
1. The patched fork runs BN1.1 **now**, standalone.
2. The Agent and brain come up in **observe-only** mode alongside the fork: telemetry and estimates, no control.
3. The brain takes over **strategy** (autopilot is retired); fork managers run as reflexes through `legacy/` adapters.
4. Fork reflexes are replaced one by one, each only when the simulator shows the replacement is at least as good.

### 12.4 Version management
The game source is a git submodule (`vendor/bitburner-src`) pinned to the commit Steam ships (3.0.1 = `1da7316ff`). We can't control when Steam updates, so the strategy is **never broken, at worst degraded**:
1. **See it coming:** a scheduled CI workflow watches upstream `stable`. When it moves, the workflow bumps the submodule on a branch, runs the full suite (including a diff of the API definitions), and opens a PR with a compatibility report. Steam ships from `stable`, so we normally know about a break, and have a fix, before Steam updates.
2. **Hold at runtime:** on every connect the brain checks `VersionNumber` and `getDefinitionFile` against the pinned build. On a mismatch it goes to **hold**: reflexes keep running, no intents, alert raised.
3. **Save backups:** the bridge pulls rotating saves via RFA (§6), so a bad patch or bug can always be rolled back.

Upgrading the pinned version is a normal PR: regenerate types, run the full suite, re-run smoke checks.

---

## 13. Milestones
| M | Deliverable | Exit criterion |
|---|---|---|
| M0 | Fork patched (upstream merge plus audit fixes); BN1.1 running | BN1.1 progressing on Steam |
| M1 | Walking skeleton: bridge, Agent, snapshot, telemetry, dashboard (observe-only); E2 source build plus Playwright harness | Skeleton passes E2 (connect, snapshot, reload, reconnect) in an 8 GB fresh start; then live snapshots on Steam for 24 h without gaps |
| M2 | Simulator core: engine, virtual clock, seeded RNG; runs the fork's daemon to a BN1 destroy | Deterministic replay of a seed; ≥100× speed (1000× stretch) |
| M3 | Action API (UI and sim backends) plus bootstrap/restart paths | Install-and-restart cycle passes in simulator chaos tests and a real-game smoke test |
| M4 | Planner v0 with `hwgw`, `factionWork`, `companyWork`, `crime`, `augPurchase`, `homeUpgrade`, and the WorldDaemon route | Autonomous BN1→destroy in the simulator over N seeds; then BN4 ×3 on Steam |
| M5+ | Capabilities in campaign-need order: `gang`, `bladeburner` route, `stocks`, `hacknet`, `corp`, `darknet`, `sleeves`, `stanek`, `go`… | Each with an estimator, a reflex, scenarios and health checks |
| M6 | Campaign selector, calibration loop, (optional) LLM supervisor | Next-BN choice from data; estimate error within bounds |

---

## 14. Risks
| Risk | Impact | Mitigation |
|---|---|---|
| Estimators are wrong, so plans are poor | Slow runs | Estimate-vs-actual monitoring, calibration, simulator A/B before deploy |
| Over-engineering delays real progress | Lost wall-clock time | The fork plays meanwhile; build the skeleton first; at most 6 capabilities for M4 |
| Simulator fidelity gaps | False confidence | Real-game smoke tier; calibrate jitter; track sim-vs-real divergence |
| Brain process down for long stretches | Suboptimal play | Safe mode; auto-start; alerts |
| Steam auto-update mid-campaign | Breakage | Upstream-`stable` watcher PRs, runtime hold, save backups (§12.4) |
| UI-driver fragility (DOM/React changes) | Pre-SF4 stalls | Short-lived dependency (Singularity replaces most of it); smoke tests |
| 8 GB early RAM | Agent can't run alongside the batcher | Strict budgets; workers; the Agent degrades to a slow cadence when RAM-starved |

---

## 15. Open questions
- **Q1** In-game Agent budget: is 3 GB realistic with WebSocket, workers and port I/O? Prototype in M1.
- **Q2** Planner v0: is greedy marginal-ETA allocation good enough to finish BN1 in the simulator, or do we need rollouts on day one?
- **Q3** ~~Steam update control~~ Resolved: we don't try to block updates; see §12.4.
- **Q4** Simulator speed: how far can a discrete-event clock skip with the real engine (stock 4 s gate, script timers)?
- **Q5** The UI-driver restart path before SF4 (terminal injection from a page timer): does it work reliably, or is save-and-reload the safer default?
- **Q6** Verify the BN12 `sourceFileOverrides {12: 0}` behaviour in the simulator before relying on it.
- **Q7** Where does the fork's hard-won RAM-dodging logic go, `ingame/workers` or `legacy/`?
- **Q8** Formula import: can we compile `vendor/bitburner-src` formula modules into `core/` without pulling in React/UI dependencies? Spike in M2.
