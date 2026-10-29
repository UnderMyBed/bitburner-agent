// The brain's side of cloud servers (#194): the game's price, the hack loop's income per GB, the servers, the names,
// and the rule (which purchase, how large, and why none), and the dashboard's switch. The controller that orders it
// against the programs and home RAM is desired-state.test.ts's; the simulator suite is cloud-servers-income.test.ts.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MediumSnapshotData, StaticSnapshotData } from "@bitburner-agent/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  CLOUD_SERVER_INCOME_WINDOW_MS,
  CLOUD_SERVER_LIMIT,
  CLOUD_SERVER_PAYBACK_LIMIT_MS,
  type CloudServerPurchase,
  chooseCloudServerPurchase,
  cloudServerPrice,
  cloudServersOf,
  HackLoopIncome,
  type HackLoopIncomeRate,
  nextCloudServerName,
  readCloudServersEnabled,
} from "../src/cloud-servers.ts";
import { TelemetryStore } from "../src/telemetry-store.ts";
import { mediumData, slowData, staticServer } from "./helpers/snapshot-fixtures.ts";

test("the price is the game's in BN1: $55,000 a GB at every size (ServerPurchases.ts:23-42)", () => {
  expect(cloudServerPrice(8)).toBe(440_000);
  expect(cloudServerPrice(64)).toBe(3_520_000);
  expect(cloudServerPrice(1_024)).toBe(56_320_000);
  expect(cloudServerPrice(2 ** 20)).toBe(57_671_680_000);
});

describe("HackLoopIncome: money's rises over the hosts' RAM × time, across the window", () => {
  /** A medium snapshot with `money`, and one rooted host with `ram` GB (n00dles, 16 GB, unless said). */
  const medium = (money: number, ram = 16) => {
    const data = mediumData(1, { home: true, n00dles: true }, { money });
    for (const server of data.servers) if (server.hostname === "n00dles") server.maxRam = ram;
    return data;
  };
  const MINUTE = 60_000;

  test("nothing until the snapshots span the window, then per second and per GB a second", () => {
    const income = new HackLoopIncome();
    income.add(0, medium(1_000));
    income.add(5 * MINUTE, medium(31_000));
    expect(income.rate()).toBeNull();
    income.add(CLOUD_SERVER_INCOME_WINDOW_MS, medium(61_000));
    // $60,000 in 600 s on 16 GB: $100 a second, $6.25 a GB a second. Home's RAM isn't the loop's.
    expect(income.rate()).toEqual({ perSecond: 100, perGbSecond: 6.25 });
  });

  test("a fall in money (a purchase) isn't income; the rises around it are", () => {
    const income = new HackLoopIncome();
    income.add(0, medium(100_000));
    income.add(5 * MINUTE, medium(160_000));
    income.add(6 * MINUTE, medium(10_000));
    income.add(10 * MINUTE, medium(70_000));
    expect(income.rate()?.perSecond).toBe(120_000 / 600);
  });

  test("each stretch counts at the RAM the snapshot that starts it shows: a host bought mid-window counts from then", () => {
    const income = new HackLoopIncome();
    income.add(0, medium(0, 16));
    income.add(5 * MINUTE, medium(48_000, 48));
    income.add(10 * MINUTE, medium(96_000 + 48_000, 48));
    // 16 GB for 300 s and 48 GB for 300 s: 19,200 GB-seconds, for $144,000.
    expect(income.rate()?.perGbSecond).toBe(144_000 / 19_200);
  });

  test("only the last window counts: older snapshots are dropped, but for the one at its start", () => {
    const income = new HackLoopIncome();
    income.add(0, medium(0));
    income.add(10 * MINUTE, medium(1_000_000));
    income.add(15 * MINUTE, medium(1_030_000));
    // The window from 10 minutes: the snapshot at its start, then 15 and 20.
    income.add(20 * MINUTE, medium(1_060_000));
    expect(income.rate()).toEqual({ perSecond: 60_000 / 600, perGbSecond: 60_000 / (600 * 16) });
  });

  test("a snapshot without a money that is a number is skipped; cleared, it starts again; no RAM, no rate", () => {
    const income = new HackLoopIncome();
    income.add(0, medium(0));
    income.add(5 * MINUTE, { ...medium(0), player: { money: "lots" } } as unknown as MediumSnapshotData);
    income.add(10 * MINUTE, medium(60_000));
    expect(income.rate()?.perSecond).toBe(100);
    income.clear();
    expect(income.rate()).toBeNull();
    const noHosts = new HackLoopIncome();
    noHosts.add(0, mediumData(1, { home: true }, { money: 0 }));
    noHosts.add(10 * MINUTE, mediumData(1, { home: true }, { money: 60_000 }));
    expect(noHosts.rate()).toBeNull();
  });
});

