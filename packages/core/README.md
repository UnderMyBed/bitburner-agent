# @bitburner-agent/core

Shared model types, interfaces and game facts, imported by the brain, the in-game code and the simulator alike, so it has neither Node nor DOM types ([CONTRIBUTING](../../CONTRIBUTING.md#typescript-configs)). Everything is exported from `src/index.ts`. Game facts are checked against the pinned game (`vendor/bitburner-src`): names and constants against its source (`test/`), and the generated data below against its engine.

## Augmentations and factions

Built in #193 for the brain's faction and augmentation choices (M4 phase A, slices A5, A6 and A8).

### The data

Generated from the pinned game by the simulator's engine, never typed by hand: `node packages/sim/scripts/generate-game-data.ts` writes it ([sim: Generated game data](../sim/README.md#generated-game-data)), and `packages/sim/test/game-data.test.ts` fails if any entry differs from the engine's. After a game bump, rerun the generator.

- **`AUGMENTATIONS`** (`src/augmentation-data.ts`): every augmentation by name, in the game's order. Each has its base money cost and base reputation (`Infinity` in both for BigD's Big ... Brain, and in reputation for violet Congruity Implant and Z.O.Ë.; no faction sells those three), the factions that sell it, its prerequisites, its multipliers other than 1 (by the game's names: `hacking`, `faction_rep`, `hacking_money`, …), the game's `isSpecial`, and what an install gives (`startingMoney`, `programs`). `isSpecial` keeps an augmentation out of a gang's shop, grafting and sleeves, not out of a faction's own shop: NeuroFlux Governor is special. Unstable Circadian Modulator's multipliers are drawn by the game's clock when the game loads and at each install and BitNode reset, so it has none and `randomMultipliers: true`.
- **`AUGMENTATION_BITNODE_MULTIPLIERS`** (same file): each BitNode's `AugmentationMoneyCost`, `AugmentationRepCost` and `DaedalusAugsRequirement`, at level 1.
- **`FACTIONS`** (`src/faction-data.ts`): every faction by name, with its enemies, the work it offers, whether membership survives an install, and its invitation requirements in the form `ns.singularity.getFactionInviteRequirements` gives (`PlayerRequirement`), as in BN1 with nothing backdoored. Daedalus's augmentation count is the BitNode's (`daedalusAugmentationsRequired`), and a megacorp's company reputation is 3/4 once its server is backdoored.

### The rules

`src/augmentations.ts`, each the game's own (cited there), and equal to the engine's to the last bit for every augmentation in the parity suite's states:

| Function | What |
|---|---|
| `augmentationCost(name, state)` | Its price now: `{ money, reputation }`, the game's `getAugCost`. Money grows 1.9× (less SF11's discount) for each augmentation queued, Shadows of Anarchy's excepted; then the BitNode's multipliers. NeuroFlux Governor's money and reputation are also × 1.14 per level, installed and queued. Shadows of Anarchy's are × 7 and × 1.3 per one of theirs owned, with no BitNode multiplier. |
| `purchaseSequenceCost(names, state)` | Buying `names` in that order: each one's price at its turn, and the money in all. It throws on one the game wouldn't sell then: owned already, sold by no faction, or a prerequisite missing. |
| `missingPrerequisites(name, state)` | Its prerequisites neither installed nor queued. |
| `augmentationsSoldBy(faction, bitNode, gangFaction)` | A faction's shop, without The Red Pill at Daedalus in BN15 (a darknet reward there). A gang's faction sells nearly everything, by a seeded draw this doesn't model, so asking for `gangFaction`'s shop throws; pass null with no gang. |
| `augmentationBitNodeMultipliers(currentNode, ownedSF)` | The BitNode's multipliers on augmentations, from `resetInfo`, BN12's at its level. |
| `daedalusAugmentationsRequired(currentNode, ownedSF)` | The installed augmentations Daedalus's invitation needs. |

`state` is what the brain has: `installed` is `resetInfo.ownedAugs`; `queued` is the queued augmentations in order, one entry per NeuroFlux Governor level; `sourceFile11Level` is `resetInfo.ownedSF["11"] ?? 0` (the game has already applied the BitNode options' overrides); and `bitNodeMultipliers` is `augmentationBitNodeMultipliers(resetInfo.currentNode, resetInfo.ownedSF)`. An unknown augmentation, an installed level that isn't a whole number from 1, an SF11 level outside 0-3, or a multiplier that isn't finite and above 0 throws.

### Faction work

`src/faction-work.ts` ([#203](https://github.com/UnderMyBed/bitburner-agent/issues/203)), for the brain's choice of which faction to work for, and how soon its next augmentation comes ([packages/brain](../brain/README.md#factions-and-their-work)):

| Function | What |
|---|---|
| `factionReputationPerCycle(person, workType, favor, sourceFile15Level)` | The reputation a cycle of hacking, field or security work earns, focused: the game's `calculateFactionRep` (`Work/Formulas.ts:82-89`, `PersonObjects/formulas/reputation.ts`). Hacking: (hacking + intelligence/3) / 975; field: 0.9 × (the five combat-and-charisma skills + hacking + intelligence) / 975 / 5.5; security: the same without charisma, / 4.5; each × `faction_rep` × the intelligence bonus × (1 + favour/100), and SF15.3's charisma terms. A figure that isn't finite throws. |
| `factionReputationPerSecond(person, workType, { favor, sourceFile15Level, focused, implant })` | Five cycles a second (`MilliPerCycle`, 200 ms), × 0.8 unfocused unless the Neuroreceptor Management Implant is installed (`focusPenalty`). |
| `hackingValue(augmentation)` | What it's worth to the brain's hacking: the natural logarithms of its `HACKING_MULTIPLIERS` (hacking, speed, money, growth, chance, experience, faction reputation) added up; 0 for one with none. |
| `intelligenceBonus(intelligence, weight)` | `calculateIntelligenceBonus`: 1 + weight × intelligence^0.8 / 600. |

`person` is `ns.getPlayer()`'s seven skills and its `faction_rep` multiplier (`WorkingPerson`). Two things are taken as 1: the share bonus (the brain runs no `share()`), and the BitNode's `FactionWorkRepGain`, exact in BN1 and the same for every faction and work type elsewhere, so only an ETA is off. `test/faction-work.test.ts` works each by hand and checks the constants and terms against the game's source; the brain's `faction-work-parity.test.ts` checks the rate against the engine's `ns.formulas.work.factionGains` for every work type, over people and favours that differ in every figure it reads.
