// Sharing spare RAM for faction reputation (#224): the game's share bonus worked by hand, the constants checked against
// the pinned game's source, where a round of share threads goes, the reserve, and the rate with the bonus. The brain's
// faction-work-parity.test.ts checks the bonus and the rate against the engine's own while share threads run.
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { SINGULARITY_LARGEST_WORKER_GB, singularityRamMultiplier, singularityWorkerRamGb } from "../src/backends.ts";
import { BATCH_RAM_RELEASE_MS, parseBatcherConfig } from "../src/batcher.ts";
import { factionReputationPerCycle, factionReputationPerSecond, type WorkingPerson } from "../src/faction-work.ts";
import {
  effectiveShareThreads,
  type HostRamUse,
  SHARE_MOST_USE,
  SHARE_RAM_GB,
  SHARE_RESERVE_MARGIN,
  SHARE_ROUND_MS,
  SHARE_TIME_MS,
  shareBonus,
  shareBonusOfPower,
  shareRamByHost,
  shareRamHolds,
  shareReleasedAt,
  shareReserveGb,
  shareRound,
  shareRoundThreads,
} from "../src/share.ts";

const source = (file: string) =>
  readFileSync(new URL(`../../../vendor/bitburner-src/src/${file}`, import.meta.url), "utf8");

test("the constants are the pinned game's and legacy's: 10 s a call, 2.4 GB for share, every 5 s, at most 80%", () => {
  const share = source("NetworkShare/Share.ts");
  expect(share).toContain(`export const ShareBonusTime = ${SHARE_TIME_MS};`);
  expect(share).toContain("const bonus = 1 + Math.log(shareThreads) / 25;");
  expect(share).toContain("return threads * calculateIntelligenceBonus(Player.skills.intelligence, 2) * coreBonus;");
  expect(source("Netscript/RamCostGenerator.ts")).toContain("  share: 2.4,");
  // 1.6 GB base (RamCostConstants.Base) + share's 2.4.
  expect(SHARE_RAM_GB).toBe(1.6 + 2.4);
  expect(SHARE_ROUND_MS).toBe(5_000);
  expect(SHARE_MOST_USE).toBe(0.8);
});

test("Singularity workers' RAM (#242's review): the largest is ram-budget.json's destroy, times the SF4 multiplier", () => {
  const budget = JSON.parse(readFileSync(new URL("../../ingame/ram-budget.json", import.meta.url), "utf8")) as Record<
    string,
    number
  >;
  const singularity = Object.entries(budget).filter(([name]) => name.startsWith("singularity-"));
  expect(singularity.length).toBeGreaterThan(10);
  expect(Math.max(...singularity.map(([, gb]) => gb))).toBe(SINGULARITY_LARGEST_WORKER_GB);
  // SF4Cost (Netscript/RamCostGenerator.ts:82-95): 1 in BN4 or at SF4.3, 4 at SF4.2, 16 at SF4.1.
  expect(source("Netscript/RamCostGenerator.ts")).toContain("if (sf4 <= 1) {\n      return cost * 16;");
  expect(singularityRamMultiplier(4, 0)).toBe(1);
  expect(singularityRamMultiplier(1, 3)).toBe(1);
  expect(singularityRamMultiplier(1, 2)).toBe(4);
  expect(singularityRamMultiplier(1, 1)).toBe(16);
  expect(singularityWorkerRamGb(33.9, 1)).toBeCloseTo(33.9, 9);
  expect(singularityWorkerRamGb(33.9, 16)).toBeCloseTo(1.6 + 16 * 32.3, 9);
});

test("a host's effective share threads: threads × the intelligence bonus at weight 2 × its core bonus", () => {
  expect(effectiveShareThreads(100, 1, 0)).toBe(100);
  // Intelligence 90: 1 + 2 × 90^0.8 / 600.
  expect(effectiveShareThreads(100, 1, 90)).toBeCloseTo(100 * (1 + (2 * 90 ** 0.8) / 600), 12);
  // 5 cores: 1 + 4/16.
  expect(effectiveShareThreads(100, 5, 0)).toBeCloseTo(125, 12);
  expect(effectiveShareThreads(100, 5, 90)).toBeCloseTo(125 * (1 + (2 * 90 ** 0.8) / 600), 12);
});

