/**
 * The game's augmentations (#149): their names (`Augmentation/Enums.ts`, `AugmentationName`), for the
 * `purchaseAugmentation` intent. NeuroFlux Governor is the one that can be bought again: each purchase is a level
 * (`Augmentation/Augmentation.ts`, `getLevel`). Shared by the in-game code and the brain; plain literals, as in
 * factions.ts. And (#193) every augmentation's data, generated from the engine into augmentation-data.ts, with the
 * game's price rules.
 */
import { AUGMENTATION_BITNODE_MULTIPLIERS, AUGMENTATIONS } from "./augmentation-data.ts";

/** Every augmentation, by the name the game uses. */
export const AUGMENTATION_NAMES = [
  "NeuroFlux Governor",
  "Augmented Targeting I",
  "Augmented Targeting II",
  "Augmented Targeting III",
  "Synthetic Heart",
  "Synfibril Muscle",
  "Combat Rib I",
  "Combat Rib II",
  "Combat Rib III",
  "Nanofiber Weave",
  "NEMEAN Subdermal Weave",
  "Wired Reflexes",
  "Graphene Bone Lacings",
  "Bionic Spine",
  "Graphene Bionic Spine Upgrade",
  "Bionic Legs",
  "Graphene Bionic Legs Upgrade",
  "Speech Processor Implant",
  "TITN-41 Gene-Modification Injection",
  "Enhanced Social Interaction Implant",
  "BitWire",
  "Artificial Bio-neural Network Implant",
  "Artificial Synaptic Potentiation",
  "Enhanced Myelin Sheathing",
  "Synaptic Enhancement Implant",
  "Neural-Retention Enhancement",
  "DataJack",
  "Embedded Netburner Module",
  "Embedded Netburner Module Core Implant",
  "Embedded Netburner Module Core V2 Upgrade",
  "Embedded Netburner Module Core V3 Upgrade",
  "Embedded Netburner Module Analyze Engine",
  "Embedded Netburner Module Direct Memory Access Upgrade",
  "Neuralstimulator",
  "Neural Accelerator",
  "Cranial Signal Processors - Gen I",
  "Cranial Signal Processors - Gen II",
  "Cranial Signal Processors - Gen III",
  "Cranial Signal Processors - Gen IV",
  "Cranial Signal Processors - Gen V",
  "Neuronal Densification",
  "Neuroreceptor Management Implant",
  "Nuoptimal Nootropic Injector Implant",
  "Speech Enhancement",
  "FocusWire",
  "PC Direct-Neural Interface",
  "PC Direct-Neural Interface Optimization Submodule",
  "PC Direct-Neural Interface NeuroNet Injector",
  "PCMatrix",
  "ADR-V1 Pheromone Gene",
  "ADR-V2 Pheromone Gene",
  "The Shadow's Simulacrum",
  "Hacknet Node CPU Architecture Neural-Upload",
  "Hacknet Node Cache Architecture Neural-Upload",
  "Hacknet Node NIC Architecture Neural-Upload",
  "Hacknet Node Kernel Direct-Neural Interface",
  "Hacknet Node Core Direct-Neural Interface",
  "Neurotrainer I",
  "Neurotrainer II",
  "Neurotrainer III",
  "HyperSight Corneal Implant",
  "LuminCloaking-V1 Skin Implant",
  "LuminCloaking-V2 Skin Implant",
  "HemoRecirculator",
  "SmartSonar Implant",
  "Power Recirculation Core",
  "QLink",
  "The Red Pill",
  "SPTN-97 Gene Modification",
  "ECorp HVMind Implant",
  "CordiARC Fusion Reactor",
  "SmartJaw",
  "Neotra",
  "Xanipher",
  "nextSENS Gene Modification",
  "OmniTek InfoLoad",
  "Photosynthetic Cells",
  "BitRunners Neurolink",
  "The Black Hand",
  "Unstable Circadian Modulator",
  "CRTX42-AA Gene Modification",
  "Neuregen Gene Modification",
  "CashRoot Starter Kit",
  "NutriGen Implant",
  "INFRARET Enhancement",
  "DermaForce Particle Barrier",
  "Graphene BrachiBlades Upgrade",
  "Graphene Bionic Arms Upgrade",
  "BrachiBlades",
  "Bionic Arms",
  "Social Negotiation Assistant (S.N.A)",
  "violet Congruity Implant",
  "Hydroflame Left Arm",
  "BigD's Big ... Brain",
  "Z.O.Ë.",
  "Eloquence Module",
  "Golden Tongue Module",
  "Glibness Enhancement",
  "Magnetism Amplifier",
  "The Illustrated Primer",
  "Social Dynamics Processor",
  "Neural Wit Amplifier",
  "EsperTech Bladeburner Eyewear",
  "EMS-4 Recombination",
  "ORION-MKIV Shoulder",
  "Hyperion Plasma Cannon V1",
  "Hyperion Plasma Cannon V2",
  "GOLEM Serum",
  "Vangelis Virus",
  "Vangelis Virus 3.0",
  "I.N.T.E.R.L.I.N.K.E.D",
  "Blade's Runners",
  "BLADE-51b Tesla Armor",
  "BLADE-51b Tesla Armor: Power Cells Upgrade",
  "BLADE-51b Tesla Armor: Energy Shielding Upgrade",
  "BLADE-51b Tesla Armor: Unibeam Upgrade",
  "BLADE-51b Tesla Armor: Omnibeam Upgrade",
  "BLADE-51b Tesla Armor: IPU Upgrade",
  "The Blade's Simulacrum",
  "Stanek's Gift - Genesis",
  "Stanek's Gift - Awakening",
  "Stanek's Gift - Serenity",
  "The W1ngs of Icarus",
  "The B00ts of Perseus",
  "The St4ff of Asclepius",
  "The H4mmer of Daedalus",
  "The L4w of Bayes",
  "The B1ade of Solomonoff",
  "SoA - Might of Ares",
  "SoA - Wisdom of Athena",
  "SoA - Trickery of Hermes",
  "SoA - Beauty of Aphrodite",
  "SoA - Chaos of Dionysus",
  "SoA - Flood of Poseidon",
  "SoA - Hunt of Artemis",
  "SoA - Knowledge of Apollo",
  "SoA - phyzical WKS harmonizer",
];

