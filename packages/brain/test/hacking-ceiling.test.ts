// The hacking ceiling over the snapshots (#196): the targets and the RAM it counts, what hacking earned from the slow
// snapshots, and the run report's section, from snapshot data built here.
import {
  batcherIncomePerGigabyteSecond,
  hackingIncomePerGigabyteSecond,
  type MediumSnapshotData,
  type SlowSnapshotData,
  type StaticSnapshotData,
} from "@bitburner-agent/core";
import { describe, expect, test } from "vitest";
import {
  describeCeiling,
  HACKING_STRETCH_MS,
  type HackingCeiling,
  HackingFold,
  type HackingMoneyPoint,
  hackingCeiling,
  hackingEarnedBetween,
  hackingIncomePerSecond,
  hackingMoneyOf,
} from "../src/hacking-ceiling.ts";
import { mediumData, slowData, staticServer } from "./helpers/snapshot-fixtures.ts";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

/** A player as `ns.getPlayer()` has it, with the skills and multipliers the formulas read. */
const fullPlayer = (hacking: number, mults: Record<string, number> = {}) => ({
  skills: { hacking, intelligence: 0, strength: 1 },
  mults: { hacking_chance: 1, hacking_speed: 1, hacking_money: 1, hacking_grow: 1, hacking: 1, ...mults },
  money: 0,
});

/** n00dles, foodnstuff and zer0 as BN1 has them; home and a purchased server, the player's own. */
const staticData = (): StaticSnapshotData => ({
  servers: [
    { ...staticServer("home"), purchasedByPlayer: true, moneyMax: 0 },
    staticServer("n00dles", { moneyMax: 1_750_000, minDifficulty: 1, requiredHackingSkill: 1, serverGrowth: 3_000 }),
    staticServer("foodnstuff", { moneyMax: 50_000_000, minDifficulty: 3, requiredHackingSkill: 1, serverGrowth: 5 }),
    staticServer("zer0", { moneyMax: 187_500_000, minDifficulty: 10, requiredHackingSkill: 75, serverGrowth: 25 }),
    { ...staticServer("pserv-0"), purchasedByPlayer: true, moneyMax: 0 },
  ],
});
const target = (hostname: string) => {
  const server = staticData().servers.find((each) => each.hostname === hostname);
  return server as Required<StaticSnapshotData["servers"][number]>;
};

/** The medium snapshot: every server at 16 GB (home 8), rooted as `rooted` says, the player's whole. */
const medium = (
  hacking: number,
  rooted: Record<string, boolean>,
  changes: { mults?: Record<string, number>; cores?: Record<string, number>; ram?: Record<string, unknown> } = {},
): MediumSnapshotData => {
  const data = mediumData(hacking, rooted, { homeRam: 8 });
  return {
    ...data,
    player: fullPlayer(hacking, changes.mults),
    servers: data.servers.map((server) => ({
      ...server,
      cpuCores: changes.cores?.[server.hostname] ?? 1,
      maxRam: (changes.ram?.[server.hostname] ?? server.maxRam) as number,
    })),
  };
};
const perGigabyteSecond = (hostname: string, hacking: number, cores = 1) =>
  hackingIncomePerGigabyteSecond(target(hostname), fullPlayer(hacking) as never, cores);
const batcherPerGigabyteSecond = (hostname: string, hacking: number, cores = 1) =>
  batcherIncomePerGigabyteSecond(target(hostname), fullPlayer(hacking) as never, cores);
/** A 16 GB server's RAM in whole threads (core's `usableRamGb`): 9 of 1.75 GB. */
const USABLE_16 = 15.75;
const known = (ceiling: HackingCeiling) => {
  if (!ceiling.known) throw new Error(`unknown: ${ceiling.reason}`);
  return ceiling;
};

