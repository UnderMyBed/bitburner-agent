import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PINNED_GAME } from "@bitburner-agent/core";
import { describe, expect, test } from "vitest";
import { buildEngine, checkVendorInstall, type EngineInputs, engineFingerprint } from "../src/engine/build.ts";
import { enginePaths } from "../src/engine/paths.ts";

const inputs: EngineInputs = {
  vendorCommit: "1da7316ff",
  buildScript: "build v1",
  entrySources: { "entry.ts": "export const a = 1;", "stubs/empty.js": "export default {};" },
  esbuildVersion: "0.28.2",
};

describe("engineFingerprint", () => {
  test("is stable for equal inputs, regardless of source order", () => {
    const reordered = {
      ...inputs,
      entrySources: { "stubs/empty.js": "export default {};", "entry.ts": "export const a = 1;" },
    };
    expect(engineFingerprint(reordered)).toBe(engineFingerprint(inputs));
  });

  test.each([
    ["vendor commit", { vendorCommit: "abc" }],
    ["build script", { buildScript: "build v2" }],
    ["entry source content", { entrySources: { ...inputs.entrySources, "entry.ts": "export const a = 2;" } }],
    ["entry source set", { entrySources: { ...inputs.entrySources, "extra.ts": "" } }],
    ["esbuild version", { esbuildVersion: "0.28.3" }],
  ])("changes when the %s changes", (_, change) => {
    expect(engineFingerprint({ ...inputs, ...change })).not.toBe(engineFingerprint(inputs));
  });
});

describe("checkVendorInstall", () => {
  test("names the setup command when the game's dependencies are missing", () => {
    const empty = mkdtempSync(path.join(tmpdir(), "no-vendor-"));
    expect(() => checkVendorInstall(empty)).toThrow(/npm run setup:engine/);
  });
});

describe("engine bundle", () => {
  // The global setup has already built the bundle, so this build must be skipped.
  test("is not rebuilt when its inputs are unchanged", async () => {
    const started = performance.now();
    const result = await buildEngine();
    expect(result.skipped).toBe(true);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  const helper = path.join(import.meta.dirname, "helpers", "load-engine.ts");

  test("loads in plain Node under the DOM environment and reports the pinned game version", () => {
    const out = execFileSync(process.execPath, [helper], { encoding: "utf8", timeout: 60_000 });
    expect(JSON.parse(out)).toEqual({ versionNumber: PINNED_GAME.versionNumber });
  });

  test("does not load without the DOM environment", () => {
    expect(() =>
      execFileSync(process.execPath, [helper, "--no-dom"], { encoding: "utf8", stdio: "pipe", timeout: 60_000 }),
    ).toThrow(/ReferenceError: \w+ is not defined/);
  });

  test("bundles the whole game through the game-module mapping", () => {
    const meta = JSON.parse(readFileSync(enginePaths.meta, "utf8")) as {
      report: { gameFiles: number; packages: string[] };
    };
    expect(meta.report.gameFiles).toBeGreaterThan(500);
    expect(meta.report.packages).toContain("react");
  });
});
