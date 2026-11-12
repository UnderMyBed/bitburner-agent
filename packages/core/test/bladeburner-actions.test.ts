// Bladeburner B2 (#375): the actions' figures checked against the pinned game's source, the formulas worked by hand,
// and the rule's choice of work, level and rest by rank a second. The parity against the engine itself is the
// simulator's (packages/brain/test/bladeburner-parity.test.ts).
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  actionDifficulty,
  actionHpLoss,
  actionMoney,
  actionRankGain,
  actionRankLoss,
  actionSeconds,
  actionStaminaCost,
  actionSuccessChance,
  actionSuccessRange,
  attemptRankMoments,
  BLADEBURNER_CONTRACTS,
  BLADEBURNER_LEVELLED_ACTIONS,
  BLADEBURNER_OPERATIONS,
  BLADEBURNER_READING_SECONDS,
  BLADEBURNER_REST_SECONDS,
  type BladeburnerActionReading,
  type BladeburnerPerson,
  bladeburnerLevelledAction,
  bladeburnerPersonOf,
  bladeburnerRankMultiplierOf,
  bladeburnerResting,
  bladeburnerRests,
  chanceLowAt,
  chaosDifficultyFactor,
  chooseBladeburnerAction,
  countGrowthPerSecond,
  difficultyMultiplier,
  FIELD_ANALYSIS,
  fieldAnalysisRank,
  maxStaminaOf,
  populationSuccessFactor,
  REGENERATION_CHAMBER,
  staminaGainPerSecond,
  staminaPenalty,
  successesForNextLevel,
  trainingExpPerAttempt,
} from "../src/bladeburner-actions.ts";

const gameSource = (file: string) =>
  readFileSync(new URL(`../../../vendor/bitburner-src/src/${file}`, import.meta.url), "utf8");

/** A player as BN6's division takes one: the four combat stats at `combat`, hacking and charisma 1, no intelligence. */
function person(combat = 100, overrides: Partial<BladeburnerPerson["skills"]> = {}): BladeburnerPerson {
  return {
    skills: {
      hacking: 1,
      strength: combat,
      defense: combat,
      dexterity: combat,
      agility: combat,
      charisma: 1,
      intelligence: 0,
      ...overrides,
    },
    mults: { bladeburner_success_chance: 1, bladeburner_max_stamina: 1, bladeburner_stamina_gain: 1 },
  };
}

const TRACKING = BLADEBURNER_CONTRACTS[0] as (typeof BLADEBURNER_CONTRACTS)[number];
const CITY = { population: 1e9, communities: 50, chaos: 0 };

/** Each action read at level 1 of max `maxLevel`, its count `count`, the range collapsed on the chance at CITY. */
function readingsFor(
  who: BladeburnerPerson,
  { maxLevel = 1, count = 100, penalty = 1 } = {},
): BladeburnerActionReading[] {
  return BLADEBURNER_LEVELLED_ACTIONS.map((action) => {
    const chance = actionSuccessChance(action, 1, who, { city: CITY, penalty });
    return { type: action.type, name: action.name, level: 1, maxLevel, count, chance: [chance, chance] };
  });
}

