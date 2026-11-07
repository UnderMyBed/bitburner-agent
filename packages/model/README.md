# @bitburner-agent/model

The fast model ([#13](https://github.com/UnderMyBed/bitburner-agent/issues/13), [architecture §4.3](../../docs/architecture.md#43-fast-model)): a pure, deterministic model of the game for the planner ([#14](https://github.com/UnderMyBed/bitburner-agent/issues/14)) to roll candidate policies forward on, far faster than the real-engine simulator (2–3× real time once the batcher fills the cloud servers, [#247](https://github.com/UnderMyBed/bitburner-agent/issues/247)). Pure like core (no Node, no DOM), and depending on core only: `core` ← `model` ← the planner; the brain's tests import it, to check it against the brain.

> **Status:** slice 1 ([#260](https://github.com/UnderMyBed/bitburner-agent/issues/260)) and slice 2's part 1 ([#263](https://github.com/UnderMyBed/bitburner-agent/issues/263)): BN1's cycles of reputation, favour and augmentations; the money in hand by the brain's own purchases; the share from the cycle's RAM; A6's countdown, holds and lookahead. **#263's gate isn't met, so it isn't fit for #247** ([below](#263s-gate-not-met)); the rest of slice 2 is its validation on BN1.3's data, held out for it ([#263's decision](https://github.com/UnderMyBed/bitburner-agent/issues/263#issuecomment-6682093248)). That data is now recorded: 1.0.0's exit run played BN1.3 from its start to its destroy ([#276](https://github.com/UnderMyBed/bitburner-agent/issues/276)). The validation on it is still to do (#263). Not wired into the brain's choices ([owner decision 46](../../docs/decisions/owner-decisions.md)).

## Why a package of its own

Core is the game's facts and formulas, imported by the in-game code too; the model adds what isn't the game's: curves measured from a run. The brain is a process with a store; the model is a library the planner and the studies call. So it lives between them, and every choice of the brain's it makes is core's, moved there from the brain in #260 (A5's work, A6's reach and decision, the city group, home RAM's price): what it runs is what the brain runs. The A6 glue it still copies is tested against the brain on the same inputs ("brain against the fast model"):

- in `packages/brain/test/augmentations.test.ts`, the countdown's start, extensions, end and call-off; the countdown's and the lookahead's reserves; #243's hold, its window and `assumeMoney` after a restart; and the constants it copies;
- in `packages/brain/test/desired-state.test.ts`, the purchase chosen (a program, home RAM or a cloud server) from the same purse, money and income, over an empty cloud, a program or home's RAM first, the next one held back, money short and a payback not met; and what the countdown, Daedalus's $100b and The Red Pill's donation hold back from it.

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
// The structural variants (#263): A6 seeing the gross, the share by install index.
runModel({ currentNode: 1, ownedSF: { "1": 1 } }, { money: "gross", share: "index" });
```

`runModel(start, { policy, calibration, measured, money, share, horizonMs, stepMs, onStep, onWork })` steps a BitNode a minute at a time from its start to its destroy, about 0.3 s a run locally. Each step:

- **The level and the gross income** come from the fitted curve (`Curves`, below) at the multipliers installed (core's `installGains`, NeuroFlux Governor's levels each, and SF1's bonus), or from a measured cycle (`measured`, `measuredAt`).
- **The money in hand** (`money.ts`, #263): the gross less what the brain spends through the cycle, one purchase after another by its own rules (`nextPurchase`; `desired-state.ts` `#choosePurchase`, `cloud-servers.ts`):
  - a program or home's RAM, the cheaper of those the money covers: a program not in the countdown nor into The Red Pill's donation's money; home's RAM not into any money A6 holds;
  - else a cloud server, from 10 min online: the largest power of two the money covers, less what A6 holds from cloud servers and the next program or home's RAM if the income brings it within a minute, paid back within 15 min at the income a GB of the hack loop's hosts, the world servers its ports root (`ROOTED_WORLD_RAM_GB_BY_PORTS`) and the cloud servers.

  Programs and cloud servers are lost at an install; home's RAM is kept, and the commit buys more with the money above the set's, the donations' and the levels' (`homeRamAtCommit`). With `money: "gross"`, A6 and the joins see the gross instead (#260's money); the purse still spends through the cycle, and the commit's home RAM is from the cash left, so nothing is counted twice.
- **The joins:** a hacker faction once the level reaches its server's (`HACKER_FACTION_JOINS`) and its port openers are bought; Tian Di Hui at hacking 50 and $1m; the city group by core's `cityGroupValues` and `chooseCityGroup` (owner decision 54) once the money covers its invitations; Daedalus with its count, hacking 2500 and $100b.
- **A5's work:** core's `factionWorkChoice`, at core's `factionReputationPerSecond` with the level, `faction_rep`, the favour and the share bonus, focused (owner decision 37). The share bonus is the game's formula on a fitted share of the cycle's RAM (`shareBonusOfState`: `shareRamShare` of home's and the cloud servers' RAM in share threads), or with `share: "index"` run #3's own by install index (#260's). Every other joined faction gains passive reputation (core's `passiveFactionReputationPerSecond`), special factions aside.
- **A6:** core's `augmentationShops`, `augmentationEndgame` (A8's The Red Pill, "Daedalus donations" and the holds) and `installJudgement` on the set the money covers (`installDecision`), with the lookahead's reserve at the income over the brain's 10-minute window; #243's hold (`countHoldOf`, the money taken as coming while its window is open and there's no income, as the brain's `assumeMoney`); the countdown (`installClock`: 90 s, 30 s for a quick install, extended as the count rises, called off when the rule stops); what the purchases leave alone after it (`holdsOf`). A step is a minute, so the install comes at the first step at or past the countdown's end.
- **An install** banks each faction's favour (`favorAfterInstall`), installs the set and the levels, and starts the next cycle with nothing joined.
- **The destroy:** The Red Pill installed and the level at w0r1d_d43m0n's 3000.

What it leaves out: the time the brain's purchases, the commit and the backdoors take (it buys every purchase the money covers within the step, where the brain makes one an intent, a medium snapshot apart; it installs at the countdown's end, where the brain then commits one intent an update: the donations, each augmentation, home's RAM, then NeuroFlux Governor a level at a time as money and reputation come, `augmentations.ts` `#neuroFlux`); combat, charisma and companies; the gang, Bladeburners and every BitNode's curves but BN1's.

**Extrapolation, flagged and bounded (#263):** past its last reading (120 min) each curve runs on at its last slope, and a measured cycle past its end likewise. Each cycle says how many minutes it ran past (`extrapolatedMinutes`, the clock furthest on); one more than `EXTRAPOLATION_BOUND_MIN` (60) past is out of range, and the run lists it (`outOfRange`), the cycle under way at the horizon included.

### Policies

A `CyclePolicy` is what the planner varies (architecture §4.5.3): `daedalusCountHold` (#243), `favourGrind(view)` (a joined faction to work for toward the favour that unlocks its donations, in place of A5's choice; one not joined, or with that reputation earned, leaves A5's), and `install(view, brainsReason)` (whether to install now; never asked about The Red Pill or an endgame hold, never installs nothing). `TODAYS_POLICY` is the brain on main; `RUN_3_POLICY` is run #3's brain (main 7c741cc), before #243's hold.

## The calibration

`src/calibration.ts`; a sweep overrides any of it through `calibration`. The level and the gross income are **inputs measured from run #3** and fitted, so they validate nothing: what the checks test is the rules that run on them.

| | What | From |
|---|---|---|
| `RUN_3_CYCLES` | Run #3's BN1.2 cycles: the hacking level and the game's hacking income since the install (`moneySources.hacking`) at 5, 10, 15, 20, 30, 45, 60, 75, 90, 105 and 120 min and at each cycle's end. Measured. | [#260's comment](https://github.com/UnderMyBed/bitburner-agent/issues/260#issuecomment-6680681582), the coordinator's read-only extract |
| `referenceCycles` | Cycles 3 to 6, each divided by the multipliers the model runs it at (a test checks they're the model's own), through the game's skill formula (`hackingExpForLevel`): one curve at multiplier 1, their median a minute, read to 120 min. Assumed multipliers: what run #3 installed a cycle isn't known. Fitted. | `RUN_3_CYCLES` |
| `expPaceExponent` 0.625, `moneyPaceExponent` 0.5 | Two clocks run the curve faster at a higher level and hacking speed (each operation's time is ∝ 1/((level + 50) × hacking_speed), `Hacking.ts:60-80`), to these powers. Fitted; `expPaceExponent` refitted by #263 (0.5625 before). | Run #3's level and gross income, cycles 1 to 6: mean error 12% on the level, ×1.8 on the money |
| `firstCycleSpeed` 0.8, `fullSpeedHomeRamGb` 512 | The pace of a cycle with home's RAM at 8 GB, against 512 GB or more, log-linear between. Fitted, on BN1.2's cycles, whose home starts at 32 GB; `fullSpeedHomeRamGb` refitted by #263 (256 before), once home's RAM came from the cash. | The same fit |
| `shareRamShare` 0.01 | The share of home's and the cloud servers' RAM in share threads while working (`shareBonusOfState`): the game's formula on this constant. The real share is what the batches leave, which rises late in a cycle, so a constant reads low in cycles 5 and 6. Fitted on run #3's share a cycle, cycles 1 to 6: 6% mean error (3% without the 4th). | `RUN_3_SHARE_BONUS` |
| `shareBonusByCycle` | Run #3's own share bonus a cycle (`RUN_3_SHARE_BONUS`, 1.07 to 1.55), by install index: the `share: "index"` variant only. | The coordinator's per-cycle table |
| `ROOTED_WORLD_RAM_GB_BY_PORTS` | The world servers' RAM the hack loop roots with each number of ports (100 GB with none, 3,169 GB with five): the cloud payback's hosts beside the cloud servers. The game's (a range's mean); a test recomputes it. | `Server/data/servers.ts`; NUKE checks the ports alone, `NetscriptFunctions.ts:541-544` |
| `HACKER_FACTION_JOINS` | Each hacker faction's server's level, the top of the game's range, checked against `servers.ts`. The game's. | `Server/data/servers.ts:1430-1517` |

## The validation

`test/validation.test.ts`, from figures the issues state (`test/fixtures.ts`; run #3's cash from [#263's comment](https://github.com/UnderMyBed/bitburner-agent/issues/263#issuecomment-6681259933)), never a store. Each check is labelled; the tolerance is in brackets; the downstream checks are on run #3's measured curves unless "fitted" is said.

| Check | Label | Model (target) | |
|---|---|---|---|
| Simulator BN1.1: 1st install | independent | 46 min (57) [15%] | ✗ −19% |
| Simulator BN1.1: 2nd install | independent | 105 min (122) [15%] | ✓ −14% |
| Simulator BN1.1: hacking at the installs | independent | 313, 464 (290, 497) [15%] | ✓ +8%, −7% |
| BitRunners' donations unlocked | downstream; fitted | 7th install, favour after the 6th 139 and 143 (6th, 150.38) | ✗ |
| #244's phase 1 (count 0 → 17) | downstream; fitted | 249, 268 min (267) [15%] | ✓ −7%, 0% |
| #244's phase 2 (BitRunners 5 → 150) | downstream; fitted | 234, 252 min (248) [15%] | ✓ −6%, +2% |
| #244's phases 3, 4, 5 | downstream; fitted | 158/17/5, 198/7/4 min (59/82/21) [15%] | ✗ |
| The faction worked most, cycles 1–6 | downstream | as run #3 in 5 of 6 | ✗ in the 3rd (CyberSec; run #3, NiteSec) |
| The count after installs 1, 2, 5, 6 [one] | downstream | 3, 4, 20, 25 (3, 5, 21, 25) | ✓ |
| The count after installs 3, 4 [one] | downstream | 8, 13 (10, 17) | ✗ |
| The favour after installs 1, 4, 5, 6 [20% or 2] | downstream | 4.6, 63.4, 85.3, 139.0 (5.04, 71.88, 96.01, 150.38) | ✓ |
| The favour after installs 2, 3 [20% or 2] | downstream | 17.3, 20.2 (22.54, 37.65) | ✗ |
| Reputation, cycles 1–6 [25%] | downstream | −7%, −31%, −56%, +2%, −26%, −20% | ✗ in 2, 3, 5 |
| Its rate, cycles 1 and 4 [16%] | downstream | −7%, −1% | ✓ |
| Its rate, cycles 5 and 6 [16%] | downstream | −17%, −17% | ✗ |
| Each cycle's length [25%] | downstream | −6%, −19%, +4%, −9%, −3%, −8% | ✓ |
| The cash, cycles 5–6, 30–60 min [10%] | downstream | within 9% (the gross within 7% too: it can't tell them apart) | ✓ |
| The cash, cycles 1–3 at 30 min, where spending is most of the income | downstream | under 2% of run #3's in cycles 1 and 2, within 10% in the 3rd; the gross ×2.6 to ×10 | ✗ in 1, 2 |
| The share a cycle [10%] | fitted | 1.11 to 1.43 (1.07 to 1.55); the 4th 1.42 (1.16) | ✗ in the 4th |
| The level at each cycle's end, cycles 1–6 [15%] | fitted | within 11% | ✓ |

## #263's gate: not met

The gate was run #3's donations at the 6th install, every phase of #244's table within 15%, and the simulator's BN1.1 within 15%. None is met in full, and nothing was tuned to pass. What's off, and why:

1. **Not the money alone.** The cheap check first: the measured money scaled by ×0.5 to ×0.01 leaves BitRunners' favour after the 6th install at 139–143. The installs' bar is mostly NeuroFlux Governor's levels, which reputation gates more than money: by the 2nd cycle's end its levels cost $13b against $4t in hand. But the cash is low where the spending is most of the income: at 30 min into cycles 1 and 2 the model's is under 2% of run #3's, as it buys every purchase the money covers within the minute. With A6 seeing the gross (the `money: "gross"` variant), the 6th install's favour comes to 148 on run #3's measured curves and 151 on the fitted one.
2. **The reputation, a knife's edge.** Run #3's 6th install came at BitRunners' favour 150.38, 0.38 over; its 2nd cycle's CyberSec reputation passed Gen I's 10,000 and its 4th NiteSec's 50,000 for Gen III, both by a few percent. A 1% shift flips each, and each flip cascades: the model's 2nd install comes at 46 min (56.6) with CyberSec at 7,774, its 3rd cycle works CyberSec for Gen I, its 4th installs 13 to run #3's 17, its 5th works NiteSec for Gen III where run #3 worked BitRunners (−26% there), its 6th ends at favour 139. The step or the share's fraction moves the 6th's favour between 139 and 151. The countdown's extensions are modelled (`installClock`); the commit's duration isn't: the brain buys one intent an update (the donations, each augmentation, home's RAM, then NeuroFlux Governor's levels as money and reputation accrue), so its install comes later, with more levels (39.5 min and 13 levels in run #3's 1st cycle, against the model's 37 and 10). BN1.3's countdown and commit timings will tell this from the purchase cadence (1).
3. **The share's shape.** A constant share of the RAM levels off at a cycle average of 1.42–1.43 once the cloud servers are bought, where run #3's rose to 1.49 and 1.55 in cycles 5 and 6 (−4% to −8% on the rate there): the batches leave more late in a cycle. Run #3's 4th cycle's 1.16 isn't in the RAM at all (its brain, before #242, shared no home RAM, and its batches held 82% of the cloud servers).
4. **The money curve at high multipliers (phases 3–5).** Fitted on cycles 3–6 (hacking_money 1.5–2.5), it gives $1e13 by 15 min into a 7th cycle (×5–6), against run #3's $1e10–1.6e10: the early minutes are bound by the RAM bought afresh each cycle, not the multipliers. Donations then come at once, and the model quick-installs every 11–18 min. On the measured curves, run #3's 7th–10th cycles run far past their ends, as the model's are other cycles.
5. **The hacking ramp at 8 GB (the simulator).** The model reaches the simulator's 290 by 45 min, not 55: `firstCycleSpeed` was fitted on BN1.2, whose home starts at 32 GB.

**Next:** validation on BN1.3's data, held out for it ([#263's decision](https://github.com/UnderMyBed/bitburner-agent/issues/263#issuecomment-6682093248)), with the purchases' and the commit's times. The data is recorded (1.0.0's exit run, [#276](https://github.com/UnderMyBed/bitburner-agent/issues/276)); the validation isn't done yet. The paired comparison for #247 (#263's work item 6) waits on it: on a model whose outcome turns on a few percent of reputation at each install, a policy's win would be the knife's edge, not the policy.

`test/model.test.ts`: the calibration's consistency (the fit a local best at the refit's own steps), the clocks, home's RAM, SF1's bonus, the favour banked by the game's formula, passive reputation, the joins' rules, A6's "nothing left", The Red Pill's hold, #243's hold, determinism, partial calibration, and the policies. `test/cash-and-state.test.ts`: the purchases through a cycle (the payback over the world and cloud servers, the holds), the income window, each install's fresh purse, the commit's home RAM, the countdown, the holds and the lookahead, the share from the state, the variants, and the extrapolation's flag and bound.
