// Bladeburner #418: the contracts' and operations' side effects on the cities, and the hospital's money. Each effect
// checked against the pinned game's source; the mean path against a seeded walk of the game's own draws (`City.ts`'s
// methods as `completeOperation` calls them), and the chances after it against core's formula; the random events'
// mean against a seeded run of `randomEvent`; the hospital's bill by hand; the rule's horizon (#386's chain at the
// chances read) and its behaviour; and the grown estimate's step against the rule's pricing at the same input and
// horizon.
// The parity against the engine itself is the simulator's (packages/brain/test/bladeburner-drift-parity.test.ts).
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { COMBAT_STATS, type CombatPerson, skillExpFor, skillLevelOf } from "../src/bladeburner.ts";
import {
  actionHpLoss,
  actionRankGain,
  actionRankLoss,
  actionSuccessChance,
  BLADEBURNER_DRIFT_PASSES,
  BLADEBURNER_LEVELLED_ACTIONS,
  type BladeburnerActionReading,
  type BladeburnerLevelledAction,
  type BladeburnerPerson,
  bladeburnerDriftHorizon,
  bladeburnerLevelledAction,
  bladeburnerPlansToTarget,
  bladeburnerTailMix,
  chooseBladeburnerAction,
  countGrowthPerSecond,
  maxStaminaOf,
} from "../src/bladeburner-actions.ts";
import { BLADEBURNER_BLACK_OPS, blackOpSuccessChance } from "../src/bladeburner-black-ops.ts";
import { chooseBladeburnerCity, cityCompetenceRatio } from "../src/bladeburner-cities.ts";
import { chaosDifficultyFactor } from "../src/bladeburner-constants.ts";
import {
  BLADEBURNER_EVENT_SECONDS,
  type BladeburnerDriftCity,
  bladeburnerAttemptDrift,
  bladeburnerDriftPath,
  bladeburnerDriftStart,
  bladeburnerEventDrift,
  cityChanceFactor,
  driftedChance,
  hospitalCostPerFailure,
  logScaleMean,
  migrationShare,
} from "../src/bladeburner-drift.ts";
import {
  blackOpsRouteGrownEstimate,
  bladeburnerGrownInput,
  bladeburnerGrowthStart,
} from "../src/bladeburner-growth.ts";
import { blackOpsInstallTiming, bladeburnerInstallGain } from "../src/bladeburner-installs.ts";

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
/** `getRandomIntInclusive` (`utils/helpers/getRandomIntInclusive.ts`) on a seeded uniform. */
const intIn = (random: () => number, min: number, max: number) => Math.floor(random() * (max - min + 1)) + min;

const action = (name: string) =>
  BLADEBURNER_LEVELLED_ACTIONS.find((each) => each.name === name) as BladeburnerLevelledAction;

describe("an attempt's effects (#418): the game's own", () => {
  test("completeOperation's and completeContract's draws, as the source has them", () => {
    const source = gameSource("Bladeburner/Bladeburner.ts");
    for (const line of [
      // Raid: a success −1% and the estimate alike; a failure −(5 to 10)/10 %, the estimate left; the chaos +1–5%.
      "city.changePopulationByPercentage(-1, {",
      "const change = getRandomIntInclusive(-10, -5) / 10;",
      "city.changeChaosByPercentage(getRandomIntInclusive(1, 5));",
      // Sting, Stealth Retirement and Assassination.
      "city.changePopulationByPercentage(-0.1, {",
      "city.changeChaosByCount(0.1);",
      "city.changePopulationByPercentage(-0.5, {",
      "city.changeChaosByPercentage(getRandomIntInclusive(-3, -1));",
      "city.changeChaosByPercentage(getRandomIntInclusive(-5, 5));",
      // Investigation's and Undercover's failures: a migration's chance.
      "this.triggerPotentialMigration(this.city, 0.1);",
      "this.triggerPotentialMigration(this.city, 0.15);",
      // Bounty Hunter's and Retirement's chaos on a success.
      "city.changeChaosByCount(0.02);",
      "city.changeChaosByCount(0.04);",
      // The decay and the events' interval.
      "city.chaos -= 0.0001 * seconds;",
      "this.randomEventCounter += getRandomIntInclusive(240, 600);",
      // A migration's share.
      "let percentage = getRandomIntInclusive(3, 15) / 100;",
      "percentage *= getRandomIntInclusive(2, 4); // Migration increases population change",
    ]) {
      expect(source, line).toContain(line);
    }
    expect(gameSource("Hospital/Hospital.ts")).toContain(
      "return Math.min(Player.money * 0.1, (Player.hp.max - Player.hp.current) * CONSTANTS.HospitalCostPerHp);",
    );
    expect(gameSource("Constants.ts")).toContain("HospitalCostPerHp: 100e3,");
  });

  test("by hand: each action's mean at a chance of 0.2, with communities", () => {
    expect(bladeburnerAttemptDrift(action("Raid"), 0.2)).toEqual({
      chaosScale: 1.03,
      chaosAdd: 0,
      // E[ln(1 + U/100)] over U of 1..5, under ln(1.03) (Jensen's).
      chaosLogScale: expect.closeTo(
        (Math.log(1.01) + Math.log(1.02) + Math.log(1.03) + Math.log(1.04) + Math.log(1.05)) / 5,
        12,
      ),
      populationScale: expect.closeTo(0.2 * 0.99 + 0.8 * 0.9925, 12),
      migrated: 0,
      communities: -0.2,
    });
    expect(bladeburnerAttemptDrift(action("Sting Operation"), 0.2)).toMatchObject({
      chaosAdd: 0.1,
      populationScale: expect.closeTo(1 - 0.0002, 12),
    });
    expect(bladeburnerAttemptDrift(action("Stealth Retirement Operation"), 0.2)).toMatchObject({
      chaosScale: 0.98,
      populationScale: expect.closeTo(1 - 0.001, 12),
    });
    expect(bladeburnerAttemptDrift(action("Investigation"), 0.2)).toMatchObject({
      migrated: expect.closeTo(0.8 * 0.1 * 0.099, 12),
      communities: expect.closeTo(-0.8 * 0.1 * 0.05, 12),
    });
    expect(bladeburnerAttemptDrift(action("Undercover Operation"), 0.2, 0)).toMatchObject({
      migrated: expect.closeTo(0.8 * 0.15 * 0.09, 12),
      communities: 0,
    });
    expect(bladeburnerAttemptDrift(action("Bounty Hunter"), 0.2).chaosAdd).toBeCloseTo(0.004, 12);
    expect(bladeburnerAttemptDrift(action("Retirement"), 0.2).chaosAdd).toBeCloseTo(0.008, 12);
    for (const name of ["Tracking", "Assassination"]) {
      expect(bladeburnerAttemptDrift(action(name), 0.2)).toEqual({
        chaosScale: 1,
        chaosAdd: 0,
        // Assassination's ±5%: 1 on average, its log's mean under 0.
        chaosLogScale: name === "Assassination" ? expect.closeTo(logScaleMean(-5, 5), 12) : 0,
        populationScale: 1,
        migrated: 0,
        communities: 0,
      });
    }
    expect(logScaleMean(-5, 5)).toBeLessThan(0);
    expect(migrationShare(10)).toBeCloseTo(0.099, 12);
  });
});

/**
 * One of the game's attempts on a city (`completeOperation`, `Bladeburner.ts:796-866`; `completeContract`, `:868-890`;
 * `City.ts`'s methods), its success drawn at `chance`, a migration to `others` (one of them) where there are any.
 */
function gameAttempt(
  name: string,
  city: { pop: number; popEst: number; comms: number; chaos: number },
  chance: number,
  random: () => number,
  others: { pop: number; comms: number }[] = [],
): boolean {
  const success = random() < chance;
  const byPercentage = (p: number, equally: boolean) => {
    let change = Math.round(city.pop * (p / 100));
    if (change === 0) change = p > 0 ? 1 : -1;
    city.pop = Math.max(0, city.pop + change);
    if (equally) city.popEst = Math.max(0, city.popEst + change);
  };
  const chaosBy = (p: number) => {
    city.chaos = Math.max(0, city.chaos * (1 + p / 100));
  };
  const migrate = (likelihood: number) => {
    if (!(random() < likelihood) || others.length === 0) return;
    const to = others[Math.floor(random() * others.length)] as { pop: number; comms: number };
    let percentage = intIn(random, 3, 15) / 100;
    if (random() < 0.05 && city.comms > 0) {
      percentage *= intIn(random, 2, 4);
      city.comms -= 1;
      to.comms += 1;
    }
    const count = Math.round(city.pop * percentage);
    city.pop -= count;
    to.pop += count;
  };
  switch (name) {
    case "Raid":
      if (success) {
        byPercentage(-1, true);
        city.comms -= 1;
      } else byPercentage(intIn(random, -10, -5) / 10, false);
      chaosBy(intIn(random, 1, 5));
      break;
    case "Sting Operation":
      if (success) byPercentage(-0.1, true);
      city.chaos += 0.1;
      break;
    case "Stealth Retirement Operation":
      if (success) byPercentage(-0.5, true);
      chaosBy(intIn(random, -3, -1));
      break;
    case "Investigation":
      if (!success) migrate(0.1);
      break;
    case "Undercover Operation":
      if (!success) migrate(0.15);
      break;
    case "Bounty Hunter":
      if (success) city.chaos += 0.02;
      break;
    case "Retirement":
      if (success) city.chaos += 0.04;
      break;
  }
  return success;
}