describe("hackingCeiling: the score on the hack loop's hosts' RAM, the bound on all the rooted RAM", () => {
  test("the hosts are the loop's, the targets the game's rooted servers, the bound every rooted server's RAM", () => {
    const ceiling = known(
      hackingCeiling(
        staticData(),
        medium(50, { home: true, n00dles: true, foodnstuff: true, zer0: true, "pserv-0": true }),
      ),
    );
    // n00dles, foodnstuff and zer0 are hosts (16 GB each); home (8 GB) and pserv-0 are the player's. zer0 needs 75.
    expect(ceiling).toMatchObject({ hostCount: 3, hostRamGb: 48, rootedCount: 5, rootedRamGb: 72 });
    const [n00dles, foodnstuff] = [batcherPerGigabyteSecond("n00dles", 50), batcherPerGigabyteSecond("foodnstuff", 50)];
    expect(ceiling.target).toBe(n00dles > foodnstuff ? "n00dles" : "foodnstuff");
    expect(ceiling.batcherIncomePerSecond).toBeCloseTo(3 * USABLE_16 * Math.max(n00dles, foodnstuff), 9);
    const best = Math.max(perGigabyteSecond("n00dles", 50), perGigabyteSecond("foodnstuff", 50));
    expect(ceiling.incomePerSecond).toBeCloseTo(3 * USABLE_16 * best, 9);
    // Home's 8 GB holds 4 threads: 7 GB.
    expect(ceiling.boundIncomePerSecond).toBeCloseTo((7 + 4 * USABLE_16) * best, 9);
    // At hacking 150 zer0 counts, and beats both.
    const at150 = known(hackingCeiling(staticData(), medium(150, { n00dles: true, foodnstuff: true, zer0: true })));
    // A batcher still does best on n00dles there (a chance of 99% against zer0's 64%); any hacker on zer0.
    expect(at150.target).toBe("n00dles");
    expect(batcherPerGigabyteSecond("n00dles", 150)).toBeGreaterThan(batcherPerGigabyteSecond("zer0", 150));
    expect(at150.batcherIncomePerSecond).toBeCloseTo(3 * USABLE_16 * batcherPerGigabyteSecond("n00dles", 150), 9);
    expect(perGigabyteSecond("zer0", 150)).toBeGreaterThan(perGigabyteSecond("n00dles", 150));
    expect(at150.incomePerSecond).toBeCloseTo(3 * USABLE_16 * perGigabyteSecond("zer0", 150), 9);
    // Each host's own RAM, as the medium snapshot has it: 64 GB holds 37 threads, all 64 GB.
    const larger = known(hackingCeiling(staticData(), medium(150, { zer0: true }, { ram: { zer0: 64 } })));
    expect(larger).toMatchObject({ hostCount: 1, hostRamGb: 64 });
    expect(larger.batcherIncomePerSecond).toBeCloseTo(64 * batcherPerGigabyteSecond("zer0", 150), 9);
  });

  test("the player's own servers are never targets, whatever money their snapshot gives them", () => {
    const withMoney: StaticSnapshotData = {
      servers: staticData().servers.map((server) =>
        server.hostname === "home" || server.hostname === "pserv-0" ? { ...server, moneyMax: 1e15 } : server,
      ),
    };
    const ceiling = known(hackingCeiling(withMoney, medium(50, { home: true, n00dles: true, "pserv-0": true })));
    expect(ceiling.target).toBe("n00dles");
  });

  test("a target not rooted doesn't count, nor its RAM", () => {
    const ceiling = known(hackingCeiling(staticData(), medium(150, { n00dles: true, foodnstuff: true, zer0: false })));
    expect(ceiling).toMatchObject({ hostCount: 2, hostRamGb: 32, rootedCount: 3, rootedRamGb: 40 });
    expect(ceiling.target).not.toBe("zer0");
  });

  test("each takes its servers' best cores: the score the hosts', the bound every rooted server's", () => {
    const ceiling = known(
      hackingCeiling(
        staticData(),
        medium(
          150,
          { n00dles: true, foodnstuff: true, zer0: true },
          { cores: { foodnstuff: 4, home: 8 }, ram: { n00dles: "x" } },
        ),
      ),
    );
    // n00dles's RAM isn't a number: no host, and none of the bound's.
    expect(ceiling).toMatchObject({ hostCount: 2, hostRamGb: 32, rootedCount: 3, rootedRamGb: 40 });
    // n00dles is still a target: it's rooted, whatever its RAM.
    const best = (figure: typeof perGigabyteSecond, cores: number) =>
      Math.max(...["n00dles", "foodnstuff", "zer0"].map((hostname) => figure(hostname, 150, cores)));
    expect(ceiling.batcherIncomePerSecond).toBeCloseTo(2 * USABLE_16 * best(batcherPerGigabyteSecond, 4), 9);
    expect(ceiling.incomePerSecond).toBeCloseTo(2 * USABLE_16 * best(perGigabyteSecond, 4), 9);
    expect(ceiling.boundIncomePerSecond).toBeCloseTo((7 + 2 * USABLE_16) * best(perGigabyteSecond, 8), 9);
    expect(best(perGigabyteSecond, 8)).toBeGreaterThan(best(perGigabyteSecond, 4));
  });

  test("the player's multipliers count", () => {
    const base = known(hackingCeiling(staticData(), medium(150, { zer0: true })));
    const faster = known(hackingCeiling(staticData(), medium(150, { zer0: true }, { mults: { hacking_speed: 2 } })));
    expect(faster.batcherIncomePerSecond).toBeGreaterThan(base.batcherIncomePerSecond);
    expect(faster.boundIncomePerSecond).toBeGreaterThan(base.boundIncomePerSecond);
  });

  test("nothing hackable rooted is a ceiling of 0, with no target", () => {
    const ceiling = known(hackingCeiling(staticData(), medium(50, { n00dles: false, zer0: true })));
    expect(ceiling).toEqual({
      known: true,
      batcherIncomePerSecond: 0,
      target: null,
      incomePerSecond: 0,
      hostCount: 1,
      hostRamGb: 16,
      boundIncomePerSecond: 0,
      rootedCount: 2,
      rootedRamGb: 24,
    });
    expect(describeCeiling(ceiling)).toBe("$0/s: nothing the player can hack is rooted (16 GB on 1 server)");
  });

  test("described: the batcher's, any hacker's, and the bound on all the rooted RAM", () => {
    const ceiling = known(hackingCeiling(staticData(), medium(150, { zer0: true })));
    const perSecond = (value: number) => `$${Math.round(value).toLocaleString("en-US")}/s`;
    expect(describeCeiling(ceiling)).toBe(
      `${perSecond(ceiling.batcherIncomePerSecond)} for a batcher on zer0 (${perSecond(ceiling.incomePerSecond)} for ` +
        `any hacker), with 16 GB on 1 server; on all 24 GB rooted (2 servers), ${perSecond(ceiling.boundIncomePerSecond)}`,
    );
  });

  test("unknown without both snapshots, or the player's skills and multipliers", () => {
    const rooted = { n00dles: true };
    expect(hackingCeiling(null, medium(50, rooted))).toEqual({ known: false, reason: "no static snapshot" });
    expect(hackingCeiling(staticData(), undefined)).toEqual({ known: false, reason: "no medium snapshot" });
    // The fixtures' player has no intelligence or multipliers.
    expect(hackingCeiling(staticData(), mediumData(50, rooted))).toEqual({
      known: false,
      reason: "the medium snapshot's player has no skills.intelligence",
    });
    const noGrow = medium(50, rooted);
    delete (noGrow.player.mults as Record<string, unknown>).hacking_grow;
    expect(hackingCeiling(staticData(), noGrow)).toEqual({
      known: false,
      reason: "the medium snapshot's player has no mults.hacking_grow",
    });
    expect(describeCeiling(hackingCeiling(null, null))).toBe("unknown: no static snapshot");
    expect(describeCeiling(null)).toBe("unknown: no medium snapshot");
  });
});