/** The augmentation bought again and again, a level each time. */
export const NEUROFLUX_GOVERNOR = "NeuroFlux Governor";

/**
 * NeuroFlux Governor's level, as the game counts it (`Augmentation/Augmentation.ts`, `getLevel`): the installed level
 * (`getResetInfo().ownedAugs`) plus one per queued copy. `ownedNames` is `getOwnedAugmentations(true)`: the installed
 * once, then each queued copy.
 */
export function neuroFluxLevel(installedLevel: number, ownedNames: readonly string[]): number {
  const copies = ownedNames.filter((name) => name === NEUROFLUX_GOVERNOR).length;
  return installedLevel + copies - (installedLevel > 0 ? 1 : 0);
}

/**
 * An augmentation, as the pinned game defines it (#193, `Augmentation/Augmentation.ts:173-226`): `AUGMENTATIONS`, in
 * augmentation-data.ts, generated from the simulator's engine (`packages/sim/scripts/generate-game-data.ts`).
 */
export interface AugmentationData {
  /** `baseCost`: the money before any multiplier. Infinity for one never sold. */
  baseMoneyCost: number;
  /** `baseRepRequirement`: the faction reputation before any multiplier. Infinity for one never sold. */
  baseRepCost: number;
  /** The factions that sell it (a gang's faction sells nearly all, which this doesn't cover). */
  factions: readonly string[];
  /** Each must be installed or queued before it can be bought (`FactionHelpers.tsx:56-58,88-95`). */
  prereqs: readonly string[];
  /** Its multipliers that aren't 1, by the game's names (`hacking`, `faction_rep`, `hacking_money`, …). */
  multipliers: Readonly<Record<string, number>>;
  /** The game's `isSpecial`: not in BN1's shops as such (Bladeburner's, Stanek's, SoA's, NeuroFlux Governor, …). */
  isSpecial: boolean;
  /** What an install of it gives: money, and programs (`Prestige.ts`). */
  startingMoney: number;
  programs: readonly string[];
  /**
   * Unstable Circadian Modulator's: one of seven sets drawn by the game's clock, again at each install
   * (`Augmentation/CircadianModulator.ts:113`, `Prestige.ts:119`), so `multipliers` is empty.
   */
  randomMultipliers?: true;
}