describe("the mean path (#418) against a seeded walk of the game's draws, one city worked", () => {
  // The city read: the true population 1.2e9, chaos 30 (under 50 at the start, over it on Raid's path), 40 communities.
  const READ = { pop: 1.2e9, popEst: 1.2e9, comms: 40, chaos: 30 };
  const WALKS = 2000;
  test.each([
    ["Raid", 0.3, 40],
    ["Raid", 0.05, 60],
    ["Sting Operation", 0.4, 60],
    ["Stealth Retirement Operation", 0.3, 60],
    ["Investigation", 0.2, 60],
  ] as const)("%s at %s, %s attempts: the mean chance, the chaos and the population", (name, chance0, attempts) => {
    const one = [{ name: "Here", population: READ.pop, communities: READ.comms, chaos: READ.chaos }];
    const others = Array.from({ length: 5 }, (_, i) => ({
      name: `Other ${i}`,
      population: READ.pop,
      communities: READ.comms,
      chaos: 0,
    }));
    // No time passes, so no decay nor events: the attempts' own effects alone, and Diplomacy's, against the walk's.
    const cities = name === "Investigation" ? [...one, ...others] : one;
    const start = bladeburnerDriftStart(cities, "Here") as NonNullable<ReturnType<typeof bladeburnerDriftStart>>;
    const reference = start.cities[0] as BladeburnerDriftCity;
    const path = bladeburnerDriftPath(start, reference, [{ action: action(name), chance: chance0, attempts }], 0, {
      charisma: 100,
      moves: false,
    });
    const random = seeded(418);
    const keep = 1 - (100 ** 0.045 + 100 / 1e3) / 100;
    let successes = 0;
    let chaos = 0;
    let population = 0;
    let populationSquares = 0;
    let diplomacy = 0;
    const each: number[] = [];
    for (let walk = 0; walk < WALKS; walk++) {
      const city = { ...READ };
      const away = others.map((other) => ({ pop: other.population, comms: other.communities }));
      let won = 0;
      for (let k = 0; k < attempts; k++) {
        // The chance the game draws at: (pop)^0.7 over the chaos factor, from the read (`Actions/Action.ts:169-196`).
        const chance =
          name === "Raid" && city.comms <= 0
            ? 0
            : Math.min(
                1,
                chance0 *
                  (cityChanceFactor({ population: city.pop, chaos: city.chaos }) /
                    cityChanceFactor({ population: READ.pop, chaos: READ.chaos })),
              );
        if (gameAttempt(name, city, chance, random, name === "Investigation" ? away : [])) won += 1;
        // The brain's Diplomacy holding the chaos at 50 (B4's).
        if (city.chaos > 50) {
          diplomacy += (60 * Math.log(50 / city.chaos)) / Math.log(keep);
          city.chaos = 50;
        }
      }
      successes += won;
      each.push(won / attempts);
      chaos += city.chaos;
      population += city.pop;
      populationSquares += (city.pop / READ.pop) ** 2;
    }
    const mean = successes / (WALKS * attempts);
    const spread = Math.sqrt(each.reduce((sum, x) => sum + (x - mean) ** 2, 0) / (WALKS - 1) / WALKS);
    const end = path.state.cities[0] as BladeburnerDriftCity;
    console.log(
      `${name} at ${chance0}, ${attempts} attempts: the mean chance ${(path.chances[0] as number).toFixed(5)} ` +
        `against the walks' ${mean.toFixed(5)} ± ${spread.toFixed(5)}; the chaos ${end.chaos.toFixed(3)} against ` +
        `${(chaos / WALKS).toFixed(3)}; the population ×${(end.population / READ.pop).toFixed(5)} against ` +
        `×${(population / WALKS / READ.pop).toFixed(5)}; Diplomacy ${path.diplomacySeconds.toFixed(0)} s against ` +
        `${(diplomacy / WALKS).toFixed(0)} s`,
    );
    // Within 4 standard errors of the walks' mean (a chance 6e-5 of a false failure), each.
    expect(Math.abs((path.chances[0] as number) - mean)).toBeLessThan(4 * spread + 1e-4);
    expect(end.chaos / (chaos / WALKS)).toBeCloseTo(1, 2);
    const populationMean = population / WALKS / READ.pop;
    const populationError = Math.sqrt((populationSquares / WALKS - populationMean ** 2) / WALKS);
    expect(Math.abs(end.population / READ.pop - populationMean)).toBeLessThan(4 * populationError + 1e-4);
    if (path.diplomacySeconds > 0) expect(path.diplomacySeconds / (diplomacy / WALKS)).toBeCloseTo(1, 1);
  });

  test("the chances after: the worked city's factor over the read one's, the game's formula at both", () => {
    const raid = action("Raid");
    const who: BladeburnerPerson = {
      skills: {
        hacking: 1,
        strength: 200,
        defense: 200,
        dexterity: 200,
        agility: 200,
        charisma: 50,
        intelligence: 0,
      },
      mults: { bladeburner_success_chance: 1, bladeburner_max_stamina: 1, bladeburner_stamina_gain: 1 },
    };
    const read = { population: 1.2e9, communities: 40, chaos: 30 };
    const chance = actionSuccessChance(raid, 1, who, { city: read, penalty: 1 });
    for (const after of [
      { population: 1.1e9, communities: 38, chaos: 45 },
      { population: 0.9e9, communities: 1, chaos: 80 },
      { population: 0.9e9, communities: 0, chaos: 20 },
    ]) {
      const game = actionSuccessChance(raid, 1, who, { city: after, penalty: 1 });
      expect(driftedChance({ action: raid, chance }, read, { name: "Here", ...after })).toBeCloseTo(game, 12);
    }
  });
});

describe("the random events' mean (#418) against a seeded run of `randomEvent`", () => {
  test("each city's population, chaos and communities an event, the six as read", () => {
    const cities: BladeburnerDriftCity[] = [
      { name: "Aevum", population: 1.4e9, communities: 30, chaos: 0 },
      { name: "Chongqing", population: 0.9e9, communities: 0, chaos: 20 },
      { name: "Sector-12", population: 1.1e9, communities: 50, chaos: 55 },
      { name: "New Tokyo", population: 1.25e9, communities: 12, chaos: 80 },
      { name: "Ishima", population: 1.6e9, communities: 7, chaos: 49.5 },
      { name: "Volhaven", population: 1.05e9, communities: 90, chaos: 51 },
    ];
    const mean = bladeburnerEventDrift(cities).map((each) => ({
      population: each.population * BLADEBURNER_EVENT_SECONDS,
      chaos: each.chaos * BLADEBURNER_EVENT_SECONDS,
      communities: each.communities * BLADEBURNER_EVENT_SECONDS,
    }));
    const random = seeded(4180);
    const events = 400_000;
    const sums = cities.map(() => ({ population: 0, chaos: 0, communities: 0, square: 0 }));
    for (let n = 0; n < events; n++) {
      // `randomEvent` (`Bladeburner.ts:601-699`) on a fresh copy each time: its change, from the six as read.
      const city = cities.map((each) => ({ ...each }));
      const s = Math.floor(random() * 6);
      let d = Math.floor(random() * 5);
      if (d >= s) d += 1;
      const source = city[s] as BladeburnerDriftCity;
      const dest = city[d] as BladeburnerDriftCity;
      const chance = random();
      const newCommunity = () => {
        source.communities += 1;
        source.population += Math.round(source.population * (intIn(random, 10, 20) / 100));
      };
      if (chance <= 0.05) newCommunity();
      else if (chance <= 0.1) {
        if (source.communities <= 0) newCommunity();
        else {
          source.communities -= 1;
          dest.communities += 1;
          const count = Math.round(source.population * (intIn(random, 10, 20) / 100));
          source.population -= count;
          dest.population += count;
        }
      } else if (chance <= 0.3) source.population += Math.round(source.population * (intIn(random, 8, 24) / 100));
      else if (chance <= 0.5) {
        // `triggerMigration`: its own destination.
        let to = Math.floor(random() * 5);
        if (to >= s) to += 1;
        const target = city[to] as BladeburnerDriftCity;
        let percentage = intIn(random, 3, 15) / 100;
        if (random() < 0.05 && source.communities > 0) {
          percentage *= intIn(random, 2, 4);
          source.communities -= 1;
          target.communities += 1;
        }
        const count = Math.round(source.population * percentage);
        source.population -= count;
        target.population += count;
      } else if (chance <= 0.7) {
        source.chaos += 1;
        source.chaos *= 1 + intIn(random, 5, 20) / 100;
      } else if (chance <= 0.9) source.population -= Math.round(source.population * (intIn(random, 8, 20) / 100));
      for (const [i, each] of city.entries()) {
        const was = cities[i] as BladeburnerDriftCity;
        const sum = sums[i] as (typeof sums)[number];
        const change = each.population - was.population;
        sum.population += change;
        sum.square += change * change;
        sum.chaos += each.chaos - was.chaos;
        sum.communities += each.communities - was.communities;
      }
    }
    for (const [i, city] of cities.entries()) {
      const sum = sums[i] as (typeof sums)[number];
      const expected = mean[i] as (typeof mean)[number];
      const populationMean = sum.population / events;
      const error = Math.sqrt((sum.square / events - populationMean ** 2) / events);
      expect(Math.abs(populationMean - expected.population), city.name).toBeLessThan(4 * error);
      expect(sum.chaos / events, city.name).toBeCloseTo(expected.chaos, 2);
      expect(sum.communities / events, city.name).toBeCloseTo(expected.communities, 2);
    }
    // The total population's rise an hour, the six alike: 1.64%.
    const alike = bladeburnerEventDrift(cities.map((each) => ({ ...each, population: 1, communities: 10 })));
    const perHour = alike.reduce((sum, each) => sum + each.population, 0) * 3600;
    expect(perHour / 6).toBeCloseTo(((0.05 * 0.15 + 0.2 * 0.16 - 0.2 * 0.14) / 6) * (3600 / 420), 12);
    expect(perHour / 6).toBeCloseTo(0.0164, 4);
  });
});

