// Bladeburner #408: the Black Ops' route's estimate with the competence's growth. The tail's mix (the linear
// programme's primal) against its dual, B3's forecast to the bit, the game's experience and levels by hand, the input at
// a state against the game's own formulas there, the integration (with no growth B6's; each growth only shortens it;
// its step), a seeded walk of the game's attempts, the install choice on both sides, and BN6's and (#411) BN7's
// playability.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { AUGMENTATIONS } from "../src/augmentation-data.ts";
import { augmentationsSoldBy } from "../src/augmentations.ts";
import { COMBAT_STATS, type CombatPerson, type CombatStat, skillExpFor, skillLevelOf } from "../src/bladeburner.ts";
import {
  actionDifficulty,
  actionRankGain,
  actionRankLoss,
  actionSuccessChance,
  BLADEBURNER_LEVELLED_ACTIONS,
  type BladeburnerActionReading,
  type BladeburnerPerson,
  bladeburnerForecastRater,
  bladeburnerLevelledAction,
  bladeburnerRankMultiplierOf,
  bladeburnerTailMix,
  bladeburnerTailRate,
  chooseBladeburnerAction,
  chooseBladeburnerSkills,
  difficultyMultiplier,
  maxStaminaOf,
  successesForNextLevel,
} from "../src/bladeburner-actions.ts";
import {
  BLADEBURNER_BLACK_OPS,
  type BladeburnerBlackOp,
  blackOpSeconds,
  blackOpSuccessChance,
} from "../src/bladeburner-black-ops.ts";
import {
  ALL_GROWTH,
  actionCombatExpPerAttempt,
  BLADEBURNER_GROWTH_FRACTION,
  BLADEBURNER_GROWTH_LEAST_STEP,
  type BladeburnerGrowthState,
  blackOpsRouteGrownEstimate,
  bladeburnerGrownInput,
  bladeburnerGrowthStart,
  maxLevelOfSuccesses,
  successesOfMaxLevel,
} from "../src/bladeburner-growth.ts";
import {
  blackOpsInstallTiming,
  bladeburnerAugmentationValues,
  bladeburnerInstallGain,
  bladeburnerPersonAfterInstall,
  bladeburnerRebuildSeconds,
  NO_INSTALL_GAIN,
} from "../src/bladeburner-installs.ts";
import { blackOpsRouteEstimate } from "../src/bladeburner-route.ts";
import {
  BLADEBURNER_SKILL_NAMES,
  bladeburnerSkillCostMultiplierOf,
  bladeburnerSkillMultsOf,
  cheapestBladeburnerSkillLevel,
} from "../src/bladeburner-skills.ts";
import { bladeburnerSustainableMix, bladeburnerSustainableRate } from "../src/bladeburner-targets.ts";

const gameSource = (file: string) =>
  readFileSync(new URL(`../../../vendor/bitburner-src/src/${file}`, import.meta.url), "utf8");

/** A seeded uniform on [0, 1) (mulberry32): the walk's, the same each run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** SF1.3's ×1.28 on the combat stats' levels and experience (`SourceFile/applySourceFile.ts:14-48`), B1's suite's. */
const SF1_3 = 1.28;
const CITY = { population: 1e9, communities: 50, chaos: 0 };
const TYPHOON = BLADEBURNER_BLACK_OPS[0] as BladeburnerBlackOp;
const HOUR = 3600;

/** The combat figures at `combat` from its experience at SF1.3's multipliers (times `gain`'s where given). */
function combatOf(combat: number): CombatPerson {
  const each = (value: number) => Object.fromEntries(COMBAT_STATS.map((stat) => [stat, value]));
  return {
    skills: each(combat),
    exp: each(skillExpFor(combat, SF1_3)),
    mults: Object.fromEntries(
      COMBAT_STATS.flatMap((stat) => [
        [stat, SF1_3],
        [`${stat}_exp`, SF1_3],
      ]),
    ),
  } as CombatPerson;
}

/** `combat` after an install of `gain` rebuilt to its levels: the multipliers times the gain, the least experience. */
function combatAfter(combat: CombatPerson, gain: ReturnType<typeof bladeburnerInstallGain>): CombatPerson {
  const mults = { ...combat.mults };
  const exp = { ...combat.exp };
  for (const stat of COMBAT_STATS) {
    mults[stat] = combat.mults[stat] * gain.levels[stat];
    mults[`${stat}_exp`] = combat.mults[`${stat}_exp`] * gain.exp[stat];
    exp[stat] = skillExpFor(combat.skills[stat], mults[stat]);
  }
  return { skills: { ...combat.skills }, exp, mults };
}

/** A player as BN6's division takes one (B7's playability states): combat at each stat's experience, hacking 100. */
function personAt(exp: Readonly<Record<CombatStat, number>>): BladeburnerPerson {
  const skills = { hacking: 100, charisma: 1, intelligence: 0 } as BladeburnerPerson["skills"];
  for (const stat of COMBAT_STATS) skills[stat] = skillLevelOf(exp[stat], SF1_3);
  return {
    skills,
    mults: { bladeburner_success_chance: 1, bladeburner_max_stamina: 1, bladeburner_stamina_gain: 1 },
  };
}

/**
 * A reading at `who`, the game's formula's chance at each action's max level (`maxLevels`, 1 by default), the skills'
 * `levels`, the counts `count`, rested; the stamina bonus 0.
 */
function inputAt(
  who: BladeburnerPerson,
  levels: Record<string, number> = {},
  maxLevels: Record<string, number> = {},
  count = 20,
) {
  const mults = bladeburnerSkillMultsOf(levels);
  const readings: BladeburnerActionReading[] = BLADEBURNER_LEVELLED_ACTIONS.map((action) => {
    const level = maxLevels[action.name] ?? 1;
    const chance = actionSuccessChance(action, level, who, { city: CITY, penalty: 1, skills: mults });
    return { type: action.type, name: action.name, level, maxLevel: level, count, chance: [chance, chance] };
  });
  const maxStamina = maxStaminaOf(who, 0, mults);
  return {
    readings,
    person: who,
    stamina: maxStamina,
    maxStamina,
    rankMultiplier: 1,
    speed: 1,
    skills: { read: levels },
  };
}