/** The BitNode multipliers on augmentations (`BitNode/BitNodeMultipliers.ts`), by the game's names. */
export interface AugmentationBitNodeMultipliers {
  AugmentationMoneyCost: number;
  AugmentationRepCost: number;
  /** The installed augmentations Daedalus's invitation needs (`Faction/FactionInfo.tsx:142`). */
  DaedalusAugsRequirement: number;
}

/** The price's growth with each augmentation queued: `MultipleAugMultiplier` (`Constants.ts:41`). */
export const AUGMENTATION_PRICE_GROWTH = 1.9;
/** SF11's discount on that growth, by its level 0-3 (`AugmentationHelpers.ts:29-31`). */
export const SOURCE_FILE_11_PRICE_GROWTH_DISCOUNT = [1, 0.96, 0.94, 0.93] as const;
/** NeuroFlux Governor's money and reputation growth per level: `NeuroFluxGovernorLevelMult` (`Constants.ts:36`). */
export const NEUROFLUX_LEVEL_GROWTH = 1.14;
/** Shadows of Anarchy's money and reputation growth per one of theirs owned: `SoACostMult`, `SoARepMult`. */
export const SHADOWS_OF_ANARCHY_MONEY_GROWTH = 7;
export const SHADOWS_OF_ANARCHY_REPUTATION_GROWTH = 1.3;
/** Shadows of Anarchy's augmentations (`AugmentationHelpers.ts:17-27`): priced apart, and not counted as queued. */
export const SHADOWS_OF_ANARCHY_AUGMENTATIONS = [
  "SoA - Beauty of Aphrodite",
  "SoA - Chaos of Dionysus",
  "SoA - Flood of Poseidon",
  "SoA - Hunt of Artemis",
  "SoA - Knowledge of Apollo",
  "SoA - Might of Ares",
  "SoA - Trickery of Hermes",
  "SoA - phyzical WKS harmonizer",
  "SoA - Wisdom of Athena",
];

/** What an augmentation's price depends on: what the brain sees of the run (#193). */
export interface AugmentationPurchaseState {
  /** Installed augmentation → level: `resetInfo.ownedAugs` (NeuroFlux Governor once, at its level). */
  installed: Readonly<Record<string, number>>;
  /** Bought and not installed, in order: one entry per purchase, so NeuroFlux Governor once per level. */
  queued: readonly string[];
  /** The active SF11 level, 0-3: `resetInfo.ownedSF["11"]`, which has the BitNode options' overrides applied. */
  sourceFile11Level: number;
  /** The BitNode's cost multipliers: `augmentationBitNodeMultipliers`. */
  bitNodeMultipliers: Pick<AugmentationBitNodeMultipliers, "AugmentationMoneyCost" | "AugmentationRepCost">;
}

/** An augmentation's price: the money it costs, and the faction reputation it needs (which isn't spent). */
export interface AugmentationCost {
  money: number;
  reputation: number;
}

function augmentationData(name: string): AugmentationData {
  if (!Object.hasOwn(AUGMENTATIONS, name)) throw new RangeError(`no augmentation ${JSON.stringify(name)}`);
  return AUGMENTATIONS[name] as AugmentationData;
}

/**
 * The price's growth with each augmentation queued: 1.9, less SF11's discount (`getBaseAugmentationPriceMultiplier`,
 * `AugmentationHelpers.ts:29-31`). A level outside 0-3 throws: the game would index past its table.
 */
export function augmentationPriceGrowth(sourceFile11Level: number): number {
  const discount = SOURCE_FILE_11_PRICE_GROWTH_DISCOUNT[sourceFile11Level];
  if (!Number.isInteger(sourceFile11Level) || discount === undefined) {
    throw new RangeError(`the SF11 level must be 0, 1, 2 or 3, not ${sourceFile11Level}`);
  }
  return AUGMENTATION_PRICE_GROWTH * discount;
}

