// The brain's side of the hack loop (#134): the starter rules (target and hosts) and the dashboard's switch. The
// controller that sends it is desired-state.test.ts's.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MediumSnapshotData, StaticSnapshotData } from "@bitburner-agent/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  chooseHackHosts,
  chooseHackTarget,
  HACK_REGROW_ROUNDS,
  hackLoopHosts,
  type LastHackTarget,
  planHackLoop,
  readHackLoopEnabled,
} from "../src/hack-loop.ts";
import { TelemetryStore } from "../src/telemetry-store.ts";
import { mediumData, staticServer } from "./helpers/snapshot-fixtures.ts";

describe("chooseHackTarget: a starter rule until the planner (M4)", () => {
  // The game's own figures for these servers (moneyMax, serverGrowth).
  const network: StaticSnapshotData = {
    servers: [
      staticServer("home", { moneyMax: 0, numOpenPortsRequired: 5, serverGrowth: 1 }),
      staticServer("n00dles", { moneyMax: 1_750_000, serverGrowth: 3_000 }),
      staticServer("foodnstuff", { moneyMax: 50_000_000, serverGrowth: 5 }),
      staticServer("joesguns", { moneyMax: 62_500_000, serverGrowth: 20, requiredHackingSkill: 10 }),
      staticServer("big-and-slow", { moneyMax: 2_000_000_000, serverGrowth: 50, requiredHackingSkill: 20 }),
      staticServer("bought-1", { purchasedByPlayer: true, moneyMax: 0 }),
    ],
  };
  const allRooted = {
    home: true,
    n00dles: true,
    foodnstuff: true,
    joesguns: true,
    "big-and-slow": true,
    "bought-1": true,
  };

  test("the highest money times growth among rooted servers needing at most half the hacking level", () => {
    // n00dles (5.25e9) over foodnstuff (2.5e8) and joesguns (1.25e9): the one that grows back fast.
    expect(chooseHackTarget(network, mediumData(1, allRooted))).toBe("n00dles");
    expect(chooseHackTarget(network, mediumData(39, allRooted))).toBe("n00dles");
    // 1e11 once its level is in reach.
    expect(chooseHackTarget(network, mediumData(40, allRooted))).toBe("big-and-slow");
  });

  test("only rooted servers, never home or a purchased one", () => {
    // Level 20 reaches joesguns (needs 10), not big-and-slow (needs 20).
    expect(chooseHackTarget(network, mediumData(20, { ...allRooted, n00dles: false }))).toBe("joesguns");
    expect(chooseHackTarget(network, mediumData(19, { ...allRooted, n00dles: false }))).toBe("foodnstuff");
    expect(chooseHackTarget(network, mediumData(100, { home: true, "bought-1": true }))).toBeNull();
  });

  test("a server without money or growth isn't one", () => {
    const barren: StaticSnapshotData = {
      servers: [staticServer("no-money", { moneyMax: 0 }), staticServer("no-growth", { serverGrowth: undefined })],
    };
    expect(chooseHackTarget(barren, mediumData(1, { "no-money": true, "no-growth": true }))).toBeNull();
  });

  test("ties go to the first hostname, so the choice doesn't flap", () => {
    const twins: StaticSnapshotData = { servers: [staticServer("zeta"), staticServer("alpha")] };
    expect(chooseHackTarget(twins, mediumData(1, { zeta: true, alpha: true }))).toBe("alpha");
  });

  test("nothing to go on: no target", () => {
    expect(chooseHackTarget(null, mediumData(1, allRooted))).toBeNull();
    expect(chooseHackTarget(network, null)).toBeNull();
  });
});