describe("the hospital's bill (#418): by hand", () => {
  test("Raid's failure past the max HP at once, Bounty Hunter's each fifth, 10% of the money at most", () => {
    const raid = actionHpLoss(action("Raid"), 1);
    expect(raid).toBeCloseTo(50 * (800 ** 0.28 + 800 / 650), 9);
    // At $1b, the HP missing × $100k (its 389 HP); at $100m, 10% of the money.
    expect(hospitalCostPerFailure(raid, 21, 1e9)).toBeCloseTo(100e3 * raid, 3);
    expect(hospitalCostPerFailure(raid, 21, 1e8)).toBeCloseTo(1e7, 3);
    const bounty = actionHpLoss(action("Bounty Hunter"), 1);
    const k = Math.ceil(21 / bounty);
    expect(k).toBe(5);
    expect(hospitalCostPerFailure(bounty, 21, 1e9)).toBeCloseTo(100e3 * bounty, 3);
    expect(hospitalCostPerFailure(bounty, 21, 1e6)).toBeCloseTo(1e5 / k, 6);
    expect(hospitalCostPerFailure(0, 21, 1e9)).toBe(0);
    expect(hospitalCostPerFailure(raid, 21, 0)).toBe(0);
  });
});

/** SF1.3's ×1.28 on the combat stats' levels and experience. */
const SF1_3 = 1.28;
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
function personOf(combat: CombatPerson): BladeburnerPerson {
  const skills = { hacking: 100, charisma: 50, intelligence: 0 } as BladeburnerPerson["skills"];
  for (const stat of COMBAT_STATS) skills[stat] = skillLevelOf(combat.exp[stat], SF1_3);
  return { skills, mults: { bladeburner_success_chance: 1, bladeburner_max_stamina: 1, bladeburner_stamina_gain: 1 } };
}
/** The six cities: New Tokyo read, as bn6-skills' seed 1 had it about (1.685e9, chaos 19.8), the others smaller. */
const SIX: BladeburnerDriftCity[] = [
  { name: "Aevum", population: 1.1e9, communities: 60, chaos: 0 },
  { name: "Chongqing", population: 1.0e9, communities: 60, chaos: 0 },
  { name: "Sector-12", population: 0.675e9, communities: 60, chaos: 0 },
  { name: "New Tokyo", population: 1.685e9, communities: 60, chaos: 19.8 },
  { name: "Ishima", population: 1.2e9, communities: 60, chaos: 0 },
  { name: "Volhaven", population: 1.3e9, communities: 60, chaos: 0 },
];
function readAt(who: BladeburnerPerson, count = 20) {
  const here = SIX[3] as BladeburnerDriftCity;
  const readings: BladeburnerActionReading[] = BLADEBURNER_LEVELLED_ACTIONS.map((each) => {
    const chance = actionSuccessChance(each, 1, who, { city: here, penalty: 1 });
    return { type: each.type, name: each.name, level: 1, maxLevel: 1, count, chance: [chance, chance] };
  });
  const maxStamina = maxStaminaOf(who, 0);
  return { readings, person: who, stamina: maxStamina, maxStamina, rankMultiplier: 1, speed: 1, skills: { read: {} } };
}

describe("the path's chunks (#418): against the same path an attempt at a time", () => {
  test.each([
    ["Raid", 0.06, 1600, 90, false],
    ["Raid", 0.06, 1600, 90, true],
    ["Bounty Hunter", 0.32, 3000, 70, true],
    ["Investigation", 0.2, 900, 60, true],
  ] as const)(
    "%s at %s, %s attempts every %s s, the six cities, the city moved: %s",
    (name, chance, attempts, cycle, moves) => {
      const start = bladeburnerDriftStart(SIX, "New Tokyo") as NonNullable<ReturnType<typeof bladeburnerDriftStart>>;
      const reference = start.cities[start.worked] as BladeburnerDriftCity;
      const options = { charisma: 50, moves };
      const chunked = bladeburnerDriftPath(
        start,
        reference,
        [{ action: action(name), chance, attempts }],
        attempts * cycle,
        options,
      );
      let state = start;
      let drawn = 0;
      let diplomacy = 0;
      for (let k = 0; k < attempts; k++) {
        const one = bladeburnerDriftPath(
          state,
          reference,
          [{ action: action(name), chance, attempts: 1 }],
          cycle,
          options,
        );
        drawn += one.chances[0] as number;
        diplomacy += one.diplomacySeconds;
        state = one.state;
      }
      const exact = drawn / attempts;
      const close = (a: number, b: number) => Math.abs(a / b - 1);
      console.log(
        `${name}${moves ? ", moved" : ""}: the mean chance ${(chunked.chances[0] as number).toFixed(5)} chunked, ${exact.toFixed(5)} an attempt at a ` +
          `time; Diplomacy ${chunked.diplomacySeconds.toFixed(0)} s against ${diplomacy.toFixed(0)} s`,
      );
      // The chance within 1%, Diplomacy's time an attempt within 1% of the cycle (in one city, the chunks alone: Raid's
      // 23 s in 228,000). Moved Raid is followed an attempt at a time (`BLADEBURNER_DRIFT_EXACT_RAID`, the next test), so
      // its case here is a self-consistency check: the path in one call against the same path an attempt a call.
      expect(close(chunked.chances[0] as number, exact)).toBeLessThan(0.01);
      expect(Math.abs(chunked.diplomacySeconds - diplomacy) / attempts).toBeLessThan(0.01 * cycle);
    },
  );

  test("moved Raid in chunks doesn't converge (#418's ruling 4): B4's pick between two homes flips with the step", () => {
    // Its 1,600 attempts in N chunks of a path each (the same scheme as N chunks of one), against the attempt at a time.
    const start = bladeburnerDriftStart(SIX, "New Tokyo") as NonNullable<ReturnType<typeof bladeburnerDriftStart>>;
    const reference = start.cities[start.worked] as BladeburnerDriftCity;
    const attempts = 1600;
    const cycle = 90;
    const run = (pieces: number, moves: boolean) => {
      let state = start;
      let drawn = 0;
      let switches = 0;
      const worked = new Map<string, number>();
      for (let k = 0; k < pieces; k++) {
        const one = bladeburnerDriftPath(
          state,
          reference,
          [{ action: action("Raid"), chance: 0.06, attempts: attempts / pieces }],
          (attempts * cycle) / pieces,
          { charisma: 50, moves, chunks: 1, exactRaid: false },
        );
        const name = (state.cities[state.worked] as BladeburnerDriftCity).name;
        worked.set(name, (worked.get(name) ?? 0) + 1 / pieces);
        drawn += ((one.chances[0] as number) * attempts) / pieces;
        if (one.state.worked !== state.worked) switches += 1;
        state = one.state;
      }
      return { chance: drawn / attempts, switches, volhaven: worked.get("Volhaven") ?? 0 };
    };
    const exact = run(attempts, true);
    const rows = [256, 512, 800, 1024].map((pieces) => ({ pieces, ...run(pieces, true) }));
    console.log(
      `moved Raid, the attempt at a time: chance ${exact.chance.toFixed(5)}, Volhaven ${(100 * exact.volhaven).toFixed(1)}% ` +
        `of the attempts, ${exact.switches} switches; ` +
        rows
          .map(
            (row) =>
              `${row.pieces} chunks: ${(100 * Math.abs(row.chance / exact.chance - 1)).toFixed(2)}% off, Volhaven ` +
              `${(100 * row.volhaven).toFixed(1)}%, ${row.switches} switches`,
          )
          .join("; "),
    );
    // Hundreds of switches: Raid drains the city it works, B4 moves, the city left's chaos rises unheld.
    expect(exact.switches).toBeGreaterThan(100);
    // The error doesn't fall with the step: at 512 chunks more than at 256, and the home's share swings by over 20 points.
    const at = (pieces: number) => rows.find((row) => row.pieces === pieces) as (typeof rows)[number];
    expect(Math.abs(at(512).chance / exact.chance - 1)).toBeGreaterThan(Math.abs(at(256).chance / exact.chance - 1));
    expect(Math.max(...rows.map((row) => row.volhaven)) - Math.min(...rows.map((row) => row.volhaven))).toBeGreaterThan(
      0.2,
    );
    // In one city the same scheme converges: within a part in 10³ at 256 chunks.
    const fixed = run(attempts, false);
    expect(Math.abs(run(256, false).chance / fixed.chance - 1)).toBeLessThan(1e-3);
  });
});

