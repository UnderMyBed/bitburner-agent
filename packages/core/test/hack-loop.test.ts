import { describe, expect, test } from "vitest";
import { isGeneratedDeploymentId } from "../src/deploy-layout.ts";
import {
  growthLogPerThread,
  HACK_LOOP_MONEY_FRACTION,
  HACK_LOOP_SECURITY_MARGIN,
  hackLoopDeployArguments,
  hackLoopsByHost,
  hostLoopOf,
  isHackLoopFile,
  isHackLoopReady,
  keptGbOf,
  LEVEL_GROW_SCRIPT_NAME,
  LEVEL_LOOP_SCRIPT_NAME,
  loopScriptNameOf,
  loopSourceOf,
  loopThreadsRoom,
  percentMoneyHackedPerThread,
  restartsAtFullSize,
} from "../src/hack-loop.ts";

test("a hack loop is ours only in a folder the deployer generated, so a player's own agent/<name>/ is never touched", () => {
  expect(isHackLoopFile("agent/0123456789ab/hack-loop.js")).toBe(true);
  expect(isHackLoopFile("/agent/0123456789ab/hack-loop.js")).toBe(true);
  expect(isHackLoopFile("agent/mine/hack-loop.js")).toBe(false);
  expect(isHackLoopFile("agent/0123456789AB/hack-loop.js")).toBe(false);
  expect(isHackLoopFile("agent/0123456789ab/agent.js")).toBe(false);
  expect(isHackLoopFile("hack-loop.js")).toBe(false);
  // Levelling mode's loop (#336) is ours on the same terms.
  expect(isHackLoopFile("agent/0123456789ab/level-loop.js")).toBe(true);
  expect(isHackLoopFile("agent/mine/level-loop.js")).toBe(false);
  expect(isHackLoopFile("agent/0123456789ab/level-grow.js")).toBe(true);
});

test("the deploy worker's arguments in levelling mode (#336): home's kept RAM, the operation, each host and home", () => {
  const hackLoop = {
    enabled: true,
    target: "joesguns",
    hosts: ["foodnstuff", "pserv-0"],
    levelling: { homeKeptGb: 32, operation: "grow" as const },
  };
  const args = hackLoopDeployArguments(hackLoop);
  expect(args).toEqual([
    true,
    "levelling",
    32,
    "grow",
    "foodnstuff",
    "joesguns",
    0,
    "pserv-0",
    "joesguns",
    0,
    "home",
    "joesguns",
    0,
  ]);
  const levelling = { homeKeptGb: 32, operation: "grow" };
  expect([...hackLoopsByHost(args)]).toEqual([
    ["foodnstuff", { target: "joesguns", hackThreads: null, levelling }],
    ["pserv-0", { target: "joesguns", hackThreads: null, levelling }],
    ["home", { target: "joesguns", hackThreads: null, levelling }],
  ]);
  // Home named already: once. No operation: the weaken.
  expect(hackLoopDeployArguments({ ...hackLoop, hosts: ["home"], levelling: { homeKeptGb: 32 } })).toEqual([
    true,
    "levelling",
    32,
    "weaken",
    "home",
    "joesguns",
    0,
  ]);
  // Off, or no target: none, as before.
  expect(hackLoopsByHost(hackLoopDeployArguments({ ...hackLoop, enabled: false })).size).toBe(0);
  expect(hackLoopsByHost(hackLoopDeployArguments({ ...hackLoop, target: null })).size).toBe(0);
  // Home's kept RAM unread: none of home is used; the operation unread, the weaken.
  expect(hackLoopsByHost([true, "levelling", "32", "x", "home", "joesguns", 0]).get("home")).toEqual({
    target: "joesguns",
    hackThreads: null,
    levelling: { homeKeptGb: Number.POSITIVE_INFINITY, operation: "weaken" },
  });
});

