// Levelling (#336): the experience a grow or weaken thread earns a second, the levelling target and operation, the
// time to a level, and the planner's three candidates and choice, on figures shaped like BN4.1's last snapshot
// (2026-11-10's run; its hacking_speed and NeuroFlux Governor levels assumed, not read).
import { describe, expect, test } from "vitest";
import { AUGMENTATIONS } from "../src/augmentation-data.ts";
import { neuroFluxLadder } from "../src/augmentation-plan.ts";
import { augmentationBitNodeMultipliers, NEUROFLUX_GOVERNOR } from "../src/augmentations.ts";
import { hackingExpOfLevel, hackingLevelOfExp } from "../src/batcher.ts";
import { LEVEL_LOOP_RAM_GB } from "../src/hack-loop.ts";
import type { HackingPlayer, HackingTarget } from "../src/hacking-ceiling.ts";
import {
  batchThenInstallPlan,
  chooseLevelling,
  chooseLevellingTarget,
  LEVELLING_INSTALL_MS,
  LEVELLING_REROOT_MS,
  LEVELLING_SWITCH_GAIN,
  type LevellingBatchOffer,
  levelLoopThreads,
  levellingEstimates,
  levellingExpPerThreadSecond,
  levellingInstallMultipliers,
  levellingPreparationMs,
  neuroFluxMultipliers,
  secondsToHackingLevel,
} from "../src/levelling.ts";

const HOUR = 3600;

/** BN1's servers as the static snapshot has them (`Server/data/servers.ts`): what the choice weighs. */
const SERVERS: { hostname: string; figures: HackingTarget }[] = [
  {
    hostname: "n00dles",
    figures: { moneyMax: 1.75e6, minDifficulty: 1, baseDifficulty: 1, requiredHackingSkill: 1, serverGrowth: 3000 },
  },
  {
    hostname: "foodnstuff",
    figures: { moneyMax: 5e7, minDifficulty: 3, baseDifficulty: 10, requiredHackingSkill: 1, serverGrowth: 5 },
  },
  {
    hostname: "sigma-cosmetics",
    figures: { moneyMax: 5.75e7, minDifficulty: 3, baseDifficulty: 10, requiredHackingSkill: 5, serverGrowth: 10 },
  },
  {
    hostname: "joesguns",
    figures: { moneyMax: 6.25e7, minDifficulty: 5, baseDifficulty: 15, requiredHackingSkill: 10, serverGrowth: 20 },
  },
  {
    hostname: "hong-fang-tea",
    figures: { moneyMax: 7.5e7, minDifficulty: 5, baseDifficulty: 15, requiredHackingSkill: 30, serverGrowth: 20 },
  },
  {
    hostname: "ecorp",
    figures: { moneyMax: 1.7e12, minDifficulty: 33, baseDifficulty: 99, requiredHackingSkill: 1100, serverGrowth: 99 },
  },
];

/** The player at BN4.1's last snapshot: hacking 6,779, its speed taken so a joesguns weaken is 0.41 s (#336). */
const BN4_PLAYER: HackingPlayer = {
  skills: { hacking: 6779, intelligence: 0 },
  mults: { hacking_chance: 3, hacking_speed: 4.465, hacking_money: 20, hacking_grow: 3 },
};
/** `hacking_exp` 19.06 × BN4's `HackExpGain` 0.4 (`BitNode/BitNode.tsx:633-661`). */
const BN4_HACKING_EXP = 19.06 * 0.4;
const BN4_LEVEL_MULT = 11.38;
const BN4_EXP = 6.34e10;
/** 3000 × BN4's `WorldDaemonDifficulty` 3 (`BitNode.tsx:660`). */
const BN4_REQUIRED = 9000;
/** The run's cloud servers and home, GB (#336). */
const CLOUD_GB = 26.2e6;
const HOME_GB = 33.5e6;

