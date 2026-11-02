// Sharing spare RAM for faction reputation (#224): the game's share bonus worked by hand, the constants checked against
// the pinned game's source, where a round of share threads goes, the reserve, and the rate with the bonus. The brain's
// faction-work-parity.test.ts checks the bonus and the rate against the engine's own while share threads run.
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { parseBatcherConfig } from "../src/batcher.ts";
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
  shareReserveGb,
  shareRound,
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
  // Home first, though a batches' host has less free.
  expect(shareRound([host("pserv-0", 64, 0), home], 0, 8).placed).toEqual([{ host: "home", threads: 216 }]);
  // The 80% cap counts home's RAM and use too: 0.8 x 2,048 - 1,724 is under 0, though home has 316 GB free.
  expect(shareRound([{ ...home, usedGb: 700 }, host("pserv-0", 1_024, 1_024)], 0, 8).placed).toEqual([]);
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