test("the deploy worker's choices (#336): each host's script, home only levelling, home's kept RAM, its room and restart", () => {
  const levelling = { homeKeptGb: 32, operation: "weaken" as const };
  const loops = new Map([
    ["home", { target: "joesguns", hackThreads: null, levelling }],
    ["foodnstuff", { target: "joesguns", hackThreads: null, levelling: { ...levelling, operation: "grow" as const } }],
  ]);
  expect(loopScriptNameOf(loops.get("home"))).toBe(LEVEL_LOOP_SCRIPT_NAME);
  expect(loopScriptNameOf(loops.get("foodnstuff"))).toBe(LEVEL_GROW_SCRIPT_NAME);
  expect(loopScriptNameOf({ target: "n00dles", hackThreads: 4 })).toBe("hack-loop.js");
  expect(loopScriptNameOf(undefined)).toBe("hack-loop.js");
  // Home runs ours only in levelling mode: a hack loop named for it (an older brain's, say) is none there, so ours
  // there are stopped; elsewhere the loop named.
  expect(hostLoopOf(loops, "home")).toEqual(loops.get("home"));
  const hackLoops = new Map([["home", { target: "n00dles", hackThreads: null }]]);
  expect(hostLoopOf(hackLoops, "home")).toBeUndefined();
  expect(hostLoopOf(hackLoops, "n00dles")).toBeUndefined();
  expect(hostLoopOf(loops, "foodnstuff")).toEqual(loops.get("foodnstuff"));
  // Home keeps the brain's kept RAM in levelling mode, all of it otherwise; other hosts nothing.
  expect(keptGbOf("home", loops.get("home"))).toBe(32);
  expect(keptGbOf("home", undefined)).toBe(Number.POSITIVE_INFINITY);
  expect(keptGbOf("foodnstuff", loops.get("foodnstuff"))).toBe(0);
  // The room: home's RAM less what the others use, then less what's kept; our own loop's counted free.
  const home = { maxGb: 1024, usedGb: 40, oursGb: 0, keptGb: 32, scriptGb: 1.75 };
  expect(loopThreadsRoom(home)).toBe(Math.floor((1024 - 40 - 32) / 1.75));
  // Others already past the kept RAM: still the kept RAM free beside them.
  expect(loopThreadsRoom({ ...home, usedGb: 100 })).toBe(Math.floor((1024 - 100 - 32) / 1.75));
  expect(loopThreadsRoom({ ...home, usedGb: 40 + 500 * 1.75, oursGb: 500 * 1.75 })).toBe(
    Math.floor((1024 - 40 - 32) / 1.75),
  );
  expect(loopThreadsRoom({ ...home, keptGb: Number.POSITIVE_INFINITY })).toBe(0);
  expect(loopThreadsRoom({ ...home, maxGb: 50 })).toBe(0);
  expect(loopThreadsRoom({ maxGb: 16, usedGb: 3.2, oursGb: 0, keptGb: 0, scriptGb: 2.4 })).toBe(5);
  // Started again at full size: elsewhere once a thread more fits, on home once as many as its kept RAM holds.
  expect(restartsAtFullSize(6, 5, 0, 2.4)).toBe(true);
  expect(restartsAtFullSize(5, 5, 0, 2.4)).toBe(false);
  expect(restartsAtFullSize(540 + 17, 540, 32, 1.75)).toBe(false);
  expect(restartsAtFullSize(540 + 18, 540, 32, 1.75)).toBe(true);
  expect(restartsAtFullSize(10, 0, 32, 1.75)).toBe(false);
});

test("levelling's loops aren't bundles (#339): the deploy worker writes one's source only when levelling is sent", () => {
  // Outside levelling, nothing to write: the hack loop is a bundle, and the deploy is the one before levelling.
  expect(loopSourceOf(undefined)).toBeNull();
  expect(loopSourceOf({ target: "n00dles", hackThreads: 4 })).toBeNull();
  // In it, a script calling the operation sent on its one argument for ever, and no other NS function, so its RAM is
  // 1.6 + 0.15 (the ingame ram-budget test measures it with the game's calculator).
  for (const operation of ["weaken", "grow"] as const) {
    const source = loopSourceOf({ target: "joesguns", hackThreads: null, levelling: { homeKeptGb: 32, operation } });
    expect(source).toContain("export async function main(ns)");
    expect(source).toContain(`for (;;) await ns.${operation}(target);`);
    expect(source?.match(/\bns\.\w+/g)).toEqual(["ns.disableLog", "ns.args", `ns.${operation}`]);
  }
});

