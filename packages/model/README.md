# @bitburner-agent/model

The fast model ([#13](https://github.com/UnderMyBed/bitburner-agent/issues/13), [architecture §4.3](../../docs/architecture.md#43-fast-model)): a pure, deterministic model of the game for the planner ([#14](https://github.com/UnderMyBed/bitburner-agent/issues/14)) to roll candidate policies forward on, far faster than the real-engine simulator (2–3× real time once the batcher fills the cloud servers, [#247](https://github.com/UnderMyBed/bitburner-agent/issues/247)). Pure like core (no Node, no DOM), and depending on core only: `core` ← `model` ← the planner.

> **Status:** first slice ([#260](https://github.com/UnderMyBed/bitburner-agent/issues/260)): BN1's cycles of reputation, favour and augmentations. It follows run #3's mechanism through cycle 6, and **isn't yet fit for #247** ([below](#not-yet-fit-for-247); [#263](https://github.com/UnderMyBed/bitburner-agent/issues/263), slice 2). Not wired into the brain's choices ([owner decision 46](../../docs/decisions/owner-decisions.md)).

## Why a package of its own

Core is the game's facts and formulas, imported by the in-game code too; the model adds what isn't the game's: curves measured from a run. The brain is a process with a store; the model is a library the planner and the studies call. So it lives between them, and every choice of the brain's it makes is core's, moved there from the brain in #260 (A5's work, A6's reach and decision, the city group, home RAM's price): what it runs is what the brain runs.

## The cycle model

```ts
import { runModel, RUN_3_CYCLES, RUN_3_POLICY, TODAYS_POLICY } from "@bitburner-agent/model";

const run = runModel({ currentNode: 1, ownedSF: { "1": 1 } }, { policy: TODAYS_POLICY });
run.cycles;        // each install: when, why, what, Daedalus's count, hacking, money, reputation and favour by faction
run.events;        // joins, installs, donations unlocked, the destroy
run.destroyedAtMs; // or null within the horizon (24 h)
// On run #3's own measured curves rather than the fitted one:
runModel({ currentNode: 1, ownedSF: { "1": 1 } }, { policy: RUN_3_POLICY, measured: RUN_3_CYCLES });
```

`runModel(start, { policy, calibration, measured, horizonMs, stepMs, onStep, onWork })` steps a BitNode a minute at a time from its start to its destroy, about 0.2 s a run locally (about 1 s on CI). Each step:

- **The level and the money** come from the fitted curve (`Curves`, below) at the multipliers installed (core's `installGains`, NeuroFlux Governor's levels each, and SF1's bonus), or from a measured cycle (`measured`, `measuredAt`).
- **The joins:** a hacker faction once the level reaches its server's (`HACKER_FACTION_JOINS`) and the money has bought the TOR router and its port openers; Tian Di Hui at hacking 50 and $1m; the city group by core's `cityGroupValues` and `chooseCityGroup` (owner decision 54) once the money covers its invitations; Daedalus with its count, hacking 2500 and $100b.
- **A5's work:** core's `factionWorkChoice`, at core's `factionReputationPerSecond` with the level, `faction_rep`, the favour and the cycle's share bonus, focused (owner decision 37). **Every other joined faction gains passive reputation** (core's `passiveFactionReputationPerSecond`, the game's `processPassiveFactionRepGain`) (special factions aside, at the BitNode's `FactionPassiveRepGain`). In the model it tips A5's ties between two factions selling the same augmentation toward the one joined longer: NiteSec over BitRunners in cycles 3 and 4, as run #3 worked.
- **A6:** core's `augmentationShops`, `augmentationEndgame` (A8's The Red Pill, "Daedalus donations" and the holds) and `installJudgement` (`affordableCounts` and `installRule`) on the set the money covers (`chooseAugmentationsToBuy` with `donationTermsOf`), and #243's hold (`countHoldOf`: `daedalusCountHold` with `countablesToCome` over `augmentationShops`, its rate without the share's bonus, as the brain's). The 90 s countdown (30 s for a quick install) runs before an install, at most a minute late at a minute's step.
- **An install** banks each faction's favour (`favorAfterInstall`), installs the set and the levels, keeps home's RAM (doubled while the cycle's money covers each upgrade, core's `homeRamUpgradePrice`), and starts the next cycle with nothing joined.
- **The destroy:** The Red Pill installed and the level at w0r1d_d43m0n's 3000.

What it leaves out: the money the brain spends through a cycle (cloud servers, home RAM): its money is the cycle's hacking income; the time the backdoors and the travels take; combat, charisma and companies; the gang, Bladeburners and every BitNode's curves but BN1's.

### Policies

A `CyclePolicy` is what the planner varies (architecture §4.5.3): `daedalusCountHold` (#243), `favourGrind(view)` (a joined faction to work for toward the favour that unlocks its donations, in place of A5's choice; one not joined, or with that reputation earned, leaves A5's), and `install(view, brainsReason)` (whether to install now; never asked about The Red Pill, never installs nothing). `TODAYS_POLICY` is the brain on main; `RUN_3_POLICY` is run #3's brain (main 7c741cc), before #243's hold. On run #3's path the two are the same: the model's 7th install takes the count from 25 to 34, so no install leaves it one short.

## The calibration

`src/calibration.ts`; a sweep overrides any of it through `calibration`. The model's money and hacking level are **inputs measured from run #3** and fitted, so they validate nothing: what the checks test is the rules that run on them.

| | What | From |
|---|---|---|
| `RUN_3_CYCLES` | Run #3's BN1.2 cycles: the hacking level and the game's hacking income since the install (`moneySources.hacking`) at 5, 10, 15, 20, 30, 45, 60, 75, 90, 105 and 120 min and at each cycle's end. Measured. | [#260's comment](https://github.com/UnderMyBed/bitburner-agent/issues/260#issuecomment-6680681582), the coordinator's read-only extract |
| `referenceCycles` | Cycles 3 to 6, each divided by the multipliers the model runs it at (a test checks they're the model's own), through the game's skill formula (`hackingExpForLevel`): one curve at multiplier 1, their median a minute. Read to 120 min; past it, linear at the last slope (105 to 120 min), which the model's 5th cycle (133–138 min) uses. One curve, not a table a cycle, so a policy that changes the cycles' lengths still has one. Fitted. | `RUN_3_CYCLES` |
| `expPaceExponent` 0.5625, `moneyPaceExponent` 0.5 | Two clocks run the curve faster at a higher level and hacking speed (each operation's time is ∝ 1/((level + 50) × hacking_speed), `Hacking.ts:60-80`), to these powers. Fitted. | Run #3's level and income, cycles 1 to 6 (from the 7th the model's cycle is another than run #3's): mean error 11% on the level, ×1.8 on the money |
| `firstCycleSpeed` 0.8, `fullSpeedHomeRamGb` 256 | The pace of a cycle with home's RAM at 8 GB, against 256 GB or more, log-linear between. Fitted. | The same fit |
| `shareBonusByCycle` | Run #3's own share bonus a cycle (`RUN_3_SHARE_BONUS`, 1.07 to 1.55), by install index; past the 10th, the last. Measured, and chosen once a constant was seen to flip the 4th cycle (1.40 to BitRunners, 1.45 to NiteSec). By index, a policy that moves the installs gets another cycle's share (#263: the share from the state). | The coordinator's per-cycle table |
| `HACKER_FACTION_JOINS` | Each hacker faction's server's level, the top of the game's range, checked against `servers.ts`. The game's. | `Server/data/servers.ts:1430-1517` |

## The validation

`test/validation.test.ts`, from figures the issues and the reviews state (`test/fixtures.ts`), never a store. Each check is labelled for what it can show; the tolerance is in brackets.

**Independent: the simulator's fresh BN1.1** (seed 1, main 412d97b), on the curve fitted to BN1.2. Installs at 47 and 114 min (3 and 4 installed) against about 57 and 122 [20%: #260 asked 15%, which the first install misses, 18% early], hacking 307 and 496 at them against 290 and 497 [15%], none more by 200 min.

**Downstream: the rules on run #3's own measured curves, cycles 1 to 6** (the fitted curve gives the same within a few percent). These share inputs with what they check: the rate is the level times the share, the count and the favour turn on the money and the cycle's length, the measured curves restart at run #3's truth each cycle, and cycle 4's share came in with its outcome in view. So they check the rules' mechanism, not the model's predictions. Model (run #3):

| Cycle | Worked most | Count [one] | Favour after [20% or 2] | Reputation there [25%] | Rate a second [16%] | Length, min [35%] |
|---|---|---|---|---|---|---|
| 1 | CyberSec ✓ | 3 (3) | 4.1 (5.04) | −17% | −14% | 36 (39.5), −9% |
| 2 | CyberSec ✓ | 4 (5) | 19.5 (22.54) | −15% | −15% | 53 (56.6), −6% |
| 3 | CyberSec, then NiteSec (NiteSec) | 10 (10) | NiteSec 31.0 (37.65) | −23% | +14% | 95 (75.6), +26% |
| 4 | NiteSec ✓ | 16 (17) | 66.5 (71.88) | −5% | 0% | 92 (95.7), −4% |
| 5 | BitRunners ✓ | 20 (21) | 87.4 (96.01) | −17% | +1% | 133 (123.8), +7% |
| 6 | BitRunners ✓ | 25 (25) | 142.9 (150.38) | −11% | −8% | 114 (124.1), −8% |

- The miss: the model's 2nd cycle ends without Cranial Signal Processors Gen I (10,000 reputation at CyberSec), so its 3rd works CyberSec first; NiteSec is still a third of it or more.
- **A known bias: the reputation is low in all six cycles** (−5% to −23%), the rate −14% and −15% in cycles 1 and 2 even on run #3's own level and share. #263 diagnoses it.
- BitRunners' favour after the 4th install is about 2 (run #3's 4.76) [under 10]: the model doesn't grind it early.
- #244's first two phases: 276 min against 267, +3%; 247 against 248, 0% [15%].

**Fitted, so consistency only:** the fitted curve's level at each cycle's end, cycles 1 to 6 [15%]; the constants a local best of the fit, its error under a bound; the reference multipliers the model's own.

**Out of reach: run #3's cycles 7 to 10.** Run #3's 6th install came at 8 h 35 min with BitRunners' favour at 150.38, 0.38 over the threshold. The model's 6th comes earlier, at 143, so BitRunners' donations unlock at its 7th (9 h 46 min) and the rest diverges: the 7th install takes the count to 34 (run #3: 29). The likely cause: the money is the cycle's gross hacking income, not the cash in hand after the brain's cloud servers and home RAM. A test keeps the divergence in view.

## Not yet fit for #247

The model follows run #3's mechanism through cycle 6: the factions worked, the count, the favour. It isn't fit to compare policies for #247: BitRunners' donations unlock one install late, the reputation runs low, the share is looked up by install index, and long cycles are extrapolated. [#263](https://github.com/UnderMyBed/bitburner-agent/issues/263) (slice 2) takes these on (money from cash, the bias, the share from the state, a paired comparison); #247 runs after it.

`test/model.test.ts`: the calibration's consistency, the clocks, home's RAM, SF1's bonus, the favour banked by the game's formula, passive reputation and its BitNode multiplier, the joins' rules, each cycle's reputation from nothing, A6's "nothing left", The Red Pill's donation hold, #243's hold (`countHoldOf`), determinism, partial calibration, and the policies.
