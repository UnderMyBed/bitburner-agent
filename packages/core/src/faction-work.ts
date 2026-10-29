/**
 * Faction work's reputation (#203, M4 phase A slice A5): the game's formulas, for the brain's choice of which faction to
 * work for and its ETAs, and what an augmentation is worth to the hacking the brain does. Shared by the brain and the
 * simulator's tests; checked against the engine's `ns.formulas.work.factionGains` (the brain's parity suite).
 */
import { AUGMENTATIONS } from "./augmentation-data.ts";
import { intelligenceBonus } from "./hacking-ceiling.ts";
import type { FactionWorkType } from "./work.ts";

/** `MaxSkillLevel` (`Constants.ts:16`): the skills' divisor in every faction work formula. */
export const MAX_SKILL_LEVEL = 975;
/** The game's cycles a second: one each `MilliPerCycle`, 200 ms (`Constants.ts:19`). */
export const FACTION_WORK_CYCLES_PER_SECOND = 5;
/** Work unfocused gains this much (`BaseFocusBonus`, `Constants.ts:87`), unless the implant is installed. */
export const UNFOCUSED_WORK_BONUS = 0.8;

/** What the formulas read of a person: `ns.getPlayer()`'s skills and its `faction_rep` multiplier. */
export interface WorkingPerson {
  skills: {
    hacking: number;
    strength: number;
    defense: number;
    dexterity: number;
    agility: number;
    charisma: number;
    intelligence: number;
  };
  mults: { faction_rep: number };
}

const finite = (value: number, what: string) => {
  if (!Number.isFinite(value)) throw new RangeError(`${what} must be a finite number, not ${value}`);
  return value;
};

/**
 * The reputation one cycle of `workType` earns, focused (`calculateFactionRep`, `Work/Formulas.ts:82-89`, and its
 * formulas, `PersonObjects/formulas/reputation.ts:8-52`):
 * - hacking: (hacking + intelligence/3 + a tenth of charisma with SF15.3) / 975;
 * - field: 0.9 × (str + def + dex + agi + cha + hacking + intelligence + 3/10 of charisma with SF15.3) / 975 / 5.5;
 * - security: 0.9 × (str + def + dex + agi + 3/10 of charisma with SF15.3 + hacking + intelligence) / 975 / 4.5;
 * - each × `faction_rep` × the intelligence bonus × (1 + favour/100).
 * The share bonus is 1: the brain runs no `share()` (`NetworkShare/Share.ts:43-57`, 1 with no threads). The BitNode's
 * `FactionWorkRepGain` is taken as 1: exact in BN1; elsewhere it scales every faction and work type alike
 * (`reputation.ts:13`), so a choice between them is the same and only an ETA is off. A figure that isn't finite throws.
 */
export function factionReputationPerCycle(
  person: WorkingPerson,
  workType: FactionWorkType,
  favor: number,
  sourceFile15Level: number,
): number {
  const skills = Object.fromEntries(
    Object.entries(person.skills).map(([name, value]) => [name, finite(value, `the player's ${name}`)]),
  ) as WorkingPerson["skills"];
  const factionRep = finite(person.mults.faction_rep, "the player's faction_rep multiplier");
  if (!(finite(favor, "the faction's favour") >= 0)) throw new RangeError(`the faction's favour is ${favor}`);
  // `getDarknetCharismaBonus` (`reputation.ts:54-59`): charisma × the scalar with SF15 at level 3 or more.
  const charismaBonus = (scalar: number) => (sourceFile15Level >= 3 ? skills.charisma * scalar : 0);
  const favorMult = 1 + favor / 100;
  // At weight 1 (`reputation.ts:20`, `:37`, `:51`): hacking-ceiling.ts's, shared.
  const intBonus = intelligenceBonus(skills.intelligence);
  const { hacking, strength, defense, dexterity, agility, charisma, intelligence } = skills;
  if (workType === "hacking") {
    return ((hacking + intelligence / 3 + charismaBonus(0.1)) / MAX_SKILL_LEVEL) * factionRep * intBonus * favorMult;
  }
  const physical = strength + defense + dexterity + agility;
  const sum =
    workType === "field"
      ? physical + charisma + hacking + intelligence + charismaBonus(0.3)
      : physical + charismaBonus(0.3) + hacking + intelligence;
  const divisor = workType === "field" ? 5.5 : 4.5;
  return ((0.9 * sum) / MAX_SKILL_LEVEL / divisor) * factionRep * favorMult * intBonus;
}

/**
 * The reputation a second of `workType` earns (`FactionWork.getReputationRate`, `Work/FactionWork.tsx:37-40`): five
 * cycles, × 0.8 unfocused unless the Neuroreceptor Management Implant is installed (`focusPenalty`,
 * `PersonObjects/Player/PlayerObjectGeneralMethods.ts:622-628`).
 */
export function factionReputationPerSecond(
  person: WorkingPerson,
  workType: FactionWorkType,
  {
    favor,
    sourceFile15Level,
    focused,
    implant,
  }: { favor: number; sourceFile15Level: number; focused: boolean; implant: boolean },
): number {
  const focusBonus = focused || implant ? 1 : UNFOCUSED_WORK_BONUS;
  return (
    factionReputationPerCycle(person, workType, favor, sourceFile15Level) * focusBonus * FACTION_WORK_CYCLES_PER_SECOND
  );
}

/**
 * The multipliers that make the brain's hacking pay more or come sooner (#203): skill, speed, money, growth, chance and
 * experience, and faction reputation, which brings the next augmentation nearer.
 */
export const HACKING_MULTIPLIERS = [
  "hacking",
  "hacking_speed",
  "hacking_money",
  "hacking_grow",
  "hacking_chance",
  "hacking_exp",
  "faction_rep",
] as const;

/**
 * What an augmentation is worth to the brain's hacking (#203): the natural logarithms of its `HACKING_MULTIPLIERS`
 * added up, so two of them together are worth what their product is. 0 for one with none (combat, The Red Pill);
 * Unstable Circadian Modulator's are drawn at random (augmentation-data.ts), so 0 too. An unknown name throws.
 */
export function hackingValue(augmentation: string): number {
  if (!Object.hasOwn(AUGMENTATIONS, augmentation))
    throw new RangeError(`no augmentation ${JSON.stringify(augmentation)}`);
  const { multipliers } = AUGMENTATIONS[augmentation] as (typeof AUGMENTATIONS)[string];
  return HACKING_MULTIPLIERS.reduce((sum, key) => sum + Math.log(multipliers[key] ?? 1), 0);
}
