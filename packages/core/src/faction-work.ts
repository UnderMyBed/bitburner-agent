/**
 * Faction work's reputation (#203, M4 phase A slice A5): the game's formulas, for the brain's choice of which faction
 * to work for and its ETAs, and what an augmentation is worth to the hacking the brain does. Shared by the brain and
 * the simulator's tests; checked against the engine's `ns.formulas.work.factionGains` (the brain's parity suite).
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
 * - each × `faction_rep` × the intelligence bonus × (1 + favour/100) × the BitNode's `FactionWorkRepGain`
 *   (`reputation.ts:8-14`; core's `augmentationBitNodeMultipliers`).
 * - `shareBonus` (#224, core's `shareBonus`, 1 with no share running) multiplies all of hacking work's, and only the
 *   (hacking + intelligence) term of field and security work's, plus SF15.3's charisma in field's (`reputation.ts:16-52`).
 * A figure that isn't finite throws.
 */
export function factionReputationPerCycle(
  person: WorkingPerson,
  workType: FactionWorkType,
  favor: number,
  sourceFile15Level: number,
  factionWorkRepGain: number,
  shareBonus = 1,
): number {
  const skills = Object.fromEntries(
    Object.entries(person.skills).map(([name, value]) => [name, finite(value, `the player's ${name}`)]),
  ) as WorkingPerson["skills"];
  const factionRep = finite(person.mults.faction_rep, "the player's faction_rep multiplier");
  const bonus = finite(shareBonus, "the share bonus");
  if (!(finite(favor, "the faction's favour") >= 0)) throw new RangeError(`the faction's favour is ${favor}`);
  // `getDarknetCharismaBonus` (`reputation.ts:54-59`): charisma × the scalar with SF15 at level 3 or more.
  const charismaBonus = (scalar: number) => (sourceFile15Level >= 3 ? skills.charisma * scalar : 0);
  const favorMult = (1 + favor / 100) * finite(factionWorkRepGain, "the BitNode's FactionWorkRepGain");
  // At weight 1 (`reputation.ts:20`, `:37`, `:51`): hacking-ceiling.ts's, shared.
  const intelligenceMultiplier = intelligenceBonus(skills.intelligence);
  const { hacking, strength, defense, dexterity, agility, charisma, intelligence } = skills;
  if (workType === "hacking") {
    return (
      ((hacking + intelligence / 3 + charismaBonus(0.1)) / MAX_SKILL_LEVEL) *
      factionRep *
      intelligenceMultiplier *
      favorMult *
      bonus
    );
  }
  const physical = strength + defense + dexterity + agility;
  const sum =
    workType === "field"
      ? physical + charisma + (hacking + intelligence + charismaBonus(0.3)) * bonus
      : physical + charismaBonus(0.3) + (hacking + intelligence) * bonus;
  const divisor = workType === "field" ? 5.5 : 4.5;
  return ((0.9 * sum) / MAX_SKILL_LEVEL / divisor) * factionRep * favorMult * intelligenceMultiplier;
}

/**
 * The reputation a second of `workType` earns (`FactionWork.getReputationRate`, `Work/FactionWork.tsx:37-40`): five
 * cycles, × 0.8 unfocused unless the Neuroreceptor Management Implant is installed (`focusPenalty`,
 * `PersonObjects/Player/PlayerObjectGeneralMethods.ts:622-628`), with the share bonus running (#224), 1 by default.
 */
export function factionReputationPerSecond(
  person: WorkingPerson,
  workType: FactionWorkType,
  {
    favor,
    sourceFile15Level,
    focused,
    implant,
    factionWorkRepGain,
    shareBonus = 1,
  }: {
    favor: number;
    sourceFile15Level: number;
    focused: boolean;
    implant: boolean;
    factionWorkRepGain: number;
    shareBonus?: number;
  },
): number {
  const focusBonus = focused || implant ? 1 : UNFOCUSED_WORK_BONUS;
  const perCycle = factionReputationPerCycle(
    person,
    workType,
    favor,
    sourceFile15Level,
    factionWorkRepGain,
    shareBonus,
  );
  return perCycle * focusBonus * FACTION_WORK_CYCLES_PER_SECOND;
}

