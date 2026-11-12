/**
 * Bladeburner (#359), slice B3 (#379): the skills. The game's twelve, their costs and effects, and the rule's choice of
 * the levels that add the most rank a second a point. Paths are `vendor/bitburner-src/src/`'s (v3.0.1), under
 * `Bladeburner/` unless named.
 * - **Points:** one for each 3 of the max rank (`Bladeburner.ts:1284-1293`, `data/Constants.ts:47`), kept through an
 *   install (`Prestige.ts:155-158`).
 * - **Cost:** `count` levels from level L cost round(count × `BladeburnerSkillCost` × (base + inc·(L + (count − 1)/2)))
 *   points (`Skill.ts:76-80`): the game's closed form, rounded once for the whole count, which `upgradeSkill` and
 *   `getSkillUpgradeCost` both charge (`Skill.ts:141-160`, `NetscriptFunctions/Bladeburner.ts:241-258`). Base and inc
 *   are each skill's (`data/Skills.ts:4-105`); `BladeburnerSkillCost` is BN7's 2 (`BitNode/BitNode.tsx:757`), BN6's
 *   the default 1 (`BitNode/BitNodeMultipliers.ts:22`). A level past the max is refused (`Skill.ts:152-154`).
 * - **Effect:** each skill's multiplier is the product over the skills of 1 + p·level/100 for each of its `mults`
 *   (`Bladeburner.ts:776-786`), at least 0; one no skill names is 1 (`getSkillMult`, `:755-757`). Overclock's p is
 *   −1 to its max level 90: the action time ×0.1 there (`data/Skills.ts:44-53`).
 * - **Where each counts:** the success skills multiply an action's competence: Blade's Intuition all, Tracer the
 *   contracts', Digital Observer the operations', Cloak the stealthy, Short-Circuit the killing (`Actions/Action.ts:
 *   183-187`, `Actions/Contract.ts:30-32`, `Actions/Operation.ts:92-94`). Reaper and Evasive System multiply the
 *   combat stats an action's competence and time read (`Bladeburner.ts:759-774`), and the agility the max stamina and
 *   its regain read (`:1319-1345`). Overclock multiplies the time (`Actions/Action.ts:105-122`). Cyber's Edge multiplies
 *   the max stamina and its regain (`:1319-1345`). Datamancer sharpens the population estimate (`:801-880`), Hands of
 *   Midas a contract's money (`:936-943`), Hyperdrive the experience (`:720-733`).
 */

/** The skills, by the NS API's names, in the game's order (`Bladeburner/Enums.ts:62-75`). */
export const BLADEBURNER_SKILL_NAMES = [
  "Blade's Intuition",
  "Cloak",
  "Short-Circuit",
  "Digital Observer",
  "Tracer",
  "Overclock",
  "Reaper",
  "Evasive System",
  "Datamancer",
  "Cyber's Edge",
  "Hands of Midas",
  "Hyperdrive",
] as const;
export type BladeburnerSkillName = (typeof BLADEBURNER_SKILL_NAMES)[number];

/** The multipliers a skill can move (`Bladeburner/Enums.ts:77-93`), by core's names. */
export interface BladeburnerSkillMults {
  /** "Total Success Chance", "Stealth Success Chance", "Retirement Success Chance", "Contract Success Chance" and
   * "Operation Success Chance". */
  successAll: number;
  successStealth: number;
  successKill: number;
  successContract: number;
  successOperation: number;
  /** "Synthoid Data Estimate". */
  successEstimate: number;
  /** "Action Time". */
  actionTime: number;
  /** "Effective Strength", and so on. */
  effStrength: number;
  effDefense: number;
  effDexterity: number;
  effAgility: number;
  effCharisma: number;
  /** "Stamina": the max stamina and its regain. */
  stamina: number;
  /** "Contract Money". */
  money: number;
  /** "Experience Gain". */
  expGain: number;
}
export type BladeburnerSkillMultName = keyof BladeburnerSkillMults;

/** A skill as `data/Skills.ts` defines it: its cost's base and rise a level, its max level, and its effects. */
export interface BladeburnerSkill {
  name: BladeburnerSkillName;
  baseCost: number;
  costInc: number;
  /** `Number.MAX_VALUE` but for Overclock's 90 (`Skill.ts:33`). */
  maxLevel: number;
  /** Each multiplier's percent a level. */
  mults: Partial<Record<BladeburnerSkillMultName, number>>;
}

