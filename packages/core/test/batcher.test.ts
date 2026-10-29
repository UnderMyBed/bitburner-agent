import { describe, expect, test } from "vitest";
import {
  BATCH_GROW_RAM_GB,
  BATCH_HACK_RAM_GB,
  BATCH_LANDING_GAP_MS,
  BATCH_LAUNCH_LEAD_MS,
  BATCH_OPERATIONS,
  BATCH_WEAKEN_RAM_GB,
  type BatchThreads,
  batchBounds,
  batchHoldsMs,
  batchOrders,
  batchPeakRamGb,
  batchPlan,
  batchRamGb,
  batchThreads,
  GROW_MARGIN,
  growThreads,
  hackSharePerThread,
  hackThreadsAtLaunch,
  hackThreadsForShare,
  isOutsideBounds,
  isTargetPrepared,
  LANDING_LOST_AFTER_MS,
  LandingWatch,
  landingOffsetMs,
  launchLeadMs,
  leastSpacingMs,
  MAX_BATCH_SHARE,
  MIN_BATCH_SPACING_MS,
  newBatcherHealth,
  operationRamGb,
  operationScriptName,
  operationTimeMs,
  parseBatcherConfig,
  parseLandingRecord,
  placeThreads,
  preparationWave,
  threadsThatFit,
} from "../src/batcher.ts";
import { growthLogPerThread } from "../src/hack-loop.ts";
import {
  batcherIncomePerGigabyteSecond,
  type HackingPlayer,
  type HackingTarget,
  hackChance,
  hackTimeSeconds,
} from "../src/hacking-ceiling.ts";

const player = (hacking: number, overrides: Partial<HackingPlayer["mults"]> = {}): HackingPlayer => ({
  skills: { hacking, intelligence: 0 },
  mults: { hacking_chance: 1, hacking_speed: 1, hacking_money: 1, hacking_grow: 1, ...overrides },
});

/** zer0 (BN1): $187.5m at most, security 10 at least, needs hacking 75, growth 25. */
const zer0: HackingTarget = { moneyMax: 187_500_000, minDifficulty: 10, requiredHackingSkill: 75, serverGrowth: 25 };
/** n00dles: $1.75m, security 1, needs 1, growth 3000. */
const n00dles: HackingTarget = { moneyMax: 1_750_000, minDifficulty: 1, requiredHackingSkill: 1, serverGrowth: 3_000 };
/** joesguns: $62.5m, security 5, needs 10, growth 20. */
const joesguns: HackingTarget = { moneyMax: 62_500_000, minDifficulty: 5, requiredHackingSkill: 10, serverGrowth: 20 };

