// The cycle model's parts (#260): the calibration's consistency, the curves, the policies, and what it keeps of the
// game's rules.
import { readFileSync } from "node:fs";
import {
  favorAfterInstall,
  HACKING_MULTIPLIERS,
  hackingExpForLevel,
  installGains,
  NEUROFLUX_GOVERNOR,
} from "@bitburner-agent/core";
import { describe, expect, test } from "vitest";
import {
  CALIBRATION,
  Curves,
  HACKER_FACTION_JOINS,
  hackingLevelOf,
  homeRamAfter,
  installDecision,
  measuredAt,
  multipliersOf,
  programsPrice,
  READ_MINUTES,
  RUN_3_CYCLES,
  RUN_3_POLICY,
  RUN_3_SHARE_BONUS,
  runModel,
  shareBonusOf,
  sourceFile1Bonus,
  startHomeRamGb,
  TODAYS_POLICY,
  WORLD_DAEMON_HACKING,
} from "../src/index.ts";
import { RUN_3_BN1_2 } from "./fixtures.ts";

const MINUTE_MS = 60_000;
const curves = new Curves(CALIBRATION);
/** Run #3's model, and each step's hacking level and money by its time. */
const steps = new Map<number, { hacking: number; money: number }>();
const run3 = runModel(RUN_3_BN1_2.start, {
  policy: RUN_3_POLICY,
  onStep: ({ atMs, hacking, money }) => steps.set(atMs, { hacking, money }),
});

describe("the calibration", () => {
  test("the reference cycles' multipliers are what the model runs those cycles of run #3 at", () => {
    for (const { cycle, multipliers } of CALIBRATION.referenceCycles) {
      const model = run3.cycles[cycle - 1]?.multipliers;
      for (const key of ["hacking", "hacking_exp", "hacking_speed", "hacking_money"] as const) {
        expect(multipliers[key], `cycle ${cycle}'s ${key}`).toBeCloseTo(model?.[key] ?? 0, 3);
      }
    }
  });

  test("the share bonus is run #3's own a cycle, its last past the list", () => {
    expect(shareBonusOf(CALIBRATION, 0)).toBe(RUN_3_SHARE_BONUS[0]);
    expect(shareBonusOf(CALIBRATION, 3)).toBe(1.16);
    expect(shareBonusOf(CALIBRATION, 40)).toBe(RUN_3_SHARE_BONUS[RUN_3_SHARE_BONUS.length - 1]);
  });

  test("the curve at a reference cycle's multipliers is near that cycle's level: the median of four", () => {
    for (const { cycle, multipliers } of CALIBRATION.referenceCycles) {
      for (const [minutes, level] of RUN_3_CYCLES[cycle - 1]?.points ?? []) {
        if (minutes < 30 || minutes > 60) continue;
        expect(
          Math.abs(curves.hackingLevelAt(minutes, multipliers) / level - 1),
          `cycle ${cycle}, ${minutes} min`,
        ).toBeLessThan(0.15);
      }
    }
  });

  test("the curve's constants are the fit's: each a local best of the error on run #3's own level and money", () => {
    // The error the fit minimised: over every reading of run #3's ten cycles, the mean |ln| of the level's ratio and a
    // third of the mean |log10| of the money's (floored at $1m), the model at the same minute of the same cycle.
    const error = (calibration: Partial<typeof CALIBRATION>) => {
      const seen = new Map<string, { hacking: number; money: number }>();
      let cycle = 0;
      let last = Number.POSITIVE_INFINITY;
      runModel(RUN_3_BN1_2.start, {
        policy: RUN_3_POLICY,
        calibration,
        onStep: ({ onlineMs, hacking, money }) => {
          if (onlineMs < last) cycle += 1;
          last = onlineMs;
          seen.set(`${cycle}:${onlineMs / MINUTE_MS}`, { hacking, money });
        },
      });
      let level = 0;
      let money = 0;
      let readings = 0;
      for (const [index, { points }] of RUN_3_CYCLES.entries()) {
        for (const [minutes, actualLevel, income] of points) {
          const step = seen.get(`${index + 1}:${minutes}`);
          if (step === undefined || !READ_MINUTES.includes(minutes)) continue;
          level += Math.abs(Math.log(step.hacking / actualLevel));
          money += Math.abs(Math.log10(Math.max(1e6, step.money) / Math.max(1e6, income)));
          readings += 1;
        }
      }
      return (level + money / 3) / readings;
    };
    const fitted = error({});
    // 0.29 at the fit (13% on the level, ×3 on the money); without the money's pace, 0.38.
    expect(fitted).toBeLessThan(0.3);
    const { expPaceExponent, moneyPaceExponent, firstCycleSpeed, fullSpeedHomeRamGb } = CALIBRATION;
    for (const neighbour of [
      { expPaceExponent: expPaceExponent - 0.125 },
      { expPaceExponent: expPaceExponent + 0.125 },
      { moneyPaceExponent: moneyPaceExponent - 0.125 },
      { moneyPaceExponent: moneyPaceExponent + 0.125 },
      { firstCycleSpeed: firstCycleSpeed - 0.1 },
      { firstCycleSpeed: firstCycleSpeed + 0.1 },
      { fullSpeedHomeRamGb: fullSpeedHomeRamGb / 4 },
      { fullSpeedHomeRamGb: fullSpeedHomeRamGb * 4 },
    ]) {
      expect(fitted, JSON.stringify(neighbour)).toBeLessThanOrEqual(error(neighbour));
    }
  });

  test("a partial override keeps the rest (the sensitivity sweeps)", () => {
    const swept = runModel(RUN_3_BN1_2.start, {
      policy: RUN_3_POLICY,
      calibration: { moneyPaceExponent: CALIBRATION.moneyPaceExponent },
    });
    expect(swept).toEqual(run3);
    const slower = runModel(RUN_3_BN1_2.start, { policy: RUN_3_POLICY, calibration: { firstCycleSpeed: 0.3 } });
    expect(slower.cycles[0]?.endMs).toBeGreaterThan(run3.cycles[0]?.endMs ?? 0);
  });
});