/** The route from rank 0 at combat `combat` (B7's BN6.1 states), the next Black Op Typhoon read at its formula. */
function startAt(combat: number) {
  const combatFigures = combatOf(combat);
  const who = personAt(combatFigures.exp);
  const chance = blackOpSuccessChance(TYPHOON, who, { penalty: 1 });
  return {
    who,
    combat: combatFigures,
    input: inputAt(who),
    at: { rank: 0, next: TYPHOON, chanceRead: [chance, chance] as [number, number] },
  };
}

describe("the tail's mix (#408): the linear programme's primal, against its dual", () => {
  test("by hand: each action to its growth, the most rank a second first, the marginal one's share filling the second", () => {
    const single = (rankPerSecond: number, seconds: number, growthPerSecond: number) => ({
      growthPerSecond,
      options: [{ rise: rankPerSecond * seconds, seconds }],
    });
    // #392's case: 0.01 a second for 0.1 of the second, 0.005 for 0.2, the rest at 0.001.
    const sources = [single(0.005, 50, 0.004), single(0.01, 100, 0.001)];
    const mix = bladeburnerSustainableMix(sources, 0.001);
    expect(mix.rate).toBeCloseTo(bladeburnerSustainableRate(sources, 0.001), 12);
    expect(mix.parts).toEqual([
      { source: 0, option: 0, perSecond: expect.closeTo(0.004, 12) },
      { source: 1, option: 0, perSecond: expect.closeTo(0.001, 12) },
    ]);
    // The time binds: A's two ways and B, the dual's bracket's two ends weighted to spend the second exactly.
    const a = {
      growthPerSecond: 0.01,
      options: [
        { rise: 4, seconds: 100 },
        { rise: 2.5, seconds: 40 },
      ],
    };
    const b = { growthPerSecond: 0.012, options: [{ rise: 1, seconds: 50 }] };
    const bound = bladeburnerSustainableMix([a, b], 0);
    expect(bound.rate).toBeCloseTo(bladeburnerSustainableRate([a, b], 0), 9);
    const seconds = bound.parts.reduce(
      (sum, part) => sum + part.perSecond * ([a, b][part.source]?.options[part.option]?.seconds ?? 0),
      0,
    );
    expect(seconds).toBeCloseTo(1, 9);
    for (const source of [0, 1]) {
      const attempts = bound.parts.filter((part) => part.source === source).reduce((t, p) => t + p.perSecond, 0);
      expect(attempts).toBeLessThanOrEqual(([a, b][source]?.growthPerSecond ?? 0) + 1e-12);
    }
  });

  test("at readings: the mix's rate the tail rate's, each action its level, chance and attempts within its growth and the second", () => {
    for (const [combat, levels, maxLevel] of [
      [100, {}, 1],
      [300, { Overclock: 40, Reaper: 20 }, 12],
      [1000, { "Blade's Intuition": 60, "Digital Observer": 60, Overclock: 90 }, 40],
    ] as const) {
      const who = personAt(combatOf(combat).exp);
      const input = inputAt(
        who,
        levels,
        Object.fromEntries(BLADEBURNER_LEVELLED_ACTIONS.map((action) => [action.name, maxLevel])),
      );
      const mix = bladeburnerTailMix(input);
      expect(mix.rate / bladeburnerTailRate(input)).toBeCloseTo(1, 9);
      // The time (#409's review): the cycles worked fit in the second, each at least its attempt.
      expect(mix.work.reduce((sum, part) => sum + part.attemptsPerSecond * part.cycleSeconds, 0)).toBeLessThanOrEqual(
        1 + 1e-9,
      );
      // At combat 100 the actions rest (B2's three quarters of the time): a cycle there is longer than its attempt.
      if (combat === 100) expect(mix.work.some((part) => part.cycleSeconds > part.attemptSeconds)).toBe(true);
      for (const part of mix.work) {
        expect(part.cycleSeconds).toBeGreaterThanOrEqual(part.attemptSeconds);
        const action = bladeburnerLevelledAction(part.type, part.name);
        expect(action).not.toBeNull();
        expect(part.level).toBeGreaterThanOrEqual(1);
        expect(part.level).toBeLessThanOrEqual(maxLevel);
        expect(part.attemptsPerSecond).toBeLessThanOrEqual(
          ((action?.growth[0] ?? 0) + (action?.growth[1] ?? 0)) / 2 / 10 / 480 + 1e-12,
        );
      }
    }
  });
});

describe("B3's forecast (#408): the rank a second at planned levels, worked out once a reading, to the bit", () => {
  test("against `chooseBladeburnerAction`'s, at random levels, persons, stamina, counts and cities", () => {
    const random = seeded(4081);
    let checked = 0;
    for (let trial = 0; trial < 60; trial++) {
      const combat = 50 + Math.floor(random() * 2000);
      const who = personAt(combatOf(combat).exp);
      const read = Object.fromEntries(
        BLADEBURNER_SKILL_NAMES.filter(() => random() < 0.5).map((name) => [
          name,
          name === "Overclock" ? Math.floor(random() * 90) : Math.floor(random() * 60),
        ]),
      );
      const maxLevels = Object.fromEntries(
        BLADEBURNER_LEVELLED_ACTIONS.map((action) => [action.name, 1 + Math.floor(random() * 30)]),
      );
      const base = inputAt(who, read, maxLevels, Math.floor(random() * 30));
      const input = {
        ...base,
        stamina: base.maxStamina * (0.2 + random()),
        ...(random() < 0.3 ? { city: { ratio: 0.5 + random(), raid: random() < 0.5 } } : {}),
        ...(random() < 0.3
          ? { forecast: { ...who, mults: { ...who.mults, bladeburner_success_chance: 1 + random() } } }
          : {}),
      };
      const rater = bladeburnerForecastRater(input, read);
      for (let each = 0; each < 5; each++) {
        const planned = { ...read };
        for (const name of BLADEBURNER_SKILL_NAMES) {
          if (random() < 0.4)
            planned[name] = Math.min(name === "Overclock" ? 90 : 300, (read[name] ?? 0) + Math.floor(random() * 40));
        }
        const slow = chooseBladeburnerAction({ ...input, skills: { read, planned } }).rankPerSecond;
        expect(rater(planned)).toBe(slow);
        checked += 1;
      }
    }
    expect(checked).toBe(300);
  });
});

