import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Simulation, type SimulationOptions } from "@bitburner-agent/sim";
import { afterAll, afterEach } from "vitest";
import { type BundleManifest, buildInGameBundles } from "../../scripts/bundles.ts";

/** Starts simulations for a test file, closing each test's when that test ends. Call at the file's top level. */
export function useSimulations(): (options: SimulationOptions) => Promise<Simulation> {
  const open: Simulation[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((simulation) => simulation.close()));
  });
  return async (options) => {
    const simulation = await Simulation.start(options);
    open.push(simulation);
    return simulation;
  };
}

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
    built ??= buildInGameBundles(outputDirectory).then((manifest) => ({
      manifest,
      source: (fileName: string) => readFileSync(path.join(outputDirectory, fileName), "utf8"),
    }));
    return built;
  };
}