describe("the experience a grow or weaken thread earns a second (#336)", () => {
  test("joesguns at BN4.1's level: (3 + 0.3 × 15) × hacking_exp over a weaken's 4 hacks' time", () => {
    const joesguns = SERVERS[3]?.figures as HackingTarget;
    const perThread = 7.5 * BN4_HACKING_EXP;
    expect(perThread).toBeCloseTo(57.18, 2);
    const weakenSeconds = (4 * 5 * (2.5 * 10 * 5 + 500)) / (6779 + 50) / 4.465;
    expect(weakenSeconds).toBeCloseTo(0.41, 2);
    expect(levellingExpPerThreadSecond(joesguns, BN4_PLAYER, BN4_HACKING_EXP)).toBeCloseTo(
      perThread / weakenSeconds,
      9,
    );
    // About 139 a thread-second (#336's reading by hand), against ecorp's 4 or so.
    expect(levellingExpPerThreadSecond(joesguns, BN4_PLAYER, BN4_HACKING_EXP)).toBeCloseTo(139.5, 0);
    const ecorp = SERVERS[5]?.figures as HackingTarget;
    expect(levellingExpPerThreadSecond(ecorp, BN4_PLAYER, BN4_HACKING_EXP)).toBeLessThan(139.5 / 30);
  });

  test("a grow earns 1.25 times a weaken's: the same experience in 3.2 hacks' time against 4", () => {
    const joesguns = SERVERS[3]?.figures as HackingTarget;
    const weaken = levellingExpPerThreadSecond(joesguns, BN4_PLAYER, BN4_HACKING_EXP, "weaken");
    const grow = levellingExpPerThreadSecond(joesguns, BN4_PLAYER, BN4_HACKING_EXP, "grow");
    expect(grow / weaken).toBeCloseTo(1.25, 12);
    expect(grow).toBeCloseTo(174.4, 1);
  });

  test("none where the game gives none: a base difficulty of 0, or unread", () => {
    const joesguns = SERVERS[3]?.figures as HackingTarget;
    expect(levellingExpPerThreadSecond({ ...joesguns, baseDifficulty: 0 }, BN4_PLAYER, BN4_HACKING_EXP)).toBe(0);
    const { baseDifficulty: _, ...unread } = joesguns;
    expect(levellingExpPerThreadSecond(unread, BN4_PLAYER, BN4_HACKING_EXP)).toBe(0);
  });

  test("the target is computed: joesguns, whatever the level and the speed; null with none", () => {
    const slow: HackingPlayer = {
      skills: { hacking: 15, intelligence: 0 },
      mults: { hacking_chance: 1, hacking_speed: 1, hacking_money: 1, hacking_grow: 1 },
    };
    for (const player of [BN4_PLAYER, slow]) {
      expect(chooseLevellingTarget(SERVERS, player, 1)).toMatchObject({ hostname: "joesguns", operation: "grow" });
    }
    // Where it may not grow (not at its minimum security and maximum money), the weaken.
    expect(chooseLevellingTarget(SERVERS, slow, 1, () => false)).toMatchObject({
      hostname: "joesguns",
      operation: "weaken",
    });
    // Only foodnstuff may: its grow's 6 / 507.5 / 3.2 beats joesguns' weaken's 7.5 / 625 / 4.
    expect(chooseLevellingTarget(SERVERS, slow, 1, (target) => target.hostname === "foodnstuff")).toMatchObject({
      hostname: "foodnstuff",
      operation: "grow",
    });
    // Without joesguns, foodnstuff's 6 / 507.5 beats sigma-cosmetics' 6 / 537.5.
    expect(chooseLevellingTarget(SERVERS.slice(0, 3), slow, 1)?.hostname).toBe("foodnstuff");
    expect(chooseLevellingTarget([], slow, 1)).toBeNull();
  });

  test("the level loop's threads: each host's whole ones at 1.75 GB", () => {
    expect(LEVEL_LOOP_RAM_GB).toBe(1.75);
    expect(levelLoopThreads([16, 8, 1.7, 0])).toBe(9 + 4);
  });
});

describe("the time to a level (#336)", () => {
  /**
   * The game's way, step by step: each step's experience at the rate of the floored level now (`calculateSkill`), a
   * thousandth of the experience still to come, so the steps shrink as the level rises.
   */
  function stepped(exp: number, required: number, levelMult: number, kappa: number): number {
    let seconds = 0;
    let now = exp;
    const target = hackingExpOfLevel(required, levelMult);
    while (hackingLevelOfExp(now, levelMult) < required) {
      const rate = kappa * (hackingLevelOfExp(now, levelMult) + 50);
      const gain = Math.max(1, (now + 534.6) * 1e-3, 0);
      const step = Math.min(gain, target - now + 1e-9);
      seconds += step / rate;
      now += step;
    }
    return seconds;
  }

  test.each([
    [0, 3000, 1, 2, 0.01],
    [1e6, 3000, 2.5, 50, 0.01],
    [BN4_EXP, BN4_REQUIRED, BN4_LEVEL_MULT, 1e3, 0.01],
    // A multiplier under 1 (BN2's 0.8, far less here): the game's level is never under 1, and from 1 to 3 the floor
    // is most of a level of 51 to 53, so 2%.
    [0, 3, 0.02, 2, 0.02],
  ])(
    "from %d exp to %d at ×%d: the game's steps within %d (optimistic: its level unfloored)",
    (exp, required, mult, kappa, within) => {
      const ours = secondsToHackingLevel(exp, required, mult, { expPerSecond: kappa * 100, atLevel: 50 });
      const theirs = stepped(exp, required, mult, kappa);
      expect(ours).toBeLessThanOrEqual(theirs * 1.000001);
      expect(ours).toBeGreaterThan(theirs * (1 - within));
    },
  );

  test("0 once reached; Infinity with no rate", () => {
    expect(secondsToHackingLevel(hackingExpOfLevel(3000, 1), 3000, 1, { expPerSecond: 1, atLevel: 1 })).toBe(0);
    expect(secondsToHackingLevel(0, 3000, 1, { expPerSecond: 0, atLevel: 1 })).toBe(Number.POSITIVE_INFINITY);
  });

  test("a rate scales with the level as level + 50: the same rate measured at another level, the same time", () => {
    const at100 = secondsToHackingLevel(0, 3000, 1, { expPerSecond: 150, atLevel: 100 });
    const at1000 = secondsToHackingLevel(0, 3000, 1, { expPerSecond: 1050, atLevel: 1000 });
    expect(at100).toBeCloseTo(at1000, 6);
  });
});