/** The twelve skills (`data/Skills.ts:4-105`). */
export const BLADEBURNER_SKILLS: readonly BladeburnerSkill[] = [
  { name: "Blade's Intuition", baseCost: 3, costInc: 2.1, maxLevel: Number.MAX_VALUE, mults: { successAll: 3 } },
  { name: "Cloak", baseCost: 2, costInc: 1.1, maxLevel: Number.MAX_VALUE, mults: { successStealth: 5.5 } },
  { name: "Short-Circuit", baseCost: 2, costInc: 2.1, maxLevel: Number.MAX_VALUE, mults: { successKill: 5.5 } },
  { name: "Digital Observer", baseCost: 2, costInc: 2.1, maxLevel: Number.MAX_VALUE, mults: { successOperation: 4 } },
  { name: "Tracer", baseCost: 2, costInc: 2.1, maxLevel: Number.MAX_VALUE, mults: { successContract: 4 } },
  { name: "Overclock", baseCost: 3, costInc: 1.4, maxLevel: 90, mults: { actionTime: -1 } },
  {
    name: "Reaper",
    baseCost: 2,
    costInc: 2.1,
    maxLevel: Number.MAX_VALUE,
    mults: { effStrength: 2, effDefense: 2, effDexterity: 2, effAgility: 2 },
  },
  {
    name: "Evasive System",
    baseCost: 2,
    costInc: 2.1,
    maxLevel: Number.MAX_VALUE,
    mults: { effDexterity: 4, effAgility: 4 },
  },
  { name: "Datamancer", baseCost: 3, costInc: 1, maxLevel: Number.MAX_VALUE, mults: { successEstimate: 5 } },
  { name: "Cyber's Edge", baseCost: 1, costInc: 3, maxLevel: Number.MAX_VALUE, mults: { stamina: 2 } },
  { name: "Hands of Midas", baseCost: 2, costInc: 2.5, maxLevel: Number.MAX_VALUE, mults: { money: 10 } },
  { name: "Hyperdrive", baseCost: 1, costInc: 2.5, maxLevel: Number.MAX_VALUE, mults: { expGain: 10 } },
];

/** The skill by its name, or null. */
export function bladeburnerSkill(name: string): BladeburnerSkill | null {
  return BLADEBURNER_SKILLS.find((each) => each.name === name) ?? null;
}

/**
 * The skills the rule buys (#379): those whose worth is rank a second, the forecast's measure (core's
 * `chooseBladeburnerAction`): the five success skills, Overclock, Reaper, Evasive System and Cyber's Edge. Left out,
 * and labelled: Hands of Midas (money) and Hyperdrive (experience), the planner's to weigh (decision 67); Datamancer,
 * whose sharper population estimate raises the estimate's low end the rule reads, not the true chance, so the
 * forecast would credit it rank it doesn't gain (B4's, with the cities).
 */
export const BLADEBURNER_RANK_SKILLS: readonly BladeburnerSkillName[] = [
  "Blade's Intuition",
  "Cloak",
  "Short-Circuit",
  "Digital Observer",
  "Tracer",
  "Overclock",
  "Reaper",
  "Evasive System",
  "Cyber's Edge",
];

/** The BitNode's `BladeburnerSkillCost`: BN7's 2 (`BitNode/BitNode.tsx:757`), BN6's the default 1. Null elsewhere. */
export function bladeburnerSkillCostMultiplierOf(bitNode: number): number | null {
  return bitNode === 6 ? 1 : bitNode === 7 ? 2 : null;
}

/**
 * The points `count` levels of `skill` cost from `level`: round(count × costMult × (base + inc·(level + (count − 1)/2)))
 * (`Skill.ts:76-80`). Infinity past the max level, as `getSkillUpgradeCost` has it
 * (`NetscriptFunctions/Bladeburner.ts:247-249`).
 */
export function bladeburnerSkillCost(skill: BladeburnerSkill, level: number, count: number, costMultiplier: number) {
  if (level + count > skill.maxLevel) return Number.POSITIVE_INFINITY;
  return Math.round(count * costMultiplier * (skill.baseCost + skill.costInc * (level + (count - 1) / 2)));
}

/** Each skill's level, by name; one absent is 0 (`getSkillLevel`, `Bladeburner.ts:1347-1349`). */
export type BladeburnerSkillLevels = Partial<Record<BladeburnerSkillName, number>>;

/** Every multiplier at 1: no skill. */
export const NO_BLADEBURNER_SKILLS: Readonly<BladeburnerSkillMults> = {
  successAll: 1,
  successStealth: 1,
  successKill: 1,
  successContract: 1,
  successOperation: 1,
  successEstimate: 1,
  actionTime: 1,
  effStrength: 1,
  effDefense: 1,
  effDexterity: 1,
  effAgility: 1,
  effCharisma: 1,
  stamina: 1,
  money: 1,
  expGain: 1,
};

/**
 * The multipliers at `levels` (`updateSkillMultipliers`, `Bladeburner.ts:776-786`): for each skill with a level, each of
 * its multipliers times 1 + p·level/100, at least 0.
 */
