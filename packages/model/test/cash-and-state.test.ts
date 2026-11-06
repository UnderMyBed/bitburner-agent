// #263: the money in hand (the brain's purchases through a cycle), A6's countdown and holds, the share from the state,
// the extrapolated cycles flagged, and the structural variants kept for the paired comparison.
import {
  countdownExtensionMs,
  homeRamUpgradePrice,
  INSTALL_COUNTDOWN_MS,
  PORT_OPENER_PROGRAMS,
  QUICK_INSTALL_COUNTDOWN_MS,
  SHARE_RAM_GB,
  shareBonusOfPower,
} from "@bitburner-agent/core";
import { describe, expect, test } from "vitest";
import {
  CALIBRATION,
  CLOUD_SERVER_LIMIT,
  CLOUD_SERVER_MAX_RAM,
  CLOUD_SERVER_PRICE_PER_GB,
  cloudRamOf,
  EXTRAPOLATION_BOUND_MIN,
  freshPurse,
  holdsOf,
  homeRamAfter,
  homeRamAtCommit,
  installClock,
  installDecision,
  MIN_CLOUD_SERVER_RAM,
  NO_HOLDS,
  PROGRAM_PRICES,
  portsOpen,
  RUN_3_CYCLES,
  RUN_3_POLICY,
  RUN_3_SHARE_BONUS,
  runModel,
  shareBonusOfState,
  spendThroughCycle,
} from "../src/index.ts";
import { RUN_3_BN1_2 } from "./fixtures.ts";

const MINUTE_MS = 60_000;
const ONLINE = 30 * MINUTE_MS;

