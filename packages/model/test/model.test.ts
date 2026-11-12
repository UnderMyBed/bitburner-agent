// The cycle model's parts (#260): the calibration's consistency, the curves, the policies, and what it keeps of the
// game's rules.
import { readFileSync } from "node:fs";
import {
  AUGMENTATIONS,
  augmentationBitNodeMultipliers,
  chooseAugmentationsToBuy,
  factionReputationPerSecond,
  favorAfterInstall,
  HACKING_MULTIPLIERS,
  hackingExpForLevel,
  installGains,
  NEUROFLUX_GOVERNOR,
  worldDaemonRequiredLevel,
} from "@bitburner-agent/core";
import { describe, expect, test } from "vitest";
import {
  CALIBRATION,
  Curves,
  calibrationSteps,
  countHoldOf,
  factionPassiveRepGainOf,
  HACKER_FACTION_JOINS,
  hackingLevelOf,
  homeRamAfter,
  installDecision,
  JoinPipeline,
  measuredAt,
  multipliersOf,
  portsOpen,
  RUN_3_CYCLES,
  RUN_3_POLICY,
  RUN_3_SHARE_BONUS,
  runModel,
  SPECIAL_FACTIONS,
  shareBonusOf,
  sourceFile1Bonus,
  startHomeRamGb,
  TODAYS_POLICY,
} from "../src/index.ts";
import { fitError } from "./fit.ts";
import { BN1_3, BN1_3_CYCLES, RUN_3_BN1_2 } from "./fixtures.ts";

const MINUTE_MS = 60_000;
const curves = new Curves(CALIBRATION);
/** Run #3's model, and each step's hacking level and money by its time. */
const steps = new Map<number, { hacking: number; money: number; ports: number }>();
const run3 = runModel(RUN_3_BN1_2.start, {
  policy: RUN_3_POLICY,
  onStep: ({ atMs, hacking, money, purse }) => steps.set(atMs, { hacking, money, ports: portsOpen(purse) }),
});

/** Run #3's fitted run's gross `minutes` into each cycle (1-based), at `calibration` and `cloudDelayMs`. */
function grossAt(calibration: Partial<typeof CALIBRATION>, minutes: number, cloudDelayMs = 0): Map<number, number> {
  const seen = new Map<number, number>();
  let cycle = 0;
  let last = Number.POSITIVE_INFINITY;
  runModel(RUN_3_BN1_2.start, {
    policy: RUN_3_POLICY,
    calibration,
    cloudDelayMs,
    onStep: ({ onlineMs, gross }) => {
      if (onlineMs < last) cycle += 1;
      last = onlineMs;
      if (onlineMs === minutes * MINUTE_MS) seen.set(cycle, gross);
    },
  });
  return seen;
}