describe("the rule's horizon (#418): the plan's least expected time to the target at the chances read", () => {
  const combat = combatOf(100);
  const who = personOf(combat);
  const input = readAt(who);
  const drift = { cities: SIX, city: "New Tokyo" };

  test("no drift given, or a horizon of 0: the plan as before, to the bit", () => {
    const target = { rank: 0, target: 25 };
    const plain = chooseBladeburnerAction({ ...input, target });
    const zero = chooseBladeburnerAction({ ...input, drift: { ...drift, horizonSeconds: 0 } });
    const none = chooseBladeburnerAction(input);
    expect(zero).toEqual(none);
    expect(plain.toTarget).toBeDefined();
  });

  test.each([
    [0, 25],
    [25, 2500],
    [150, 2500],
  ])("from %s to %s: each chance its mean over the plan's horizon, the horizon the plan's own time", (rank, to) => {
    const target = { rank, target: to };
    const readStarted = performance.now();
    const plain = chooseBladeburnerAction({ ...input, target });
    const readMs = performance.now() - readStarted;
    const started = performance.now();
    const priced = chooseBladeburnerAction({ ...input, target, drift });
    const ms = performance.now() - started;
    const plans = bladeburnerPlansToTarget({ ...input, target, drift });
    expect(priced).toEqual(plans[0]);
    const work = priced.work;
    expect(work?.drift).toBeDefined();
    const horizon = work?.drift?.horizonSeconds as number;
    const seconds = priced.toTarget?.seconds as number;
    console.log(
      `${rank} → ${to}: read ${plain.work?.name} ${plain.work?.level} (${((plain.toTarget?.seconds ?? 0) / 60).toFixed(1)} min); ` +
        `priced ${work?.name} ${work?.level} at ${work?.chance.toFixed(4)} (read ${work?.drift?.chanceRead.toFixed(4)}), ` +
        `${(seconds / 60).toFixed(1)} min against a horizon of ${(horizon / 60).toFixed(1)} min, ` +
        `${work?.drift?.attempts.toFixed(1)} attempts, the chaos to ${work?.drift?.chaos.toFixed(2)}, the population ` +
        `×${work?.drift?.populationRatio.toFixed(4)}, Diplomacy ${work?.diplomacySeconds.toFixed(1)} s an attempt; ${work?.drift?.passes} passes, ` +
        `${ms.toFixed(0)} ms (read: ${readMs.toFixed(0)} ms)`,
    );
    // One pass (`BLADEBURNER_DRIFT_PASSES`): the horizon `bladeburnerDriftHorizon`'s (each plan's own chain, its
    // next-best by the mean), to the bit, and here the rule's chain at the chances read, its least expected time.
    expect(work?.drift?.passes).toBe(BLADEBURNER_DRIFT_PASSES);
    if (BLADEBURNER_DRIFT_PASSES === 1) expect(horizon).toBe(bladeburnerDriftHorizon({ ...input, target, drift }));
    const chain = plain.toTarget?.seconds as number;
    expect(Math.abs(horizon / chain - 1)).toBeLessThan(1e-12);
    // Each Raid plan's chance under its read (its own fall, −0.75% of the population a failure, outruns the events'
    // rise); the actions that move no population rise with the events' (their chance over the read where the horizon
    // is long: the total population's 1.64% an hour).
    for (const plan of plans) {
      if (plan.work?.name !== "Raid" || plan.work.drift === undefined) continue;
      expect(plan.work.chance).toBeLessThan(plan.work.drift.chanceRead);
    }
  });

  test("Raid's chance over its horizon, against its path's own figures: the city moved as it falls", () => {
    // Volhaven a little under New Tokyo: Raid's path to the faction's 25 drains New Tokyo past it, and moves there.
    const target = { rank: 0, target: 25 };
    const cities = SIX.map((city) => (city.name === "Volhaven" ? { ...city, population: 1.6e9 } : { ...city }));
    const plans = bladeburnerPlansToTarget({ ...input, target, drift: { cities, city: "New Tokyo" } });
    const raid = plans.find((plan) => plan.work?.name === "Raid" && plan.work.level === 1);
    const work = raid?.work;
    expect(work?.drift).toBeDefined();
    const start = bladeburnerDriftStart(cities, "New Tokyo") as NonNullable<ReturnType<typeof bladeburnerDriftStart>>;
    const reference = start.cities[start.worked] as BladeburnerDriftCity;
    const attempts = work?.drift?.attempts as number;
    // Its cycle read: no Diplomacy at chaos 19.8 to 50 in its 18 attempts.
    expect(work?.diplomacySeconds).toBe(0);
    const cycle = (work?.seconds as number) / (raid?.duty as number);
    const path = bladeburnerDriftPath(
      start,
      reference,
      [{ action: action("Raid"), chance: work?.drift?.chanceRead as number, attempts }],
      attempts * cycle,
      { charisma: who.skills.charisma, moves: true },
    );
    expect(work?.chance).toBeCloseTo(path.chances[0] as number, 9);
    // Worked by turns once New Tokyo falls under it (B4's choice by the ratio): Volhaven drained too.
    const volhaven = (each: { cities: BladeburnerDriftCity[] }) =>
      (each.cities.find((city) => city.name === "Volhaven") as BladeburnerDriftCity).population;
    expect(volhaven(path.state)).toBeLessThan(volhaven(start));
  });
});

describe("the grown estimate's step (#418): the rule's pricing at the same input and horizon", () => {
  const combat = combatOf(100);
  const who = personOf(combat);
  const input = { ...readAt(who), drift: { cities: SIX, city: "New Tokyo" } };
  const typhoon = BLADEBURNER_BLACK_OPS[0] as (typeof BLADEBURNER_BLACK_OPS)[number];

  test("at the start: the grown input's mix is the rule's tail mix priced over the same horizon, to the bit", () => {
    const state = bladeburnerGrowthStart(input, { rank: 0, points: 0, combat });
    for (const horizon of [0, 600, 7200]) {
      const grown = bladeburnerGrownInput(input, combat, state, horizon);
      const rule = bladeburnerTailMix({ ...input, drift: { ...input.drift, horizonSeconds: horizon } });
      expect(bladeburnerTailMix(grown)).toEqual(rule);
    }
  });

  test("mid-route: the grown input's mix is the rule's at a reading taken there, to the bit", () => {
    // 10 h of Raid from the start (its chaos, communities and population moved, the cohorts carried, B4's moves).
    const start = bladeburnerGrowthStart(input, { rank: 0, points: 0, combat });
    const at = start.drift as NonNullable<typeof start.drift>;
    const moved = bladeburnerDriftPath(
      at.state,
      at.reference,
      [{ action: action("Raid"), chance: 0.06, attempts: 400 }],
      36000,
      {
        charisma: who.skills.charisma,
        moves: true,
      },
    );
    const state = { ...start, drift: { state: moved.state, reference: at.reference } };
    const city = moved.state.cities[moved.state.worked] as BladeburnerDriftCity;
    expect(city.chaosMix?.cohorts.length ?? 0).toBeGreaterThan(0);
    for (const horizon of [600, 7200]) {
      const grown = bladeburnerGrownInput(input, combat, state, horizon);
      // The brain reading there: each chance read in the city worked now, the cities as they are, its horizon given.
      const there = {
        ...input,
        readings: input.readings.map((read) => {
          const each = bladeburnerLevelledAction(read.type, read.name) as BladeburnerLevelledAction;
          const chance = driftedChance(
            { action: each, chance: read.chance[0] },
            at.reference,
            city,
            moved.state.ceiling,
          );
          return { ...read, chance: [chance, chance] as [number, number] };
        }),
        drift: { cities: moved.state.cities, city: city.name, horizonSeconds: horizon },
      };
      expect(bladeburnerTailMix(grown)).toEqual(bladeburnerTailMix(there));
    }
  });

  test("along the route: the cities move, the chances with them; with no cities read, the estimate as before", () => {
    const chance = blackOpSuccessChance(typhoon, who, { penalty: 1 });
    const at = { rank: 0, next: typhoon, chanceRead: [chance, chance] as [number, number] };
    const { drift: _drift, ...plain } = input;
    const flat = blackOpsRouteGrownEstimate(plain, at, { combat, costMultiplier: 1 });
    const drifted = blackOpsRouteGrownEstimate(input, at, { combat, costMultiplier: 1 });
    expect(flat.drift ?? null).toBeNull();
    expect(drifted.drift).not.toBeNull();
    const end = drifted.drift as NonNullable<typeof drifted.drift>;
    console.log(
      `the route: ${(flat.seconds / 3600).toFixed(1)} h as read, ${(drifted.seconds / 3600).toFixed(1)} h with the ` +
        `drift; at its end the city worked ${end.worked}, its population ×${end.populationRatio.toFixed(3)} the one ` +
        `read; the chaos ${end.cities.map((city) => `${city.name} ${city.chaos.toFixed(1)}`).join(", ")}`,
    );
    expect(Number.isFinite(drifted.seconds)).toBe(true);
    // The city worked held at 50 by Diplomacy; the others' chaos risen by the riots' mean, which outruns the decay
    // over a chaos of 1.08 (each 1/30 of the events: +1, then +12.5%, against −0.0001 a second).
    const worked = end.cities.find((city) => city.name === end.worked) as BladeburnerDriftCity;
    expect(worked.chaos).toBeLessThanOrEqual(50 + 1e-9);
    for (const city of end.cities) {
      const read = SIX.find((each) => each.name === city.name) as BladeburnerDriftCity;
      if (city !== worked && read.chaos > 1.1) expect(city.chaos).toBeGreaterThan(read.chaos);
    }
  });
});

