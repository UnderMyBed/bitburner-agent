// What the brain deploys (#91): the in-game build (which the brain makes at start, packages/ingame), its RAM budgets,
// and the pinned game's definition file for the version check.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { InGameBuild } from "@bitburner-agent/bridge";

const PACKAGES_DIRECTORY = path.resolve(import.meta.dirname, "../..");
export const RAM_BUDGET_FILE = path.join(PACKAGES_DIRECTORY, "ingame/ram-budget.json");
export const PINNED_DEFINITIONS_FILE = path.resolve(
  PACKAGES_DIRECTORY,
  "../vendor/bitburner-src/src/ScriptEditor/NetscriptDefinitions.d.ts",
);

/**
 * The build its manifest lists, each file checked against the manifest's hash, so a half-written or edited dist is
 * refused rather than deployed.
 */
export function readInGameBuild(distDirectory: string, ramBudgetFile = RAM_BUDGET_FILE): InGameBuild {
  const manifest = JSON.parse(readFileSync(path.join(distDirectory, "manifest.json"), "utf8")) as {
    files: Record<string, { sha256: string }>;
  };
  const scripts: Record<string, string> = {};
  for (const [fileName, { sha256 }] of Object.entries(manifest.files)) {
    const content = readFileSync(path.join(distDirectory, fileName), "utf8");
    if (createHash("sha256").update(content).digest("hex") !== sha256) {
      throw new Error(`${path.join(distDirectory, fileName)} doesn't match the build's manifest: build again`);
    }
    scripts[fileName] = content;
  }
  return { scripts, ramBudgets: JSON.parse(readFileSync(ramBudgetFile, "utf8")) };
}

export function readPinnedDefinitions(definitionsFile = PINNED_DEFINITIONS_FILE): string {
  return readFileSync(definitionsFile, "utf8");
}
