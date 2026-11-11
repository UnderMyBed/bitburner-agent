// Levelling (#336): the experience a grow or weaken thread earns a second, the levelling target and operation, the
// time to a level, and the planner's three candidates and choice, on figures shaped like BN4.1's last snapshot
// (2026-11-10's run; its hacking_speed and NeuroFlux Governor levels assumed, not read).
import { describe, expect, test } from "vitest";
import { hackingExpOfLevel, hackingLevelOfExp } from "../src/batcher.ts";
import { LEVEL_LOOP_RAM_GB } from "../src/hack-loop.ts";
import type { HackingPlayer, HackingTarget } from "../src/hacking-ceiling.ts";
import {
  chooseLevelling,
  chooseLevellingTarget,
  LEVELLING_INSTALL_MS,
  LEVELLING_REROOT_MS,
  LEVELLING_SWITCH_GAIN,
  levelLoopThreads,
  levellingEstimates,
  levellingExpPerThreadSecond,
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
  // The chosen operation's, the grow's, joesguns at its minimum security and maximum money; after an install, the
  // weaken's (every server back at its starting money).
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
    install: { levels: 17, homeThreads, perThread: { expPerSecond: weakenRate, atLevel: 6779 } },
  };

  test("the figures the PR quotes: (a) 2,307.7 h, (b) 61.7 min, (c) 20.5 / 29.3 / 124.2 min at 17 / 10 / 1 levels", () => {
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
    // The install's own 15 minutes and the root's 3.4, then 17 levels' cut: 9,000 at ×13.5 is about 6e11 experience.
    // The 17 are assumed (the store's NeuroFlux Governor level isn't in the fixture), not derived from $6.96e15.
    expect((estimates.install as number) / 60).toBeCloseTo(20.5, 1);
    const levels = (count: number) =>
      (levellingEstimates({ ...inputs, install: { ...inputs.install, levels: count } }).install as number) / 60;
    expect(levels(10)).toBeCloseTo(29.3, 1);
    expect(levels(1)).toBeCloseTo(124.2, 1);
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
      (LEVELLING_INSTALL_MS + LEVELLING_REROOT_MS) / 1000 +
      secondsToHackingLevel(0, BN4_REQUIRED, BN4_LEVEL_MULT * hacking ** 17, {
        expPerSecond: weakenRate * homeThreads * (hackingExp * hackingSpeed) ** 17 * 0.8,
        atLevel: 6779,
      });
    const install = levellingEstimates({ ...inputs, levelling: { ...inputs.levelling, factor: 0.8 } }).install;
    expect(install).toBeCloseTo(expected, 6);
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

  test("hysteresis: a move only once the shortest is 1.25 times shorter; money unmeasured waits for it", () => {
    expect(LEVELLING_SWITCH_GAIN).toBe(1.25);
    expect(chooseLevelling({ money: 100, level: 81, install: null }, "money")).toBe("money");
    expect(chooseLevelling({ money: 100, level: 79, install: null }, "money")).toBe("level");
    expect(chooseLevelling({ money: 79, level: 100, install: null }, "level")).toBe("money");
    expect(chooseLevelling({ money: 81, level: 100, install: null }, "level")).toBe("level");
    expect(chooseLevelling({ money: null, level: 1, install: 1 }, "money")).toBe("money");
    // Levelling with no estimate (no target): to the shortest.
    expect(chooseLevelling({ money: 100, level: null, install: null }, "level")).toBe("money");
    // A tie goes to the cheapest action; nothing to choose, as it is.
    expect(chooseLevelling({ money: 1, level: 1, install: 1 }, "install")).toBe("install");
    expect(chooseLevelling({ money: null, level: null, install: null }, "level")).toBe("level");
    // Infinity (nothing measured earns) gives way to anything finite.
    expect(chooseLevelling({ money: Number.POSITIVE_INFINITY, level: 1e9, install: null }, "money")).toBe("level");
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
