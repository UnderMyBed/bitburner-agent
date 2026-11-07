// #263: the money in hand (the brain's purchases through a cycle), A6's countdown and holds, the share from the state,
// the extrapolated cycles flagged, and the structural variants kept for the paired comparison.
import { readFileSync } from "node:fs";
import {
  CLOUD_SERVER_MAX_RAM,
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
  CLOUD_SERVER_PAYBACK_LIMIT_MS,
  CLOUD_SERVER_PRICE_PER_GB,
  cloudRamOf,
  EXTRAPOLATION_BOUND_MIN,
  freshPurse,
  type Holds,
  holdsOf,
  homeRamAtCommit,
  installClock,
  installDecision,
  MIN_CLOUD_SERVER_RAM,
  NO_HOLDS,
  nextPurchase,
  PROGRAM_PRICES,
  type Purse,
  portsOpen,
  ROOTED_WORLD_RAM_GB_BY_PORTS,
  RUN_3_CYCLES,
  RUN_3_POLICY,
  RUN_3_SHARE_BONUS,
  runModel,
  shareBonusOfState,
  shareRamGbOfState,
  spendThroughCycle,
  TODAYS_POLICY,
} from "../src/index.ts";
import { RUN_3_BN1_2 } from "./fixtures.ts";

const MINUTE_MS = 60_000;
const ONLINE = 30 * MINUTE_MS;
/** n00dles and its like, rooted with no port: the hack loop's hosts before any cloud server. */
const WORLD_RAM_GB = 100;
const spend = (purse: Purse, gross: number, income: number | null, onlineMs: number, holds: Holds = NO_HOLDS) =>
  spendThroughCycle(purse, gross, income, onlineMs, holds, WORLD_RAM_GB);
/** Every program bought, home at the game's limit: only cloud servers left to buy. */
const ONLY_CLOUD: Purse = { ...freshPurse(2 ** 30), programs: PROGRAM_PRICES.length };
/** A decision with nothing to hold but what a test sets. */
const dummyDecision = {
  endgameHold: null,
  endgameHoldFor: null,
  money: 0,
  set: { purchases: [], money: 0, donationMoney: 0 } as never,
  lookahead: 0,
};