function checkState(state: AugmentationPurchaseState): void {
  for (const name of [...Object.keys(state.installed), ...state.queued]) augmentationData(name);
  for (const [key, value] of Object.entries(state.bitNodeMultipliers)) {
    if (!Number.isFinite(value) || value <= 0)
      throw new RangeError(`the BitNode's ${key} must be above 0, not ${value}`);
  }
}

/**
 * An augmentation's price now, as the game's `getAugCost` has it (`Augmentation/AugmentationHelpers.ts:127-161`):
 * - most: money = base × g^q × the BitNode's AugmentationMoneyCost, reputation = base × its AugmentationRepCost, where g
 *   is `augmentationPriceGrowth` and q the queued augmentations that aren't Shadows of Anarchy's (`:32-37`);
 * - NeuroFlux Governor: both × 1.14^L as well, L its installed level plus its queued copies (`Augmentation.ts:238-246`);
 * - Shadows of Anarchy's: base × 7^n and base × 1.3^n, n of theirs installed or queued (`Person.ts:233-241`), with no
 *   BitNode multiplier and no g^q.
 * An owned one is priced too, as the game's pages do; buying it again is refused (`purchaseSequenceCost`).
 */
export function augmentationCost(name: string, state: AugmentationPurchaseState): AugmentationCost {
  const augmentation = augmentationData(name);
  checkState(state);
  const { AugmentationMoneyCost, AugmentationRepCost } = state.bitNodeMultipliers;
  if (SHADOWS_OF_ANARCHY_AUGMENTATIONS.includes(name)) {
    const owned = SHADOWS_OF_ANARCHY_AUGMENTATIONS.filter(
      (soa) => Object.hasOwn(state.installed, soa) || state.queued.includes(soa),
    ).length;
    return {
      money: augmentation.baseMoneyCost * SHADOWS_OF_ANARCHY_MONEY_GROWTH ** owned,
      reputation: augmentation.baseRepCost * SHADOWS_OF_ANARCHY_REPUTATION_GROWTH ** owned,
    };
  }
  const queued = state.queued.filter((queuedName) => !SHADOWS_OF_ANARCHY_AUGMENTATIONS.includes(queuedName)).length;
  const growth = augmentationPriceGrowth(state.sourceFile11Level) ** queued;
  // In the game's order of operations, so the floating point agrees to the last bit.
  if (name === NEUROFLUX_GOVERNOR) {
    const level = (state.installed[NEUROFLUX_GOVERNOR] ?? 0) + state.queued.filter((q) => q === name).length;
    const levelGrowth = NEUROFLUX_LEVEL_GROWTH ** level;
    return {
      money: augmentation.baseMoneyCost * levelGrowth * AugmentationMoneyCost * growth,
      reputation: augmentation.baseRepCost * levelGrowth * AugmentationRepCost,
    };
  }
  return {
    money: augmentation.baseMoneyCost * growth * AugmentationMoneyCost,
    reputation: augmentation.baseRepCost * AugmentationRepCost,
  };
}

/** The prerequisites of `name` neither installed nor queued, in the game's order (`FactionHelpers.tsx:56-58`). */
export function missingPrerequisites(name: string, state: Pick<AugmentationPurchaseState, "installed" | "queued">) {
  return augmentationData(name).prereqs.filter(
    (prereq) => !Object.hasOwn(state.installed, prereq) && !state.queued.includes(prereq),
  );
}

/** One purchase of a sequence: what it cost, then. */
export interface AugmentationPurchase extends AugmentationCost {
  name: string;
}

/**
 * Buying `names` in that order (#193): each one's price when its turn comes, each queued before the next, and the money
 * in all. Each must be one the game would sell then: not owned already (NeuroFlux Governor excepted, a level each
 * time), and its prerequisites installed, queued or bought earlier in the sequence (`FactionHelpers.tsx:75-95`).
 * Otherwise it throws. The money and reputation themselves aren't checked.
 */