describe("hackLoopHosts: where the loop runs (#134, #194)", () => {
  /** The game's servers, home and a Hacknet server as the static snapshot has them (home's is purchased, as the game's). */
  const network: StaticSnapshotData = {
    servers: [
      staticServer("home", { purchasedByPlayer: true, moneyMax: 0 }),
      staticServer("n00dles"),
      staticServer("foodnstuff"),
      staticServer("not-rooted"),
      staticServer("no-ram"),
      staticServer("hacknet-server-0", { purchasedByPlayer: true }),
      staticServer("owners-old-box", { purchasedByPlayer: true, moneyMax: 0 }),
    ],
  };

  test("the game's rooted servers with RAM and the brain's cloud servers, sorted: never home, Hacknet or the owner's", () => {
    const medium = mediumData(1, {
      home: true,
      n00dles: true,
      foodnstuff: true,
      "not-rooted": false,
      "no-ram": true,
      "pserv-0": true,
      "owners-box": true,
      "owners-old-box": true,
      "pserv-01": true,
      "hacknet-server-0": true,
    });
    for (const server of medium.servers) {
      if (server.hostname === "no-ram") server.maxRam = 0;
      if (server.hostname === "pserv-0") server.maxRam = 1_024;
    }
    expect(hackLoopHosts(network, medium)).toEqual([
      { hostname: "foodnstuff", ram: 16 },
      { hostname: "n00dles", ram: 16 },
      { hostname: "pserv-0", ram: 1_024 },
    ]);
    expect(chooseHackHosts(network, medium)).toEqual(["foodnstuff", "n00dles", "pserv-0"]);
  });

  test("a home that isn't marked purchased is still never a host", () => {
    const odd: StaticSnapshotData = { servers: [staticServer("home"), staticServer("n00dles")] };
    expect(chooseHackHosts(odd, mediumData(1, { home: true, n00dles: true }))).toEqual(["n00dles"]);
  });

  test("a cloud server the brain bought since the static snapshot is a host at the next medium one, at its RAM then", () => {
    const before = mediumData(1, { n00dles: true });
    const after = mediumData(1, { n00dles: true, "pserv-0": true });
    expect(chooseHackHosts(network, before)).toEqual(["n00dles"]);
    expect(chooseHackHosts(network, after)).toEqual(["n00dles", "pserv-0"]);
    // Upgraded: its RAM as the snapshot has it now.
    for (const server of after.servers) if (server.hostname === "pserv-0") server.maxRam = 64;
    expect(hackLoopHosts(network, after).at(-1)).toEqual({ hostname: "pserv-0", ram: 64 });
  });

  test("only names the protocol takes, a RAM that is a number, and at most its limit", () => {
    const names: StaticSnapshotData = {
      servers: ["", "x".repeat(257), "n00dles", "odd-ram"].map((hostname) => staticServer(hostname)),
    };
    const odd = mediumData(1, { "": true, ["x".repeat(257)]: true, n00dles: true, "odd-ram": true });
    for (const server of odd.servers) if (server.hostname === "odd-ram") server.maxRam = "16" as unknown as number;
    expect(chooseHackHosts(names, odd)).toEqual(["n00dles"]);
    const hostnames = Array.from({ length: 1_005 }, (_, index) => `server-${String(index).padStart(4, "0")}`);
    const many: StaticSnapshotData = { servers: hostnames.map((hostname) => staticServer(hostname)) };
    const allRooted = Object.fromEntries(hostnames.map((hostname) => [hostname, true]));
    expect(chooseHackHosts(many, mediumData(1, allRooted))).toHaveLength(1_000);
  });

  test("nothing to go on: none", () => {
    expect(chooseHackHosts(null, mediumData(1, { n00dles: true, "pserv-0": true }))).toEqual([]);
    expect(chooseHackHosts(network, null)).toEqual([]);
    expect(chooseHackHosts(network, { servers: "odd" } as unknown as MediumSnapshotData)).toEqual([]);
  });
});