describe("the path's own steps (#418): the time's effects, one attempt, the moves", () => {
  test("no attempts: each city the events' mean and the decay over the time, in one step", () => {
    const start = bladeburnerDriftStart(SIX, "New Tokyo") as NonNullable<ReturnType<typeof bladeburnerDriftStart>>;
    const reference = start.cities[start.worked] as BladeburnerDriftCity;
    const seconds = 600;
    const path = bladeburnerDriftPath(start, reference, [], seconds, { charisma: 50, moves: false });
    const rates = bladeburnerEventDrift(SIX);
    for (const [i, city] of SIX.entries()) {
      const each = rates[i] as (typeof rates)[number];
      const after = path.state.cities[i] as BladeburnerDriftCity;
      const near = (a: number, b: number) => Math.abs(a / b - 1);
      // In two halves (Strang's splitting), each at its own start's rates (the population's and a riot's by %): second
      // order in the step, a part in 10⁵ at most here.
      expect(near(after.population, city.population + each.population * seconds), city.name).toBeLessThan(1e-5);
      expect(after.communities, city.name).toBeCloseTo(city.communities + each.communities * seconds, 6);
      if (city.chaos > 1.1) {
        // Over 0 the riots' mean and the decay.
        expect(near(after.chaos, city.chaos + (each.chaos - 0.0001) * seconds), city.name).toBeLessThan(1e-5);
      } else {
        // At 0 the mean can't leave it, the draws do: the riots reaching it, each to 1.125 less half its step's decay.
        const riots = (0.2 * seconds) / BLADEBURNER_EVENT_SECONDS / 6;
        expect(after.chaos, city.name).toBeGreaterThan(0);
        expect(after.chaos, city.name).toBeLessThanOrEqual(riots * 1.125);
      }
    }
  });

  test("one attempt: its chance the one before it; Raid's chance 0 with no communities", () => {
    const start = bladeburnerDriftStart(SIX, "New Tokyo") as NonNullable<ReturnType<typeof bladeburnerDriftStart>>;
    const reference = start.cities[start.worked] as BladeburnerDriftCity;
    const one = bladeburnerDriftPath(start, reference, [{ action: action("Raid"), chance: 0.2, attempts: 1 }], 60, {
      charisma: 50,
      moves: false,
    });
    // The chance before it, after the first half of the step's events (a part in 10⁵ of the population's growth).
    expect(one.chances[0]).toBeCloseTo(0.2, 5);
    expect(driftedChance({ action: action("Raid"), chance: 0.2 }, reference, { ...reference, communities: 0 })).toBe(0);
    // Carried as a distribution (#418's review): Raid's chance there times P(at least one), not the mean's (0.3 > 0).
    const carried = { ...reference, communities: 0.3, communitiesMix: { low: 0, probs: [0.7, 0.3] } };
    expect(driftedChance({ action: action("Raid"), chance: 0.2 }, reference, carried)).toBeCloseTo(
      0.2 * 0.3 * (cityChanceFactor(carried) / cityChanceFactor(reference)),
      12,
    );
  });

  test("the moves: past the read city's fall, another; with Raid alone, only to a city with communities", () => {
    const cities = SIX.map((city) => (city.name === "Volhaven" ? { ...city, population: 1.6e9 } : { ...city }));
    const start = bladeburnerDriftStart(cities, "New Tokyo") as NonNullable<ReturnType<typeof bladeburnerDriftStart>>;
    const reference = start.cities[start.worked] as BladeburnerDriftCity;
    const raid = [{ action: action("Raid"), chance: 0.05, attempts: 200 }];
    const options = { charisma: 50, moves: true };
    // No time: the events add no communities (their mean is a fraction a second, `bladeburnerEventDrift`).
    const moved = bladeburnerDriftPath(start, reference, raid, 0, options);
    // Volhaven worked by turns with New Tokyo once it falls under it: drained too.
    const volhaven = (each: { cities: BladeburnerDriftCity[] }) =>
      (each.cities.find((city) => city.name === "Volhaven") as BladeburnerDriftCity).population;
    expect(volhaven(moved.state)).toBeLessThan(volhaven(start));
    const noCommunities = cities.map((city) => (city.name === "New Tokyo" ? city : { ...city, communities: 0 }));
    const kept = bladeburnerDriftStart(noCommunities, "New Tokyo") as NonNullable<
      ReturnType<typeof bladeburnerDriftStart>
    >;
    const stayed = bladeburnerDriftPath(kept, reference, raid, 0, options);
    expect(stayed.state.cities[stayed.state.worked]?.name).toBe("New Tokyo");
    expect(volhaven(stayed.state)).toBe(volhaven(kept));
    // None anywhere, New Tokyo's too: nowhere to move to (a city without any is never Raid's, even from one without).
    const none = cities.map((city) => ({ ...city, communities: 0 }));
    const nowhere = bladeburnerDriftStart(none, "New Tokyo") as NonNullable<ReturnType<typeof bladeburnerDriftStart>>;
    const still = bladeburnerDriftPath(nowhere, reference, raid, 0, options);
    expect(still.state.cities[still.state.worked]?.name).toBe("New Tokyo");
  });
});

describe("the rule's figures (#418): the attempts' bound, the city's drift, the hospital on each side of B7", () => {
  const combat = combatOf(100);
  const who = personOf(combat);
  const input = readAt(who);
  const typhoon = BLADEBURNER_BLACK_OPS[0] as (typeof BLADEBURNER_BLACK_OPS)[number];

  test("no count to bound it: Raid's attempts its horizon over its cycle, Diplomacy's seconds in it", () => {
    // Raid alone, its count past the horizon (50,000), 10 h given: the attempts the time allows at (seconds +
    // Diplomacy's) over the duty there, its chaos held at 50 (every city at 45, so wherever B4 moves it).
    const hot = SIX.map((city) => ({ ...city, chaos: 45 }));
    const read = readAt(who, 5e4);
    const raidOnly = { ...read, readings: read.readings.filter((each) => each.name === "Raid") };
    const horizonSeconds = 36_000;
    // Under a target with the horizon given (B4's way: one solve), each plan priced; Raid at Field Analysis.
    const plans = bladeburnerPlansToTarget({
      ...raidOnly,
      target: { rank: 150, target: 2500 },
      drift: { cities: hot, city: "New Tokyo", horizonSeconds },
    });
    const plan = plans.find((each) => each.work?.name === "Raid" && each.rest.name === "Field Analysis");
    if (plan === undefined) throw new Error("no Raid plan");
    const work = plan.work;
    expect(work?.name).toBe("Raid");
    expect(work?.diplomacySeconds).toBeGreaterThan(10);
    const cycle = ((work?.seconds as number) + (work?.diplomacySeconds as number)) / plan.duty;
    // Within 1%: the attempts and Diplomacy's seconds at them solved in three passes.
    expect(Math.abs(((work?.drift?.attempts as number) * cycle) / horizonSeconds - 1)).toBeLessThan(0.01);
  });

  test("each plan's attempts over its horizon at most its count and its regrowth", () => {
    const drift = { cities: SIX, city: "New Tokyo" };
    const plans = bladeburnerPlansToTarget({ ...input, target: { rank: 25, target: 2500 }, drift });
    for (const plan of plans) {
      const priced = plan.work?.drift;
      if (plan.work === null || priced === undefined) continue;
      const each = bladeburnerLevelledAction(plan.work.type, plan.work.name) as BladeburnerLevelledAction;
      const read = input.readings.find((reading) => reading.name === plan.work?.name) as BladeburnerActionReading;
      expect(priced.attempts, plan.work.name).toBeLessThanOrEqual(
        read.count + countGrowthPerSecond(each) * priced.horizonSeconds + 1e-9,
      );
    }
  });

  test("B4's city: the plan there priced from that city's figures", () => {
    // Volhaven the most populous: under a target the rule moves there, its plan priced from Volhaven's.
    const cities = SIX.map((city) => (city.name === "Volhaven" ? { ...city, population: 2.4e9 } : { ...city }));
    const target = { rank: 0, target: 25 };
    const choice = chooseBladeburnerCity(
      { ...input, target, drift: { cities, city: "New Tokyo" } },
      { city: "New Tokyo", cities },
    );
    expect(choice?.city).toBe("Volhaven");
    const here = cities.find((city) => city.name === "New Tokyo") as BladeburnerDriftCity;
    const there = cities.find((city) => city.name === "Volhaven") as BladeburnerDriftCity;
    const ratio = cityCompetenceRatio(here, there) as number;
    const direct = chooseBladeburnerAction({
      ...input,
      target,
      city: { ratio, raid: true },
      // At B4's horizon: the city read's, once (`bladeburnerDriftHorizon`).
      drift: { cities, city: "Volhaven", chaos: there.chaos, horizonSeconds: choice?.horizonSeconds as number },
    });
    expect(choice?.horizonSeconds).toBe(
      bladeburnerDriftHorizon({
        ...input,
        target,
        city: { ratio: 1, raid: true },
        drift: { cities, city: "New Tokyo" },
      }),
    );
    expect(choice?.plan).toEqual(direct);
  });

  test("B7's hospital on each side: keeping at the money read, installing now from $1,000", () => {
    const chance = blackOpSuccessChance(typhoon, who, { penalty: 1 });
    const at = { rank: 0, next: typhoon, chanceRead: [chance, chance] as [number, number] };
    const timing = blackOpsInstallTiming({
      input: { ...input, hospital: { hpMax: 21, money: 1e9 } },
      at,
      combat,
      gain: bladeburnerInstallGain(0, ["EsperTech Bladeburner Eyewear"]),
      installable: true,
      growth: { costMultiplier: 1 },
    });
    const { keep, installNow } = timing.moneyLostPerSecond;
    console.log(
      `B7's hospital: keeping ${keep?.toFixed(0)} dollars a second, installing now ${installNow?.toFixed(2)}`,
    );
    expect(keep).toBeGreaterThan(0);
    // From $1,000: each failure at most 10% of it, at most a failure each second.
    expect(installNow).toBeGreaterThan(0);
    expect(installNow).toBeLessThan(100);
  });
});