describe("the curves", () => {
  test("the game's skill formula: calculateSkill inverts hackingExpForLevel", () => {
    for (const level of [1, 50, 616, 3000]) {
      expect(hackingLevelOf(hackingExpForLevel(level, 1.3) + 1e-6, 1.3)).toBe(level);
    }
  });

  test("past the last reading, the money grows at its last rate", () => {
    const at = (minutes: number) => curves.moneyAt(minutes, { hacking_money: 1 });
    expect(at(140) - at(130)).toBeCloseTo(at(130) - at(120), 0);
    expect(at(130)).toBeGreaterThan(at(120));
  });

  test("home's pace: the first cycle's at 8 GB, the reference's from `fullSpeedHomeRamGb`, log-linear between", () => {
    const { firstCycleSpeed, fullSpeedHomeRamGb } = CALIBRATION;
    expect(curves.homeSpeedOf(8)).toBe(firstCycleSpeed);
    expect(curves.homeSpeedOf(fullSpeedHomeRamGb)).toBe(1);
    expect(curves.homeSpeedOf(2 ** 30)).toBe(1);
    const halfway = 2 ** ((3 + Math.log2(fullSpeedHomeRamGb)) / 2);
    expect(curves.homeSpeedOf(halfway)).toBeCloseTo(firstCycleSpeed + (1 - firstCycleSpeed) / 2, 12);
  });

  test("at the reference multipliers the clocks run at the reference's pace; higher multipliers run them faster", () => {
    const one = curves.advanceClocks({ exp: 20, money: 20 }, 10 * MINUTE_MS, curves.reference, 2 ** 20);
    expect(one.exp).toBeCloseTo(30, 6);
    expect(one.money).toBeCloseTo(30, 6);
    const faster = { ...curves.reference, hacking: 6, hacking_speed: 4 };
    const two = curves.advanceClocks({ exp: 20, money: 20 }, 10 * MINUTE_MS, faster, 2 ** 20);
    expect(two.exp).toBeGreaterThan(two.money);
    expect(two.money).toBeGreaterThan(30);
  });

  test("a measured cycle read back: the level linear, the money geometric, past the end at the last slope", () => {
    const points = [
      [10, 100, 1e6],
      [20, 300, 1e8],
    ] as const;
    expect(measuredAt(points, 15)).toEqual({ hacking: 200, money: 1e7 });
    expect(measuredAt(points, 0).hacking).toBe(1);
    expect(measuredAt(points, 30).hacking).toBe(500);
  });

  test("home's RAM doubles while the money covers each upgrade on top of those before it", () => {
    expect(homeRamAfter(8, 0)).toBe(8);
    // 8 → 16 costs $1,009,743.87; 16 → 32, $3,190,790.64 more.
    expect(homeRamAfter(8, 1_009_744)).toBe(16);
    expect(homeRamAfter(8, 4_200_534)).toBe(16);
    expect(homeRamAfter(8, 4_200_535)).toBe(32);
    expect(homeRamAfter(2 ** 30, 1e300)).toBe(2 ** 30);
  });
});

