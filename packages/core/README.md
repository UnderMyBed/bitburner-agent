# @bitburner-agent/core

Shared model types, interfaces and game facts, imported by the brain, the in-game code and the simulator alike, so it has neither Node nor DOM types ([CONTRIBUTING](../../CONTRIBUTING.md#typescript-configs)). Everything is exported from `src/index.ts`. Game facts are checked against the pinned game (`vendor/bitburner-src`): names and constants against its source (`test/`), and the generated data below against its engine.

## Augmentations and factions

Built in #193 for the brain's faction and augmentation choices (M4 phase A, slices A5, A6 and A8).

### The data

Generated from the pinned game by the simulator's engine, never typed by hand: `node packages/sim/scripts/generate-game-data.ts` writes it ([sim: Generated game data](../sim/README.md#generated-game-data)), and `packages/sim/test/game-data.test.ts` fails if any entry differs from the engine's. After a game bump, rerun the generator.

- **`AUGMENTATIONS`** (`src/augmentation-data.ts`): every augmentation by name, in the game's order. Each has its base money cost and base reputation (`Infinity` for the three never sold), the factions that sell it, its prerequisites, its multipliers other than 1 (by the game's names: `hacking`, `faction_rep`, `hacking_money`, …), the game's `isSpecial`, and what an install gives (`startingMoney`, `programs`). Unstable Circadian Modulator's multipliers are drawn by the game's clock at each install, so it has none and `randomMultipliers: true`.
- **`AUGMENTATION_BITNODE_MULTIPLIERS`** (same file): each BitNode's `AugmentationMoneyCost`, `AugmentationRepCost` and `DaedalusAugsRequirement`, at level 1.
- **`FACTIONS`** (`src/faction-data.ts`): every faction by name, with its enemies, the work it offers, whether membership survives an install, and its invitation requirements in the form `ns.singularity.getFactionInviteRequirements` gives (`PlayerRequirement`), as in BN1 with nothing backdoored. Daedalus's augmentation count is the BitNode's (`daedalusAugmentationsRequired`), and a megacorp's company reputation is 3/4 once its server is backdoored.

### The rules

`src/augmentations.ts`, each the game's own (cited there), and equal to the engine's to the last bit for every augmentation in the parity suite's states:

| Function | What |
|---|---|
| `augmentationCost(name, state)` | Its price now: `{ money, reputation }`, the game's `getAugCost`. Money grows 1.9× (less SF11's discount) for each augmentation queued, Shadows of Anarchy's excepted; then the BitNode's multipliers. NeuroFlux Governor's money and reputation are also × 1.14 per level, installed and queued. Shadows of Anarchy's are × 7 and × 1.3 per one of theirs owned, with no BitNode multiplier. |
| `purchaseSequenceCost(names, state)` | Buying `names` in that order: each one's price at its turn, and the money in all. It throws on one the game wouldn't sell then: owned already, or a prerequisite missing. |
| `missingPrerequisites(name, state)` | Its prerequisites neither installed nor queued. |
| `augmentationsSoldBy(faction, bitNode)` | A faction's shop, without The Red Pill at Daedalus in BN15. A gang's faction, which sells nearly everything, isn't covered. |
| `augmentationBitNodeMultipliers(currentNode, ownedSF)` | The BitNode's multipliers on augmentations, from `resetInfo`, BN12's at its level. |
| `daedalusAugmentationsRequired(currentNode, ownedSF)` | The installed augmentations Daedalus's invitation needs. |

`state` is what the brain has: `installed` is `resetInfo.ownedAugs`; `queued` is the queued augmentations in order, one entry per NeuroFlux Governor level; `sourceFile11Level` is `resetInfo.ownedSF["11"] ?? 0` (the game has already applied the BitNode options' overrides); and `bitNodeMultipliers` is `augmentationBitNodeMultipliers(resetInfo.currentNode, resetInfo.ownedSF)`. An unknown augmentation, an SF11 level outside 0-3, or a multiplier not above 0 throws.