test("generated deployment ids are 12 lowercase hex digits", () => {
  expect(isGeneratedDeploymentId("0123456789ab")).toBe(true);
  expect(isGeneratedDeploymentId("0123456789a")).toBe(false);
  expect(isGeneratedDeploymentId("deployment-a")).toBe(false);
});

test("ready (#184): at the loop's own thresholds, money at least 75% of the maximum, security at most the minimum + 5", () => {
  expect([HACK_LOOP_MONEY_FRACTION, HACK_LOOP_SECURITY_MARGIN]).toEqual([0.75, 5]);
  // zer0: $187.5m at most, security 10 at least.
  const zer0 = { moneyAvailable: 140_625_000, moneyMax: 187_500_000, hackDifficulty: 15, minDifficulty: 10 };
  expect(isHackLoopReady(zer0)).toBe(true);
  expect(isHackLoopReady({ ...zer0, moneyAvailable: 140_624_999 })).toBe(false);
  expect(isHackLoopReady({ ...zer0, hackDifficulty: 15.001 })).toBe(false);
  // Where a fresh start leaves it: $7.5m, 4%.
  expect(isHackLoopReady({ ...zer0, moneyAvailable: 7_500_000, hackDifficulty: 10 })).toBe(false);
});

test("the deploy worker's arguments (#184, #187): each host with its target and hack threads, read back as they were", () => {
  const hackLoop = {
    enabled: true,
    target: "n00dles",
    hosts: ["foodnstuff", "n00dles"],
    preparing: { target: "zer0", hosts: ["max-hardware"] },
    hackThreads: { foodnstuff: 4, "max-hardware": 16 },
  };
  const args = hackLoopDeployArguments(hackLoop);
  // 0 is no cap: all its threads hack (a host the state gives none, as an older brain's).
  expect(args).toEqual([true, "foodnstuff", "n00dles", 4, "n00dles", "n00dles", 0, "max-hardware", "zer0", 16]);
  expect([...hackLoopsByHost(args)]).toEqual([
    ["foodnstuff", { target: "n00dles", hackThreads: 4 }],
    ["n00dles", { target: "n00dles", hackThreads: null }],
    ["max-hardware", { target: "zer0", hackThreads: 16 }],
  ]);
  expect(hackLoopDeployArguments({ ...hackLoop, preparing: null, hackThreads: undefined })).toEqual([
    true,
    "foodnstuff",
    "n00dles",
    0,
    "n00dles",
    "n00dles",
    0,
  ]);
  // Off, or no target: no host runs it.
  for (const none of [
    { ...hackLoop, enabled: false },
    { ...hackLoop, target: null, preparing: null },
  ]) {
    const noneArgs = hackLoopDeployArguments(none);
    expect(hackLoopsByHost(noneArgs).size).toBe(0);
  }
  expect(hackLoopsByHost([false, "n00dles", "n00dles", 1]).size).toBe(0);
  // A count that isn't a whole number of threads isn't a cap: all its threads.
  for (const odd of [0, -1, 1.5, "4", Number.NaN, undefined]) {
    expect(hackLoopsByHost([true, "n00dles", "n00dles", odd]).get("n00dles")).toEqual({
      target: "n00dles",
      hackThreads: null,
    });
  }
});