describe("the game's experience and levels (#408)", () => {
  test("an attempt's experience: its seconds × diffMult × weight × (p + ½(1 − p)) × mults.<stat>_exp, taken once", () => {
    const assassination = bladeburnerLevelledAction("Operations", "Assassination");
    if (assassination === null) throw new Error("no Assassination");
    const difficulty = actionDifficulty(assassination, 3);
    const diffMult = difficulty ** 0.28 + difficulty / 650;
    const mults = { strength: 1.28, defense: 1.28, dexterity: 1.5, agility: 1.28 };
    const exp = actionCombatExpPerAttempt(assassination, 3, 0.4, 120, mults);
    expect(exp.dexterity).toBeCloseTo(120 * diffMult * 0.3 * (0.4 + 0.3) * 1.5, 9);
    expect(exp.strength).toBeCloseTo(120 * diffMult * 0.1 * 0.7 * 1.28, 9);
    expect(difficultyMultiplier(difficulty)).toBeCloseTo(diffMult, 12);
    // The game's: the time, BaseStatGain 1, half on a failure, Hyperdrive's multiplier; then `gainStats`' one more.
    const bladeburner = gameSource("Bladeburner/Bladeburner.ts");
    expect(bladeburner).toContain(
      "const unweightedGain = time * BladeburnerConstants.BaseStatGain * successMult * difficultyMult;",
    );
    expect(bladeburner).toContain("const successMult = success ? 1 : 0.5;");
    expect(gameSource("Bladeburner/data/Constants.ts")).toContain("BaseStatGain: 1,");
    expect(gameSource("PersonObjects/Person.ts")).toContain(
      "this.gainStrengthExp(retValue.strExp * this.mults.strength_exp);",
    );
  });

  test("the max level the successes open: the game's one level a success at ⌈½·M·(2b + M − 1)⌉; its inverse", () => {
    for (const action of BLADEBURNER_LEVELLED_ACTIONS) {
      // The game's: each success, one more level once the successes reach the next one's (`setMaxLevel`).
      let maxLevel = 1;
      for (let successes = 1; successes <= 600; successes++) {
        if (successes >= successesForNextLevel(action, maxLevel)) maxLevel += 1;
        expect(maxLevelOfSuccesses(action, successes), `${action.name} at ${successes}`).toBe(maxLevel);
      }
      for (let level = 1; level <= 30; level++) {
        expect(maxLevelOfSuccesses(action, successesOfMaxLevel(action, level))).toBe(level);
        if (level > 1) expect(maxLevelOfSuccesses(action, successesOfMaxLevel(action, level) - 1)).toBe(level - 1);
      }
    }
    expect(gameSource("Bladeburner/Actions/LevelableAction.ts")).toContain(
      "return Math.ceil(0.5 * this.maxLevel * (2 * baseSuccessesPerLevel + (this.maxLevel - 1)));",
    );
  });
});

describe("the input at a state (#408): as a reading there would have it", () => {
  const { who, combat, input } = startAt(100);

  test("at the start: the readings' chances and ρ as read", () => {
    const state = bladeburnerGrowthStart(input, { rank: 0, points: 0, combat });
    const grown = bladeburnerGrownInput(input, combat, state);
    grown.readings.forEach((read, index) => {
      expect(read.chance[0]).toBeCloseTo(input.readings[index]?.chance[0] as number, 12);
      expect(read.maxLevel).toBe(1);
    });
    expect(grown.person.skills).toEqual(who.skills);
    expect(bladeburnerTailRate(grown) / bladeburnerTailRate(input)).toBeCloseTo(1, 12);
  });

  test("grown: each chance the game's formula at the stats, skills and max level there (not the ratio's own check)", () => {
    const exp = Object.fromEntries(COMBAT_STATS.map((stat) => [stat, skillExpFor(300, SF1_3)])) as Record<
      CombatStat,
      number
    >;
    const state: BladeburnerGrowthState = {
      rank: 5000,
      points: 3,
      levels: { "Blade's Intuition": 20, "Digital Observer": 15, Reaper: 10, "Evasive System": 5, Overclock: 30 },
      exp,
      successes: Object.fromEntries(
        BLADEBURNER_LEVELLED_ACTIONS.map((action) => [action.name, successesOfMaxLevel(action, 10) + 2]),
      ),
    };
    const grown = bladeburnerGrownInput(input, combat, state);
    const there = personAt(exp);
    const skills = bladeburnerSkillMultsOf(state.levels);
    expect(grown.person.skills).toEqual(there.skills);
    for (const read of grown.readings) {
      const action = bladeburnerLevelledAction(read.type, read.name);
      if (action === null) throw new Error(read.name);
      expect(read.maxLevel).toBe(10);
      const formula = actionSuccessChance(action, 10, there, { city: CITY, penalty: 1, skills });
      expect(read.chance[0], read.name).toBeCloseTo(formula, 12);
    }
    expect(grown.maxStamina).toBeCloseTo(maxStaminaOf(there, 0, skills), 12);
    expect(grown.stamina).toBe(grown.maxStamina);
  });

  test("at an install's person, the success chance ×1.5: each chance ×1.5; a high end read at 1, no rise credited", () => {
    const start = bladeburnerGrowthStart(input, { rank: 0, points: 0, combat });
    const forecast = { ...who, mults: { ...who.mults, bladeburner_success_chance: 1.5 } };
    const grown = bladeburnerGrownInput({ ...input, forecast }, combat, start);
    grown.readings.forEach((read, index) => {
      const before = input.readings[index]?.chance[0] as number;
      expect(read.chance[0], read.name).toBeCloseTo(Math.min(1, 1.5 * before), 12);
    });
    // Clamped (B2's `chanceLowAt`): the low end read may be over the true one, so a rise isn't credited.
    const clamped = {
      ...input,
      readings: input.readings.map((read) => ({ ...read, chance: [read.chance[0], 1] as [number, number] })),
    };
    const atClamped = bladeburnerGrownInput({ ...clamped, forecast }, combat, start);
    atClamped.readings.forEach((read, index) => {
      expect(read.chance[0], read.name).toBeCloseTo(input.readings[index]?.chance[0] as number, 12);
    });
  });
});