describe("planHackLoop (#184): the next target prepared while the current one earns", () => {
  // The game's own figures: n00dles at $1.75m and security 1 at best, zer0 at $187.5m and 10 (needs hacking 75).
  // The hosts have no money (so aren't targets), and the targets no RAM (so aren't hosts).
  const network: StaticSnapshotData = {
    servers: [
      staticServer("home", { moneyMax: 0 }),
      staticServer("n00dles", { moneyMax: 1_750_000, serverGrowth: 3_000, minDifficulty: 1 }),
      staticServer("zer0", { moneyMax: 187_500_000, serverGrowth: 40, minDifficulty: 10, requiredHackingSkill: 75 }),
      ...["alpha", "bravo", "charlie", "delta"].map((hostname) => staticServer(hostname, { moneyMax: 0 })),
    ],
  };
  const READY = { moneyAvailable: 1_750_000, hackDifficulty: 1 };
  /** n00dles being worked, caught between a hack and the weaken after it: 60% of its money, security min + 5.1. */
  const N00DLES_WORKED = { moneyAvailable: 1_050_000, hackDifficulty: 6.1 };
  /** n00dles as a fresh start has it: 4% of its money (Server.ts:74-75). */
  const N00DLES_FRESH = { moneyAvailable: 70_000, hackDifficulty: 1 };
  /** zer0 as a fresh start has it: 4% of its money, at its starting security. */
  const ZER0_FRESH = { moneyAvailable: 7_500_000, hackDifficulty: 30 };
  const ZER0_READY = { moneyAvailable: 140_625_000, hackDifficulty: 15 };
  /** A medium snapshot at hacking `hacking`: everything rooted, the hosts' RAM, and the targets' money and security. */
  const medium = (
    hacking: number,
    {
      ram = { alpha: 64, bravo: 32, charlie: 16, delta: 16 },
      zer0 = ZER0_FRESH,
      n00dles = READY,
    }: {
      ram?: Record<string, number>;
      zer0?: { moneyAvailable: number; hackDifficulty: number };
      n00dles?: { moneyAvailable: number; hackDifficulty: number };
    } = {},
  ): MediumSnapshotData => {
    const data = mediumData(hacking, {
      home: true,
      n00dles: true,
      zer0: true,
      ...Object.fromEntries(Object.keys(ram).map((host) => [host, true])),
    });
    for (const server of data.servers) {
      server.maxRam = ram[server.hostname] ?? 0;
      if (server.hostname === "zer0") Object.assign(server, zer0);
      if (server.hostname === "n00dles") Object.assign(server, n00dles);
    }
    return data;
  };
  const ALL_HOSTS = ["alpha", "bravo", "charlie", "delta"];
  /** A target last set that has been ready since, so the loop hacks it, with the hosts that prepared the next one. */
  const earningOn = (target: string, preparingHosts: string[] = []): LastHackTarget => ({
    target,
    earning: true,
    preparingHosts,
  });
  /** The plan's targets and hosts: its hack threads (#187) are the next describe's. */
  const plan = (...args: Parameters<typeof planHackLoop>) => {
    const { hackThreads: _hackThreads, ...targetsAndHosts } = planHackLoop(...args).hackLoop;
    return targetsAndHosts;
  };
  const lastSetAfter = (...args: Parameters<typeof planHackLoop>) => planHackLoop(...args).lastSet;

  test("what it notes: the target set, whether it earns (once a snapshot shows it ready), and the preparing hosts", () => {
    // Prepared while n00dles earns: n00dles is noted, with alpha preparing.
    expect(lastSetAfter(network, medium(150), earningOn("n00dles"))).toEqual(earningOn("n00dles", ["alpha"]));
    // Moved to zer0 once ready: it earns.
    expect(lastSetAfter(network, medium(150, { zer0: ZER0_READY }), earningOn("n00dles"))).toEqual(earningOn("zer0"));
    // zer0 hacked below 75% since: it still earns.
    expect(lastSetAfter(network, medium(150), earningOn("zer0"))).toEqual(earningOn("zer0"));
    // n00dles as a fresh start has it, and never ready since: not earning, until a snapshot shows it ready.
    const notYet = { target: "n00dles", earning: false, preparingHosts: [] };
    expect(lastSetAfter(network, medium(1, { n00dles: N00DLES_FRESH }), null)).toEqual(notYet);
    expect(lastSetAfter(network, medium(1), notYet)).toEqual(earningOn("n00dles"));
    expect(lastSetAfter(null, medium(150), earningOn("n00dles"))).toBeNull();
  });

  test("a target that doesn't earn yet is given up at once for a better one: nothing earning is lost", () => {
    // n00dles set, and not at 75% since: zer0 takes every host at once. (On a fresh start where the owner rooted
    // foodnstuff first, foodnstuff was the target, and n00dles took over as soon as it was rooted.)
    const notYet = medium(150, { n00dles: N00DLES_FRESH });
    expect(plan(network, notYet, { target: "n00dles", earning: false, preparingHosts: [] })).toEqual({
      target: "zer0",
      hosts: ALL_HOSTS,
    });
    // Once it has been ready, it earns: zer0 is prepared beside it, whatever this snapshot shows of n00dles.
    expect(plan(network, medium(150, { n00dles: N00DLES_WORKED }), earningOn("n00dles"))).toMatchObject({
      target: "n00dles",
      preparing: { target: "zer0" },
    });
  });

  test("best is current: every host on it, nothing prepared", () => {
    expect(plan(network, medium(100), earningOn("n00dles"))).toEqual({ target: "n00dles", hosts: ALL_HOSTS });
  });

  test("best isn't current and isn't ready: the rest keep earning, the largest prepare it until they hold half the RAM", () => {
    // 64 of 128 GB: alpha alone is half.
    expect(plan(network, medium(150), earningOn("n00dles"))).toEqual({
      target: "n00dles",
      hosts: ["bravo", "charlie", "delta"],
      preparing: { target: "zer0", hosts: ["alpha"] },
    });
    // Equal hosts: two of four are half; ties by name.
    expect(
      plan(network, medium(150, { ram: { alpha: 32, bravo: 32, charlie: 32, delta: 32 } }), earningOn("n00dles")),
    ).toEqual({
      target: "n00dles",
      hosts: ["charlie", "delta"],
      preparing: { target: "zer0", hosts: ["alpha", "bravo"] },
    });
    // At least half, in RAM order: 16 + 8 of 40 is 24, more than half once the 8 is in.
    expect(
      plan(network, medium(150, { ram: { alpha: 8, bravo: 16, charlie: 8, delta: 8 } }), earningOn("n00dles")),
    ).toEqual({
      target: "n00dles",
      hosts: ["charlie", "delta"],
      preparing: { target: "zer0", hosts: ["alpha", "bravo"] },
    });
  });

  test("the preparing hosts stay while they still hold half the RAM: a larger host rooted later doesn't swap them", () => {
    // echo (64 GB), rooted since: alpha, still preparing, holds 64 of 192 GB, no longer half, so the split is made
    // again from the largest: alpha and echo.
    const withEcho = { alpha: 64, bravo: 32, charlie: 16, delta: 16, echo: 64 };
    const echoNetwork = { servers: [...network.servers, staticServer("echo", { moneyMax: 0 })] };
    expect(plan(echoNetwork, medium(150, { ram: withEcho }), earningOn("n00dles", ["alpha"]))).toMatchObject({
      preparing: { hosts: ["alpha", "echo"] },
    });
    // bravo and charlie prepared before, 48 of 128: not half, made again. alpha and bravo, 96 of 128: kept, though
    // alpha alone would do.
    expect(plan(network, medium(150), earningOn("n00dles", ["bravo", "charlie"]))).toMatchObject({
      preparing: { hosts: ["alpha"] },
    });
    expect(plan(network, medium(150), earningOn("n00dles", ["alpha", "bravo"]))).toEqual({
      target: "n00dles",
      hosts: ["charlie", "delta"],
      preparing: { target: "zer0", hosts: ["alpha", "bravo"] },
    });
    // Equal hosts, delta then charlie having prepared: kept, not swapped for alpha and bravo by name.
    const equal = medium(150, { ram: { alpha: 32, bravo: 32, charlie: 32, delta: 32 } });
    expect(plan(network, equal, earningOn("n00dles", ["charlie", "delta"]))).toMatchObject({
      hosts: ["alpha", "bravo"],
      preparing: { hosts: ["charlie", "delta"] },
    });
    // A host gone (no longer rooted with RAM) leaves the list; every host preparing is never kept.
    expect(plan(network, medium(150), earningOn("n00dles", ["alpha", "gone"]))).toMatchObject({
      preparing: { hosts: ["alpha"] },
    });
    expect(plan(network, medium(150), earningOn("n00dles", ALL_HOSTS))).toMatchObject({
      preparing: { hosts: ["alpha"] },
    });
  });

  test("best ready, by the loop's thresholds: every host moves to it", () => {
    expect(plan(network, medium(150, { zer0: ZER0_READY }), earningOn("n00dles"))).toEqual({
      target: "zer0",
      hosts: ALL_HOSTS,
    });
    // Money short of 75%, or security over the minimum + 5: still prepared.
    for (const zer0 of [
      { ...ZER0_READY, moneyAvailable: 140_624_999 },
      { ...ZER0_READY, hackDifficulty: 15.5 },
    ]) {
      expect(plan(network, medium(150, { zer0 }), earningOn("n00dles")).target).toBe("n00dles");
    }
    // Once moved, it stays, ready or not: zer0 is current now.
    expect(plan(network, medium(150), earningOn("zer0"))).toEqual({ target: "zer0", hosts: ALL_HOSTS });
  });

  test("nothing set (a brain restart): the best ready candidate; else the one with the most of its money, if worked", () => {
    expect(plan(network, medium(150), null)).toMatchObject({ target: "n00dles", preparing: { target: "zer0" } });
    // The ready one comes before the one with more of its money: foodnstuff at 90% but its security too high, n00dles
    // ready at 80%.
    const withFoodnstuff: StaticSnapshotData = {
      servers: [
        ...network.servers,
        staticServer("foodnstuff", { moneyMax: 50_000_000, serverGrowth: 5, minDifficulty: 3 }),
      ],
    };
    const foodnstuffWorked = medium(150, { n00dles: { moneyAvailable: 1_400_000, hackDifficulty: 1 } });
    foodnstuffWorked.servers.push({
      hostname: "foodnstuff",
      maxRam: 0,
      cpuCores: 1,
      hasAdminRights: true,
      backdoorInstalled: false,
      moneyAvailable: 45_000_000,
      hackDifficulty: 20,
    });
    expect(plan(withFoodnstuff, foodnstuffWorked, null)).toMatchObject({ target: "n00dles" });
    // A restart mid-prepare, n00dles caught between a hack and a weaken (not ready), zer0 grown to 30%: n00dles has
    // the more of its money, so it's the one being worked. It earns on, and zer0 is prepared.
    const midPrepare = medium(150, {
      n00dles: N00DLES_WORKED,
      zer0: { moneyAvailable: 56_250_000, hackDifficulty: 20 },
    });
    expect(plan(network, midPrepare, null)).toMatchObject({ target: "n00dles", preparing: { target: "zer0" } });
    expect(lastSetAfter(network, midPrepare, null)).toMatchObject({ target: "n00dles", earning: true });
    // zer0 further on than n00dles: zer0 is the one, and best, so every host goes to it.
    const zer0Further = medium(150, {
      n00dles: N00DLES_WORKED,
      zer0: { moneyAvailable: 131_250_000, hackDifficulty: 20 },
    });
    expect(plan(network, zer0Further, null)).toEqual({ target: "zer0", hosts: ALL_HOSTS });
    // Everything at a fresh start's 4%: nothing is worked, so best has every host.
    expect(plan(network, medium(150, { n00dles: N00DLES_FRESH }), null)).toEqual({ target: "zer0", hosts: ALL_HOSTS });
    // n00dles at its starting 4% has the more of its money than zer0 at 2%, but a fresh start's 4% isn't worked.
    const zer0Low = { moneyAvailable: 3_750_000, hackDifficulty: 30 };
    expect(plan(network, medium(150, { n00dles: N00DLES_FRESH, zer0: zer0Low }), null)).toEqual({
      target: "zer0",
      hosts: ALL_HOSTS,
    });
  });

  test("a last target that isn't a candidate any more (after a reset): the same fallback", () => {
    // Back at hacking 1, zer0 is out of reach: n00dles, all hosts.
    expect(plan(network, medium(1), earningOn("zer0"))).toEqual({ target: "n00dles", hosts: ALL_HOSTS });
    expect(plan(network, medium(150), earningOn("gone-server"))).toMatchObject({
      target: "n00dles",
      preparing: { target: "zer0" },
    });
  });

  test("a single host holds all the RAM, so it prepares; with no host, nothing is prepared; nothing to plan, nothing", () => {
    expect(plan(network, medium(150, { ram: { alpha: 64 } }), earningOn("n00dles"))).toEqual({
      target: "n00dles",
      hosts: [],
      preparing: { target: "zer0", hosts: ["alpha"] },
    });
    // No rooted server with RAM: no "preparing zer0 on 0 servers".
    expect(plan(network, medium(150, { ram: {} }), earningOn("n00dles"))).toEqual({ target: "n00dles", hosts: [] });
    expect(plan(network, mediumData(150, { alpha: true }), null)).toEqual({ target: null, hosts: ["alpha"] });
    expect(plan(null, medium(150), earningOn("n00dles"))).toEqual({ target: null, hosts: [] });
  });

  describe("each host's hack threads (#187): a round of hacks takes no more than two rounds of grows bring back", () => {
    const hackThreadsOf = (...args: Parameters<typeof planHackLoop>) => planHackLoop(...args).hackLoop.hackThreads;
    /** Every host on zer0, ready, at `hacking`. */
    const onZer0 = (hacking: number, changes: Parameters<typeof medium>[1] = {}) =>
      hackThreadsOf(network, medium(hacking, { zer0: ZER0_READY, ...changes }), earningOn("n00dles"));

    test("a slow grower (zer0, growth 40): each host's part of two rounds' growth, over one thread's share", () => {
      expect(HACK_REGROW_ROUNDS).toBe(2);
      // One thread takes 0.9 x 76/150 / 240 = 0.19% at security 10 (its minimum); one grows log1p(0.03/15) x 0.4 =
      // 0.0008 at 15 (minimum + 5). The hosts' 26 + 13 + 6 + 6 threads, twice: 0.0815. alpha's half: 1 - e^-0.0408 =
      // 4.0%, 21 threads, so 16; bravo 10.6, so 8; charlie and delta 5.3, so 4.
      expect(onZer0(150)).toEqual({ alpha: 16, bravo: 8, charlie: 4, delta: 4 });
    });

    test("n00dles (growth 3000) grows back from anything: every host hacks with all the threads its RAM holds", () => {
      // 1 - e^-5.3 of what it finds, 241 threads, so 128; alpha's 64 GB holds 26.
      expect(hackThreadsOf(network, medium(100), earningOn("n00dles"))).toEqual({
        alpha: 26,
        bravo: 13,
        charlie: 6,
        delta: 6,
      });
    });

    test("in proportion to RAM, and at least 1: a 2 GB host (no thread of the loop's) still gets 1", () => {
      const withEcho = { servers: [...network.servers, staticServer("echo", { moneyMax: 0 })] };
      const ram = { alpha: 64, bravo: 32, charlie: 16, delta: 16, echo: 2 };
      expect(hackThreadsOf(withEcho, medium(150, { ram, zer0: ZER0_READY }), earningOn("n00dles"))).toEqual({
        alpha: 16,
        bravo: 8,
        charlie: 4,
        delta: 4,
        echo: 1,
      });
    });

    test("rounded down to a power of two: the count holds while the hacking level rises, then halves", () => {
      // alpha's 21 at hacking 150 is 16.0 at 220 (the share per thread rises with the level), and 15.7 at 230.
      for (const hacking of [150, 160, 180, 200, 220]) {
        expect(onZer0(hacking), `hacking ${hacking}`).toEqual({ alpha: 16, bravo: 8, charlie: 4, delta: 4 });
      }
      expect(onZer0(230)).toEqual({ alpha: 8, bravo: 4, charlie: 2, delta: 2 });
    });

    test("the player's multipliers: twice the money, half the threads; twice the growth, twice, up to what RAM holds", () => {
      const withMults = (mults: Record<string, number>) => {
        const data = medium(150, { zer0: ZER0_READY });
        data.player = { ...data.player, mults };
        return hackThreadsOf(network, data, earningOn("n00dles"));
      };
      expect(withMults({ hacking_money: 2, hacking_grow: 1 })).toEqual({ alpha: 8, bravo: 4, charlie: 2, delta: 2 });
      // 32, 16, 8 and 8, but at most the threads their RAM holds: 26, 13, 6 and 6.
      expect(withMults({ hacking_money: 1, hacking_grow: 2 })).toEqual({ alpha: 26, bravo: 13, charlie: 6, delta: 6 });
      // Ones that aren't numbers count as 1.
      expect(withMults({ hacking_money: "lots" as unknown as number })).toEqual(onZer0(150));
    });

    test("while preparing: the earning hosts' against the target they earn on, the preparing hosts' against theirs", () => {
      // n00dles on bravo, charlie and delta (all their threads); zer0 on alpha alone: its 26 threads' growth, twice,
      // all alpha's: 21.4, so 16.
      expect(hackThreadsOf(network, medium(150), earningOn("n00dles"))).toEqual({
        bravo: 13,
        charlie: 6,
        delta: 6,
        alpha: 16,
      });
    });

    test("none with no host or no target; 1 each without the minimum security, or with no finite count", () => {
      expect(hackThreadsOf(network, medium(150, { ram: {} }), earningOn("n00dles"))).toBeUndefined();
      expect(hackThreadsOf(network, mediumData(150, { alpha: true }), null)).toBeUndefined();
      const noMinimum = {
        servers: network.servers.map((server) =>
          server.hostname === "zer0" ? { ...server, minDifficulty: undefined } : server,
        ),
      };
      expect(hackThreadsOf(noMinimum, medium(150, { zer0: ZER0_READY }), earningOn("zer0"))).toEqual({
        alpha: 1,
        bravo: 1,
        charlie: 1,
        delta: 1,
      });
      // An infinite grow multiplier (the game has none) on hosts with no thread of the loop's: no finite count, so 1.
      const infinite = medium(150, { ram: { alpha: 2 }, zer0: ZER0_READY });
      infinite.player = { ...infinite.player, mults: { hacking_grow: Number.POSITIVE_INFINITY } };
      expect(hackThreadsOf(network, infinite, earningOn("zer0"))).toEqual({ alpha: 1 });
    });
  });
});

let directory: string;
let store: TelemetryStore;
beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "hack-loop-"));
  store = TelemetryStore.open(path.join(directory, "telemetry.sqlite"));
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

test("the switch: a value it didn't write fails, rather than guess", () => {
  store.setSetting("hackLoop.enabled", "maybe");
  expect(() => readHackLoopEnabled(store)).toThrow(/hackLoop\.enabled/);
});