describe("the grown estimate's state (#418): the chances at the city worked there", () => {
  test("its population halved: each chance × 0.5^0.7, Raid's 0 with no communities left", () => {
    const combat = combatOf(100);
    const who = personOf(combat);
    const input = { ...readAt(who), drift: { cities: SIX, city: "New Tokyo" } };
    const start = bladeburnerGrowthStart(input, { rank: 0, points: 0, combat });
    const drift = start.drift as NonNullable<typeof start.drift>;
    const halved = (communities: number) => ({
      ...start,
      drift: {
        ...drift,
        state: {
          ...drift.state,
          cities: drift.state.cities.map((city, i) =>
            i === drift.state.worked ? { ...city, population: city.population / 2, communities } : city,
          ),
        },
      },
    });
    const read = bladeburnerGrownInput(input, combat, start);
    const moved = bladeburnerGrownInput(input, combat, halved(60));
    const empty = bladeburnerGrownInput(input, combat, halved(0));
    for (const [i, each] of read.readings.entries()) {
      const at = moved.readings[i] as BladeburnerActionReading;
      expect(at.chance[0], each.name).toBeCloseTo(Math.min(1, each.chance[0] * 0.5 ** 0.7), 12);
      if (each.name === "Raid") expect((empty.readings[i] as BladeburnerActionReading).chance[0]).toBe(0);
    }
  });
});

/** Walks behind the env knob (`BLADEBURNER_DRIFT_WALKS`), fewer in CI. */
const DRIFT_WALKS = Number(process.env.BLADEBURNER_DRIFT_WALKS ?? 300);

/**
 * Raid alone in one city of six for `hours`, an attempt each `cycle` s at `p0` there, walked under the game's draws
 * (#418's review): each attempt's success, its population draw and its chaos's +1–5%; the decay, a second at a time
 * with its clamp at 0 (`Bladeburner.ts:1395-1401`, taken between the draws, which it is exactly); an event each
 * 240–600 s in a city of the six, each kind as `randomEvent` (`:601-699`) draws it (a migration's destination its own);
 * Diplomacy as B4 spends it, the chaos over 50 taken to 50 after an attempt. Its mean chaos at the end, Diplomacy's
 * seconds an attempt, the mean chance, the population at the end over the start's; and each one's standard error.
 */
function walkRaid({ chaos0, hours, cycle, p0, charisma, walks, seed }: Record<string, number>) {
  const random = seeded(seed as number);
  const keep = 1 - ((charisma as number) ** 0.045 + (charisma as number) / 1e3) / 100;
  const attempts = Math.floor(((hours as number) * 3600) / (cycle as number));
  const sums = { chaos: [] as number[], diplomacy: [] as number[], chance: [] as number[], population: [] as number[] };
  for (let walk = 0; walk < (walks as number); walk++) {
    const pops = Array.from({ length: 6 }, () => 1e9);
    const comms = Array.from({ length: 6 }, () => 50);
    let chaos = chaos0 as number;
    let clock = 0;
    let next = intIn(random, 240, 600);
    let diplomacy = 0;
    let drawn = 0;
    const decayTo = (t: number) => {
      chaos = Math.max(0, chaos - 0.0001 * (t - clock));
      clock = t;
    };
    const event = () => {
      const kind = random();
      const s = Math.floor(random() * 6);
      let d = Math.floor(random() * 5);
      if (d >= s) d += 1;
      const grow = (share: number) => {
        pops[s] = (pops[s] as number) + Math.round((pops[s] as number) * share);
      };
      const move = (share: number, to: number) => {
        const count = Math.round((pops[s] as number) * share);
        pops[s] = (pops[s] as number) - count;
        pops[to] = (pops[to] as number) + count;
      };
      if (kind <= 0.05) {
        comms[s] = (comms[s] as number) + 1;
        grow(intIn(random, 10, 20) / 100);
      } else if (kind <= 0.1) {
        if ((comms[s] as number) <= 0) {
          comms[s] = 1;
          grow(intIn(random, 10, 20) / 100);
        } else {
          comms[s] = (comms[s] as number) - 1;
          comms[d] = (comms[d] as number) + 1;
          move(intIn(random, 10, 20) / 100, d);
        }
      } else if (kind <= 0.3) grow(intIn(random, 8, 24) / 100);
      else if (kind <= 0.5) {
        let to = Math.floor(random() * 5);
        if (to >= s) to += 1;
        let share = intIn(random, 3, 15) / 100;
        if (random() < 0.05 && (comms[s] as number) > 0) {
          share *= intIn(random, 2, 4);
          comms[s] = (comms[s] as number) - 1;
          comms[to] = (comms[to] as number) + 1;
        }
        move(share, to);
      } else if (kind <= 0.7) {
        if (s === 0) chaos = (chaos + 1) * (1 + intIn(random, 5, 20) / 100);
      } else if (kind <= 0.9) grow(-intIn(random, 8, 20) / 100);
    };
    const until = (t: number) => {
      while (next <= t) {
        decayTo(next);
        event();
        next += intIn(random, 240, 600);
      }
      decayTo(t);
    };
    for (let k = 1; k <= attempts; k++) {
      until(k * (cycle as number));
      // Raid 0 with no communities (`Actions/Operation.ts:63-68`); a success takes one (`Bladeburner.ts:832-838`).
      const p = (comms[0] as number) <= 0 ? 0 : Math.min(1, (p0 as number) * ((pops[0] as number) / 1e9) ** 0.7);
      drawn += p;
      if (random() < p) {
        pops[0] = (pops[0] as number) + Math.round((pops[0] as number) * -0.01);
        comms[0] = (comms[0] as number) - 1;
      } else {
        pops[0] = (pops[0] as number) + Math.round(((pops[0] as number) * intIn(random, -10, -5)) / 1000);
      }
      chaos *= 1 + intIn(random, 1, 5) / 100;
      if (chaos > 50) {
        diplomacy += (60 * Math.log(50 / chaos)) / Math.log(keep);
        chaos = 50;
      }
    }
    until((hours as number) * 3600);
    sums.chaos.push(chaos);
    sums.diplomacy.push(diplomacy / attempts);
    sums.chance.push(drawn / attempts);
    sums.population.push((pops[0] as number) / 1e9);
  }
  const stat = (xs: number[]) => {
    const mean = xs.reduce((sum, x) => sum + x, 0) / xs.length;
    const variance = xs.reduce((sum, x) => sum + (x - mean) ** 2, 0) / Math.max(1, xs.length - 1);
    return { mean, error: Math.sqrt(variance / xs.length) };
  };
  return {
    attempts,
    chaos: stat(sums.chaos),
    diplomacy: stat(sums.diplomacy),
    chance: stat(sums.chance),
    population: stat(sums.population),
  };
}

describe("the chaos from 0 (#418's review): the mean path against walks of the game's draws, over the plan's horizon", () => {
  // From 0 (a BitNode's start) and from the chaos read (seed 1's New Tokyo, about 20), over 10 h and over the horizon of
  // the plan toward Typhoon's 2,500 in the rule's test above (about 100 h).
  test.each([
    [0, 10],
    [20, 10],
    [0, 100],
    [20, 100],
  ])(
    "Raid from chaos %s for %s h: the chaos, Diplomacy's seconds an attempt, the chance and the population",
    (chaos0, hours) => {
      const cycle = 60;
      const p0 = 0.3;
      const charisma = 100;
      const walks = walkRaid({ chaos0, hours, cycle, p0, charisma, walks: DRIFT_WALKS, seed: 4181 + chaos0 + hours });
      const cities = Array.from({ length: 6 }, (_, i) => ({
        name: `City ${i}`,
        population: 1e9,
        communities: 50,
        chaos: i === 0 ? chaos0 : 0,
      }));
      const start = bladeburnerDriftStart(cities, "City 0") as NonNullable<ReturnType<typeof bladeburnerDriftStart>>;
      const reference = { population: 1e9, chaos: chaos0 };
      // The path at its chunks, and in 8 pieces (8 times the chunks, the state carried): their gap the path's own
      // resolution, allowed beside the walks' error.
      const pathIn = (pieces: number) => {
        let state = start;
        let drawn = 0;
        let diplomacy = 0;
        for (let piece = 0; piece < pieces; piece++) {
          const each = bladeburnerDriftPath(
            state,
            reference,
            [{ action: action("Raid"), chance: p0, attempts: walks.attempts / pieces }],
            (hours * 3600) / pieces,
            { charisma, moves: false },
          );
          drawn += ((each.chances[0] as number) * walks.attempts) / pieces;
          diplomacy += each.diplomacySeconds;
          state = each.state;
        }
        const end = state.cities[0] as BladeburnerDriftCity;
        return {
          chaos: end.chaos,
          diplomacy: diplomacy / walks.attempts,
          chance: drawn / walks.attempts,
          population: end.population / 1e9,
        };
      };
      const figures = pathIn(1);
      const fine = pathIn(8);
      const keys = ["chaos", "diplomacy", "chance", "population"] as const;
      const rows = keys.map(
        (key) =>
          `${key} ${figures[key].toFixed(4)} (in pieces ${fine[key].toFixed(4)}) against ${walks[key].mean.toFixed(4)} ± ` +
          walks[key].error.toFixed(4),
      );
      console.log(`Raid from chaos ${chaos0} for ${hours} h (${DRIFT_WALKS} walks): ${rows.join("; ")}`);
      for (const key of keys) {
        const resolution = Math.abs(figures[key] - fine[key]);
        expect(Math.abs(figures[key] - walks[key].mean), key).toBeLessThanOrEqual(
          4 * walks[key].error + resolution + 1e-9,
        );
      }
    },
  );
});