describe("the route's grown estimate (#408): the integration", () => {
  test("with no growth, B6's estimate; each growth alone shortens it, and all three most", () => {
    const { combat, input, at } = startAt(300);
    const flat = blackOpsRouteEstimate(input, { ...at, firstToRankSeconds: null });
    const none = blackOpsRouteGrownEstimate(input, at, {
      combat,
      costMultiplier: 1,
      grow: { skills: false, stats: false, levels: false },
    });
    expect(none.seconds / flat.seconds).toBeCloseTo(1, 9);
    expect(none.rate / flat.rate).toBeCloseTo(1, 9);
    const hours = (grow: typeof ALL_GROWTH) =>
      blackOpsRouteGrownEstimate(input, at, { combat, costMultiplier: 1, grow }).seconds / HOUR;
    const skills = hours({ skills: true, stats: false, levels: false });
    const stats = hours({ skills: false, stats: true, levels: false });
    const levels = hours({ skills: false, stats: false, levels: true });
    const all = hours(ALL_GROWTH);
    console.log(
      `combat 300 from rank 0: flat ${(flat.seconds / HOUR).toPrecision(4)} h; the skills alone ` +
        `${skills.toPrecision(4)} h, the stats alone ${stats.toPrecision(4)} h, the levels alone ${levels.toPrecision(4)} h; ` +
        `all three ${all.toPrecision(4)} h`,
    );
    for (const one of [skills, stats, levels]) expect(one).toBeLessThan(flat.seconds / HOUR);
    expect(all).toBeLessThan(Math.min(skills, stats, levels));
  });

  test("its step: the default within 2% of an eighth of it, and short of it (optimistic: B3's buys batched a step at a time)", () => {
    for (const combat of [100, 300]) {
      const { combat: figures, input, at } = startAt(combat);
      const at8 = blackOpsRouteGrownEstimate(input, at, {
        combat: figures,
        costMultiplier: 1,
        fraction: BLADEBURNER_GROWTH_FRACTION / 8,
        leastStep: BLADEBURNER_GROWTH_LEAST_STEP / 8,
      });
      const started = performance.now();
      const route = blackOpsRouteGrownEstimate(input, at, { combat: figures, costMultiplier: 1 });
      const ms = performance.now() - started;
      console.log(
        `combat ${combat}: ${(route.seconds / HOUR).toFixed(2)} h at a step of ${BLADEBURNER_GROWTH_FRACTION} ` +
          `(${route.solves} mixes solved, ${ms.toFixed(0)} ms), ${(at8.seconds / HOUR).toFixed(2)} h at an eighth ` +
          `(${(((route.seconds - at8.seconds) / at8.seconds) * 100).toFixed(2)}%)`,
      );
      expect(Math.abs(route.seconds - at8.seconds) / at8.seconds).toBeLessThan(0.02);
      // Short at both (#409's review): the step's error optimistic, as labelled, though the left sum alone errs long.
      expect(route.seconds).toBeLessThan(at8.seconds);
    }
  });

  test("its cost late on the route (#409's review): a solve from rank 295,000, Centurion next, at combat 1,000", () => {
    const who = personAt(combatOf(1000).exp);
    const levels = {
      "Blade's Intuition": 120,
      "Digital Observer": 100,
      Reaper: 60,
      "Evasive System": 60,
      Overclock: 90,
    };
    const maxLevels = Object.fromEntries(BLADEBURNER_LEVELLED_ACTIONS.map((action) => [action.name, 40]));
    const centurion = BLADEBURNER_BLACK_OPS.find((op) => op.name === "Operation Centurion") as BladeburnerBlackOp;
    const chance = blackOpSuccessChance(centurion, who, { penalty: 1, skills: bladeburnerSkillMultsOf(levels) });
    const at = { rank: 295_000, next: centurion, chanceRead: [chance, chance] as [number, number] };
    const started = performance.now();
    const route = blackOpsRouteGrownEstimate(inputAt(who, levels, maxLevels), at, {
      combat: combatOf(1000),
      costMultiplier: 1,
    });
    const ms = performance.now() - started;
    console.log(
      `late, rank 295,000, combat 1,000: ${(route.seconds / HOUR).toFixed(2)} h, ${route.solves} mixes solved, ` +
        `${ms.toFixed(0)} ms`,
    );
    expect(route.steps[0]?.name).toBe("Operation Centurion");
    expect(Number.isFinite(route.seconds)).toBe(true);
  });

  test("the first one's rank: B5's stock where shorter than the growth's tail; each Black Op's figures at its rank", () => {
    const { combat, input, at } = startAt(300);
    const tail = blackOpsRouteGrownEstimate(input, at, { combat, costMultiplier: 1 });
    const first = tail.steps[0]?.toRankSeconds as number;
    const stocked = blackOpsRouteGrownEstimate(
      input,
      { ...at, firstToRankSeconds: first / 2 },
      { combat, costMultiplier: 1 },
    );
    expect(stocked.steps[0]?.toRankSeconds).toBe(first / 2);
    expect(stocked.seconds).toBeCloseTo(tail.seconds - first / 2, 3);
    const longer = blackOpsRouteGrownEstimate(
      input,
      { ...at, firstToRankSeconds: first * 2 },
      { combat, costMultiplier: 1 },
    );
    expect(longer.seconds).toBe(tail.seconds);
    expect(tail.steps.map((step) => step.name)).toEqual(BLADEBURNER_BLACK_OPS.map((op) => op.name));
    // Each one's chance the formula at its state (the share 1 here); the competence never falls along the route.
    for (const [index, step] of tail.steps.entries()) {
      const op = BLADEBURNER_BLACK_OPS[index] as BladeburnerBlackOp;
      const person = { ...input.person, skills: { ...input.person.skills, ...step.combat } };
      const skills = bladeburnerSkillMultsOf(step.levels);
      expect(step.chance).toBeCloseTo(blackOpSuccessChance(op, person, { penalty: 1, skills }), 12);
      expect(step.seconds).toBe(blackOpSeconds(op, person, skills));
      const before = tail.steps[index - 1];
      if (before !== undefined) {
        for (const stat of COMBAT_STATS) expect(step.combat[stat]).toBeGreaterThanOrEqual(before.combat[stat]);
        expect(step.rate).toBeGreaterThanOrEqual(before.rate);
      }
    }
    // The points read unspent: spent first by B3's rule, so the same route as a reading with them bought.
    const unspent = blackOpsRouteGrownEstimate(input, at, { combat, costMultiplier: 1, points: 300 });
    const bought = chooseBladeburnerSkills(input, { levels: {}, points: 300, costMultiplier: 1 });
    const levels = Object.fromEntries(bought.buys.map((buy) => [buy.skill, buy.to]));
    // The reading with them bought: the next Black Op's chance read at those levels too.
    const typhoon = blackOpSuccessChance(TYPHOON, input.person, {
      penalty: 1,
      skills: bladeburnerSkillMultsOf(levels),
    });
    const atBought = { ...at, chanceRead: [typhoon, typhoon] as [number, number] };
    const spent = blackOpsRouteGrownEstimate(inputAt(input.person, levels), atBought, {
      combat,
      costMultiplier: 1,
      points: 300 - bought.spent,
    });
    expect(bought.spent).toBeGreaterThan(250);
    // Within 0.1%: there the chances are scaled from the levels read, here computed at the levels bought.
    expect(Math.abs(unspent.seconds / spent.seconds - 1)).toBeLessThan(1e-3);
    expect(unspent.seconds).toBeLessThan(tail.seconds);
    // Spent before the first step, not after it: the first step's at the levels bought.
    const firstStep = (route: typeof spent) => route.path[1]?.seconds as number;
    expect(Math.abs(firstStep(unspent) / firstStep(spent) - 1)).toBeLessThan(1e-3);
    // Never with no chance at all (the next one read at 0: its share 0), as B6's.
    const hopeless = blackOpsRouteGrownEstimate(
      { ...input, readings: input.readings.map((read) => ({ ...read, chance: [0, 0] as [number, number] })) },
      { ...at, chanceRead: [0, 0] as [number, number] },
      { combat, costMultiplier: 1 },
    );
    expect(hopeless.seconds).toBe(Number.POSITIVE_INFINITY);
  });
});

