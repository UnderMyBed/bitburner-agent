import { expect, test } from "vitest";
import { isGeneratedDeploymentId } from "../src/deploy-layout.ts";
import {
  HACK_LOOP_MONEY_FRACTION,
  HACK_LOOP_SECURITY_MARGIN,
  hackLoopDeployArguments,
  hackLoopTargetsByHost,
  isHackLoopFile,
  isHackLoopReady,
} from "../src/hack-loop.ts";

test("a hack loop is ours only in a folder the deployer generated, so a player's own agent/<name>/ is never touched", () => {
  expect(isHackLoopFile("agent/0123456789ab/hack-loop.js")).toBe(true);
  expect(isHackLoopFile("/agent/0123456789ab/hack-loop.js")).toBe(true);
  expect(isHackLoopFile("agent/mine/hack-loop.js")).toBe(false);
  expect(isHackLoopFile("agent/0123456789AB/hack-loop.js")).toBe(false);
  expect(isHackLoopFile("agent/0123456789ab/agent.js")).toBe(false);
  expect(isHackLoopFile("hack-loop.js")).toBe(false);
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

test("the deploy worker's arguments (#184): each host with its own target, read back as they were", () => {
  const hackLoop = {
    enabled: true,
    target: "n00dles",
    hosts: ["foodnstuff", "n00dles"],
    preparing: { target: "zer0", hosts: ["max-hardware"] },
  };
  const args = hackLoopDeployArguments(hackLoop);
  expect(args).toEqual([true, "foodnstuff", "n00dles", "n00dles", "n00dles", "max-hardware", "zer0"]);
  expect([...hackLoopTargetsByHost(args)]).toEqual([
    ["foodnstuff", "n00dles"],
    ["n00dles", "n00dles"],
    ["max-hardware", "zer0"],
  ]);
  expect(hackLoopDeployArguments({ ...hackLoop, preparing: null })).toEqual([
    true,
    "foodnstuff",
    "n00dles",
    "n00dles",
    "n00dles",
  ]);
  // Off, or no target: no host runs it.
  for (const none of [
    { ...hackLoop, enabled: false },
    { ...hackLoop, target: null, preparing: null },
  ]) {
    const noneArgs = hackLoopDeployArguments(none);
    expect(hackLoopTargetsByHost(noneArgs).size).toBe(0);
  }
  expect(hackLoopTargetsByHost([false, "n00dles", "n00dles"]).size).toBe(0);
});
