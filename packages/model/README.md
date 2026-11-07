# @bitburner-agent/model

The fast model ([#13](https://github.com/UnderMyBed/bitburner-agent/issues/13), [architecture §4.3](../../docs/architecture.md#43-fast-model)): a pure, deterministic model of the game for the planner ([#14](https://github.com/UnderMyBed/bitburner-agent/issues/14)) to roll candidate policies forward on, far faster than the real-engine simulator (2–3× real time once the batcher fills the cloud servers, [#247](https://github.com/UnderMyBed/bitburner-agent/issues/247)). Pure like core (no Node, no DOM), and depending on core only: `core` ← `model` ← the planner; the brain's tests import it, to check it against the brain.

> **Status:** slices 1 to 3 ([#260](https://github.com/UnderMyBed/bitburner-agent/issues/260), [#263](https://github.com/UnderMyBed/bitburner-agent/issues/263), [#294](https://github.com/UnderMyBed/bitburner-agent/issues/294)'s items 1, 2, 3 and 5): BN1's cycles of reputation, favour and augmentations; the money in hand by the brain's own purchases, one a medium snapshot, cloud servers by its own income measure; the joins in the time the brain and the game take; the share by #242's rule, the batches' use from the state; A6's countdown, holds and lookahead; the paired comparison over the joins' time, the first cloud server's and three starts. Fitted on run #3 alone (refitted in #294) and checked on BN1.3, which is **seen, no longer held out**: #294 was planned from its figures. **Not fit for #247 yet** ([the verdict](#the-verdict-not-fit-for-247-yet)): on BN1.3's own curves the rules now follow its whole run, in range, but the fitted curves still miss its 4th and 5th cycles, every Daedalus cycle runs out of their range, and the money after a cycle's first cloud server runs away. #294's item 4 (the curves past 120 min) waits for the next live run, the next held-out check. Not wired into the brain's choices ([owner decision 46](../../docs/decisions/owner-decisions.md)).

## Why a package of its own

Core is the game's facts and formulas, imported by the in-game code too; the model adds what isn't the game's: curves measured from a run. The brain is a process with a store; the model is a library the planner and the studies call. So it lives between them, and the brain's choices it makes are core's, moved there from the brain in #260 (A5's work, A6's reach and decision, the city group, home RAM's price), or core's own (#242's share, `shareRound`; #294's batch plan): what it runs is what the brain runs. The glue and the constants it still copies are tested against the brain on the same inputs ("brain against the fast model"):

- in `packages/brain/test/augmentations.test.ts`, the countdown's start, extensions, end and call-off; the countdown's and the lookahead's reserves; #243's hold, its window and `assumeMoney` after a restart; and the constants it copies, checked equal (the share's home RAM kept and in use among them: the brain's reserved constants, not the game's used RAM);
- in `packages/brain/test/desired-state.test.ts`, the purchase chosen (a program, home RAM or a cloud server) from the same purse, money and income, over an empty cloud, a program or home's RAM first, the next one held back, money short and a payback not met; and what the countdown, Daedalus's $100b and The Red Pill's donation hold back from it;
- in `packages/brain/test/cloud-servers.test.ts` (#294), the income measure the cloud purchases pay back on: the model's `IncomeWindow` gives the brain's `HackLoopIncome` rate, sample by sample, over 25 minutes of medium snapshots with purchases and growing RAM;
- in `packages/brain/test/backdoors.test.ts` (#294), a hacker faction's join: the brain's own `BackdoorRule` on medium snapshots and `chooseJoin` on slow ones, with the Agent's rounds and the game's backdoor and invitation check between, averaged over the snapshots' phases, within 2.5 s of the model's `hackerFactionJoinMs`; the backdoor's time is core's `hackTimeSeconds` / 4.

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
// The structural variants: A6 seeing the gross, the share by install index (#263); the joins at once, or later (#294).
runModel({ currentNode: 1, ownedSF: { "1": 1 } }, { money: "gross", share: "index", joinDelay: "instant" });
// #247's paired comparison: two policies at each setting of a grid, a difference only where every setting agrees.
pairedComparison({ currentNode: 1, ownedSF: {} }, TODAYS_POLICY, FAVOUR_FIRST_POLICY).verdict;
```

`runModel(start, { policy, calibration, measured, money, share, joinDelay, cloudDelayMs, horizonMs, stepMs, onStep, onWork })` steps a BitNode a minute at a time from its start to its destroy, about 0.25 s a run locally. Each step:

- **The level and the gross income** come from the fitted curve (`Curves`, below; the money's clock at most `moneyPaceMost` times the reference's till the cycle's first cloud server) at the multipliers installed (core's `installGains`, NeuroFlux Governor's levels each, and SF1's bonus), or from a measured cycle (`measured`, `measuredAt`). Within the step, the clocks run a medium snapshot (10 s) at a time.
- **The money in hand** (`money.ts`, #263): the gross less what the brain spends through the cycle, **one purchase a medium snapshot** (#294: the brain chooses the next from the snapshot that shows the last done), by its own rules (`nextPurchase`; `desired-state.ts` `#choosePurchase`, `cloud-servers.ts`):
  - a program or home's RAM, the cheaper of those the money covers: a program not in the countdown nor into The Red Pill's donation's money; home's RAM not into any money A6 holds;
  - else a cloud server, once the brain's income measure has a full window: **the money's rises between medium snapshots over the hack loop's hosts' RAM × time, across the last 10 minutes** (`IncomeWindow`, the brain's `HackLoopIncome`, #207), from the Agent's first usable medium snapshot after an install (`FIRST_INCOME_SAMPLE_MS`, 20 s), so the first server comes at 10 min 20 s at the soonest; the largest power of two the money covers, less what A6 holds from cloud servers and the next program or home's RAM if the income brings it within a minute, paid back within 15 min at that income a GB. A purchase between two snapshots hides that stretch's rise, and a server just bought weighs only from its first snapshot, as in the brain.

  The step's own purchase comes after A6's decision, under the holds it has just set (the brain's one update). Programs and cloud servers are lost at an install; home's RAM is kept, and the commit buys more with the money above the set's, the donations' and the levels' (`homeRamAtCommit`). With `money: "gross"`, A6 and the joins see the gross instead (#260's money); the purse still spends through the cycle, and the commit's home RAM is from the cash left, so nothing is counted twice.
- **The joins** (`joins.ts`, #294): a hacker faction once the level reaches its server's (`HACKER_FACTION_JOINS`) and its port openers are bought; Tian Di Hui at hacking 50 and $1m; the city group by core's `cityGroupValues` and `chooseCityGroup` (owner decision 54) once the money covers its invitations; Daedalus with its count, hacking 2500 and $100b. **Each joins as long after its terms as the brain and the game take**, each wait at its mean: for a hacker faction, the next medium snapshot (the brain's `chooseBackdoor`), the Agent's round, the backdoor's quarter hack time at security 1 (`Terminal/Terminal.ts:242`), the game's invitation check every 2 s (`engine.tsx:177-182`), the dialog answered, the invitation in the next slow snapshot, the join in the Agent's round, and the slow snapshot after that, which A5 works from: about 1 min 42 s, so the faction is joined two steps after its terms. Tian Di Hui adds the travel's round instead of the backdoor; a city group a visit a city and each join through the irreversible gate, one at a time; Daedalus the invitation's tail alone. `joinDelay: "instant"` joins at the step the terms are met (slice 2's), a number that many ms later than modelled.
- **A5's work:** core's `factionWorkChoice`, at core's `factionReputationPerSecond` with the level, `faction_rep`, the favour and the share bonus, focused (owner decision 37). The share bonus is the game's formula on the share threads: by #242's rule for today's brain (`CyclePolicy.homeShares`, absent or true; `shareRamGbOfState`), core's `shareRound` on home, less the Agent's 8 GB in use (`HOME_USED_BY_THE_AGENT_GB`) and the 32 it keeps (`SHARE_HOME_KEPT_GB`, both the brain's), and on the batches' hosts, which share only up to 80% use, at **their use from the state** (#294, `batches.ts`: core's batch plan at its most on the target worth most among those the level and the ports reach, `batchesPeakGbOf`, over the hosts' RAM: the hosts fill in the early cycles, and at a high level the target's money bounds the batches, so most of the cloud is left to the share); for run #3's brain and the simulator probe's, before #242, a fitted share (`shareRamShare`) of home's and the cloud servers' RAM; or with `share: "index"` run #3's own by install index (#260's). Every other joined faction gains passive reputation (core's `passiveFactionReputationPerSecond`), special factions aside.
- **A6:** core's `augmentationShops`, `augmentationEndgame` (A8's The Red Pill, "Daedalus donations" and the holds) and `installJudgement` on the set the money covers (`installDecision`), with the lookahead's reserve at the income over the brain's 10-minute window; #243's hold (`countHoldOf`, the money taken as coming while its window is open and there's no income, as the brain's `assumeMoney`); the countdown (`installClock`: 90 s, 30 s for a quick install, extended as the count rises, called off when the rule stops); what the purchases leave alone after it (`holdsOf`). A step is a minute, so the install comes at the first step at or past the countdown's end.
- **An install** banks each faction's favour (`favorAfterInstall`), installs the set and the levels, and starts the next cycle with nothing joined, a fresh income measure and no join under way.
- **The destroy:** The Red Pill installed and the level at w0r1d_d43m0n's 3000.

What it leaves out: the hack loop's root (every 30 s; the level, not the port opener, comes last in the model's runs); the batches' ramp on a cycle's new RAM (the money after the first cloud server, [the verdict](#the-verdict-not-fit-for-247-yet)); the batcher's preparation of its target and the next one prepared beside the batches; the time the commit takes (the brain commits one intent an update: the donations, each augmentation, home's RAM, then NeuroFlux Governor a level at a time, `augmentations.ts` `#neuroFlux`); the money a cycle may start with; combat, charisma and companies; the gang, Bladeburners and every BitNode's curves but BN1's.

**Extrapolation, flagged and bounded (#263):** past its last reading (120 min) each curve runs on at its last slope, and a measured cycle past its end likewise. Each cycle says how many minutes it ran past (`extrapolatedMinutes`, the clock furthest on); one more than `EXTRAPOLATION_BOUND_MIN` (60) past is out of range, and the run lists it (`outOfRange`), the cycle under way at the horizon included.

### Policies

A `CyclePolicy` is what the planner varies (architecture §4.5.3): `daedalusCountHold` (#243), `favourGrind(view)` (a joined faction to work for toward the favour that unlocks its donations, in place of A5's choice; one not joined, or with that reputation earned, leaves A5's), and `install(view, brainsReason)` (whether to install now; never asked about The Red Pill or an endgame hold, never installs nothing). `homeShares` is #242's share, a brain's version rather than a planner's choice (absent: today's). `TODAYS_POLICY` is the brain on main; `RUN_3_POLICY` is run #3's brain (main 7c741cc), before #243's hold and #242's share; `FAVOUR_FIRST_POLICY` is #247's "favour first" (`src/compare.ts`).

## The calibration

`src/calibration.ts`; a sweep overrides any of it through `calibration`. The level and the gross income are **inputs measured from run #3** and fitted, so they validate nothing: what the checks test is the rules that run on them.

| | What | From |
|---|---|---|
| `RUN_3_CYCLES` | Run #3's BN1.2 cycles: the hacking level and the game's hacking income since the install (`moneySources.hacking`) at 5, 10, 15, 20, 30, 45, 60, 75, 90, 105 and 120 min and at each cycle's end. Measured. | [#260's comment](https://github.com/UnderMyBed/bitburner-agent/issues/260#issuecomment-6680681582), the coordinator's read-only extract |
| `referenceCycles` | Cycles 3 to 6, each divided by the multipliers the brain's rules install for it on run #3's own measured curves (the downstream run; a test checks they're its own), through the game's skill formula (`hackingExpForLevel`): one curve at multiplier 1, their median a minute, read to 120 min. Until #294 the fitted run's own multipliers; with #294's joins and purchases that has no fixed point (its 5th cycle a quick install or not, by turns). Assumed multipliers: what run #3 installed a cycle isn't known. Fitted. | `RUN_3_CYCLES` |
| `expPaceExponent` 0.5, `moneyPaceExponent` 0.375 | Two clocks run the curve faster at a higher level and hacking speed (each operation's time is ∝ 1/((level + 50) × hacking_speed), `Hacking.ts:60-80`), to these powers. Fitted; #263's 0.625 and 0.5. | The fit (`test/fit.ts`'s `fitError`): run #3's level and gross income, cycles 1 to 6, and its 7th to 10th's money at 5 to 20 min; **0.2658** (0.1900 on cycles 1 to 6), a local best at `calibrationSteps` from #263's constants, which #294's joins and purchases had moved to 0.3265; from #263's first refit the descent stops at 0.2829, the worse (a test pins both) |
| `moneyPaceMost` 2.75 | Before the cycle's first cloud server only, the money's clock runs at most this times the reference's. Fitted (#263's 1.5): at the refit's slower money pace it no longer binds in run #3's 7th and 8th cycles, but the fit is better for it. | The same fit |
| `firstCycleSpeed` 0.75, `fullSpeedHomeRamGb` 1024 | The pace of a cycle with home's RAM at 8 GB, against 1 TB or more, log-linear between. Fitted (#263's 0.8 and 512) on BN1.2's cycles, whose home starts at 32 GB, as BN1.3's does: no run measured says how slow 8 GB is (the simulator, the one at 8 GB, is the independent check). | The same fit |
| `shareRamShare` 0.01 | Run #3's brain's share (before #242): this share of home's and the cloud servers' RAM in share threads (`shareBonusOfState`), the game's formula on it. Its one cap over every host, and the gaps between rounds, aren't a rule of the RAM's. Fitted on run #3's share a cycle, cycles 1 to 6: 6% mean error (3% without the 4th). | `RUN_3_SHARE_BONUS` |
| `batchesUseFactor` 1 | #242's share (today's brain): a factor on the batches' use of their hosts from the state (`batches.ts`, #294), core's own batch maths; the comparison's grid varies it. Not fitted: core's plan gives 100% at run #3's 4th cycle, where #242 measured 82% (both past 80%, so the hosts share nothing), and about 10% at BN1.3's 9th's level, where its share left about that. #263's was run #3's 82% for every cycle, by the cycle's index. | Core (`batchPlan`'s maths), on `BATCH_TARGETS` |
| `BATCH_TARGETS` | BN1's servers with money, as the batcher's targets: the ports, the money (25 times the starting money), the security, the level and the growth, a range's mean where the game draws one per save. The game's; a test recomputes it. | `Server/data/servers.ts`, `Server/Server.ts:76-83` |
| `shareBonusByCycle` | Run #3's own share bonus a cycle (`RUN_3_SHARE_BONUS`, 1.07 to 1.55), by install index: the `share: "index"` variant only. | The coordinator's per-cycle table |
| `ROOTED_WORLD_RAM_GB_BY_PORTS` | The world servers' RAM the hack loop roots with each number of ports (100 GB with none, 3,169 GB with five): the hack loop's hosts beside the cloud servers. The game's (a range's mean); a test recomputes it. | `Server/data/servers.ts`; NUKE checks the ports alone, `NetscriptFunctions.ts:541-544` |
| `HACKER_FACTION_JOINS` | Each hacker faction's server's level, the top of the game's range, checked against `servers.ts`. The game's. | `Server/data/servers.ts:1430-1517` |
| `joins.ts`'s cadence | The snapshots' periods (core's `SNAPSHOT_TIER_PERIOD_MS`), the game's invitation check (`INVITATION_CHECK_MS`, 2 s), the irreversible gate's medium snapshots (`GATE_MEDIUM_SNAPSHOTS`, the brain's 2). The game's and the brain's; not fitted. | `engine.tsx:177-182`, `Constants.ts:19`, packages/brain/src/irreversible-gate.ts |

## The validation

From figures the issues state (`test/fixtures.ts`), never a store. Each check is labelled; the tolerance is in brackets.

- **Independent:** a prediction, nothing of the run checked fitted on it.
- **Downstream:** the rules on a run's own measured level and income a cycle. They share inputs with what they check, so they test the mechanism, not the curves.
- **Fitted:** a check on the run the curves were fitted on, of what they were fitted to: consistency only.
- **Seen (no longer held out):** BN1.3. #263's part 2 held it out; its first review then cited its figures, and #294 was planned from them, so it can't validate any more. Nothing is fitted on it: #294's refit is on run #3 alone, and its mechanisms are the brain's code and the game's, tested against them. The next live run is the held-out check.
- **Out of range:** the check's cycle, or one before it, ran past the curves' range (`ModelRun.outOfRange`): no validation either way, whatever its figure. Every check asserts its run's range.

### BN1.3, seen (`test/bn1-3.test.ts`)

BN1.3, the exit run (#276; today's brain with #242's share and #243's hold, SF1.2), from [the coordinator's extract on #263](https://github.com/UnderMyBed/bitburner-agent/issues/263), summarised in `BN1_3`, `BN1_3_PER_CYCLE`, `BN1_3_CYCLES`, `BN1_3_CASH` and `BN1_3_SHARE_RAM`. Independent is the fitted model from BN1.3's start; downstream is today's rules on BN1.3's own curves.

**The stuck batcher (#274):** in BN1.3's cycles 6 to 8 the batcher sat about 5 hours on poor targets, so their income, and the level and reputation that follow, are far under a healthy batcher's, and the 9th starts from what they left. The downstream run has them in its curves. The independent run models a healthy batcher, so the size of any check on those cycles, and of the phases and the total they fall in, is confounded.

#244's phases are split by milestone: the count to 17; BitRunners' donations unlocked; the install before Daedalus's donations' (its cycle's start); Daedalus's donations unlocked; the destroy. BN1.3's are 317, 232, 86, 93 and 27 min.

| Check | Label | Model (BN1.3) | #294 | #263 |
|---|---|---|---|---|
| The range | downstream | every cycle in it | ✓ | out from the 5th |
| The 5th cycle | downstream | a quick install at 17 min (18.5) [25%]; BitRunners joined at 11 min (10–15) | ✓ | ✗ 104 min |
| Both donations' installs | downstream | the 7th and the 9th (the 7th, the 9th) | ✓ | out of range |
| #244's phases 1–5 [15%] | downstream | −2%, +3%, +1%, +7%, −11% | ✓ | out of range |
| The destroy | downstream | 12 h 39 min (12 h 35 min), +0.5% | ✓ | out of range |
| Each cycle's length, 1–10 [25%] | downstream | all within | ✓ | ✗ the 4th, 5th |
| The count after, 1–5 [one] | downstream | 3, 4, 10, 13, 17 (3, 5, 10, 14, 18) | ✓ | ✗ the 3rd |
| The count after, 6th and 7th [one] | downstream | 21, 28 (23, 32) | ✗ | out of range |
| The faction worked most, 1–9 | downstream | as BN1.3's in 6 of 9 | ✗ the 3rd, 7th, 8th | ✗ the 3rd, 4th |
| Each cycle's first cloud server, 1–8 | downstream | 11 to 14 min (between 10 and 15) | ✓ | (at 10) |
| Daedalus's cycle's first cloud server | downstream | 17 min (15–20: its $100b held) | ✓ | out of range |
| The cash, 9 readings [×2] | downstream | 7 of 9 within (×0.46 to ×2.4) | ✓ 7 | ✗ (under 2% at 20 min) |
| The share's RAM at a high level, the 9th at 30–75 min [×2.1] | downstream | ×0.90 to ×1.00 (at 20 min ×8.4: the model's cloud bought first) | ✓ | ✗ ×0.17 to ×0.65 |
| The share's excess, cycles 2–5 [10%]; the 1st | downstream | within; +23% | ✓; ✗ | — |
| The range | independent | out from the 8th (Daedalus's grind, 130 min past the curves' 120) | — | the 8th |
| BitRunners' donations unlocked | independent | the 7th install, 8 h 30 min (the 7th, 9 h 9 min) | ✓ the install; its time (−7%) confounded | ✓ (−8%) |
| Phase 1 [15%] | independent | 358 min (317), +13% | ✓ | ✗ +16% |
| Phases 2, 3 [15%] | independent | 152 (232), 0 (86) | ✗ −34%, size confounded; ✗ | ✗ −42%; ✗ |
| Phases 4, 5; the destroy | independent | 119, 14 min; 10 h 43 min | out of range | out of range |
| Cycles 1–3: length [25%], count [one] | independent | −6%, −13%, +14%; 3, 4, 9 (3, 5, 10) | ✓ | ✓ (and the 4th) |
| Cycles 1–4: the level at the end [15%] | independent | −2%, −7%, −5%, −9% | ✓ | ✓ |
| The 4th cycle | independent | 73 min (141), 16 installed after (14) | ✗ | ✓ −14% |
| The 5th cycle | independent | 126 min, the count rule (18.5, a quick install); BitRunners joined at 13 min (10–15) | ✗ the install; ✓ the join | ✗ 79 min |
| Cycles 1, 2: the faction worked; the 1st's favour [20% or 2] | independent | as BN1.3's; 4.9 (5.18) | ✓ | ✓ |
| The 2nd's favour; the 3rd and 4th's faction | independent | 18.7 (23.62), −21%; CyberSec, NiteSec (NiteSec, BitRunners) | ✗ | ✓; ✗ the 3rd |
| Each cycle's first cloud server, 1–7 | independent | 11 to 13 min (between 10 and 15) | ✓ | (at 10) |
| The money 5, 10, 15 min into Daedalus's cycle | independent | ×0.09, ×14, ×680; its first cloud server at 11 min (15–20) | ✗, out of range | ✗ ×0.02, ×1.6, ×320 |
| The share's excess, cycles 2–5 [10%]; the 1st | independent | 3 of 4 (the 2nd −11%); +16% | ✗ 1; ✗ | ✓; ✗ +33% |
| The share's RAM, cycles 2–5 at the readings the model's cycles reach [×2.1] | independent | 19 of 20 (the 2nd at 30 min ×0.25) | ✓ | ✓ 24 of 25 |
| The cash, 9 readings [×2] | independent | 4 of 9 (the 3rd ×0.03 and ×0.08, the 1st at 30 min ×10) | ✗ | ✗ |

### Fitted on: run #3 (`test/validation.test.ts`, `test/model.test.ts`)

Run #3's cash is from [#263's comment](https://github.com/UnderMyBed/bitburner-agent/issues/263#issuecomment-6681259933). The downstream checks are on run #3's measured curves unless "fitted" is said. The simulator's BN1.1 (main 412d97b, before #242) is the one independent check here.

| Check | Label | Model (target) | |
|---|---|---|---|
| Simulator BN1.1: 1st install | independent | 46 min (57) [15%] | ✗ −19% |
| Simulator BN1.1: 2nd install | independent | 110 min (122) [15%] | ✓ −10% |
| Simulator BN1.1: hacking at the installs | independent | 312, 493 (290, 497) [15%] | ✓ +8%, −1% |
| BitRunners' donations unlocked | downstream; fitted | the 7th install, favour after the 6th 148.2 and 147.5 (the 6th, 150.38) | ✗ (#263's 139.0, 143.0) |
| #244's phase 1 (count 0 → 17) | downstream; fitted | 260, 317 min (267) [15%] | ✓ −3%; ✗ +19% |
| #244's phase 2 (BitRunners 5 → 150) | downstream; fitted | 251, 214 min (248) [15%] | ✓ +1%, −14% |
| #244's phases 3–5; the destroy | downstream; fitted | the destroy 11 h 25 min, 12 h 38 min (11 h 17 min) | out of range |
| The faction worked most, cycles 1–6 | downstream | as run #3 in 5 of 6 | ✗ in the 3rd (CyberSec; run #3, NiteSec) |
| The count after installs 1–6 [one] | downstream | 3, 4, 9, 17, 21, 25 (3, 5, 10, 17, 21, 25) | ✓ (#263: the 3rd and 4th ✗) |
| The favour after installs 1, 4, 5, 6 [20% or 2] | downstream | 5.2, 66.1, 92.6, 148.2 (5.04, 71.88, 96.01, 150.38) | ✓ |
| The favour after installs 2, 3 [20% or 2] | downstream | 18.8, 25.6 (22.54, 37.65) | ✓ −17%; ✗ −32% |
| Reputation and its rate, cycles 1, 4, 5, 6 [25%, 16%] | downstream | +5%, +3%, −7%, −2%; +5%, +8%, −5%, −9% | ✓ (#263: the 5th, 6th ✗ −26%, −20%) |
| Each cycle's length [25%] | downstream | −1%, −15%, +14%, −9%, −1%, +4% | ✓ |
| The cash, cycles 5–6, 30–60 min [10%] | downstream | within 9% | ✓ |
| The cash, cycles 1–3 at 30 min [×2] | downstream | ×0.56, ×0.97, ×1.3 | ✓ (#263: under 2% in the 1st, 2nd) |
| The money 10 min into cycles 7 and 8 [×3] | fitted | ×3.2, ×6.4: the cap doesn't bind there | ✗ (#263: ×1.5 to ×2.1) |
| The money 15 min into cycles 7 and 8 | fitted | ×190, ×350 | ✗ |
| The share a cycle, run #3's brain's [10%] | fitted | within, but the 4th (run #3's 1.16) | ✗ in the 4th |
| The level at each cycle's end, cycles 1–6 [15%] | fitted | within 6% | ✓ |

## The verdict: not fit for #247 yet

#263's bar was the donations at the right install, every phase of #244's within 15%, and the paired comparison giving an answer. Nothing was tuned on BN1.3.

1. **The rules now follow BN1.3 end to end on its own curves** (downstream, seen): every cycle in range, the 5th cycle's quick install at 17 min against 18.5, both donations at its installs, every phase within 15% (−2% to +7%, the 5th −11%), each cycle's length within 25%, the destroy +0.5%. #294's three mechanisms did it: the joins' time (BitRunners joined at 11 min, not at the level), the purchases a medium snapshot apart (the cash within ×2 at 7 of 9 readings, from under 2%), and the batches' use from the state (the 9th cycle's share RAM ×0.90 to ×1.00, from ×0.17 to ×0.65). On run #3's curves, likewise: every count within one, the 5th and 6th cycles' reputation −7% and −2% (from −26% and −20%), the cash in the steep minutes within ×2. BitRunners' favour after run #3's 6th is 148.2 against 150.38: still one install late, by 1.5%.
2. **The fitted curves don't meet the bar.** From BN1.3's start, phase 1 is in (+13%), BitRunners' donations unlock at its 7th install, the first three cycles and four levels follow; but the 4th cycle runs 73 min against 141 and installs 16, so the 5th has no Tian Di Hui quick install (126 min), and phase 2 is −34% (its size confounded by #274), phase 3 0 against 86. On run #3 the fitted run's phase 1 is now +19%: the refit's 3rd and 4th cycles run 34% and 37% long.
3. **The money after a cycle's first cloud server runs away**, ×190 and more at 15 min on run #3's 7th and 8th, ×680 in BN1.3's Daedalus cycle. #294 models the first purchase at the brain's own time, 10 min 20 s at the soonest, and it does come between 10 and 15 min in every BN1.3 cycle but Daedalus's (held for its $100b), as BN1.3's did. So its timing wasn't the cause: run #3's money rose about $1b a minute from 10 to 20 min with its servers already bought. What's missing is the batches' ramp on the new RAM, a curve, not a rule (#294's item 4, with the curves past 120 min). The refit's money cap no longer binds there.
4. **Every Daedalus cycle is out of range** in the fitted runs, so phases 4 and 5, the destroy, and the comparison's Daedalus milestones have no answer.
5. **The paired comparison, run for the record on the 20 settings** (`test/compare.test.ts` pins it), count first (today's brain) against favour first: **no answer on any milestone.** From BN1.3's start, favour first unlocks the donations later at 14 of the 15 paired settings (19 to 94 min) and sooner at #260's gross money (−65), with 5 settings unpaired; Daedalus's count likewise (−1 to 104 min, 5 unpaired). From a fresh BN1.1, 13 of 20 settings have no pair: the fresh runs go out of range before the donations, so it answers at fewer settings than #263's grid did there (none unpaired), and #263's "count first reaches Daedalus's count sooner at every setting" no longer holds. The three starts are now in the grid, so an answer must hold from every start. From SF1.2 more settings pair than in #263's (15 of 20, against 11 of 14), but where #263's paired ones all had favour first later, one of the 15 now flips; no milestone has an answer at every setting.

**Next (#294's item 4 and #247):** the batches' ramp on a cycle's new RAM and the curves past 120 min, from BN1.3's 141-min 4th cycle and its Daedalus cycles, validated on the next live run (1.0.1's or later), the held-out check; then #247, narrowed to the donations from an SF1 start (#294's item 6).

`test/fit.ts`: the fit's objective (`fitError`). `test/model.test.ts`: the calibration's consistency (the fit a local best at `calibrationSteps`, from two starts; the reference cycles the downstream run's own; the cap and the clocks), home's RAM, SF1's bonus, the favour banked by the game's formula, passive reputation, the joins' rules and their modelled time (and at once, and later), A6's "nothing left", The Red Pill's hold, #243's hold, determinism, partial calibration, and the policies. `test/cash-and-state.test.ts`: the purchases (one at a time, the payback on the brain's measure, the holds), the brain's income measure, a run's purchases a medium snapshot apart and its first cloud server at the brain's time, each install's fresh purse, the commit's home RAM, the countdown, the holds and the lookahead, the share from the state (#242's on core's `shareRound`; the batches' use from core's batch maths, against run #3's 4th and BN1.3's 9th; the targets the game's), the variants, and the extrapolation's flag and bound. `test/compare.test.ts`: the verdict's rule, the milestones' range, favour first, both policies' pairs, a setting's own start, the grid, and #247's comparison pinned.