/**
 * A seeded walk of the game's attempts from rank 0 at combat `combat` to the `last`-th Black Op done, a check of the
 * integration and the growth's bookkeeping, not of ρ (#409's review): the actions as the tail's mix at the walk's own
 * state works them (the brain's ρ, its policy and its time accounting, inherited; only the hindcasts check ρ), each
 * attempt's success drawn at the game's formula there (the walk's own input: `actionSuccessChance` at its stats,
 * skills and max levels), its rank ±10% uniform (`Bladeburner.ts:951`, `:980`), its experience the game's
 * (`getActionStats`), the stats' levels the game's, a success's max level the game's (`setMaxLevel`), the points the
 * game's from the max rank (`Bladeburner.ts:1284-1293`) spent by B3's rule whenever they cover a level, and each Black
 * Op at its rank attempted at the game's formula, a failure's loss rebuilt by the actions. The mix solved again at each
 * change of a stat's level, a skill or a max level, and each 1% of rank. Its mean time and standard error.
 */
function walk(combat: number, last: number, runs: number, seed: number) {
  const random = seeded(seed);
  const offset = () => 0.9 + 0.2 * random();
  const exp0 = combatOf(combat).exp;
  const times: number[] = [];
  for (let run = 0; run < runs; run++) {
    let rank = 0;
    let maxRank = 0;
    let total = 0;
    let points = 0;
    let time = 0;
    const levels: Record<string, number> = {};
    const exp = { ...exp0 };
    const maxLevels = Object.fromEntries(BLADEBURNER_LEVELLED_ACTIONS.map((action) => [action.name, 1]));
    const successes = Object.fromEntries(BLADEBURNER_LEVELLED_ACTIONS.map((action) => [action.name, 0]));
    let who = personAt(exp);
    let input = inputAt(who, levels, maxLevels);
    let mix = bladeburnerTailMix(input);
    let solveAt = 0;
    const solve = () => {
      who = personAt(exp);
      input = inputAt(who, levels, maxLevels);
      mix = bladeburnerTailMix(input);
      solveAt = rank * 1.01 + 3;
    };
    const changeRank = (by: number) => {
      rank = Math.max(0, rank + by);
      maxRank = Math.max(maxRank, rank);
      const needed = (total + 1) * 3;
      if (maxRank >= needed) {
        const gained = Math.floor((maxRank - needed) / 3 + 1);
        points += gained;
        total += gained;
      }
    };
    for (const op of BLADEBURNER_BLACK_OPS.slice(0, last + 1)) {
      for (;;) {
        while (rank < op.rank) {
          const attempts = mix.work.reduce((sum, part) => sum + part.attemptsPerSecond, 0);
          const resting = mix.rate - mix.work.reduce((sum, part) => sum + part.attemptsPerSecond * part.rise, 0);
          const dt = 1 / attempts;
          time += dt;
          let pick = random() * attempts;
          let part = mix.work.at(-1) as (typeof mix.work)[number];
          for (const each of mix.work) {
            pick -= each.attemptsPerSecond;
            if (pick < 0) {
              part = each;
              break;
            }
          }
          const action = bladeburnerLevelledAction(part.type, part.name) as NonNullable<
            ReturnType<typeof bladeburnerLevelledAction>
          >;
          const gain = actionRankGain(action, part.level, 1);
          const loss = actionRankLoss(action, part.level);
          const success = random() < part.chance;
          const before = COMBAT_STATS.map((stat) => skillLevelOf(exp[stat], SF1_3)).join();
          const diffMult = difficultyMultiplier(actionDifficulty(action, part.level));
          for (const stat of COMBAT_STATS) {
            exp[stat] += part.attemptSeconds * diffMult * action.weights[stat] * (success ? 1 : 0.5) * SF1_3;
          }
          let changed = COMBAT_STATS.map((stat) => skillLevelOf(exp[stat], SF1_3)).join() !== before;
          if (success) {
            successes[part.name] = (successes[part.name] as number) + 1;
            if ((successes[part.name] as number) >= successesForNextLevel(action, maxLevels[part.name] as number)) {
              maxLevels[part.name] = (maxLevels[part.name] as number) + 1;
              changed = true;
            }
            changeRank(gain * offset());
          } else if (loss > 0) changeRank(-loss * offset());
          // The cycle's rest's rank with it, and resting alone's for the rest of the second.
          changeRank(part.rise - (part.chance * gain - (1 - part.chance) * loss) + resting * dt);
          if (points >= cheapestBladeburnerSkillLevel(levels, 1)) {
            const plan = chooseBladeburnerSkills(input, { levels, points, costMultiplier: 1 });
            for (const buy of plan.buys) {
              levels[buy.skill] = buy.to;
              changed = true;
            }
            points -= plan.spent;
          }
          if (changed || rank >= solveAt) solve();
        }
        const skills = bladeburnerSkillMultsOf(levels);
        const chance = blackOpSuccessChance(op, who, { penalty: 1, skills });
        const seconds = blackOpSeconds(op, who, skills);
        time += seconds;
        const success = random() < chance;
        const diffMult = difficultyMultiplier(op.baseDifficulty);
        for (const stat of COMBAT_STATS) {
          exp[stat] += seconds * diffMult * op.weights[stat] * (success ? 1 : 0.5) * SF1_3;
        }
        changeRank(success ? op.rankGain * offset() : -op.rankLoss * offset());
        solve();
        if (success) break;
      }
    }
    times.push(time);
  }
  const mean = times.reduce((a, b) => a + b, 0) / runs;
  const variance = times.reduce((a, b) => a + (b - mean) ** 2, 0) / (runs - 1);
  return { mean, standardError: Math.sqrt(variance / runs) };
}