/** A small seeded generator, so the sweeps are the same every run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

const growthLogOf = (target: HackingTarget, mults: HackingPlayer = player(100)) =>
  growthLogPerThread({ serverGrowth: target.serverGrowth, hackDifficulty: target.minDifficulty }, mults);

describe("growThreads: the game's numCycleForGrowthCorrected, ServerHelpers.ts:90-199", () => {
  test("none to grow: 0; no growth: Infinity; the target capped at the maximum", () => {
    expect(growThreads(100, 100, 1_000, 0.01)).toBe(0);
    expect(growThreads(200, 100, 1_000, 0.01)).toBe(0);
    expect(growThreads(100, 200, 1_000, 0)).toBe(Number.POSITIVE_INFINITY);
    expect(growThreads(100, 2_000, 1_000, 0.01)).toBe(growThreads(100, 1_000, 1_000, 0.01));
  });

  test("worked by hand: from $0, 3 threads at k = log(2) reach $16 ((0 + 3) x 2^3 = 24), 2 don't (2 x 4 = 8)", () => {
    expect(growThreads(0, 16, 1_000, Math.log(2))).toBe(3);
    expect(growThreads(0, 8, 1_000, Math.log(2))).toBe(2);
    // From below 0, as from 0.
    expect(growThreads(-5, 16, 1_000, Math.log(2))).toBe(3);
  });

  test("the fewest whole threads that reach the target, (start + x) e^(kx) >= target, over a seeded sweep", () => {
    const random = seeded(7);
    for (let index = 0; index < 2_000; index += 1) {
      const moneyMax = 10 ** (3 + random() * 9);
      const target = moneyMax * (0.5 + random() * 0.5);
      const start = target * random() ** 3;
      const growthLog = 10 ** (-5 + random() * 4);
      const threads = growThreads(start, target, moneyMax, growthLog);
      const reaches = (x: number) => (start + x) * Math.exp(growthLog * x) >= target * (1 - 1e-12);
      expect(reaches(threads), `${start} → ${target} at ${growthLog}`).toBe(true);
      if (threads > 0) expect(reaches(threads - 1 - 1e-9), `${start} → ${target} at ${growthLog}`).toBe(false);
    }
  });
});

describe("batchThreads", () => {
  test("zer0, hacking 150, 10 hack threads: weaken1 for 0.002 a thread, grow for 1.1 x the share, weaken2 for it", () => {
    const at150 = player(150);
    const perThread = (0.9 * (150 - 74)) / 150 / 240;
    expect(hackSharePerThread(zer0, at150)).toBeCloseTo(perThread, 15);
    const threads = batchThreads(zer0, at150, 10);
    const growthLog = growthLogOf(zer0, at150);
    const grow = growThreads(
      zer0.moneyMax * (1 - GROW_MARGIN * 10 * perThread),
      zer0.moneyMax,
      zer0.moneyMax,
      growthLog,
    );
    expect(threads).toEqual({ hack: 10, weaken1: 1, grow, weaken2: Math.ceil((grow * 0.004) / 0.05 - 1e-9) });
    // The grow brings back GROW_MARGIN times the share, not just the share.
    const left = zer0.moneyMax * (1 - GROW_MARGIN * 10 * perThread);
    expect((left + grow) * Math.exp(growthLog * grow)).toBeGreaterThanOrEqual(zer0.moneyMax);
    expect((left + grow - 1) * Math.exp(growthLog * (grow - 1))).toBeLessThan(zer0.moneyMax);
  });

  test("whole threads: 25 hack threads' 0.05 is one weaken, 26's two; at least 1 of each", () => {
    expect(batchThreads(n00dles, player(50), 25).weaken1).toBe(1);
    expect(batchThreads(n00dles, player(50), 26).weaken1).toBe(2);
    const one = batchThreads(n00dles, player(50), 1);
    expect(Object.values(one).every((threads) => threads >= 1)).toBe(true);
    expect(batchThreads(n00dles, player(50), 0).hack).toBe(1);
  });

  test("hackThreadsForShare: the threads for a share now, at least 1; 0 where a thread takes nothing", () => {
    const perThread = hackSharePerThread(joesguns, player(50));
    expect(hackThreadsForShare(10 * perThread, joesguns, player(50))).toBe(10);
    expect(hackThreadsForShare(10.9 * perThread, joesguns, player(50))).toBe(10);
    expect(hackThreadsForShare(perThread / 2, joesguns, player(50))).toBe(1);
    expect(hackThreadsForShare(0.1, joesguns, player(5))).toBe(0);
  });
});

describe("the operations: scripts, RAM, landing order, times", () => {
  test("hack, weaken1, grow, weaken2, δ apart; their scripts and RAM", () => {
    expect(BATCH_OPERATIONS).toEqual(["hack", "weaken1", "grow", "weaken2"]);
    expect(BATCH_OPERATIONS.map(landingOffsetMs)).toEqual([0, 1, 2, 3].map((each) => each * BATCH_LANDING_GAP_MS));
    expect(BATCH_OPERATIONS.map(operationScriptName)).toEqual([
      "batch-hack.js",
      "batch-weaken.js",
      "batch-grow.js",
      "batch-weaken.js",
    ]);
    expect(BATCH_OPERATIONS.map(operationRamGb)).toEqual([1.75, 1.8, 1.8, 1.8]);
    expect([BATCH_HACK_RAM_GB, BATCH_GROW_RAM_GB, BATCH_WEAKEN_RAM_GB]).toEqual([1.75, 1.8, 1.8]);
  });

  test("a hack's time at the minimum security, or another; grow 3.2 and weaken 4 of it (Hacking.ts:60-94)", () => {
    const hackMs = hackTimeSeconds({ hackDifficulty: 10, requiredHackingSkill: 75 }, player(150)) * 1000;
    expect(operationTimeMs("hack", zer0, player(150))).toBeCloseTo(hackMs, 9);
    expect(operationTimeMs("grow", zer0, player(150))).toBeCloseTo(hackMs * 3.2, 9);
    expect(operationTimeMs("weaken1", zer0, player(150))).toBeCloseTo(hackMs * 4, 9);
    expect(operationTimeMs("weaken2", zer0, player(150), 12)).toBeCloseTo(
      hackTimeSeconds({ hackDifficulty: 12, requiredHackingSkill: 75 }, player(150)) * 4000,
      9,
    );
  });

  test("the lead: 200 ms, plus what security at the ceiling adds to the operation's time", () => {
    expect(launchLeadMs("hack", zer0, player(150), zer0.minDifficulty)).toBe(BATCH_LAUNCH_LEAD_MS);
    const slower = operationTimeMs("weaken1", zer0, player(150), 10.2) - operationTimeMs("weaken1", zer0, player(150));
    expect(slower).toBeGreaterThan(0);
    expect(launchLeadMs("weaken1", zer0, player(150), 10.2)).toBeCloseTo(BATCH_LAUNCH_LEAD_MS + slower, 9);
  });

  test("a batch's orders: each lands at its offset and starts its hold before; weaken1 first, hack last", () => {
    const holds = { hack: 1_000, weaken1: 4_000, grow: 3_200, weaken2: 4_000 };
    const orders = batchOrders(7, 100_000, holds);
    expect(orders).toEqual([
      { batch: 7, operation: "weaken1", landAt: 100_020, launchAt: 96_020 },
      { batch: 7, operation: "weaken2", landAt: 100_060, launchAt: 96_060 },
      { batch: 7, operation: "grow", landAt: 100_040, launchAt: 96_840 },
      { batch: 7, operation: "hack", landAt: 100_000, launchAt: 99_000 },
    ]);
  });

  test("batchHoldsMs: each operation's time at the minimum plus its lead at the batch's ceiling", () => {
    const threads = batchThreads(zer0, player(150), 10);
    const { securityCeiling } = batchBounds(zer0, player(150), [threads]);
    const holds = batchHoldsMs(zer0, player(150), threads);
    for (const operation of BATCH_OPERATIONS) {
      expect(holds[operation]).toBeCloseTo(
        operationTimeMs(operation, zer0, player(150)) + launchLeadMs(operation, zer0, player(150), securityCeiling),
        9,
      );
    }
  });
});

describe("batchBounds", () => {
  const threads: BatchThreads = { hack: 10, weaken1: 1, grow: 30, weaken2: 3 };

  test("money at least what a hack of 1.1 x the share leaves; security at most the minimum + the larger rise", () => {
    const share = 10 * hackSharePerThread(zer0, player(150));
    const bounds = batchBounds(zer0, player(150), [threads]);
    expect(bounds.moneyFloor).toBeCloseTo(zer0.moneyMax * (1 - 1.1 * share), 3);
    expect(bounds.securityCeiling).toBeCloseTo(10 + 0.12, 6);
    expect(batchBounds(zer0, player(150), [{ ...threads, hack: 100, grow: 10 }]).securityCeiling).toBeCloseTo(10.2, 6);
    // A share past all of the money leaves a floor of 0, never below.
    expect(batchBounds(n00dles, player(50), [{ ...threads, hack: 1_000 }]).moneyFloor).toBe(0);
  });

  test("over every batch still landing: an older batch's larger hack, or grow, sets them", () => {
    const older = { ...threads, hack: 20, grow: 40 };
    const share = 20 * hackSharePerThread(zer0, player(150));
    const bounds = batchBounds(zer0, player(150), [threads, older]);
    expect(bounds.moneyFloor).toBeCloseTo(zer0.moneyMax * (1 - 1.1 * share), 3);
    expect(bounds.securityCeiling).toBeCloseTo(10 + 0.16, 6);
    expect(batchBounds(zer0, player(150), [older, threads])).toEqual(bounds);
  });

  test("isOutsideBounds: money under the floor, or security over the ceiling, each alone", () => {
    const bounds = { moneyFloor: 100, securityCeiling: 10.1 };
    expect(isOutsideBounds(bounds, { money: 100, security: 10.1 })).toBe(false);
    expect(isOutsideBounds(bounds, { money: 99.99, security: 10 })).toBe(true);
    expect(isOutsideBounds(bounds, { money: 1_000, security: 10.11 })).toBe(true);
  });
});

describe("hackThreadsAtLaunch: a hack replanned when it goes out, as the hacking level rises", () => {
  test("zer0 (needs 75): planned at hacking 150, sent at 160, no more threads than take the share planned", () => {
    const planned = batchThreads(zer0, player(150), 40);
    const plannedShare = planned.hack * hackSharePerThread(zer0, player(150));
    const atLaunch = hackThreadsAtLaunch(planned.hack, plannedShare, zer0, player(160));
    expect(atLaunch).toBeLessThan(planned.hack);
    expect(atLaunch * hackSharePerThread(zer0, player(160))).toBeLessThanOrEqual(plannedShare * (1 + 1e-12));
    // So the grow, sized for 1.1 x the planned share, still covers what it takes.
    expect(atLaunch * hackSharePerThread(zer0, player(160))).toBeLessThan(GROW_MARGIN * plannedShare);
    // Sent unreplanned, the 40 threads would take more than the margin covers: (160 - 74)/160 over (150 - 74)/150.
    expect(planned.hack * hackSharePerThread(zer0, player(170))).toBeGreaterThan(GROW_MARGIN * plannedShare);
  });

  /**
   * Batches on harakiri-sushi (needs 40) every 30 s while the hacking level climbs from 55 by 6 levels a weaken's time,
   * the rise #208's review measured (the share a thread takes 1.25x over a weaken): each batch planned at its first
   * weaken's level, its hack sent a hack's time before it lands, and landing at the level then. Money after
   * each hack never falls under the bounds' floor; sent as planned, unreplanned, it does.
   */
  function driftOverBatches(replanned: boolean): { lowest: number; floorBreaks: number } {
    const harakiri: HackingTarget = {
      moneyMax: 100_000_000,
      minDifficulty: 5,
      requiredHackingSkill: 40,
      serverGrowth: 40,
    };
    const spacingMs = 30_000;
    const weakenMs = operationTimeMs("weaken1", harakiri, player(55));
    const levelAt = (ms: number) => 55 + (6 * ms) / weakenMs;
    const growthLog = growthLogOf(harakiri, player(55));
    let money = harakiri.moneyMax;
    let lowest = 1;
    let floorBreaks = 0;
    for (let batch = 0; batch < 60; batch += 1) {
      const landMs = batch * spacingMs + weakenMs;
      const planned = player(Math.floor(levelAt(landMs - weakenMs)));
      const threads = batchThreads(harakiri, planned, hackThreadsForShare(0.05, harakiri, planned));
      const plannedShare = threads.hack * hackSharePerThread(harakiri, planned);
      const hackMs = operationTimeMs("hack", harakiri, planned);
      const sent = player(Math.floor(levelAt(landMs - hackMs)));
      const hackCount = replanned ? hackThreadsAtLaunch(threads.hack, plannedShare, harakiri, sent) : threads.hack;
      const landing = player(Math.floor(levelAt(landMs)));
      money *= 1 - Math.min(1, hackCount * hackSharePerThread(harakiri, landing));
      const { moneyFloor } = batchBounds(harakiri, landing, [threads]);
      if (money < moneyFloor) floorBreaks += 1;
      lowest = Math.min(lowest, money / harakiri.moneyMax);
      money = Math.min(harakiri.moneyMax, (money + threads.grow) * Math.exp(growthLog * threads.grow));
    }
    return { lowest, floorBreaks };
  }

  test("a rising level: replanned at launch, money stays within the bounds; unreplanned, it breaks them", () => {
    expect(driftOverBatches(true).floorBreaks).toBe(0);
    expect(driftOverBatches(false).floorBreaks).toBeGreaterThan(0);
  });

  test("never more than planned, at least 1", () => {
    expect(hackThreadsAtLaunch(10, 10 * hackSharePerThread(zer0, player(150)), zer0, player(150))).toBe(10);
    expect(hackThreadsAtLaunch(10, 1, zer0, player(150))).toBe(10);
    expect(hackThreadsAtLaunch(3, 1e-9, zer0, player(150))).toBe(1);
  });
});