describe("the money in hand: the brain's purchases through a cycle", () => {
  test("a program or home's RAM, the cheaper first, each once the money covers it; no cloud server before 10 min", () => {
    // $2m at 8 GB: the TOR router ($200k), BruteSSH ($500k), then home's RAM ($1,009,744, cheaper than FTPCrack).
    const purse = spendThroughCycle(freshPurse(8), 2e6, 1e6, 5 * MINUTE_MS);
    expect(purse).toMatchObject({ programs: 2, homeRamGb: 16, cloud: [] });
    expect(purse.spent).toBeCloseTo(200e3 + 500e3 + homeRamUpgradePrice(8), 0);
    expect(portsOpen(purse)).toBe(1);
    expect(portsOpen(freshPurse(8))).toBe(0);
    // The TOR router and each of core's port openers.
    expect(PROGRAM_PRICES).toHaveLength(1 + PORT_OPENER_PROGRAMS.length);
    // Home's RAM first while it's the cheaper: $251m would cover SQLInject ($250m), but home's upgrades come first.
    const sqlInject = spendThroughCycle({ ...freshPurse(8), programs: 5 }, 251e6, null, 5 * MINUTE_MS);
    expect(sqlInject.programs).toBe(5);
    expect(sqlInject.homeRamGb).toBeGreaterThan(8);
  });

  test("in the countdown no program, and home's RAM only with the money above what's held", () => {
    const held = { home: 1e6, cloud: 1e6, countdown: true };
    expect(spendThroughCycle(freshPurse(8), 2e6, null, ONLINE, held)).toMatchObject({ programs: 0, homeRamGb: 8 });
    expect(spendThroughCycle(freshPurse(8), 2.1e6, null, ONLINE, held)).toMatchObject({ programs: 0, homeRamGb: 16 });
  });

  test("a cloud server: the largest power of two the money covers, from 8 GB, 25 of them, then the smallest upgraded", () => {
    const programs = { ...freshPurse(2 ** 30), programs: PROGRAM_PRICES.length };
    // No income measured yet, or before the window: none.
    expect(spendThroughCycle(programs, 1e9, null, ONLINE).cloud).toEqual([]);
    expect(spendThroughCycle(programs, 1e9, 1e9, 9 * MINUTE_MS).cloud).toEqual([]);
    // $1m: 16 GB ($880k) but not 32; then nothing more fits.
    expect(spendThroughCycle(programs, 1e6, 1e9, ONLINE).cloud).toEqual([16]);
    expect(
      spendThroughCycle(programs, MIN_CLOUD_SERVER_RAM * CLOUD_SERVER_PRICE_PER_GB - 1, 1e9, ONLINE).cloud,
    ).toEqual([]);
    // All 25 at the most: $1.44t, and nothing more to buy.
    const full = spendThroughCycle(programs, 1e15, 1e15, ONLINE);
    expect(full.cloud).toEqual(Array(CLOUD_SERVER_LIMIT).fill(CLOUD_SERVER_MAX_RAM));
    expect(full.spent).toBe(CLOUD_SERVER_LIMIT * CLOUD_SERVER_MAX_RAM * CLOUD_SERVER_PRICE_PER_GB);
    // At the limit, the smallest is upgraded, paying the difference.
    const limit = { ...programs, cloud: [64, ...Array(CLOUD_SERVER_LIMIT - 1).fill(128)] };
    const upgraded = spendThroughCycle(limit, 64 * CLOUD_SERVER_PRICE_PER_GB, 1e9, ONLINE);
    expect(upgraded.cloud[0]).toBe(128);
    expect(upgraded.spent).toBe(64 * CLOUD_SERVER_PRICE_PER_GB);
  });

  test("cloud servers leave what's held, and the next program or home RAM the income brings within a minute", () => {
    const programs = { ...freshPurse(8), programs: PROGRAM_PRICES.length };
    const home = homeRamUpgradePrice(8);
    // Home's next short by $100k: within a minute at $2k/s, so held from cloud servers.
    expect(spendThroughCycle(programs, home - 100e3, 2e3, ONLINE).cloud).toEqual([]);
    // At $1k/s, 100 s off: not held; a server bought.
    expect(spendThroughCycle(programs, home - 100e3, 1e3, ONLINE).cloud).not.toEqual([]);
    // A cloud hold (the lookahead's) of all the money: none.
    const held = { ...NO_HOLDS, cloud: 1e9 };
    expect(spendThroughCycle({ ...programs, homeRamGb: 2 ** 30 }, 1e9, 1e9, ONLINE, held).cloud).toEqual([]);
  });

  test("a server must pay for itself within 15 min at the income a GB", () => {
    const owned = { ...freshPurse(2 ** 30), programs: PROGRAM_PRICES.length, cloud: [1024] };
    // $1,024/s over 1 TB is $1 a GB a second: a GB at $55,000 pays back in 55,000 s, far over 15 min.
    expect(spendThroughCycle(owned, 1e12, 1024, ONLINE).cloud).toEqual([1024]);
    // At $100k a GB a second it does.
    expect(spendThroughCycle(owned, 1e12, 1024 * 100e3, ONLINE).cloud.length).toBeGreaterThan(1);
  });

  test("the model's money is the gross less what's spent; an install loses programs and cloud servers, keeps home", () => {
    const steps: {
      onlineMs: number;
      gross: number;
      money: number;
      income: number | null;
      spent: number;
      home: number;
      cycle: number;
    }[] = [];
    let cycle = 0;
    let last = -1;
    const run = runModel(RUN_3_BN1_2.start, {
      policy: RUN_3_POLICY,
      onStep: ({ onlineMs, gross, money, income, purse }) => {
        if (onlineMs < last) cycle += 1;
        last = onlineMs;
        steps.push({ onlineMs, gross, money, income, spent: purse.spent, home: purse.homeRamGb, cycle });
        if (onlineMs === 0) expect(purse).toMatchObject({ spent: 0, programs: 0, cloud: [] });
      },
    });
    for (const step of steps) expect(step.money).toBeCloseTo(step.gross - step.spent, 0);
    expect(steps.some((step) => step.spent > 0 && step.money < step.gross)).toBe(true);
    // The income over the brain's 10-minute window: none till it's full, then the gross's rise over it (never below 0).
    for (const step of steps) {
      if (step.onlineMs < 10 * MINUTE_MS) expect(step.income).toBeNull();
      else {
        const at = step.onlineMs - 10 * MINUTE_MS;
        const before = at === 0 ? 0 : steps.find((each) => each.cycle === step.cycle && each.onlineMs === at)?.gross;
        const rise = Math.max(0, step.gross - (before ?? Number.NaN));
        expect(step.income).toBeCloseTo((rise / (10 * MINUTE_MS)) * 1000, 6);
      }
    }
    // The commit: the set and the levels from the money in hand, home's RAM with the rest; home's never shrinks.
    for (const [index, each] of run.cycles.entries()) {
      const lastStep = steps.filter((step) => step.cycle === index).at(-1);
      expect(each.commitMoney).toBeLessThanOrEqual(each.moneyAtEnd);
      expect(each.homeRamGb).toBe(homeRamAfter(lastStep?.home ?? 0, each.moneyAtEnd - each.commitMoney));
      expect(each.moneyAtEnd).toBeLessThanOrEqual(each.grossAtEnd);
    }
    // The levels' money is kept from home's RAM: $1.1m at 8 GB buys 16 GB ($1,009,744), not with $200k of levels.
    expect(homeRamAtCommit(8, 1.1e6, 0)).toBe(16);
    expect(homeRamAtCommit(8, 1.1e6, 200e3)).toBe(8);
  });
});