describe("percentMoneyHackedPerThread (#187): the game's calculatePercentMoneyHacked, Hacking.ts:44-57", () => {
  const player = (hacking: number, hackingMoney = 1) => ({
    skills: { hacking },
    mults: { hacking_money: hackingMoney },
  });

  test("(100 - security)/100 x (hacking - (required - 1))/hacking x the money multiplier / 240", () => {
    // n00dles (security 1, needs 1) at hacking 150: 0.99 / 240, about 0.41%.
    expect(percentMoneyHackedPerThread({ hackDifficulty: 1, requiredHackingSkill: 1 }, player(150))).toBeCloseTo(
      0.99 / 240,
      15,
    );
    // zer0 at security 15 (needs 75) at hacking 150: 0.85 x 76/150 / 240, about 0.18%.
    const zer0 = { hackDifficulty: 15, requiredHackingSkill: 75 };
    expect(percentMoneyHackedPerThread(zer0, player(150))).toBeCloseTo((0.85 * (76 / 150)) / 240, 15);
    // The player's hacking_money multiplier scales it.
    expect(percentMoneyHackedPerThread(zer0, player(150, 1.5))).toBeCloseTo((1.5 * 0.85 * (76 / 150)) / 240, 15);
  });

  test("none below the hacking it needs, or at security 100 or more; never more than all of it", () => {
    expect(percentMoneyHackedPerThread({ hackDifficulty: 10, requiredHackingSkill: 200 }, player(150))).toBe(0);
    // At exactly the hacking it needs, one level counts: 1/hacking.
    expect(percentMoneyHackedPerThread({ hackDifficulty: 0, requiredHackingSkill: 150 }, player(150))).toBeCloseTo(
      1 / 150 / 240,
      15,
    );
    for (const hackDifficulty of [100, 150]) {
      expect(percentMoneyHackedPerThread({ hackDifficulty, requiredHackingSkill: 1 }, player(150))).toBe(0);
    }
    // Security over 100, hacking below what it needs: two negatives, which the guard at 100 (Hacking.ts:46) keeps from
    // making a share.
    expect(percentMoneyHackedPerThread({ hackDifficulty: 150, requiredHackingSkill: 200 }, player(150))).toBe(0);
    expect(percentMoneyHackedPerThread({ hackDifficulty: 1, requiredHackingSkill: 1 }, player(150, 1e6))).toBe(1);
    // No hacking at all (no game's player has none): none, not NaN.
    expect(percentMoneyHackedPerThread({ hackDifficulty: 1, requiredHackingSkill: 1 }, player(0))).toBe(0);
  });
});

describe("growthLogPerThread (#187): the game's calculateServerGrowthLog for one thread, grow.ts:8-28", () => {
  const player = (hackingGrow = 1) => ({ mults: { hacking_grow: hackingGrow } });

  test("log1p(0.03 / security) x growth/100 x the grow multiplier", () => {
    // max-hardware (growth 30) at security 10: log1p(0.003) x 0.3.
    const maxHardware = { serverGrowth: 30, hackDifficulty: 10 };
    expect(growthLogPerThread(maxHardware, player())).toBeCloseTo(Math.log1p(0.003) * 0.3, 15);
    expect(growthLogPerThread(maxHardware, player(1.2))).toBeCloseTo(Math.log1p(0.003) * 0.3 * 1.2, 15);
  });

  test("at most log1p(0.0035) before growth (Server/data/Constants.ts:8): low security grows no faster", () => {
    // n00dles (growth 3000) at security 1: log1p(0.03) would be over it.
    expect(growthLogPerThread({ serverGrowth: 3_000, hackDifficulty: 1 }, player())).toBeCloseTo(
      0.00349388925425578 * 30,
      15,
    );
    // Just below the edge, security 8.57: log1p(0.0035) at 0.03 / 0.0035 = 8.571...
    expect(growthLogPerThread({ serverGrowth: 100, hackDifficulty: 9 }, player())).toBeCloseTo(
      Math.log1p(0.03 / 9),
      15,
    );
  });

  test("none with no growth, or no security (not a game's server)", () => {
    expect(growthLogPerThread({ serverGrowth: 0, hackDifficulty: 10 }, player())).toBe(0);
    expect(growthLogPerThread({ serverGrowth: 30, hackDifficulty: 0 }, player())).toBe(0);
  });
});
