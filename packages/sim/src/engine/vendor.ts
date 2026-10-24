// The game's own dependencies, installed from its lockfile into the submodule by `npm run setup:engine`.
// Setup writes a stamp recording which lockfile it installed, so a stale or half-finished install is caught.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const SETUP_COMMAND = "npm run setup:engine";
const stampPath = (gameRoot: string) => path.join(gameRoot, "node_modules", ".bitburner-agent-setup.json");

export function lockfileHash(gameRoot: string): string {
  return createHash("sha256")
    .update(readFileSync(path.join(gameRoot, "package-lock.json")))
    .digest("hex");
}

/** Called by setup after a successful install (npm ci deletes node_modules first, so a failed install has no stamp). */
export function writeSetupStamp(gameRoot: string): void {
  writeFileSync(stampPath(gameRoot), `${JSON.stringify({ lockfile: lockfileHash(gameRoot) })}\n`);
}

export function checkVendorInstall(gameRoot: string): void {
  if (!existsSync(stampPath(gameRoot))) {
    throw new Error(`The game's dependencies are not installed in ${gameRoot}. Run: ${SETUP_COMMAND}`);
  }
  const stamp = JSON.parse(readFileSync(stampPath(gameRoot), "utf8")) as { lockfile?: string };
  if (stamp.lockfile !== lockfileHash(gameRoot)) {
    throw new Error(
      `The game's dependencies in ${gameRoot} are out of date: its lockfile changed since setup. Run: ${SETUP_COMMAND}`,
    );
  }
}