describe("cloudServersOf and nextCloudServerName", () => {
  const network: StaticSnapshotData = {
    servers: [
      staticServer("home", { moneyMax: 0 }),
      staticServer("n00dles"),
      staticServer("pserv-0", { purchasedByPlayer: true, moneyMax: 0 }),
      staticServer("hacknet-server-0", { purchasedByPlayer: true }),
    ],
  };

  test("the medium snapshot's servers but home, Hacknet's and the game's own, by name, with their RAM", () => {
    const medium = mediumData(1, {
      home: true,
      n00dles: true,
      "pserv-0": true,
      "hacknet-server-0": true,
      "pserv-1": true,
      "owners-box": true,
    });
    expect(cloudServersOf(network, medium)).toEqual([
      { hostname: "owners-box", ram: 16 },
      { hostname: "pserv-0", ram: 16 },
      { hostname: "pserv-1", ram: 16 },
    ]);
  });

  test("the least pserv-<n> no server is named, or named after with a '-'", () => {
    expect(nextCloudServerName([])).toBe("pserv-0");
    expect(nextCloudServerName(["home", "pserv-0", "pserv-2"])).toBe("pserv-1");
    // pserv-1 bought renamed (a server off the network held it): passed over, never bought again and again.
    expect(nextCloudServerName(["pserv-0", "pserv-1-0"])).toBe("pserv-2");
    // pserv-10 doesn't take pserv-1.
    expect(nextCloudServerName(["pserv-0", "pserv-10"])).toBe("pserv-1");
  });
});