export function purchaseSequenceCost(
  names: readonly string[],
  state: AugmentationPurchaseState,
): { purchases: AugmentationPurchase[]; money: number } {
  const purchases: AugmentationPurchase[] = [];
  let queued = [...state.queued];
  for (const name of names) {
    const now = { ...state, queued };
    if (name !== NEUROFLUX_GOVERNOR && (Object.hasOwn(state.installed, name) || queued.includes(name))) {
      throw new RangeError(`${name} is owned already: the game sells it once`);
    }
    const missing = missingPrerequisites(name, now);
    if (missing.length > 0) throw new RangeError(`${name} needs ${missing.join(", ")} first`);
    purchases.push({ name, ...augmentationCost(name, now) });
    queued = [...queued, name];
  }
  return { purchases, money: purchases.reduce((sum, purchase) => sum + purchase.money, 0) };
}

/**
 * The augmentations `faction` sells, in the game's order (`Faction/Factions.ts:14-21`), less The Red Pill at Daedalus
 * in BN15 (`FactionHelpers.tsx:204-207`). A gang's faction sells nearly all (`:173-202`), which this doesn't cover.
 */
export function augmentationsSoldBy(faction: string, bitNode: number): string[] {
  return AUGMENTATION_NAMES.filter(
    (name) =>
      AUGMENTATIONS[name]?.factions.includes(faction) &&
      !(bitNode === 15 && faction === "Daedalus" && name === "The Red Pill"),
  );
}

/**
 * The current BitNode's multipliers on augmentations (`getBitNodeMultipliers`, `BitNode/BitNode.tsx:570-1127`), from
 * `resetInfo`: its `currentNode`, at the level the game sets them (`initBitNodeMultipliers`, `:1129-1131`), its own
 * active Source-File + 1 (`ownedSF`). Only BN12's depend on the level: 1.02^level, and Daedalus's
 * floor(min(30 + 1.02^level, 40)) (`:924-929`).
 */
export function augmentationBitNodeMultipliers(
  currentNode: number,
  ownedSF: Readonly<Record<string, number>>,
): AugmentationBitNodeMultipliers {
  const multipliers = AUGMENTATION_BITNODE_MULTIPLIERS[currentNode];
  if (multipliers === undefined) throw new RangeError(`no BitNode ${currentNode}`);
  if (currentNode !== 12) return { ...multipliers };
  const growth = 1.02 ** ((ownedSF[String(currentNode)] ?? 0) + 1);
  // BN1's is the default (`BitNodeMultipliers.ts:61`), which BN12's adds to.
  const defaultDaedalus = (AUGMENTATION_BITNODE_MULTIPLIERS[1] as AugmentationBitNodeMultipliers)
    .DaedalusAugsRequirement;
  return {
    AugmentationMoneyCost: growth,
    AugmentationRepCost: growth,
    DaedalusAugsRequirement: Math.floor(Math.min(defaultDaedalus + growth, 40)),
  };
}

/** The backends' problems for an augmentation not bought, worded once so every backend reports the same (§5.6). */
export const augmentationProblems = {
  outOfTurn: (nextLevel: number, level: number) =>
    `${NEUROFLUX_GOVERNOR}'s next level is ${nextLevel}, not ${level}: the levels before it come first`,
  cantBuyYet: (augmentation: string, faction: string) =>
    `can't buy ${augmentation} from ${faction} yet (the money, the reputation or a prerequisite?)`,
  /** Singularity's refusal, which doesn't say why. */
  refused: (augmentation: string, faction: string) =>
    `the game refused ${augmentation} from ${faction} (joined? sold by it? the money, the reputation, a prerequisite?)`,
  notOffered: (augmentation: string, faction: string) =>
    `${faction} doesn't offer ${augmentation} (is it joined, and does it sell it?)`,
};

/** Home worker: buys an augmentation through the game's page (#149). */
export const BUY_AUGMENTATION_WORKER_NAME = "buy-augmentation.js";
/** Home worker: installs the queued augmentations through the game's page (#164). */
export const INSTALL_AUGMENTATIONS_WORKER_NAME = "install-augmentations.js";