describe("the candidates and the choice (#336), on BN4.1's last snapshot", () => {
  // The chosen operation's, the grow's, joesguns at its minimum security; after an install the grow's too, once
  // prepared from its starting security and money (`levellingPreparationMs`).
  const joesgunsRate = levellingExpPerThreadSecond(
    SERVERS[3]?.figures as HackingTarget,
    BN4_PLAYER,
    BN4_HACKING_EXP,
    "grow",
  );
  const weakenRate = levellingExpPerThreadSecond(SERVERS[3]?.figures as HackingTarget, BN4_PLAYER, BN4_HACKING_EXP);
  const threads = levelLoopThreads([CLOUD_GB, HOME_GB - 32]);
  const homeThreads = levelLoopThreads([HOME_GB - 32]);
  const inputs = {
    exp: BN4_EXP,
    level: 6779,
    required: BN4_REQUIRED,
    levelMult: BN4_LEVEL_MULT,
    money: { expPerSecond: 2.65e6, atLevel: 6779 },
    levelling: { predicted: { expPerSecond: joesgunsRate * threads, atLevel: 6779 }, factor: null },
    install: installOf(17),
  };
  /** (c)'s offer at `levels`: the grow's rate, and the preparation at the level and speed the levels give from 0. */
  function installOf(levels: number) {
    const neuroFlux = neuroFluxMultipliers();
    const after: HackingPlayer = {
      skills: { hacking: hackingLevelOfExp(0, BN4_LEVEL_MULT * neuroFlux.hacking ** levels), intelligence: 0 },
      mults: { ...BN4_PLAYER.mults, hacking_speed: BN4_PLAYER.mults.hacking_speed * neuroFlux.hackingSpeed ** levels },
    };
    const preparationMs = levellingPreparationMs(SERVERS[3]?.figures as HackingTarget, after, homeThreads);
    return { levels, homeThreads, perThread: { expPerSecond: joesgunsRate, atLevel: 6779 }, preparationMs };
  }

  test("the figures the PR quotes: (a) 2,307.7 h, (b) 61.7 min, (c) 22.2 / 29.5 / 105.7 min at 17 / 10 / 1 levels", () => {
    const estimates = levellingEstimates(inputs);
    // At a flat 2.65e6/s, 2.82e13 more experience is the report's 2,873 h; its rise with the level takes some off.
    expect((estimates.money as number) / HOUR).toBeCloseTo(2307.75, 1);
    expect((estimates.level as number) / 60).toBeCloseTo(61.7, 1);
    // Below its maximum money, the weaken: 77.1 min.
    const weakening = levellingEstimates({
      ...inputs,
      levelling: { predicted: { expPerSecond: weakenRate * threads, atLevel: 6779 }, factor: null },
    });
    expect((weakening.level as number) / 60).toBeCloseTo(77.1, 1);
    // The install's own 15 minutes, the root's 3.4 and joesguns' 2.15 to prepare, then 17 levels' cut: 9,000 at
    // ×13.5 is about 6e11 experience.
    // The 17 are assumed (the store's NeuroFlux Governor level isn't in the fixture), not derived from $6.96e15.
    expect((estimates.install as number) / 60).toBeCloseTo(22.2, 1);
    const levels = (count: number) =>
      (levellingEstimates({ ...inputs, install: installOf(count) }).install as number) / 60;
    expect(levels(10)).toBeCloseTo(29.5, 1);
    expect(levels(1)).toBeCloseTo(105.7, 1);
    expect(chooseLevelling(estimates, "money")).toBe("install");
    expect(chooseLevelling(estimates, "level")).toBe("install");
  });

  test("(b)'s fitted factor scales its rate; (c) at the same factor", () => {
    const fitted = levellingEstimates({ ...inputs, levelling: { ...inputs.levelling, factor: 0.5 } });
    const unfitted = levellingEstimates(inputs);
    expect(fitted.level as number).toBeCloseTo((unfitted.level as number) * 2, 0);
    expect(fitted.install as number).toBeGreaterThan(unfitted.install as number);
  });

  test("(c): the install's time and the root's again, then from 0 at the levels' multipliers (the level's, the experience's, the speed's) on home's threads", () => {
    const { hacking, hackingExp, hackingSpeed } = neuroFluxMultipliers();
    expect(LEVELLING_REROOT_MS).toBe(204_000);
    const expected =
      (LEVELLING_INSTALL_MS + LEVELLING_REROOT_MS + inputs.install.preparationMs) / 1000 +
      secondsToHackingLevel(0, BN4_REQUIRED, BN4_LEVEL_MULT * hacking ** 17, {
        expPerSecond: joesgunsRate * homeThreads * (hackingExp * hackingSpeed) ** 17 * 0.8,
        atLevel: 6779,
      });
    const install = levellingEstimates({ ...inputs, levelling: { ...inputs.levelling, factor: 0.8 } }).install;
    expect(install).toBeCloseTo(expected, 6);
  });

  test("the grow's preparation after an install: a weaken at its starting security, a round filling it, a weaken back", () => {
    const joesguns = SERVERS[3]?.figures as HackingTarget;
    const prep = inputs.install.preparationMs;
    // At the level 1.01^17 × 11.38 gives from 0 experience (13) and the speed × 1.01^17.
    const after = { ...BN4_PLAYER, skills: { hacking: 13, intelligence: 0 } };
    after.mults = {
      ...BN4_PLAYER.mults,
      hacking_speed: BN4_PLAYER.mults.hacking_speed * neuroFluxMultipliers().hackingSpeed ** 17,
    };
    const hackMs = (security: number) =>
      ((5 * (2.5 * 10 * security + 500)) / (13 + 50) / after.mults.hacking_speed) * 1000;
    // The grow from a 25th of its money raises the security once; the weaken back is at most the first weaken's.
    expect(prep).toBeGreaterThan(4 * hackMs(15) + 3.2 * hackMs(5) + 4 * hackMs(5));
    expect(prep).toBeLessThan(4 * hackMs(15) + 3.2 * hackMs(5) + 4 * hackMs(100));
    expect(prep / 60_000).toBeCloseTo(2.15, 1);
    // A grow adds nothing once at its maximum money; the preparation's grow at its minimum security.
    expect(levellingPreparationMs({ ...joesguns, baseDifficulty: 5 }, after, homeThreads)).toBeLessThan(prep);
  });

  test("(c) is on offer only with a level to buy and home's threads; its multipliers are NeuroFlux Governor's", () => {
    expect(levellingEstimates({ ...inputs, install: { ...inputs.install, levels: 0 } }).install).toBeNull();
    expect(levellingEstimates({ ...inputs, install: { ...inputs.install, homeThreads: 0 } }).install).toBeNull();
    expect(levellingEstimates({ ...inputs, install: null }).install).toBeNull();
    const neuroFlux = neuroFluxMultipliers();
    for (const multiplier of Object.values(neuroFlux)) {
      expect(multiplier).toBeGreaterThan(1.01);
      expect(multiplier).toBeLessThan(1.0101);
    }
    // At this multiplier each level cuts the experience 9,000 needs by about 22% (#336).
    const cut = hackingExpOfLevel(9000, BN4_LEVEL_MULT * neuroFlux.hacking) / hackingExpOfLevel(9000, BN4_LEVEL_MULT);
    expect(cut).toBeCloseTo(0.78, 2);
  });

  test("(c) with A6's set (#355): the set's multipliers times NeuroFlux Governor's levels; the set alone on offer", () => {
    // QLink's level ×1.75 and speed ×2 alone; then with BitRunners Neurolink's ×1.15, ×1.2 and ×1.05
    // (`Augmentation/Augmentations.ts`): each of the three a product, as the game merges them.
    expect(levellingInstallMultipliers(0, ["QLink"])).toEqual({ hacking: 1.75, hackingExp: 1, hackingSpeed: 2 });
    const set = ["QLink", "BitRunners Neurolink"];
    const product = levellingInstallMultipliers(0, set);
    expect(product.hacking).toBeCloseTo(1.75 * 1.15, 12);
    expect(product.hackingExp).toBeCloseTo(1.2, 12);
    expect(product.hackingSpeed).toBeCloseTo(2 * 1.05, 12);
    // NeuroFlux Governor's levels on top.
    const neuroFlux = neuroFluxMultipliers();
    const both = levellingInstallMultipliers(17, set);
    expect(both.hacking).toBeCloseTo(1.75 * 1.15 * neuroFlux.hacking ** 17, 12);
    expect(both.hackingExp).toBeCloseTo(1.2 * neuroFlux.hackingExp ** 17, 12);
    expect(both.hackingSpeed).toBeCloseTo(2 * 1.05 * neuroFlux.hackingSpeed ** 17, 12);
    expect(levellingInstallMultipliers(17)).toEqual(levellingInstallMultipliers(17, []));
    expect(levellingInstallMultipliers(17).hacking).toBeCloseTo(neuroFlux.hacking ** 17, 12);
    // An augmentation core doesn't know throws: the set is A6's, from the game's names.
    expect(() => levellingInstallMultipliers(0, ["no such augmentation"])).toThrow(/no such augmentation/);
    // The set alone, no level to buy: (c) on offer at the set's multipliers.
    const alone = { ...inputs.install, levels: 0, augmentations: set };
    const estimate = levellingEstimates({ ...inputs, install: alone }).install;
    const expected =
      (LEVELLING_INSTALL_MS + LEVELLING_REROOT_MS + inputs.install.preparationMs) / 1000 +
      secondsToHackingLevel(0, BN4_REQUIRED, BN4_LEVEL_MULT * 1.75 * 1.15, {
        expPerSecond: joesgunsRate * homeThreads * 1.2 * 2 * 1.05,
        atLevel: 6779,
      });
    expect(estimate).toBeCloseTo(expected, 6);
    // With the levels too: shorter than either alone.
    const withLevels = levellingEstimates({ ...inputs, install: { ...inputs.install, augmentations: set } }).install;
    expect(withLevels as number).toBeLessThan(estimate as number);
    expect(withLevels as number).toBeLessThan(levellingEstimates(inputs).install as number);
    // A set that adds nothing to the level, its experience or its speed (Combat Rib I: strength and defence), and no
    // level: nothing to install for, none on offer.
    const nothing = levellingInstallMultipliers(0, ["Combat Rib I"]);
    expect(nothing).toEqual({ hacking: 1, hackingExp: 1, hackingSpeed: 1 });
    expect(
      levellingEstimates({ ...inputs, install: { ...inputs.install, levels: 0, augmentations: ["Combat Rib I"] } })
        .install,
    ).toBeNull();
    expect(levellingEstimates({ ...inputs, install: { ...alone, homeThreads: 0 } }).install).toBeNull();
  });

  test("hysteresis: a move only once the shortest is 1.25 times shorter; money unmeasured waits for it", () => {
    expect(LEVELLING_SWITCH_GAIN).toBe(1.25);
    expect(chooseLevelling({ money: 100, level: 81, install: null, batch: null }, "money")).toBe("money");
    expect(chooseLevelling({ money: 100, level: 79, install: null, batch: null }, "money")).toBe("level");
    expect(chooseLevelling({ money: 79, level: 100, install: null, batch: null }, "level")).toBe("money");
    expect(chooseLevelling({ money: 81, level: 100, install: null, batch: null }, "level")).toBe("level");
    expect(chooseLevelling({ money: null, level: 1, install: 1, batch: null }, "money")).toBe("money");
    // Levelling with no estimate (no target): to the shortest.
    expect(chooseLevelling({ money: 100, level: null, install: null, batch: null }, "level")).toBe("money");
    // A tie goes to the cheapest action; nothing to choose, as it is.
    expect(chooseLevelling({ money: 1, level: 1, install: 1, batch: null }, "install")).toBe("install");
    expect(chooseLevelling({ money: null, level: null, install: null, batch: null }, "level")).toBe("level");
    // Infinity (nothing measured earns) gives way to anything finite.
    expect(chooseLevelling({ money: Number.POSITIVE_INFINITY, level: 1e9, install: null, batch: null }, "money")).toBe(
      "level",
    );
  });

  test("after (c)'s install, the next must still pay by the same score: with little money, no install again", () => {
    // Just after the install: experience from zero at the new multiplier, w0r1d_d43m0n rooted again, the money for
    // a level or two at most (NeuroFlux Governor's price has risen 1.14 times a level).
    const neuroFlux = neuroFluxMultipliers();
    const after = {
      ...inputs,
      exp: 1e9,
      level: hackingLevelOfExp(1e9, BN4_LEVEL_MULT * neuroFlux.hacking ** 17),
      levelMult: BN4_LEVEL_MULT * neuroFlux.hacking ** 17,
      money: null,
      levelling: {
        predicted: {
          expPerSecond: joesgunsRate * homeThreads * (neuroFlux.hackingExp * neuroFlux.hackingSpeed) ** 17,
          atLevel: 6779,
        },
        factor: null,
      },
    };
    const one = levellingEstimates({ ...after, install: { ...after.install, levels: 1 } });
    expect(chooseLevelling(one, "level")).toBe("level");
    expect(one.install as number).toBeGreaterThan(one.level as number);
  });
});

