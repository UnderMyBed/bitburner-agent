# @bitburner-agent/model

The fast model ([#13](https://github.com/UnderMyBed/bitburner-agent/issues/13), [architecture §4.3](../../docs/architecture.md#43-fast-model)): a pure, deterministic model of the game for the planner ([#14](https://github.com/UnderMyBed/bitburner-agent/issues/14)) to roll candidate policies forward on, far faster than the real-engine simulator (2–3× real time once the batcher fills the cloud servers, [#247](https://github.com/UnderMyBed/bitburner-agent/issues/247)). Pure like core (no Node, no DOM), and depending on core only: `core` ← `model` ← the planner.

> **Status:** slices 1 and 2 ([#260](https://github.com/UnderMyBed/bitburner-agent/issues/260), [#263](https://github.com/UnderMyBed/bitburner-agent/issues/263)): BN1's cycles of reputation, favour and augmentations, the money in hand by the brain's own purchases, the share from the cycle's RAM, and A6's countdown and holds checked against the brain's. **#263's gate isn't met, so it isn't fit for #247** ([below](#263s-gate-not-met)). Not wired into the brain's choices ([owner decision 46](../../docs/decisions/owner-decisions.md)).

## Why a package of its own

Core is the game's facts and formulas, imported by the in-game code too; the model adds what isn't the game's: curves measured from a run. The brain is a process with a store; the model is a library the planner and the studies call. So it lives between them, and every choice of the brain's it makes is core's, moved there from the brain in #260 (A5's work, A6's reach and decision, the city group, home RAM's price): what it runs is what the brain runs. The A6 glue it still copies (the countdown, the holds, the lookahead, the purchases through a cycle) is checked against the brain on the same inputs (`packages/brain/test/augmentations.test.ts`, "brain against the fast model").

## The cycle model

```ts
import { runModel, RUN_3_CYCLES, RUN_3_POLICY, TODAYS_POLICY } from "@bitburner-agent/model";

const run = runModel({ currentNode: 1, ownedSF: { "1": 1 } }, { policy: TODAYS_POLICY });
run.cycles;        // each install: when, why, what, Daedalus's count, hacking, money, reputation, favour, share
run.events;        // joins, installs, donations unlocked, the destroy
run.destroyedAtMs; // or null within the horizon (24 h)
run.outOfRange;    // the cycles extrapolated past the curves' bound: a run with any isn't to be trusted
// On run #3's own measured curves rather than the fitted one:
runModel({ currentNode: 1, ownedSF: { "1": 1 } }, { policy: RUN_3_POLICY, measured: RUN_3_CYCLES });
// The structural variants (#263), slice 1's: the money gross, the share by install index.
runModel({ currentNode: 1, ownedSF: { "1": 1 } }, { money: "gross", share: "index" });
```

`runModel(start, { policy, calibration, measured, money, share, horizonMs, stepMs, onStep, onWork })` steps a BitNode a minute at a time from its start to its destroy, about 0.3 s a run locally. Each step:

- **The level and the gross income** come from the fitted curve (`Curves`, below) at the multipliers installed (core's `installGains`, NeuroFlux Governor's levels each, and SF1's bonus), or from a measured cycle (`measured`, `measuredAt`).
- **The money in hand** (`money.ts`, #263): the gross less what the brain spends through the cycle, by its own rules (`desired-state.ts` `#choosePurchase`, `cloud-servers.ts`): a program or home's RAM, the cheaper first, as the money covers it (no program in the countdown, home's RAM only above what A6 holds); else a cloud server, from 10 min online, the largest power of two the money covers less what's held from cloud servers (the lookahead's, the next program or home's RAM if the income brings it within a minute), paid back within 15 min. Programs and cloud servers are lost at an install; home's RAM is kept, and the commit buys more with the money above the set's and the levels' (`homeRamAtCommit`). With `money: "gross"`, A6 and the joins see the gross instead (#260's).
- **The joins:** a hacker faction once the level reaches its server's (`HACKER_FACTION_JOINS`) and its port openers are bought; Tian Di Hui at hacking 50 and $1m; the city group by core's `cityGroupValues` and `chooseCityGroup` (owner decision 54) once the money covers its invitations; Daedalus with its count, hacking 2500 and $100b.
- **A5's work:** core's `factionWorkChoice`, at core's `factionReputationPerSecond` with the level, `faction_rep`, the favour and the share bonus, focused (owner decision 37). The share bonus is the game's for the cycle's RAM (`shareBonusOfState`: `shareRamShare` of home's and the cloud servers' RAM in share threads), or with `share: "index"` run #3's own by install index (#260's). Every other joined faction gains passive reputation (core's `passiveFactionReputationPerSecond`), special factions aside.
- **A6:** core's `augmentationShops`, `augmentationEndgame` (A8's The Red Pill, "Daedalus donations" and the holds) and `installJudgement` on the set the money covers (`installDecision`), with the lookahead's reserve at the income over the brain's 10-minute window; #243's hold (`countHoldOf`, the money taken as coming while its window is open and there's no income, as the brain's `assumeMoney`); the countdown (`installClock`: 90 s, 30 s for a quick install, extended as the count rises, called off when the rule stops); what the purchases leave alone after it (`holdsOf`). A step is a minute, so the install comes at the first step at or past the countdown's end.
- **An install** banks each faction's favour (`favorAfterInstall`), installs the set and the levels, and starts the next cycle with nothing joined.
- **The destroy:** The Red Pill installed and the level at w0r1d_d43m0n's 3000.

What it leaves out: the time the brain's purchases, the commit and the backdoors take (it buys every server the money covers each minute, the brain one at a time; it installs at the countdown's end); combat, charisma and companies; the gang, Bladeburners and every BitNode's curves but BN1's.

**Extrapolation, flagged and bounded (#263):** past its last reading (120 min) each curve runs on at its last slope, and a measured cycle past its end likewise. Each cycle says how many minutes it ran past (`extrapolatedMinutes`, the clock furthest on); one more than `EXTRAPOLATION_BOUND_MIN` (60) past is out of range, and the run lists it (`outOfRange`).

### Policies

A `CyclePolicy` is what the planner varies (architecture §4.5.3): `daedalusCountHold` (#243), `favourGrind(view)` (a joined faction to work for toward the favour that unlocks its donations, in place of A5's choice; one not joined, or with that reputation earned, leaves A5's), and `install(view, brainsReason)` (whether to install now; never asked about The Red Pill or an endgame hold, never installs nothing). `TODAYS_POLICY` is the brain on main; `RUN_3_POLICY` is run #3's brain (main 7c741cc), before #243's hold.

## The calibration

`src/calibration.ts`; a sweep overrides any of it through `calibration`. The level and the gross income are **inputs measured from run #3** and fitted, so they validate nothing: what the checks test is the rules that run on them.

| | What | From |
|---|---|---|
| `RUN_3_CYCLES` | Run #3's BN1.2 cycles: the hacking level and the game's hacking income since the install (`moneySources.hacking`) at 5, 10, 15, 20, 30, 45, 60, 75, 90, 105 and 120 min and at each cycle's end. Measured. | [#260's comment](https://github.com/UnderMyBed/bitburner-agent/issues/260#issuecomment-6680681582), the coordinator's read-only extract |
| `referenceCycles` | Cycles 3 to 6, each divided by the multipliers the model runs it at (a test checks they're the model's own), through the game's skill formula (`hackingExpForLevel`): one curve at multiplier 1, their median a minute, read to 120 min. Assumed multipliers: what run #3 installed a cycle isn't known yet. Fitted. | `RUN_3_CYCLES` |
| `expPaceExponent` 0.625, `moneyPaceExponent` 0.5 | Two clocks run the curve faster at a higher level and hacking speed (each operation's time is ∝ 1/((level + 50) × hacking_speed), `Hacking.ts:60-80`), to these powers. Fitted (#263 refitted them once home's RAM came from the cash). | Run #3's level and gross income, cycles 1 to 6: mean error 12% on the level, ×1.8 on the money |
| `firstCycleSpeed` 0.8, `fullSpeedHomeRamGb` 512 | The pace of a cycle with home's RAM at 8 GB, against 512 GB or more, log-linear between. Fitted, on BN1.2's cycles, whose home starts at 32 GB. | The same fit |
| `shareRamShare` 0.01 | The share of home's and the cloud servers' RAM in share threads while working (`shareBonusOfState`). Fitted on run #3's share a cycle, cycles 1 to 6: 6% mean error (3% without the 4th, below). | `RUN_3_SHARE_BONUS` |
| `shareBonusByCycle` | Run #3's own share bonus a cycle (`RUN_3_SHARE_BONUS`, 1.07 to 1.55), by install index: the `share: "index"` variant only. | The coordinator's per-cycle table |
| `HACKER_FACTION_JOINS` | Each hacker faction's server's level, the top of the game's range, checked against `servers.ts`. The game's. | `Server/data/servers.ts:1430-1517` |

## The validation

`test/validation.test.ts`, from figures the issues state (`test/fixtures.ts`, run #3's cash from [#263's comment](https://github.com/UnderMyBed/bitburner-agent/issues/263)), never a store. Each check is labelled; the tolerance is in brackets.

| Check | Label | Model (target) | |
|---|---|---|---|
| Simulator BN1.1: 1st install | independent | 46 min (57) [15%] | ✗ −19% |
| Simulator BN1.1: 2nd install | independent | 105 min (122) [15%] | ✓ −14% |
| Simulator BN1.1: hacking at the installs | independent | 312, 464 (290, 497) [15%] | ✓ +8%, −7% |
| BitRunners' donations unlocked | downstream (measured), fitted | 7th install, favour 139 and 143 after the 6th (6th, 150.38) | ✗ |
| #244's phase 1 (count 0 → 17) | downstream, fitted | 249, 268 min (267) [15%] | ✓ −7%, 0% |
| #244's phase 2 (BitRunners 5 → 150) | downstream, fitted | 234, 252 min (248) [15%] | ✓ −6%, +2% |
| #244's phases 3, 4, 5 | downstream, fitted | 158/17/5, 198/7/4 min (59/82/21) [15%] | ✗ |
| The faction worked most, cycles 1–6 | downstream | 5 of 6 (the 3rd CyberSec, run #3's NiteSec) | |
| The count after installs 1, 2, 5, 6 [one] | downstream | 3, 4, 20, 25 (3, 5, 21, 25) | ✓ |
| The count after installs 3, 4 [one] | downstream | 8, 13 (10, 17) | ✗ |
| Reputation, cycles 1–6 [25%] | downstream | −6%, −31%, −56%, +2%, −26%, −20% | ✗ 2, 3, 5 |
| Each cycle's length [25%] | downstream | −6%, −19%, +4%, −9%, −3%, −8% | ✓ |
| The cash, cycles 5–6, 30–60 min [10%] | downstream | within 9% | ✓ |
| The share a cycle [10%] | fitted | 1.11 to 1.43 (1.07 to 1.55); the 4th 1.42 (1.16) | ✓ but the 4th |
| The level at each cycle's end, cycles 1–6 [15%] | fitted | within 11% | ✓ |

## #263's gate: not met

The gate was run #3's donations at the 6th install, every phase of #244's table within 15%, and the simulator's BN1.1 within 15%. None is met in full, and nothing was tuned to pass. What's off, and why:

1. **Not the money.** The cheap check first: the measured money scaled by ×0.5 to ×0.01 leaves BitRunners' favour after the 6th install at 139–143. The installs' bar is mostly NeuroFlux Governor's levels, which reputation gates more than money: by the 2nd cycle's end its levels cost $13b against $4t in hand. Money from cash is now the default (it's the brain's), but it moved little; in the 1st cycle it costs three levels (10, against run #3's 13), as the cycle ends in its steepest minutes.
2. **The reputation, a knife's edge.** Run #3's 6th install came at BitRunners' favour 150.38, 0.38 over; its 2nd cycle's CyberSec reputation passed Gen I's 10,000 and its 4th NiteSec's 50,000 for Gen III, both by a few percent. A 1% shift in reputation flips each, and each flip cascades: the model's 2nd install comes at 46 min (56.6) with CyberSec at 7,774, its 3rd cycle works CyberSec for Gen I, its 4th installs 13 to run #3's 17, its 5th works NiteSec for Gen III where run #3 worked BitRunners (−26% there), its 6th ends at favour 139. On the fitted curve the 6th ends at 143; at a 10 s step 138; a step or a share fraction moves it between 139 and 151. The likely root: the model installs at its countdown's end, where run #3's countdown, extensions and commit (15 purchases, an intent each) ran on longer as the count rose (39.5 min against the model's 37 in the 1st cycle).
3. **The share's shape.** From the RAM it saturates at 1.43 with the cloud servers (25 × 1 PB by 30 min), where run #3's rose to 1.49 and 1.55 in cycles 5 and 6 (−4% to −8% on the rate there), and its 4th cycle's 1.16 isn't in the RAM at all (run #3's brain, before #242, shared no home RAM, and its batches held 82% of the cloud servers).
4. **The money curve at high multipliers (phases 3–5).** Fitted on cycles 3–6 (hacking_money 1.5–2.5), it gives $1e13 by 15 min into a 7th cycle (×5–6), against run #3's $1e10–1.6e10: the early minutes are bound by the RAM bought afresh each cycle, not the multipliers. Donations then come at once, and the model quick-installs every 11–18 min. On the measured curves, run #3's 7th–10th cycles run far past their ends, as the model's are other cycles.
5. **The hacking ramp at 8 GB (the simulator).** The model reaches the simulator's 290 by 45 min, not 55: `firstCycleSpeed` was fitted on BN1.2, whose home starts at 32 GB.

**What would settle 2–3, from the store (read-only, for the coordinator):** run #3's per cycle, the augmentations installed by name and NeuroFlux Governor's levels; the time the countdown started, each extension and the install chosen (`augmentationProgress`, `augmentationInstallChosen`), and the reset; the faction worked minute by minute (the work intents); the share bonus at each reading (the batcher's health); and the purchases' times, to set how fast the brain spends.

The paired comparison for #247 (#263's work item 6) waits on this: run on a model whose outcome turns on a few percent of reputation at each install, a policy's win would be the knife's edge, not the policy.

`test/model.test.ts`: the calibration's consistency, the clocks, home's RAM, SF1's bonus, the favour banked by the game's formula, passive reputation, the joins' rules, A6's "nothing left", The Red Pill's hold, #243's hold, determinism, partial calibration, and the policies. `test/cash-and-state.test.ts`: the purchases through a cycle, the countdown, the holds and the lookahead, the share from the state, the structural variants, and the extrapolation's flag and bound.
