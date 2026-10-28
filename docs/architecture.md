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
- G2: Survive any interruption (script death, reload, aug install, BitNode change, offline time, our own crashes) with no human repair. The one exception is a reboot: nothing is installed to start the brain (owner decision 30), so the owner runs it again.
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
| C1 | Steam build **v3.0.1** (VersionNumber 51); Steam updates whenever it ships (not pinned) | Pin the *source we test against*, detect drift at runtime, watch upstream `stable` and `dev` (§12.4) |
| C2 | Fresh save means **8 GB home RAM** and every NS function costs RAM | In-game code must be tiny, and expensive calls go in throwaway worker scripts |
| C3 | RAM is charged by **identifier name** across all imported code; only `document`/`window` are special, and `eval("document")`, `WebSocket` and `fetch` are free | Bundling must be per-script and tree-shaken, with a RAM check in CI |
| C4 | No Singularity until SF4; ×16, ×4 and ×1 RAM at SF4.1, 4.2 and 4.3 | All player actions go through **Effectors** (§5.6) with a UI backend and a Singularity backend |
| C5 | All scripts die on aug install or BitNode change; autoexec runs only on game load; `installAugmentations(cb)` and `destroyW0r1dD43m0n(n, cb, opts)` take a callback script | Bootstrap must be re-entrant, with an explicit restart path per transition |
| C6 | hack/grow/weaken run on wall-clock `setTimeout`; hacknet, work and stocks run on 200 ms game cycles | Sub-second logic must live in game; the simulator needs a virtual clock |
| C7 | Electron sets `backgroundThrottling: false` | The game runs at full speed minimised. A brain process outside the game is viable. |
| C8 | Real wall-clock time is the binding cost (~42 node clears plus ~50 BN12 clears) | Optimise for time-to-destroy, and start running early |
| C9 | The game runs 24/7 on the owner's machine. Offline time (reboots, updates) is the exception, and offline progress is lossy (no scripts run; approximated income/rep on reload). | Offline time is an interruption to survive (G2), never a strategy. The planner doesn't rely on offline progress. The brain runs continuously from the repo, restarted after a crash by its runner; after a reboot the owner starts it again (owner decision 30). |

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
- An extra process must be running. Mitigation: safe mode (§5.4) means a missing brain costs optimality, not progress. `npm run brain` restarts it after a crash; after a reboot the owner starts it again, since nothing is installed (owner decision 30).
- An extra transport hop. Not a problem for decisions made on a cadence of seconds or more; sub-second loops stay in game.

**Alternative rejected:** everything in game, the way the fork works. It's RAM-starved, untestable, and needs file-based IPC.