describe("(d): batching for the money, then the augmentations and an install (#380)", () => {
  /** A small case: the levels at $1m, $3m, $7m … ($2m in hand), home's 1,000 threads, the level 2,000 of 3,000 at ×4. */
  const ladder = [0, 1e6, 3e6, 7e6, 15e6, 31e6, 63e6, 127e6, 255e6];
  const small = {
    exp: hackingExpOfLevel(2000, 4),
    level: 2000,
    required: 3000,
    levelMult: 4,
    money: null,
    levelling: { predicted: { expPerSecond: 1e9, atLevel: 2000 }, factor: null },
    install: null,
    batch: {
      money: 2e6,
      incomePerSecond: 1e5,
      ladder,
      homeThreads: 1000,
      perThread: { expPerSecond: 1e6, atLevel: 2000 },
    } as LevellingBatchOffer,
  };
  /** (d) at k levels alone: the batching to the ladder's k, then (c)'s install at k levels. */
  const atLevels = (k: number, inputs = small) =>
    ((ladder[k] as number) - inputs.batch.money) / (inputs.batch.incomePerSecond as number) +
    (levellingEstimates({
      ...inputs,
      batch: null,
      install: { levels: k, homeThreads: 1000, perThread: { expPerSecond: 1e6, atLevel: 2000 } },
    }).install as number);

  test("the least total of the ladder's counts beyond the money now: (M − money) / income, then (c)'s install at them", () => {
    const plan = batchThenInstallPlan(small);
    // Every count beyond the money ($2m: 1 level is in hand, (c)'s), by brute force: the plan's is the least.
    const totals = ladder.map((_, k) => (k >= 2 ? atLevels(k) : Number.POSITIVE_INFINITY));
    const least = totals.indexOf(Math.min(...totals));
    expect(least).toBeGreaterThan(2);
    expect(least).toBeLessThan(ladder.length - 1);
    expect(plan).toEqual({
      seconds: expect.closeTo(totals[least] as number, 6),
      levels: least,
      money: ladder[least],
      batchingSeconds: expect.closeTo(((ladder[least] as number) - 2e6) / 1e5, 9),
    });
    expect(levellingEstimates(small).batch).toBeCloseTo(totals[least] as number, 6);
    // Half the income: longer.
    const slower = batchThenInstallPlan({ ...small, batch: { ...small.batch, incomePerSecond: 5e4 } });
    expect(slower?.seconds as number).toBeGreaterThan(plan?.seconds as number);
    // At (b)'s fitted factor, as (c).
    const fitted = { ...small, levelling: { ...small.levelling, factor: 0.5 } };
    expect(batchThenInstallPlan(fitted)?.seconds as number).toBeGreaterThan(plan?.seconds as number);
  });

  test("the search stops once the batching alone, with the install's fixed time, is past the best: exact, whatever the income", () => {
    for (const income of [1, 1e2, 1e4, 1e6, 1e9, 1e15]) {
      const inputs = { ...small, batch: { ...small.batch, incomePerSecond: income } };
      const plan = batchThenInstallPlan(inputs);
      const brute = Math.min(...ladder.map((_, k) => (k >= 2 ? atLevels(k, inputs) : Number.POSITIVE_INFINITY)));
      expect(plan?.seconds, `income ${income}`).toBeCloseTo(brute, 6);
    }
    // A flood buys the most levels; a trickle the fewest beyond the money.
    const flood = batchThenInstallPlan({ ...small, batch: { ...small.batch, incomePerSecond: 1e15 } });
    expect(flood?.levels).toBe(ladder.length - 1);
    const trickle = batchThenInstallPlan({ ...small, batch: { ...small.batch, incomePerSecond: 1 } });
    expect(trickle?.levels).toBe(2);
    // An entry past what can be named (Infinity) stops it, never a NaN.
    const infinite = { ...small, batch: { ...small.batch, ladder: [0, 1e6, 3e6, Number.POSITIVE_INFINITY, 15e6] } };
    expect(batchThenInstallPlan({ ...infinite, batch: { ...infinite.batch, incomePerSecond: 1e15 } })?.levels).toBe(2);
  });

  test("on offer with an income above 0, home's threads, and a level beyond the money or a set that adds", () => {
    const with_ = (batch: Partial<LevellingBatchOffer>) =>
      batchThenInstallPlan({ ...small, batch: { ...small.batch, ...batch } });
    expect(batchThenInstallPlan({ ...small, batch: null })).toBeNull();
    expect(batchThenInstallPlan({ ...small, batch: undefined })).toBeNull();
    expect(levellingEstimates({ ...small, batch: null }).batch).toBeNull();
    for (const incomePerSecond of [null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(with_({ incomePerSecond }), String(incomePerSecond)).toBeNull();
    }
    expect(with_({ homeThreads: 0 })).toBeNull();
    // Every count within the money now: (c)'s, none for (d).
    expect(with_({ money: 1e9 })).toBeNull();
    // The set alone (k = 0) beyond the money: on offer only if it adds to levelling.
    const setAlone = { ladder: [5e6], money: 0 };
    expect(with_(setAlone)).toBeNull();
    expect(with_({ ...setAlone, augmentations: ["Combat Rib I"] })).toBeNull();
    expect(with_({ ...setAlone, augmentations: ["QLink"] })).toMatchObject({
      levels: 0,
      money: 5e6,
      batchingSeconds: 50,
    });
    // The set's multipliers with the levels, as (c)'s.
    expect(with_({ augmentations: ["QLink"] })?.seconds as number).toBeLessThan(with_({})?.seconds as number);
  });

  test("the choice: (d) once 1.25 times shorter; from (d), the install once (c) is no longer than (d), at once", () => {
    const of = (money: number | null, level: number | null, install: number | null, batch: number | null) => ({
      money,
      level,
      install,
      batch,
    });
    expect(chooseLevelling(of(1000, 100, null, 79), "level")).toBe("batch");
    expect(chooseLevelling(of(1000, 100, null, 81), "level")).toBe("level");
    expect(chooseLevelling(of(1000, 100, null, 79), "money")).toBe("batch");
    // A tie goes to the cheapest action: (d) last.
    expect(chooseLevelling(of(50, 1000, 50, 50), "level")).toBe("money");
    // From (d): the money in hand reaches M, (c) no longer than (d): the install, no hysteresis.
    expect(chooseLevelling(of(1000, 100, 60, 60), "batch")).toBe("install");
    expect(chooseLevelling(of(1000, 100, 59, 60), "batch")).toBe("install");
    // (c) longer than (d): batching goes on.
    expect(chooseLevelling(of(1000, 100, 61, 60), "batch")).toBe("batch");
    // The income fell (#380's "a drop in income re-decides"): (d) past levelling mode by 1.25 times, levelling mode.
    expect(chooseLevelling(of(1000, 100, null, 126), "batch")).toBe("level");
    expect(chooseLevelling(of(1000, 100, null, 124), "batch")).toBe("batch");
    // From (d) to the install, another 1.25 times shorter than the install wins instead.
    expect(chooseLevelling(of(1000, 40, 60, 60), "batch")).toBe("level");
    // (d) gone: to the shortest.
    expect(chooseLevelling(of(1000, 100, null, null), "batch")).toBe("level");
  });
});

describe("(d)'s golden cases (#380): BN4.1's and BN4.2's figures", () => {
  const BN4_COSTS = augmentationBitNodeMultipliers(4, {});
  const NO_SET = { purchases: [], money: 0, donations: [], donationMoney: 0, byDonation: [] };

  test("BN4.1: at The Red Pill, (d) batches to $3.09e13 for ×10 (31 min), not to $70e15 for ×20 (68.8 h)", () => {
    // Shaped like BN4.1 rooted again after The Red Pill (#339: hacking 2,938, its money spent), at #336's fixture's
    // multipliers and RAM, NeuroFlux Governor at 76 (the destroy's 96 less the last install's 20), the reputation for
    // every level taken as reached (assumed), and the online money pace: $6.96e15 in 6.82 h (#336, before the offline
    // gap), 2.835e11/s. Levelling mode's 61.9 min against (d)'s 31.1 min: (d), at once.
    const state = {
      installed: { [NEUROFLUX_GOVERNOR]: 76 },
      queued: [],
      sourceFile11Level: 0,
      bitNodeMultipliers: BN4_COSTS,
    };
    const bn4Ladder = neuroFluxLadder({ state, set: NO_SET, neuroFluxReputation: Number.POSITIVE_INFINITY });
    // The first level after 76: 750e3 × 1.14^76 (`Augmentation/AugmentationHelpers.ts:128-140`); ×20 about $70e15.
    expect((bn4Ladder[1] as number) / (750e3 * 1.14 ** 76)).toBeCloseTo(1, 9);
    expect((bn4Ladder[20] as number) / 1e15).toBeCloseTo(70.19, 1);
    const income = 6.96e15 / (6.82 * 3600);
    const joesguns = SERVERS[3]?.figures as HackingTarget;
    const joesgunsRate = levellingExpPerThreadSecond(joesguns, BN4_PLAYER, BN4_HACKING_EXP, "grow");
    const homeThreads = levelLoopThreads([HOME_GB - 32]);
    const atRoot = {
      exp: hackingExpOfLevel(2938, BN4_LEVEL_MULT),
      level: 2938,
      required: BN4_REQUIRED,
      levelMult: BN4_LEVEL_MULT,
      money: null,
      levelling: {
        predicted: { expPerSecond: joesgunsRate * levelLoopThreads([CLOUD_GB, HOME_GB - 32]), atLevel: 6779 },
        factor: null,
      },
      install: null,
      batch: {
        money: 0,
        incomePerSecond: income,
        ladder: bn4Ladder,
        homeThreads,
        perThread: { expPerSecond: joesgunsRate, atLevel: 6779 },
        preparationMs: 2.15 * 60_000,
      },
    };
    // (a), batching's experience: #336's measured 2.65e6/s.
    const measuredMoney = { expPerSecond: 2.65e6, atLevel: 6779 };
    const estimates = levellingEstimates(atRoot);
    const plan = batchThenInstallPlan(atRoot);
    expect((estimates.level as number) / 60).toBeCloseTo(61.9, 1);
    expect(plan?.levels).toBe(10);
    expect((plan?.money as number) / 1e13).toBeCloseTo(3.09, 2);
    expect((plan?.batchingSeconds as number) / 60).toBeCloseTo(1.8, 1);
    expect((estimates.batch as number) / 60).toBeCloseTo(31.1, 1);
    expect(chooseLevelling(estimates, "money")).toBe("money");
    expect(chooseLevelling(levellingEstimates({ ...atRoot, money: measuredMoney }), "money")).toBe("batch");
    // ×20: 68.8 h of batching at that pace. BN4.1 bought it with $7.09e16 in hand after a 13.2-hour offline gap:
    // (c)'s, the money already there; (d) then looks past it.
    expect((bn4Ladder[20] as number) / income / 3600).toBeCloseTo(68.8, 1);
    const inHand = levellingEstimates({ ...atRoot, batch: { ...atRoot.batch, money: 7.09e16 } });
    expect(inHand.batch as number).toBeGreaterThan(estimates.batch as number);
  });

  test("BN4.2: at 8,148 with its income at The Red Pill, (d) is about 40 min (×14), against levelling mode's 7.3 h", () => {
    // BN4.2's last snapshot (2026-11-12's run report): hacking 8,148 of 9,000, home 16,777,216 GB and 1,200,756 GB on
    // the hack loop's hosts, $288,624, levelling's fitted factor 0.96. Its multipliers from its installed list (the
    // campaign report's), SF1.3's ×1.28 (`SourceFile/applySourceFile.ts`) and NeuroFlux Governor at 73; BitRunners
    // (110,603) and Daedalus (96,515), donations unlocked (`Faction/formulas/donation.ts:8-10`, BN4's
    // FactionWorkRepGain 0.75, `BitNode/BitNode.tsx:651`). The income: the batcher's best hour before The Red Pill,
    // $1.83e12/s (the report's section 5). No set: assumed, none of the joined shops' left.
    const installed = [
      "Artificial Synaptic Potentiation",
      "Cranial Signal Processors - Gen I",
      "Speech Processor Implant",
      "Neurotrainer II",
      "INFRARET Enhancement",
      "Social Negotiation Assistant (S.N.A)",
      "Combat Rib I",
      "Nuoptimal Nootropic Injector Implant",
      "ADR-V1 Pheromone Gene",
      "Augmented Targeting I",
      "Speech Enhancement",
      "BitWire",
      "Synaptic Enhancement Implant",
      "Neurotrainer I",
      "Wired Reflexes",
      "NutriGen Implant",
      "Neural-Retention Enhancement",
      "Embedded Netburner Module",
      "Cranial Signal Processors - Gen II",
      "Neural Wit Amplifier",
      "Magnetism Amplifier",
      "Cranial Signal Processors - Gen III",
      "CRTX42-AA Gene Modification",
      "CashRoot Starter Kit",
      "Augmented Targeting II",
      "Combat Rib II",
      "DermaForce Particle Barrier",
      "Nanofiber Weave",
      "Neuregen Gene Modification",
      "Neuralstimulator",
      "Enhanced Myelin Sheathing",
      "Cranial Signal Processors - Gen IV",
      "The Black Hand",
      "DataJack",
      "Artificial Bio-neural Network Implant",
      "Embedded Netburner Module Core Implant",
      "Cranial Signal Processors - Gen V",
      "Neural Accelerator",
      "Embedded Netburner Module Core V2 Upgrade",
      "BitRunners Neurolink",
      "Embedded Netburner Module Core V3 Upgrade",
      "Embedded Netburner Module Direct Memory Access Upgrade",
      "Embedded Netburner Module Analyze Engine",
      "The Red Pill",
    ];
    const multiplierOf = (name: string, key: string) =>
      (AUGMENTATIONS[name]?.multipliers as Readonly<Record<string, number>> | undefined)?.[key] ?? 1;
    const mult = (key: string) =>
      installed.reduce((product, name) => product * multiplierOf(name, key), 1.28) *
      multiplierOf(NEUROFLUX_GOVERNOR, key) ** 73;
    const levelMult = mult("hacking");
    expect(levelMult).toBeCloseTo(11.04, 2);
    const player: HackingPlayer = {
      skills: { hacking: 8148, intelligence: 0 },
      mults: { hacking_chance: 1, hacking_speed: mult("hacking_speed"), hacking_money: 1, hacking_grow: 1 },
    };
    // joesguns at BN4's ServerMaxMoney 0.1125 (`BitNode/BitNode.tsx:635`): the preparation's grow alone reads it.
    const joesguns = { ...(SERVERS[3]?.figures as HackingTarget), moneyMax: 6.25e7 * 0.1125 };
    const rate = levellingExpPerThreadSecond(joesguns, player, mult("hacking_exp") * 0.4, "grow");
    const homeThreads = levelLoopThreads([16_777_216 - 32]);
    const threads = levelLoopThreads([1_200_756]) + homeThreads;
    // The run report's formula: 2.01e9/s for the RAM it runs on.
    expect((rate * threads) / 1e9).toBeCloseTo(2.02, 2);
    const state = {
      installed: { [NEUROFLUX_GOVERNOR]: 73 },
      queued: [],
      sourceFile11Level: 0,
      bitNodeMultipliers: BN4_COSTS,
    };
    const bn4Ladder = neuroFluxLadder({
      state,
      set: NO_SET,
      neuroFluxReputation: 110_603,
      donations: {
        sellers: {},
        neuroFluxSellers: [
          { faction: "Daedalus", reputation: 96_515 },
          { faction: "BitRunners", reputation: 110_603 },
        ],
        factionRep: mult("faction_rep"),
        factionWorkRepGain: 0.75,
      },
    });
    // The first level's reputation, 500 × 1.14^73 (7.2m), is mostly its donation's: $2.81e12, past the $789b in hand
    // at The Red Pill, so (c) had none.
    expect((bn4Ladder[1] as number) / 1e12).toBeCloseTo(2.81, 2);
    const after = { ...player, skills: { hacking: hackingLevelOfExp(0, levelMult), intelligence: 0 } };
    const inputs = {
      exp: hackingExpOfLevel(8148, levelMult),
      level: 8148,
      required: BN4_REQUIRED,
      levelMult,
      money: null,
      levelling: { predicted: { expPerSecond: rate * threads, atLevel: 8148 }, factor: 0.96 },
      install: null,
      batch: {
        money: 288_624,
        incomePerSecond: 1.83e12,
        ladder: bn4Ladder,
        homeThreads,
        perThread: { expPerSecond: rate, atLevel: 8148 },
        preparationMs: levellingPreparationMs(joesguns, after, homeThreads),
      },
    };
    const estimates = levellingEstimates(inputs);
    const plan = batchThenInstallPlan(inputs);
    // Levelling mode's 7.3 h, as the report said.
    expect((estimates.level as number) / 3600).toBeCloseTo(7.28, 2);
    expect(plan?.levels).toBe(14);
    expect((plan?.money as number) / 1e14).toBeCloseTo(4.74, 2);
    expect((plan?.batchingSeconds as number) / 60).toBeCloseTo(4.3, 1);
    expect((estimates.batch as number) / 60).toBeCloseTo(40.3, 1);
    expect(chooseLevelling(estimates, "level")).toBe("batch");
    // At the window's mean income ($1.01e12/s) and the hour of The Red Pill's install ($6.44e11/s): ×13 each.
    for (const [incomePerSecond, minutes] of [
      [1.01e12, 43.6],
      [6.44e11, 45.7],
    ] as const) {
      const slower = { ...inputs, batch: { ...inputs.batch, incomePerSecond } };
      expect(batchThenInstallPlan(slower)?.levels).toBe(13);
      expect((levellingEstimates(slower).batch as number) / 60).toBeCloseTo(minutes, 1);
    }
  });
});