describe("the plan", () => {
  const holds = { hack: 1_000, weaken1: 4_000, grow: 3_200, weaken2: 4_000 };
  const threads: BatchThreads = { hack: 10, weaken1: 1, grow: 20, weaken2: 2 };
  /** One batch's operations at once: 10 x 1.75 + 1 x 1.8 + 20 x 1.8 + 2 x 1.8. */
  const oneBatchGb = 17.5 + 1.8 + 36 + 3.6;

  test("the peak: each operation's RAM times the batches running it at once, ⌈hold / spacing⌉", () => {
    expect(batchPeakRamGb(threads, holds, 4_000)).toBeCloseTo(oneBatchGb, 9);
    // At 1 s: 1 hack, 4 weaken1, 4 grows, 4 weaken2 at once.
    expect(batchPeakRamGb(threads, holds, 1_000)).toBeCloseTo(17.5 + 4 * 1.8 + 4 * 36 + 4 * 3.6, 9);
  });

  test("the least spacing that fits; null when one batch doesn't; never under the minimum", () => {
    expect(leastSpacingMs(threads, holds, oneBatchGb - 0.01)).toBeNull();
    expect(leastSpacingMs(threads, holds, oneBatchGb)).toBe(4_000);
    const spacing = leastSpacingMs(threads, holds, 100) as number;
    expect(batchPeakRamGb(threads, holds, spacing)).toBeLessThanOrEqual(100);
    expect(batchPeakRamGb(threads, holds, spacing - 1)).toBeGreaterThan(100);
    expect(leastSpacingMs(threads, holds, 1e9)).toBe(MIN_BATCH_SPACING_MS);
  });

  test("batchPlan: the most income over the hack threads, its peak within the RAM; null with nothing to plan", () => {
    const plan = batchPlan(joesguns, player(50), 100);
    expect(plan).not.toBeNull();
    if (plan === null) return;
    expect(plan.peakRamGb).toBeLessThanOrEqual(100);
    expect(plan.spacingMs).toBeGreaterThanOrEqual(MIN_BATCH_SPACING_MS);
    const chance = hackChance({ hackDifficulty: 5, requiredHackingSkill: 10 }, player(50));
    expect(plan.incomePerSecond).toBeCloseTo((joesguns.moneyMax * plan.hackShare * chance * 1000) / plan.spacingMs, 6);
    // No other count of hack threads does better.
    for (let hack = 1; hack * hackSharePerThread(joesguns, player(50)) <= MAX_BATCH_SHARE; hack += 1) {
      const each = batchThreads(joesguns, player(50), hack);
      const spacing = leastSpacingMs(each, batchHoldsMs(joesguns, player(50), each), 100);
      if (spacing === null) break;
      const income = (joesguns.moneyMax * hack * hackSharePerThread(joesguns, player(50)) * chance * 1000) / spacing;
      expect(income).toBeLessThanOrEqual(plan.incomePerSecond * (1 + 1e-12));
    }
    expect(batchPlan(joesguns, player(5), 100), "below the hacking it needs").toBeNull();
    expect(batchPlan(joesguns, player(50), 5), "no batch fits 5 GB").toBeNull();
    expect(batchPlan({ ...joesguns, moneyMax: 0 }, player(50), 100), "no money").toBeNull();
  });

  test("never above A1's batcher ceiling on the same RAM, over targets, hacking levels and RAM", () => {
    for (const target of [n00dles, joesguns, zer0]) {
      for (const hacking of [30, 80, 150, 400, 1_000]) {
        for (const ramGb of [16, 100, 1_000, 10_000]) {
          const plan = batchPlan(target, player(hacking), ramGb);
          if (plan === null) continue;
          const ceiling = batcherIncomePerGigabyteSecond(target, player(hacking), 1) * ramGb;
          expect(plan.incomePerSecond, `${target.moneyMax} at ${hacking} on ${ramGb} GB`).toBeLessThanOrEqual(ceiling);
        }
      }
    }
  });

  test("on 100 GB to 1 TB, the plan reaches most of the ceiling: whole threads and the lead cost the rest", () => {
    for (const [target, hacking] of [
      [n00dles, 50],
      [joesguns, 150],
      [zer0, 300],
    ] as const) {
      for (const ramGb of [100, 1_000]) {
        const plan = batchPlan(target, player(hacking), ramGb) as NonNullable<ReturnType<typeof batchPlan>>;
        const ceiling = batcherIncomePerGigabyteSecond(target, player(hacking), 1) * ramGb;
        expect(plan.incomePerSecond / ceiling).toBeGreaterThan(0.6);
      }
    }
  });
});

