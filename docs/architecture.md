# Architecture: Autonomous Bitburner Agent

> Status: **DRAFT for review** · 2026-10-24
> Inputs: [`synthesis.md`](synthesis.md), [`mechanics/`](mechanics/), [`research/`](research/), [`legacy/scripts-compat-audit.md`](legacy/scripts-compat-audit.md)
> Conventions: **D#** = design decision, **Q#** = open question, **R#** = requirement.

---

## 1. Purpose

Build one piece of software that takes a Bitburner save from **any valid state** to **every Source-File maxed** (SF1–11 and SF13–15 at level 3, plus SF12 to level 50, which is the CHALLENGE_BN12 achievement). It should get there **unattended, repeatably, and as fast as wall-clock allows**.

It is **not** a scripted campaign. Behaviour that differs per BitNode should come from **data**: the multipliers, which mechanics are enabled, and which win routes are available. Hand-written `if BN == x` branches are not the approach.

### 1.1 Goals
- G1: Reach the goal from a fresh save with human input limited to things that are impossible to automate (§10.1). The agent plays from the very first BitNode: BN1.1, which has no Singularity API, is played through the `ui` backend (§5.6).
- G2: Survive any interruption (script death, reload, aug install, BitNode change, offline time, our own crashes) with no human repair.
- G3: Prove repeatability in a simulator, as a measured pass rate across seeded scenarios.
- G4: Minimise total wall-clock time to the goal.
- G5: Make every decision explainable after the fact.

**Priority when goals conflict:** robustness (G2) > correctness > speed (G4). The agent never risks a stall, a broken state or an irreversible mistake to go faster.

### 1.2 Non-goals
- Achievements beyond what the goal requires; SF-1 (exploits) is excluded.
- Supporting older game versions. We support the current Steam release; during a rollout the next release is handled through runtime feature detection (§12.4).
- Pretty UI. A functional dashboard is enough.
- Claude (or any LLM) playing in the hot loop.

### 1.3 Rules of engagement
- **Allowed:** anything reachable through the NS API or page/React state from inside the game. That includes the UI driver, reading component state, seeded-RNG prediction, and `sourceFileOverrides`.
- **Forbidden:** DevTools/CDP, save-file editing, modifying game code, the dev menu.

---

## 2. Constraints that shape the design

| # | Constraint | Consequence |
|---|---|---|
| C1 | Steam build **v3.0.1** (VersionNumber 51); Steam updates whenever it ships (not pinned) | Pin the *source we test against*, detect drift at runtime, forward-check upstream `dev` (§12.4) |
| C2 | Fresh save means **8 GB home RAM** and every NS function costs RAM | In-game code must be tiny, and expensive calls go in throwaway worker scripts |
| C3 | RAM is charged by **identifier name** across all imported code; only `document`/`window` are special, and `eval("document")`, `WebSocket` and `fetch` are free | Bundling must be per-script and tree-shaken, with a RAM check in CI |
| C4 | No Singularity until SF4; ×16, ×4 and ×1 RAM at SF4.1, 4.2 and 4.3 | All player actions go through **Effectors** (§5.6) with a UI backend and a Singularity backend |
| C5 | All scripts die on aug install or BitNode change; autoexec runs only on game load; `installAugmentations(cb)` and `destroyW0r1dD43m0n(n, cb, opts)` take a callback script | Bootstrap must be re-entrant, with an explicit restart path per transition |
| C6 | hack/grow/weaken run on wall-clock `setTimeout`; hacknet, work and stocks run on 200 ms game cycles | Sub-second logic must live in game; the simulator needs a virtual clock |
| C7 | Electron sets `backgroundThrottling: false` | The game runs at full speed minimised. A brain process outside the game is viable. |
| C8 | Real wall-clock time is the binding cost (~42 node clears plus ~50 BN12 clears) | Optimise for time-to-destroy, and start running early |
| C9 | The game runs 24/7 on the owner's machine. Offline time (reboots, updates) is the exception, and offline progress is lossy (no scripts run; approximated income/rep on reload). | Offline time is an interruption to survive (G2), never a strategy. The planner doesn't rely on offline progress, and the brain runs as a supervised always-on process. |

---

## 3. System overview

