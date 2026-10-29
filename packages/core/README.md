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

## The hacking ceilings

Built in #196 (M4 phase A slice A1): "how good is our hacking" as a number. `src/hacking-ceiling.ts`; the brain applies them to the snapshots ([brain: the hacking ceiling](../brain/README.md#the-hacking-ceiling)).

| Function | What |
|---|---|
| `hackChance(server, player)` | The game's `calculateHackingChance` (Hacking.ts:9-24), on a rooted server. |
| `hackTimeSeconds(server, player)` | The game's `calculateHackingTime` (Hacking.ts:60-80); a grow takes `GROW_TIME_PER_HACK_TIME` (3.2) of it, a weaken `WEAKEN_TIME_PER_HACK_TIME` (4). |
| `intelligenceBonus(intelligence)`, `coreBonus(cores)` | The game's (intelligence.ts:1-3, ServerHelpers.ts:287-290). |
| `hackingIncomePerGigabyteSecond(target, player, cores)` | The hacking ceiling: the most $ a GB-second of RAM can earn on `target`, by any hacker, as the limit of a batch's share going to 0. Nothing passes it. |
| `batcherIncomePerGigabyteSecond(target, player, cores)` | The batcher ceiling: the same with grow and weaken paid for failed hacks too, as a batcher (HWGW) commits them first. The score the batcher (A7) is judged on. |
| `usableRamGb(ramGb)` | A host's RAM in whole threads: floor(RAM/1.7) at 1.75 GB each, at most its RAM. |

With `percentMoneyHackedPerThread` and `growthLogPerThread` (`src/hack-loop.ts`, #187), and the script RAM (1.7, 1.75, 1.75 GB) and security a thread (0.002, 0.004, 0.05) as constants. BitNode multipliers are taken as 1: exact in BN1, high elsewhere (the safe side) but for BN11's weaken rate. `test/hacking-ceiling.test.ts` works them by hand, and the brain's `hacking-ceiling-parity.test.ts` checks them against the engine's `ns.formulas.hacking`.