describe("the grown estimate against a seeded walk of the game's attempts (#408)", () => {
  const check = (combat: number, last: number, runs: number, seed: number) => {
    const { combat: figures, input, at } = startAt(combat);
    const route = blackOpsRouteGrownEstimate(input, at, { combat: figures, costMultiplier: 1 });
    const estimate = route.steps
      .slice(0, last + 1)
      .reduce((sum, step) => sum + step.toRankSeconds + step.attemptsSeconds, 0);
    const { mean, standardError } = walk(combat, last, runs, seed);
    const off = (estimate - mean) / mean;
    console.log(
      `combat ${combat}, rank 0 to ${BLADEBURNER_BLACK_OPS[last]?.name} done: ${(estimate / HOUR).toFixed(2)} h by the ` +
        `estimate; the walk ${(mean / HOUR).toFixed(2)} ± ${(standardError / HOUR).toFixed(2)} h (${runs} runs), ` +
        `${(off * 100).toFixed(2)}%`,
    );
    return { estimate, mean, standardError, off };
  };

  test("combat 100 from rank 0 to Operation Titan done (the stats ×2, the skills and levels all moving): within 3%", () => {
    const { estimate, mean, standardError, off } = check(100, 3, 200, 408);
    // One-sided (#409's review): never short past the walk's noise. The step's own error is short (1.1% here, under
    // 4 SE, 3%); what the walk counts and the estimate leaves out (the Black Ops' own experience; the paths' spread,
    // the whole route 2.8% long) errs long.
    expect(estimate).toBeGreaterThan(mean - 4 * standardError);
    expect(Math.abs(off)).toBeLessThan(0.03);
  }, 60_000);

  test.runIf(process.env.BLADEBURNER_GROWTH_WALK_FULL === "1")(
    "the whole route to Daedalus done, at combat 100 (BLADEBURNER_GROWTH_WALK_FULL=1)",
    () => {
      const { off } = check(100, 20, 40, 4082);
      expect(Math.abs(off)).toBeLessThan(0.1);
      // Measured (#408): 98.25 h against 95.56 ± 1.97 h over 40 walks, +2.8%.
    },
    600_000,
  );
});

