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
  type ModelCycle,
  multipliersOf,
  programsPrice,
  REFERENCE_MONEY_LEFT_OUT_MINUTES,
  RUN_3_POLICY,
  runModel,
  SIMULATOR_CYCLES,
  sourceFile1Bonus,
  startHomeRamGb,
  TODAYS_POLICY,
  WORLD_DAEMON_HACKING,
} from "../src/index.ts";
import { RUN_3_BN1_2, SIMULATOR_SEED_1 } from "./fixtures.ts";

const MINUTE_MS = 60_000;
const curves = new Curves(CALIBRATION);
const reference = SIMULATOR_CYCLES[2]?.points ?? [];
/** Run #3's model, and each step's hacking level and money by its time. */
const steps = new Map<number, { hacking: number; money: number }>();
const run3 = runModel(RUN_3_BN1_2.start, {
  policy: RUN_3_POLICY,
  onStep: ({ atMs, hacking, money }) => steps.set(atMs, { hacking, money }),
});

/** What's installed after `cycles`: each set once, NeuroFlux Governor's levels summed. */
function installedAfter(cycles: readonly ModelCycle[]): Record<string, number> {
  const installed: Record<string, number> = {};
  for (const cycle of cycles) {
    for (const name of cycle.installed) installed[name] = 1;
    if (cycle.neuroFluxLevels > 0) {
      installed[NEUROFLUX_GOVERNOR] = (installed[NEUROFLUX_GOVERNOR] ?? 0) + cycle.neuroFluxLevels;
    }
  }
  return installed;
}

describe("the calibration", () => {
  test("the reference multipliers are what the model runs the simulator's third cycle at", () => {
    const sim = runModel(SIMULATOR_SEED_1.start, { horizonMs: SIMULATOR_SEED_1.horizonMinutes * MINUTE_MS });
    const third = multipliersOf(installedAfter(sim.cycles.slice(0, 2)), 0);
    for (const key of ["hacking", "hacking_exp", "hacking_speed", "hacking_money"] as const) {
      expect(CALIBRATION.reference[key]).toBeCloseTo(third[key], 3);
    }
  });

  test("the share bonus gives run #3's BitRunners rate, for the favour, within 10%", () => {
    // Each rate divided by (1 + favour/100) is the hacking level × faction_rep × the share bonus that set it.
    for (const { cycle, perSecond, favor } of RUN_3_BN1_2.bitRunnersRate) {
      const modelCycle = run3.cycles[cycle - 1];
      const modelFavor = favorBefore(cycle - 1, "BitRunners");
      const model = (modelCycle?.bestRatePerSecond.BitRunners ?? 0) / (1 + modelFavor / 100);
      expect(Math.abs(model / (perSecond / (1 + favor / 100)) - 1)).toBeLessThan(0.1);
    }
  });

  test("the reference curves give back the simulator's third cycle at its multipliers", () => {
    for (const [minutes, level, money] of reference) {
      expect(Math.abs(curves.hackingLevelAt(minutes, CALIBRATION.reference) - level)).toBeLessThanOrEqual(1);
      if (!REFERENCE_MONEY_LEFT_OUT_MINUTES.includes(minutes) && minutes >= 3) {
        expect(curves.moneyAt(minutes, CALIBRATION.reference) / money).toBeCloseTo(1, 9);
      }
    }
  });
});

/** A faction's favour at the start of the 0-based cycle `index` in run #3's model: the install before's, or 0. */
function favorBefore(index: number, faction: string): number {
  for (let each = index - 1; each >= 0; each--) {
    const favor = run3.cycles[each]?.favorAfter[faction];
    if (favor !== undefined) return favor;
  }
  return 0;
}

describe("the curves", () => {
  test("the game's skill formula: calculateSkill inverts hackingExpForLevel", () => {
    for (const level of [1, 50, 616, 3000]) {
      expect(hackingLevelOf(hackingExpForLevel(level, 1.3) + 1e-6, 1.3)).toBe(level);
    }
  });

  test("past the reference cycle's end, the experience and the money grow at its last rate", () => {
    const at = (minutes: number) => curves.moneyAt(minutes, { hacking_money: 1 });
    expect(at(98) - at(88)).toBeCloseTo(at(88) - at(78), 0);
    expect(at(88)).toBeGreaterThan(at(78));
  });

  test("home's pace: the first cycle's at 8 GB, the reference's from 1 TB, log-linear between", () => {
    expect(curves.homeSpeedOf(8)).toBe(CALIBRATION.firstCycleSpeed);
    expect(curves.homeSpeedOf(1024)).toBe(1);
    expect(curves.homeSpeedOf(2 ** 30)).toBe(1);
    expect(curves.homeSpeedOf(128)).toBeCloseTo(
      CALIBRATION.firstCycleSpeed + ((1 - CALIBRATION.firstCycleSpeed) * 4) / 7,
      12,
    );
  });

  test("the reference money never falls: the minutes it fell at (a purchase) are left out", () => {
    let before = 0;
    for (let minutes = 3; minutes <= 78; minutes += 0.5) {
      const money = curves.moneyAt(minutes, { hacking_money: 1 });
      expect(money).toBeGreaterThanOrEqual(before);
      before = money;
    }
  });

  test("at the reference multipliers the clocks run at the reference's pace; higher multipliers run them faster", () => {
    const one = curves.advanceClocks({ exp: 20, money: 20 }, 10 * MINUTE_MS, CALIBRATION.reference, 1024);
    expect(one.exp).toBeCloseTo(30, 6);
    expect(one.money).toBeCloseTo(30, 6);
    const faster = { ...CALIBRATION.reference, hacking: 3, hacking_speed: 2 };
    const two = curves.advanceClocks({ exp: 20, money: 20 }, 10 * MINUTE_MS, faster, 1024);
    expect(two.exp).toBeGreaterThan(two.money);
    expect(two.money).toBeGreaterThan(30);
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

  test("never installs nothing, and resets each cycle's reputation", () => {
    for (const cycle of run3.cycles) {
      expect(cycle.installed.length + cycle.neuroFluxLevels).toBeGreaterThan(0);
      expect(cycle.endMs).toBeGreaterThan(cycle.startMs);
    }
    // The 2nd cycle's reputation is its own: CyberSec's isn't the 1st cycle's plus more.
    expect(run3.cycles[1]?.reputation.CyberSec).toBeLessThan(
      (run3.cycles[0]?.reputation.CyberSec ?? 0) + (run3.cycles[1]?.reputation.CyberSec ?? 0),
    );
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
        expect(now?.hacking).toBeGreaterThanOrEqual(hacking);
        expect(now?.money).toBeGreaterThanOrEqual(programsPrice(ports));
        expect((before?.hacking ?? 0) < hacking || (before?.money ?? 0) < programsPrice(ports)).toBe(true);
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

  test("today's policy holds the install that would leave Daedalus's count one short (#243)", () => {
    const today = runModel(RUN_3_BN1_2.start, { policy: TODAYS_POLICY });
    const held = today.cycles.find((cycle) => cycle.heldMinutes > 0);
    expect(held?.countAfter).toBeGreaterThanOrEqual(30);
    expect(run3.cycles.every((cycle) => cycle.heldMinutes === 0)).toBe(true);
    // Run #3's 29 isn't an install today's brain makes.
    expect(today.cycles.some((cycle) => cycle.countAfter === 29)).toBe(false);
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