describe("the money in hand: the brain's purchases through a cycle", () => {
  test("a program or home's RAM, the cheaper first, each once the money covers it; no cloud server before 10 min", () => {
    // $2m at 8 GB: the TOR router ($200k), BruteSSH ($500k), then home's RAM ($1,009,744, cheaper than FTPCrack).
    const purse = spend(freshPurse(8), 2e6, 1e6, 5 * MINUTE_MS);
    expect(purse).toMatchObject({ programs: 2, homeRamGb: 16, cloudServersRamGb: [] });
    expect(purse.spent).toBeCloseTo(200e3 + 500e3 + homeRamUpgradePrice(8), 0);
    expect(portsOpen(purse)).toBe(1);
    expect(portsOpen(freshPurse(8))).toBe(0);
    // The TOR router and each of core's port openers.
    expect(PROGRAM_PRICES).toHaveLength(1 + PORT_OPENER_PROGRAMS.length);
    // Home's RAM first while it's the cheaper: $251m would cover SQLInject ($250m), but home's upgrades come first.
    const sqlInject = spend({ ...freshPurse(8), programs: 5 }, 251e6, null, 5 * MINUTE_MS);
    expect(sqlInject.programs).toBe(5);
    expect(sqlInject.homeRamGb).toBeGreaterThan(8);
    // The program first where it's the cheaper: BruteSSH ($500k) before home's 16 GB ($1,009,744).
    const bruteSsh = { ...freshPurse(8), programs: 1 };
    expect(nextPurchase(bruteSsh, 1e9, null, ONLINE, { ...NO_HOLDS }, WORLD_RAM_GB)).toEqual({
      kind: "program",
      price: 500e3,
    });
  });

  test("in the countdown no program, and home's RAM only with the money above what's held", () => {
    const held: Holds = { fromHomeRam: 1e6, fromPrograms: 0, fromCloudServers: 1e6, countdownUnderWay: true };
    expect(spend(freshPurse(8), 2e6, null, ONLINE, held)).toMatchObject({ programs: 0, homeRamGb: 8 });
    expect(spend(freshPurse(8), 2.1e6, null, ONLINE, held)).toMatchObject({ programs: 0, homeRamGb: 16 });
  });

  test("Daedalus's $100b holds home's RAM, not programs; The Red Pill's donation holds both (the brain's)", () => {
    const daedalus = holdsOf({ ...dummyDecision, endgameHold: 100e9, endgameHoldFor: "daedalus" }, false, null);
    expect(daedalus).toEqual({
      fromHomeRam: 100e9,
      fromPrograms: 0,
      fromCloudServers: 100e9,
      countdownUnderWay: false,
    });
    const redPill = holdsOf({ ...dummyDecision, endgameHold: 2.5e12, endgameHoldFor: "redPill" }, false, null);
    expect(redPill).toEqual({
      fromHomeRam: 2.5e12,
      fromPrograms: 2.5e12,
      fromCloudServers: 2.5e12,
      countdownUnderWay: false,
    });
    // $1m in hand, BruteSSH ($500k) next and home's 16 GB: under Daedalus's hold the program goes, home's RAM doesn't.
    const purse = { ...freshPurse(8), programs: 1 };
    expect(nextPurchase(purse, 1e6, null, ONLINE, daedalus, WORLD_RAM_GB)).toMatchObject({ kind: "program" });
    expect(nextPurchase(purse, 1e6, null, ONLINE, redPill, WORLD_RAM_GB)).toBeNull();
    expect(nextPurchase({ ...purse, programs: 6 }, 2e6, null, ONLINE, daedalus, WORLD_RAM_GB)).toBeNull();
  });

  test("a cloud server: the largest power of two the money covers, from 8 GB, 25 of them, then the smallest upgraded", () => {
    // No income measured yet, or before the window: none.
    expect(spend(ONLY_CLOUD, 1e9, null, ONLINE).cloudServersRamGb).toEqual([]);
    expect(spend(ONLY_CLOUD, 1e9, 1e9, 9 * MINUTE_MS).cloudServersRamGb).toEqual([]);
    // $1m: 16 GB ($880k) but not 32; then nothing more fits.
    expect(spend(ONLY_CLOUD, 1e6, 1e9, ONLINE).cloudServersRamGb).toEqual([16]);
    // $500k: 8 GB ($440k), the least a new server is bought with.
    expect(spend(ONLY_CLOUD, 500e3, 1e9, ONLINE).cloudServersRamGb).toEqual([8]);
    expect(
      spend(ONLY_CLOUD, MIN_CLOUD_SERVER_RAM * CLOUD_SERVER_PRICE_PER_GB - 1, 1e9, ONLINE).cloudServersRamGb,
    ).toEqual([]);
    // All 25 at the most (core's `CLOUD_SERVER_MAX_RAM`): $1.44t, and nothing more to buy.
    const full = spend(ONLY_CLOUD, 1e15, 1e15, ONLINE);
    expect(full.cloudServersRamGb).toEqual(Array(CLOUD_SERVER_LIMIT).fill(CLOUD_SERVER_MAX_RAM));
    expect(full.spent).toBe(CLOUD_SERVER_LIMIT * CLOUD_SERVER_MAX_RAM * CLOUD_SERVER_PRICE_PER_GB);
    // At the limit, the smallest is upgraded, paying the difference.
    const limit = { ...ONLY_CLOUD, cloudServersRamGb: [64, ...Array(CLOUD_SERVER_LIMIT - 1).fill(128)] };
    const upgraded = spend(limit, 64 * CLOUD_SERVER_PRICE_PER_GB, 1e9, ONLINE);
    expect(upgraded.cloudServersRamGb[0]).toBe(128);
    expect(upgraded.spent).toBe(64 * CLOUD_SERVER_PRICE_PER_GB);
  });

  test("cloud servers leave what's held, and the next program or home RAM the income brings within a minute", () => {
    const programs = { ...freshPurse(8), programs: PROGRAM_PRICES.length };
    const home = homeRamUpgradePrice(8);
    // Home's next short by $100k: within a minute at $2k/s, so held from cloud servers.
    expect(spend(programs, home - 100e3, 2e3, ONLINE).cloudServersRamGb).toEqual([]);
    // At $1k/s, 100 s off: not held; a server bought (on 10 GB of world servers, $100 a GB a second: paid back).
    expect(spendThroughCycle(programs, home - 100e3, 1e3, ONLINE, NO_HOLDS, 10).cloudServersRamGb).not.toEqual([]);
    // A cloud hold (the lookahead's) of all the money: none.
    expect(spend(ONLY_CLOUD, 1e9, 1e9, ONLINE, { ...NO_HOLDS, fromCloudServers: 1e9 }).cloudServersRamGb).toEqual([]);
    // In the countdown the next program is still held from cloud servers (the brain's plan has its price).
    const countdown: Holds = { fromHomeRam: 0, fromPrograms: 0, fromCloudServers: 0, countdownUnderWay: true };
    const sqlInjectNext = { ...freshPurse(2 ** 30), programs: 5 };
    expect(spend(sqlInjectNext, 249.99e6, 1e6, ONLINE, countdown).cloudServersRamGb).toEqual([]);
  });

  test("a server must pay for itself within 15 min at the income a GB of the hack loop's hosts, world and cloud", () => {
    // From an empty cloud: at $2,500/s over 300 GB of world servers, $8.33 a GB a second, a GB pays back in 6,600 s:
    // none (the brain's at cycle 1's 10 min, the #263 review). At $10k/s, 1,650 s: none. At $100k/s, 165 s: bought.
    const start = { ...freshPurse(2 ** 30), programs: 2 };
    const worldOf = (gross: number, income: number) =>
      spendThroughCycle(start, gross, income, ONLINE, NO_HOLDS, 300).cloudServersRamGb;
    expect(worldOf(1e9, 2_500)).toEqual([]);
    expect(worldOf(1e9, 10e3)).toEqual([]);
    expect(worldOf(1e9, 100e3).length).toBeGreaterThan(0);
    const owned = { ...ONLY_CLOUD, cloudServersRamGb: [1024] };
    // $1,124/s over 1 TB of cloud and 100 GB of world: $1 a GB a second, far over 15 min.
    expect(spend(owned, 1e12, 1124, ONLINE).cloudServersRamGb).toEqual([1024]);
    // At $100k a GB a second it does.
    expect(spend(owned, 1e12, 1124 * 100e3, ONLINE).cloudServersRamGb.length).toBeGreaterThan(1);
  });

  test("in a run, each cycle's first cloud server comes once it pays back over the world servers its ports root", () => {
    const steps: { purse: Purse; income: number | null; onlineMs: number }[] = [];
    runModel(RUN_3_BN1_2.start, {
      policy: RUN_3_POLICY,
      horizonMs: 5 * 60 * MINUTE_MS,
      onStep: ({ purse, income, onlineMs }) => steps.push({ purse, income, onlineMs }),
    });
    let firsts = 0;
    for (const [index, step] of steps.entries()) {
      const before = steps[index - 1];
      if (before === undefined || step.onlineMs === 0 || before.onlineMs > step.onlineMs) continue;
      if (before.purse.cloudServersRamGb.length > 0 || step.purse.cloudServersRamGb.length === 0) continue;
      // The first cloud server of the cycle: bought at this step, over the world RAM of the ports open before it.
      firsts += 1;
      const worldRamGb = ROOTED_WORLD_RAM_GB_BY_PORTS[portsOpen(before.purse)] as number;
      const paybackMs = (CLOUD_SERVER_PRICE_PER_GB / ((step.income ?? 0) / worldRamGb)) * 1000;
      expect(paybackMs, `at ${step.onlineMs / MINUTE_MS} min`).toBeLessThanOrEqual(CLOUD_SERVER_PAYBACK_LIMIT_MS);
    }
    expect(firsts).toBeGreaterThan(1);
    // In the 1st cycle the payback over the world servers holds the first server back past the income window's end.
    const first = steps.find((step) => step.purse.cloudServersRamGb.length > 0) as (typeof steps)[number];
    expect(first.onlineMs).toBeGreaterThan(10 * MINUTE_MS);
  });

  test("the world servers' RAM by the ports open is the game's (`servers.ts`), rooted by the ports alone", () => {
    const servers = readFileSync(
      new URL("../../../vendor/bitburner-src/src/Server/data/servers.ts", import.meta.url),
      "utf8",
    ).split("hostname:");
    const byPorts = [0, 0, 0, 0, 0, 0];
    for (const server of servers.slice(1)) {
      const ports = /numOpenPortsRequired:\s*(\d+)/.exec(server);
      if (ports === null) continue;
      const single = /maxRamExponent:\s*(\d+)/.exec(server);
      const range = /maxRamExponent:\s*\{\s*max:\s*(\d+),\s*min:\s*(\d+)/.exec(server);
      let ram = 0;
      if (single !== null) ram = 2 ** Number(single[1]);
      else if (range !== null) {
        const [high, low] = [Number(range[1]), Number(range[2])];
        for (let exponent = low; exponent <= high; exponent++) ram += 2 ** exponent / (high - low + 1);
      }
      byPorts[Number(ports[1])] = (byPorts[Number(ports[1])] as number) + ram;
    }
    const cumulative = byPorts.map((_, ports) => byPorts.slice(0, ports + 1).reduce((sum, each) => sum + each, 0));
    for (const [ports, ram] of cumulative.entries()) {
      expect(ROOTED_WORLD_RAM_GB_BY_PORTS[ports], `${ports} ports`).toBeCloseTo(ram, 3);
    }
  });

  test("the money is the gross less what's spent; the income over the window; each install loses the programs and the cloud servers", () => {
    const steps: {
      onlineMs: number;
      gross: number;
      money: number;
      income: number | null;
      purse: Purse;
      cycle: number;
    }[] = [];
    let cycle = 0;
    let last = -1;
    const run = runModel(RUN_3_BN1_2.start, {
      policy: RUN_3_POLICY,
      onStep: ({ onlineMs, gross, money, income, purse }) => {
        if (onlineMs < last) cycle += 1;
        last = onlineMs;
        steps.push({ onlineMs, gross, money, income, purse, cycle });
      },
    });
    for (const step of steps) expect(step.money).toBeCloseTo(step.gross - step.purse.spent, 0);
    expect(steps.some((step) => step.purse.spent > 0 && step.money < step.gross)).toBe(true);
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
    // The first step of each cycle after an install: no cloud server (lost, and none before the window), only the
    // programs that step's own money bought, home's RAM no less than the install left.
    for (const [index, each] of run.cycles.entries()) {
      const first = steps.find((step) => step.cycle === index + 1);
      if (first === undefined) continue;
      expect(first.purse.cloudServersRamGb, `cycle ${index + 2}`).toEqual([]);
      const affordable = PROGRAM_PRICES.filter(
        (_, count) => PROGRAM_PRICES.slice(0, count + 1).reduce((sum, price) => sum + price, 0) <= first.gross,
      ).length;
      expect(first.purse.programs, `cycle ${index + 2}`).toBeLessThanOrEqual(affordable);
      expect(first.purse.spent, `cycle ${index + 2}`).toBeLessThanOrEqual(first.gross);
      expect(first.purse.homeRamGb).toBeGreaterThanOrEqual(each.homeRamGb);
    }
    // The commit: the set and the levels from the money in hand, home's RAM with the rest.
    for (const [index, each] of run.cycles.entries()) {
      const lastStep = steps.filter((step) => step.cycle === index).at(-1) as (typeof steps)[number];
      expect(each.commitMoney).toBeLessThanOrEqual(each.moneyAtEnd);
      expect(each.homeRamGb).toBe(homeRamAtCommit(lastStep.purse.homeRamGb, each.moneyAtEnd, each.commitMoney));
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
    endgameHoldFor: null,
    money: 5e9,
    set: { purchases: [], money: 1e9, donationMoney: 0 } as never,
    lookahead: 7e9,
  };

  test("the lookahead from cloud servers alone; the countdown's money from home's RAM and cloud servers, no program", () => {
    expect(holdsOf(decision, false, null)).toEqual({
      fromHomeRam: 0,
      fromPrograms: 0,
      fromCloudServers: 7e9,
      countdownUnderWay: false,
    });
    expect(holdsOf(decision, true, null)).toEqual({
      fromHomeRam: 5e9,
      fromPrograms: 0,
      fromCloudServers: 5e9,
      countdownUnderWay: true,
    });
  });

  test("held for Daedalus's count: the counted money, or the set's and the last's if more", () => {
    expect(holdsOf(decision, false, { next: { money: 1e9 } })).toMatchObject({
      fromHomeRam: 5e9,
      countdownUnderWay: true,
    });
    expect(holdsOf(decision, false, { next: { money: 9e9 } })).toMatchObject({
      fromHomeRam: 10e9,
      fromCloudServers: 10e9,
    });
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
  test("run #3's brain's (before #242): the game's bonus for a fitted share of home's and the cloud servers' RAM", () => {
    const purse = { ...freshPurse(1024), cloudServersRamGb: [2048, 2048] };
    const threads = (CALIBRATION.shareRamShare * (1024 + 4096)) / SHARE_RAM_GB;
    expect(cloudRamOf(purse)).toBe(4096);
    expect(shareBonusOfState(purse, CALIBRATION, false)).toBe(shareBonusOfPower(1 + threads));
    expect(shareBonusOfState(freshPurse(1024), CALIBRATION, false)).toBeLessThan(
      shareBonusOfState(purse, CALIBRATION, false),
    );
  });

  test("#242's (today's brain, the default): core's `shareRound` on home and the batches' hosts", () => {
    const purse = { ...freshPurse(8192), cloudServersRamGb: [2 ** 20, 2 ** 20] };
    // Home less the Agent's 8 GB in use and the 32 kept: (8192 − 8 − 32) / 4 = 2038 threads. The batches' hosts at run
    // #3's 82% use are past `SHARE_MOST_USE` (80%), so share nothing.
    expect(shareRamGbOfState(purse, CALIBRATION, 3168.8)).toBe(2038 * SHARE_RAM_GB);
    expect(shareBonusOfState(purse, CALIBRATION, true, 3168.8)).toBe(shareBonusOfPower(1 + 2038));
    expect(shareBonusOfState(purse, CALIBRATION, undefined, 3168.8)).toBe(shareBonusOfPower(1 + 2038));
    // From the brain's constants alone: home 32 GB shares nothing, 64 GB 24, 512 GB 472. These are BN1.3's 1st cycle's
    // readings at 15, 20 and 30 min, but seen before the Agent's RAM in use was modelled (#293's first review), so
    // after the fact: not validation.
    expect([32, 64, 512].map((home) => shareRamGbOfState(freshPurse(home), CALIBRATION, 100))).toEqual([0, 24, 472]);
    expect(shareBonusOfState(freshPurse(32), CALIBRATION, true, 100)).toBe(1);
  });

  test("#242's: the batches' use by cycle, its last past the list; below 80%, their hosts share the room to it", () => {
    const purse = { ...freshPurse(8192), cloudServersRamGb: [2 ** 20, 2 ** 20] };
    const byCycle = { ...CALIBRATION, batchesUseOfHosts: [0.82, 0.7] };
    const hostsGb = 3168.8 + 2 ** 21;
    // At 70%, a tenth of the world and cloud servers' RAM beside home's 2038 threads.
    const tenth = Math.floor((0.1 * hostsGb) / SHARE_RAM_GB);
    expect(shareRamGbOfState(purse, byCycle, 3168.8, 0)).toBe(2038 * SHARE_RAM_GB);
    expect(shareRamGbOfState(purse, byCycle, 3168.8, 1)).toBe((2038 + tenth) * SHARE_RAM_GB);
    expect(shareRamGbOfState(purse, byCycle, 3168.8, 7)).toBe((2038 + tenth) * SHARE_RAM_GB);
  });

  test("a policy without `homeShares` is today's brain, #242's share; run #3's says false", () => {
    const today = runModel(RUN_3_BN1_2.start, { policy: TODAYS_POLICY, horizonMs: 2 * 60 * MINUTE_MS });
    const absent = runModel(RUN_3_BN1_2.start, {
      policy: { name: "absent", daedalusCountHold: true },
      horizonMs: 2 * 60 * MINUTE_MS,
    });
    expect(absent.cycles).toEqual(today.cycles);
    expect(RUN_3_POLICY.homeShares).toBe(false);
    expect(TODAYS_POLICY.homeShares).toBe(true);
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
  test("gross: A6 and the joins see the cycle's gross income (#260's); the purse spends and the commit's home RAM is cash", () => {
    const lastPurse: Purse[] = [];
    let cycle = 0;
    let last = -1;
    const gross = runModel(RUN_3_BN1_2.start, {
      policy: RUN_3_POLICY,
      money: "gross",
      horizonMs: 3 * 60 * MINUTE_MS,
      onStep: ({ onlineMs, purse }) => {
        if (onlineMs < last) cycle += 1;
        last = onlineMs;
        lastPurse[cycle] = purse;
      },
    });
    expect(gross.cycles.length).toBeGreaterThan(1);
    for (const [index, each] of gross.cycles.entries()) {
      const purse = lastPurse[index] as Purse;
      expect(each.moneyAtEnd).toBe(each.grossAtEnd);
      expect(purse.spent).toBeGreaterThan(0);
      // No double count: home's RAM at the commit from the gross less what the purse spent, less the commit.
      expect(each.homeRamGb).toBe(homeRamAtCommit(purse.homeRamGb, each.grossAtEnd - purse.spent, each.commitMoney));
    }
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
    expect(beyond.length).toBeGreaterThan(0);
    expect(run.outOfRange.slice(0, beyond.length)).toEqual(beyond);
  });

  test("the cycle under way at the horizon is flagged too: out of range past the bound, not before", () => {
    const never = { name: "never", daedalusCountHold: false, install: () => false };
    // Run #3's 1st measured cycle ended at 39.5 min: at 90 min, 50.5 past (within the bound); at 120, 80.5 (out).
    const within = runModel(RUN_3_BN1_2.start, { policy: never, measured: RUN_3_CYCLES, horizonMs: 90 * MINUTE_MS });
    expect(within.cycles).toHaveLength(0);
    expect(within.outOfRange).toEqual([]);
    const beyond = runModel(RUN_3_BN1_2.start, { policy: never, measured: RUN_3_CYCLES, horizonMs: 120 * MINUTE_MS });
    expect(beyond.outOfRange).toEqual([1]);
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