```
┌───────────────────────── Node process: "brain" (TypeScript) ─────────────────────────┐
│                                                                                      │
│  Bridge ──► World Model ──► Fast Model ──► Planner ──► Desired State ──► Bridge      │
│    │          (snapshot      (activities    (campaign/   (activity configs   │       │
│    │           + derived)     + actions)     BitNode/     + action intents)  │       │
│    │                                         cycle)                          │       │
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
│  Effectors: Singularity backend | UI backend                                         │
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

**Supervision:** the brain is an always-on process (C9). It runs under Windows Task Scheduler: started at logon, restarted on failure, and so back after reboots. No extra software is needed. Its health is visible on the dashboard. If it's down, the game is in safe mode (§5.4). The brain in turn keeps the game itself alive (§10.2).

### D2 — Desired-state reconciliation, not command streams
The brain publishes a **desired state**, a versioned, declarative document. The in-game Reconciler converges reality toward it with **idempotent** steps, Kubernetes-style.

A dropped message, a duplicate message or a restart therefore never corrupts anything: the next reconcile just recomputes the difference.

Example desired state:
```jsonc
{
  "version": 1842, "issuedAt": 1761300000000, "ttlMs": 600000,
  "playerFocus": { "kind": "factionWork", "faction": "CyberSec", "type": "hacking" },
  "activities": {
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

### 4.1 World model and brain state
- **Snapshot:** raw state from the game (player, servers, factions, augs, BitNode multipliers, gang, corp, Bladeburner, sleeves, Dark Net, stocks, running scripts and RAM). It is the **only source of truth for game state**.
- **Derived model:** the snapshot, normalised and enriched using the game's own functions imported from `vendor/bitburner-src`: hack chance and time, growth, rep gain, exp→level curves, aug price escalation, w0r1d_d43m0n difficulty, and so on. Before SF5, BitNode multipliers come from a static table generated from the game source.
- **Brain state:** the planner's own commitments: the current BitNode plan, cycle targets, and the active policy and when it was chosen. It isn't derivable from the game, so it's persisted in the store and mirrored to a file on home, which survives installs and BitNode changes. A brain restart **resumes** the plan instead of re-planning from scratch, so there's no thrash. Safe mode can read the mirror.

### 4.2 Building blocks: Activities and Actions
Everything the agent can do is one of two kinds.

**Activities** are ongoing and produce rates while resources are allocated to them.
```ts
interface Activity {
  id: ActivityId;                                   // "hwgw" | "factionWork" | "gang" | ...
  availability(m: Model): Availability;             // unlocked? which prerequisites are missing?
  options(m: Model): ActivityOption[];              // discrete modes (gang: respect | money | territory)
  claims(opt: ActivityOption): ResourceClaim;       // player focus? RAM? sleeves? hashes?
  rates(m: Model, opt: ActivityOption, alloc: Allocation): RateVector; // instantaneous, in expectation
  configFor(opt: ActivityOption, alloc: Allocation): ActivityConfig;   // → desired state
  health(s: Snapshot, expected: RateVector): HealthReport;             // actual vs expected; stalls
}
```

**Actions** are one-off: they have preconditions, a cost and an effect.
```ts
interface Action {
  id: ActionId;                                     // "buyAug" | "installAugs" | "buyProgram" | "joinFaction" | ...
  instances(m: Model): ActionInstance[];            // concrete candidates now (e.g. each purchasable aug)
  preconditions(m: Model, a: ActionInstance): Check;
  cost(m: Model, a: ActionInstance): Cost;          // money, focus-time, hashes, …
  apply(m: Model, a: ActionInstance): Model;        // expected effect (used by the fast model)
  irreversible: boolean;                            // installs, BitNode changes, exclusive faction joins
  intentFor(a: ActionInstance): Intent;             // → desired state (idempotency key + guard)
}
```

| Activities (rates) | Actions (one-off) |
|---|---|
| `hwgw` (hacking batcher), `factionWork`, `companyWork`, `crime`, `classes`, `hacknet`, `stocks`, `gang`, `bladeburner`, `corp`, `sleeves`, `darknet`, `stanek`, `go`, `share` | `buyAug`, `installAugs`, `destroyBitNode`, `joinFaction`, `travel`, `buyTor`, `buyProgram`, `upgradeHome`, `buyServer`, `backdoor`, `donate`, `graft`, `casinoRun`, `infiltrationRun`, `solveContract`, `acceptStanek` |

```ts
type RateVector = Partial<{
  money: number; hackExp: number; combatExp: number; chaExp: number; intExp: number;
  rep: Record<FactionName, number>; companyRep: Record<CompanyName, number>;
  karma: number; bbRank: number; hashes: number; corpValuation: number; /* … */
}>;
```

**Scarce resources**, which the planner allocates across activities:

| Resource | Notes |
|---|---|
| Player focus | Exclusive: faction work, company work, crime, class, grafting, infiltration, Bladeburner action, or idle |
| RAM | Home plus purchased plus rooted servers; worker cores matter for grow/weaken |
| Money | Spent by actions (investment and purchases) or held for upcoming costs |
| Sleeves | Up to 8, each an independent focus |
| Hashes | If hacknet servers exist |

### 4.3 Fast model
A cheap, **pure** approximation of the game used for planning rollouts. It is the planner's core dependency.
```ts
interface FastModel {
  init(snapshot: Snapshot): FmState;                       // pure, serialisable
  step(s: FmState, policy: Policy, dtSeconds: number): FmState;
}
// step(): integrates activity rates over dt (exp → levels → rates change, rep accrues, money compounds),
// fires the policy's actions when their triggers hold (Action.apply), including prestige transitions
// (installAugs / destroyBitNode apply the documented persist/reset rules).
```
- **Built from the same pieces** (`Activity.rates`, `Action.apply`), so the fast model and the live estimates can't disagree.
- **Expectation by default:** deterministic and RNG-free. A stochastic mode exists for risk-sensitive choices.
- **Fidelity is measured, not assumed.** Simulator scenarios compare fast-model trajectories against the real engine over the same horizon, and divergence is a tracked metric with a tolerance gate. That's the main job of the "estimate vs actual" calibration loop (§11).
- **Batchable:** rollouts are independent, so they parallelise across workers today and can move to native code or the GPU later behind the same interface (ADR 0006).

### 4.4 Win routes as goal trees
A route is a requirement tree. Its leaves are quantities that activities produce or actions grant. Routes are data, checked against `availability`.

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

Most routes take **several reset cycles** (e.g. 30 *installed* augs for Daedalus). The BitNode level of the planner decomposes the chosen route into per-cycle targets.

### 4.5 Planning hierarchy
| Level | Decides | Cadence | Method |
|---|---|---|---|
| **Campaign** | Which BitNode next | Once per BitNode | Minimise estimated remaining campaign time |
| **BitNode** | Win route + **cycle plan** (a target per reset cycle) | At each install, and when the current cycle is off-plan | Multi-cycle fast-model rollouts |
| **Cycle** | Allocation, purchases, when to install | Every planning tick (30 s) and on events | Candidate-policy rollouts |
| **Reflex** | Execution | Real time, in game | Reflex scripts (§5.5) |

Each level constrains the one below. A level re-plans when its inputs change or the level below reports it can't meet its targets.

#### 4.5.1 Campaign level
- Chooses the next BitNode by minimising **estimated remaining campaign time**, given the current Source-Files and the bonuses each candidate would add.
- Per-BitNode duration estimates come from a table maintained by simulator runs and real telemetry. The draft order in the synthesis is the **prior**.
- **BN12:** `sourceFileOverrides {12: 0}` keeps difficulty at level 1, subject to verification (Q6).

#### 4.5.2 BitNode level
- Chooses the **win route** and produces a **cycle plan**: an ordered list of cycles, each with targets (augs to install, faction/rep targets, stat targets, unlocks) and an expected duration.
- **Method:** candidate cycle plans are scored by multi-cycle fast-model rollouts, including the prestige transitions between cycles. The plan with the lowest projected time-to-destroy wins.
- **Re-planned** at every install, and whenever the cycle level reports its targets are out of reach or the cycle has drifted beyond tolerance.

#### 4.5.3 Cycle level
Every planning tick:
1. **Generate candidate policies.** A policy is a parametrised strategy: allocation rule, action triggers (what to buy at what money threshold), focus target, and an install rule.
   - v0: a small structured family (tens of candidates).
   - Later: search (cross-entropy / MCTS) and GPU-batched rollouts.
2. **Roll each forward** with the fast model to the cycle's targets (or a horizon). The score is the projected time to meet the targets, plus a terminal estimate for the remaining plan.
3. **Install timing falls out of the rollouts.** Candidates differ in when they install, which realises `argmin over t_install of [t_install + ETA_after(multipliers(augs bought by t_install))]`.
   - Aug selection and order is a knapsack under the 1.9× price escalation: most expensive first, Red Pill last.
4. **Apply hysteresis.** The incumbent policy is kept unless a challenger wins by more than the **switching cost** (lost focus bonus, gang task churn, re-batching).
5. **Emit** the desired state (§3, D2) and a decision record (§4.6).

### 4.6 Decision records
Every desired-state version links to a record: the snapshot sequence number, the level that decided, the candidates considered with their scores and key rollout metrics, the choice, and the margin. Records are what the dashboard shows and what the optional LLM supervisor reads (G5, R7).

### 4.7 Hard-coded knowledge
Some things genuinely can't be estimated cheaply: known traps (accept Stanek's Gift before joining Bladeburner with SF7.3), a sensible BN1.1 opening, and similar. These live in a **declarative rules file** of constraints and preferences that the planner consumes. Guardrails, so this doesn't become a scripted campaign by another name:
- Every rule cites its reason (a mechanics doc or telemetry) and has a test.
- Rules constrain or bias candidate generation. They never bypass scoring.
- Rules are debt: each one is deleted once the models derive the same behaviour.

---

## 5. In-game runtime

### 5.1 Agent
- One persistent script, held to a **≤ 3 GB** budget that we enforce.
- It holds the WebSocket to the brain and runs the Snapshotter and Reconciler. It never calls expensive NS functions directly.
- Expensive calls go to **worker scripts**: tiny, single-purpose, short-lived. They write their results to a port or file. This is the fork's `getNsDataThroughFile` pattern, formalised.
- **RAM reservation:** the agent and its workers get a fixed reserved slice of home RAM, sized from measured worker peaks. Reflexes, the batcher in particular, receive their RAM budget from the reconciler and never use the reservation. On an 8 GB start the reservation is the first claim on RAM. When RAM is starved, the agent drops to slower snapshot tiers instead of growing.

### 5.2 Snapshotter
- **Tiered cadence:**

  | Tier | Cadence | Contents |
  |---|---|---|
  | static | once per reset, plus on demand | server max money, min security, required hack level, ports; faction/aug catalogue; BitNode multipliers |
  | slow | 60 s | factions and rep, owned/queued augs, the big subsystems (gang, corp, Bladeburner, sleeves, Dark Net) |
  | medium | 10 s | player stats and exp, server money and security, purchased servers |
  | fast | 2 s | money, player focus, running scripts, reflex health metrics |

- Each tier is one worker batch. Snapshots carry a monotonic sequence number and game timestamps. Tiers are merged into one model on the brain side.

### 5.3 Reconciler
- **Namespace ownership:** the reconciler manages only the scripts it owns: everything under `/agent/`, plus legacy reflexes it launched itself. It never kills or modifies anything else. Foreign scripts' RAM is counted as unavailable. In **observe-only mode** it launches and kills nothing except its own workers.
- **Activities:** for each activity config, it diffs desired against actual: is the reflex running, with which config, and is it healthy. It starts, stops or reconfigures reflexes to close the diff.
- **Intents:** executed at most once.
  - **Game state is the first idempotency check.** For example, `buyAug X` is skipped if X is owned or queued; `joinFaction F` if already a member.
  - The **ledger** on home (it survives installs and BitNode changes) is the backstop for intents the game can't confirm (casino run, donation, infiltration run).
- **Guards:** checked before every intent. Irreversible intents need their guard to hold on two consecutive snapshots (R8).

### 5.4 Safe mode
If the brain has been silent longer than `ttlMs`, the agent **keeps running the last desired state**, minus intents. Reflexes keep producing money and XP; nothing irreversible happens (no installs, no BitNode changes). Progress continues; only optimality is lost.

### 5.5 Reflexes
Real-time loops that are configured by the brain and never decide strategy.
- **Hot configuration:** each reflex re-reads its config (a file or port written by the reconciler) every loop. Script arguments only identify the instance, so a config change never restarts a reflex or drops batches in flight.
- **Health out:** each reflex publishes its metrics (rates, errors, loop latency) to a port the snapshotter reads. That feeds `Activity.health` and the fast-model fidelity metric.
- **Legacy reflexes** (from the retired fork, run through `legacy/` adapters) are launched with their self-launching of helper scripts disabled. Only the reconciler decides which processes exist.

| Reflex | Why it's in game | Source |
|---|---|---|
| HWGW batcher | Millisecond landing precision | Legacy `daemon.js` first; possible rewrite later (§13) |
| Stock trader | Reacts on stock ticks | Legacy `stockmaster.js` |
| Gang ticker | Territory tick (~20 s) swap trick | Legacy `gangs.js` (includes the upstream v3 fix) |
| Bladeburner loop | Action completion events | Legacy `bladeburner.js` |
| Go player | Turn-by-turn play, cheat timing within one 200 ms tick | **New**: AI port plus search, predicted cheats |
| Dark Net crawler | Self-replicating onto frontier servers, sessions per process | **New** |
| Corp cycle | Five-state market cycle | **New** |
| Casino / infiltration | DOM/React-driven, real-time | **New** (UI backend) |

### 5.6 Effectors
The in-game side of §4.2 Actions. The flow is: a brain **Action** becomes an **intent** in the desired state, and the reconciler executes it through an **Effector**.
```ts
interface Effectors {
  joinFaction(f): Result;  purchaseAug(f, aug): Result;  installAugs(cb): Result;
  workForFaction(f, type, focus): Result;  workForCompany(c, focus): Result;  commitCrime(c): Result;
  travel(city): Result;  purchaseTor(): Result;  purchaseProgram(p): Result;  upgradeHomeRam(): Result;
  backdoor(host): Result;  destroyWorldDaemon(nextBN, cb, opts): Result;  /* … */
}
```
- **Backends:**
  - `singularity`: SF4, or inside BN4
  - `ui`: page/React automation through `eval("document")`. This is **on the critical path**: a fresh save has no Singularity, so BN1.1 is played entirely through this backend.
  - `sim`: direct engine calls, simulator only
- Backend selection is automatic, by availability and RAM cost (C4). The `ui` backend also covers the things that never get an API (casino, infiltration).
- Brain-side code never knows which backend is in use.

### 5.7 Bootstrap and restart (C5)
| Transition | Restart path |
|---|---|
| Game load | Autoexec setting → `boot.js` (set once by hand, §10.1) |
| Aug install (SF4) | `installAugmentations("boot.js")` |
| BitNode change (SF4) | `destroyW0r1dD43m0n(n, "boot.js", opts)` |
| Aug install / BitNode change through the UI (before SF4) | The `ui` backend types `run boot.js` into `#terminal-input` from a page-level timer that outlives the dying script. Fallback is save and reload, so autoexec fires. **On the critical path for BN1.1** (Q5). |

`boot.js` is re-entrant: it is safe to run at any time and in any number of copies. It (re)starts the Agent; everything else follows from reconciliation.

**Fresh save:** a new game starts the interactive tutorial. On v3.0.1, while it runs, finished scripts are never cleaned up and never free their RAM (fixed on `dev`; S1 finding). The first thing the Agent does on a fresh save is end the tutorial, through the `ui` backend's equivalent of the Skip button.

---

## 6. Bridge

Two channels, because the game's Remote File API (RFA) only handles files:

| Channel | Direction | Use |
|---|---|---|
| **RFA** (WebSocket server; the game connects to us) | Brain → game requests | Deploy bundles (`pushFile`), `calculateRam` checks, `getDefinitionFile` (live API types for drift detection), `getSaveFile` (backups and simulator seeding) |
| **Control** (WebSocket server; the Agent connects to us) | Both ways | Snapshots up; desired state and intent acknowledgements down; heartbeats |

- The protocol is versioned JSON messages with sequence numbers. On reconnect, the Agent sends a full snapshot and the brain resends the current desired state.
- **Security.** Any web page can open a WebSocket to `localhost`, so:
  - both servers bind to `127.0.0.1` only and accept only the game's origin
  - each allows one client
  - the control channel requires a **shared token**, which the deployer writes to a file only the agent reads
- **Version handshake:** brain and agent are built from the same release. On connect they compare build IDs, and on a mismatch the brain redeploys the agent before anything else.
- **Atomic deploys.** Each release deploys into its own versioned folder (`/agent/<build>/…`) plus a manifest:
  - **Ordering:** libraries first, then entry scripts are re-pushed and their RAM re-verified with `calculateRam`. This works around game issue #2907 (stale RAM cache for importers).
  - **Switch-over:** only after that does `boot.js` switch to the new build, and the reconciler restarts reflexes onto it. Old and new code never mix.
  - **Release gate:** only tagged releases are deployed to Steam.
- **Save backups:**
  - `getSaveFile` every N minutes, with rotation, **plus immediately before every irreversible intent** (install, BitNode change). Save corruption is a known open issue on 3.0.1 (#2809).
  - Backups are our insurance against catastrophic bugs, and the simulator's source of real starting states.

---

## 7. Telemetry and observability
- **Store:** an append-only time series of snapshots (thinned for old data), decision records, estimate-vs-actual errors, reflex health, and transitions. SQLite to start, in the configurable data directory (ADR 0006).
- **Losing the store never breaks play,** because state is always rebuilt from the game. It does lose history and calibration data, so the data directory (store plus save backups) gets a rotating backup.
- **Release tagging:** every record carries the agent release that produced it, so releases can be compared directly ("did v0.4 beat v0.3 on BN1?").
- **Dashboard:** a web page served on **`127.0.0.1` only**. It shows the current route and ETA, the allocation, activity rates (expected against actual), fast-model divergence, a timeline of BitNodes and installs, brain/agent health, and alerts.
- **Alerts** appear **on the dashboard only**: no push notifications. Conditions: a stall (no progress on the route's critical path for X minutes), a reflex crash loop, estimate error above a threshold, brain disconnected, game version changed (hold).
- **Campaign report:** generated from telemetry: clear time, cycles and installs per BitNode, per release. It's our benchmark in place of community numbers.

---

## 8. LLM and ML roles (deliberately narrow)
| Role | What | When |
|---|---|---|
| Fast-model calibration (ML) | Fit correction terms to the fast model from telemetry and simulator runs. Small models, trainable on the local GPU. | Phase 4, or earlier if fidelity demands it |
| Planner search | Rollouts over the fast model. GPU-batched rollouts are the scale-up path (ADR 0006). A learned value function only if search is too slow. | After planner v0 |
| Go engine | Search with the exact ported AI as the opponent; **no reinforcement learning** | With the `go` activity |
| LLM supervisor (optional) | A **local model** on the GPU (~30B class fits in 32 GB). Never in the control loop. | Phase 4 experiment |

**LLM supervisor details:**
- **Event-driven:** it wakes on a stall, a hold, large fast-model divergence or a reflex crash loop, not on a timer.
- **Read-only on the game:** it reads the decision log and telemetry and writes a diagnosis into the decision log, which the dashboard shows. It has no channel to the live game.
- **Proposals go through the normal merge gate:** a proposed change (e.g. a rules-file edit) becomes a PR and is subject to the same CI and independent review as any change. It ships only in a tagged release. No human approval step; proposals show up in release notes.

---

## 9. Simulator

### 9.1 Design
Proven by spike S1 ([report](spikes/s1-headless-engine.md), ADR 0007).
- **Engine:** the real `vendor/bitburner-src` code, bundled for plain Node with esbuild (the module mapping from the game's `jest.config.js`), on jsdom globals. It boots through the game's own `Engine.load`: the new-game path, or the real save-load path including migration and offline progress.
- **Browser parity layer:** the harness reproduces what the browser and UI provide implicitly, and each item gets a test. The [parity audit](sim/parity.md) is the full inventory, with each item's disposition and test:
  - the page's globals (`sprintf`, lodash `_`, `React`), shared between `window` and the global object
  - the UI's popups, toasts, error popup and prompts, as sim events; prompts answered by scenario rules, or left open as with nobody at the screen
  - uncaught errors handled as a browser does; no network
  - browser timer semantics (callbacks run with `this` = `window`), a pinned default locale and time zone
  - `MainUILoaded`, which starts saved scripts and autoexec
  - a headless router with the real router's side effects
  - fake IndexedDB
  - `blob:` script modules through a synchronous module hook
- **Virtual clock:** `@sinonjs/fake-timers` fakes `setTimeout`/`setInterval`/`Date`/`performance`. The game's own `Engine.start` loop runs unmodified on it. Time advances to the next timer, discrete-event style. Results don't depend on the driver's step size.
- **Determinism:**
  - Replace `Math.random` (and confirm the game's `WHRNG` sites) with a seeded PRNG per scenario. Web Crypto's `getRandomValues`/`randomUUID` get a second, independent seeded stream.
  - One process per simulation (game state is global); the parent drives it over IPC, and the host runs requests one at a time, so nothing observes the game mid-advance.
  - An import barrier holds virtual time while a player-script module is still loading (between timers, and before each request), so script start times never depend on real import speed.
  - The fake `Date` also pins the game's clock-seeded randomness (roulette seed, Circadian Modulator).
  - Execution is single-threaded and every timer is virtual, so script interleaving is a function of the seed. A replay test proves it: same seed, same state hash, on any machine. The state hash is the sha256 of the game's own save plus the seeded streams' positions.
- **Same code under test:** the brain connects through an in-process transport, and the in-game bundles run as real NS scripts inside the engine.
- **`sim` effectors** call engine internals directly (e.g. the function a UI button calls). They never grant Source-Files to unlock Singularity, because that would change the state under test.
- **Scenario fixtures:** starting states (each BitNode entry with a given Source-File set, plus odd mid-run states) are built through the engine's own prestige functions. The simulator's own tests may also edit saves the simulator made (e.g. to mark a BitNode finished); edited saves never leave the simulator. Real Steam saves join as fixtures under the one-way save rule (§9.4).
- **Speed (measured in S1):** it depends on the workload, because the engine does whatever work the in-game scripts cause.
  - 10,000–37,000× for lean hacking workloads.
  - 50–700× for heavy script churn or IPvGO-scale compute (the legacy fork from a real save ran at 50–78×).
  - Target: at least **1000×** for our own hacking-phase workloads (workers use `disableLog`). Long-horizon search stays on the fast model (§4.3).
  - Measured on every release, with heap growth over a long run, and recorded per rig in [docs/sim/benchmarks.md](sim/benchmarks.md).
- **Scale-out:** a worker pool, one engine instance per process. Size is `availableParallelism() − reserve`, about 12–14 on the reference rig. A suite (scenarios × seeds) fans out across the pool; results are aggregated into the repeatability metric. Scenario files and the runner: [docs/sim/scenarios.md](sim/scenarios.md). Benchmark workloads may set home's RAM to fit (`homeRamGb`), a harness edit; agent and baseline scenarios don't, so their states stay ones a player can reach.

### 9.2 Fidelity gaps (known and accepted)
- The headless simulator doesn't render the UI, so code that reads the game's DOM fails there (our `ui` effectors, parts of the legacy fork). UI-driver paths are covered by **E2 end-to-end tests on a source build** (§9.4), and only a final smoke check runs on Steam.
- The browser parity layer (§9.1) is hand-written. A missed side effect of the UI is a silent fidelity gap, so the layer is re-audited ([parity audit](sim/parity.md)) whenever the pinned version moves.
- The simulator differs from a browser on purpose in a few places, listed in the [parity audit's summary](sim/parity.md#summary): a simulated player at the UI (prompt rules, error popups closed at once), no network, no windows, autosave off.
- Timing contention under load (batch landing jitter) is modelled with injected jitter that we calibrate from real telemetry.
- Offline progress and save/reload are exercised through the engine's real load path using serialised saves.

### 9.3 Test pyramid
| Level | What | Gate |
|---|---|---|
| Unit | Activity rates and action effects against game formulas (formula parity); fast-model step invariants; planner levels on fixed models; reconciler diffing | Every PR (CI) |
| Property | Reconciler convergence and idempotency, protocol handling of dropped/duplicated/reordered messages, planner invariants, under randomised inputs | Every PR (CI) |
| Contract | In-game bundles type-check against the pinned `NetscriptDefinitions.d.ts`; static RAM ≤ budget | Every PR (CI) |
| Scenario (simulator) | Seeded runs: fresh BN1.1→destroy; entry into each BitNode with representative Source-File sets; odd mid-run states | On demand when touching brain/activities/actions; before every release. Includes **fast-model fidelity** (divergence from the engine over a horizon). |
| Chaos (simulator) | Kill random scripts, drop the brain, reload mid-batch, offline gaps, duplicated messages | Before every release |
| End-to-end (E2 source build) | UI driver actions, bootstrap/restart paths (Q5), Agent RAM in a real 8 GB start (Q1), bridge connect/reconnect, RFA deploy, real save/reload | On demand when touching `ingame/` or `bridge/`; before every release |
| Smoke (E0 Steam) | Short checklist confirming E2 results hold on the shipped binary | Before relying on a new UI path in the campaign |

No scheduled (nightly) runs. The heavy suites are run deliberately, not on a timer. Mutation testing runs periodically on core logic (ADR 0004).

**Repeatability metric:** the pass rate and the time-to-destroy distribution per scenario. A release can't regress either beyond a threshold. The scenario runner reports both: a run passes when a `stopWhen` condition (here `bitnodeDestroyed`) ends it and no `failWhen` condition does, and the time to stop is taken over the runs that passed ([docs/sim/scenarios.md](sim/scenarios.md)).

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
| R1 | **Crash-only.** Every component can be killed at any time; on restart it rebuilds from a snapshot plus persisted brain state (§4.1). No important state lives only in memory. |
| R2 | **Idempotent effects.** Every irreversible action (buy, install, flume, join an exclusive faction) is an intent with a key, a guard and a recorded outcome. Idempotency is judged from game state first, with the ledger as backstop (§5.3). |
| R3 | **Brain-optional progress** (§5.4). |
| R4 | **Bounded in-game RAM.** Agent ≤ 3 GB; every bundle's static RAM is checked in CI and verified live via RFA `calculateRam`. |
| R5 | **Graceful degradation.** A failing activity is marked unhealthy and the planner re-routes around it. |
| R6 | **Version pinning and drift detection** (§12.4). |
| R7 | **Explainability.** Every desired-state version links to its decision record. |
| R8 | **Rate-limited and confirmed irreversibles.** Installs and flumes require the guard to pass on two consecutive snapshots, and a save backup is taken first (§6). |
| R9 | **Liveness.** The brain detects a dead or frozen game (no snapshot for N minutes while the brain is up) and a stalled route (no critical-path progress), and alerts on the dashboard. See §10.2 for automatic recovery. |
| R10 | **Long-run hygiene (24/7).** The game compiles each distinct script source into a module that is never garbage-collected (S1). So in-game code never generates scripts with unique source text: variation goes in arguments and ports, not code. Reflex state is bounded. The Agent reports the page's heap use (`performance.memory`, free through `eval("window")`), so growth is visible before it hurts. |
| R11 | **Injectable time and randomness.** Brain and in-game code read time and randomness only through injected sources. Under the simulator's virtual clock they then behave exactly as live, and runs are reproducible from a seed (ADR 0007). |

### 10.1 Irreducible human steps
1. Install Steam, set the RFA port, set autoexec to `boot.js` in game options, and install the Task Scheduler tasks (one setup script). One time.
2. None during play. The agent plays BN1.1 itself through the `ui` backend; there is no manual phase. Its first action on a fresh save is to skip the tutorial (§5.7).
3. Anything the game gates behind a trusted click. None is known on the critical path so far; flag any we find.
4. Interruptions outside the game (Windows reboots, Steam client updates, power loss) are recovered automatically (§10.2). A human is needed only if recovery gives up and raises an alert.

### 10.2 Recovery: the game is relaunched automatically
The goal is unattended play (C9), so recovery doesn't wait for a human.
- **Who:**
  - The same Windows Task Scheduler setup that supervises the brain (D1) also starts Bitburner at logon, through Steam (`steam://rungameid/<appid>`).
  - Autoexec then runs `boot.js` (§5.7), so a reboot is a short interruption, not a stop.
- **Dead game** (process gone): the brain's supervisor relaunches it the same way.
- **Frozen game** (process alive, no snapshot for N minutes, and the Agent unreachable):
  - The supervisor ends the game process and relaunches it.
  - At most the progress since the last autosave is lost, plus the time offline.
  - This is process management only. Nothing touches game code or the save.
- **Guards:**
  - Relaunches are rate-limited. After K failures in an hour the supervisor stops and raises a dashboard alert, so we don't get a crash loop.
  - Every relaunch is logged with its cause.
- **Pause switch:** the dashboard has a "pause supervision" toggle. While it's on, nothing is relaunched, so the owner can close the game deliberately without the supervisor fighting them.

---

## 11. Data and learning loop
```
real game ──telemetry──► store ◄──runs── simulator
                           │
                  calibration jobs (estimator corrections, per-BN duration table, jitter model)
                           │
                     versioned model params ──► brain
```
- **One store for both worlds:** live telemetry and simulator runs go into the same SQLite store (§7). Every record is tagged with environment (E0/E1/E2), release, scenario and seed.
- **Calibration jobs** fit fast-model corrections, the per-BitNode duration table and the timing-jitter model. They run on demand like the other heavy suites.
- **Model params are code.** Calibration output is a versioned data file that ships through the normal merge gate: PR, CI including the scenario suite, independent review, tagged release. A behaviour change never reaches the live game without the same checks as a code change. This is the same rule as LLM supervisor proposals (§8).

---

## 12. Engineering

### 12.1 Language and build
- **TypeScript on Node** at the core: brain, bridge, simulator, dashboard, in-game code (ADR 0006).
- In-game bundles are built per entry point with esbuild, tree-shaken and minified **without renaming NS identifiers**, then RAM-checked.
- **Rust (napi-rs)** only for profiled hot spots. **Python services** (GPU, ML, local LLM) only in Phase 4. Neither is present until needed.
- Fast CI tiers run on GitHub-hosted runners. Heavy suites run locally on the reference rig through one command. There is no self-hosted runner, because the repo is public.

### 12.2 Repo shape
An npm-workspaces monorepo. Packages are created when the first code that needs them lands, not up front.
```
packages/
  game-types/   generated from NetscriptDefinitions.d.ts (pinned) + live drift check
  core/         model types, Activity/Action interfaces, route definitions, formula shims → vendor/bitburner-src
  brain/        fast model, planner (campaign/BitNode/cycle), activities, actions, rules file
  ingame/       agent, reconciler, workers, reflexes, effectors (singularity|ui|sim), boot.js
  bridge/       RFA server + control channel
  sim/          engine bundle, browser parity layer, virtual clock, scenarios, chaos, worker pool (ADR 0007)
  dashboard/    local web UI
  legacy/       retired-fork scripts (MIT, with notice; fork/ is byte-for-byte, see PROVENANCE.md) + adapters that run them as reflexes; also the simulator baseline
spikes/         throwaway experiments; findings in docs/spikes/
tools/          repository tooling run by Node, under the same gates (upstream-watch: the upstream watchers)
vendor/         bitburner-src submodule (pinned, read-only)
```
- **Dependency direction:** `core` ← `brain`, `ingame`, `sim`, `bridge`; `dashboard` reads the store only. `ingame` never imports from `brain`, because in-game bundles have to stay tiny (C2/C3).
- **Type environments differ per package:** Node-side packages get Node types. `ingame` gets the browser `lib` plus the pinned NS definitions, and no Node types. The single root `tsconfig` splits into per-package configs (project references) before `ingame` lands.
- **Real saves stay local:** Steam save copies used as fixtures live in a gitignored folder. The public repo only carries fixtures generated by the simulator.

### 12.3 Migration from the fork (strangler pattern)
The fork is retired and does **not** play the campaign; the agent plays from BN1.1. The fork's proven parts live on in three ways:
1. **Baseline:** the fork (autopilot + daemon) runs in the simulator as the benchmark the planner must beat (M4 exit). The fork needs a human without SF4, so the fair comparison starts both from the **same BN1 state with SF4.3**, where the fork is fully automatic. For BN1.1 itself (no SF4) the agent is held to absolute targets instead: time-to-destroy and pass rate.
2. **Legacy reflexes:** fork managers (batcher, stocks, gang, Bladeburner) run under the agent through `legacy/` adapters, while the brain owns strategy.
3. **Replacement:** legacy reflexes are replaced one by one, each only when the simulator shows the replacement is at least as good.

### 12.4 Version management
The game source is a git submodule (`vendor/bitburner-src`) pinned to the commit Steam ships (3.0.1 = `1da7316ff`). We can't control when Steam updates, so the strategy is **never broken, at worst degraded**:
1. **See it coming:** a scheduled CI workflow watches upstream `stable`. When it moves, the workflow bumps the submodule on a branch, runs the full suite (including a diff of the API definitions), and opens a PR with a compatibility report. Steam ships from `stable`, so we normally know about a break, and have a fix, before Steam updates.
2. **Hold at runtime:** on every connect the brain checks `VersionNumber` and `getDefinitionFile` against the pinned build. On a mismatch it goes to **hold**: reflexes keep running, no intents, alert raised.
3. **Save backups:** the bridge pulls rotating saves via RFA (§6), so a bad patch or bug can always be rolled back.
4. **Look further ahead:** a cheap, advisory weekly check against upstream `dev` covers API diff, contract typecheck, RAM cost diff and a commit log for a [watchlist](../tools/upstream-watch/watchlist.txt) of game source. It reports into one tracking issue and never blocks merges (ADR 0005, [`tools/upstream-watch`](../tools/upstream-watch/README.md)).

Steam itself is not pinned: game updates are taken as Steam ships them.

Upgrading the pinned version is a normal PR: regenerate types, run the full suite, re-run smoke checks.

---

## 13. Milestones
Each milestone is a [GitHub milestone](https://github.com/UnderMyBed/bitburner-agent/milestones), with epics and task issues carrying the detailed specs (ADR 0008). This table is canonical for deliverables and exit criteria; the issues hold the detailed specs.

| M | Deliverable | Exit criterion |
|---|---|---|
| M0 | Legacy fork retired (upstream merged, archived); repo bootstrapped; design reviewed | ✅ Done |
| S1 | **Simulator spike** (time-boxed, throwaway code under `spikes/`). The whole plan depends on iterating in simulation, so this went first. | ✅ Passed ([report](spikes/s1-headless-engine.md), ADR 0007): headless outside Jest, deterministic, step-invariant, exact save round trip, real Steam saves load and play, 50–37,000× depending on workload |
| M1 | Toolchain and CI first (workspace, test runner, upstream `stable`/`dev` watchers; then branch protection). Then the simulator core, rebuilt test-first from S1 (its work list): engine, browser parity layer, virtual clock, seeded RNG, worker pool, scenario fixtures. Runs the legacy fork from BN1 with SF4.3 to a destroy, which is the baseline (§12.3). Built first so every later milestone is tested against it. | Deterministic replay of a seed; each browser parity item tested; ≥1000× on a lean hacking workload; fork baseline time-to-destroy recorded |
| M2 | Walking skeleton: bridge, Agent, snapshot, telemetry, dashboard (observe-only), liveness and recovery (§10.2); in-game contract typecheck and RAM-budget checks in CI (with the first in-game package); E2 source build plus Playwright harness | Skeleton passes in the simulator and on E2 (connect, snapshot, reload, reconnect, Agent RAM in an 8 GB fresh start); then live snapshots on Steam for 24 h without gaps |
| M3 | Effectors (`ui`, `singularity` and `sim` backends, §5.6) plus bootstrap/restart paths. **Critical path for BN1.1.** | Every BN1 effector and the UI-driven install-and-restart cycle pass E2 tests on the source build and simulator chaos tests; real-game smoke test |
| M4 | Fast model + planner v0 (all three levels, candidate-policy rollouts). Activities: `hwgw`, `factionWork`, `companyWork`, `crime`, `classes`. Actions: `buyAug`, `installAugs`, `destroyBitNode`, `joinFaction`, `travel`, `buyTor`, `buyProgram`, `upgradeHome`, `buyServer`, `backdoor`. WorldDaemon route. | Fast-model fidelity within tolerance on BN1 scenarios; autonomous BN1→destroy in the simulator over N seeds, **at least as fast as the legacy fork**; then **the campaign starts: BN1.1 on Steam from a fresh save** |
| M5+ | Activities/actions in campaign-need order: `gang`, `bladeburner` route, `stocks`, `hacknet`, `corp`, `darknet`, `sleeves`, `stanek`, `go`, `casinoRun`, `infiltrationRun`… | Each with rates/effects in the fast model, a reflex, scenarios and health checks |
| M6 | Campaign selector, calibration loop, (optional) LLM supervisor | Next-BN choice from data; estimate error within bounds |

---

## 14. Risks
| Risk | Impact | Mitigation |
|---|---|---|
| Fast model diverges from the game, so plans are poor | Slow runs | Fidelity metric with a tolerance gate, estimate-vs-actual monitoring, calibration, simulator A/B before deploy |
| Over-engineering delays real progress | Lost wall-clock time | The campaign doesn't start until M4, so M1–M4 stay lean vertical slices; a minimal activity/action set for M4 |
| Simulator fidelity gaps, especially a UI side effect missing from the browser parity layer | False confidence | Each parity item has a test; re-audit when the pinned version moves; real-game smoke tier; calibrate jitter; track sim-vs-real divergence (§9.2) |
| Simulator too slow for heavy workloads (50–700× measured) | Slow scenario suites in late-game nodes | Worker pool; lean in-game code (`disableLog`, no code generation); long horizons on the fast model; profile, then optimise the harness or move hot paths (ADR 0006) |
| Brain process down for long stretches | Suboptimal play | Safe mode; auto-start; alerts |
| Game process dead, frozen or bloated (24/7 run) | Lost wall-clock time | Liveness detection and recovery (R9, §10.2); heap monitoring and no code generation (R10); save backups |
| Steam auto-update mid-campaign | Breakage | Upstream-`stable` watcher PRs, runtime hold, save backups (§12.4) |
| UI-backend fragility (DOM/React changes) | Stalls in BN1 (and any BitNode before SF4) | Critical-path E2 tests on the source build; Singularity replaces most UI use after SF4; smoke tests |
| 8 GB early RAM | Agent can't run alongside the batcher | Strict budgets; workers; the Agent degrades to a slow cadence when RAM-starved |

---

## 15. Open questions
Each open question is tracked as a `type:question` issue; the answer is written back here when it closes.

- **Q1** ([#34](https://github.com/UnderMyBed/bitburner-agent/issues/34)) In-game Agent budget: is 3 GB realistic with WebSocket, workers and port I/O? Measured in M2. The simulator uses the engine's own RAM calculator, so the numbers are exact before E2.
- **Q2** ([#35](https://github.com/UnderMyBed/bitburner-agent/issues/35)) Planner v0: is a small structured family of candidate policies (tens) enough to beat the legacy fork on BN1, or is real search (CEM/MCTS) needed sooner?
- **Q9** ([#39](https://github.com/UnderMyBed/bitburner-agent/issues/39)) Fast-model fidelity: what divergence tolerance (per horizon) is "good enough" for planning? Calibrate on BN1 scenarios in M4.
- **Q3** ~~Steam update control~~ Resolved: we don't try to block updates; see §12.4.
- **Q4** ~~Simulator speed~~ Answered by S1: the engine is bound by how much computing the in-game code does, not by the clock. 10,000–37,000× lean, 50–700× heavy; see §9.1.
- **Q5** ([#36](https://github.com/UnderMyBed/bitburner-agent/issues/36)) The UI-driver restart path before SF4 (terminal injection from a page timer): does it work reliably, or is save-and-reload the safer default? (S1: the load path, including autoexec via `MainUILoaded`, runs in the simulator; terminal injection needs E2.)
- **Q6** ([#37](https://github.com/UnderMyBed/bitburner-agent/issues/37)) Verify the BN12 `sourceFileOverrides {12: 0}` behaviour in the simulator before relying on it.
- **Q7** ~~Where does the fork's RAM-dodging logic go?~~ Resolved:
  - The fork's version generates a temp script with unique source text per call, and S1 found that leaks a module each time (R10).
  - `ingame/workers` is a fixed set of prebuilt worker scripts that take arguments and return results over ports.
  - The fork's version lives only in `legacy/`.
- **Q8** ([#38](https://github.com/UnderMyBed/bitburner-agent/issues/38)) Formula import: can we compile `vendor/bitburner-src` formula modules into `core/` without pulling in React/UI dependencies? S1: importing the engine drags in the whole UI (894 game files plus React/MUI), though it runs fine in Node. Formula-only extraction is still open.