describe("A6's countdown, a step on (the brain's `#decide`)", () => {
  const rule = (count: number, names = ["x"], neuroFluxLevels = 0) => ({
    names,
    neuroFluxLevels,
    affordableWithNeuroFlux: count,
    barWithNeuroFlux: 12,
  });

  test("started at 90 s (30 s for a quick install), installed at its end; The Red Pill at once", () => {
    const started = installClock(null, "count reached", rule(12), 0);
    expect(started).toEqual({
      countdown: { endsAtMs: INSTALL_COUNTDOWN_MS, lengthMs: INSTALL_COUNTDOWN_MS, extensions: 0, count: 12 },
      install: false,
    });
    expect(installClock(started.countdown, "count reached", rule(12), INSTALL_COUNTDOWN_MS - 1).install).toBe(false);
    expect(installClock(started.countdown, "count reached", rule(12), INSTALL_COUNTDOWN_MS)).toEqual({
      countdown: null,
      install: true,
    });
    expect(installClock(null, "quick install", rule(4), 0).countdown?.endsAtMs).toBe(QUICK_INSTALL_COUNTDOWN_MS);
    expect(installClock(null, "The Red Pill", rule(0), 0)).toEqual({ countdown: null, install: true });
  });

  test("a rise in the count extends it, never shortened; the rule's stopping, or nothing to install, calls it off", () => {
    const started = installClock(null, "count reached", rule(12), 0).countdown;
    const once = installClock(started, "count reached", rule(13), 30_000).countdown;
    expect(once).toMatchObject({ extensions: 1, count: 13, endsAtMs: 30_000 + countdownExtensionMs(90_000, 1, 12) });
    // A second rise 2 s on would end sooner: kept.
    const twice = installClock(once, "count reached", rule(14), 32_000).countdown;
    expect(twice).toMatchObject({ extensions: 2, endsAtMs: once?.endsAtMs });
    // No rise: no extension.
    expect(installClock(twice, "count reached", rule(14), 40_000).countdown).toMatchObject({ extensions: 2 });
    expect(installClock(twice, null, rule(14), 40_000)).toEqual({ countdown: null, install: false });
    expect(installClock(twice, "count reached", rule(14, [], 0), 40_000)).toEqual({ countdown: null, install: false });
  });
});

describe("what the purchases leave alone (`holdsOf`)", () => {
  const decision = {
    endgameHold: null,
    money: 5e9,
    set: { purchases: [], money: 1e9, donationMoney: 0 } as never,
    lookahead: 7e9,
  };

  test("the lookahead from cloud servers alone; the countdown's money from everything; an endgame hold's", () => {
    expect(holdsOf(decision, false, null)).toEqual({ home: 0, cloud: 7e9, countdown: false });
    expect(holdsOf(decision, true, null)).toEqual({ home: 5e9, cloud: 5e9, countdown: true });
    expect(holdsOf({ ...decision, endgameHold: 100e9 }, true, null)).toEqual({
      home: 100e9,
      cloud: 100e9,
      countdown: false,
    });
  });

  test("held for Daedalus's count: the counted money, or the set's and the last's if more", () => {
    expect(holdsOf(decision, false, { next: { money: 1e9 } })).toMatchObject({ home: 5e9, countdown: true });
    expect(holdsOf(decision, false, { next: { money: 9e9 } })).toMatchObject({ home: 10e9, cloud: 10e9 });
  });

  test("A6's lookahead: the counted money if 15 more minutes of income would install, else none", () => {
    // CyberSec's five reached; $150m covers too few for "nothing left", $450m all five.
    const decide = (income: number | null) =>
      installDecision({
        installed: {},
        joined: [{ name: "CyberSec", reputation: 1e6, favor: 0 }],
        currentNode: 1,
        ownedSF: {},
        money: 150e6,
        hacking: 300,
        factionRep: 1,
        onlineMs: ONLINE,
        income,
      });
    expect(decide(null).lookahead).toBe(0);
    expect(decide(100).lookahead).toBe(0);
    // $400k/s: $360m more in 15 minutes.
    expect(decide(400e3).reason).toBeNull();
    expect(decide(400e3).lookahead).toBeGreaterThan(400e6);
  });
});

