import { expect, test } from "vitest";
import {
  BOOT_SCRIPT,
  CURRENT_DEPLOYMENT_FILE,
  DEPLOYMENT_ROOT,
  deployedFilePath,
  deploymentIdOfPath,
  isValidDeploymentId,
  parseAgentConfig,
} from "../src/deploy-layout.ts";

test("every path is under the deployment root", () => {
  expect(CURRENT_DEPLOYMENT_FILE.startsWith(`${DEPLOYMENT_ROOT}/`)).toBe(true);
  expect(BOOT_SCRIPT.startsWith(`${DEPLOYMENT_ROOT}/`)).toBe(true);
  expect(deployedFilePath("0123abcd", "agent.js")).toBe("agent/0123abcd/agent.js");
});

test("the Agent's config: a valid deployment id and port, or a reason", () => {
  expect(parseAgentConfig(JSON.stringify({ deploymentId: "abc123", controlPort: 12526 }))).toEqual({
    ok: true,
    config: { deploymentId: "abc123", controlPort: 12526 },
  });
  for (const [text, reason] of [
    ["{", "not JSON"],
    ["", "not JSON"],
    ["null", "no valid deploymentId"],
    [JSON.stringify({ controlPort: 1 }), "no valid deploymentId"],
    [JSON.stringify({ deploymentId: 7, controlPort: 1 }), "no valid deploymentId"],
    [JSON.stringify({ deploymentId: "../x", controlPort: 1 }), "no valid deploymentId"],
    [JSON.stringify({ deploymentId: "a" }), "no valid controlPort"],
    [JSON.stringify({ deploymentId: "a", controlPort: 0 }), "no valid controlPort"],
    [JSON.stringify({ deploymentId: "a", controlPort: 65536 }), "no valid controlPort"],
    [JSON.stringify({ deploymentId: "a", controlPort: 1.5 }), "no valid controlPort"],
    [JSON.stringify({ deploymentId: "a", controlPort: "12526" }), "no valid controlPort"],
  ]) {
    expect(parseAgentConfig(text as string), text).toEqual({ ok: false, reason });
  }
  expect(parseAgentConfig(JSON.stringify({ deploymentId: "a", controlPort: 65535 })).ok).toBe(true);
});

test("a deployed file's path gives its deployment", () => {
  expect(deploymentIdOfPath("agent/abc123/agent.js")).toBe("abc123");
  expect(deploymentIdOfPath("/agent/abc123/agent.js")).toBe("abc123");
  expect(deploymentIdOfPath("agent/boot.js")).toBeNull();
  expect(deploymentIdOfPath("other/abc123/agent.js")).toBeNull();
  expect(deploymentIdOfPath("agent/abc123/nested/agent.js")).toBeNull();
  expect(deploymentIdOfPath("agent/bad id/agent.js")).toBeNull();
});

test("a deployment id is a plain folder name, never a path", () => {
  for (const valid of ["0123abcd", "deployment_1", "a-b"]) expect(isValidDeploymentId(valid), valid).toBe(true);
  for (const invalid of ["", "bad id", "/abs", "../x", "a/b", "a.b", "a\nb"]) {
    expect(isValidDeploymentId(invalid), JSON.stringify(invalid)).toBe(false);
  }
});