**Supervision:** the brain is meant to run continuously (C9). The owner runs it from the repository (`npm run brain`), in a terminal, until stopped (Ctrl+C). Nothing is installed: no service, no scheduled task, nothing outside the repo (owner decision 30, #122). `npm run brain` runs the brain as a child process and starts it again after a crash, waiting longer in a crash loop (`packages/brain/src/restart-on-crash.ts`). After a reboot, the owner runs it again. Its health is visible on the dashboard. If it's down, the game is in safe mode (§5.4). The brain in turn keeps the game itself alive (§10.2).

### D2 — Desired-state reconciliation, not command streams
The brain publishes a **desired state**, a versioned, declarative document. The in-game Reconciler converges reality toward it with **idempotent** steps, Kubernetes-style.

A dropped message, a duplicate message or a restart therefore never corrupts anything: the next reconcile just recomputes the difference.

Example desired state:
```jsonc
{
  "version": 1842, "issuedAt": 1761300000000, "ttlMs": 43200000,  // built as `ttlMs` (#160): safe mode, §5.4
  "work": { "kind": "faction", "faction": "CyberSec", "workType": "hacking", "focus": true },  // built as `work` (#151); or company work (#153), or a crime (#156)
  "activities": {
    "hwgw":   { "enabled": true, "targets": ["joesguns","phantasy"], "ramBudget": 0.85 },
    "stocks": { "enabled": false },
    "gang":   { "enabled": true, "mode": "respect", "warfare": "auto" }
  },
  "intents": [   // one-shot, in order; the id is the action and its args' values (#141)
    { "id": "purchaseAugmentation(CyberSec, BitWire)", "action": "purchaseAugmentation", "args": { "faction": "CyberSec", "augmentation": "BitWire" } },
    { "id": "installAugmentations(7)", "action": "installAugmentations", "args": { "cycle": 7 }, "guard": { "queuedAugsAtLeast": 6 } }
  ]
}
```

---

## 4. The brain

### 4.1 World model and brain state
- **Snapshot:** raw state from the game (player, servers, factions, augs, BitNode multipliers, gang, corp, Bladeburner, sleeves, Dark Net, stocks, running scripts and RAM). It is the **only source of truth for game state**.
- **Derived model:** the snapshot, normalised and enriched using the game's own functions imported from `vendor/bitburner-src`: hack chance and time, growth, rep gain, exp→level curves, aug price escalation, w0r1d_d43m0n difficulty, and so on. Before SF5, BitNode multipliers come from a static table generated from the game source.
- **Brain state:** the planner's own commitments: the current BitNode plan, cycle targets, and the active policy and when it was chosen. It isn't derivable from the game, so it's persisted in the store and mirrored to a file on home, which survives installs and BitNode changes. A brain restart **resumes** the plan instead of re-planning from scratch, so there's no thrash. Safe mode can read the mirror. Its first part is built (#160): the last desired state, which the Agent keeps in `agent/desired-state.json` for safe mode (§5.4).

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
- **Socket handlers never call `ns`.** While a script awaits a call the game delays, such as `ns.sleep` or `hack`, the game kills it for an `ns` call from any other callback. So the handlers only queue events, and the main loop acts on them ([lifecycle and details](../packages/ingame/README.md#the-agent)).
- **What it runs:** in M2 the Agent only observed, launching and killing nothing but its own workers and `agent/boot.js`. From M3 it also carries out the brain's desired state, starting with the hack loop on the servers other than home (#134, §5.3), then the work the player does (#151, #153, #156), then the brain's intents (#141): buying the hacking programs and home's RAM, travel, and what the owner queues, through the Effectors (§5.6): the game's page from home workers before Singularity, Singularity's own workers once the game has it, or the simulator's own effectors there (#136, #138, #145). With no brain, it keeps converging the hack loop and the work on the last desired state, never its intents (safe mode, §5.4, #160). It still launches and kills only our own scripts, under `agent/`, and touches the page only for what the brain asks and the game's routine dialogs (#143), never over a dialog it leaves to the owner or a line the owner has typed.
- Expensive calls go to **worker scripts**: tiny, single-purpose, short-lived. They write their results to a port or file. This is the fork's `getNsDataThroughFile` pattern, formalised.
- **RAM reservation:** the agent and its workers get a fixed reserved slice of home RAM, sized from measured worker peaks. Reflexes, the batcher in particular, receive their RAM budget from the reconciler and never use the reservation. On an 8 GB start the reservation is the first claim on RAM. When RAM is starved, the Agent skips the tiers whose workers can't start, naming them in the heartbeat, instead of growing (§5.2).

### 5.2 Snapshotter
- **Tiered cadence:**

  | Tier | Cadence | Contents |
  |---|---|---|
  | static | once per Agent start (so once per reset), resent after each welcome | server max money, min security, required hack level, ports; faction/aug catalogue; BitNode multipliers |
  | slow | 60 s | factions and rep, owned/queued augs, purchased servers, the big subsystems (gang, corp, Bladeburner, sleeves, Dark Net) |
  | medium | 10 s | player stats and exp, server money, security, RAM and cores |
  | fast | 2 s | money, player focus, running scripts, reflex health metrics |

- Each tier is one worker batch. Snapshots carry a monotonic sequence number and game timestamps. Tiers are merged into one model on the brain side.
- **M2 contents (#89):** what can be read cheaply without Singularity ([each tier's data](bridge/protocol.md#each-tiers-data)):
  - static: the servers' fixed fields (max money, min security, required hacking level, ports needed, and, from M3, growth);
  - slow: the reset info (installed augmentations, Source-Files, the BitNode) and the purchased servers;
  - medium: the player, the hacking programs they own (from M3), and every server's RAM, cores, money, security and access;
  - fast: money, home's RAM and the scripts on home.

  Reputation, queued augmentations and current work need Singularity, so they come later (M3/M4). Until then, the effectors read what they need from the page: queued augmentations (#149) and the current work (#151, #153, #156; the jobs held are `getPlayer().jobs`).
- **Static once per Agent start:** installing augmentations or changing BitNode kills every script, so a reset always means a new Agent. The Agent keeps the static data and resends it after each welcome. Its server list is as of the Agent's start. Medium scans afresh, so it has servers that appear later (purchased ones, darkweb), and it carries what changes: RAM and cores (home and purchased servers are upgraded), admin rights and backdoors.
- **The fast snapshot is the heartbeat:** it's sent every 2 s even when no worker can run, with `game: null` and the skipped tiers in `degradedTiers`. A full home never looks like a dead game.
- **Workers** run one at a time, as temporary scripts, and report through a port. Every wait ends with its 2 s round, so the heartbeat is never more than 4 s apart, whatever the workers do. A worker that can't start, doesn't report in its round or is still running leaves its tier skipped that time, and named in `degradedTiers` until it next succeeds ([details](../packages/ingame/README.md#snapshots)).

### 5.3 Reconciler
- **First slice (M3, #134):** the hack loop. The brain's desired state has one activity, `hackLoop { enabled, target, hosts }`: the brain picks the target and the servers it runs on (the game's, never home or the player's own). The Agent converges on it with two home workers (root what it can, then start and stop the loops), when it changes and every 30 s ([`packages/ingame`](../packages/ingame/README.md#the-hack-loop)). Slices 2 and 3 (#136, #138) bought the hacking programs and home's RAM through the `ui` effector (§5.6). The fourth (#141) turns one-shot actions into **intents**: `intents: [{ id, action, args }]` in the desired state, each done at most once, in order, until the game shows it done, with the game's state as the first idempotency check. Purchases and travel are intents, from the brain's purchase rules (one at a time, the cheaper first) and the owner's manual queue on the dashboard (owner decision 36). The Agent reports each intent's outcome in the fast snapshot, and a stuck one is an alert. Property tests cover the intent runner's convergence and idempotency ([`packages/ingame`](../packages/ingame/README.md#intents)). The fifth (#143) handles the game's routine dialogs every round (owner decision 35). The seventh (#147) adds `joinFaction`, and with it the first irreversible intent, joining a faction that has enemies, and its gate (below); its second half (#149) adds `purchaseAugmentation`, NeuroFlux Governor a level at a time. The eighth (#151) adds the second activity, **work**: `work { kind: "faction", faction, workType, focus }`, or company work (#153, `{ kind: "company", company, field, focus }`, the job applied for first), or a crime (#156, `{ kind: "crime", crime, focus }`), or none, set by the owner on the dashboard and converged on by the Agent when it changes and every 30 s, focused unless the Neuroreceptor Management Implant is installed (owner decision 37) or the job is part-time; with none, the game's work is left alone ([`packages/ingame`](../packages/ingame/README.md#work)). The twelfth (#160) is safe mode (§5.4): the hack loop and the work go on with the brain gone. Activities with reflex health come with the first real reflex, M4's batcher.
- **Namespace ownership:** the reconciler manages only the scripts it owns: everything under `/agent/`, plus legacy reflexes it launched itself. It never kills or modifies anything else. Foreign scripts' RAM is counted as unavailable.
- **Activities:** for each activity config, it diffs desired against actual: is the reflex running, with which config, and is it healthy. It starts, stops or reconfigures reflexes to close the diff.
- **Intents:** executed at most once.
  - **Game state is the first idempotency check.** For example, `purchaseAugmentation X` is skipped if X is owned or queued; `joinFaction F` if already a member.
  - The **ledger** on home (it survives installs and BitNode changes) is the backstop for intents the game can't confirm (casino run, donation, infiltration run).
- **Guards:** checked before every intent. Irreversible intents need their guard to hold on two consecutive snapshots (R8). Built in #147, in the brain (`DesiredStateController`): an irreversible intent from the queue goes out only once its guard has held on two consecutive medium snapshots from the connected Agent, received after it was queued, and a save backup asked for then (`SaveBackups.backupNow`, §6) has succeeded ([`packages/brain`](../packages/brain/README.md#intents)). One irreversible intent at a time, in the queue's order, so two that conflict never go out together. The guard fails closed on a snapshot it can't read. Once out, the guard is still judged, and an intent not done within 60 medium snapshots goes back behind the gate for a new backup. A failed guard or backup starts the count again, and a disconnect or a restarted brain forgets it, the safe way. So far the irreversible intents (core's `isIrreversibleIntent`) are joins of the six city factions, whose enemies a join bans; the guard is that none of those enemies is joined. Installs and BitNode changes join them in their slices.

### 5.4 Safe mode
With the brain gone, the Agent **keeps converging on the last desired state**, minus intents, until its `ttlMs` passes. Reflexes keep producing money and XP; nothing irreversible happens (no installs, no BitNode changes, no exclusive faction joins). Progress continues; only optimality is lost.

Built in #160 ([`packages/ingame`](../packages/ingame/README.md#safe-mode)):
- **What converges:** the activities, today the hack loop and the work, at their own cadence; the Agent's dialog watcher runs too. Never the intents: one-shot actions need the brain, and are forgotten at a disconnect. No snapshots, except the slow worker once, unsent, for the reset check.
- **`ttlMs`** is set by the brain on every state (`SAFE_MODE_TTL_MS`, 12 hours), and counts from when the Agent was last connected to the brain that sent the state, not from when it was sent. Nothing in a state turns harmful with time alone; the bound is on how long a stopped brain's choices outlive it.
- **A connected brain's word comes first:** while connected, the Agent acts only on what that brain sends. A brain back sends a fresh state, which replaces the kept one.
- **Kept on home** in `agent/desired-state.json`, outside the deployment folders, so a reload, an install's restart and a new deployment's Agent have it: written when a state arrives, every 60 s while connected to its brain, and at the disconnect. `ns.write` and `ns.read` cost no RAM.
- **Dropped** on expiry, and after a reset: a state from the file waits for the slow snapshot's `lastAugReset`, and is dropped if it has moved, since its target may be unhackable and its work gone. A reset always means a new Agent, so the running Agent's own state never needs the check.
- **Tested** by property tests (never past `ttlMs`, from before a reset, other than the last state a brain sent, or with intents; and converging otherwise), simulator chaos tests (the brain down for an hour with a reload in the middle, expiry, a reset, a new deployment), and E2 (the work refocused on the real page with the brain stopped, before and after a reload).

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
  - `ui`: page/React automation through `eval("document")` (indirect: `globalThis.eval`). This is **on the critical path**: a fresh save has no Singularity, so BN1.1 is played entirely through this backend.
  - `sim`: direct engine calls, simulator only
- **First `ui` effector (M3, #136):** buying the TOR router at a tech vendor and the port openers through the terminal ([`packages/ingame`](../packages/ingame/README.md#the-hacking-programs)). The page is driven through React's own handlers, from a home worker that ends within the Agent's round; E2 tests it on the real page. The second (#138) upgrades home's RAM at the same vendors, through the same page code ([`packages/ingame`](../packages/ingame/README.md#home-ram)). Since #141 each action an intent names has an entry in the Agent's Effector table (`packages/ingame/src/agent/effectors.ts`): the worker that does it and its arguments. `travel` is the third `ui` effector, and `joinFaction` (#147, the Factions page's "Join!") the fourth. `purchaseAugmentation` ([#149](../packages/ingame/README.md#buying-augmentations)) is the fifth: a faction's augmentations page, "Buy" only while the page enables it, its confirmation and alert handled; the page's "Owned" is the check for a queued augmentation, which no NS call shows without Singularity. Since #143 the Agent handles the game's routine dialogs before any page work, every round (owner decision 35): it closes the game's alerts and answers faction invitations "Decide later", reporting what each said, and leaves any other dialog to the owner, which blocks the page until it's closed. Since #151 every page effector keeps the player's focus on work: the Work page hides the sidebar, so a focused player is unfocused first ("Do something else simultaneously") and focused again after (the overview's "Focus"); and work itself is the first activity with `ui`, `singularity` and `sim` effectors (faction work: the faction's page, `workForFaction`; company work, #153: the company's page in its city, its "Apply" and "Work", or `applyToCompany` and `workForCompany`; a crime, #156: the Slums' crime buttons, or `commitCrime`).
- Backend selection is automatic, by availability and RAM cost (C4). Built in #145: per try, the Agent uses the simulator's own effectors where the page has them (`sim`; they call what the page's handlers call, and never grant Source-Files); else Singularity once its slow snapshot shows SF4 or BN4 and the action's Singularity worker fits home beside the Agent (with less than SF4.3 the game charges it 4× or 16×); else the page (`ui`). The fit is checked every try, so a home upgrade brings Singularity back. The outcome in the fast snapshot, the Agent's log and the dashboard name the backend. The `ui` backend also covers the things that never get an API (casino, infiltration).
- Brain-side code never knows which backend is in use.

### 5.7 Bootstrap and restart (C5)
| Transition | Restart path |
|---|---|
| Game load | Autoexec setting → `agent/boot.js` (set once by hand, §10.1) |
| Aug install (SF4) | `installAugmentations("agent/boot.js")` |
| BitNode change (SF4) | `destroyW0r1dD43m0n(n, "agent/boot.js", opts)` |
| Aug install / BitNode change through the UI (before SF4) | The `ui` backend types `run agent/boot.js` into `#terminal-input` from a page-level timer that outlives the dying script. Fallback is save and reload, so autoexec fires. **On the critical path for BN1.1** (Q5). |

`agent/boot.js` (its fixed path in the [deploy layout](../packages/ingame/README.md#deploy-layout)) is re-entrant: it is safe to run at any time and in any number of copies. It starts the current deployment's Agent if that isn't running; everything else follows from reconciliation.

**Fresh save:** a new game starts the interactive tutorial. On v3.0.1, while it runs, finished scripts are never cleaned up and never free their RAM (fixed on `dev`; S1 finding). The first thing the Agent does on a fresh save is end the tutorial, through the `ui` backend's equivalent of the Skip button.

---

## 6. Bridge

Two channels, because the game's Remote File API (RFA) only handles files:

| Channel | Direction | Use |
|---|---|---|
| **RFA** (WebSocket server; the game connects to us) | Brain → game requests | Deploy bundles (`pushFile`), `calculateRam` checks, `getDefinitionFile` (live API types for drift detection), `getSaveFile` (backups and simulator seeding) |
| **Control** (WebSocket server; the Agent connects to us) | Both ways | Snapshots up (the fast one, every 2 s, is the heartbeat, and carries the intents' outcomes, #141, and the game's dialogs the Agent handled, #143); desired state down (M3) |

- The protocol is versioned JSON messages with sequence numbers ([docs/bridge/protocol.md](bridge/protocol.md)). On reconnect, the Agent sends a full snapshot and the brain resends the current desired state (M3).
- **Security.** Any web page can open a WebSocket to `localhost`, so:
  - both servers bind to `127.0.0.1` only and accept only the game's origin
  - each allows one client: the newest accepted connection replaces the old one
  - the control channel requires a **shared token**, which the deployer writes to a file only the agent reads
- **Version handshake:** the Agent's `hello` names its deployment and the game's version. The channel checks the version against `PINNED_GAME`: on a mismatch it holds for the brain's run (§12.4). Otherwise, if the deployer knows a different deployment is deployed, isn't on hold and its last deploy didn't fail, the brain tells the Agent to restart onto it, once per outdated deployment, so neither a hold, a failed deploy nor a reloaded save can cause a restart loop.
- **Atomic deploys** ([#91](https://github.com/UnderMyBed/bitburner-agent/issues/91); the steps are in [the protocol](bridge/protocol.md#deploying)). On every RFA connection, unless on hold, the deployer deploys the brain's build. Each deployment (a build plus its configuration) goes into its own folder (`agent/<deploymentId>/…`; the layout is in [`packages/ingame`](../packages/ingame/README.md#deploy-layout)):
  - **RAM:** every script, `boot.js` included, is pushed into the folder and measured there with `calculateRam`, the game's own calculator. Any script over its budget aborts the deploy before a shared path changes. A Singularity worker's budget is at SF4.3; with less of SF4 the game multiplies its functions' cost, never the 1.6 GB base, by up to 16, so it may cost up to 1.6 GB plus 16 times the rest of its budget (#145). Bundles are self-contained and every deployment has new paths, so game issue #2907 (stale RAM cache for importers) can't arise; a simulator test shows the game measuring a new build's own RAM.
  - **Switch-over:** only then does the deployer update `agent/boot.js` (if it differs), and `agent/current.txt` last. It then has the old Agent restart: it runs `agent/boot.js` with its pid and exits, and `boot.js` waits for it to go, then starts the new deployment's Agent. `boot.js` itself never stops an Agent. The reconciler then restarts reflexes onto the new deployment (M4, with the first real reflex).
  - **Saved at the next autosave:** `pushFile` doesn't save the game. A deployment is in the save only after the next autosave (every 60 s by default). If the game reloads before then, the next RFA connection deploys again.
  - **Release gate:** only tagged releases are deployed to Steam. That's a rule of how it's run ([docs/setup.md](setup.md)): the owner runs the brain from a release checkout; the brain doesn't enforce it. The exception is a release's own live run ([releasing](releasing.md) step 2), which runs the candidate commit before it's tagged.
- **Save backups** ([#92](https://github.com/UnderMyBed/bitburner-agent/issues/92); details in [`packages/brain`](../packages/brain/README.md#save-backups)):
  - **When:** `getSaveFile` on every RFA connection and every `saveBackupIntervalMinutes` (30 by default). From M3 there's also one **immediately before every irreversible intent** (an exclusive faction join since #147; installs and BitNode changes in their slices; R8, #11), and the intent waits for it to succeed. Save corruption is a known open issue on 3.0.1 (#2809).
  - **What's kept:** the game's save at that moment, in the gzip format Steam writes, checked to be what the game's own Import Game accepts, in `<data dir>/saves/<environment>/`. Rotation keeps the newest `saveBackupsKept` (96: two days at the default interval) per environment. A failed or damaged backup is recorded (`saveBackup` events), never kept.
  - **Sharing the connection:** the backups share the RFA connection with the deployer, each on its own client. Request ids are unique per connection.
  - **Why:** backups are our insurance against catastrophic bugs, and the simulator's source of real starting states: a backup loads as a save fixture. Only `E0` backups may ever go back into Steam (§9.4).

---

## 7. Telemetry and observability
- **Store:** an append-only time series of snapshots, decision records, estimate-vs-actual errors, reflex health, and transitions. It's SQLite through Node's built-in `node:sqlite`, in the brain's data directory, by default the repo's gitignored `.data/` (owner decision 30; [`packages/brain`](../packages/brain/README.md#the-telemetry-store)). Old data is thinned once the campaign's months of data need it (M4). The gap report over its fast snapshots is the evidence for M2's live criterion.
- **Losing the store never breaks play,** because state is always rebuilt from the game. It does lose history and calibration data, so the data directory (store plus save backups) gets a rotating backup once the campaign starts (M4, [#15](https://github.com/UnderMyBed/bitburner-agent/issues/15)).
- **Release tagging:** every record carries the agent release that produced it, so releases can be compared directly ("did v0.4 beat v0.3 on BN1?").
- **Dashboard:** a web page the brain serves on **`127.0.0.1` only**, refusing foreign `Host` headers (DNS rebinding) and writes from other pages.
  - **Built in M2** ([#93](https://github.com/UnderMyBed/bitburner-agent/issues/93); [`packages/brain`](../packages/brain/README.md#the-dashboard)): skeleton health (the Agent, the last snapshot per tier, key game values, gaps over 24 h), alerts, recent events, and the supervision switch (§10.2).
  - **Later (M4 on):** the current route and ETA, the allocation, activity rates (expected against actual), fast-model divergence, and a timeline of BitNodes and installs.
- **Alerts** appear **on the dashboard only**: no push notifications. They're rules over the store, evaluated whenever the dashboard reads status.
  - **Built in M2:** the Agent silent (no heartbeat for 60 s with the brain up), a version hold, a failed deploy, and the supervisor giving up (#94). A brain that's down shows as "brain unreachable". **M3:** an intent stuck, tried 5 times without being done (#141), and a dialog the Agent leaves for the owner blocking the page (#143).
  - **Later:** a stall (no progress on the route's critical path for X minutes) needs a route, so it comes with the planner (M4). A reflex crash loop comes with reflexes (M4), and estimate error above a threshold with the fast model (M4).
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
- **Engine:** the real `vendor/bitburner-src` code, bundled for plain Node with esbuild (the module mapping from the game's `jest.config.js`), on jsdom globals. One game file differs in the bundle: the script module cache gets strong `WeakRef`/`FinalizationRegistry` stand-ins, so garbage collection can't change results ([#73](https://github.com/UnderMyBed/bitburner-agent/issues/73), [parity audit §8](sim/parity.md#8-the-simulators-own-parity-layer)). It boots through the game's own `Engine.load`: the new-game path, or the real save-load path including migration and offline progress.
- **Browser parity layer:** the harness reproduces what the browser and UI provide implicitly, and each item gets a test. The [parity audit](sim/parity.md) is the full inventory, with each item's disposition and test:
  - the page's globals (`sprintf`, lodash `_`, `React`), shared between `window` and the global object
  - the UI's popups, toasts, error popup and prompts, as sim events; prompts answered by scenario rules, or left open as with nobody at the screen
  - uncaught errors handled as a browser does; no network, apart from WebSockets to the parent, which cross in lockstep with the virtual clock (ADR 0012)
  - browser timer semantics (callbacks run with `this` = `window`), a pinned default locale and time zone
  - `MainUILoaded`, which starts saved scripts and autoexec
  - a headless router with the real router's side effects
  - fake IndexedDB
  - `blob:` script modules through a synchronous module hook
- **Virtual clock:** `@sinonjs/fake-timers` fakes `setTimeout`/`setInterval`/`Date`/`performance`. The game's own `Engine.start` loop runs unmodified on it. Time advances to the next timer, discrete-event style. Results don't depend on the driver's step size. fake-timers is loaded with one patch (`clock.ts`), so the clock's cost per step no longer grows in proportion to the timers pending ([#74](https://github.com/UnderMyBed/bitburner-agent/issues/74)). Timer delays and the nesting clamp follow Chromium 146, Steam's Electron 41 ([#80](https://github.com/UnderMyBed/bitburner-agent/issues/80)).
- **Determinism:**
  - Replace `Math.random` (and confirm the game's `WHRNG` sites) with a seeded PRNG per scenario. Web Crypto's `getRandomValues`/`randomUUID` get a second, independent seeded stream.
  - One process per simulation (game state is global); the parent drives it over IPC, and the host runs requests one at a time, so nothing observes the game mid-advance.
  - An import barrier holds virtual time while a player-script module is still loading (between timers, and before each request), so script start times never depend on real import speed.
  - The fake `Date` also pins the game's clock-seeded randomness (roulette seed, Circadian Modulator).
  - Execution is single-threaded and every timer is virtual, so script interleaving is a function of the seed. A replay test proves it: same seed, same state hash, on any machine. The state hash is the sha256 of the game's own save plus the seeded streams' positions.
- **Same code under test:** the in-game bundles run as real NS scripts inside the engine, and their sockets (the Agent's, and the game's own RFA client's) reach the brain in the parent process, in lockstep with the virtual clock ([ADR 0012](decisions/0012-simulator-network-in-lockstep.md)).
- **`sim` effectors** call engine internals directly (e.g. the function a UI button calls). They never grant Source-Files to unlock Singularity, because that would change the state under test.
- **Scenario fixtures:** starting states (each BitNode entry with a given Source-File set, plus odd mid-run states) are built through the engine's own prestige functions. The simulator's own tests may also edit saves the simulator made (e.g. to mark a BitNode finished); edited saves never leave the simulator. Real Steam saves join as fixtures under the one-way save rule (§9.4).
- **Speed (measured in S1):** it depends on the workload, because the engine does whatever work the in-game scripts cause.
  - 10,000–37,000× for lean hacking workloads.
  - 50–700× for heavy script churn or IPvGO-scale compute (the legacy fork from a real save ran at 50–78×).
  - Target: at least **1000×** for our own hacking-phase workloads (workers use `disableLog`). Long-horizon search stays on the fast model (§4.3).
  - Measured on every release, with heap growth over a long run, and recorded per rig in [docs/sim/benchmarks.md](sim/benchmarks.md).
- **Scale-out:** a worker pool, one engine instance per process. Size is `availableParallelism() − reserve`, about 12–14 on the reference rig. A suite (scenarios × seeds) fans out across the pool; results are aggregated into the repeatability metric. Long runs can take a hard real-time limit per seed, which the parent enforces by killing the seed's process, and a heap cap per process ([scenarios](sim/scenarios.md#the-cli)). The fork baseline, which is heavy, runs one seed at a time by default, with a 60-minute real-time limit and a 2 GB cap ([baselines](sim/baselines.md#running-it)). Scenario files and the runner: [docs/sim/scenarios.md](sim/scenarios.md). Benchmark workloads may set home's RAM to fit (`homeRamGb`), a harness edit; agent and baseline scenarios don't, so their states stay ones a player can reach.

### 9.2 Fidelity gaps (known and accepted)
- The headless simulator doesn't render the UI, so code that reads the game's DOM fails there (our `ui` effectors, parts of the legacy fork). UI-driver paths are covered by **E2 end-to-end tests on a source build** (§9.4), and only a final smoke check runs on Steam.
- The browser parity layer (§9.1) is hand-written. A missed side effect of the UI is a silent fidelity gap, so the layer is re-audited ([parity audit](sim/parity.md)) whenever the pinned version moves.
- The simulator differs from a browser on purpose in a few places, all listed in the [parity audit's summary](sim/parity.md#summary): for example a simulated player at the UI (prompt rules, error popups closed at once), no windows, and sockets only to the parent (ADR 0012).
- Timing contention under load (batch landing jitter) is modelled with injected jitter that we calibrate from real telemetry.
- Offline progress and save/reload are exercised through the engine's real load path using serialised saves.

### 9.3 Test pyramid
| Level | What | Gate |
|---|---|---|
| Unit | Activity rates and action effects against game formulas (formula parity); fast-model step invariants; planner levels on fixed models; reconciler diffing | Every PR (CI) |
| Property | Reconciler convergence and idempotency, protocol handling of dropped/duplicated/reordered messages, planner invariants, under randomised inputs | Every PR (CI) |
| Contract | In-game bundles type-check against the pinned `NetscriptDefinitions.d.ts`; static RAM ≤ budget | Every PR (CI) |
| Integration (simulator) | The brain, bridge and built in-game code together on the lockstep driver, including the skeleton suite: connect, snapshot, reload, reconnect, Agent RAM in an 8 GB start, and dropped or duplicated snapshot frames ([`packages/brain`](../packages/brain/README.md#the-skeleton-suite)) | Every PR (CI) |
| Scenario (simulator) | Seeded runs: fresh BN1.1→destroy; entry into each BitNode with representative Source-File sets; odd mid-run states | On demand when touching brain/activities/actions; before every release. Includes **fast-model fidelity** (divergence from the engine over a horizon). |
| Chaos (simulator) | Kill random scripts, drop the brain, reload mid-batch, offline gaps, duplicated messages | Before every release |
| End-to-end (E2 source build) | UI driver actions, bootstrap/restart paths (Q5), Agent RAM in a real 8 GB start (Q1), bridge connect/reconnect, RFA deploy, real save/reload | On demand when touching `ingame/` or `bridge/`; before every release |
| Smoke (E0 Steam) | Short checklist confirming E2 results hold on the shipped binary | Before relying on a new UI path in the campaign |

No scheduled (nightly) runs. The heavy suites are run deliberately, not on a timer. Mutation testing runs periodically on core logic (ADR 0004).

**Repeatability metric:** the pass rate and, for scenarios that stop on a destroy, the time-to-destroy distribution. A release can't regress either beyond a threshold. Comparisons with the fork baseline use checkpoints instead, since a run to a destroy costs hours per seed ([ADR 0011](decisions/0011-checkpointed-simulator-comparisons.md)). The scenario runner reports both: a run passes when a `stopWhen` condition (here `bitnodeDestroyed`) ends it and no `failWhen` condition does, and the time to stop is taken over the runs that passed ([docs/sim/scenarios.md](sim/scenarios.md)).

### 9.4 Environments
| Env | What | Used for |
|---|---|---|
| **E0 Steam** | Vanilla 3.0.1 binary and the real campaign save | The campaign. Final smoke checks only. Never used as a test bed. |
| **E1 Simulator** | Engine from `vendor/bitburner-src` in Node; no UI; virtual clock; seeded RNG | The skeleton suite (every PR), scenario and chaos suites, calibration, the speed target |
| **E2 Source build (browser)** | `vendor/bitburner-src` @ `1da7316ff` built with the game's own webpack config in production mode (`npm run e2:build`, into `.cache/e2/<commit>/`), served on 127.0.0.1, driven by Playwright 1.59 (its Chromium 147 headless shell; Steam's Electron 41 is Chromium 146, and no Playwright release ships 146). Playwright's clock control lets the real UI run time-accelerated, paced at up to ×20 so real-time work (imports, socket replies) keeps up ([`packages/e2`](../packages/e2/README.md)). | End-to-end tests of everything that touches the UI, the bootstrap or the bridge. Debugging game internals with breakpoints and logs. |
| **E3 Electron from source** *(only if needed)* | `npm run electron` from the same commit | Only if Electron-specific behaviour (file protocol, Steam hooks) diverges from E2 |

**Guardrails**
- **Parity:** E1 and E2 build from the pinned commit, the same source Steam ships. The brain checks the live game against them: its `getDefinitionFile` on every RFA connection, and the version each Agent's `hello` reports (§12.4).
- **Vanilla-only dependency:** the agent (in-game bundles and brain) must never rely on behaviour that doesn't exist in unmodified 3.0.1.
  - Instrumentation (clock, RNG seeding, observation hooks) lives in the **harness** and is injected from outside, either by the simulator harness or by Playwright.
  - The game build itself is never patched for E2 runs. Its build config changes only how it's built (where to, the minifier on one core, without the separate typecheck process), and the harness's one page-side shim restores browser behaviour Playwright's clock lacks (timer callbacks' `this`).
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
| R8 | **Rate-limited and confirmed irreversibles.** Installs, flumes and exclusive faction joins require the guard to pass on two consecutive snapshots, and a save backup is taken first (§6, §5.3). |
| R9 | **Liveness.** The brain detects a dead or frozen game (no new heartbeat for 5 minutes while the brain is up; §10.2) and a stalled route (no critical-path progress), and alerts on the dashboard. See §10.2 for automatic recovery. |
| R10 | **Long-run hygiene (24/7).** The game compiles each distinct script source into a module that is never garbage-collected (S1). So in-game code never generates scripts with unique source text: variation goes in arguments and ports, not code. On v3.0.1 the game's cache holds those modules weakly, so a source that returns after a garbage collection compiles, and leaks, a new module, with its module-level variables reset. In-game code therefore keeps no state at module level that it relies on either lasting or resetting. (The simulator holds every module, as upstream dev does: [#73](https://github.com/UnderMyBed/bitburner-agent/issues/73).) Reflex state is bounded. The Agent reports the page's heap use (`performance.memory`, a global scripts can read for free) in every fast snapshot (`pageHeapUsedBytes`), so growth is visible before it hurts: the dashboard shows the latest, and `npm run gaps` its range over a window ([the gap report](../packages/brain/README.md#the-gap-report)). |
| R11 | **Injectable time and randomness.** Brain and in-game code read time and randomness only through injected sources. Under the simulator's virtual clock they then behave exactly as live, and runs are reproducible from a seed (ADR 0007). |

### 10.1 Irreducible human steps
1. One time, following [docs/setup.md](setup.md) (#95):
   - install Steam and Bitburner;
   - in a clone of the repo, `npm run bootstrap`, then `npm run brain`. The brain launches the game itself, so pause supervision while setting up;
   - on a new save, exit the tutorial (until the agent does it itself, §5.7);
   - in the game's options, set the Remote API's Hostname to `127.0.0.1` (the brain listens there only, not on `localhost`) and port 12525, with a reconnection delay above 0, and click Connect (changing the settings alone doesn't connect);
   - set autoexec to `agent/boot.js`, and save the game so the settings are kept;
   - once the brain has deployed, run `agent/boot.js` once in the game's terminal: autoexec fires at load, before the first deploy exists;
   - resume supervision.
2. None during play. The agent plays BN1.1 itself through the `ui` backend; there is no manual phase. Its first action on a fresh save is to skip the tutorial (§5.7).
3. Anything the game gates behind a trusted click. None is known on the critical path so far; flag any we find.
4. Interruptions of the game (it closes, freezes, or Steam restarts it) are recovered automatically while the brain runs (§10.2). A human is needed if recovery gives up and raises an alert, and to start the brain again after a reboot: nothing is installed to do it (owner decision 30). A crash of the brain itself is restarted by `npm run brain` (D1).

### 10.2 Recovery: the game is relaunched automatically
The goal is unattended play (C9), so recovery of the game doesn't wait for a human while the brain runs. A brain crash is recovered by its runner (D1); a reboot needs the owner to run `npm run brain` again.
Built in M2 ([#94](https://github.com/UnderMyBed/bitburner-agent/issues/94); [`packages/brain`](../packages/brain/README.md#supervision)).
- **Who:**
  - **The brain, while it runs** (`npm run brain`, from the repo; D1). Its supervisor finds Bitburner isn't running and launches it through Steam (`steam://rungameid/1812820`), so starting the brain starts both.
  - Autoexec then runs `agent/boot.js` (§5.7). After a reboot, the owner starts the brain again, and the rest follows.
  - Only an E0 brain on Windows supervises (Steam's game); a source build's brain (E2) never launches or kills anything.
- **Judged by checks, not clocks:** the supervisor looks every 30 s. Its waits are counted in checks, and a heartbeat counts as new by being a new snapshot, so a clock that steps can't fake silence or hide it.
- **Dead game** (process gone): the supervisor relaunches it the same way. After a launch it waits 5 minutes before anything else, so a slow Steam (starting, logging in, updating) isn't launched over and over.
- **Silent game** (process alive, but no new heartbeat for 5 minutes, after a 5-minute grace from the brain's start or a resume; after a launch, the grace starts once the launch's 5-minute wait is over, so the earliest kill is 10 minutes after it):
  - The supervisor ends the game process and relaunches it.
  - This covers a frozen page, and an Agent that died while the game runs: the brain has no other way to restart it, and a reload brings it back through autoexec.
  - At most the progress since the last autosave is lost, plus the time offline.
  - This is process management only. Nothing touches game code or the save.
- **Guards:**
  - At most 3 launches in any hour, counted from the store, so a restarting brain can't get round it. A 4th means the supervisor gives up and raises a dashboard alert, so we don't get a crash loop. So do 10 failed checks in a row (a command that keeps failing). It stays given up until the owner resumes it.
  - Every launch is recorded with its cause (`relaunch` events).
- **Pause switch:** the dashboard has a "pause supervision" toggle. While it's on, nothing is launched or killed, so the owner can close the game deliberately, or set it up, without the supervisor fighting them. Resuming also clears a give-up.

---

## 11. Data and learning loop
```
real game ──telemetry──► store ◄──runs── simulator
                           │
                  calibration jobs (estimator corrections, per-BN duration table, jitter model)
                           │
                     versioned model params ──► brain
```
- **One store for both worlds:** live telemetry and simulator runs go into the same SQLite store (§7). Every record is tagged with environment (E0/E1/E2) and release, and simulator runs with scenario and seed once scenarios store their runs (M4). Under the simulator the brain's clock is virtual time (the lockstep driver, [`packages/brain`](../packages/brain/README.md#the-lockstep-driver)), so its records are reproducible from the seed.
- **Calibration jobs** fit fast-model corrections, the per-BitNode duration table and the timing-jitter model. They run on demand like the other heavy suites.
- **Model params are code.** Calibration output is a versioned data file that ships through the normal merge gate: PR, CI including the scenario suite, independent review, tagged release. A behaviour change never reaches the live game without the same checks as a code change. This is the same rule as LLM supervisor proposals (§8).

---

## 12. Engineering

### 12.1 Language and build
- **TypeScript on Node** at the core: brain, bridge, simulator, dashboard, in-game code (ADR 0006).
- In-game bundles are built per entry point with esbuild, self-contained and tree-shaken but **not minified**: the game charges RAM by identifier name, so names stay as written, apart from a top-level name esbuild renames where two modules collide. Each bundle's RAM is checked against its budget with the game's own calculator in CI ([`packages/ingame`](../packages/ingame/README.md#ram)).
- **Rust (napi-rs)** only for profiled hot spots. **Python services** (GPU, ML, local LLM) only in Phase 4. Neither is present until needed.
- Fast CI tiers run on GitHub-hosted runners. Heavy suites run locally on the reference rig through one command. There is no self-hosted runner, because the repo is public.

### 12.2 Repo shape
An npm-workspaces monorepo. Packages are created when the first code that needs them lands, not up front.
```
packages/
  core/         model types, Activity/Action interfaces, route definitions, formula shims → vendor/bitburner-src
  brain/        the brain process: bridge composition, telemetry store and gap report, save backups, the local
                dashboard (served by the brain; #93), the game's supervisor (#94), lockstep driver (tests);
                from M4 the fast model, planner (campaign/BitNode/cycle), activities, actions, rules file
  ingame/       agent, reconciler, workers, reflexes, effectors (singularity|ui|sim), boot.js
  bridge/       RFA server + control channel
  sim/          engine bundle, browser parity layer, virtual clock, scenarios, chaos, worker pool (ADR 0007)
  e2/           environment E2 (tests only): the pinned game built from source, its static server, Playwright
                fixtures and game clock (§9.4)
  legacy/       retired-fork scripts (MIT, with notice; fork/ is byte-for-byte, see PROVENANCE.md) + adapters that run them as reflexes; also the simulator baseline
spikes/         throwaway experiments; findings in docs/spikes/
tools/          repository tooling run by Node, under the same gates (upstream-watch: the upstream stable and dev watchers; typecheck: every config, each in its environment)
vendor/         bitburner-src submodule (pinned, read-only)
```
- **Dependency direction:** `core` ← `brain`, `ingame`, `sim`, `bridge`; `bridge` ← `brain`; `sim` ← `brain` for the lockstep driver only (type imports and tests: the live brain never loads the simulator); `ingame` ← `brain` for tests only (its build, to run the Agent against the control channel); `sim`, `brain`, `core` ← `e2` for tests only (the saves E2 loads come from the simulator; its skeleton tests run a real brain process and read the snapshot types). The dashboard, inside `brain`, reads the store and writes only the supervision switch. `bridge` never depends on `sim`, so the live transport stays free of the simulator. `ingame` never imports from `brain`, because in-game bundles have to stay tiny (C2/C3).
- **Type environments differ per package:** Node-side packages get Node types. `ingame` gets the browser `lib` plus the pinned NS definitions, read straight from the submodule as `@nsdefs` (no generated types package; the live drift check is the bridge's, §12.4), and no Node types. `core` gets neither, since both sides import it. `e2` gets Node and the DOM: the functions it passes to Playwright's `page.evaluate` run in the page. Each package has its own config, and tests (which run in Node) have their own where the package's environment differs ([CONTRIBUTING](../CONTRIBUTING.md#typescript-configs)).
- **Real saves stay local:** Steam save copies used as fixtures live in a gitignored folder. The public repo only carries fixtures generated by the simulator.

### 12.3 Migration from the fork (strangler pattern)
The fork is retired and does **not** play the campaign; the agent plays from BN1.1. The fork's proven parts live on in three ways:
1. **Baseline:** the fork (autopilot + daemon) runs in the simulator as the benchmark the planner must beat (M4 exit), compared at fixed checkpoints (4, 8 and 12 virtual hours), since a full-length run costs hours per seed ([ADR 0011](decisions/0011-checkpointed-simulator-comparisons.md)). The fork needs a human without SF4, so the fair comparison starts both from the **same BN1 state with SF1.1 and SF4.3** ([owner decisions log](decisions/owner-decisions.md) #28): the least a player can hold along with SF4.3, since earning SF4 means destroying BN1 first. The game makes it BN1.2, and SF1 starts home at 32 GB, so the fork runs unattended from the start, as a player starts it (`autopilot.js --disable-casino`). Every state is one a player can reach ([baselines](sim/baselines.md)). For BN1.1 itself (no SF4) the agent is held to absolute targets instead: time-to-destroy and pass rate.
2. **Legacy reflexes:** fork managers (batcher, stocks, gang, Bladeburner) run under the agent through `legacy/` adapters, while the brain owns strategy.
3. **Replacement:** legacy reflexes are replaced one by one, each only when the simulator shows the replacement is at least as good.

### 12.4 Version management
The game source is a git submodule (`vendor/bitburner-src`) pinned to upstream `stable`'s commit for the release Steam ships (3.0.1 = `1da7316ff`). Steam's build reports the release tag's commit, `3162fd2`, which has the same source. We can't control when Steam updates, so the strategy is **never broken, at worst degraded**:
1. **See it coming:** a CI workflow, run on demand and at every release (ADR 0009), watches upstream `stable`. When it has moved ahead of the pinned commit, the workflow keeps one issue with a compatibility report (API, RAM cost and watched-source diffs, and the in-game code typechecked against `stable`'s definitions) and the bump steps. The bump itself is a normal PR (ADR 0010, [`tools/upstream-watch`](../tools/upstream-watch/README.md)). Steam ships from `stable`, so we normally know about a break, and have a fix, before Steam updates.
2. **Hold at runtime** (#91). Two checks:
   - on every RFA connection, the deployer compares `getDefinitionFile` with the pinned `NetscriptDefinitions.d.ts`, line endings aside;
   - on every `hello`, the control channel compares the Agent's `versionNumber` and `version` with `PINNED_GAME`. The commit isn't compared (owner decision 31, #128): upstream's v3.0.1 tag is a different commit from `stable`'s, with the same source, and Steam's build reports the tag's. The dashboard still shows it.

   On a mismatch the brain goes to **hold** for the rest of its run:
   - it deploys nothing more (a deploy under way stops before it changes anything shared);
   - it never tells an Agent to restart;
   - it records a `versionDrift` event for the dashboard's alert (#93).

   An Agent already running keeps reporting. In M3, hold also stops intents; reflexes keep running. The RFA can't tell the game's version, so a game with unchanged definitions but another version can be deployed to before its first `hello` ([the protocol](bridge/protocol.md#deploying)).
3. **Save backups:** the brain takes rotating save backups over the RFA (§6), so a bad patch or bug can always be rolled back.
4. **Look further ahead:** a cheap, advisory check against upstream `dev`, run on demand and at every release (ADR 0009), covers API diff, contract typecheck (the in-game code against `dev`'s definitions, #42), RAM cost diff and a commit log for a [watchlist](../tools/upstream-watch/watchlist.txt) of game source. It reports into one tracking issue and never blocks merges (ADR 0005, [`tools/upstream-watch`](../tools/upstream-watch/README.md)).

Steam itself is not pinned: game updates are taken as Steam ships them.

Upgrading the pinned version is a normal PR: regenerate types, run the full suite, re-run smoke checks.

---

## 13. Milestones
Each milestone is a [GitHub milestone](https://github.com/UnderMyBed/bitburner-agent/milestones), with epics and task issues carrying the detailed specs (ADR 0008). This table is canonical for deliverables and exit criteria; the issues hold the detailed specs.

| M | Deliverable | Exit criterion |
|---|---|---|
| M0 | Legacy fork retired (upstream merged, archived); repo bootstrapped; design reviewed | ✅ Done |
| S1 | **Simulator spike** (time-boxed, throwaway code under `spikes/`). The whole plan depends on iterating in simulation, so this went first. | ✅ Passed ([report](spikes/s1-headless-engine.md), ADR 0007): headless outside Jest, deterministic, step-invariant, exact save round trip, real Steam saves load and play, 50–37,000× depending on workload |
| M1 | Toolchain and CI first (workspace, test runner, upstream `stable`/`dev` watchers; then branch protection). Then the simulator core, rebuilt test-first from S1 (its work list): engine, browser parity layer, virtual clock, seeded RNG, worker pool, scenario fixtures. Runs the legacy fork from BN1 with SF1.1 and SF4.3 to fixed checkpoints, which is the baseline (§12.3, [ADR 0011](decisions/0011-checkpointed-simulator-comparisons.md)). Built first so every later milestone is tested against it. | Deterministic replay of a seed; each browser parity item tested; ≥1000× on a lean hacking workload; fork baseline recorded at its checkpoints (4, 8 and 12 virtual hours, seeds 1–8) |
| M2 | Walking skeleton: bridge, Agent, snapshot, telemetry, dashboard (observe-only), liveness and recovery (§10.2); in-game contract typecheck (against the pinned definitions) and RAM-budget checks in CI (with the first in-game package); E2 source build plus Playwright harness | Skeleton passes in the simulator and on E2 (connect, snapshot, reload, reconnect, Agent RAM in an 8 GB fresh start); then live snapshots on Steam without gaps (no set length: owner decision 33 dropped the 24 h soak) |
| M3 | Effectors (`ui`, `singularity` and `sim` backends, §5.6) plus bootstrap/restart paths, plus the reconciler, desired state and safe mode (§5.3, §5.4), which M2's observe-only Agent doesn't need. **Critical path for BN1.1.** | Every BN1 effector and the UI-driven install-and-restart cycle pass E2 tests on the source build and simulator chaos tests; reconciler convergence and idempotency pass property tests, and safe mode holds the last desired state with the brain down (simulator chaos test); real-game smoke test |
| M4 | Fast model + planner v0 (all three levels, candidate-policy rollouts). Activities: `hwgw`, `factionWork`, `companyWork`, `crime`, `classes`. Actions: `buyAug`, `installAugs`, `destroyBitNode`, `joinFaction`, `travel`, `buyTor`, `buyProgram`, `upgradeHome`, `buyServer`, `backdoor`. WorldDaemon route. | Fast-model fidelity within tolerance on BN1 scenarios; **at least as far along as the legacy fork at each baseline checkpoint**, over the baseline's seeds (what that means is Q10, §15); an autonomous BN1→destroy in the simulator, measured at least once as a full-length run ([ADR 0011](decisions/0011-checkpointed-simulator-comparisons.md)); then **the campaign starts: BN1.1 on Steam from a fresh save** |
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
| Brain process down for long stretches | Suboptimal play; with the brain down there are no alerts, only "Brain unreachable" on the dashboard | Safe mode (M3); the runner restarts it after a crash (D1); after a reboot the owner starts it again (owner decision 30) |
| Game process dead, frozen or bloated (24/7 run) | Lost wall-clock time | Liveness detection and recovery (R9, §10.2); heap monitoring and no code generation (R10); save backups |
| Steam auto-update mid-campaign | Breakage | Upstream-`stable` watcher issues, runtime hold, save backups (§12.4) |
| UI-backend fragility (DOM/React changes) | Stalls in BN1 (and any BitNode before SF4) | Critical-path E2 tests on the source build; Singularity replaces most UI use after SF4; smoke tests |
| 8 GB early RAM | Agent can't run alongside the batcher | Strict budgets; workers; when RAM-starved, the Agent skips the tiers it can't run and keeps the heartbeat (§5.2). Measured (Q1): 2.7 GB steady (2.85 GB since #145), 7.15 GB at a snapshot worker's peak (the medium tier's, 4.45 GB since #136; 7.3 GB since #145), and 7.35 GB with the hack loop's deploy worker (#134; 7.5 GB since #145), so a full reservation leaves under 1 GB of 8; sized in M3 planning |

---

## 15. Open questions
Each open question is tracked as a `type:question` issue; the answer is written back here when it closes.

- **Q1** ~~In-game Agent budget: is 3 GB realistic with WebSocket, workers and port I/O?~~ Answered in M2 ([#34](https://github.com/UnderMyBed/bitburner-agent/issues/34)): yes.
  - **Measured:** the Agent is 2.7 GB, its snapshot workers 2.0–4.3 GB (one at a time), and `boot.js` 2.7 GB. These are the game's own figures, in the simulator (#89) and with `mem` on E2 in a real 8 GB fresh start (#97), and the two agree.
  - **Runtime equals static:** at each fast snapshot on E2, home held the Agent and the fast worker, 4.7 GB in use: exactly 2.7 + 2.0 (4.85 since #145, with the Agent at 2.85).
  - **The peak is derived:** the Agent plus its largest worker (the medium tier's) is 7.0 GB of 8, for the moment that worker runs. At a handover, `boot.js` runs beside the Agent too (5.4 GB, and more if a worker is still running); a worker that can't start then is a degraded tier, not an error.
  - **What it means for §5.1:** the reservation, "sized from measured worker peaks", is then 7.0 GB of a fresh save's 8, leaving reflexes (an early-BN1 batcher) about 1 GB until home grows. Whether to keep that, or reserve less (say, the Agent and the fast worker) and let the slower tiers degrade while RAM is short, is a design call for M3 planning.
  - **Deferred by M3's first slice** (owner decision 34): the hack loop runs on the game's servers, never home, and a fresh save's no-port servers have about 100 GB between them, so home is left to the Agent for now. Since then, the hack loop's deploy worker is the largest home worker a fresh save runs: 4.65 GB, or 7.5 GB with the Agent (2.85 GB since #145).
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
- **Q10** ([#83](https://github.com/UnderMyBed/bitburner-agent/issues/83)) The M4 comparison: at a baseline checkpoint, what does "at least as far along as the fork" mean, when money, hacking level, augmentations and home RAM can disagree? Settled while planning M4 (ADR 0011).
