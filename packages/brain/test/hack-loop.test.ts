// The brain's side of the hack loop (#134): the starter rules (target and hosts) and the dashboard's switch. The
// controller that sends it is desired-state.test.ts's.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MediumSnapshotData, StaticSnapshotData } from "@bitburner-agent/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { chooseHackHosts, chooseHackTarget, planHackLoop, readHackLoopEnabled } from "../src/hack-loop.ts";
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

describe("chooseHackHosts: where the loop runs", () => {
  test("the game's rooted servers with RAM, sorted: never home, nor the player's purchased or Hacknet servers", () => {
    const network: StaticSnapshotData = {
      servers: [
        staticServer("home", { moneyMax: 0 }),
        staticServer("n00dles"),
        staticServer("foodnstuff"),
        staticServer("not-rooted"),
        staticServer("no-ram"),
        staticServer("bought-1", { purchasedByPlayer: true, moneyMax: 0 }),
        staticServer("hacknet-server-0", { purchasedByPlayer: true }),
      ],
    };
    const medium = mediumData(1, {
      home: true,
      n00dles: true,
      foodnstuff: true,
      "not-rooted": false,
      "no-ram": true,
      "bought-1": true,
      "hacknet-server-0": true,
    });
    for (const server of medium.servers) if (server.hostname === "no-ram") server.maxRam = 0;
    expect(chooseHackHosts(network, medium)).toEqual(["foodnstuff", "n00dles"]);
  });

  test("only names the protocol takes, and at most its limit", () => {
    const odd: StaticSnapshotData = {
      servers: [staticServer(""), staticServer("x".repeat(257)), staticServer("n00dles")],
    };
    expect(chooseHackHosts(odd, mediumData(1, { "": true, ["x".repeat(257)]: true, n00dles: true }))).toEqual([
      "n00dles",
    ]);
    const hostnames = Array.from({ length: 1_005 }, (_, index) => `server-${String(index).padStart(4, "0")}`);
    const many: StaticSnapshotData = { servers: hostnames.map((hostname) => staticServer(hostname)) };
    const allRooted = Object.fromEntries(hostnames.map((hostname) => [hostname, true]));
    expect(chooseHackHosts(many, mediumData(1, allRooted))).toHaveLength(1_000);
  });

  test("nothing to go on: none", () => {
    expect(chooseHackHosts(null, mediumData(1, { n00dles: true }))).toEqual([]);
    expect(chooseHackHosts({ servers: [staticServer("n00dles")] }, null)).toEqual([]);
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
  /** The note for a target that has been ready since it was set, so the loop hacks it. */
  const earningOn = (target: string) => ({ target, earning: true });
  const plan = (...args: Parameters<typeof planHackLoop>) => planHackLoop(...args).hackLoop;

  test("the note: the target set, and whether it earns, kept until a snapshot shows it ready", () => {
    // Prepared while n00dles earns: n00dles is noted.
    expect(planHackLoop(network, medium(150), earningOn("n00dles")).note).toEqual(earningOn("n00dles"));
    // Moved to zer0 once ready: it earns.
    expect(planHackLoop(network, medium(150, { zer0: ZER0_READY }), earningOn("n00dles")).note).toEqual(
      earningOn("zer0"),
    );
    // zer0 hacked below 75% since: it still earns.
    expect(planHackLoop(network, medium(150), earningOn("zer0")).note).toEqual(earningOn("zer0"));
    // n00dles as a fresh start has it, and never ready since: not earning, until a snapshot shows it ready.
    const fresh = { moneyAvailable: 70_000, hackDifficulty: 1 };
    expect(planHackLoop(network, medium(1, { n00dles: fresh }), null).note).toEqual({
      target: "n00dles",
      earning: false,
    });
    expect(planHackLoop(network, medium(1), { target: "n00dles", earning: false }).note).toEqual(earningOn("n00dles"));
    expect(planHackLoop(null, medium(150), earningOn("n00dles")).note).toBeNull();
  });

  test("a target that doesn't earn yet is given up at once for a better one: nothing earning is lost", () => {
    // n00dles set, and not at 75% since: zer0 takes every host at once. (On a fresh start where the owner rooted
    // foodnstuff first, foodnstuff was the target, and n00dles took over as soon as it was rooted.)
    const notYet = medium(150, { n00dles: { moneyAvailable: 70_000, hackDifficulty: 1 } });
    expect(plan(network, notYet, { target: "n00dles", earning: false })).toEqual({ target: "zer0", hosts: ALL_HOSTS });
    // Once it has been ready, it earns: zer0 is prepared beside it.
    expect(plan(network, notYet, earningOn("n00dles"))).toMatchObject({
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

  test("no last target (a brain restart): the best ready candidate, or best if none is ready", () => {
    expect(plan(network, medium(150), null)).toMatchObject({
      target: "n00dles",
      preparing: { target: "zer0" },
    });
    const nothingReady = medium(150, { n00dles: { moneyAvailable: 0, hackDifficulty: 1 } });
    expect(plan(network, nothingReady, null)).toEqual({ target: "zer0", hosts: ALL_HOSTS });
  });

  test("a last target that isn't a candidate any more (after a reset): the same fallback", () => {
    // Back at hacking 1, zer0 is out of reach: n00dles, all hosts.
    expect(plan(network, medium(1), earningOn("zer0"))).toEqual({ target: "n00dles", hosts: ALL_HOSTS });
    expect(plan(network, medium(150), earningOn("gone-server"))).toMatchObject({
      target: "n00dles",
      preparing: { target: "zer0" },
    });
  });

  test("a single host holds all the RAM, so it prepares; no target or no snapshots, nothing to plan", () => {
    expect(plan(network, medium(150, { ram: { alpha: 64 } }), earningOn("n00dles"))).toEqual({
      target: "n00dles",
      hosts: [],
      preparing: { target: "zer0", hosts: ["alpha"] },
    });
    expect(plan(network, mediumData(150, { alpha: true }), null)).toEqual({ target: null, hosts: ["alpha"] });
    expect(plan(null, medium(150), earningOn("n00dles"))).toEqual({ target: null, hosts: [] });
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
