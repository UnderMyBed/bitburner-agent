// Destroying a BitNode (#175): the BitNodes a destroy can enter, The Red Pill, and w0r1d_d43m0n's preconditions.
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { AUGMENTATION_NAMES } from "../src/augmentations.ts";
import { BITNODE_COUNT, isBitNodeNumber, THE_RED_PILL, worldDaemonProblem } from "../src/bitnodes.ts";

const gameSource = (file: string) =>
  readFileSync(new URL(`../../../vendor/bitburner-src/src/${file}`, import.meta.url), "utf8");

test("the BitNodes a destroy can enter are the pinned game's: 1 to 15", () => {
  expect(gameSource("BitNode/Constants.ts")).toContain(
    `export const validBitNodes = [${Array.from({ length: BITNODE_COUNT }, (_, index) => index + 1).join(", ")}];`,
  );
  expect([1, 2, 15].every(isBitNodeNumber)).toBe(true);
  expect([0, 16, 1.5, "2", null, Number.NaN].some(isBitNodeNumber)).toBe(false);
});

test("The Red Pill is the game's, and the install that links w0r1d_d43m0n checks it", () => {
  expect(AUGMENTATION_NAMES).toContain(THE_RED_PILL);
  expect(gameSource("Augmentation/Enums.ts")).toContain(`TheRedPill = "${THE_RED_PILL}",`);
  expect(gameSource("Prestige.ts")).toContain("if (Player.hasAugmentation(AugmentationName.TheRedPill, true)) {");
});

test("worldDaemonProblem: unreachable, then no root, then the level, each saying why; none once all hold", () => {
  expect(worldDaemonProblem(null)).toBe("w0r1d_d43m0n isn't reachable: The Red Pill isn't installed");
  expect(worldDaemonProblem({ rooted: false, hackingLevel: 1, requiredHackingLevel: 3000 })).toBe(
    "no root access on w0r1d_d43m0n (NUKE.exe first)",
  );
  expect(worldDaemonProblem({ rooted: true, hackingLevel: 2999, requiredHackingLevel: 3000 })).toBe(
    "hacking level 2999: w0r1d_d43m0n needs 3000",
  );
  expect(worldDaemonProblem({ rooted: true, hackingLevel: 3000, requiredHackingLevel: 3000 })).toBeNull();
  // BN2's difficulty is 5: 15000 (`Server/ServerHelpers.ts:383-385`).
  expect(worldDaemonProblem({ rooted: true, hackingLevel: 14999, requiredHackingLevel: 15000 })).toBe(
    "hacking level 14999: w0r1d_d43m0n needs 15000",
  );
});
