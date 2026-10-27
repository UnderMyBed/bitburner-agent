import { expect, test } from "vitest";
import { isGeneratedDeploymentId } from "../src/deploy-layout.ts";
import { isHackLoopFile } from "../src/hack-loop.ts";

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
