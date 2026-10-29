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

`person` is `ns.getPlayer()`'s seven skills and its `faction_rep` multiplier (`WorkingPerson`); the intelligence bonus is `intelligenceBonus`, the hacking ceilings' (below). Two things are taken as 1: the share bonus (the brain runs no `share()`), and the BitNode's `FactionWorkRepGain`, exact in BN1 and the same for every faction and work type elsewhere, so only an ETA is off. `test/faction-work.test.ts` works each by hand and checks the constants and terms against the game's source; the brain's `faction-work-parity.test.ts` checks the rate against the engine's `ns.formulas.work.factionGains` for every work type, over people and favours that differ in every figure it reads.

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

## The batcher

Built in #204 (M4 phase A slice A7a): the maths of a batch (hack, weaken, grow, weaken), pure, so the in-game batcher ([ingame: the batcher](../ingame/README.md#the-batcher)) and the brain (#206) use the same functions. `src/batcher.ts`.

| Function | What |
|---|---|
| `growThreads(start, target, moneyMax, growthLog)` | The game's `numCycleForGrowthCorrected` (ServerHelpers.ts:90-199), line for line: the fewest whole grow threads from `start` to `target`. Checked against the engine's `formulas.hacking.growThreads` in the brain's parity test. |
| `batchThreads(target, player, hackThreads)` | A batch's whole threads at 1 core: the hack; weaken1 for its 0.002 a thread; grow back from a hack of `GROW_MARGIN` (1.1) times its share, for the share's rise with the hacking level before it lands; weaken2 for the grow's 0.004 a thread. |
| `operationTimeMs`, `landingOffsetMs`, `launchLeadMs`, `batchHoldsMs`, `batchOrders` | The timing: the operations land in order 20 ms apart (`BATCH_LANDING_GAP_MS`); each starts its time plus a lead before it lands (200 ms, plus what security at the bounds adds to its time); a batch's orders, weaken1 out first and the hack last. |
| `batchPeakRamGb`, `leastSpacingMs`, `batchPlan(target, player, ramGb)` | The plan: for each count of hack threads, the least spacing (at least 80 ms) at which batches' peak RAM (each operation's threads × RAM × ⌈its hold / the spacing⌉) fits; the most income wins. Never above the batcher ceiling, and above 60% of it on 100 GB to 1 TB in the tests. |
| `batchRamGb(hostsRamGb)`, `threadsThatFit`, `placeThreads(hosts, threads, ramGb)` | The RAM: each host's whole 1.8 GB threads, as `exec` counts them (NetscriptWorker.ts:110-117); an operation on the host with the least free RAM that holds it all, else split across the largest. |
| `batchBounds`, `isOutsideBounds`, `hackThreadsAtLaunch`, `isTargetPrepared`, `preparationWave` | The bounds batches in step keep their target within, over every batch still landing (money at least what 1.1× the largest share leaves, security at most the minimum plus the largest hack's or grow's rise), and whether what was seen is outside them; a batch's hack threads replanned when it goes out, so the share's rise with the hacking level over a weaken's time stays within the margin (a rising-level test shows it does, and that unreplanned it doesn't); a target at its minimum security and maximum money; the next wave preparing one on some RAM, weaken first. |
| `LandingWatch`, `parseLandingRecord`, `parseBatcherConfig`, `newBatcherHealth` | The checks on the landings (out of order, lost 10 s after their time; a record never expected, or a late hack's, moves nothing), the batcher's config and its health. |

The operation scripts' RAM (1.75, 1.8, 1.8 GB) are constants the ingame RAM test checks against `ram-budget.json`. `test/batcher.test.ts` works these by hand and over seeded sweeps.
