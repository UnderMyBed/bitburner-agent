// The hacking ceiling over the snapshots (#196): the targets and the RAM it counts, what hacking earned from the slow
// snapshots, and the run report's section, from snapshot data built here.
import {
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
const known = (ceiling: HackingCeiling) => {
  if (!ceiling.known) throw new Error(`unknown: ${ceiling.reason}`);
  return ceiling;
};

describe("hackingCeiling: the hack loop's hosts' RAM times the best target's income a GB-second", () => {
  test("the hosts are the loop's (the game's rooted servers with RAM), the targets the rooted ones within hacking", () => {
    const ceiling = known(
      hackingCeiling(
        staticData(),
        medium(50, { home: true, n00dles: true, foodnstuff: true, zer0: true, "pserv-0": true }),
      ),
    );
    // n00dles, foodnstuff and zer0 are hosts (16 GB each); home and pserv-0 are the player's. zer0 needs 75.
    expect(ceiling).toMatchObject({ hostCount: 3, hostRamGb: 48 });
    const best = Math.max(perGigabyteSecond("n00dles", 50), perGigabyteSecond("foodnstuff", 50));
    expect(ceiling.target).toBe(best === perGigabyteSecond("n00dles", 50) ? "n00dles" : "foodnstuff");
    expect(ceiling.incomePerSecond).toBeCloseTo(48 * best, 9);
    // At hacking 150 zer0 counts, and beats both.
    const at150 = known(hackingCeiling(staticData(), medium(150, { n00dles: true, foodnstuff: true, zer0: true })));
    expect(at150.target).toBe("zer0");
    expect(at150.incomePerSecond).toBeCloseTo(48 * perGigabyteSecond("zer0", 150), 9);
    // Each host's own RAM, as the medium snapshot has it.
    const larger = known(hackingCeiling(staticData(), medium(150, { zer0: true }, { ram: { zer0: 64 } })));
    expect(larger).toMatchObject({ hostCount: 1, hostRamGb: 64 });
    expect(larger.incomePerSecond).toBeCloseTo(64 * perGigabyteSecond("zer0", 150), 9);
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

  test("a target not rooted doesn't count, though its RAM isn't a host's either", () => {
    const ceiling = known(hackingCeiling(staticData(), medium(150, { n00dles: true, foodnstuff: true, zer0: false })));
    expect(ceiling).toMatchObject({ hostCount: 2, hostRamGb: 32 });
    expect(ceiling.target).not.toBe("zer0");
  });

  test("the hosts' best cores make grow and weaken stronger; RAM that isn't a number counts as none", () => {
    const ceiling = known(
      hackingCeiling(
        staticData(),
        medium(
          150,
          { n00dles: true, foodnstuff: true, zer0: true },
          { cores: { foodnstuff: 4 }, ram: { n00dles: "x" } },
        ),
      ),
    );
    expect(ceiling.hostRamGb).toBe(32);
    expect(ceiling.incomePerSecond).toBeCloseTo(32 * perGigabyteSecond("zer0", 150, 4), 9);
  });

  test("the player's multipliers count", () => {
    const base = known(hackingCeiling(staticData(), medium(150, { zer0: true }))).incomePerSecond;
    const faster = known(hackingCeiling(staticData(), medium(150, { zer0: true }, { mults: { hacking_speed: 2 } })));
    expect(faster.incomePerSecond).toBeGreaterThan(base);
  });

  test("nothing hackable rooted is a ceiling of 0, with no target", () => {
    const ceiling = known(hackingCeiling(staticData(), medium(50, { n00dles: false, zer0: true })));
    expect(ceiling).toEqual({ known: true, incomePerSecond: 0, target: null, hostCount: 1, hostRamGb: 16 });
    expect(describeCeiling(ceiling)).toBe("$0/s: nothing the player can hack is rooted (16 GB on 1 server)");
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
  });
});

describe("what hacking earned: the slow snapshot's moneySources.hacking", () => {
  const slow = (hacking: unknown): SlowSnapshotData => ({ ...slowData(), moneySources: { hacking } as never });

  test("its rises; after a fall (an install's reset) the count since", () => {
    expect(hackingMoneyOf(slow(1_500))).toBe(1_500);
    expect(hackingMoneyOf(slowData())).toBeNull();
    expect(hackingMoneyOf(slow("lots"))).toBeNull();
    expect(hackingEarnedBetween({ atMs: 0, hacking: 1_000 }, { atMs: MINUTE, hacking: 4_000 })).toBe(3_000);
    expect(hackingEarnedBetween({ atMs: 0, hacking: 9_000 }, { atMs: MINUTE, hacking: 500 })).toBe(500);
    expect(
      hackingIncomePerSecond([
        { atMs: 0, hacking: 1_000 },
        { atMs: MINUTE, hacking: 7_000 },
        { atMs: 2 * MINUTE, hacking: 6_000 },
      ]),
    ).toBe(12_000 / 120);
    expect(hackingIncomePerSecond([{ atMs: 0, hacking: 1_000 }])).toBeNull();
  });
});

/** A fold over a run: the static snapshot, a medium every 10 s, a slow every 60 s, for `runMs`. */
function foldOf({
  runMs,
  mediumAt,
  hackingAt,
}: {
  runMs: number;
  mediumAt: (offsetMs: number) => MediumSnapshotData;
  hackingAt: (offsetMs: number) => number | undefined;
}): HackingFold {
  const fold = new HackingFold(new Set(["home"]));
  fold.addStatic(0, staticData());
  for (let offsetMs = 0; offsetMs <= runMs; offsetMs += 10 * SECOND) {
    if (offsetMs % MINUTE === 0) {
      const hacking = hackingAt(offsetMs);
      fold.addSlow(offsetMs, hacking === undefined ? slowData() : { ...slowData(), moneySources: { hacking } });
    }
    fold.addMedium(offsetMs, mediumAt(offsetMs));
  }
  return fold;
}

describe("the run report's section (#196)", () => {
  const small = medium(150, { zer0: true });
  const large = medium(150, { zer0: true }, { ram: { zer0: 64 } });
  const ceilingOf = (data: MediumSnapshotData) => known(hackingCeiling(staticData(), data)).incomePerSecond;

  test("the ceiling steps at each medium snapshot: its $ over each interval between slow snapshots", () => {
    // 16 GB until 30 s, then 64 GB.
    const fold = foldOf({
      runMs: MINUTE,
      mediumAt: (offsetMs) => (offsetMs < 30 * SECOND ? small : large),
      hackingAt: (offsetMs) => offsetMs,
    });
    const [interval] = fold.judgedIntervals();
    expect(interval?.ceiling).toBeCloseTo(30 * ceilingOf(small) + 30 * ceilingOf(large), 6);
    expect(interval?.earned).toBe(MINUTE);
  });

  test("hacking against the ceiling over the window and each hour, as a percentage, and the ceiling now", () => {
    const runMs = 90 * MINUTE;
    // Earning a quarter of the ceiling: its $ a second, a quarter, every second.
    const quarter = ceilingOf(small) / 4;
    const fold = foldOf({ runMs, mediumAt: () => small, hackingAt: (offsetMs) => (offsetMs / 1000) * quarter });
    const failures: string[] = [];
    const lines = fold.section(failures);
    expect(failures).toEqual([]);
    const perSecond = (value: number) => `$${Math.round(value).toLocaleString("en-US")}/s`;
    const atIso = (offsetMs: number) => new Date(offsetMs).toISOString();
    expect(lines).toEqual([
      expect.stringMatching(/^5\. Hacking /),
      `  the ceiling now: ${perSecond(ceilingOf(small))} on zer0, with 16 GB on 1 server`,
      `  ${perSecond(quarter)} against a ceiling of ${perSecond(ceilingOf(small))}: 25.0%, from ${atIso(0)} to ` +
        `${atIso(runMs)} (1.5 h)`,
      "  each hour:",
      `    ${perSecond(quarter)} against a ceiling of ${perSecond(ceilingOf(small))}: 25.0%, from ${atIso(0)} to ` +
        `${atIso(HACKING_STRETCH_MS)} (1.0 h)`,
      `    ${perSecond(quarter)} against a ceiling of ${perSecond(ceilingOf(small))}: 25.0%, from ` +
        `${atIso(HACKING_STRETCH_MS)} to ${atIso(runMs)} (0.5 h)`,
    ]);
  });

  test("above the ceiling, beyond what the game's servers' money fell by, is a failure: the formula is wrong", () => {
    const twice = ceilingOf(small) * 2;
    const fold = foldOf({
      runMs: 10 * MINUTE,
      mediumAt: () => small,
      hackingAt: (offsetMs) => (offsetMs / 1000) * twice,
    });
    const failures: string[] = [];
    const lines = fold.section(failures);
    expect(failures).toEqual([expect.stringMatching(/^hacking income above the ceiling: \$[\d,]+ earned from /)]);
    expect(failures[0]).toContain("the ceiling's formula or the measure is wrong");
    expect(lines).toContain(`  ${failures[0]}`);
    expect(lines.join("\n")).toContain("200.0%");
  });

  test("money the servers held at the start, hacked and not grown back, is allowed for", () => {
    const dollars = 10 * 60 * ceilingOf(small);
    // zer0 falls by twice what the ceiling allows in the 10 minutes; hacking earns 1.5 times it.
    const zer0Money = (offsetMs: number) => 2 * dollars * (1 - offsetMs / (10 * MINUTE));
    const withMoney = (offsetMs: number) => ({
      ...small,
      servers: small.servers.map((server) =>
        server.hostname === "zer0" ? { ...server, moneyAvailable: zer0Money(offsetMs) } : server,
      ),
    });
    const fold = foldOf({
      runMs: 10 * MINUTE,
      mediumAt: withMoney,
      hackingAt: (offsetMs) => (offsetMs / (10 * MINUTE)) * 1.5 * dollars,
    });
    expect(fold.serversMoneyFell()).toBeCloseTo(2 * dollars, 3);
    const failures: string[] = [];
    fold.section(failures);
    expect(failures).toEqual([]);
    // The player's own servers' money isn't counted: home's falls too here, and changes nothing.
    const homeFalls = (offsetMs: number) => ({
      ...small,
      servers: small.servers.map((server) =>
        server.hostname === "home" ? { ...server, moneyAvailable: 1e12 - offsetMs * 1e6 } : server,
      ),
    });
    const ownFold = foldOf({
      runMs: 10 * MINUTE,
      mediumAt: homeFalls,
      hackingAt: (offsetMs) => (offsetMs / 1000) * 2 * ceilingOf(small),
    });
    const ownFailures: string[] = [];
    ownFold.section(ownFailures);
    expect(ownFold.serversMoneyFell()).toBe(0);
    expect(ownFailures).toHaveLength(1);
  });

  test("where the ceiling is unknown, nothing is judged; without the money sources, it says why", () => {
    const unknownPlayer = mediumData(150, { zer0: true });
    const partly = foldOf({
      runMs: 10 * MINUTE,
      mediumAt: (offsetMs) => (offsetMs < 4 * MINUTE ? unknownPlayer : small),
      hackingAt: (offsetMs) => offsetMs * 1e9,
    });
    // The first four minutes' intervals aren't judged, however much hacking earned in them.
    expect(partly.judgedIntervals()).toHaveLength(6);
    const partlyLines = partly.section([]);
    expect(partlyLines).toContain("    not judged: 0.1 h with the ceiling unknown");

    const never = foldOf({ runMs: 10 * MINUTE, mediumAt: () => unknownPlayer, hackingAt: (offsetMs) => offsetMs });
    const failures: string[] = [];
    expect(never.section(failures)).toEqual([
      expect.stringMatching(/^5\. Hacking /),
      "  the ceiling now: unknown: the medium snapshot's player has no skills.intelligence",
      "  against the ceiling: not judged, the ceiling was unknown throughout",
    ]);
    const older = foldOf({ runMs: 10 * MINUTE, mediumAt: () => small, hackingAt: () => undefined });
    expect(older.section(failures).at(-1)).toBe(
      "  actual: unknown: the slow snapshots carry no money sources (an Agent from before #196)",
    );
    const one = foldOf({ runMs: 30 * SECOND, mediumAt: () => small, hackingAt: () => 5 });
    expect(one.section(failures).at(-1)).toBe("  actual: unknown: fewer than two slow snapshots in the window");
    expect(failures).toEqual([]);
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
