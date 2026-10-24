import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { PINNED_GAME } from "../src/index.ts";

// Contract: the version we claim to target is the game source we actually test against (ADR 0003).
const gameSrc = fileURLToPath(new URL("../../../vendor/bitburner-src", import.meta.url));

function gameConstant(name: string): string {
  const constants = readFileSync(`${gameSrc}/src/Constants.ts`, "utf8");
  const match = constants.match(new RegExp(`^\\s*${name}:\\s*"?([^",]+)"?,`, "m"));
  if (!match?.[1]) throw new Error(`${name} not found in the pinned game's Constants.ts`);
  return match[1];
}

describe("PINNED_GAME", () => {
  test("matches the version constants of the pinned game source", () => {
    expect(PINNED_GAME.versionString).toBe(gameConstant("VersionString"));
    expect(PINNED_GAME.versionNumber).toBe(Number(gameConstant("VersionNumber")));
  });

  test("matches the commit the submodule is pinned to", () => {
    const head = execFileSync("git", ["-C", gameSrc, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    expect(head.slice(0, PINNED_GAME.commit.length)).toBe(PINNED_GAME.commit);
  });
});
