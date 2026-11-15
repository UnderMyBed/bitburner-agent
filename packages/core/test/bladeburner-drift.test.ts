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
  actionSuccessChance,
  BLADEBURNER_DRIFT_PASSES,
  BLADEBURNER_LEVELLED_ACTIONS,
  type BladeburnerActionReading,
  type BladeburnerLevelledAction,
  type BladeburnerPerson,
  bladeburnerLevelledAction,
  bladeburnerPlansToTarget,
  bladeburnerTailMix,
  chooseBladeburnerAction,
  countGrowthPerSecond,
  maxStaminaOf,
} from "../src/bladeburner-actions.ts";
import { BLADEBURNER_BLACK_OPS, blackOpSuccessChance } from "../src/bladeburner-black-ops.ts";
import { chooseBladeburnerCity, cityCompetenceRatio } from "../src/bladeburner-cities.ts";
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
        populationScale: 1,
        migrated: 0,
        communities: 0,
      });
    }
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
    ["Raid", 0.06, 1600, 90],
    ["Bounty Hunter", 0.32, 3000, 70],
    ["Investigation", 0.2, 900, 60],
  ] as const)("%s at %s, %s attempts every %s s, the six cities, the city moved", (name, chance, attempts, cycle) => {
    const start = bladeburnerDriftStart(SIX, "New Tokyo") as NonNullable<ReturnType<typeof bladeburnerDriftStart>>;
    const reference = start.cities[start.worked] as BladeburnerDriftCity;
    const options = { charisma: 50, moves: true };
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
      `${name}: the mean chance ${(chunked.chances[0] as number).toFixed(5)} chunked, ${exact.toFixed(5)} an attempt at a ` +
        `time; Diplomacy ${chunked.diplomacySeconds.toFixed(0)} s against ${diplomacy.toFixed(0)} s`,
    );
    expect(close(chunked.chances[0] as number, exact)).toBeLessThan(0.01);
    // Diplomacy's time an attempt within 1% of the cycle (where the city moves decides it, the chunks' own resolution).
    expect(Math.abs(chunked.diplomacySeconds - diplomacy) / attempts).toBeLessThan(0.01 * cycle);
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
    // One pass (`BLADEBURNER_DRIFT_PASSES`): the horizon the plan's least time at the chances read, to the bit.
    expect(work?.drift?.passes).toBe(BLADEBURNER_DRIFT_PASSES);
    if (BLADEBURNER_DRIFT_PASSES === 1) expect(horizon).toBe(plain.toTarget?.seconds);
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
      expect(after.population, city.name).toBeCloseTo(city.population + each.population * seconds, 0);
      expect(after.communities, city.name).toBeCloseTo(city.communities + each.communities * seconds, 9);
      expect(after.chaos, city.name).toBeCloseTo(Math.max(0, city.chaos + (each.chaos - 0.0001) * seconds), 9);
    }
  });

  test("one attempt: its chance the one before it; Raid's chance 0 with no communities", () => {
    const start = bladeburnerDriftStart(SIX, "New Tokyo") as NonNullable<ReturnType<typeof bladeburnerDriftStart>>;
    const reference = start.cities[start.worked] as BladeburnerDriftCity;
    const one = bladeburnerDriftPath(start, reference, [{ action: action("Raid"), chance: 0.2, attempts: 1 }], 60, {
      charisma: 50,
      moves: false,
    });
    expect(one.chances[0]).toBe(0.2);
    expect(driftedChance({ action: action("Raid"), chance: 0.2 }, reference, { ...reference, communities: 0 })).toBe(0);
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
  });
});

describe("the rule's figures (#418): the attempts' bound, the city's drift, the hospital on each side of B7", () => {
  const combat = combatOf(100);
  const who = personOf(combat);
  const input = readAt(who);
  const typhoon = BLADEBURNER_BLACK_OPS[0] as (typeof BLADEBURNER_BLACK_OPS)[number];

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
      drift: { cities, city: "Volhaven", chaos: there.chaos },
    });
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