/** A slow snapshot with hacking's money since the install, and the install's time. */
const slowWith = (hacking: unknown, lastAugReset = 0): SlowSnapshotData => {
  const slow = slowData();
  return { ...slow, resetInfo: { ...slow.resetInfo, lastAugReset }, moneySources: { hacking } as never };
};
const point = (atMs: number, hacking: number, lastAugReset: number | null = 0): HackingMoneyPoint => ({
  atMs,
  hacking,
  lastAugReset,
});

describe("what hacking earned: the slow snapshot's moneySources.hacking", () => {
  test("read with the install it counts from; none without the money sources", () => {
    expect(hackingMoneyOf(slowWith(1_500, 77))).toEqual({ hacking: 1_500, lastAugReset: 77 });
    expect(hackingMoneyOf(slowData())).toBeNull();
    expect(hackingMoneyOf(slowWith("lots"))).toBeNull();
    const noReset = { ...slowWith(1_500), resetInfo: {} } as unknown as SlowSnapshotData;
    expect(hackingMoneyOf(noReset)).toEqual({ hacking: 1_500, lastAugReset: null });
  });

  test("its rise; after an install, the count since; a fall with no install (a relaunch's older save) is none", () => {
    expect(hackingEarnedBetween(point(0, 1_000), point(MINUTE, 4_000))).toBe(3_000);
    expect(hackingEarnedBetween(point(0, 4_000), point(MINUTE, 4_000))).toBe(0);
    // A relaunch loads the save's older count: $500m since the install isn't earned in a minute.
    expect(hackingEarnedBetween(point(0, 500e6), point(MINUTE, 420e6))).toBe(0);
    // An install resets it: what it says is what was earned since, fallen or not.
    expect(hackingEarnedBetween(point(0, 9_000, 0), point(MINUTE, 500, 30_000))).toBe(500);
    expect(hackingEarnedBetween(point(0, 100, 0), point(MINUTE, 700, 30_000))).toBe(700);
    // Without the install's time, a fall is none.
    expect(hackingEarnedBetween(point(0, 9_000, null), point(MINUTE, 500, 30_000))).toBe(0);
    expect(hackingIncomePerSecond([point(0, 1_000), point(MINUTE, 7_000), point(2 * MINUTE, 6_000)])).toBe(6_000 / 120);
    expect(hackingIncomePerSecond([point(0, 1_000), point(MINUTE, 7_000), point(2 * MINUTE, 600, 1)])).toBe(
      6_600 / 120,
    );
    expect(hackingIncomePerSecond([point(0, 1_000)])).toBeNull();
  });
});