test("the bonus: 1 + ln(1 + the effective threads)/25, 1 with none, and 1 where the logarithm isn't finite", () => {
  expect(shareBonus([], 0)).toBe(1);
  expect(shareBonus([{ threads: 1_000, cores: 1 }], 0)).toBeCloseTo(1 + Math.log(1_001) / 25, 14);
  // The issue's figure: the first overnight run's 26 PB at 4 GB a thread, about 6.5m threads, gives about 1.63.
  expect(shareBonus([{ threads: 6_500_000, cores: 1 }], 0)).toBeCloseTo(1.63, 2);
  // Parts add up, each at its host's cores.
  expect(
    shareBonus(
      [
        { threads: 300, cores: 1 },
        { threads: 80, cores: 5 },
      ],
      0,
    ),
  ).toBeCloseTo(1 + Math.log(1 + 300 + 100) / 25, 14);
  expect(shareBonus([{ threads: 300, cores: 3 }], 50)).toBeCloseTo(
    1 + Math.log(1 + 300 * (1 + (2 * 50 ** 0.8) / 600) * (1 + 2 / 16)) / 25,
    14,
  );
  expect(shareBonusOfPower(0)).toBe(1);
  expect(shareBonusOfPower(Number.NaN)).toBe(1);
  expect(shareBonusOfPower(Math.E ** 25)).toBeCloseTo(2, 12);
});

/** A host: its RAM and what's used of it, GB. */
const host = (name: string, maxGb: number, usedGb = 0): HostRamUse => ({ host: name, maxGb, usedGb });

test("a round takes the free RAM less the reserve, the hosts with the least free first, whole threads each", () => {
  const hosts = [host("big", 1_024, 24), host("small", 64, 4), host("mid", 256, 0)];
  // Free: 1000 + 60 + 256 = 1316. Used: 28; at most 80% of 1344 = 1075.2 in use. The reserve leaves 1016.
  const round = shareRound(hosts, 300, 8);
  expect(round.roomGb).toBe(1_016);
  // 254 threads: small's 15, mid's 64, then big's 175.
  expect(round.placed).toEqual([
    { host: "small", threads: 15 },
    { host: "mid", threads: 64 },
    { host: "big", threads: 175 },
  ]);
  expect(round.placed.reduce((sum, part) => sum + part.threads, 0) * SHARE_RAM_GB).toBeLessThanOrEqual(1_016);
});

test("a round never takes the hosts' use past 80% of their RAM, nor home's kept RAM", () => {
  // Free 900 of 1000, no reserve: the cap, 800 - 100 = 700, binds.
  const capped = shareRound([host("a", 1_000, 100)], 0, 8);
  expect(capped.roomGb).toBeCloseTo(700, 9);
  expect(capped.placed).toEqual([{ host: "a", threads: 175 }]);
  // Already at 80%: nothing.
  expect(shareRound([host("a", 1_000, 800)], 0, 8)).toEqual({ placed: [], roomGb: 0 });
  // Home keeps its RAM for the Agent: 1000 - 500 kept = 500, 125 threads, under the cap's 800.
  expect(shareRound([host("home", 1_000, 0)], 0, 500)).toEqual({
    placed: [{ host: "home", threads: 125 }],
    roomGb: 500,
  });
  // Any other host keeps nothing back: the cap binds.
  expect(shareRound([host("pserv-0", 1_000, 0)], 0, 500).placed).toEqual([{ host: "pserv-0", threads: 200 }]);
  // Home's kept RAM counts against the room as well as its place.
  expect(shareRound([host("home", 1_000, 0), host("a", 1_000, 0)], 1_000, 500).placed).toEqual([
    { host: "home", threads: 125 },
  ]);
});

