# @bitburner-agent/model

The fast model ([#13](https://github.com/UnderMyBed/bitburner-agent/issues/13), [architecture §4.3](../../docs/architecture.md#43-fast-model)): a pure, deterministic model of the game for the planner ([#14](https://github.com/UnderMyBed/bitburner-agent/issues/14)) to roll candidate policies forward on, far faster than the real-engine simulator (2–3× real time once the batcher fills the cloud servers, [#247](https://github.com/UnderMyBed/bitburner-agent/issues/247)). Pure like core (no Node, no DOM), and depending on core only: `core` ← `model` ← the planner; the brain's tests import it, to check it against the brain.

> **Status:** slices 1 and 2 ([#260](https://github.com/UnderMyBed/bitburner-agent/issues/260), [#263](https://github.com/UnderMyBed/bitburner-agent/issues/263)): BN1's cycles of reputation, favour and augmentations; the money in hand by the brain's own purchases; the share by #242's rule; A6's countdown, holds and lookahead; the paired comparison. Fitted on run #3 alone and validated, unchanged, on BN1.3, held out ([#263's decision](https://github.com/UnderMyBed/bitburner-agent/issues/263#issuecomment-6682093248), [#276](https://github.com/UnderMyBed/bitburner-agent/issues/276)). **Not fit for #247 yet** ([the verdict](#the-verdict-not-fit-for-247-yet)): on BN1.3's own curves its rules reach BN1.3's milestones, but its fitted curves unlock BitRunners' donations an install early and miss a quick install, and every Daedalus cycle runs past the curves' range. Not wired into the brain's choices ([owner decision 46](../../docs/decisions/owner-decisions.md)).

## Why a package of its own

Core is the game's facts and formulas, imported by the in-game code too; the model adds what isn't the game's: curves measured from a run. The brain is a process with a store; the model is a library the planner and the studies call. So it lives between them, and every choice of the brain's it makes is core's, moved there from the brain in #260 (A5's work, A6's reach and decision, the city group, home RAM's price): what it runs is what the brain runs. The A6 glue it still copies is tested against the brain on the same inputs ("brain against the fast model"):

- in `packages/brain/test/augmentations.test.ts`, the countdown's start, extensions, end and call-off; the countdown's and the lookahead's reserves; #243's hold, its window and `assumeMoney` after a restart; and the constants it copies;
- in `packages/brain/test/desired-state.test.ts`, the purchase chosen (a program, home RAM or a cloud server) from the same purse, money and income, over an empty cloud, a program or home's RAM first, the next one held back, money short and a payback not met; and what the countdown, Daedalus's $100b and The Red Pill's donation hold back from it.

## The cycle model

```ts
import {
  FAVOUR_FIRST_POLICY,
  pairedComparison,
  RUN_3_CYCLES,
  RUN_3_POLICY,
  runModel,
  TODAYS_POLICY,
} from "@bitburner-agent/model";

const run = runModel({ currentNode: 1, ownedSF: { "1": 1 } }, { policy: TODAYS_POLICY });
run.cycles;        // each install: when, why, what, Daedalus's count, hacking, money, reputation, favour, share
run.events;        // joins, installs, donations unlocked, the destroy
run.destroyedAtMs; // or null within the horizon (24 h)
run.outOfRange;    // the cycles extrapolated past the curves' bound: a run with any isn't to be trusted
// On run #3's own measured curves rather than the fitted one:
runModel({ currentNode: 1, ownedSF: { "1": 1 } }, { policy: RUN_3_POLICY, measured: RUN_3_CYCLES });
// The structural variants (#263): A6 seeing the gross, the share by install index.
runModel({ currentNode: 1, ownedSF: { "1": 1 } }, { money: "gross", share: "index" });
// #247's paired comparison: two policies at each setting of a grid, a difference only where every setting agrees.
pairedComparison({ currentNode: 1, ownedSF: {} }, TODAYS_POLICY, FAVOUR_FIRST_POLICY).verdict;
```

`runModel(start, { policy, calibration, measured, money, share, horizonMs, stepMs, onStep, onWork })` steps a BitNode a minute at a time from its start to its destroy, about 0.3 s a run locally. Each step:

- **The level and the gross income** come from the fitted curve (`Curves`, below; the money's clock no faster than the reference's, `moneyPaceMost`) at the multipliers installed (core's `installGains`, NeuroFlux Governor's levels each, and SF1's bonus), or from a measured cycle (`measured`, `measuredAt`).
- **The money in hand** (`money.ts`, #263): the gross less what the brain spends through the cycle, one purchase after another by its own rules (`nextPurchase`; `desired-state.ts` `#choosePurchase`, `cloud-servers.ts`):
  - a program or home's RAM, the cheaper of those the money covers: a program not in the countdown nor into The Red Pill's donation's money; home's RAM not into any money A6 holds;
  - else a cloud server, from 10 min online: the largest power of two the money covers, less what A6 holds from cloud servers and the next program or home's RAM if the income brings it within a minute, paid back within 15 min at the income a GB of the hack loop's hosts, the world servers its ports root (`ROOTED_WORLD_RAM_GB_BY_PORTS`) and the cloud servers.

  Programs and cloud servers are lost at an install; home's RAM is kept, and the commit buys more with the money above the set's, the donations' and the levels' (`homeRamAtCommit`). With `money: "gross"`, A6 and the joins see the gross instead (#260's money); the purse still spends through the cycle, and the commit's home RAM is from the cash left, so nothing is counted twice.
- **The joins:** a hacker faction once the level reaches its server's (`HACKER_FACTION_JOINS`) and its port openers are bought; Tian Di Hui at hacking 50 and $1m; the city group by core's `cityGroupValues` and `chooseCityGroup` (owner decision 54) once the money covers its invitations; Daedalus with its count, hacking 2500 and $100b.
- **A5's work:** core's `factionWorkChoice`, at core's `factionReputationPerSecond` with the level, `faction_rep`, the favour and the share bonus, focused (owner decision 37). The share bonus is the game's formula on the share threads (`shareBonusOfState`): by #242's rule for today's brain (`CyclePolicy.homeShares`, absent or true), home's RAM less the 32 GB it keeps (`SHARE_HOME_KEPT_GB`, the brain's) and the batches' hosts' RAM only past their use (`batchesUseOfHosts`, run #3's 82%, so none); for run #3's brain and the simulator probe's, before #242, a fitted share (`shareRamShare`) of home's and the cloud servers' RAM; or with `share: "index"` run #3's own by install index (#260's). Every other joined faction gains passive reputation (core's `passiveFactionReputationPerSecond`), special factions aside.
- **A6:** core's `augmentationShops`, `augmentationEndgame` (A8's The Red Pill, "Daedalus donations" and the holds) and `installJudgement` on the set the money covers (`installDecision`), with the lookahead's reserve at the income over the brain's 10-minute window; #243's hold (`countHoldOf`, the money taken as coming while its window is open and there's no income, as the brain's `assumeMoney`); the countdown (`installClock`: 90 s, 30 s for a quick install, extended as the count rises, called off when the rule stops); what the purchases leave alone after it (`holdsOf`). A step is a minute, so the install comes at the first step at or past the countdown's end.
- **An install** banks each faction's favour (`favorAfterInstall`), installs the set and the levels, and starts the next cycle with nothing joined.
- **The destroy:** The Red Pill installed and the level at w0r1d_d43m0n's 3000.

What it leaves out: the time the brain's purchases, the commit and the backdoors take (it buys every purchase the money covers within the step, where the brain makes one an intent, a medium snapshot apart; it installs at the countdown's end, where the brain then commits one intent an update: the donations, each augmentation, home's RAM, then NeuroFlux Governor a level at a time as money and reputation come, `augmentations.ts` `#neuroFlux`); combat, charisma and companies; the gang, Bladeburners and every BitNode's curves but BN1's.

**Extrapolation, flagged and bounded (#263):** past its last reading (120 min) each curve runs on at its last slope, and a measured cycle past its end likewise. Each cycle says how many minutes it ran past (`extrapolatedMinutes`, the clock furthest on); one more than `EXTRAPOLATION_BOUND_MIN` (60) past is out of range, and the run lists it (`outOfRange`), the cycle under way at the horizon included.

### Policies

A `CyclePolicy` is what the planner varies (architecture §4.5.3): `daedalusCountHold` (#243), `favourGrind(view)` (a joined faction to work for toward the favour that unlocks its donations, in place of A5's choice; one not joined, or with that reputation earned, leaves A5's), and `install(view, brainsReason)` (whether to install now; never asked about The Red Pill or an endgame hold, never installs nothing). `homeShares` is #242's share, a brain's version rather than a planner's choice (absent: today's). `TODAYS_POLICY` is the brain on main; `RUN_3_POLICY` is run #3's brain (main 7c741cc), before #243's hold and #242's share; `FAVOUR_FIRST_POLICY` is #247's "favour first" (`src/compare.ts`).

## The calibration

`src/calibration.ts`; a sweep overrides any of it through `calibration`. The level and the gross income are **inputs measured from run #3** and fitted, so they validate nothing: what the checks test is the rules that run on them.

| | What | From |
|---|---|---|
| `RUN_3_CYCLES` | Run #3's BN1.2 cycles: the hacking level and the game's hacking income since the install (`moneySources.hacking`) at 5, 10, 15, 20, 30, 45, 60, 75, 90, 105 and 120 min and at each cycle's end. Measured. | [#260's comment](https://github.com/UnderMyBed/bitburner-agent/issues/260#issuecomment-6680681582), the coordinator's read-only extract |
| `referenceCycles` | Cycles 3 to 6, each divided by the multipliers the model runs it at (a test checks they're the model's own), through the game's skill formula (`hackingExpForLevel`): one curve at multiplier 1, their median a minute, read to 120 min. Assumed multipliers: what run #3 installed a cycle isn't known. Fitted. | `RUN_3_CYCLES` |
| `expPaceExponent` 0.625, `moneyPaceExponent` 0.5625 | Two clocks run the curve faster at a higher level and hacking speed (each operation's time is ∝ 1/((level + 50) × hacking_speed), `Hacking.ts:60-80`), to these powers. Fitted; refitted with the cap below (#263's part 2; 0.5 before). | Run #3's level and gross income, cycles 1 to 6: error 0.1817 (part 1's 0.2003), a local best at the refit's steps |
| `moneyPaceMost` 1 | The money's clock never runs faster than the reference's. At high multipliers the pace ran a 7th cycle's first minutes to $1e13 by 15 min, against run #3's $1.05e10–1.34e10 in its 7th to 10th: those minutes are bound by the RAM (an install loses the cloud servers, the batches never run on home, and none is bought before 10 min and a 15-minute payback), not the level. Fitted (#263's part 2), at a step of 0.25. | Run #3 alone: cycles 1 to 6, and its 7th to 10th to 20 min |
| `firstCycleSpeed` 0.85, `fullSpeedHomeRamGb` 128 | The pace of a cycle with home's RAM at 8 GB, against 128 GB or more, log-linear between. Fitted on BN1.2's cycles, whose home starts at 32 GB, as BN1.3's does: no run measured says how slow 8 GB is (the simulator, the one at 8 GB, is the independent check). | The same fit |
| `shareRamShare` 0.01 | Run #3's brain's share (before #242): this share of home's and the cloud servers' RAM in share threads (`shareBonusOfState`), the game's formula on it. Its one cap over every host, and the gaps between rounds, aren't a rule of the RAM's. Fitted on run #3's share a cycle, cycles 1 to 6: 6% mean error (3% without the 4th). | `RUN_3_SHARE_BONUS` |
| `batchesUseOfHosts` 0.82 | #242's share (today's brain): the batches' use of their hosts, past which (core's `SHARE_MOST_USE`, 0.8) they share nothing, so home shares alone. Measured on run #3, not fitted: "its batches held 82% of the cloud servers". | #242, from run #3's store |
| `shareBonusByCycle` | Run #3's own share bonus a cycle (`RUN_3_SHARE_BONUS`, 1.07 to 1.55), by install index: the `share: "index"` variant only. | The coordinator's per-cycle table |
| `ROOTED_WORLD_RAM_GB_BY_PORTS` | The world servers' RAM the hack loop roots with each number of ports (100 GB with none, 3,169 GB with five): the cloud payback's hosts beside the cloud servers. The game's (a range's mean); a test recomputes it. | `Server/data/servers.ts`; NUKE checks the ports alone, `NetscriptFunctions.ts:541-544` |
| `HACKER_FACTION_JOINS` | Each hacker faction's server's level, the top of the game's range, checked against `servers.ts`. The game's. | `Server/data/servers.ts:1430-1517` |

## The validation

From figures the issues state (`test/fixtures.ts`), never a store. Each check is labelled; the tolerance is in brackets.

- **Fitted:** consistency only, the curves against the run they're fitted on.
- **Independent:** a prediction, nothing of the run checked fitted on it.
- **Downstream:** the rules on a run's own measured level and income a cycle. They share inputs with what they check, so they test the mechanism, not the curves.

### Held out: BN1.3 (`test/bn1-3.test.ts`)

BN1.3, the exit run (#276; today's brain with #242's share and #243's hold, SF1.2), from [the coordinator's extract on #263](https://github.com/UnderMyBed/bitburner-agent/issues/263), summarised in `BN1_3`, `BN1_3_PER_CYCLE`, `BN1_3_CYCLES` and `BN1_3_CASH`. Nothing was fitted on it, or tuned after it. Independent is the fitted model from BN1.3's start; downstream is today's rules on BN1.3's own curves.

**The stuck batcher (#274):** in BN1.3's cycles 6 to 8 the batcher sat about 5 hours on poor targets, so their income, and the level and reputation that follow, are far under a healthy batcher's. The downstream run has them in its curves. The independent run models a healthy batcher, so it leaves those cycles' money out, and the phases and the total that span them are reported as confounded, not as validation.

#244's phases are split by milestone: the count to 17; BitRunners' donations unlocked; the install before Daedalus's cycle; Daedalus's donations unlocked; the destroy. BN1.3's are 317, 232, 86, 93 and 27 min (run #3's, so split, are #244's own).

| Check | Label | Model (BN1.3) | |
|---|---|---|---|
| BitRunners' donations unlocked | independent | the 6th install, 8 h 0 min; favour 151.4 after it (the 7th, 9 h 9 min; 128.22 after the 6th) | ✗ (in part #274's) |
| BitRunners' and Daedalus's donations unlocked | downstream | the 7th and the 9th installs (the 7th, the 9th) | ✓ |
| Phase 1, the count 0 → 17 [15%] | independent; downstream | 390, 322 min (317) | ✗ +23%; ✓ +1% |
| Phase 2, BitRunners' favour to 150 [15%] | independent; downstream | 90, 216 min (232) | confounded, −61%; ✓ −7% |
| Phase 3, to Daedalus's cycle [15%] | independent; downstream | 32, 87 min (86) | confounded, −63%; ✓ +1% |
| Phase 4, Daedalus's favour [15%] | independent; downstream | 94, 92 min (93) | ✓ +1%; ✓ −1% |
| Phase 5, The Red Pill and the destroy [15%] | independent; downstream | 23, 23 min (27.1) | ✗ −15.0%, a step's minute out |
| The destroy [15%] | independent; downstream | 10 h 29 min, 12 h 20 min (12 h 35 min) | confounded, −17%; ✓ −2% |
| Cycles 1–4: each length [25%] | independent | −6%, −9%, +23%, −14% | ✓ |
| Cycles 1–4: the count after [one] | independent | 3, 4, 10, 14 (3, 5, 10, 14) | ✓ |
| Cycles 1–4: the level at the end [15%] | independent | +6%, −6%, −2%, +1% | ✓ |
| Cycles 1–4: the faction worked most | independent | as BN1.3's but the 3rd's (CyberSec; BN1.3's NiteSec) | ✗ in the 3rd |
| Cycles 1, 2, 4: its favour after [20% or 2] | independent | 5.4, 20.6, 58.2 (5.18, 23.62, 70.71) | ✓ |
| The 5th cycle | independent; downstream | 101, 104 min to the count rule (18.5, a quick install) | ✗ |
| The count after each install [one] | downstream | as BN1.3's at installs 1, 2, 4 and 6–9; 8 (10) at the 3rd, 21 (18) at the 5th | ✗ in the 3rd, 5th |
| The faction worked most | downstream | as BN1.3's in cycles 1, 2 and 6–9 | ✗ in the 3rd–5th |
| The share a cycle, #242's rule, cycles 1–5 [5%] | independent | 1.154, 1.333, 1.444, 1.508, 1.527 (1.118, 1.357, 1.459, 1.513, 1.527) | ✓ +3% to −2% |
| The share, the 6th cycle | independent | 1.527 (1.61) | confounded: stuck, the batches left the cloud to the share |
| The money at high multipliers: 15 min into Daedalus's and The Red Pill's cycles [×2] | independent | $16b, $21b ($12.5b, $13.4b) | ✓ ×1.3, ×1.6 (uncapped, ×1,000) |
| The same at 5 and 10 min | independent | ×0.003, ×0.1 | ✗ |
| The cash, cycles 1–3 at 20 and 30 min, where spending is most of the income | independent; downstream | ×0.0002 to ×16; under 2% at 20 min | ✗ |
| The cash, the 3rd cycle at 30 min, the 4th at 30 and 60 [10%] | downstream | −9%, −8%, −2% (at 45 min, −10.5%) | ✓ |
| The cash, the 4th cycle at 30–60 min [10%] | independent | −22% to −39% | ✗ |

### Fitted on: run #3 (`test/validation.test.ts`, `test/model.test.ts`)

Run #3's cash is from [#263's comment](https://github.com/UnderMyBed/bitburner-agent/issues/263#issuecomment-6681259933). The downstream checks are on run #3's measured curves unless "fitted" is said. The simulator's BN1.1 (main 412d97b, before #242) is the one independent check here.

| Check | Label | Model (target) | |
|---|---|---|---|
| Simulator BN1.1: 1st install | independent | 45 min (57) [15%] | ✗ −21% |
| Simulator BN1.1: 2nd install | independent | 104 min (122) [15%] | ✓ −15% (−14.8%) |
| Simulator BN1.1: hacking at the installs | independent | 317, 464 (290, 497) [15%] | ✓ +9%, −7% |
| BitRunners' donations unlocked | downstream; fitted | the 7th install, favour after the 6th 139.0 and 143.2 (the 6th, 150.38) | ✗ |
| #244's phase 1 (count 0 → 17) | downstream; fitted | 249, 267 min (267) [15%] | ✓ −7%, 0% |
| #244's phase 2 (BitRunners 5 → 150) | downstream; fitted | 234, 253 min (248) [15%] | ✓ −6%, +2% |
| #244's phase 3; the destroy | downstream; fitted | 158, 205 min (59); 11 h 3 min, 12 h 30 min (11 h 17 min) [15%] | ✗; ✓ −2%, +11% |
| The faction worked most, cycles 1–6 | downstream | as run #3 in 5 of 6 | ✗ in the 3rd (CyberSec; run #3, NiteSec) |
| The count after installs 1, 2, 5, 6 [one] | downstream | 3, 4, 20, 25 (3, 5, 21, 25) | ✓ |
| The count after installs 3, 4 [one] | downstream | 8, 13 (10, 17) | ✗ |
| The favour after installs 1, 4, 5, 6 [20% or 2] | downstream | 4.6, 63.4, 85.3, 139.0 (5.04, 71.88, 96.01, 150.38) | ✓ |
| The favour after installs 2, 3 [20% or 2] | downstream | 17.3, 20.2 (22.54, 37.65) | ✗ |
| Reputation, cycles 1–6 [25%] | downstream | −7%, −31%, −56%, +2%, −26%, −20% | ✗ in 2, 3, 5 |
| Its rate, cycles 1 and 4 [16%]; 5 and 6 | downstream | −7%, −1%; −17%, −17% | ✓; ✗ |
| Each cycle's length [25%] | downstream | −6%, −19%, +4%, −9%, −3%, −8% | ✓ |
| The cash, cycles 5–6, 30–60 min [10%] | downstream | within 9% (the gross within 7% too: it can't tell them apart) | ✓ |
| The cash, cycles 1–3 at 30 min, where spending is most of the income | downstream | under 2% of run #3's in cycles 1 and 2, within 10% in the 3rd; the gross ×2.6 to ×10 | ✗ in 1, 2 |
| The money 15 min into cycles 7–9 [×2] | fitted | ×0.5 to ×2 (uncapped, over ×100) | ✓ |
| The share a cycle, run #3's brain's [10%] | fitted | 1.11 to 1.43 (1.07 to 1.55); the 4th 1.42 (1.16) | ✗ in the 4th |
| The level at each cycle's end, cycles 1–6 [15%] | fitted | within 11% | ✓ |

## The verdict: not fit for #247 yet

#263's gate was the donations at the right install, every phase of #244's within 15%, and the paired comparison. Nothing was tuned on BN1.3 to pass.

1. **The rules hold on real curves.** On BN1.3's own curves, stuck batcher and all, both donations unlock at BN1.3's installs, phases 1 to 4 are within 15%, and the destroy is 2% early. Phase 5 is 23 min against 27.1, a step's minute short of 15%.
2. **The fitted curves don't, for a comparison of policies.** From BN1.3's start, BitRunners' donations unlock at the 6th install (8 h 0 min), where BN1.3's came at its 7th (9 h 9 min). The stuck batcher was in BN1.3's 6th and 7th cycles, so part of that gap is #274's, but how much can't be told from BN1.3.
3. **The joins are instant.** Phase 1 is 23% long because BN1.3's 5th cycle was a quick install at 18.5 min. Its brain worked Tian Di Hui from 6 min and quick-installed its four at 17 min; BitRunners joined only at 10–15 min (the backdoor and the invitation, at hacking 633–818). The model joins at the server's level, A5 works BitRunners at once, and Tian Di Hui's four never come within 20 minutes. Run #3's data has no join times to fit a delay on, and BN1.3's are held out: a delay fitted on BN1.3 needs another run to validate it.
4. **The Daedalus cycle is out of range.** Every run's cycle with Daedalus's grind runs its clocks about 190–220 min past the curves' 120, so the comparison has no answer on Daedalus's join or the destroy.
5. **Still off, as on run #3:** the cash in the steep minutes (the model buys every purchase within the minute, the brain one an intent); the money in a high-multiplier cycle's first 10 minutes (×0.003 to ×0.1, though right by 15 min); the 3rd cycle's work (CyberSec for Gen II before NiteSec); the 8 GB ramp, which no run's data covers.

**What changed, and held up on BN1.3:**

- **The share's shape is fixed for today's brain.** #242's rule, from the brain's code with run #3's 82% use, matches BN1.3's share to within 3% in cycles 1 to 5, with nothing fitted on BN1.3. It rises with home's RAM through a cycle, as BN1.3's did (1.30 to 1.44 in its 2nd). The 1.42–1.43 plateau was run #3's brain's.
- **The money at high multipliers** is right by 15 min (×1.3, ×1.6 of BN1.3's 9th and 10th), from ×1,000 over.

**The paired comparison, run for the record, is not #247's answer.** Count first (today's brain) against favour first, over `COMPARISON_GRID`'s eight settings, gives no answer at any milestone:

- From a fresh BN1.1, favour first unlocks the donations 28–47 min sooner at the 7 settings with a pair, but has none under the gross money. It reaches Daedalus's count 18–42 min later.
- From BN1.3's start, favour first unlocks the donations 31–144 min later at the 4 settings with a pair.
- Daedalus's join and the destroy are out of range everywhere.

**Next, for #247:** the join's delay after the level (the brain's backdoor and invitation), the curves past 120 min for the Daedalus cycle, and a run beyond BN1.3 to validate what's fitted on it.

`test/model.test.ts`: the calibration's consistency (the fit a local best at the refit's own steps, the money's cap on run #3's 7th to 9th cycles), the clocks, home's RAM, SF1's bonus, the favour banked by the game's formula, passive reputation, the joins' rules, A6's "nothing left", The Red Pill's hold, #243's hold, determinism, partial calibration, and the policies. `test/cash-and-state.test.ts`: the purchases through a cycle (the payback over the world and cloud servers, the holds), the income window, each install's fresh purse, the commit's home RAM, the countdown, the holds and the lookahead, the share from the state (#242's and run #3's brain's), the variants, and the extrapolation's flag and bound. `test/compare.test.ts`: the verdict's rule, the milestones' range, favour first, and the grid.
