import { expect, test } from "vitest";
import {
  BOOT_SCRIPT,
  CURRENT_DEPLOYMENT_FILE,
  DEPLOYMENT_ROOT,
  deployedFilePath,
  isValidDeploymentId,
} from "../src/deploy-layout.ts";

test("every path is under the deployment root", () => {
  expect(CURRENT_DEPLOYMENT_FILE.startsWith(`${DEPLOYMENT_ROOT}/`)).toBe(true);
  expect(BOOT_SCRIPT.startsWith(`${DEPLOYMENT_ROOT}/`)).toBe(true);
  expect(deployedFilePath("0123abcd", "agent.js")).toBe("agent/0123abcd/agent.js");
});

test("a deployment id is a plain folder name, never a path", () => {
  for (const valid of ["0123abcd", "deployment_1", "a-b"]) expect(isValidDeploymentId(valid), valid).toBe(true);
  for (const invalid of ["", "bad id", "/abs", "../x", "a/b", "a.b", "a\nb"]) {
    expect(isValidDeploymentId(invalid), JSON.stringify(invalid)).toBe(false);
  }
});
