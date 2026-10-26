import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { gameDrift, PINNED_GAME } from "../src/index.ts";

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

describe("gameDrift: how the game the Agent reports differs from the pinned one", () => {
  const pinned = { version: "3.0.1", versionNumber: 51, commit: "1da7316ff", platform: "Steam" };

  test("none for the pinned game, its commit abbreviated to any length from 7, on either platform", () => {
    expect(gameDrift(pinned)).toBeNull();
    expect(gameDrift({ ...pinned, commit: "1da7316" })).toBeNull();
    expect(gameDrift({ ...pinned, commit: "1da7316ffd9d281b45a86c4c54ec532276557892" })).toBeNull();
    expect(gameDrift({ ...pinned, platform: "Browser" })).toBeNull();
  });

  test("another version number or commit, or a commit too short to tell, is drift, and says what differs", () => {
    expect(gameDrift({ ...pinned, versionNumber: 52 })).toBe("versionNumber 52, pinned 51");
    expect(gameDrift({ ...pinned, commit: "1da7317ff" })).toBe("commit 1da7317ff, pinned 1da7316ff");
    expect(gameDrift({ ...pinned, commit: "1da731" })).toBe("commit 1da731, pinned 1da7316ff");
    expect(gameDrift({ ...pinned, commit: "DEV" })).toBe("commit DEV, pinned 1da7316ff");
  });
});