test("home beside the batches' hosts (#224's review): its free RAM above what it keeps, outside the reserve, first", () => {
  const home = { ...host("home", 1_024, 4), batches: false };
  // The reserve takes all the batches' hosts' free RAM: only home's, above its 8 GB, is shared.
  expect(shareRound([home, host("pserv-0", 1_024, 24)], 1_000, 8)).toEqual({
    placed: [{ host: "home", threads: 253 }],
    roomGb: 1_012,
  });
  // With room on both, home first, then the batches' hosts, never more there than their room (4,096 - 3,996 = 100 GB).
  expect(shareRound([host("pserv-0", 4_096, 0), home], 3_996, 8).placed).toEqual([
    { host: "home", threads: 253 },
    { host: "pserv-0", threads: 25 },
  ]);
  // Home's fragment (2 GB) makes no room on the batches' hosts: 102 GB there is 25 threads, not 26.
  expect(shareRound([{ ...home, usedGb: 1_014 }, host("pserv-0", 4_096, 0)], 3_994, 8).placed).toEqual([
    { host: "pserv-0", threads: 25 },
  ]);
  // Home first, though a batches' host has less free; then the batches' host to 80% of its own RAM, 51.2 GB.
  expect(shareRound([host("pserv-0", 64, 0), home], 0, 8)).toEqual({
    placed: [
      { host: "home", threads: 253 },
      { host: "pserv-0", threads: 12 },
    ],
    roomGb: 1_012 + 51.2,
  });
  // The 80% cap counts the batches' hosts alone (#242): theirs full, home's 316 GB above its 8 kept still shares.
  expect(shareRound([{ ...home, usedGb: 700 }, host("pserv-0", 1_024, 1_024)], 0, 8)).toEqual({
    placed: [{ host: "home", threads: 79 }],
    roomGb: 316,
  });
});

test("run #3's 12:22 (#242): the batches on 97% of the cloud servers, home large and empty, home shares all it can", () => {
  // The simulator's rebuild of it: 25 cloud servers of 64 TB, 1,594,284 GB used of them; home 64 TB, 8.45 GB used.
  // Counted over all the hosts, 0.8 x 1,703,936 - 1,594,292 is under 0: no room at all, and home sat idle.
  const cloud = Array.from({ length: 25 }, (_, index) => host(`pserv-${index}`, 65_536, 1_594_284 / 25));
  const home = { ...host("home", 65_536, 8.45), batches: false };
  const round = shareRound([...cloud, home], 50_000, 32);
  expect(round.roomGb).toBeCloseTo(65_536 - 8.45 - 32, 9);
  expect(round.placed).toEqual([{ host: "home", threads: 16_373 }]);
});

test("a round takes at most `mostThreads` (#242): home first, then the batches' hosts with the least free", () => {
  const home = { ...host("home", 108, 0), batches: false };
  const hosts = [host("big", 1_024, 0), host("small", 64, 0), home];
  // Room: home's 100 (8 kept) and 80% of the hosts' 1,088, 870.4: the room is all of it, the threads only 30.
  const round = shareRound(hosts, 0, 8, 30);
  expect(round.placed).toEqual([
    { host: "home", threads: 25 },
    { host: "small", threads: 5 },
  ]);
  expect(round.roomGb).toBeCloseTo(970.4, 9);
  expect(shareRound(hosts, 0, 8, 0).placed).toEqual([]);
  // More than the room: the room's.
  expect(shareRound(hosts, 0, 8, 1_000).placed.reduce((sum, part) => sum + part.threads, 0)).toBe(25 + 16 + 201);
});