describe("the game's facts", () => {
  test("every contract's and operation's figures are its data file's", () => {
    const files = {
      Contracts: gameSource("Bladeburner/data/Contracts.ts"),
      Operations: gameSource("Bladeburner/data/Operations.ts"),
    };
    expect(BLADEBURNER_CONTRACTS.map((each) => each.name)).toEqual(["Tracking", "Bounty Hunter", "Retirement"]);
    expect(BLADEBURNER_OPERATIONS.map((each) => each.name)).toEqual([
      "Investigation",
      "Undercover Operation",
      "Sting Operation",
      "Raid",
      "Stealth Retirement Operation",
      "Assassination",
    ]);
    const enums = gameSource("Bladeburner/Enums.ts");
    for (const action of BLADEBURNER_LEVELLED_ACTIONS) {
      expect(enums).toContain(` = "${action.name}",`);
      const file = files[action.type];
      // The action's own block: from its enum key's `name:` line to the next action's.
      const key = [...enums.matchAll(/ {2}(\w+) = "([^"]+)",/g)].find((match) => match[2] === action.name)?.[1];
      const from = file.indexOf(
        `name: Bladeburner${action.type === "Contracts" ? "Contract" : "Operation"}Name.${key},`,
      );
      expect(from, action.name).toBeGreaterThan(0);
      const rest = file.slice(from + 1);
      const block = rest.slice(0, rest.search(/\n {4}\[Bladeburner/) + 1 || undefined);
      const field = (name: string, value: number) =>
        value === 0
          ? expect(block, `${action.name}'s ${name}`).not.toMatch(new RegExp(`\\n {6}${name}:`))
          : expect(block, `${action.name}'s ${name}`).toContain(`\n      ${name}: ${value},`);
      field("baseDifficulty", action.baseDifficulty);
      field("difficultyFac", action.difficultyFac);
      field("rewardFac", action.rewardFac);
      field("rankGain", action.rankGain);
      field("rankLoss", action.rankLoss);
      field("hpLoss", action.hpLoss);
      for (const [table, values] of [
        ["weights", action.weights],
        ["decays", action.decays],
      ] as const) {
        const lines = Object.entries(values)
          .map(([stat, value]) => `        ${stat}: ${value},`)
          .join("\n");
        expect(block, `${action.name}'s ${table}`).toContain(`      ${table}: {\n${lines}\n      },`);
      }
      expect(block.includes("isStealth: true,"), `${action.name}'s stealth`).toBe(action.isStealth);
      expect(block.includes("isKill: true,"), `${action.name}'s kill`).toBe(action.isKill);
      expect(block).toContain(
        `growthFunction: () => getRandomIntInclusive(${action.growth[0]}, ${action.growth[1]}) / 10,`,
      );
    }
    // The defaults the data leaves out (`Actions/Action.ts:35-37`): no rank lost, no HP lost.
    expect(gameSource("Bladeburner/Actions/Action.ts")).toContain("  rankLoss = 0;\n  hpLoss = 0;");
    expect(bladeburnerLevelledAction("Operations", "Raid")?.rankGain).toBe(55);
    expect(bladeburnerLevelledAction("Contracts", "Raid")).toBeNull();
  });

  test("the constants, the rests' times and the BitNodes' rank multipliers are the game's", () => {
    const constants = gameSource("Bladeburner/data/Constants.ts");
    for (const line of [
      "StaminaGainPerSecond: 0.0085,",
      "BaseStaminaLoss: 0.285,",
      "MaxStaminaToGainFactor: 70000,",
      "DifficultyToTimeFactor: 10,",
      "DiffMultExponentialFactor: 0.28,",
      "DiffMultLinearFactor: 650,",
      "EffAgiLinearFactor: 10e3,",
      "EffDexLinearFactor: 10e3,",
      "EffAgiExponentialFactor: 0.04,",
      "EffDexExponentialFactor: 0.035,",
      "PopulationThreshold: 1e9,",
      "PopulationExponent: 0.7,",
      "ChaosThreshold: 50,",
      "ActionCountGrowthPeriod: 480,",
      "ContractSuccessesPerLevel: 3,",
      "OperationSuccessesPerLevel: 2.5,",
      "ContractBaseMoneyGain: 250e3,",
      "HrcStaminaGain: 1,",
    ]) {
      expect(constants).toContain(line);
    }
    const general = gameSource("Bladeburner/data/GeneralActions.ts");
    for (const [name, key] of [
      [FIELD_ANALYSIS, "FieldAnalysis"],
      [REGENERATION_CHAMBER, "HyperbolicRegen"],
      ["Training", "Training"],
    ] as const) {
      expect(general).toMatch(
        new RegExp(
          `name: BladeburnerGeneralActionName\\.${key},\\n {4}getActionTime: \\(\\) => ${BLADEBURNER_REST_SECONDS[name]},`,
        ),
      );
    }
    expect(gameSource("Bladeburner/Bladeburner.ts")).toContain("seconds = Math.min(seconds, 5); // Max of 5 'ticks'");
    const bitNodes = gameSource("BitNode/BitNode.tsx");
    expect(bitNodes).toMatch(/case 7: \{[^}]*BladeburnerRank: 0\.6,/);
    expect(bitNodes).not.toMatch(/case 6: \{[^}]*BladeburnerRank/);
    expect(bladeburnerRankMultiplierOf(6)).toBe(1);
    expect(bladeburnerRankMultiplierOf(7)).toBe(0.6);
    expect(bladeburnerRankMultiplierOf(1)).toBeNull();
  });

  test("the formulas' lines are the game's", () => {
    const action = gameSource("Bladeburner/Actions/Action.ts");
    expect(action).toContain("competence *= calculateIntelligenceBonus(person.skills.intelligence, 0.75);");
    expect(action).toContain("competence *= inst.calculateStaminaPenalty();");
    expect(action).toContain("return Math.min(1, competence / difficulty);");
    expect(action).toContain("const diff = 1 + (city.chaos - BladeburnerConstants.ChaosThreshold);");
    expect(action).toContain("baseTime = Math.max(1, (baseTime * skillFac) / statFac);");
    expect(gameSource("PersonObjects/formulas/intelligence.ts")).toContain(
      "return 1 + (weight * Math.pow(intelligence, 0.8)) / 600;",
    );
    expect(gameSource("Bladeburner/Actions/LevelableAction.ts")).toContain(
      "return Math.ceil(0.5 * this.maxLevel * (2 * baseSuccessesPerLevel + (this.maxLevel - 1)));",
    );
    const bladeburner = gameSource("Bladeburner/Bladeburner.ts");
    expect(bladeburner).toContain("return Math.min(1, this.stamina / (0.5 * this.maxStamina));");
    expect(bladeburner).toContain("const gain = addOffset(calculateActionRankGain(action), 10);");
    expect(bladeburner).toContain("loss = addOffset(calculateActionRankLoss(action), 10);");
    expect(bladeburner).toContain("this.stamina -= 0.5 * BladeburnerConstants.BaseStaminaLoss;");
    expect(bladeburner).toContain("const strExpGain = 30 * person.mults.strength_exp,");
    expect(gameSource("PersonObjects/Person.ts")).toContain(
      "this.gainStrengthExp(retValue.strExp * this.mults.strength_exp);",
    );
    expect(bladeburner).toContain('const baseStamina = Math.pow(this.getEffectiveSkillLevel(Player, "agility"), 0.8);');
    expect(bladeburner).toContain(
      "const gain = (BladeburnerConstants.StaminaGainPerSecond + maxStaminaBonus) * Math.pow(effAgility, 0.17);",
    );
    expect(gameSource("Bladeburner/Formulas.ts")).toContain("return 0.1 * currentNodeMults.BladeburnerRank;");
  });
});

describe("the formulas, worked by hand", () => {
  test("Tracking at combat 100, charisma 1: competence 0.8 × 100^0.91 + 0.1, over 125: 42.4%", () => {
    const competence = 0.8 * 100 ** 0.91 + 0.1;
    expect(competence).toBeCloseTo(52.955, 3);
    expect(actionSuccessChance(TRACKING, 1, person(), { city: CITY, penalty: 1 })).toBeCloseTo(competence / 125, 12);
    // Level 3: the difficulty × 1.02².
    expect(actionDifficulty(TRACKING, 3)).toBeCloseTo(125 * 1.02 ** 2, 12);
    expect(actionSuccessChance(TRACKING, 3, person(), { city: CITY, penalty: 1 })).toBeCloseTo(
      competence / (125 * 1.02 ** 2),
      12,
    );
    // The penalty, the population and the chaos: half stamina's ½, 2e9's 2^0.7, chaos 59's √10.
    expect(
      actionSuccessChance(TRACKING, 1, person(), {
        city: { population: 2e9, communities: 1, chaos: 59 },
        penalty: 0.5,
      }),
    ).toBeCloseTo((competence * 0.5 * 2 ** 0.7) / (125 * Math.sqrt(10)), 12);
    // Intelligence 100's bonus: 1 + 0.75 × 100^0.8 / 600; its weight 0.05 × 100^1.
    expect(
      actionSuccessChance(TRACKING, 1, person(100, { intelligence: 100 }), { city: CITY, penalty: 1 }),
    ).toBeCloseTo(((competence + 5) * (1 + (0.75 * 100 ** 0.8) / 600)) / 125, 12);
    // Capped at 1.
    expect(actionSuccessChance(TRACKING, 1, person(1000), { city: CITY, penalty: 1 })).toBe(1);
    // Raid with no communities: 0.
    const raid = bladeburnerLevelledAction("Operations", "Raid");
    if (raid === null) throw new Error("no Raid");
    expect(actionSuccessChance(raid, 1, person(1000), { city: { ...CITY, communities: 0 }, penalty: 1 })).toBe(0);
    expect(chaosDifficultyFactor(50)).toBe(1);
    expect(chaosDifficultyFactor(51)).toBeCloseTo(Math.SQRT2, 12);
    expect(populationSuccessFactor(1e9)).toBe(1);
    expect(staminaPenalty(10, 40)).toBe(0.5);
    expect(staminaPenalty(30, 40)).toBe(1);
  });

  test("the estimate's range: real ± |real − est|, the low end × pop/popEst below 1, the high end above", () => {
    // Overestimated (popEst > pop): low = (2·real − est) × pop/popEst.
    expect(actionSuccessRange(0.4, 0.5, 1e9, 1.25e9)).toEqual([expect.closeTo(0.3 * 0.8, 12), expect.closeTo(0.5, 12)]);
    // Underestimated: low = est, high = (2·real − est) × pop/popEst, clamped at 1.
    expect(actionSuccessRange(0.5, 0.4, 1.25e9, 1e9)).toEqual([expect.closeTo(0.4, 12), expect.closeTo(0.75, 12)]);
    expect(actionSuccessRange(0.8, 0.4, 2e9, 1e9)).toEqual([expect.closeTo(0.4, 12), 1]);
    // Exact: one figure.
    expect(actionSuccessRange(0.4, 0.4, 1e9, 1e9)).toEqual([0.4, 0.4]);
    // No estimate (0): the ratio Infinity, the high end clamped.
    expect(actionSuccessRange(0.4, 0, 1e9, 0)).toEqual([0, 1]);
  });

  test("time: ⌈12.5 / statFac⌉ = 11 s for Tracking at 100; at least 1 s", () => {
    const statFac = 0.5 * (100 ** 0.04 + 100 ** 0.035 + 100 / 10e3 + 100 / 10e3);
    expect(statFac).toBeCloseTo(1.19858, 5);
    expect(actionSeconds(TRACKING, 1, person())).toBe(Math.ceil(12.5 / statFac));
    expect(actionSeconds(TRACKING, 1, person())).toBe(11);
    expect(actionSeconds(TRACKING, 1, person(1e9))).toBe(1);
    const assassination = bladeburnerLevelledAction("Operations", "Assassination");
    if (assassination === null) throw new Error("no Assassination");
    expect(actionSeconds(assassination, 2, person())).toBe(Math.ceil((1500 * 1.06) / 10 / statFac));
  });

  test("rank, money, stamina, HP and levels", () => {
    expect(actionRankGain(TRACKING, 1, 1)).toBe(0.3);
    expect(actionRankGain(TRACKING, 4, 0.6)).toBeCloseTo(0.3 * 1.041 ** 3 * 0.6, 12);
    const raid = bladeburnerLevelledAction("Operations", "Raid");
    if (raid === null) throw new Error("no Raid");
    // Loss isn't BitNode-scaled.
    expect(actionRankLoss(raid, 2)).toBeCloseTo(2.5 * 1.1, 12);
    expect(actionRankLoss(TRACKING, 5)).toBe(0);
    expect(actionMoney(TRACKING, 3)).toBeCloseTo(250e3 * 1.041 ** 2, 6);
    expect(actionMoney(raid, 3)).toBe(0);
    const diffMult = 125 ** 0.28 + 125 / 650;
    expect(difficultyMultiplier(125)).toBeCloseTo(diffMult, 12);
    expect(actionStaminaCost(TRACKING, 1)).toBeCloseTo(0.285 * diffMult, 12);
    expect(actionStaminaCost(TRACKING, 1)).toBeCloseTo(1.1563, 4);
    expect(actionHpLoss(raid, 1)).toBeCloseTo(50 * (800 ** 0.28 + 800 / 650), 12);
    // Level 2 after ⌈½·1·(2·3 + 0)⌉ = 3 successes for a contract, 3 (2.5 rounded up) for an operation; level 3 after 7
    // and 6.
    expect(successesForNextLevel(TRACKING, 1)).toBe(3);
    expect(successesForNextLevel(TRACKING, 2)).toBe(7);
    expect(successesForNextLevel(raid, 1)).toBe(3);
    expect(successesForNextLevel(raid, 2)).toBe(6);
    expect(countGrowthPerSecond(TRACKING)).toBeCloseTo(4 / 480, 12);
    expect(countGrowthPerSecond(raid)).toBeCloseTo(2.1 / 480, 12);
  });

  test("stamina: 100^0.8 = 39.8 max, (0.0085 + max/70,000) × 100^0.17 a second; Training's experience × mult²", () => {
    const max = 100 ** 0.8;
    expect(maxStaminaOf(person(), 0)).toBeCloseTo(max, 12);
    expect(maxStaminaOf(person(), 2)).toBeCloseTo(max + 2, 12);
    expect(staminaGainPerSecond(person(), max)).toBeCloseTo((0.0085 + max / 70_000) * 100 ** 0.17, 15);
    expect(staminaGainPerSecond(person(), max)).toBeCloseTo(0.01984, 5);
    const boosted = {
      ...person(),
      mults: { ...person().mults, bladeburner_max_stamina: 1.5, bladeburner_stamina_gain: 2 },
    };
    expect(maxStaminaOf(boosted, 0)).toBeCloseTo(max * 1.5, 12);
    expect(staminaGainPerSecond(boosted, max)).toBeCloseTo(2 * (0.0085 + max / 70_000) * 100 ** 0.17, 15);
    // SF1.3's 1.28: 30 × 1.28 × 1.28, the quirk.
    expect(trainingExpPerAttempt(1.28)).toBeCloseTo(49.152, 12);
    expect(fieldAnalysisRank(0.6)).toBeCloseTo(0.06, 15);
  });

  test("an attempt's rank: a success's gain against a failure's loss, each ±10% uniform", () => {
    const { mean, variance } = attemptRankMoments(0.5, 2, 1);
    expect(mean).toBeCloseTo(0.5, 15);
    // E[X²] = (½·4 + ½·1)(1 + 0.01/3); less the mean squared.
    expect(variance).toBeCloseTo(2.5 * (1 + 0.01 / 3) - 0.25, 12);
    // Sure success: only the offset's spread, (g·0.1)²/3.
    expect(attemptRankMoments(1, 3, 0).variance).toBeCloseTo((0.3 * 0.3) / 3, 12);
  });

  test("the low end at another level: over the penalty, × fac^(read − level), at most 1", () => {
    const read: BladeburnerActionReading = {
      type: "Contracts",
      name: "Tracking",
      level: 3,
      maxLevel: 5,
      count: 10,
      chance: [0.3, 0.5],
    };
    expect(chanceLowAt(TRACKING, read, 3, 1)).toBeCloseTo(0.3, 15);
    expect(chanceLowAt(TRACKING, read, 5, 1)).toBeCloseTo(0.3 / 1.02 ** 2, 15);
    expect(chanceLowAt(TRACKING, read, 1, 1)).toBeCloseTo(0.3 * 1.02 ** 2, 15);
    // Read at a quarter of the max stamina: the penalty ½ taken out.
    expect(chanceLowAt(TRACKING, read, 3, 0.5)).toBeCloseTo(0.6, 15);
    // Read at 1: a bound from below at higher levels, and 1 at lower ones.
    expect(chanceLowAt(TRACKING, { ...read, chance: [1, 1] }, 4, 1)).toBeCloseTo(1 / 1.02, 15);
    expect(chanceLowAt(TRACKING, { ...read, chance: [1, 1] }, 1, 1)).toBe(1);
    expect(chanceLowAt(TRACKING, read, 3, 0)).toBeNull();
  });

  test("the rests: Field Analysis's rank, the Chamber's 1% a minute, Training's 0.1425 each 30 s spent", () => {
    const [field, chamber, training] = bladeburnerRests(0.02, 40, 1);
    expect(field).toEqual({ name: FIELD_ANALYSIS, staminaPerSecond: 0.02, rankPerSecond: 0.1 / 30 });
    expect(chamber).toEqual({ name: REGENERATION_CHAMBER, staminaPerSecond: 0.02 + 0.4 / 60, rankPerSecond: 0 });
    expect(training?.staminaPerSecond).toBeCloseTo(0.02 - 0.1425 / 30, 15);
  });

  test("the player's figures from the medium snapshot, or null with one missing", () => {
    const player = {
      skills: { ...person().skills },
      mults: { ...person().mults, strength_exp: 1.28 },
      money: 1,
    };
    expect(bladeburnerPersonOf(player)).toMatchObject({ skills: person().skills, mults: { strength_exp: 1.28 } });
    expect(bladeburnerPersonOf({ ...player, skills: { ...player.skills, charisma: "x" } })).toBeNull();
    expect(bladeburnerPersonOf({ skills: player.skills })).toBeNull();
    expect(bladeburnerPersonOf(null)).toBeNull();
  });
});

describe("the rule's choice (#375): the most rank a second over a cycle of work and rest", () => {
  test("at combat 100: Bounty Hunter over Tracking, lighter on stamina, with Field Analysis to rest", () => {
    const who = person();
    const max = maxStaminaOf(who, 0);
    const plan = chooseBladeburnerAction({
      readings: readingsFor(who),
      person: who,
      stamina: max,
      maxStamina: max,
      rankMultiplier: 1,
      speed: 1,
    });
    // By hand, each worked from ½ max and rested with Field Analysis (0.1 each 30 s): the time worked is the regain
    // over the work's drain (its stamina over its time) ...
    const regain = (0.0085 + max / 70_000) * 100 ** 0.17;
    const cycle = (chance: number, gain: number, seconds: number, difficulty: number) => {
      const rate = (chance * gain) / seconds;
      const drain = (0.285 * (difficulty ** 0.28 + difficulty / 650)) / seconds;
      const duty = regain / drain;
      return { rate, duty, rankPerSecond: duty * rate + ((1 - duty) * 0.1) / 30 };
    };
    // ... Tracking: 42.4% for 0.3 over 11 s; Bounty Hunter: the same competence over 250, 21% for 0.9 over 21 s.
    const competence = 0.8 * 100 ** 0.91 + 0.1;
    const tracking = cycle(competence / 125, 0.3, 11, 125);
    const bountyHunter = cycle(competence / 250, 0.9, 21, 250);
    expect(tracking.rate).toBeGreaterThan(bountyHunter.rate);
    expect(bountyHunter.rankPerSecond).toBeGreaterThan(tracking.rankPerSecond);
    expect(plan.work).toMatchObject({ type: "Contracts", name: "Bounty Hunter", level: 1, seconds: 21 });
    expect(plan.work?.chance).toBeCloseTo(competence / 250, 12);
    expect(plan.work?.rankPerSecond).toBeCloseTo(bountyHunter.rate, 12);
    expect(plan.rest.name).toBe(FIELD_ANALYSIS);
    expect(plan.duty).toBeCloseTo(bountyHunter.duty, 12);
    expect(plan.duty).toBeCloseTo(0.288, 3);
    expect(plan.rankPerSecond).toBeCloseTo(bountyHunter.rankPerSecond, 12);
    // The Chamber's cycle: more work (1% of the max a minute more), no rank while resting; less.
    const drain = (0.285 * (250 ** 0.28 + 250 / 650)) / 21 - regain;
    const chamberDuty = (regain + max / 100 / 60) / (drain + regain + max / 100 / 60);
    expect(plan.rankPerSecond).toBeGreaterThan(chamberDuty * bountyHunter.rate);
    expect(plan.regain).toBeCloseTo(regain, 15);
    // Raid: 4% for 55 against 96% for 2.5 lost, a loss; never chosen.
    const raid = bladeburnerLevelledAction("Operations", "Raid");
    if (raid === null) throw new Error("no Raid");
    const raidChance = actionSuccessChance(raid, 1, who, { city: CITY, penalty: 1 });
    expect(attemptRankMoments(raidChance, 55, 2.5).mean).toBeLessThan(0);
  });

  test("the level: Tracking's rate rises with its level here (1.041 against 1.02), up to its max", () => {
    const who = person();
    const max = maxStaminaOf(who, 0);
    const plan = chooseBladeburnerAction({
      readings: readingsFor(who, { maxLevel: 3 }).filter((each) => each.name === "Tracking"),
      person: who,
      stamina: max,
      maxStamina: max,
      rankMultiplier: 1,
      speed: 1,
    });
    expect(plan.work).toMatchObject({ name: "Tracking", level: 3 });
    expect(plan.work?.chance).toBeCloseTo(
      actionSuccessChance(TRACKING, 1, who, { city: CITY, penalty: 1 }) / 1.02 ** 2,
      12,
    );
  });

  test("the counts: an action needs 1 + 10 s of attempts (× 5 with bonus time); none left, rest alone", () => {
    const who = person();
    const max = maxStaminaOf(who, 0);
    const choose = (count: number, speed = 1) =>
      chooseBladeburnerAction({
        readings: readingsFor(who)
          .filter((each) => each.name === "Tracking")
          .map((each) => ({ ...each, count })),
        person: who,
        stamina: max,
        maxStamina: max,
        rankMultiplier: 1,
        speed,
      }).work?.name;
    expect(BLADEBURNER_READING_SECONDS).toBe(10);
    expect(choose(1 + 10 / 11)).toBe("Tracking");
    expect(choose(1 + 10 / 11 - 1e-9)).toBeUndefined();
    expect(choose(1 + 50 / 11, 5)).toBe("Tracking");
    expect(choose(1 + 50 / 11 - 1e-9, 5)).toBeUndefined();
    const none = chooseBladeburnerAction({
      readings: readingsFor(who, { count: 0.5 }),
      person: who,
      stamina: max,
      maxStamina: max,
      rankMultiplier: 1,
      speed: 1,
    });
    expect(none).toMatchObject({ work: null, rest: { name: FIELD_ANALYSIS }, duty: 0 });
    expect(none.rankPerSecond).toBeCloseTo(0.1 / 30, 15);
  });

  test("read at a quarter of the stamina, the penalty's taken out: the same choice and chance", () => {
    const who = person();
    const max = maxStaminaOf(who, 0);
    const full = chooseBladeburnerAction({
      readings: readingsFor(who),
      person: who,
      stamina: max,
      maxStamina: max,
      rankMultiplier: 1,
      speed: 1,
    });
    const tired = chooseBladeburnerAction({
      readings: readingsFor(who, { penalty: 0.5 }),
      person: who,
      stamina: max / 4,
      maxStamina: max,
      rankMultiplier: 1,
      speed: 1,
    });
    expect(tired.work?.name).toBe(full.work?.name);
    expect(tired.work?.chance).toBeCloseTo(full.work?.chance ?? 0, 12);
  });

  test("BN7's 0.6 scales every gain, Field Analysis's too; an action core doesn't know is passed over", () => {
    const who = person();
    const max = maxStaminaOf(who, 0);
    const readings: BladeburnerActionReading[] = [
      { type: "Contracts", name: "Tracking", level: 1, maxLevel: 1, count: 100, chance: [0.5, 0.5] },
      { type: "Contracts", name: "Shoplifting", level: 1, maxLevel: 1, count: 100, chance: [1, 1] },
    ];
    const plan = (rankMultiplier: number) =>
      chooseBladeburnerAction({ readings, person: who, stamina: max, maxStamina: max, rankMultiplier, speed: 1 });
    expect(plan(1).work?.name).toBe("Tracking");
    expect(plan(0.6).work?.rankPerSecond).toBeCloseTo((0.5 * 0.3 * 0.6) / 11, 12);
    expect(plan(0.6).rest.rankPerSecond).toBeCloseTo(0.06 / 30, 15);
  });

  test("resting: below ½ max; back to work only at the max", () => {
    expect(bladeburnerResting({ stamina: 19.9, maxStamina: 40, wasResting: false })).toBe(true);
    expect(bladeburnerResting({ stamina: 20, maxStamina: 40, wasResting: false })).toBe(false);
    expect(bladeburnerResting({ stamina: 39.9, maxStamina: 40, wasResting: true })).toBe(true);
    expect(bladeburnerResting({ stamina: 40, maxStamina: 40, wasResting: true })).toBe(false);
  });
});