describe("the share from the state (#263), not the install index", () => {
  test("the game's bonus for the share of home's and the cloud servers' RAM in share threads", () => {
    const purse = { ...freshPurse(1024), cloud: [2048, 2048] };
    const threads = (CALIBRATION.shareRamShare * (1024 + 4096)) / SHARE_RAM_GB;
    expect(cloudRamOf(purse)).toBe(4096);
    expect(shareBonusOfState(purse, CALIBRATION)).toBe(shareBonusOfPower(1 + threads));
    expect(shareBonusOfState(freshPurse(1024), CALIBRATION)).toBeLessThan(shareBonusOfState(purse, CALIBRATION));
  });

  test("a cycle's share is its RAM's, so a policy that moves the installs gets its own; by index, run #3's", () => {
    const byState = runModel(RUN_3_BN1_2.start, { policy: RUN_3_POLICY, horizonMs: 5 * 60 * MINUTE_MS });
    const byIndex = runModel(RUN_3_BN1_2.start, {
      policy: RUN_3_POLICY,
      share: "index",
      horizonMs: 5 * 60 * MINUTE_MS,
    });
    for (const [index, each] of byIndex.cycles.entries()) {
      expect(each.shareBonus).toBeCloseTo(RUN_3_SHARE_BONUS[index] as number, 12);
    }
    // By state, it grows with the cycle's RAM: more in the 2nd cycle than the 1st.
    expect(byState.cycles[1]?.shareBonus).toBeGreaterThan(byState.cycles[0]?.shareBonus ?? 0);
    expect(byState.cycles[0]?.shareBonus).not.toBeCloseTo(RUN_3_SHARE_BONUS[0] as number, 2);
  });
});

describe("the structural variants (#263): gross money, share by index", () => {
  test("gross: the money is the cycle's hacking income, as #260 had it", () => {
    const gross = runModel(RUN_3_BN1_2.start, {
      policy: RUN_3_POLICY,
      money: "gross",
      horizonMs: 3 * 60 * MINUTE_MS,
    });
    for (const each of gross.cycles) expect(each.moneyAtEnd).toBe(each.grossAtEnd);
    const cash = runModel(RUN_3_BN1_2.start, { policy: RUN_3_POLICY, horizonMs: 3 * 60 * MINUTE_MS });
    expect(cash.cycles[0]?.moneyAtEnd).toBeLessThan(cash.cycles[0]?.grossAtEnd ?? 0);
  });
});

describe("extrapolated cycles flagged (#263)", () => {
  test("minutes past the curve's last reading (120 min), by the clock furthest on; none within it", () => {
    const furthest: number[] = [];
    let cycle = 0;
    let last = -1;
    const run = runModel(RUN_3_BN1_2.start, {
      policy: RUN_3_POLICY,
      onStep: ({ onlineMs, clocks }) => {
        if (onlineMs < last) cycle += 1;
        last = onlineMs;
        furthest[cycle] = Math.max(furthest[cycle] ?? 0, clocks.exp, clocks.money);
      },
    });
    for (const [index, each] of run.cycles.entries()) {
      expect(each.extrapolatedMinutes, `cycle ${index + 1}`).toBeCloseTo(Math.max(0, (furthest[index] ?? 0) - 120), 9);
    }
    expect(run.cycles[0]?.extrapolatedMinutes).toBe(0);
    expect(run.cycles.some((each) => each.extrapolatedMinutes > 0)).toBe(true);
    // Bounded: a cycle more than EXTRAPOLATION_BOUND_MIN past is out of range, and the run says which.
    const beyond = run.cycles.flatMap((each, index) =>
      each.extrapolatedMinutes > EXTRAPOLATION_BOUND_MIN ? [index + 1] : [],
    );
    expect(run.outOfRange.slice(0, beyond.length)).toEqual(beyond);
  });

  test("a measured cycle run past its own end is flagged by the minutes past it", () => {
    // Run #3's 1st cycle ended at 39.5 min; a policy that installs only from 50 min runs the model on past it.
    const late = runModel(RUN_3_BN1_2.start, {
      policy: { name: "late", daedalusCountHold: false, install: (view) => view.onlineMs >= 50 * MINUTE_MS },
      measured: RUN_3_CYCLES,
      horizonMs: 60 * MINUTE_MS,
    });
    const end = (late.cycles[0]?.endMs ?? 0) / MINUTE_MS;
    expect(end).toBeGreaterThanOrEqual(50);
    expect(late.cycles[0]?.extrapolatedMinutes).toBeCloseTo(end - 39.5, 9);
  });
});