/**
 * Walks of a plan to the target, more behind the env knob (`BLADEBURNER_PLAN_WALKS`). 1,200 in CI (about 5 s here): Raid's
 * successes are a lottery (about 55 rank at 3.5%), its time's spread a walk about 1,100 min, so the gap of about 100 min
 * takes 1,100 walks to read at 3 standard errors.
 */
const PLAN_WALKS = Number(process.env.BLADEBURNER_PLAN_WALKS ?? 1200);

/** A sample's mean and its standard error. */
function meanOf(xs: readonly number[]): { mean: number; error: number } {
  const mean = xs.reduce((sum, x) => sum + x, 0) / xs.length;
  const variance = xs.reduce((sum, x) => sum + (x - mean) ** 2, 0) / Math.max(1, xs.length - 1);
  return { mean, error: Math.sqrt(variance / xs.length) };
}

/** A way to work an action in the walks: the rule's plan's own figures for it (its level, time, stamina, chance read). */
interface WalkedWay {
  action: BladeburnerLevelledAction;
  chanceRead: number;
  seconds: number;
  stamina: number;
  gain: number;
  loss: number;
}

/**
 * A plan walked to the target under the game's draws (#418's ruling 2, check 3), from `rank`: each attempt the first
 * way in `order` with a count of 1 or more (its count down 1, success or failure, `Bladeburner.ts:927-976`; each count
 * regrowing at its mean, `:1386-1393`), else Field Analysis's 30 s; an attempt only with its stamina leaving half the max
 * (no penalty, `staminaPenalty`), the regain a second always. Its success at the chance read times the city's factor
 * over the city read's (the true population^0.7 over the chaos's factor, `Action.ts:88-103`; Raid 0 with no
 * communities), its rank ±10% (`addOffset`) and the floor at 0 (`:1267-1275`); its effects as
 * `completeOperation`/`completeContract` draw them (`:793-890`: Raid's −1% or −(5–10)/10 % and +1–5% chaos and a
 * community; Bounty Hunter's and Retirement's −1 and +0.02/+0.04 chaos; Investigation's and Undercover's failures a
 * migration's chance; Sting's); the city B4's before each attempt, by each city's true figure as the brain measures it
 * at every reading (#420's ruling 2: the round over the six recovers each city's pop/popEst, so the most true
 * population^0.7 over the chaos's factor, Raid's only where there are communities; until #420 the walks picked by the
 * estimates, which the events don't move, `City.ts:35-87`, as the brain then did), Diplomacy as B4 spends
 * it after an attempt over 50 (60 s an attempt at ×keep, taken whole: 60·ln(50/chaos)/ln(keep) s, the city at 50, then
 * the time); an event each 240–600 s in one of the six as `randomEvent` (`:601-699`) draws it and the decay
 * (`:1395-1401`) over every second. Left out, labelled: the count's regrowth's draw (its mean taken), the skills'
 * estimate multiplier (1), the migration's +100 under 1.5e9 (`:597-598`), the levels and skills (the plan's own level
 * throughout, as the rule prices it), HP and the hospital (no rank).
 */
function walkPlan(
  order: readonly WalkedWay[],
  {
    rank: from,
    target,
    regain,
    maxStamina,
    restRank,
    charisma,
    cities: read,
    city: readCity,
    walks,
    seed,
  }: {
    rank: number;
    target: number;
    regain: number;
    maxStamina: number;
    restRank: number;
    charisma: number;
    cities: readonly BladeburnerDriftCity[];
    city: string;
    walks: number;
    seed: number;
  },
) {
  const keep = 1 - (charisma ** 0.045 + charisma / 1e3) / 100;
  const factorOf = (pop: number, chaos: number) => Math.max(0, pop) ** 0.7 / chaosDifficultyFactor(chaos);
  const home = read.findIndex((city) => city.name === readCity);
  const reference = factorOf(
    (read[home] as BladeburnerDriftCity).population,
    (read[home] as BladeburnerDriftCity).chaos,
  );
  const times: number[] = [];
  const attemptsOf: number[] = [];
  // The plan's own action (`order[0]`), over every walk (#420's ruling 3, item 4: the priced time's terms against
  // the walks'): its attempts, their chances summed, the time worked on them, and Diplomacy's after them.
  const first = { attempts: 0, chance: 0, atMean: 0, seconds: 0, diplomacy: 0 };
  for (let walk = 0; walk < walks; walk++) {
    // Two streams a walk (common random numbers: a walk's events the same draws under either plan, as its own
    // attempts'), so the plans' gap is read walk by walk.
    const events = seeded(seed + 7919 * walk);
    const random = seeded(seed + 7919 * walk + 104729);
    const offset = (x: number) => x * (1 + (random() * 2 - 1) * 0.1);
    const pops = read.map((city) => city.population);
    const comms = read.map((city) => city.communities);
    const chaos = read.map((city) => city.chaos);
    const counts = order.map(() => 20);
    const growth = order.map((way) => countGrowthPerSecond(way.action));
    let stamina = maxStamina;
    let rank = from;
    let clock = 0;
    let decayed = 0;
    let next = intIn(events, 240, 600);
    let attempts = 0;
    const decayTo = (t: number) => {
      for (const i of chaos.keys()) chaos[i] = Math.max(0, (chaos[i] as number) - 0.0001 * (t - decayed));
      decayed = t;
    };
    const migrate = (s: number, to: number, share: number) => {
      const count = Math.round((pops[s] as number) * share);
      pops[s] = (pops[s] as number) - count;
      pops[to] = (pops[to] as number) + count;
    };
    const other = (s: number, rng: () => number) => {
      const d = Math.floor(rng() * 5);
      return d >= s ? d + 1 : d;
    };
    const migration = (s: number, rng: () => number) => {
      const to = other(s, rng);
      let share = intIn(rng, 3, 15) / 100;
      if (rng() < 0.05 && (comms[s] as number) > 0) {
        share *= intIn(rng, 2, 4);
        comms[s] = (comms[s] as number) - 1;
        comms[to] = (comms[to] as number) + 1;
      }
      migrate(s, to, share);
    };
    const grow = (s: number, share: number) => {
      const change = Math.round((pops[s] as number) * share);
      pops[s] = (pops[s] as number) + change;
      return change;
    };
    const event = () => {
      const kind = events();
      const s = Math.floor(events() * 6);
      if (kind <= 0.05) {
        comms[s] = (comms[s] as number) + 1;
        grow(s, intIn(events, 10, 20) / 100);
      } else if (kind <= 0.1) {
        if ((comms[s] as number) <= 0) {
          comms[s] = 1;
          grow(s, intIn(events, 10, 20) / 100);
        } else {
          const d = other(s, events);
          comms[s] = (comms[s] as number) - 1;
          comms[d] = (comms[d] as number) + 1;
          migrate(s, d, intIn(events, 10, 20) / 100);
        }
      } else if (kind <= 0.3) grow(s, intIn(events, 8, 24) / 100);
      else if (kind <= 0.5) migration(s, events);
      else if (kind <= 0.7) chaos[s] = ((chaos[s] as number) + 1) * (1 + intIn(events, 5, 20) / 100);
      else if (kind <= 0.9) grow(s, -intIn(events, 8, 20) / 100);
    };
    const pass = (dt: number) => {
      const t = clock + dt;
      while (next <= t) {
        decayTo(next);
        event();
        next += intIn(events, 240, 600);
      }
      decayTo(t);
      clock = t;
      stamina = Math.min(maxStamina, stamina + regain * dt);
      for (const i of counts.keys()) counts[i] = (counts[i] as number) + (growth[i] as number) * dt;
    };
    while (rank < target && clock < 1e8) {
      const way = order.find(
        (each, i) =>
          (counts[i] as number) >= 1 &&
          stamina - each.stamina >= maxStamina / 2 &&
          (each.action.name !== "Raid" || comms.some((c) => c > 0)),
      );
      if (way === undefined) {
        pass(30);
        rank += restRank * 30;
        continue;
      }
      const raid = way.action.name === "Raid";
      // B4's city: the most true factor, measured each reading (#420; Raid's among those with communities).
      let city = -1;
      for (const i of pops.keys()) {
        if (raid && !((comms[i] as number) > 0)) continue;
        if (
          city < 0 ||
          factorOf(pops[i] as number, chaos[i] as number) > factorOf(pops[city] as number, chaos[city] as number)
        )
          city = i;
      }
      const i = order.indexOf(way);
      counts[i] = (counts[i] as number) - 1;
      stamina -= way.stamina;
      pass(way.seconds);
      attempts++;
      const p = Math.min(1, (way.chanceRead * factorOf(pops[city] as number, chaos[city] as number)) / reference);
      if (way === order[0]) {
        first.attempts += 1;
        first.chance += p;
        first.seconds += way.seconds;
        // At the six's mean population and chaos (those with communities for Raid): the mean path's city, where the
        // six alike stay alike, against B4's pick of the best of six that the events spread apart.
        const pool = [...pops.keys()].filter((k) => !raid || (comms[k] as number) > 0);
        const meanPop = pool.reduce((sum, k) => sum + (pops[k] as number), 0) / pool.length;
        const meanChaos = pool.reduce((sum, k) => sum + (chaos[k] as number), 0) / pool.length;
        first.atMean += Math.min(1, (way.chanceRead * factorOf(meanPop, meanChaos)) / reference);
      }
      const success = random() < p;
      rank = Math.max(0, rank + (success ? offset(way.gain) : -offset(way.loss)));
      switch (way.action.name) {
        case "Raid":
          if (success) {
            grow(city, -0.01);
            comms[city] = (comms[city] as number) - 1;
          } else grow(city, intIn(random, -10, -5) / 1000);
          chaos[city] = (chaos[city] as number) * (1 + intIn(random, 1, 5) / 100);
          break;
        case "Bounty Hunter":
        case "Retirement":
          if (success) {
            pops[city] = (pops[city] as number) - 1;
            chaos[city] = (chaos[city] as number) + (way.action.name === "Retirement" ? 0.04 : 0.02);
          }
          break;
        case "Investigation":
        case "Undercover Operation":
          if (!success && random() < (way.action.name === "Investigation" ? 0.1 : 0.15)) migration(city, random);
          break;
        case "Sting Operation":
          if (success) grow(city, -0.001);
          chaos[city] = (chaos[city] as number) + 0.1;
          break;
      }
      // Diplomacy as B4 spends it: the city back to 50, its time then.
      if ((chaos[city] as number) > 50) {
        const seconds = (60 * Math.log(50 / (chaos[city] as number))) / Math.log(keep);
        chaos[city] = 50;
        if (way === order[0]) first.diplomacy += seconds;
        pass(seconds);
      }
    }
    times.push(clock);
    attemptsOf.push(attempts);
  }
  return {
    times,
    ...meanOf(times),
    attempts: attemptsOf.reduce((a, b) => a + b, 0) / walks,
    first: {
      attempts: first.attempts / walks,
      chance: first.attempts > 0 ? first.chance / first.attempts : 0,
      atMean: first.attempts > 0 ? first.atMean / first.attempts : 0,
      diplomacy: first.attempts > 0 ? first.diplomacy / first.attempts : 0,
      share: first.seconds / walks,
    },
  };
}