describe("placement", () => {
  test("batchRamGb: each host's whole threads of 1.8 GB, as exec counts them", () => {
    expect(batchRamGb([16, 16, 4, 2, 1])).toBeCloseTo(14.4 + 14.4 + 3.6 + 1.8, 9);
    expect(batchRamGb([])).toBe(0);
  });

  test("threadsThatFit: as exec counts, roundToTwo(ram x threads) <= free + 0.001 (NetscriptWorker.ts:110-117)", () => {
    expect(threadsThatFit(3.5, 1.75)).toBe(2);
    expect(threadsThatFit(3.49, 1.75)).toBe(1);
    // 5.4 / 1.8 is 2.9999999999999996 in floating point: still 3.
    expect(threadsThatFit(5.4, 1.8)).toBe(3);
    expect(threadsThatFit(5.3995, 1.8)).toBe(3);
    expect(threadsThatFit(0, 1.8)).toBe(0);
    expect(threadsThatFit(-1, 1.8)).toBe(0);
  });

  test("whole on the host with the least free RAM that holds it; split largest first otherwise; null if short", () => {
    const hosts = [
      { host: "a", freeGb: 16 },
      { host: "b", freeGb: 8 },
      { host: "c", freeGb: 32 },
    ];
    expect(placeThreads(hosts, 4, 1.8)).toEqual([{ host: "b", threads: 4 }]);
    expect(placeThreads(hosts, 5, 1.8)).toEqual([{ host: "a", threads: 5 }]);
    expect(placeThreads(hosts, 20, 1.8)).toEqual([
      { host: "c", threads: 17 },
      { host: "a", threads: 3 },
    ]);
    expect(placeThreads(hosts, 17 + 8 + 4 + 1, 1.8)).toBeNull();
    expect(placeThreads(hosts, 0, 1.8)).toEqual([]);
  });

  test("never more than a host holds, and all the threads asked, over a seeded sweep", () => {
    const random = seeded(11);
    for (let index = 0; index < 1_000; index += 1) {
      const hosts = Array.from({ length: 1 + Math.floor(random() * 6) }, (_, each) => ({
        host: `h${each}`,
        freeGb: Math.floor(random() * 64 * 100) / 100,
      }));
      const ramGb = random() < 0.5 ? 1.75 : 1.8;
      const threads = 1 + Math.floor(random() * 60);
      const placed = placeThreads(hosts, threads, ramGb);
      const room = hosts.reduce((total, each) => total + threadsThatFit(each.freeGb, ramGb), 0);
      if (placed === null) {
        expect(room).toBeLessThan(threads);
        continue;
      }
      expect(placed.reduce((total, part) => total + part.threads, 0)).toBe(threads);
      for (const part of placed) {
        const host = hosts.find((each) => each.host === part.host) as { freeGb: number };
        expect(part.threads).toBeGreaterThan(0);
        expect(Math.round(part.threads * ramGb * 100) / 100).toBeLessThanOrEqual(host.freeGb + 0.001);
      }
    }
  });
});