/**
 * A fold over a run, fed as the run report feeds it: the static snapshot, a slow snapshot every 60 s, then a medium
 * every 10 s, for `runMs`.
 */
function foldOf({
  runMs,
  mediumAt,
  hackingAt,
  lastAugResetAt = () => 0,
}: {
  runMs: number;
  mediumAt: (offsetMs: number) => MediumSnapshotData;
  hackingAt: (offsetMs: number) => number | undefined;
  lastAugResetAt?: (offsetMs: number) => number;
}): HackingFold {
  const fold = new HackingFold(new Set(["home"]));
  fold.addStatic(0, staticData());
  for (let offsetMs = 0; offsetMs <= runMs; offsetMs += MINUTE) {
    const hacking = hackingAt(offsetMs);
    fold.addSlow(offsetMs, hacking === undefined ? slowData() : slowWith(hacking, lastAugResetAt(offsetMs)));
  }
  for (let offsetMs = 0; offsetMs <= runMs; offsetMs += 10 * SECOND) fold.addMedium(offsetMs, mediumAt(offsetMs));
  return fold;
}

describe("the run report's section (#196)", () => {
  const small = medium(150, { zer0: true });
  const large = medium(150, { zer0: true }, { ram: { zer0: 64 } });
  const ceilingsOf = (data: MediumSnapshotData) => known(hackingCeiling(staticData(), data));
  const perSecond = (value: number) => `$${Math.round(value).toLocaleString("en-US")}/s`;
  const atIso = (offsetMs: number) => new Date(offsetMs).toISOString();
  /** zer0's money set at each medium snapshot. */
  const withZer0Money = (money: (offsetMs: number) => number) => (offsetMs: number) => ({
    ...small,
    servers: small.servers.map((server) =>
      server.hostname === "zer0" ? { ...server, moneyAvailable: money(offsetMs) } : server,
    ),
  });

  test("the ceilings step at each medium snapshot: their $ over each interval between slow snapshots", () => {
    // 16 GB until 30 s, then 64 GB.
    const fold = foldOf({
      runMs: MINUTE,
      mediumAt: (offsetMs) => (offsetMs < 30 * SECOND ? small : large),
      hackingAt: (offsetMs) => offsetMs,
    });
    const [interval] = fold.judgedIntervals();
    const [before, after] = [ceilingsOf(small), ceilingsOf(large)];
    expect(interval?.batcher).toBeCloseTo(30 * before.batcherIncomePerSecond + 30 * after.batcherIncomePerSecond, 6);
    expect(interval?.ceiling).toBeCloseTo(30 * before.incomePerSecond + 30 * after.incomePerSecond, 6);
    expect(interval?.bound).toBeCloseTo(30 * before.boundIncomePerSecond + 30 * after.boundIncomePerSecond, 6);
    expect(interval?.earned).toBe(MINUTE);
  });

  test("the best 10 minutes against the batcher ceiling, the window and each hour against both, the ceilings now", () => {
    const runMs = 90 * MINUTE;
    const { batcherIncomePerSecond: batcher, incomePerSecond: ceiling } = ceilingsOf(small);
    // A quarter of the batcher ceiling, every second.
    const quarter = batcher / 4;
    const fold = foldOf({ runMs, mediumAt: () => small, hackingAt: (offsetMs) => (offsetMs / 1000) * quarter });
    const failures: string[] = [];
    const lines = fold.section(failures);
    expect(failures).toEqual([]);
    const ofCeiling = `${((quarter / ceiling) * 100).toFixed(1)}%`;
    const against = (fromMs: number, toMs: number, hours: string) =>
      `${perSecond(quarter)}: 25.0% of the batcher ceiling (${perSecond(batcher)}), ${ofCeiling} of the ceiling ` +
      `(${perSecond(ceiling)}), from ${atIso(fromMs)} to ${atIso(toMs)} (${hours} h)`;
    expect(lines).toEqual([
      expect.stringMatching(/^5\. Hacking /),
      `  the ceilings now: ${describeCeiling(ceilingsOf(small))}`,
      `  the best 10 minutes: 25.0% of the batcher ceiling (${perSecond(quarter)} against ${perSecond(batcher)}), ` +
        `from ${atIso(0)} to ${atIso(10 * MINUTE)}`,
      `  over the window: ${against(0, runMs, "1.5")}`,
      "  each hour:",
      `    ${against(0, HACKING_STRETCH_MS, "1.0")}`,
      `    ${against(HACKING_STRETCH_MS, runMs, "0.5")}`,
    ]);
  });

  test("the best 10 minutes is the best stretch: earning twice as fast from 30 to 40 minutes", () => {
    const { batcherIncomePerSecond: batcher } = ceilingsOf(small);
    const rate = (offsetMs: number) => (offsetMs > 30 * MINUTE && offsetMs <= 40 * MINUTE ? 0.4 : 0.2) * batcher;
    let earned = 0;
    const counts = new Map<number, number>();
    for (let offsetMs = 0; offsetMs <= 60 * MINUTE; offsetMs += MINUTE) {
      earned += offsetMs === 0 ? 0 : rate(offsetMs) * 60;
      counts.set(offsetMs, earned);
    }
    const fold = foldOf({ runMs: 60 * MINUTE, mediumAt: () => small, hackingAt: (offsetMs) => counts.get(offsetMs) });
    expect(fold.totals().best).toMatchObject({ fromMs: 30 * MINUTE, toMs: 40 * MINUTE, judgedMs: 10 * MINUTE });
    expect(fold.section([])[2]).toMatch(/^ {2}the best 10 minutes: 40\.0% of the batcher ceiling /);
    // Under 10 minutes judged, there's no best yet.
    const short = foldOf({ runMs: 9 * MINUTE, mediumAt: () => small, hackingAt: (offsetMs) => offsetMs });
    expect(short.totals().best).toBeNull();
    expect(short.section([])[2]).toBe("  the best 10 minutes: none yet (under 10 minutes judged)");
  });

  test("above the bound on all the rooted RAM, beyond what the game's servers' money fell by, is a failure", () => {
    const twice = ceilingsOf(small).boundIncomePerSecond * 2;
    const fold = foldOf({
      runMs: 10 * MINUTE,
      mediumAt: () => small,
      hackingAt: (offsetMs) => (offsetMs / 1000) * twice,
    });
    const failures: string[] = [];
    const lines = fold.section(failures);
    expect(failures).toEqual([
      expect.stringMatching(/^hacking income above what all the rooted RAM could earn: \$[\d,]+ earned from /),
    ]);
    expect(failures[0]).toContain("the ceiling's formula or the measure is wrong");
    expect(lines).toContain(`  ${failures[0]}`);
    // Between the batcher ceiling and the bound is no failure: the owner's own scripts, say, on home's RAM.
    const between = foldOf({
      runMs: 10 * MINUTE,
      mediumAt: () => small,
      hackingAt: (offsetMs) => (offsetMs / 1000) * ceilingsOf(small).boundIncomePerSecond * 0.99,
    });
    const betweenFailures: string[] = [];
    between.section(betweenFailures);
    expect(betweenFailures).toEqual([]);
  });

  test("money the servers held at the start, hacked and not grown back, is allowed for; never the player's own", () => {
    const dollars = 10 * 60 * ceilingsOf(small).boundIncomePerSecond;
    // zer0 falls by twice what the bound allows in the 10 minutes; hacking earns 1.5 times it.
    const fold = foldOf({
      runMs: 10 * MINUTE,
      mediumAt: withZer0Money((offsetMs) => 2 * dollars * (1 - offsetMs / (10 * MINUTE))),
      hackingAt: (offsetMs) => (offsetMs / (10 * MINUTE)) * 1.5 * dollars,
    });
    expect(fold.serversMoneyFell()).toBeCloseTo(2 * dollars, 3);
    const failures: string[] = [];
    fold.section(failures);
    expect(failures).toEqual([]);
    // Home's money falls too here, and counts for nothing.
    const homeFalls = (offsetMs: number) => ({
      ...small,
      servers: small.servers.map((server) =>
        server.hostname === "home" ? { ...server, moneyAvailable: 1e12 - offsetMs * 1e6 } : server,
      ),
    });
    const ownFold = foldOf({
      runMs: 10 * MINUTE,
      mediumAt: homeFalls,
      hackingAt: (offsetMs) => (offsetMs / 1000) * 2 * ceilingsOf(small).boundIncomePerSecond,
    });
    const ownFailures: string[] = [];
    ownFold.section(ownFailures);
    expect(ownFold.serversMoneyFell()).toBe(0);
    expect(ownFailures).toHaveLength(1);
  });

  test("a server whose money rose takes nothing off another's fall", () => {
    const fold = foldOf({
      runMs: 10 * MINUTE,
      mediumAt: (offsetMs) => ({
        ...small,
        servers: small.servers.map((server) =>
          server.hostname === "zer0"
            ? { ...server, moneyAvailable: 1_000 - offsetMs / 1_000 }
            : { ...server, moneyAvailable: offsetMs },
        ),
      }),
      hackingAt: (offsetMs) => offsetMs,
    });
    // zer0 fell by 600; home rose, and is the player's anyway; nothing else moved.
    expect(fold.serversMoneyFell()).toBe(600);
  });

  test("a relaunch: hacking's count falls with no install; that interval earns none, and money falls on each side", () => {
    // The count rises $1,000 a minute; at 6 minutes the game relaunches from a save 3 minutes old.
    const count = (offsetMs: number) => (offsetMs < 6 * MINUTE ? offsetMs : offsetMs - 3 * MINUTE) / 60;
    // zer0's money falls $100 a minute, and the older save puts back $300.
    const zer0Money = (offsetMs: number) => 10_000 - count(offsetMs) / 10;
    const fold = foldOf({ runMs: 10 * MINUTE, mediumAt: withZer0Money(zer0Money), hackingAt: count });
    const earned = fold.judgedIntervals().map((interval) => interval.earned);
    expect(earned).toEqual([1_000, 1_000, 1_000, 1_000, 1_000, 0, 1_000, 1_000, 1_000, 1_000]);
    // Each side's fall, the mediums from 5 minutes 10 s to 6 minutes (either side) left out: 0 to 5 minutes, $500;
    // 6 minutes 10 s to 10 minutes, $383.33. Across the relaunch, zer0's money rose: no fall, though there was one.
    expect(fold.serversMoneyFell()).toBeCloseTo(500 + 3_833.33 / 10, 2);
  });

  test("an install: lastAugReset changes, and what the count says is what was earned since", () => {
    const fold = foldOf({
      runMs: 4 * MINUTE,
      mediumAt: () => small,
      hackingAt: (offsetMs) => (offsetMs < 2 * MINUTE ? 1e9 + offsetMs : offsetMs - 2 * MINUTE + 5),
      lastAugResetAt: (offsetMs) => (offsetMs < 2 * MINUTE ? 0 : 100_000),
    });
    expect(fold.judgedIntervals().map((interval) => interval.earned)).toEqual([MINUTE, 5, MINUTE, MINUTE]);
  });

  test("the slow snapshots come before the medium ones, or it fails loudly", () => {
    const fold = new HackingFold(new Set(["home"]));
    fold.addMedium(0, small);
    expect(() => fold.addSlow(0, slowWith(1))).toThrow(/slow snapshots must come before the medium ones/);
  });

  test("where the ceilings are unknown, nothing is judged; without the money sources, it says why", () => {
    const unknownPlayer = mediumData(150, { zer0: true });
    const partly = foldOf({
      runMs: 10 * MINUTE,
      mediumAt: (offsetMs) => (offsetMs < 4 * MINUTE ? unknownPlayer : small),
      hackingAt: (offsetMs) => offsetMs * 1e9,
    });
    // The first four minutes' intervals aren't judged, however much hacking earned in them.
    expect(partly.judgedIntervals()).toHaveLength(6);
    expect(partly.section([])).toContain("    not judged: 0.1 h with the ceilings unknown");

    const never = foldOf({ runMs: 10 * MINUTE, mediumAt: () => unknownPlayer, hackingAt: (offsetMs) => offsetMs });
    const failures: string[] = [];
    expect(never.section(failures)).toEqual([
      expect.stringMatching(/^5\. Hacking /),
      "  the ceilings now: unknown: the medium snapshot's player has no skills.intelligence",
      "  against the ceilings: not judged, the ceilings were unknown throughout",
    ]);
    const older = foldOf({ runMs: 10 * MINUTE, mediumAt: () => small, hackingAt: () => undefined });
    expect(older.section(failures).at(-1)).toBe(
      "  actual: unknown: the slow snapshots carry no money sources (an Agent from before #196)",
    );
    const one = foldOf({ runMs: 30 * SECOND, mediumAt: () => small, hackingAt: () => 5 });
    expect(one.section(failures).at(-1)).toBe("  actual: unknown: fewer than two slow snapshots in the window");
    expect(failures).toEqual([]);
  });

  test("no time judged: n/a, not NaN or Infinity", () => {
    const fold = new HackingFold(new Set(["home"]));
    fold.addStatic(0, staticData());
    fold.addSlow(0, slowWith(0));
    fold.addSlow(0, slowWith(5));
    fold.addMedium(0, small);
    const lines = fold.section([]).join("\n");
    expect(lines).toContain("  over the window: n/a: ");
    expect(lines).not.toMatch(/NaN|Infinity/);
  });

  test("a medium snapshot before any static uses the first static; one after a later static, that one", () => {
    const fold = new HackingFold(new Set(["home"]));
    const richer: StaticSnapshotData = {
      servers: staticData().servers.map((server) =>
        server.hostname === "zer0" ? { ...server, moneyMax: 2 * (server.moneyMax as number) } : server,
      ),
    };
    fold.addStatic(10 * SECOND, staticData());
    fold.addStatic(MINUTE, richer);
    fold.addMedium(0, small);
    expect(fold.latestCeiling).toEqual(hackingCeiling(staticData(), small));
    fold.addMedium(MINUTE, small);
    expect(fold.latestCeiling).toEqual(hackingCeiling(richer, small));
  });
});