/** Passive reputation's least, a cycle (`Faction/FactionHelpers.tsx:162`): 1 every 2 minutes. */
export const PASSIVE_REPUTATION_LEAST_PER_CYCLE = 1 / 120;

/**
 * The reputation a second a joined faction gains while not worked for (#260; `processPassiveFactionRepGain`,
 * `Faction/FactionHelpers.tsx:132-170`): the best of its hacking, security and field work's rate a cycle (each type,
 * whether or not the faction offers it), times 1% plus a tenth of a percent a point of favour, at most 10%; never
 * below `PASSIVE_REPUTATION_LEAST_PER_CYCLE`; five cycles a second, focus aside; times the BitNode's
 * `FactionPassiveRepGain` (1 in BN1, 0 in BN2: `BitNode/BitNode.tsx:587`). Not for the faction worked for, a gang's or
 * a special one (the caller's).
 */
export function passiveFactionReputationPerSecond(
  person: WorkingPerson,
  favor: number,
  sourceFile15Level: number,
  factionWorkRepGain: number,
  shareBonus = 1,
  factionPassiveRepGain = 1,
): number {
  const favorMult = Math.min(0.1, favor / 1000 + 0.01);
  const perCycle = Math.max(
    ...(["hacking", "security", "field"] as const).map(
      (workType) =>
        factionReputationPerCycle(person, workType, favor, sourceFile15Level, factionWorkRepGain, shareBonus) *
        favorMult,
    ),
    PASSIVE_REPUTATION_LEAST_PER_CYCLE,
  );
  return perCycle * FACTION_WORK_CYCLES_PER_SECOND * factionPassiveRepGain;
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
 * What `hacking` × `multiplier` is worth at `hackingLevel`, as the hacking experience multiplier that lifts the level
 * as much: ln x = (L/32)(1 − 1/m). The level is m × (32 ln(exp + 534.6) − 200) (`PersonObjects/Person.ts:60-63`,
 * `formulas/skill.ts:13`), so ×m on it is worth ×x on experience, at level L. At L=300, BitWire's ×1.05 is worth an
 * experience multiplier of ×1.56; at L=3000, ×87: the skill multipliers outgrow the rest as the level climbs.
 */
export function hackingSkillValue(multiplier: number, hackingLevel: number): number {
  if (!(Number.isFinite(hackingLevel) && hackingLevel >= 1)) {
    throw new RangeError(`the hacking level must be 1 or more, not ${hackingLevel}`);
  }
  return (hackingLevel / 32) * (1 - 1 / multiplier);
}

/**
 * What an augmentation is worth to the brain's hacking at `hackingLevel` (#203; A6 ranks its purchases by it too): the
 * natural logarithms of its `HACKING_MULTIPLIERS` added up, so two of them together are worth what their product is,
 * but for `hacking` itself, weighed by the level formula (`hackingSkillValue`) as the experience multiplier it equals
 * at that level. `hacking_speed` is counted once, though faster hacks bring both money and experience sooner. 0 for one
 * with none (combat, The Red Pill); Unstable Circadian Modulator's are drawn at random (augmentation-data.ts), so 0 too.
 * An unknown name throws.
 */
export function hackingValue(augmentation: string, hackingLevel: number): number {
  if (!Object.hasOwn(AUGMENTATIONS, augmentation)) {
    throw new RangeError(`no augmentation ${JSON.stringify(augmentation)}`);
  }
  const { multipliers } = AUGMENTATIONS[augmentation] as (typeof AUGMENTATIONS)[string];
  return HACKING_MULTIPLIERS.reduce((sum, key) => {
    const multiplier = multipliers[key] ?? 1;
    return sum + (key === "hacking" ? hackingSkillValue(multiplier, hackingLevel) : Math.log(multiplier));
  }, 0);
}