const ESPERTECH = "EsperTech Bladeburner Eyewear";
/** The Bladeburners faction's shop, all 18 (B7's). */
const SHOP = () => bladeburnerInstallGain(0, augmentationsSoldBy("Bladeburners", 6, null));
/**
 * Every augmentation in the game with a multiplier the route reads (B7's upper bound: BigD's Big ... Brain among them,
 * sold by no faction in BN6, and none of their prices or reputations counted).
 */
const EVERY = () =>
  bladeburnerInstallGain(
    0,
    Object.keys(AUGMENTATIONS).filter((name) => {
      const { multipliers } = AUGMENTATIONS[name] as { multipliers: Record<string, number> };
      return (
        name !== "NeuroFlux Governor" &&
        [...COMBAT_STATS, "bladeburner_success_chance", "bladeburner_max_stamina", "bladeburner_stamina_gain"].some(
          (key) => (multipliers[key] ?? 1) > 1,
        )
      );
    }),
  );

describe("B7's install choice on the grown estimate (#408): the bias towards installing gone", () => {
  test("EsperTech at combat 300: its share of the route against Training's rebuild: keep", () => {
    const { combat, input, at, who } = startAt(300);
    const gain = bladeburnerInstallGain(0, [ESPERTECH]);
    const growth = { costMultiplier: 1 };
    const timing = blackOpsInstallTiming({ input, at, combat, gain, installable: true, growth });
    // Its value alone (B7's): the route after an install of nothing against one of it, the rebuild common to both.
    const [value] = bladeburnerAugmentationValues({ input, at, combat, growth, augmentations: [ESPERTECH] });
    const saved = value?.savedSeconds as number;
    const nothing = blackOpsRouteGrownEstimate(
      { ...input, forecast: bladeburnerPersonAfterInstall(who, NO_INSTALL_GAIN) },
      at,
      { combat, costMultiplier: 1 },
    ).seconds;
    expect(nothing - saved).toBeCloseTo(timing.afterSeconds, 3);
    console.log(
      `combat 300, EsperTech: keep ${(timing.keepSeconds / HOUR).toFixed(2)} h; install now ` +
        `${(timing.rebuildSeconds / HOUR).toFixed(2)} h + ${(timing.afterSeconds / HOUR).toFixed(2)} h; it saves ` +
        `${(saved / HOUR).toFixed(2)} h (${((saved / nothing) * 100).toFixed(1)}% of the route) against the ` +
        `rebuild's ${(timing.rebuildSeconds / HOUR).toFixed(2)} h`,
    );
    // Its value is within the estimate's own step (2%; B6's 7% was the flat route's share), far under the rebuild.
    expect(Math.abs(saved)).toBeLessThan(0.02 * nothing);
    expect(timing.rebuildSeconds).toBeGreaterThan(10 * Math.abs(saved));
    expect(timing.choice).toBe("keep");
  });

  test("#406's rule (#409's review): installing must beat keeping by more than the step's error of their difference", () => {
    const gain = bladeburnerInstallGain(0, [ESPERTECH]);
    const fine = { fraction: BLADEBURNER_GROWTH_FRACTION / 8, leastStep: BLADEBURNER_GROWTH_LEAST_STEP / 8 };
    const growth = { costMultiplier: 1 };
    const rows: string[] = [];
    for (const [combat, chosen] of [
      [100, "install"],
      [108, "keep"],
    ] as const) {
      const { combat: figures, input, at, who } = startAt(combat);
      const started = performance.now();
      const timing = blackOpsInstallTiming({ input, at, combat: figures, gain, installable: true, growth });
      const ms = performance.now() - started;
      // The paired difference at an eighth of the step, worked out here: both sides' estimates.
      const keep8 = blackOpsRouteGrownEstimate(input, at, { combat: figures, costMultiplier: 1, ...fine }).seconds;
      const after8 = blackOpsRouteGrownEstimate({ ...input, forecast: bladeburnerPersonAfterInstall(who, gain) }, at, {
        combat: combatAfter(figures, gain),
        costMultiplier: 1,
        ...fine,
      }).seconds;
      const difference = timing.keepSeconds - (timing.installNowSeconds as number);
      const margin = Math.abs(difference - (keep8 - (timing.rebuildSeconds + after8)));
      rows.push(
        `combat ${combat}, EsperTech: keep − install now ${(difference / 60).toFixed(1)} min, its error at the step ` +
          `${(margin / 60).toFixed(1)} min: ${timing.choice} (the choice in ${ms.toFixed(0)} ms)`,
      );
      // Installing leads at the step on both sides: the rule decides.
      expect(difference).toBeGreaterThan(0);
      expect(timing.marginSeconds).toBeCloseTo(margin, 3);
      expect(timing.choice).toBe(chosen);
      expect(difference > margin).toBe(chosen === "install");
    }
    console.log(rows.join("\n"));
    // Keeping leads (combat 300): no error measured, kept.
    const { combat: figures, input, at } = startAt(300);
    const kept = blackOpsInstallTiming({ input, at, combat: figures, gain, installable: true, growth });
    expect(kept).toMatchObject({ marginSeconds: null, choice: "keep" });
  });

  test("the shop at combat 100: a rebuild of half an hour against the route it saves: install", () => {
    const { combat, input, at } = startAt(100);
    const gain = SHOP();
    const timing = blackOpsInstallTiming({ input, at, combat, gain, installable: true, growth: { costMultiplier: 1 } });
    expect(timing.rebuildSeconds).toBeCloseTo(bladeburnerRebuildSeconds(combat, { gain, fromZero: true }).seconds, 6);
    expect(timing.installNowSeconds).toBeCloseTo(timing.rebuildSeconds + timing.afterSeconds, 6);
    expect(timing.choice).toBe("install");
    console.log(
      `combat 100, the shop: keep ${(timing.keepSeconds / HOUR).toFixed(2)} h; install now ` +
        `${(timing.rebuildSeconds / HOUR).toFixed(2)} h + ${(timing.afterSeconds / HOUR).toFixed(2)} h`,
    );
  });
});