describe("the calibration", () => {
  test("the reference cycles' multipliers are what the brain's rules install on run #3's own measured curves", () => {
    // The downstream run (#294): the fitted run's own has no fixed point since #294's joins and purchases.
    const downstream = runModel(RUN_3_BN1_2.start, { policy: RUN_3_POLICY, measured: RUN_3_CYCLES });
    for (const { cycle, multipliers } of CALIBRATION.referenceCycles) {
      const model = downstream.cycles[cycle - 1]?.multipliers;
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

  test("the curve's constants are the fit's: a strict local best on run #3 alone, at the refit's own steps", () => {
    // test/fit.ts's `fitError`, the objective the refit minimised (test/refit.ts, the trace in the README): run #3's
    // cycles 1 to 6, level and money, and its 7th to 10th's money at 5 to 20 min, where the cap applies. #294's refit:
    // 0.3199 from #263's constants (0.3443 under #294's joins and purchases), every step around it worse. A shallow
    // minimum: `firstCycleSpeed` and `fullSpeedHomeRamGb` move it by about a thousandth a step (+0.0011 to +0.0013);
    // the paces and the cap by 0.009 to 0.037. #263's fit was 0.2969; #294's first refit, before the joins' pipeline,
    // 0.2658. Of it, cycles 1 to 6 alone are 0.2363 (#263's 0.2003).
    const fitted = fitError({});
    expect(fitted.combined).toBeCloseTo(0.3199, 4);
    expect(fitted.early).toBeCloseTo(0.2363, 4);
    expect(fitted.lateReadings).toBe(15);
    const steps = calibrationSteps(CALIBRATION).map(({ name, calibration }) => ({
      name,
      by: fitError(calibration).combined - fitted.combined,
    }));
    for (const { name, by } of steps) expect(by, name).toBeGreaterThan(0.0009);
    const flattest = steps.filter(({ by }) => by < 0.002).map(({ name }) => name.split(" ")[0]);
    expect([...new Set(flattest)].sort()).toEqual(["firstCycleSpeed", "fullSpeedHomeRamGb"]);
  });

  test("the descent's other start, #294's first refit's constants, stops at a worse local best with a flat direction", () => {
    // From (0.5, 0.375, 2.75, 0.75, 1 TB): 0.3456, at expPaceExponent 0.625 and home 512 GB. There the cap at 2.75 and
    // at 3 give the same error, as the cap doesn't bind: a flat direction, so the cap isn't identified there.
    const other = { expPaceExponent: 0.625, moneyPaceExponent: 0.375, moneyPaceMost: 2.75, firstCycleSpeed: 0.75 };
    const end = fitError(other);
    expect(end.combined).toBeCloseTo(0.3456, 4);
    expect(end.combined).toBeGreaterThan(fitError({}).combined);
    const flat: string[] = [];
    for (const { name, calibration } of calibrationSteps({ ...CALIBRATION, ...other })) {
      const stepped = fitError({ ...other, ...calibration }).combined;
      expect(stepped, name).toBeGreaterThanOrEqual(end.combined);
      if (stepped === end.combined) flat.push(name);
    }
    expect(flat).toEqual(["moneyPaceMost 3"]);
  });

  test("fitted: the cap brings run #3's 7th and 8th cycles' 10 min within ×3 (×2.1, ×1.5), from ×43 and ×120 uncapped", () => {
    // Before the cycle's first cloud server, the world servers' few TB: the cap holds the money's clock there. Fitted
    // on these, so consistency only. By cycle, as `fitError` keys them.
    const capped = grossAt({}, 10);
    const uncapped = grossAt({ moneyPaceMost: Number.POSITIVE_INFINITY }, 10);
    for (const cycle of [7, 8]) {
      const actual = RUN_3_CYCLES[cycle - 1]?.points.find(([minutes]) => minutes === 10)?.[2] ?? Number.NaN;
      const ratio = (capped.get(cycle) ?? 0) / actual;
      expect(ratio, `cycle ${cycle}`).toBeGreaterThan(1 / 3);
      expect(ratio, `cycle ${cycle}`).toBeLessThan(3);
      expect((uncapped.get(cycle) ?? 0) / actual, `cycle ${cycle}, uncapped`).toBeGreaterThan(30);
    }
  });

  test("known miss: by 15 min into run #3's 7th and 8th cycles the money is ×300 and ×350; ×150 and ×130 with the first cloud server 5 min later", () => {
    // #294: the model buys its first cloud server when the brain would (10 min 20 s at the soonest, `money.ts`), and
    // from there the level paces the money. Run #3's money rose about $1b a minute from 10 to 20 min, its servers
    // bought by 15. Its snapshots can't say when between 10 min 20 s and 15 min the first came, but even 5 min later
    // than modelled (the grid's variant) the model is ×130 and more over at 15 min and ×2,300 and more at 20: the
    // purchase's time explains about a factor of 2 of it, the batches' ramp on the new RAM, not modelled, the rest.
    for (const [cloudDelayMs, low, high] of [
      [0, 250, 400],
      [5 * MINUTE_MS, 100, 200],
    ] as const) {
      const seen = grossAt({}, 15, cloudDelayMs);
      for (const cycle of [7, 8]) {
        const actual = RUN_3_CYCLES[cycle - 1]?.points.find(([minutes]) => minutes === 15)?.[2] ?? Number.NaN;
        const ratio = (seen.get(cycle) ?? 0) / actual;
        expect(ratio, `cycle ${cycle}, ${cloudDelayMs / MINUTE_MS} min later`).toBeGreaterThan(low);
        expect(ratio, `cycle ${cycle}, ${cloudDelayMs / MINUTE_MS} min later`).toBeLessThan(high);
      }
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
    // The refit's two exponents are both 0.5 (#294), so the clocks run alike.
    expect(two.exp).toBeCloseTo(two.money, 9);
    expect(two.money).toBeGreaterThan(30);
    const moneySlower = curves.advanceClocks({ exp: 20, money: 20 }, 10 * MINUTE_MS, faster, 2 ** 20, false);
    const slower = new Curves({ ...CALIBRATION, moneyPaceExponent: 0.25 });
    expect(slower.advanceClocks({ exp: 20, money: 20 }, 10 * MINUTE_MS, faster, 2 ** 20).money).toBeLessThan(
      moneySlower.money,
    );
  });

  test("before the cycle's first cloud server the money's clock runs at most `moneyPaceMost` faster; after, uncapped", () => {
    const faster = { ...curves.reference, hacking: 60, hacking_speed: 40 };
    const before = curves.advanceClocks({ exp: 20, money: 20 }, 10 * MINUTE_MS, faster, 2 ** 20, true);
    const after = curves.advanceClocks({ exp: 20, money: 20 }, 10 * MINUTE_MS, faster, 2 ** 20, false);
    expect(before.money).toBeCloseTo(20 + 10 * CALIBRATION.moneyPaceMost, 6);
    expect(after.money).toBeGreaterThan(before.money);
    // The experience's clock is never capped.
    expect(before.exp).toBe(after.exp);
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
    // At each cycle's first step with a faction joined, before any work, every joined faction's reputation is 0: an
    // install drops every faction (`Faction/Faction.ts:77-85`), and a join starts from none.
    const firstJoined = new Map<number, { name: string; reputation: number }[]>();
    runModel(RUN_3_BN1_2.start, {
      policy: RUN_3_POLICY,
      onWork: ({ atMs, joined }) => {
        const cycle = run3.cycles.filter((each) => each.endMs < atMs).length;
        if (joined.length > 0 && !firstJoined.has(cycle)) firstJoined.set(cycle, [...joined]);
      },
    });
    // Every cycle joins a faction; the last, after The Red Pill, may end in the destroy before its first join shows.
    expect(firstJoined.size).toBeGreaterThanOrEqual(run3.cycles.length);
    for (const joined of firstJoined.values()) for (const { reputation } of joined) expect(reputation).toBe(0);
  });

  test("the BitNode's passive reputation: 0 in BN2, BN12's dec, else 1; none for the special factions", () => {
    expect(factionPassiveRepGainOf(1, 1)).toBe(1);
    expect(factionPassiveRepGainOf(2, 0.5)).toBe(0);
    expect(factionPassiveRepGainOf(12, 1 / 1.02)).toBe(1 / 1.02);
    expect(SPECIAL_FACTIONS).toEqual(["Bladeburners", "Church of the Machine God", "Shadows of Anarchy"]);
  });

  test("a favour grind naming a faction not joined leaves A5's choice", () => {
    const named = runModel(RUN_3_BN1_2.start, {
      policy: { ...RUN_3_POLICY, name: "a faction never joined", favourGrind: () => "Illuminati" },
    });
    expect(named.cycles).toEqual(run3.cycles);
  });

  test("passive reputation at the joined factions not worked for (`processPassiveFactionRepGain`)", () => {
    // The factions joined in the 1st cycle and never worked for: their reputation is passive, and more than none.
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

  test("joins a faction the brain's time after its terms (./joins.ts), one join a slow snapshot, at the nearest step", () => {
    // The first join of the BitNode: its terms met within the step that first shows them (half a step back on
    // average), a fresh pipeline's time from there, joined at the step nearest it.
    const first = run3.events.find((event) => event.kind === "joined");
    expect(first).toMatchObject({ kind: "joined", faction: "CyberSec" });
    let termsAt = MINUTE_MS;
    while (!((steps.get(termsAt)?.hacking ?? 0) >= 60 && (steps.get(termsAt)?.ports ?? 0) >= 1)) termsAt += MINUTE_MS;
    const speed = run3.cycles[0]?.multipliers.hacking_speed ?? 1;
    const shownAt = new JoinPipeline().hackerFaction(
      termsAt - MINUTE_MS / 2,
      60,
      steps.get(termsAt)?.hacking ?? 0,
      speed,
    );
    expect(first?.atMs).toBe(Math.ceil((shownAt - MINUTE_MS / 2) / MINUTE_MS) * MINUTE_MS);
    for (const { faction, hacking, ports } of HACKER_FACTION_JOINS) {
      for (const { atMs } of run3.events.filter((event) => event.kind === "joined" && event.faction === faction)) {
        const cycle = run3.cycles.find((each) => atMs > each.startMs && atMs <= each.endMs);
        if (cycle === undefined) continue;
        // Never before a step after the first with its terms met: the brain takes 100 s at the least.
        let met = cycle.startMs + MINUTE_MS;
        while (!((steps.get(met)?.hacking ?? 0) >= hacking && (steps.get(met)?.ports ?? 0) >= ports)) met += MINUTE_MS;
        expect(atMs, `${faction} at ${(atMs - cycle.startMs) / MINUTE_MS} min`).toBeGreaterThan(met);
      }
    }
    // One join a slow snapshot: never two factions joined at one step.
    const joinedAt = run3.events.filter((event) => event.kind === "joined").map((event) => event.atMs);
    expect(new Set(joinedAt).size).toBe(joinedAt.length);
    // With the joins at once (slice 2's, the comparison's variant), at the very step the terms are met.
    const instant = runModel(RUN_3_BN1_2.start, {
      policy: RUN_3_POLICY,
      joinDelay: "instant",
      horizonMs: 3 * 60 * MINUTE_MS,
    });
    const later = runModel(RUN_3_BN1_2.start, {
      policy: RUN_3_POLICY,
      joinDelay: 5 * MINUTE_MS,
      horizonMs: 3 * 60 * MINUTE_MS,
    });
    const firstJoin = (run: typeof run3, faction: string) =>
      run.events.find((event) => event.kind === "joined" && event.faction === faction)?.atMs ?? Number.NaN;
    const modelled = firstJoin(run3, "CyberSec");
    expect(firstJoin(instant, "CyberSec")).toBeLessThan(modelled);
    expect(firstJoin(later, "CyberSec")).toBe(modelled + 5 * MINUTE_MS);
  });

  test("a fresh join pipeline each cycle, even when the install fires as joins' terms are met (#294's re-review)", () => {
    // An eager policy installs as soon as anything can be, on BN1.3's own curves: its installs come minutes into
    // cycles where the level is high, as joins' terms are met, so a queue kept across an install would push the next
    // cycle's first joins later. Each cycle's CyberSec join is a fresh pipeline's, Tian Di Hui's ahead of it if its
    // terms came first, at the step nearest it.
    const eager = { ...TODAYS_POLICY, name: "eager", install: () => true };
    const seen: { cycle: number; onlineMs: number; hacking: number; ports: number; money: number }[] = [];
    let cycle = 0;
    let last = -1;
    const run = runModel(BN1_3.start, {
      policy: eager,
      measured: BN1_3_CYCLES,
      horizonMs: 6 * 60 * MINUTE_MS,
      onStep: ({ onlineMs, hacking, purse, money }) => {
        if (onlineMs < last) cycle += 1;
        last = onlineMs;
        seen.push({ cycle, onlineMs, hacking, ports: portsOpen(purse), money });
      },
    });
    expect(run.cycles.length).toBeGreaterThan(5);
    let checked = 0;
    for (const [index, each] of run.cycles.entries()) {
      if (index === 0) continue;
      const steps = seen.filter((step) => step.cycle === index && step.onlineMs > 0);
      const cyberSec = steps.find((step) => step.hacking >= 60 && step.ports >= 1);
      const tianDiHui = steps.find((step) => step.hacking >= 50 && step.money >= 1_200_000);
      const join = run.events.find(
        (event) =>
          event.kind === "joined" &&
          event.faction === "CyberSec" &&
          event.atMs > (run.cycles[index - 1]?.endMs ?? 0) &&
          event.atMs <= each.endMs,
      );
      if (cyberSec === undefined || join === undefined) continue;
      const start = run.cycles[index - 1]?.endMs ?? 0;
      const pipeline = new JoinPipeline();
      if (tianDiHui !== undefined && tianDiHui.onlineMs < cyberSec.onlineMs) {
        pipeline.tianDiHui(start + tianDiHui.onlineMs - MINUTE_MS / 2);
      }
      const termsAt = start + cyberSec.onlineMs - MINUTE_MS / 2;
      const shownAt = pipeline.hackerFaction(termsAt, 60, cyberSec.hacking, each.multipliers.hacking_speed);
      expect(join.atMs, `cycle ${index + 1}`).toBe(Math.ceil((shownAt - MINUTE_MS / 2) / MINUTE_MS) * MINUTE_MS);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(4);
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
    expect(steps.get(destroyed)?.hacking).toBeGreaterThanOrEqual(worldDaemonRequiredLevel(1, {}));
    expect(steps.get(destroyed - MINUTE_MS)?.hacking).toBeLessThan(worldDaemonRequiredLevel(1, {}));
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
    // 2.5m reputation at $1m a reputation over faction_rep 4: $625b, and a hair. Held: nothing installs, its money
    // held.
    expect(decide(624e9)).toMatchObject({ reason: null, names: [], neuroFluxLevels: 0 });
    expect(decide(624e9).endgameHold).toBeGreaterThan(0);
    expect(decide(626e9).endgameHold).toBeNull();
    expect(decide(626e9)?.reason).toBe("The Red Pill");
    expect(decide(626e9)?.names).toContain("The Red Pill");
  });

  test("#243's hold: one short of the count, the last by work at its seller within the window, at the share bonus rate (#345)", () => {
    // 28 installed (all The Black Hand sells but its own), BitWire to install: 29 of 30, one short.
    const theBlackHands = [
      "Artificial Synaptic Potentiation",
      "Enhanced Myelin Sheathing",
      "DataJack",
      "Embedded Netburner Module",
      "Embedded Netburner Module Core Implant",
      "Neuralstimulator",
      "Cranial Signal Processors - Gen I",
      "Cranial Signal Processors - Gen II",
      "Cranial Signal Processors - Gen III",
      "Cranial Signal Processors - Gen IV",
      "Magnetism Amplifier",
    ];
    const others = Object.keys(AUGMENTATIONS).filter(
      (name) =>
        !theBlackHands.includes(name) &&
        ![NEUROFLUX_GOVERNOR, "The Red Pill", "The Black Hand", "BitWire"].includes(name),
    );
    const installed = Object.fromEntries(
      [...theBlackHands, ...others.slice(0, 28 - theBlackHands.length)].map((name) => [name, 1]),
    );
    const joined = [{ name: "The Black Hand", reputation: 90_000, favor: 0 }];
    const person = {
      skills: { hacking: 3000, strength: 1, defense: 1, dexterity: 1, agility: 1, charisma: 1, intelligence: 0 },
      mults: { faction_rep: 2 },
    };
    const conditions = {
      sourceFile15Level: 0,
      focused: true,
      implant: false,
      factionWorkRepGain: 1,
      favorToDonateToFaction: 1,
      donations: true,
      shareBonus: 1.45,
    };
    const state = {
      installed,
      queued: [],
      sourceFile11Level: 0,
      bitNodeMultipliers: augmentationBitNodeMultipliers(1, {}),
    };
    const decision = {
      names: ["BitWire"],
      neuroFluxLevels: 0,
      set: chooseAugmentationsToBuy([], state, 0, 3000),
      terms: undefined,
    };
    const hold = (onlineMs: number, heldSinceOnlineMs: number | null) =>
      countHoldOf({
        installed,
        joined,
        currentNode: 1,
        ownedSF: {},
        decision,
        money: 1e15,
        income: null,
        person,
        conditions,
        onlineMs,
        heldSinceOnlineMs,
      });
    const held = hold(0, null);
    expect(held?.next).toMatchObject({ augmentation: "The Black Hand", faction: "The Black Hand", way: "work" });
    // 10,000 reputation at the work's rate with the share's bonus (#345: ×1.45, so 1.45 times as soon as without).
    const rate = factionReputationPerSecond(person, "hacking", { ...conditions, favor: 0 });
    expect(rate).toBeCloseTo(
      factionReputationPerSecond(person, "hacking", { ...conditions, favor: 0, shareBonus: 1 }) * 1.45,
      9,
    );
    expect(held?.next.etaMs).toBeCloseTo((10_000 / rate) * 1000, 3);
    // The window: 20 minutes from the first hold, never restarted.
    expect(hold(19 * 60_000, 0)).toBeNull();
  });
  test("#243's hold is run #3's brain's on this path: no install in it would leave Daedalus's count one short", () => {
    // The model's 7th install takes the count from 25 to 34, past 29, so #243's hold never arises on run #3's path
    // (run #3's own 7th took it to 29). The hold's wiring is checked by the probes, not by a run in reach. Today's
    // brain differs from run #3's by #242's share too, which moves the path: it's left out here.
    const today = runModel(RUN_3_BN1_2.start, { policy: { ...TODAYS_POLICY, homeShares: false } });
    expect(today.cycles.every((cycle) => cycle.heldMinutes === 0)).toBe(true);
    expect(today.cycles).toEqual(run3.cycles);
  });

  test("#242's share moves run #3's path: today's brain shares home's RAM, run #3's didn't", () => {
    const today = runModel(RUN_3_BN1_2.start, { policy: TODAYS_POLICY });
    expect(today.cycles[2]?.shareBonus).toBeGreaterThan((run3.cycles[2]?.shareBonus ?? 0) + 0.02);
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