describe("preparation", () => {
  test("ready at the minimum security and the maximum money", () => {
    expect(isTargetPrepared(joesguns, { money: joesguns.moneyMax, security: 5 })).toBe(true);
    expect(isTargetPrepared(joesguns, { money: joesguns.moneyMax, security: 5.002 })).toBe(false);
    expect(isTargetPrepared(joesguns, { money: joesguns.moneyMax - 1, security: 5 })).toBe(false);
    expect(preparationWave(joesguns, player(50), { money: joesguns.moneyMax, security: 5 }, 100)).toBeNull();
  });

  test("weaken1 for the security over, grow from the money now, weaken2 for the grow, all on enough RAM", () => {
    const now = { money: 2_500_000, security: 15 };
    const grow = growThreads(2_500_000, joesguns.moneyMax, joesguns.moneyMax, growthLogOf(joesguns, player(50)));
    expect(preparationWave(joesguns, player(50), now, 1e6)).toEqual({
      weaken1: 200,
      grow,
      weaken2: Math.ceil(grow * 0.08 - 1e-9),
    });
  });

  test("whole threads where floating point is off: 3.8 over the minimum is 76 weakens, not 77", () => {
    // (8.8 - 5) / 0.05 is 76.00000000000001 in floating point.
    expect(preparationWave(joesguns, player(50), { money: joesguns.moneyMax, security: 8.8 }, 1e6)).toEqual({
      weaken1: 76,
      grow: 0,
      weaken2: 0,
    });
  });

  test("short of RAM: weaken1 first, then as much grow as fits with its weaken2; none when nothing fits", () => {
    const now = { money: 2_500_000, security: 15 };
    expect(preparationWave(joesguns, player(50), now, 100)).toEqual({ weaken1: 55, grow: 0, weaken2: 0 });
    const wave = preparationWave(joesguns, player(50), { money: 2_500_000, security: 5 }, 100) as {
      grow: number;
      weaken2: number;
      weaken1: number;
    };
    expect(wave.weaken1).toBe(0);
    expect(wave.weaken2).toBe(Math.ceil(wave.grow * 0.08 - 1e-9));
    expect((wave.grow + wave.weaken2) * 1.8).toBeLessThanOrEqual(100);
    expect((wave.grow + 1 + Math.ceil((wave.grow + 1) * 0.08 - 1e-9)) * 1.8).toBeGreaterThan(100);
    expect(preparationWave(joesguns, player(50), now, 1)).toEqual({ weaken1: 0, grow: 0, weaken2: 0 });
  });
});

