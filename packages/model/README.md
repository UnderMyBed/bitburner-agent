# @bitburner-agent/model

The fast model ([#13](https://github.com/UnderMyBed/bitburner-agent/issues/13), [architecture §4.3](../../docs/architecture.md#43-fast-model)): a pure, deterministic model of the game for the planner ([#14](https://github.com/UnderMyBed/bitburner-agent/issues/14)) to roll candidate policies forward on, far faster than the real-engine simulator (2–3× real time once the batcher fills the cloud servers, [#247](https://github.com/UnderMyBed/bitburner-agent/issues/247)). Pure like core (no Node, no DOM), and depending on core only: `core` ← `model` ← the planner.

> **Status:** first slice ([#260](https://github.com/UnderMyBed/bitburner-agent/issues/260)): BN1's cycles of reputation, favour and augmentations, validated on run #3. Not wired into the brain's choices ([owner decision 46](../../docs/decisions/owner-decisions.md): phase B replaces a choice only where it measurably beats it). #247 runs its comparison ("favour first or count first") on it next.

## Why a package of its own

Core is the game's facts and formulas, imported by the in-game code too; the model adds what isn't the game's: curves fitted to runs. The brain is a process with a store; the model is a library the planner and the studies call. So it lives between them, and the brain's own choices it needs were moved to core (#260), never copied: what it runs is what the brain runs.

## The cycle model

```ts
import { runModel, RUN_3_POLICY, TODAYS_POLICY } from "@bitburner-agent/model";

const run = runModel({ currentNode: 1, ownedSF: { "1": 1 } }, { policy: TODAYS_POLICY });
run.cycles;        // each install: when, why, what, Daedalus's count, hacking, money, reputation and favour by faction
run.events;        // joins, installs, donations unlocked, the destroy
run.destroyedAtMs; // or null within the horizon (24 h)
```

`runModel(start, { policy, calibration, horizonMs, stepMs, onStep })` steps a BitNode a minute at a time from its start to its destroy, about 0.2 s a run. Each step:

- **The level and the money** come from the calibrated curves (`Curves`, below), at the multipliers installed (core's `installGains`, NeuroFlux Governor's levels each, and SF1's bonus, `sourceFile1Bonus`).
- **The joins:** a hacker faction once the level reaches its server's (`HACKER_FACTION_JOINS`) and the money has bought the TOR router and its port openers; Tian Di Hui at hacking 50 and $1m; the city group by core's `cityGroupValues` and `chooseCityGroup` (owner decision 54) once the money covers its invitations; Daedalus with its count, hacking 2500 and $100b.
- **A5's work:** core's `factionWorkChoice` (The Red Pill first, the most hacking value a second of work, toward donations' favour, Daedalus's count, an install held for it), at core's `factionReputationPerSecond` with the level, `faction_rep`, the favour and the share bonus. The work is focused (owner decision 37).
- **A6:** the set the money covers (`chooseAugmentationsToBuy`, with the donations' terms of `donationTermsOf`), the counts with NeuroFlux Governor's levels (`affordableCounts`), the count rule (`installRule`), #243's hold (`daedalusCountHold` with `countablesToCome`), and A8's endgame: The Red Pill installed at once, "Daedalus donations" once Daedalus's reputation unlocks its donations (`redPillTarget`), and the holds for Daedalus's money and The Red Pill's reputation. The 90 s countdown (30 s for a quick install) runs before an install.
- **An install** banks each faction's favour (`favorAfterInstall`), installs the set and the levels, keeps home's RAM (doubled while the cycle's money covers each upgrade, core's `homeRamUpgradePrice`), and starts the next cycle with nothing joined.
- **The destroy:** The Red Pill installed and the level at w0r1d_d43m0n's 3000.

What it leaves out: passive reputation; the time the backdoors and the travels take; combat, charisma and companies; the gang, Bladeburners and every BitNode but BN1's multipliers on augmentations and faction work (the model takes any BitNode core knows, but the curves are BN1's).

### Policies

A `CyclePolicy` is what the planner varies (architecture §4.5.3): `daedalusCountHold` (#243), `favourGrind(view)` (a joined faction to work for toward the favour that unlocks its donations, in place of A5's choice), and `install(view, brainsReason)` (whether to install now; never asked about The Red Pill, never installs nothing). `TODAYS_POLICY` is the brain on main; `RUN_3_POLICY` is run #3's brain (main 7c741cc), before #243's hold.

## The calibration

`src/calibration.ts`, each constant citing its source; the sensitivity sweeps (#247) override any of it through `calibration`.

| | What | From |
|---|---|---|
| `SIMULATOR_CYCLES` | The simulator's first three cycles, hacking and money every 5 minutes. The third is the reference curve: its levels through the game's skill formula (`hackingExpForLevel`) and its money, each at multiplier 1 (`reference`, the multipliers the model itself installs before it, checked by a test). | #247's feasibility probe (seed 1, main 412d97b) |
| `advanceClocks` | Two clocks run through the reference cycle: a cycle at a higher level and hacking speed runs it faster, as each operation's time is ∝ 1/((level + 50) × hacking_speed) (`Hacking.ts:60-80`). The experience at that full pace (`expPaceExponent` 1, the formula's, not fitted); the money at its 0.25th power (`moneyPaceExponent`, fitted), as the targets' own money bounds it. | the game's formulas; run #3's late cycles |
| `firstCycleSpeed` | 0.75: a cycle's economy with home's RAM at 8 GB, against 1 TB or more. | the simulator's installs at 57 and 122 min |
| `shareBonus` | 1.45 while working, about 76,000 share threads. | run #3's BitRunners rep/s, 22 at favour 4.8 and 52.7 at 96 |
| `HACKER_FACTION_JOINS` | Each hacker faction's server's level, the top of the game's range. | `Server/data/servers.ts:1430-1517` |

The sensitivity (`calibration` overridden one at a time, run #3's total): `firstCycleSpeed` 0.6 or 0.9, ±1%; `shareBonus` 1.3, +3%, 1.6, −7%, 1 (no share), +43%; `moneyPaceExponent` 0, +6% (9 installs), 0.5, −5% (12, four of them quick), 1, −13% (16). The phases can move more than the total: a calibration that changes how many installs a phase takes moves the phases' boundaries.

## The validation

`test/validation.test.ts`, from the figures the issues state (`test/fixtures.ts`), never a store:

| Run #3's BN1.2 (#244's table) | Run #3 | Model | |
|---|---|---|---|
| Count 0 → 17, 4 installs | 4 h 27 min | 4 h 36 min | +3% |
| BitRunners favour 5 → 150, 2 installs | 4 h 08 min | 4 h 04 min | −2% |
| Donations to BitRunners, count 25 → 30, 2 installs | 59 min | 54 min | −8% |
| Daedalus favour 0 → 150, 1 install | 82 min | 83 min | +1% |
| The donation, The Red Pill, the destroy | 21 min | 19 min | −10% |
| **Start to destroy** | **11 h 17 min** | **11 h 16 min** | **−0%** |

Each phase within 15%, as #260 asks, and each ends as run #3's did: BitRunners' donations unlocked at the 6th install, "Daedalus donations" the 9th, The Red Pill the 10th. Daedalus's count: 26 after the 6th install (run #3 25), 29 after the 7th (29; three of run #3's four augmentations, the fourth bought an install earlier), 33 after the 8th (30). Where the model's path differs: its count is 15 after the 4th install (run #3's 17), and BitRunners' favour is 68 by then (run #3's 4.8), as the model works BitRunners for its augmentations from its join in the 3rd cycle, where run #3 worked CyberSec, Tian Di Hui and NiteSec for the count. The phases' times hold all the same.

The simulator's first three cycles: installs at 54 min (3 installed) and 122 min (4), none by 200 min, against about 57 and 122; hacking 229 and 488 at the installs (290 and 497: the first cycle's level ramps slower in the model, its money faster, so its tolerance is 25%), 626 at 200 min (616).

`test/model.test.ts`: the calibration's consistency (the reference multipliers, the share bonus against run #3's rates, the curves giving back the reference cycle), the clocks, home's RAM, SF1's bonus, the favour banked by the game's formula, determinism, and the policies.
