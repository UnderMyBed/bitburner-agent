# @bitburner-agent/model

The fast model ([#13](https://github.com/UnderMyBed/bitburner-agent/issues/13), [architecture §4.3](../../docs/architecture.md#43-fast-model)): a pure, deterministic model of the game for the planner ([#14](https://github.com/UnderMyBed/bitburner-agent/issues/14)) to roll candidate policies forward on, far faster than the real-engine simulator (2–3× real time once the batcher fills the cloud servers, [#247](https://github.com/UnderMyBed/bitburner-agent/issues/247)). Pure like core (no Node, no DOM), and depending on core only: `core` ← `model` ← the planner; the brain's tests import it, to check it against the brain.

> **Status:** slices 1 and 2 ([#260](https://github.com/UnderMyBed/bitburner-agent/issues/260), [#263](https://github.com/UnderMyBed/bitburner-agent/issues/263)): BN1's cycles of reputation, favour and augmentations; the money in hand by the brain's own purchases; the share by #242's rule; A6's countdown, holds and lookahead; the paired comparison. Fitted on run #3 alone and validated, unchanged, on BN1.3, held out ([#263's decision](https://github.com/UnderMyBed/bitburner-agent/issues/263#issuecomment-6682093248), [#276](https://github.com/UnderMyBed/bitburner-agent/issues/276)). **Not fit for #247 yet** ([the verdict](#the-verdict-not-fit-for-247-yet)): its fitted curves follow BN1.3's first four cycles, but both runs miss BN1.3's quick install in its 5th (the joins are instant), the money's first minutes after an install are off, and every Daedalus cycle runs out of the curves' range. Not wired into the brain's choices ([owner decision 46](../../docs/decisions/owner-decisions.md)).

## Why a package of its own

Core is the game's facts and formulas, imported by the in-game code too; the model adds what isn't the game's: curves measured from a run. The brain is a process with a store; the model is a library the planner and the studies call. So it lives between them, and the brain's choices it makes are core's, moved there from the brain in #260 (A5's work, A6's reach and decision, the city group, home RAM's price), or core's own (#242's share, `shareRound`): what it runs is what the brain runs. The A6 glue and the constants it still copies are tested against the brain on the same inputs ("brain against the fast model"):

- in `packages/brain/test/augmentations.test.ts`, the countdown's start, extensions, end and call-off; the countdown's and the lookahead's reserves; #243's hold, its window and `assumeMoney` after a restart; and the constants it copies, checked equal (the share's home RAM kept and in use among them: the brain's reserved constants, not the game's used RAM);
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

- **The level and the gross income** come from the fitted curve (`Curves`, below; the money's clock at most `moneyPaceMost` times the reference's till the cycle's first cloud server) at the multipliers installed (core's `installGains`, NeuroFlux Governor's levels each, and SF1's bonus), or from a measured cycle (`measured`, `measuredAt`).
- **The money in hand** (`money.ts`, #263): the gross less what the brain spends through the cycle, one purchase after another by its own rules (`nextPurchase`; `desired-state.ts` `#choosePurchase`, `cloud-servers.ts`):
  - a program or home's RAM, the cheaper of those the money covers: a program not in the countdown nor into The Red Pill's donation's money; home's RAM not into any money A6 holds;
  - else a cloud server, from 10 min online: the largest power of two the money covers, less what A6 holds from cloud servers and the next program or home's RAM if the income brings it within a minute, paid back within 15 min at the income a GB of the hack loop's hosts, the world servers its ports root (`ROOTED_WORLD_RAM_GB_BY_PORTS`) and the cloud servers.

  Programs and cloud servers are lost at an install; home's RAM is kept, and the commit buys more with the money above the set's, the donations' and the levels' (`homeRamAtCommit`). With `money: "gross"`, A6 and the joins see the gross instead (#260's money); the purse still spends through the cycle, and the commit's home RAM is from the cash left, so nothing is counted twice.
- **The joins:** a hacker faction once the level reaches its server's (`HACKER_FACTION_JOINS`) and its port openers are bought; Tian Di Hui at hacking 50 and $1m; the city group by core's `cityGroupValues` and `chooseCityGroup` (owner decision 54) once the money covers its invitations; Daedalus with its count, hacking 2500 and $100b.
- **A5's work:** core's `factionWorkChoice`, at core's `factionReputationPerSecond` with the level, `faction_rep`, the favour and the share bonus, focused (owner decision 37). The share bonus is the game's formula on the share threads (`shareBonusOfState`): by #242's rule for today's brain (`CyclePolicy.homeShares`, absent or true; `shareRamGbOfState`), core's `shareRound` on home, less the Agent's 8 GB in use (`HOME_USED_BY_THE_AGENT_GB`) and the 32 it keeps (`SHARE_HOME_KEPT_GB`, both the brain's), and on the batches' hosts, which share only up to 80% use, at their use by cycle (`batchesUseOfHosts`; run #3's 82% for every cycle, so none: low where the level is high, as BN1.3's 9th shared 18–20m GB of the cloud); for run #3's brain and the simulator probe's, before #242, a fitted share (`shareRamShare`) of home's and the cloud servers' RAM; or with `share: "index"` run #3's own by install index (#260's). Every other joined faction gains passive reputation (core's `passiveFactionReputationPerSecond`), special factions aside.
- **A6:** core's `augmentationShops`, `augmentationEndgame` (A8's The Red Pill, "Daedalus donations" and the holds) and `installJudgement` on the set the money covers (`installDecision`), with the lookahead's reserve at the income over the brain's 10-minute window; #243's hold (`countHoldOf`, the money taken as coming while its window is open and there's no income, as the brain's `assumeMoney`); the countdown (`installClock`: 90 s, 30 s for a quick install, extended as the count rises, called off when the rule stops); what the purchases leave alone after it (`holdsOf`). A step is a minute, so the install comes at the first step at or past the countdown's end.
- **An install** banks each faction's favour (`favorAfterInstall`), installs the set and the levels, and starts the next cycle with nothing joined.
- **The destroy:** The Red Pill installed and the level at w0r1d_d43m0n's 3000.

What it leaves out: the time the joins take after the level allows them (the backdoor, the invitation and the brain's cadence: BN1.3's brain joined BitRunners at 10–15 min into its 5th cycle, the model at 5–10); the time the brain's purchases, the commit and the backdoors take (it buys every purchase the money covers within the step, where the brain makes one an intent, a medium snapshot apart; it installs at the countdown's end, where the brain then commits one intent an update: the donations, each augmentation, home's RAM, then NeuroFlux Governor a level at a time as money and reputation come, `augmentations.ts` `#neuroFlux`); combat, charisma and companies; the gang, Bladeburners and every BitNode's curves but BN1's.

**Extrapolation, flagged and bounded (#263):** past its last reading (120 min) each curve runs on at its last slope, and a measured cycle past its end likewise. Each cycle says how many minutes it ran past (`extrapolatedMinutes`, the clock furthest on); one more than `EXTRAPOLATION_BOUND_MIN` (60) past is out of range, and the run lists it (`outOfRange`), the cycle under way at the horizon included.

### Policies

A `CyclePolicy` is what the planner varies (architecture §4.5.3): `daedalusCountHold` (#243), `favourGrind(view)` (a joined faction to work for toward the favour that unlocks its donations, in place of A5's choice; one not joined, or with that reputation earned, leaves A5's), and `install(view, brainsReason)` (whether to install now; never asked about The Red Pill or an endgame hold, never installs nothing). `homeShares` is #242's share, a brain's version rather than a planner's choice (absent: today's). `TODAYS_POLICY` is the brain on main; `RUN_3_POLICY` is run #3's brain (main 7c741cc), before #243's hold and #242's share; `FAVOUR_FIRST_POLICY` is #247's "favour first" (`src/compare.ts`).

## The calibration

`src/calibration.ts`; a sweep overrides any of it through `calibration`. The level and the gross income are **inputs measured from run #3** and fitted, so they validate nothing: what the checks test is the rules that run on them.

| | What | From |
|---|---|---|
| `RUN_3_CYCLES` | Run #3's BN1.2 cycles: the hacking level and the game's hacking income since the install (`moneySources.hacking`) at 5, 10, 15, 20, 30, 45, 60, 75, 90, 105 and 120 min and at each cycle's end. Measured. | [#260's comment](https://github.com/UnderMyBed/bitburner-agent/issues/260#issuecomment-6680681582), the coordinator's read-only extract |
| `referenceCycles` | Cycles 3 to 6, each divided by the multipliers the model runs it at (a test checks they're the model's own), through the game's skill formula (`hackingExpForLevel`): one curve at multiplier 1, their median a minute, read to 120 min. Assumed multipliers: what run #3 installed a cycle isn't known. Fitted. | `RUN_3_CYCLES` |
| `expPaceExponent` 0.625, `moneyPaceExponent` 0.5 | Two clocks run the curve faster at a higher level and hacking speed (each operation's time is ∝ 1/((level + 50) × hacking_speed), `Hacking.ts:60-80`), to these powers. Fitted. | The fit (`test/fit.ts`'s `fitError`): run #3's level and gross income, cycles 1 to 6, and its 7th to 10th's money at 5 to 20 min; 0.2969, a local best at `calibrationSteps` from part 1's constants; from part 2's first refit the descent stops at 0.2989, the worse (a test pins both) |
| `moneyPaceMost` 1.5 | Before the cycle's first cloud server only, the money's clock runs at most this times the reference's. At high multipliers the level's pace ran a 7th cycle's first minutes 5–6 times over: those minutes are bound by the RAM (an install loses the cloud servers, the batches never run on home, and none is bought before 10 min and a 15-minute payback), not the level. Once a server is bought the RAM grows with the money, and the level paces it again. Fitted (#263's part 2), at a step of 0.25. | The same fit |
| `firstCycleSpeed` 0.8, `fullSpeedHomeRamGb` 512 | The pace of a cycle with home's RAM at 8 GB, against 512 GB or more, log-linear between. Fitted on BN1.2's cycles, whose home starts at 32 GB, as BN1.3's does: no run measured says how slow 8 GB is (the simulator, the one at 8 GB, is the independent check). | The same fit |
| `shareRamShare` 0.01 | Run #3's brain's share (before #242): this share of home's and the cloud servers' RAM in share threads (`shareBonusOfState`), the game's formula on it. Its one cap over every host, and the gaps between rounds, aren't a rule of the RAM's. Fitted on run #3's share a cycle, cycles 1 to 6: 6% mean error (3% without the 4th). | `RUN_3_SHARE_BONUS` |
| `batchesUseOfHosts` [0.82] | #242's share (today's brain): the batches' use of their hosts by cycle (past the list, its last), past which (core's `SHARE_MOST_USE`, 0.8) they share nothing. Run #3's one reading, its 4th cycle's, for every cycle: measured on run #3, not fitted. By the cycle's index, the flaw #260's share by index had: the level would key it better (#263's next part). It isn't constant: BN1.3's 9th cycle, at hacking 4,000 and more, shared 18–20m GB of the cloud beside home's. | #242, from run #3's store |
| `shareBonusByCycle` | Run #3's own share bonus a cycle (`RUN_3_SHARE_BONUS`, 1.07 to 1.55), by install index: the `share: "index"` variant only. | The coordinator's per-cycle table |
| `ROOTED_WORLD_RAM_GB_BY_PORTS` | The world servers' RAM the hack loop roots with each number of ports (100 GB with none, 3,169 GB with five): the cloud payback's hosts beside the cloud servers. The game's (a range's mean); a test recomputes it. | `Server/data/servers.ts`; NUKE checks the ports alone, `NetscriptFunctions.ts:541-544` |
| `HACKER_FACTION_JOINS` | Each hacker faction's server's level, the top of the game's range, checked against `servers.ts`. The game's. | `Server/data/servers.ts:1430-1517` |

## The validation

From figures the issues state (`test/fixtures.ts`), never a store. Each check is labelled; the tolerance is in brackets.

- **Independent:** a prediction, nothing of the run checked fitted on it.
- **Downstream:** the rules on a run's own measured level and income a cycle. They share inputs with what they check, so they test the mechanism, not the curves.
- **Fitted:** a check on the run the curves were fitted on, of what they were fitted to: consistency only.
- **Out of range:** the check's cycle, or one before it, ran past the curves' range (`ModelRun.outOfRange`): no validation either way, whatever its figure. Every check asserts its run's range.

A row labelled "independent; downstream" gives each run's figure in that order.

### Held out: BN1.3 (`test/bn1-3.test.ts`)

BN1.3, the exit run (#276; today's brain with #242's share and #243's hold, SF1.2), from [the coordinator's extract on #263](https://github.com/UnderMyBed/bitburner-agent/issues/263), summarised in `BN1_3`, `BN1_3_PER_CYCLE`, `BN1_3_CYCLES`, `BN1_3_CASH` and `BN1_3_SHARE_RAM`. Nothing was fitted on it, or tuned after it. Independent is the fitted model from BN1.3's start; downstream is today's rules on BN1.3's own curves.

**The stuck batcher (#274):** in BN1.3's cycles 6 to 8 the batcher sat about 5 hours on poor targets, so their income, and the level and reputation that follow, are far under a healthy batcher's, and the 9th starts from what they left. The downstream run has them in its curves. The independent run models a healthy batcher, so the size of any check on those cycles, and of the phases and the total they fall in, is confounded.

#244's phases are split by milestone: the count to 17; BitRunners' donations unlocked; the install before Daedalus's donations' (its cycle's start); Daedalus's donations unlocked; the destroy. BN1.3's are 317, 232, 86, 93 and 27 min (run #3's, so split, are #244's own).

| Check | Label | Model (BN1.3) | |
|---|---|---|---|
| The range | independent; downstream | out of it from the 8th cycle (Daedalus's grind, 174 min past the curves' 120); from the 5th (104 min on BN1.3's 18.5-min curve) | — |
| BitRunners' donations unlocked | independent | the 7th install, 8 h 23 min (the 7th, 9 h 9 min) | ✓ the install; its time (−8%) confounded: it spans the stuck 6th and 7th, and phases 1 and 2 (+16%, −42%) cancel in it; not the path (the 5th cycle) |
| Phase 1, the count 0 → 17 [15%] | independent | 368 min (317) | ✗ +16% |
| Phase 2, BitRunners' favour to 150 [15%] | independent | 135 min (232) | ✗ −42%, its size confounded by #274 |
| Phase 3, to Daedalus's cycle [15%] | independent | 0 min (86): Daedalus joined in the next cycle | ✗ |
| Phases 4, 5; the destroy | independent | 114, 17 min; 10 h 34 min (93, 27; 12 h 35 min) | out of range |
| The donations; phases 1–5; the destroy | downstream | the 7th and 9th installs; +1%, −7%, +1%, −1%, −15%; −2% | out of range (from the 5th cycle) |
| Cycles 1–4: each length [25%] | independent | −6%, −9%, +23%, −14% | ✓ |
| Cycles 1–4: the count after [one] | independent | 3, 4, 10, 14 (3, 5, 10, 14) | ✓ |
| Cycles 1–4: the level at the end [15%] | independent | +1%, −6%, −2%, +1% | ✓ |
| Cycles 1, 2, 4: the faction worked most, its favour after [20% or 2] | independent | as BN1.3's; 5.1, 20.3, 58.2 (5.18, 23.62, 70.71) | ✓ |
| Cycle 3: the faction worked most | independent | CyberSec (NiteSec) | ✗ |
| Cycle 5 | independent; downstream | 79, 104 min to the count rule (18.5, a quick install) | ✗ |
| The share's RAM, #242's rule, cycles 2–5 at BN1.3's 25 readings [×2.1, one doubling] | independent | 24 of 25 within; the 2nd cycle at 30 min ×0.25 | ✓ |
| The share's excess (the bonus less 1), cycles 2–5 [10%] | independent | −6%, −3%, −1%, 0% | ✓ |
| The share's excess, cycle 1 [10%] | independent | +33% (its home RAM bought sooner) | ✗ |
| The share's RAM at a high level, BN1.3's 9th cycle at 30–75 min | downstream | ×0.17 to ×0.65 BN1.3's: the batches' hosts share none at the 82%, where BN1.3's left the cloud to the share | ✗, out of range |
| The money 5, 10, 15 min into Daedalus's cycle (BN1.3's 9th) | independent | ×0.02, ×1.6, ×320 | ✗, out of range |
| The cash, cycles 1–3 at 20 and 30 min, where spending is most of the income | independent; downstream | ×0.0002 to ×23; under 2% at 20 min | ✗ |
| The cash, the 4th cycle at 30–60 min [10%] | independent | −15%, −29%, −36% | ✗ |
| The cash once the cloud is bought, the 3rd cycle at 30 min and the 4th at 30–60 [10%] | downstream | −9%, −8%, −10.5%, −2%: 3 of 4, all low | ✓ 3; ✗ 1 |
| Cycles 1–4: the count after [one] | downstream | 3, 4, 8, 13 (3, 5, 10, 14) | ✗ in the 3rd |
| Cycles 1–4: the faction worked most | downstream | as BN1.3's in the 1st and 2nd | ✗ in the 3rd, 4th |
| The 4th cycle's length [25%] | downstream | 77 min (141) | ✗ |

### Fitted on: run #3 (`test/validation.test.ts`, `test/model.test.ts`)

Run #3's cash is from [#263's comment](https://github.com/UnderMyBed/bitburner-agent/issues/263#issuecomment-6681259933). The downstream checks are on run #3's measured curves unless "fitted" is said. The simulator's BN1.1 (main 412d97b, before #242) is the one independent check here.

| Check | Label | Model (target) | |
|---|---|---|---|
| Simulator BN1.1: 1st install | independent | 46 min (57) [15%] | ✗ −19% |
| Simulator BN1.1: 2nd install | independent | 105 min (122) [15%] | ✓ −14% |
| Simulator BN1.1: hacking at the installs | independent | 313, 464 (290, 497) [15%] | ✓ +8%, −7% |
| BitRunners' donations unlocked | downstream; fitted | the 7th install, favour after the 6th 139.0 and 143.0 (the 6th, 150.38) | ✗ |
| #244's phase 1 (count 0 → 17) | downstream; fitted | 249, 268 min (267) [15%] | ✓ −7%, 0% |
| #244's phase 2 (BitRunners 5 → 150) | downstream; fitted | 234, 252 min (248) [15%] | ✓ −6%, +2% |
| #244's phases 3–5; the destroy | downstream; fitted | phase 3 158, 199 min (59); the destroy 11 h 3 min, 12 h 17 min (11 h 17 min) | out of range |
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
| The money 10 min into cycles 7–9 [×3] | fitted | ×1.5 to ×2.1 (uncapped, ×30 and more) | ✓ |
| The fit's other late readings: cycles 7–10 at 5, 15 and 20 min, and the 10th's at 10 | fitted | 5 min ×0.02 to ×0.5; 15 min ×120 to ×350 in the 7th–9th; 20 min ×2,700 and ×3,300 in the 7th and 8th; the 9th at 20 and the 10th's, past the model's own cycle's end, ×0.0014 and ×0.005 to ×0.023 | ✗ |
| The share a cycle, run #3's brain's [10%] | fitted | 1.14 to 1.44 (1.07 to 1.55); the 4th 1.42 (1.16) | ✗ in the 4th |
| The level at each cycle's end, cycles 1–6 [15%] | fitted | within 11% | ✓ |

## The verdict: not fit for #247 yet

#263's gate was the donations at the right install, every phase of #244's within 15%, and the paired comparison. Nothing was tuned on BN1.3 to pass.

1. **The fitted curves follow BN1.3's first four cycles,** held out and in range: each length within 23%, the counts within one, the level within 6%, the faction worked and its favour but in the 3rd cycle, and the share but in the 1st (its excess +33%).
2. **Both runs miss BN1.3's quick install in its 5th cycle, and from there the paths part.** BN1.3's brain worked Tian Di Hui from 6 min and quick-installed its four at 17 min; BitRunners joined only at 10–15 min (the backdoor and the invitation, at hacking 633–818). The model joins at the server's level, 5–10 min in, and A5 works BitRunners at once. The downstream run goes out of range there, so its milestones are no validation. The independent run's 5th cycle runs 79 min, so phase 1 is 16% long. BitRunners' donations still unlock at BN1.3's 7th install, 8% sooner, but by another path: its 6th leaves favour 148.8 where BN1.3's left 128.22.
3. **Phases 2 and 3 miss** (−42%, and 0 against 86 min): BN1.3's stuck batcher (#274) confounds their size, but not that the model joins Daedalus a cycle sooner.
4. **Every Daedalus cycle is out of range,** 170–220 min past the curves' 120, so phases 4 and 5, the destroy, and the comparison's Daedalus milestones have no answer.
5. **The money's first minutes after an install are off.** The cap now holds only before the cycle's first cloud server, where it's justified: right at 10 min on run #3, where it's fitted, but the model buys its first server at about 10 min, where the brain held off to 15–20 min and more, so by 15 min the model is ×100 and more over on run #3 and on BN1.3. (Part 2's first cap, over the whole cycle, passed 15 min only at a crossing point, ×0.003 and ×0.1 at 5 and 10 min.)
6. **Still off, as on run #3:** the cash in the steep minutes (the model buys every purchase within the minute, the brain one an intent); the 3rd cycle's work (CyberSec for Gen II before NiteSec); the 8 GB ramp, which no run's data covers; and the share at a high level, where the batches leave the cloud servers to it.

**What held up on BN1.3: the share's shape for today's brain,** in cycles 2 to 5. #242's rule, core's own `shareRound` on the brain's constants with run #3's 82% use, puts the share's RAM within one doubling of BN1.3's at 24 of its 25 readings there, and the bonus's excess within 6%, with nothing fitted on BN1.3. It rises with home's RAM through a cycle, as BN1.3's did; the 1.42–1.43 plateau was run #3's brain's. Two of this part's structural changes followed the first review's findings, which cited BN1.3's figures: home's RAM in use in the share (from the 1st cycle's share), and the cap held before the first cloud server only (from the money's ×0.003 and ×0.1 at 5 and 10 min). Neither is fitted on BN1.3, but BN1.3 isn't wholly held out from them: the 1st cycle's 0, 24 and 472 GB of home's 32, 64 and 512, which the share now gives, were seen first, so they aren't counted as validation.

**The paired comparison, run for the record on the full grid, is not #247's answer** (`test/compare.test.ts` pins it). Count first (today's brain) against favour first, over `COMPARISON_GRID`'s 14 settings:

- From a fresh BN1.1: no answer on the donations (favour first −53 to +2 min; the share by index flips it); count first reaches Daedalus's count sooner at every setting, by 5 to 62 min.
- From BN1.3's start: no answer. Favour first unlocks the donations 9 to 143 min later where paired, but 3 of the 14 settings have no pair; it reaches Daedalus's count 36 to 163 min later where paired, again with 3 unpaired.
- Daedalus's join and the destroy are out of range everywhere.

**Next, in #263's next part:** model the join's timing after the level (the backdoor's hack time / 4, the game's invitation check, the brain's cadence) with a test against the brain's on the same inputs, rather than fit it, so BN1.3 stays a check; model the brain's first cloud purchase in a cycle (the model buys at about 10 min, where the brain held off to 15–20 min and more, and the cap releases there: verdict 5's ×100 to ×320), with a grid variant for it; add the join's timing and the start state to the grid; key the batches' use by the level rather than the cycle's index; extend the curves past 120 min with BN1.3's 141-min 4th cycle, its held-out use now spent, and validate on the next run; and narrow #247 to the donations from an SF1 start, where the model stays in range.

`test/fit.ts`: the fit's objective (`fitError`). `test/model.test.ts`: the calibration's consistency (the fit a local best at `calibrationSteps`, the cap before the first cloud server, on run #3's 7th to 9th cycles), the clocks, home's RAM, SF1's bonus, the favour banked by the game's formula, passive reputation, the joins' rules, A6's "nothing left", The Red Pill's hold, #243's hold, determinism, partial calibration, and the policies. `test/cash-and-state.test.ts`: the purchases through a cycle (the payback over the world and cloud servers, the holds), the income window, each install's fresh purse, the commit's home RAM, the countdown, the holds and the lookahead, the share from the state (#242's on core's `shareRound`, by cycle, and run #3's brain's), the variants, and the extrapolation's flag and bound. `test/compare.test.ts`: the verdict's rule, the milestones' range, favour first, both policies' pairs, the grid, and #247's comparison pinned.