describe("chooseCloudServerPurchase: the largest that money allows and pays back in time", () => {
  const network: StaticSnapshotData = { servers: [staticServer("home", { moneyMax: 0 }), staticServer("n00dles")] };
  /** n00dles rooted, the player's money, and cloud servers `pserv-<i>` with these RAMs. */
  const medium = (money: number, cloudRams: number[] = []) => {
    const data = mediumData(
      1,
      { home: true, n00dles: true, ...Object.fromEntries(cloudRams.map((_, index) => [`pserv-${index}`, true])) },
      { money },
    );
    for (const server of data.servers) {
      const index = /^pserv-(\d+)$/.exec(server.hostname)?.[1];
      if (index !== undefined) server.maxRam = cloudRams[Number(index)] as number;
    }
    return data;
  };
  /** An income at which a GB pays back in `minutes`: $55,000 over that time. */
  const paysBackIn = (minutes: number): HackLoopIncomeRate => ({
    perSecond: 1_000,
    perGbSecond: 55_000 / (minutes * 60),
  });
  /** $128 a GB a second: a GB's $55,000 pays back in 429.6875 s, in exact binary, so the paybacks compare exactly. */
  const INCOME = { perSecond: 1_000, perGbSecond: 128 };
  const PAYBACK_MS = 429_687.5;
  const choose = (
    mediumSnapshot: MediumSnapshotData,
    {
      income = INCOME as HackLoopIncomeRate | null,
      reserve = null as { amount: number; forWhat: string } | null,
      previous = null as CloudServerPurchase | null,
      slow = slowData(),
    } = {},
  ) =>
    chooseCloudServerPurchase({
      staticData: network,
      mediumData: mediumSnapshot,
      slowData: slow,
      income,
      reserve,
      previous,
    });

  test("under the limit, a new server: the largest power of two the money covers, at least 8 GB", () => {
    // $10m covers 128 GB ($7.04m), not 256 ($14.08m).
    expect(choose(medium(10e6))).toEqual({
      servers: [],
      next: { action: "buyServer", hostname: "pserv-0", ram: 128, price: 7_040_000, paybackMs: PAYBACK_MS },
      waitingFor: null,
    });
    expect(choose(medium(440_000)).next).toMatchObject({ ram: 8, price: 440_000 });
    // Its name is the next free one; the servers owned are listed.
    expect(choose(medium(440_000, [8, 64]))).toMatchObject({
      servers: [
        { hostname: "pserv-0", ram: 8 },
        { hostname: "pserv-1", ram: 64 },
      ],
      next: { action: "buyServer", hostname: "pserv-2", ram: 8 },
    });
    // At the most RAM, however much money.
    expect(choose(medium(1e15)).next).toMatchObject({ ram: 2 ** 20 });
  });

  test("short of 8 GB's price: none, saying what it waits for, and what money is held back for", () => {
    expect(choose(medium(439_999))).toMatchObject({
      next: null,
      waitingFor: "money for pserv-0 with 8 GB ($440,000)",
    });
    const reserve = { amount: 500_000, forWhat: "BruteSSH.exe" };
    expect(choose(medium(900_000), { reserve })).toMatchObject({
      next: null,
      waitingFor: "money for pserv-0 with 8 GB ($440,000, beyond $500,000 held for BruteSSH.exe)",
    });
    // The reserve is taken off the money: $1m less $500k covers 8 GB, not 16.
    expect(choose(medium(1e6), { reserve }).next).toMatchObject({ ram: 8 });
  });

  test("the payback: within the limit, bought; past it, none, saying the income and the payback", () => {
    const limitMinutes = CLOUD_SERVER_PAYBACK_LIMIT_MS / 60_000;
    expect(choose(medium(1e9), { income: paysBackIn(limitMinutes * 0.99) }).next).not.toBeNull();
    const slow = paysBackIn(limitMinutes * 1.01);
    expect(choose(medium(1e9), { income: slow })).toMatchObject({
      next: null,
      waitingFor:
        `an income that pays a server back within ${limitMinutes} min (at $${slow.perGbSecond.toFixed(2)} a GB a ` +
        `second, ${Math.ceil(limitMinutes * 1.01)} min)`,
    });
  });

  test(`at the limit of ${CLOUD_SERVER_LIMIT}, the smallest server upgraded, at the difference in price`, () => {
    const rams = Array.from({ length: CLOUD_SERVER_LIMIT }, (_, index) => (index === 7 ? 8 : 64));
    // 8 GB to 64 GB is 56 GB more, $3.08m; $10m covers to 128 GB ($6.6m), not 256 ($13.64m).
    expect(choose(medium(10e6, rams)).next).toEqual({
      action: "upgradeServer",
      hostname: "pserv-7",
      ram: 128,
      price: 6_600_000,
      paybackMs: PAYBACK_MS,
    });
    // Ties to the first name.
    const even = Array.from({ length: CLOUD_SERVER_LIMIT }, () => 64);
    expect(choose(medium(10e6, even)).next).toMatchObject({ hostname: "pserv-0", ram: 128, price: 3_520_000 });
    expect(choose(medium(3_519_999, even))).toMatchObject({
      next: null,
      waitingFor: "money for pserv-0 to 128 GB ($3,520,000)",
    });
    // All at the most: nothing more, and nothing to wait for.
    const most = Array.from({ length: CLOUD_SERVER_LIMIT }, () => 2 ** 20);
    expect(choose(medium(1e300, most))).toMatchObject({ next: null, waitingFor: null });
  });

  test("a purchase in flight is kept while still to do and allowed, at today's price and income", () => {
    const previous: CloudServerPurchase = {
      action: "buyServer",
      hostname: "pserv-0",
      ram: 8,
      price: 440_000,
      paybackMs: PAYBACK_MS,
    };
    // Money for 128 GB now, but the 8 GB purchase sent before is kept, so its id holds.
    expect(choose(medium(10e6), { previous, income: { perSecond: 1_000, perGbSecond: 256 } }).next).toEqual({
      ...previous,
      paybackMs: PAYBACK_MS / 2,
    });
    // Bought (pserv-0 in the snapshot): the next one.
    expect(choose(medium(10e6, [8]), { previous }).next).toMatchObject({ hostname: "pserv-1", ram: 128 });
    // No longer allowed by the money, or the payback: chosen afresh.
    expect(choose(medium(300_000), { previous }).next).toBeNull();
    const limitMinutes = CLOUD_SERVER_PAYBACK_LIMIT_MS / 60_000;
    expect(choose(medium(10e6), { previous, income: paysBackIn(limitMinutes * 2) }).next).toBeNull();
    // An upgrade, until the server has its RAM, priced from the RAM it has now.
    const rams = Array.from({ length: CLOUD_SERVER_LIMIT }, () => 64);
    const upgrade: CloudServerPurchase = { ...previous, action: "upgradeServer", hostname: "pserv-3", ram: 256 };
    expect(choose(medium(1e9, rams), { previous: upgrade }).next).toEqual({
      ...upgrade,
      price: cloudServerPrice(256) - cloudServerPrice(64),
    });
    rams[3] = 256;
    expect(choose(medium(1e9, rams), { previous: upgrade }).next).toMatchObject({ hostname: "pserv-0" });
    // Past it (the owner upgraded it further): done too.
    rams[3] = 512;
    expect(choose(medium(1e9, rams), { previous: upgrade }).next).toMatchObject({ hostname: "pserv-0" });
  });

  test("what it waits for first: the slow snapshot, BN1's prices, the income, an income at all", () => {
    expect(choose(medium(1e9), { slow: null as never })).toMatchObject({
      next: null,
      waitingFor: "the Agent's slow snapshot (which BitNode)",
    });
    expect(choose(medium(1e9), { slow: slowData(2) })).toMatchObject({
      next: null,
      waitingFor: "the cloud server prices in BitNode 2 (not known yet)",
    });
    expect(choose(medium(1e9), { income: null })).toMatchObject({
      next: null,
      waitingFor: "the hack loop's income over 10 min (measured from the medium snapshots)",
    });
    expect(choose(medium(1e9), { income: { perSecond: 0, perGbSecond: 0 } })).toMatchObject({
      next: null,
      waitingFor: "the hack loop to earn (nothing in the last 10 min)",
    });
  });
});

describe("the dashboard's switch", () => {
  let directory: string;
  let store: TelemetryStore;
  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), "cloud-servers-"));
    store = TelemetryStore.open(path.join(directory, "telemetry.sqlite"));
  });
  afterEach(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("on by default; off once the owner turns it off", () => {
    expect(readCloudServersEnabled(store)).toBe(true);
    store.setSetting("cloudServers.enabled", "false");
    expect(readCloudServersEnabled(store)).toBe(false);
  });
});