describe("BN6's playability by the grown estimate (#408): within ×2 of the slowest destroy so far, or not", () => {
  /** The bar: BN4.1's 27 h 5 min online, the slowest destroy in the campaign report (2026-11-12), twice. */
  const BAR_SECONDS = 2 * (27 * 3600 + 5 * 60);

  test("at B7's BN6.1 states (rank 0, combat 100 and 300): as is and with the shop past the bar, so unplayable", () => {
    const rows: string[] = [];
    for (const combat of [100, 300]) {
      const { combat: figures, input, at } = startAt(combat);
      const keep = blackOpsRouteGrownEstimate(input, at, { combat: figures, costMultiplier: 1 }).seconds;
      const shop = blackOpsInstallTiming({
        input,
        at,
        combat: figures,
        gain: SHOP(),
        installable: true,
        growth: { costMultiplier: 1 },
      });
      const every = blackOpsInstallTiming({
        input,
        at,
        combat: figures,
        gain: EVERY(),
        installable: true,
        growth: { costMultiplier: 1 },
      });
      const shopNow = shop.installNowSeconds as number;
      const everyNow = every.installNowSeconds as number;
      rows.push(
        `combat ${combat}: as is ${(keep / HOUR).toFixed(1)} h; the shop ${(shopNow / HOUR).toFixed(1)} h ` +
          `(rebuild ${(shop.rebuildSeconds / HOUR).toFixed(2)} h); every one ${(everyNow / HOUR).toFixed(1)} h ` +
          `(rebuild ${(every.rebuildSeconds / HOUR).toFixed(2)} h)`,
      );
      expect(keep).toBeGreaterThan(BAR_SECONDS);
      expect(Math.min(keep, shopNow)).toBeGreaterThan(BAR_SECONDS);
    }
    console.log(`${rows.join("\n")}\nthe bar ${(BAR_SECONDS / HOUR).toFixed(2)} h`);
  });
});

describe("BN7's playability by the grown estimate (#411): the same route at its own multipliers, against the same bar", () => {
  /** The bar: BN4.1's 27 h 5 min online, the slowest destroy in the campaign report (2026-11-12), twice. */
  const BAR_SECONDS = 2 * (27 * 3600 + 5 * 60);

  test("at a BN7.1 start (rank 0, combat 100 and 300), rank ×0.6 and skills ×2: as is, the shop and every one", () => {
    const rankMultiplier = bladeburnerRankMultiplierOf(7) as number;
    const costMultiplier = bladeburnerSkillCostMultiplierOf(7) as number;
    expect([rankMultiplier, costMultiplier]).toEqual([0.6, 2]);
    const growth = { costMultiplier };
    const rows: string[] = [];
    for (const combat of [100, 300]) {
      const { combat: figures, input: read, at } = startAt(combat);
      const input = { ...read, rankMultiplier };
      const started = performance.now();
      const route = blackOpsRouteGrownEstimate(input, at, { combat: figures, costMultiplier });
      const ms = performance.now() - started;
      const bn6 = blackOpsRouteGrownEstimate(read, at, { combat: figures, costMultiplier: 1 }).seconds;
      const rankAlone = blackOpsRouteGrownEstimate(input, at, { combat: figures, costMultiplier: 1 }).seconds;
      const costAlone = blackOpsRouteGrownEstimate(read, at, { combat: figures, costMultiplier }).seconds;
      const choosing = performance.now();
      const shop = blackOpsInstallTiming({
        input,
        at,
        combat: figures,
        gain: bladeburnerInstallGain(0, augmentationsSoldBy("Bladeburners", 7, null)),
        installable: true,
        growth,
      });
      const choiceMs = performance.now() - choosing;
      // B7's choice with #406's margin: installing only where it beats keeping by more than the step's error.
      const shopSeconds = shop.choice === "install" ? (shop.installNowSeconds as number) : shop.keepSeconds;
      const every = blackOpsInstallTiming({ input, at, combat: figures, gain: EVERY(), installable: true, growth });
      const everyNow = every.installNowSeconds as number;
      rows.push(
        `combat ${combat}: as is ${(route.seconds / HOUR).toFixed(1)} h (BN6's ${(bn6 / HOUR).toFixed(1)} h, the rank alone ` +
          `${(rankAlone / HOUR).toFixed(1)} h, the skills alone ${(costAlone / HOUR).toFixed(1)} h); ` +
          `the shop ${shop.choice} ${(shopSeconds / HOUR).toFixed(1)} h (keep ${(shop.keepSeconds / HOUR).toFixed(1)} h, ` +
          `install now ${((shop.installNowSeconds as number) / HOUR).toFixed(1)} h, its rebuild ` +
          `${(shop.rebuildSeconds / HOUR).toFixed(2)} h, the margin ${((shop.marginSeconds ?? 0) / 60).toFixed(1)} min); ` +
          `every one ${(everyNow / HOUR).toFixed(1)} h (rebuild ${(every.rebuildSeconds / HOUR).toFixed(2)} h); ` +
          `a solve ${ms.toFixed(0)} ms, ${route.solves} mixes; the shop's choice ${choiceMs.toFixed(0)} ms`,
      );
      // Each of BN7's multipliers on the route only lengthens it, alone and together: BN6's at the same state shortest.
      expect(rankAlone).toBeGreaterThan(bn6);
      expect(costAlone).toBeGreaterThan(bn6);
      expect(route.seconds).toBeGreaterThan(Math.max(rankAlone, costAlone));
      expect(route.seconds).toBeGreaterThan(BAR_SECONDS);
      expect(shopSeconds).toBeGreaterThan(BAR_SECONDS);
    }
    console.log(`${rows.join("\n")}\nthe bar ${(BAR_SECONDS / HOUR).toFixed(2)} h`);
  });
});
