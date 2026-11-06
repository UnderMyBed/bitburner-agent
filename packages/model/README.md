# @bitburner-agent/model

The fast model ([#13](https://github.com/UnderMyBed/bitburner-agent/issues/13), [architecture §4.3](../../docs/architecture.md#43-fast-model)): a pure, deterministic model of the game for the planner ([#14](https://github.com/UnderMyBed/bitburner-agent/issues/14)) to roll candidate policies forward on, far faster than the real-engine simulator (2–3× real time once the batcher fills the cloud servers, [#247](https://github.com/UnderMyBed/bitburner-agent/issues/247)). Pure like core (no Node, no DOM), and depending on core only: `core` ← `model` ← the planner.

> **Status:** first slice ([#260](https://github.com/UnderMyBed/bitburner-agent/issues/260)): BN1's cycles of reputation, favour and augmentations. **In reach: run #3's cycles 1 to 6**, up to BitRunners' donations, #247's question. Cycles 7 to 10 diverge (below). Not wired into the brain's choices ([owner decision 46](../../docs/decisions/owner-decisions.md)).

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

`runModel(start, { policy, calibration, measured, horizonMs, stepMs, onStep, onWork })` steps a BitNode a minute at a time from its start to its destroy, about 0.2 s a run. Each step:

- **The level and the money** come from the fitted curve (`Curves`, below) at the multipliers installed (core's `installGains`, NeuroFlux Governor's levels each, and SF1's bonus), or from a measured cycle (`measured`, `measuredAt`).
- **The joins:** a hacker faction once the level reaches its server's (`HACKER_FACTION_JOINS`) and the money has bought the TOR router and its port openers; Tian Di Hui at hacking 50 and $1m; the city group by core's `cityGroupValues` and `chooseCityGroup` (owner decision 54) once the money covers its invitations; Daedalus with its count, hacking 2500 and $100b.
- **A5's work:** core's `factionWorkChoice`, at core's `factionReputationPerSecond` with the level, `faction_rep`, the favour and the cycle's share bonus, focused (owner decision 37). **Every other joined faction gains passive reputation** (core's `passiveFactionReputationPerSecond`, the game's `processPassiveFactionRepGain`): it breaks A5's ties between two factions selling the same augmentation toward the one joined longer, which is why run #3 worked NiteSec, not BitRunners, in its 3rd and 4th cycles.
- **A6:** core's `augmentationShops`, `augmentationEndgame` (A8's The Red Pill, "Daedalus donations" and the holds) and `installJudgement` (`affordableCounts` and `installRule`) on the set the money covers (`chooseAugmentationsToBuy` with `donationTermsOf`), and #243's hold (`daedalusCountHold` with `countablesToCome`, its rate without the share's bonus, as the brain's). The 90 s countdown (30 s for a quick install) runs before an install, at most a minute late at a minute's step.
- **An install** banks each faction's favour (`favorAfterInstall`), installs the set and the levels, keeps home's RAM (doubled while the cycle's money covers each upgrade, core's `homeRamUpgradePrice`), and starts the next cycle with nothing joined.
- **The destroy:** The Red Pill installed and the level at w0r1d_d43m0n's 3000.

What it leaves out: the money the brain spends through a cycle (cloud servers, home RAM): its money is the cycle's hacking income; the time the backdoors and the travels take; combat, charisma and companies; the gang, Bladeburners and every BitNode's curves but BN1's.

### Policies

A `CyclePolicy` is what the planner varies (architecture §4.5.3): `daedalusCountHold` (#243), `favourGrind(view)` (a joined faction to work for toward the favour that unlocks its donations, in place of A5's choice; one not joined, or with that reputation earned, leaves A5's), and `install(view, brainsReason)` (whether to install now; never asked about The Red Pill, never installs nothing). `TODAYS_POLICY` is the brain on main; `RUN_3_POLICY` is run #3's brain (main 7c741cc), before #243's hold. On run #3's path the two are the same: the model's 7th install takes the count from 25 to 34, so no install leaves it one short.

## The calibration: fitted, all of it

`src/calibration.ts`; the sensitivity sweeps override any of it through `calibration`. The model's money and hacking are **inputs measured from run #3**, so they validate nothing: what's under test is the rules that run on them.

| | What | From |
|---|---|---|
| `RUN_3_CYCLES` | Run #3's BN1.2 cycles: the hacking level and the game's hacking income since the install (`moneySources.hacking`) at 5, 10, 15, 20, 30, 45, 60, 75, 90, 105 and 120 min and at each cycle's end. | The coordinator's read-only extract from the store (#262's review) |
| `referenceCycles` | Cycles 3 to 6, each divided by the multipliers the model runs it at (a test checks they're the model's own), through the game's skill formula (`hackingExpForLevel`): one curve at multiplier 1, their median a minute. A curve, not a table a cycle, so a policy that makes cycles longer or shorter (#247) still has one. | `RUN_3_CYCLES` |
| `expPaceExponent` 0.5, `moneyPaceExponent` 0.375 | Two clocks run the curve faster at a higher level and hacking speed, as each operation's time is ∝ 1/((level + 50) × hacking_speed) (`Hacking.ts:60-80`), to these powers. Fitted: the experience carries the RAM's growth, which the money pays for, and the money is bounded by the targets'. | Fitted to `RUN_3_CYCLES`' level and income, cycles 1 to 10: mean error 13% on the level, ×3 on the money (which spans 12 orders of magnitude in a cycle) |
| `firstCycleSpeed` 0.65, `fullSpeedHomeRamGb` 256 | The pace of a cycle with home's RAM at 8 GB, against 256 GB or more, log-linear between. | The same fit |
| `shareBonusByCycle` | Run #3's own share bonus a cycle (`RUN_3_SHARE_BONUS`, 1.07 to 1.55); past the 10th, the last. A constant flipped the 4th cycle: 1.40 sent its work to BitRunners, 1.45 to NiteSec. | The coordinator's per-cycle table |
| `HACKER_FACTION_JOINS` | Each hacker faction's server's level, the top of the game's range, checked against `servers.ts`. | `Server/data/servers.ts:1430-1517` |

## The validation

`test/validation.test.ts`, from figures the issues and the review state (`test/fixtures.ts`), never a store.

**Independent: the rules on run #3's own curves (`measured`), cycles 1 to 6** (the fitted curve gives the same within a few percent). Model (run #3):

| Cycle | Worked most | Count | Favour after | Reputation there | Rate a second | Length, min (partly downstream) |
|---|---|---|---|---|---|---|
| 1 | CyberSec ✓ | 3 (3) | 4.1 (5.04) | −17% | −14% | 36 (39.5), −9% |
| 2 | CyberSec ✓ | 4 (5) | 19.5 (22.54) | −15% | −15% | 53 (56.6), −6% |
| 3 | CyberSec, then NiteSec (NiteSec) | 10 (10) | NiteSec 31.0 (37.65) | −23% | +14% | 95 (75.6), +26% |
| 4 | NiteSec ✓ | 16 (17) | 66.5 (71.88) | −5% | 0% | 92 (95.7), −4% |
| 5 | BitRunners ✓ | 20 (21) | 87.4 (96.01) | −17% | +1% | 133 (123.8), +7% |
| 6 | BitRunners ✓ | 25 (25) | 142.9 (150.38) | −11% | −8% | 114 (124.1), −8% |

The tests' tolerances: the faction worked most exactly, but for the known miss in cycle 3 (the model's 2nd cycle ends without Cranial Signal Processors Gen I, 10,000 reputation at CyberSec, so its 3rd works CyberSec first; NiteSec still a third of it or more); the count within one; the favour within 20% or 2 points; the reputation within 30%; the rate within 20%; BitRunners' favour after the 4th install under 10 (about 2; run #3's 4.76); the lengths within 35%; #244's first two phases within 15% (276 min against 267, +3%; 247 against 248, 0%).

**Independent: the simulator's fresh BN1.1** (seed 1, main 412d97b), on the curve fitted to BN1.2: installs at 50 and 112 min (3 and 4 installed) against about 57 and 122, hacking 289 and 488 at them against 290 and 497, none more by 200 min.

**Fitted, so consistency only:** the fitted curve's level within 15% of run #3's at each cycle's end, cycles 1 to 6; the reference multipliers the model's own.

**Out of reach: run #3's cycles 7 to 10.** Run #3's 6th install came at 124 min with BitRunners' favour at 150.38, 0.38 over the threshold; the model's comes 10 minutes earlier on run #3's own curves (19 on the fitted one), at 143, so BitRunners' donations unlock an install later and the rest diverges: the 7th install takes the count to 34 (run #3: 29), and the Daedalus cycle comes a cycle late. The destroy lands at 11 h 40 min on the measured curves and 11 h 46 min on the fitted (run #3: 11 h 17 min), but that agreement means little. Likely cause: the money is the cycle's hacking income, not the money in hand; the brain spends through a cycle on cloud servers and home RAM, so the model affords its NeuroFlux Governor levels sooner. A test keeps the divergence in view (BitRunners' favour after the 6th install between 140 and 150).

## Sensitivity, and what #247 may conclude

`calibration` overridden one at a time (each cycle's share ×0.95 and ×1.05; each pace exponent ±0.125; `firstCycleSpeed` ±0.1), run #3's policy: BitRunners' donations unlock at 9 h 46 min [9 h 25 min – 9 h 52 min], the 6th install at 8 h 43 min [8 h 24 min – 8 h 48 min], the destroy at 11 h 46 min [11 h 21 min – 12 h 27 min]; the 4th cycle works NiteSec throughout. A naive "favour first" (grinding BitRunners from its join) unlocks them at 10 h 27 min [9 h 45 min – 10 h 49 min].

**A policy's difference counts only where it exceeds this spread**: its range across the grid clear of the other's. "Favour first" against run #3's policy doesn't clear it (9 h 45 min against 9 h 52 min). And past the 6th install nothing does: the model is out of reach there.

`test/model.test.ts`: the calibration's consistency, the clocks, home's RAM, SF1's bonus, the favour banked by the game's formula, passive reputation, the joins' rules, A6's "nothing left" and The Red Pill's donation hold, determinism, partial calibration, and the policies.