describe("the model", () => {
  test("SF1's bonus: 16%, 24%, 28% (`applySourceFile.ts:15-40`), on every hacking multiplier", () => {
    expect(sourceFile1Bonus(0)).toBe(1);
    expect(sourceFile1Bonus(1)).toBeCloseTo(1.16, 12);
    expect(sourceFile1Bonus(2)).toBeCloseTo(1.24, 12);
    expect(sourceFile1Bonus(3)).toBeCloseTo(1.28, 12);
    // Each NeuroFlux Governor level counts once (core's `installGains` takes a name per level).
    const multipliers = multipliersOf({ BitWire: 1, [NEUROFLUX_GOVERNOR]: 2 }, 1);
    const gains = installGains(["BitWire", NEUROFLUX_GOVERNOR, NEUROFLUX_GOVERNOR]);
    for (const key of HACKING_MULTIPLIERS) expect(multipliers[key]).toBeCloseTo(gains[key] * 1.16, 12);
    expect(multipliers.hacking).toBeGreaterThan(multipliersOf({ BitWire: 1, [NEUROFLUX_GOVERNOR]: 1 }, 1).hacking);
  });

  test("is deterministic", () => {
    expect(runModel(RUN_3_BN1_2.start, { policy: RUN_3_POLICY })).toEqual(run3);
  });

  test("banks each faction's favour at an install by the game's formula", () => {
    let favor: Record<string, number> = {};
    for (const cycle of run3.cycles) {
      for (const [faction, reputation] of Object.entries(cycle.reputation)) {
        expect(cycle.favorAfter[faction]).toBe(favorAfterInstall(favor[faction] ?? 0, reputation));
      }
      favor = { ...favor, ...cycle.favorAfter };
    }
  });

  test("never installs nothing, and starts each cycle's reputation from nothing", () => {
    for (const cycle of run3.cycles) {
      expect(cycle.installed.length + cycle.neuroFluxLevels).toBeGreaterThan(0);
      expect(cycle.endMs).toBeGreaterThan(cycle.startMs);
    }
    // CyberSec is joined afresh in the 2nd cycle, and its reputation there is no more than one cycle's work at its
    // best rate and a cycle's passive gain (at most a tenth of it, `processPassiveFactionRepGain`).
    const second = run3.cycles[1];
    const lengthS = ((second?.endMs ?? 0) - (second?.startMs ?? 0)) / 1000;
    expect(
      run3.events.some(
        (event) => event.kind === "joined" && event.faction === "CyberSec" && event.atMs > (second?.startMs ?? 0),
      ),
    ).toBe(true);
    expect(second?.reputation.CyberSec ?? 0).toBeLessThanOrEqual((second?.bestRatePerSecond.CyberSec ?? 0) * lengthS);
  });

  test("a favour grind naming a faction not joined leaves A5's choice", () => {
    const named = runModel(RUN_3_BN1_2.start, {
      policy: { ...RUN_3_POLICY, name: "a faction never joined", favourGrind: () => "Illuminati" },
    });
    expect(named.cycles).toEqual(run3.cycles);
  });

  test("passive reputation at the joined factions not worked for (`processPassiveFactionRepGain`)", () => {
    // Tian Di Hui is joined in the 1st cycle and barely worked: its reputation is passive, a percent of its rate.
    const first = run3.cycles[0];
    const passive = Object.entries(first?.reputation ?? {}).filter(
      ([faction]) => !(faction in (first?.workMinutes ?? {})),
    );
    expect(passive.length).toBeGreaterThan(0);
    for (const [, reputation] of passive) expect(reputation).toBeGreaterThan(0);
  });

  test("BN1.2 starts home at 32 GB, with SF1 (`Prestige.ts:254-260`); BN1.1 at 8", () => {
    expect(startHomeRamGb(1)).toBe(32);
    expect(startHomeRamGb(0)).toBe(8);
  });

  test("a hacker faction's join level is the top of its server's range, and its ports, in the pinned game", () => {
    const servers = readFileSync(
      new URL("../../../vendor/bitburner-src/src/Server/data/servers.ts", import.meta.url),
      "utf8",
    ).split("hostname:");
    const keys: Record<string, string> = {
      CyberSec: "CyberSecServer",
      NiteSec: "NiteSecServer",
      "The Black Hand": "TheBlackHandServer",
      BitRunners: "BitRunnersServer",
    };
    for (const { faction, hacking, ports } of HACKER_FACTION_JOINS) {
      const server = servers.find((each) => each.trimStart().startsWith(`SpecialServers.${keys[faction]},`)) ?? "";
      expect(Number(/requiredHackingSkill:\s*\{\s*max:\s*(\d+)/.exec(server)?.[1]), faction).toBe(hacking);
      expect(Number(/numOpenPortsRequired:\s*(\d+)/.exec(server)?.[1]), faction).toBe(ports);
    }
  });

  test("joins a hacker faction at the first step its server's level and its programs' money are both reached", () => {
    for (const { faction, hacking, ports } of HACKER_FACTION_JOINS) {
      const joins = run3.events.filter((event) => event.kind === "joined" && event.faction === faction);
      expect(joins.length).toBeGreaterThan(0);
      for (const { atMs } of joins) {
        const now = steps.get(atMs);
        const before = steps.get(atMs - MINUTE_MS);
        // The step before an install's next is the cycle before's: no comparison across an install.
        const afterInstall = run3.cycles.some((cycle) => cycle.endMs === atMs - MINUTE_MS);
        expect(now?.hacking).toBeGreaterThanOrEqual(hacking);
        expect(now?.money).toBeGreaterThanOrEqual(programsPrice(ports));
        if (!afterInstall) {
          expect((before?.hacking ?? 0) < hacking || (before?.money ?? 0) < programsPrice(ports)).toBe(true);
        }
      }
    }
  });

  test("joins Daedalus only with its count, hacking 2500 and $100b, and destroys at w0r1d_d43m0n's level", () => {
    const daedalus = run3.events.filter((event) => event.kind === "joined" && event.faction === "Daedalus");
    const counted = run3.cycles.find((cycle) => cycle.countAfter >= 30);
    expect(daedalus.length).toBeGreaterThan(0);
    for (const { atMs } of daedalus) {
      expect(atMs).toBeGreaterThan(counted?.endMs ?? Number.POSITIVE_INFINITY);
      expect(steps.get(atMs)?.hacking).toBeGreaterThanOrEqual(2500);
      expect(steps.get(atMs)?.money).toBeGreaterThanOrEqual(100e9);
    }
    const redPill = run3.cycles.find((cycle) => cycle.installed.includes("The Red Pill"));
    const destroyed = run3.destroyedAtMs ?? 0;
    expect(destroyed).toBeGreaterThan(redPill?.endMs ?? Number.POSITIVE_INFINITY);
    expect(steps.get(destroyed)?.hacking).toBeGreaterThanOrEqual(WORLD_DAEMON_HACKING);
    expect(steps.get(destroyed - MINUTE_MS)?.hacking).toBeLessThan(WORLD_DAEMON_HACKING);
  });

  test("A6: nothing left at the joined factions installs what the money bought, short of the bars", () => {
    // CyberSec's five reached; the money buys them all, and too few NeuroFlux Governor levels for the bar of 12.
    const decide = (money: number) =>
      installDecision({
        installed: {},
        joined: [{ name: "CyberSec", reputation: 1e6, favor: 0 }],
        currentNode: 1,
        ownedSF: {},
        money,
        hacking: 300,
        factionRep: 1,
        onlineMs: 30 * MINUTE_MS,
      });
    const decision = decide(450e6);
    expect(decision?.names).toHaveLength(5);
    expect(decision?.neuroFluxLevels).toBeLessThan(7);
    expect(decision?.reason).toBe("nothing left");
    // Short of the five, something's left: no install.
    expect(decide(150e6)?.reason).toBeNull();
  });

  test("A8: The Red Pill by a donation once Daedalus's are unlocked and the money covers it; held till then", () => {
    const decide = (money: number) =>
      installDecision({
        installed: {},
        joined: [{ name: "Daedalus", reputation: 0, favor: 150 }],
        currentNode: 1,
        ownedSF: {},
        money,
        hacking: 3000,
        factionRep: 4,
        onlineMs: 5 * MINUTE_MS,
      });
    // 2.5m reputation at $1m a reputation over faction_rep 4: $625b, and a hair.
    expect(decide(624e9)).toBeNull();
    expect(decide(626e9)?.reason).toBe("The Red Pill");
    expect(decide(626e9)?.names).toContain("The Red Pill");
  });

  test("today's policy is run #3's on this path: no install in it would leave Daedalus's count one short (#243)", () => {
    // The model's 7th install takes the count from 25 to 34, past 29, so #243's hold never arises on run #3's path
    // (run #3's own 7th took it to 29). The hold's wiring is checked by the probes, not by a run in reach.
    const today = runModel(RUN_3_BN1_2.start, { policy: TODAYS_POLICY });
    expect(today.cycles.every((cycle) => cycle.heldMinutes === 0)).toBe(true);
    expect(today.cycles).toEqual(run3.cycles);
  });

  test("a policy's favour grind works the faction it names toward its donations", () => {
    const grind = runModel(RUN_3_BN1_2.start, {
      policy: {
        name: "favour first",
        daedalusCountHold: true,
        favourGrind: ({ joined }) => (joined.some((each) => each.name === "BitRunners") ? "BitRunners" : null),
      },
    });
    // From BitRunners' join (the 3rd cycle), its work goes to the donations' target, not to an augmentation's.
    const grindMinutes = grind.cycles[2]?.donationTargetMinutes ?? 0;
    expect(grindMinutes).toBeGreaterThan(30);
    expect(grindMinutes).toBe(grind.cycles[2]?.workMinutes.BitRunners);
    expect(run3.cycles[2]?.donationTargetMinutes).toBe(0);
    expect(grind.events.some((event) => event.kind === "donationsUnlocked" && event.faction === "BitRunners")).toBe(
      true,
    );
  });

  test("a policy's install: never installing leaves the BitNode standing; installing at once makes short cycles", () => {
    const never = runModel(RUN_3_BN1_2.start, {
      policy: { name: "never", daedalusCountHold: false, install: () => false },
      horizonMs: 6 * 60 * MINUTE_MS,
    });
    expect(never.cycles).toHaveLength(0);
    const eager = runModel(RUN_3_BN1_2.start, {
      policy: { name: "eager", daedalusCountHold: false, install: () => true },
      horizonMs: 2 * 60 * MINUTE_MS,
    });
    expect(eager.cycles.length).toBeGreaterThan(
      run3.cycles.filter((cycle) => cycle.endMs <= 2 * 60 * MINUTE_MS).length,
    );
    expect(eager.cycles.every((cycle) => cycle.installed.length + cycle.neuroFluxLevels > 0)).toBe(true);
    expect(eager.cycles.some((cycle) => cycle.reason === "policy")).toBe(true);
  });
});