test("a round starts half of what the share may hold, so two halves overlap (#242), never more than the room", () => {
  // Nothing held: half the room, rounded up.
  expect(shareRoundThreads(0, 1_000)).toBe(500);
  expect(shareRoundThreads(0, 7)).toBe(4);
  expect(shareRoundThreads(0, 1)).toBe(1);
  // Half held, the other half's RAM back: that half.
  expect(shareRoundThreads(500, 500)).toBe(500);
  // The old half not yet released: no room, nothing.
  expect(shareRoundThreads(1_000, 0)).toBe(0);
  // Half held, and more room since: half the whole.
  expect(shareRoundThreads(500, 1_500)).toBe(1_000);
  // Less room than half: the room.
  expect(shareRoundThreads(900, 100)).toBe(100);
  // Odd figures, whole threads.
  expect(shareRoundThreads(-3, 10.9)).toBe(5);
  // A half ending (#242's review): none, though another host has room; its RAM comes back a moment later.
  expect(shareRoundThreads(500, 300, true)).toBe(0);
  expect(shareRoundThreads(500, 300, false)).toBe(300);
  // Two halves a round apart, each running a call's time: a round's every `SHARE_ROUND_MS`, half a call's 10 s.
  expect(2 * SHARE_ROUND_MS).toBe(SHARE_TIME_MS);
});

test("a round places nothing where the room holds no thread: the reserve takes it all", () => {
  expect(shareRound([host("a", 64, 0)], 64, 0)).toEqual({ placed: [], roomGb: 0 });
  expect(shareRound([host("a", 64, 0)], 61, 0)).toEqual({ placed: [], roomGb: 3 });
  expect(shareRound([host("a", 64, 0)], 60, 0).placed).toEqual([{ host: "a", threads: 1 }]);
  expect(shareRound([], 0, 0)).toEqual({ placed: [], roomGb: 0 });
});

test("the reserve: the batches' peak with the margin, the next target's RAM, up to a whole GB", () => {
  expect(SHARE_RESERVE_MARGIN).toBe(0.25);
  expect(shareReserveGb(100, 0)).toBe(125);
  expect(shareReserveGb(100, 40)).toBe(165);
  expect(shareReserveGb(10.1, 0)).toBe(13);
  expect(shareReserveGb(0, 0)).toBe(0);
});

/** One with every figure the formulas read moved. */
const MOVED: WorkingPerson = {
  skills: { hacking: 300, strength: 40, defense: 50, dexterity: 60, agility: 70, charisma: 80, intelligence: 90 },
  mults: { faction_rep: 1.25 },
};

test("the rate with share: all of hacking work's ×the bonus, only field's and security's hacking and intelligence", () => {
  const bonus = 1.5;
  const at = (workType: "hacking" | "field" | "security", withBonus = 1) =>
    factionReputationPerCycle(MOVED, workType, 25, 0, 1, withBonus);
  expect(at("hacking", bonus)).toBeCloseTo(at("hacking") * bonus, 14);
  const { hacking, strength, defense, dexterity, agility, charisma, intelligence } = MOVED.skills;
  const rest = (0.9 / 975) * 1.25 * 1.25 * (1 + intelligence ** 0.8 / 600);
  expect(at("field", bonus)).toBeCloseTo(
    ((strength + defense + dexterity + agility + charisma + (hacking + intelligence) * bonus) / 5.5) * rest,
    14,
  );
  expect(at("security", bonus)).toBeCloseTo(
    ((strength + defense + dexterity + agility + (hacking + intelligence) * bonus) / 4.5) * rest,
    14,
  );
  // Less than ×the bonus for field and security, which have other terms.
  expect(at("field", bonus)).toBeLessThan(at("field") * bonus);
  expect(at("security", bonus)).toBeGreaterThan(at("security"));
  // SF15.3's charisma bonus is in field's shared term, not security's (reputation.ts:30, :47).
  const sf15 = (workType: "field" | "security", withBonus: number) =>
    factionReputationPerCycle(MOVED, workType, 25, 3, 1, withBonus);
  expect(sf15("field", bonus) - sf15("field", 1)).toBeCloseTo(
    (hacking + intelligence + 0.3 * charisma) * (bonus - 1) * (0.9 / 975 / 5.5) * 1.25 * 1.25 * (1 + 90 ** 0.8 / 600),
    14,
  );
  expect(sf15("security", bonus) - sf15("security", 1)).toBeCloseTo(
    (hacking + intelligence) * (bonus - 1) * (0.9 / 975 / 4.5) * 1.25 * 1.25 * (1 + 90 ** 0.8 / 600),
    14,
  );
  // A second's, likewise; 1 by default, and a bonus that isn't finite throws.
  const options = { favor: 25, sourceFile15Level: 0, focused: true, implant: false, factionWorkRepGain: 1 };
  expect(factionReputationPerSecond(MOVED, "hacking", { ...options, shareBonus: bonus })).toBeCloseTo(
    factionReputationPerSecond(MOVED, "hacking", options) * bonus,
    14,
  );
  expect(() => factionReputationPerCycle(MOVED, "hacking", 25, 0, 1, Number.NaN)).toThrow(/share bonus/);
});