describe("landings", () => {
  const record = (id: string, landAt: number, extra: Partial<Record<string, unknown>> = {}) => ({
    id,
    landAt,
    landedAt: landAt,
    result: 1,
    late: false,
    skipped: false,
    ...extra,
  });

  test("parseLandingRecord: the fields, or null", () => {
    expect(parseLandingRecord(record("1.hack.0", 5))).toEqual(record("1.hack.0", 5));
    for (const bad of [
      null,
      "x",
      3,
      record("a", Number.NaN),
      record("a", 1, { late: "no" }),
      record("a", 1, { skipped: undefined }),
      { ...record("a", 1), id: 2 },
    ]) {
      expect(parseLandingRecord(bad)).toBeNull();
    }
  });

  test("in order, out of order, the same moment (parts of one operation), unexpected", () => {
    const watch = new LandingWatch();
    watch.expect("a", 100);
    watch.expect("b", 120);
    watch.expect("c", 120);
    expect(watch.inFlight()).toBe(3);
    expect(watch.landed(record("a", 100))).toEqual({ outOfOrder: false, expected: true });
    expect(watch.landed(record("b", 120))).toEqual({ outOfOrder: false, expected: true });
    expect(watch.landed(record("c", 120))).toEqual({ outOfOrder: false, expected: true });
    expect(watch.inFlight()).toBe(0);
    watch.expect("d", 110);
    expect(watch.landed(record("d", 110))).toEqual({ outOfOrder: true, expected: true });
  });

  test("an unexpected record (another run's, or one already counted) moves nothing", () => {
    const watch = new LandingWatch();
    watch.expect("a", 100);
    expect(watch.landed(record("old.7.hack.0", 1_000))).toEqual({ outOfOrder: false, expected: false });
    expect(watch.landed(record("a", 100))).toEqual({ outOfOrder: false, expected: true });
    expect(watch.landed(record("a", 100))).toEqual({ outOfOrder: false, expected: false });
    expect(watch.latestLandAt()).toBe(100);
  });

  test("a hack that never ran (late), recorded at once with its later time, makes nothing out of order", () => {
    const watch = new LandingWatch();
    watch.expect("w", 100);
    watch.expect("h", 200);
    expect(watch.landed(record("h", 200, { late: true, skipped: true }))).toEqual({
      outOfOrder: false,
      expected: true,
    });
    expect(watch.landed(record("w", 100))).toEqual({ outOfOrder: false, expected: true });
  });

  test("lost once LANDING_LOST_AFTER_MS past its time, and forgotten; the latest landing time", () => {
    const watch = new LandingWatch();
    watch.expect("a", 1_000);
    watch.expect("b", 5_000);
    expect(watch.latestLandAt()).toBe(5_000);
    expect(watch.nextLostAtMs()).toBe(1_001 + LANDING_LOST_AFTER_MS);
    expect(watch.takeLost(1_000 + LANDING_LOST_AFTER_MS)).toBe(0);
    expect(watch.takeLost(1_001 + LANDING_LOST_AFTER_MS)).toBe(1);
    expect(watch.inFlight()).toBe(1);
    watch.landed(record("b", 5_000));
    expect(watch.latestLandAt()).toBe(5_000);
    expect(new LandingWatch().latestLandAt()).toBe(Number.NEGATIVE_INFINITY);
    expect(new LandingWatch().nextLostAtMs()).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("parseBatcherConfig", () => {
  const config = {
    target: "joesguns",
    figures: joesguns,
    player: { intelligence: 0, mults: player(1).mults },
    hosts: ["foodnstuff", "sigma-cosmetics"],
    hackShare: 0.05,
    spacingMs: 5_000,
  };

  test("a config, as given", () => {
    expect(parseBatcherConfig(config)).toEqual({ ok: true, config });
  });

  test.each([
    [null, "isn't an object"],
    [{ ...config, target: "" }, "no target"],
    [{ ...config, figures: { ...joesguns, serverGrowth: undefined } }, "figures have no serverGrowth"],
    [{ ...config, player: { mults: player(1).mults } }, "no intelligence"],
    [{ ...config, player: { intelligence: 0, mults: { ...player(1).mults, hacking_speed: "1" } } }, "hacking_speed"],
    [{ ...config, hosts: [] }, "hosts"],
    [{ ...config, hosts: ["a", ""] }, "hosts"],
    [{ ...config, hackShare: 0 }, "hackShare"],
    [{ ...config, hackShare: 0.95 }, "hackShare"],
    [{ ...config, spacingMs: MIN_BATCH_SPACING_MS - 1 }, "spacing"],
  ])("refused: %j (%s)", (value, reason) => {
    const parsed = parseBatcherConfig(value);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain(reason);
  });

  test("a new batcher's health: preparing, every count 0, no problem", () => {
    expect(newBatcherHealth("joesguns", "r1", 5)).toMatchObject({
      state: "preparing",
      target: "joesguns",
      runName: "r1",
      unexpected: 0,
      batchesStarted: 0,
      desyncs: 0,
      problem: null,
      atMs: 5,
    });
  });
});