export function bladeburnerSkillMultsOf(levels: BladeburnerSkillLevels): BladeburnerSkillMults {
  const mults = { ...NO_BLADEBURNER_SKILLS };
  for (const skill of BLADEBURNER_SKILLS) {
    const level = levels[skill.name] ?? 0;
    if (!level) continue;
    for (const [name, percent] of Object.entries(skill.mults) as [BladeburnerSkillMultName, number][]) {
      mults[name] = Math.max(0, mults[name] * (1 + (percent * level) / 100));
    }
  }
  return mults;
}

/** A skill's levels the rule buys: from the level read to `to`, for `cost` points (one `upgradeSkill` call's). */
export interface BladeburnerSkillBuy {
  skill: BladeburnerSkillName;
  from: number;
  to: number;
  cost: number;
}

/** The rule's skills (#379): the levels to buy, the points they cost, and the forecast's rank a second before and after. */
export interface BladeburnerSkillPlan {
  buys: BladeburnerSkillBuy[];
  points: number;
  spent: number;
  rankPerSecond: number;
  rankPerSecondAfter: number;
}

/** The most levels of one skill the rule weighs at a time: past that, the points' own limit is far smaller. */
const MOST_LEVELS_WEIGHED = 1_000;

/**
 * The levels to buy with `points` (#379), each step the levels of one skill that add the most rank a second a point,
 * by `rankPerSecond` (the forecast at a set of levels: the brain's is core's `chooseBladeburnerAction`, its cycle of
 * work and rest, so Cyber's Edge is worth its stamina's duty cycle):
 * - **A step:** each skill of `BLADEBURNER_RANK_SKILLS`, one level and more up to what the points left cover and its
 *   max (Overclock's 90), each count by its gain over the forecast now a point; the best kept, the first in the game's
 *   order and the fewest levels on a tie. More than one level is weighed as the forecast moves in steps: an action's
 *   time is a whole number of seconds (`Actions/Action.ts:121`), so a level of Overclock alone may gain nothing where
 *   several do.
 * - **Repeated** while a step gains rank; what's left is under any level that gains (none gains without a contract or
 *   operation worth working). The points of each skill's levels are the game's for the whole count, from the level read
 *   (one `upgradeSkill` call's, `Skill.ts:76-80`): a step's are the rise in that.
 * Left out, and labelled: saving points for a dearer level that gains more a point (the points are spent within a
 * reading of coming, #379); the skills whose worth isn't rank (`BLADEBURNER_RANK_SKILLS`).
 */
export function planBladeburnerSkills({
  levels,
  points,
  costMultiplier,
  rankPerSecond,
}: {
  levels: BladeburnerSkillLevels;
  points: number;
  costMultiplier: number;
  rankPerSecond: (levels: BladeburnerSkillLevels) => number;
}): BladeburnerSkillPlan {
  const read = (name: BladeburnerSkillName) => levels[name] ?? 0;
  const planned: BladeburnerSkillLevels = { ...levels };
  const before = rankPerSecond(levels);
  let now = before;
  let spent = 0;
  const costOf = (skill: BladeburnerSkill, to: number) =>
    to === read(skill.name) ? 0 : bladeburnerSkillCost(skill, read(skill.name), to - read(skill.name), costMultiplier);
  for (;;) {
    let best: { skill: BladeburnerSkill; to: number; cost: number; rate: number; perPoint: number } | null = null;
    for (const name of BLADEBURNER_RANK_SKILLS) {
      const skill = bladeburnerSkill(name) as BladeburnerSkill;
      const at = planned[name] ?? 0;
      const paid = costOf(skill, at);
      for (let count = 1; count <= MOST_LEVELS_WEIGHED; count++) {
        const cost = costOf(skill, at + count) - paid;
        if (!(spent + cost <= points)) break;
        const rate = rankPerSecond({ ...planned, [name]: at + count });
        const perPoint = (rate - now) / cost;
        if (rate > now && (best === null || perPoint > best.perPoint))
          best = { skill, to: at + count, cost, rate, perPoint };
      }
    }
    if (best === null) break;
    planned[best.skill.name] = best.to;
    spent += best.cost;
    now = best.rate;
  }
  const buys = BLADEBURNER_SKILL_NAMES.flatMap((name) => {
    const to = planned[name] ?? 0;
    const skill = bladeburnerSkill(name) as BladeburnerSkill;
    return to > read(name) ? [{ skill: name, from: read(name), to, cost: costOf(skill, to) }] : [];
  });
  return { buys, points, spent, rankPerSecond: before, rankPerSecondAfter: now };
}

/** The least points any rank skill's next level costs at `levels`: what the points unspent are short of. */
export function cheapestBladeburnerSkillLevel(levels: BladeburnerSkillLevels, costMultiplier: number): number {
  return Math.min(
    ...BLADEBURNER_RANK_SKILLS.map((name) =>
      bladeburnerSkillCost(bladeburnerSkill(name) as BladeburnerSkill, levels[name] ?? 0, 1, costMultiplier),
    ),
  );
}
