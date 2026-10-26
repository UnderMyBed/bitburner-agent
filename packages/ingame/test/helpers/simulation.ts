import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SimulationOptions } from "@bitburner-agent/sim";
import { afterAll } from "vitest";
import { type BundleManifest, buildInGameBundles } from "../../scripts/bundles.ts";

export { useSimulations } from "@bitburner-agent/sim/test-helpers";

export const NEW_GAME: SimulationOptions = {
  seed: 1,
  epochMs: Date.UTC(2026, 0, 1),
  fixture: { kind: "new", tutorial: "skipped" },
};

/** Builds the in-game bundles once for a test file, into a temporary directory removed when the file ends. */
export function useInGameBuild(): () => Promise<{ manifest: BundleManifest; source(fileName: string): string }> {
  let built: Promise<{ manifest: BundleManifest; source(fileName: string): string }> | undefined;
  const outputDirectory = mkdtempSync(path.join(os.tmpdir(), "ingame-build-"));
  afterAll(() => rmSync(outputDirectory, { recursive: true, force: true }));
  return () => {
    built ??= buildInGameBundles({ outputDirectory }).then((manifest) => ({
      manifest,
      source: (fileName: string) => readFileSync(path.join(outputDirectory, fileName), "utf8"),
    }));
    return built;
  };
}