describe("the rule's order under walks of the game's draws (#418's ruling 2, check 3): its plan against rank a second's", () => {
  test("150 to 2,500 from the six cities read: the walks order the two plans' expected times as the rule does", () => {
    const combat = combatOf(100);
    const who = personOf(combat);
    const input = readAt(who);
    const drift = { cities: SIX, city: "New Tokyo" };
    const target = { rank: 150, target: 2500 };
    const plans = bladeburnerPlansToTarget({ ...input, target, drift });
    const chosen = plans[0] as (typeof plans)[number];
    // Rank a second's plan: B2's, no target (Raid here, at its chance read).
    const second = chooseBladeburnerAction(input);
    const rival = plans.find((plan) => plan.work?.name === second.work?.name && plan.rest.name === second.rest.name);
    expect(chosen.work?.name).toBe("Bounty Hunter");
    expect(second.work?.name).toBe("Raid");
    expect(rival).toBeDefined();
    const alone = plans.find((plan) => plan.work === null) as (typeof plans)[number];
    const wayOf = (plan: (typeof plans)[number]): WalkedWay => {
      const work = plan.work as NonNullable<(typeof plan)["work"]>;
      const each = action(work.name);
      return {
        action: each,
        chanceRead: work.drift?.chanceRead ?? work.chance,
        seconds: work.seconds,
        stamina: work.stamina,
        gain: actionRankGain(each, work.level, 1),
        loss: actionRankLoss(each, work.level),
      };
    };
    // After the plan's own action, the others as the rule's tail takes them: by their best rate a second (the drift
    // priced), those over resting alone's, Field Analysis then.
    const best = new Map<string, (typeof plans)[number]>();
    for (const plan of plans) {
      const name = plan.work?.name;
      if (name === undefined || best.has(name)) continue;
      if (plan.rankPerSecond > alone.rankPerSecond) best.set(name, plan);
    }
    const tail = [...best.values()].sort((a, b) => b.rankPerSecond - a.rankPerSecond);
    const orderOf = (first: (typeof plans)[number]) => [
      wayOf(first),
      ...tail.filter((plan) => plan.work?.name !== first.work?.name).map(wayOf),
    ];
    const setting = {
      ...target,
      regain: chosen.regain,
      maxStamina: input.maxStamina,
      restRank: alone.rankPerSecond,
      charisma: who.skills.charisma,
      cities: SIX,
      city: "New Tokyo",
      walks: PLAN_WALKS,
    };
    const started = performance.now();
    const ruled = walkPlan(orderOf(chosen), { ...setting, seed: 3861 });
    const raided = walkPlan(orderOf(rival as (typeof plans)[number]), { ...setting, seed: 3861 });
    const ms = performance.now() - started;
    const minutes = (x: number) => (x / 60).toFixed(1);
    // The gap walk by walk (the same seeds: common random numbers).
    const { mean: gap, error } = meanOf(raided.times.map((time, i) => time - (ruled.times[i] as number)));
    console.log(
      `150 → 2500 (${PLAN_WALKS} walks each, ${ms.toFixed(0)} ms): the rule's ${chosen.work?.name} first ` +
        `${minutes(ruled.mean)} ± ${minutes(ruled.error)} min walked (${ruled.attempts.toFixed(0)} attempts), ` +
        `${minutes(chosen.toTarget?.seconds as number)} priced; rank a second's ${rival?.work?.name} first ` +
        `${minutes(raided.mean)} ± ${minutes(raided.error)} min walked (${raided.attempts.toFixed(0)} attempts), ` +
        `${minutes(rival?.toTarget?.seconds as number)} priced; the gap ${minutes(gap)} ± ${minutes(error)} min; the ` +
        `rule optimistic by ${(100 * (1 - (chosen.toTarget?.seconds as number) / ruled.mean)).toFixed(1)}% and ` +
        `${(100 * (1 - (rival?.toTarget?.seconds as number) / raided.mean)).toFixed(1)}% (its path's B4 and the ` +
        `walks' both by each city's true figure, measured each reading, #420)`,
    );
    // The priced time's terms against the walks' (#420's ruling 3, item 4): the plan's own action's mean chance and
    // Diplomacy's seconds an attempt, priced and walked; and each plan's time priced at the walks' mean chance (its
    // reading's chance there, the chain as the rule's, no drift), which says how much of the gap that term is.
    const termsOf = (plan: (typeof plans)[number], walked: ReturnType<typeof walkPlan>) => {
      const work = plan.work as NonNullable<(typeof plan)["work"]>;
      const factor = walked.first.chance / (work.drift?.chanceRead ?? work.chance);
      const atWalked = bladeburnerPlansToTarget({
        ...input,
        target,
        readings: input.readings.map((read) =>
          read.name === work.name
            ? { ...read, chance: [read.chance[0] * factor, read.chance[1] * factor] as [number, number] }
            : read,
        ),
      }).find(
        (each) => each.work?.name === work.name && each.work.level === work.level && each.rest.name === plan.rest.name,
      );
      return (
        `${work.name}: priced its chance ${work.chance.toFixed(4)} over ${(work.drift?.attempts ?? 0).toFixed(0)} attempts ` +
        `and Diplomacy ${work.diplomacySeconds.toFixed(1)} s an attempt; walked ${walked.first.chance.toFixed(4)} ` +
        `(${walked.first.atMean.toFixed(4)} at the six's mean) over ` +
        `${walked.first.attempts.toFixed(0)} and ${walked.first.diplomacy.toFixed(1)} s; priced at the walked chance ` +
        `${minutes(atWalked?.toTarget?.seconds as number)} min (walked ${minutes(walked.mean)}, priced ` +
        `${minutes(plan.toTarget?.seconds as number)})`
      );
    };
    console.log(`the terms (#420): ${termsOf(chosen, ruled)}; ${termsOf(rival as (typeof plans)[number], raided)}`);
    // The rule's order: its plan the faster.
    expect((rival?.toTarget?.seconds as number) > (chosen.toTarget?.seconds as number)).toBe(true);
    // The walks' the same, beyond 3 standard errors of the gap.
    expect(gap).toBeGreaterThan(3 * error);
  });
});