test("the config's sharing (#224): its reserve, home's kept RAM and the cores; absent is none; anything else fails", () => {
  const config = {
    target: "n00dles",
    figures: { moneyMax: 1, minDifficulty: 1, requiredHackingSkill: 1, serverGrowth: 1 },
    player: { intelligence: 0, mults: { hacking_chance: 1, hacking_speed: 1, hacking_money: 1, hacking_grow: 1 } },
    hosts: ["a"],
    hackShare: 0.5,
    spacingMs: 100,
  };
  expect(parseBatcherConfig(config)).toMatchObject({ ok: true });
  expect((parseBatcherConfig(config) as { config: object }).config).not.toHaveProperty("sharing");
  const sharing = { reserveGb: 120, homeKeptGb: 8, cores: { CSEC: 2 } };
  expect(parseBatcherConfig({ ...config, sharing })).toEqual({ ok: true, config: { ...config, sharing } });
  expect(parseBatcherConfig({ ...config, sharing: null })).toEqual({ ok: true, config });
  for (const [odd, reason] of [
    [{ ...sharing, reserveGb: -1 }, "reserveGb of 0 or more"],
    [{ ...sharing, reserveGb: "1" }, "reserveGb of 0 or more"],
    [{ ...sharing, homeKeptGb: Number.NaN }, "homeKeptGb of 0 or more"],
    [{ ...sharing, cores: { CSEC: "2" } }, "cores"],
    [{ reserveGb: 1, homeKeptGb: 8 }, "cores"],
  ] as const) {
    expect(parseBatcherConfig({ ...config, sharing: odd })).toEqual({
      ok: false,
      reason: `the config's sharing has no ${reason}`,
    });
  }
});

test("a share part's RAM (#232's review): the batcher's own until its script ends, its release after its call", () => {
  const parts = [
    { host: "a", threads: 2, endsAt: 10_000 },
    { host: "a", threads: 1, endsAt: 20_000 },
    { host: "home", threads: 5, endsAt: 10_000 },
  ];
  expect(shareReleasedAt({ endsAt: 10_000 })).toBe(10_000 + BATCH_RAM_RELEASE_MS);
  // Its call over, its script not yet ended: still held, as `getServerUsedRam` counts it.
  const justAfter = 10_000 + BATCH_RAM_RELEASE_MS / 2;
  expect(shareRamByHost(parts, justAfter)).toEqual(
    new Map([
      ["a", 3 * SHARE_RAM_GB],
      ["home", 5 * SHARE_RAM_GB],
    ]),
  );
  expect(shareRamHolds(parts, ["a"], justAfter)).toEqual([
    { gb: 2 * SHARE_RAM_GB, fromMs: justAfter, untilMs: 10_000 + BATCH_RAM_RELEASE_MS },
    { gb: SHARE_RAM_GB, fromMs: justAfter, untilMs: 20_000 + BATCH_RAM_RELEASE_MS },
  ]);
  // Released: gone.
  const released = 10_000 + BATCH_RAM_RELEASE_MS;
  expect(shareRamByHost(parts, released)).toEqual(new Map([["a", SHARE_RAM_GB]]));
  expect(shareRamHolds(parts, ["a", "home"], released)).toEqual([
    { gb: SHARE_RAM_GB, fromMs: released, untilMs: 20_000 + BATCH_RAM_RELEASE_MS },
  ]);
});
