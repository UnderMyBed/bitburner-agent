// The next BitNode (#321, owner decision 66): the campaign's draft order, BN4 ×3 after BN1.1, then BN1, then a replay.
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import {
  CAMPAIGN_ORDER,
  nextBitNodeOf,
  REPLAY_BITNODE,
  SOURCE_FILE_TOP_LEVEL,
  sourceFilesAfterDestroy,
} from "../src/campaign-order.ts";

const gameSource = (file: string) =>
  readFileSync(new URL(`../../../vendor/bitburner-src/src/${file}`, import.meta.url), "utf8");

const REPLAY = "the campaign's order has nothing left to gain (Source-File 1 at 3, Source-File 4 at 3), but the run";

test("the order is the synthesis's first three rows: BN1.1, BN4 ×3, BN1 to 3; the replay is BN1's", () => {
  expect(CAMPAIGN_ORDER).toEqual([
    { bitNode: 1, level: 1 },
    { bitNode: 4, level: 3 },
    { bitNode: 1, level: 3 },
  ]);
  expect(REPLAY_BITNODE).toBe(1);
  const synthesis = readFileSync(new URL("../../../docs/synthesis.md", import.meta.url), "utf8");
  expect(synthesis).toContain("| 1 | BN1.1 | Forced start.");
  expect(synthesis).toContain("| 2 | BN4 ×3 | Singularity at ×1 RAM");
  expect(synthesis).toContain("| 3 | BN1.2–1.3 | Easiest clears");
});

test("a destroy raises its own Source-File a level, to the top but for BN12's, as the game's giveSourceFile does", () => {
  const redPill = gameSource("RedPill.tsx");
  expect(redPill).toContain("if (lvl >= 3 && bitNodeNumber !== 12) {");
  expect(redPill).toContain("Player.sourceFiles.set(bitNodeNumber, 1);");
  expect(SOURCE_FILE_TOP_LEVEL).toBe(3);
  expect(sourceFilesAfterDestroy(1, {})).toEqual({ 1: 1 });
  expect(sourceFilesAfterDestroy(4, { 1: 3, 4: 1 })).toEqual({ 1: 3, 4: 2 });
  expect(sourceFilesAfterDestroy(1, { 1: 3 })).toEqual({ 1: 3 });
  expect(sourceFilesAfterDestroy(12, { 12: 7 })).toEqual({ 12: 8 });
});

test.each([
  ["BN1.1 (a fresh save)", 1, {}, 4],
  ["BN1.2", 1, { 1: 1 }, 4],
  ["BN1.4 at the cap (today's replay)", 1, { 1: 3 }, 4],
  ["BN4.1, from BN1.4", 4, { 1: 3 }, 4],
  ["BN4.2", 4, { 1: 3, 4: 1 }, 4],
  ["BN4.1 from BN1.2: SF1 short of 3 still", 4, { 1: 1 }, 4],
  ["BN4.3 from BN1.2: then BN1, for SF1's levels", 4, { 1: 1, 4: 2 }, 1],
  ["BN1.2 with SF4.3 (the legacy baseline's)", 1, { 1: 1, 4: 3 }, 1],
  ["another BitNode, the order short", 2, { 1: 3 }, 4],
])("%s: into the BitNode given", (_name, currentNode, ownedSF, next) => {
  expect(nextBitNodeOf({ currentNode, ownedSF })).toEqual({ bitNode: next, replay: null });
});

test("nothing left in the order to gain: BN1 again, a replay saying why, from BN1 or BN4 at the caps", () => {
  expect(nextBitNodeOf({ currentNode: 1, ownedSF: { 1: 3, 4: 3 } })).toEqual({ bitNode: 1, replay: REPLAY });
  expect(nextBitNodeOf({ currentNode: 4, ownedSF: { 1: 3, 4: 3 } })).toEqual({ bitNode: 1, replay: REPLAY });
  // BN4.3 destroyed after BN1.4: SF4 reaches 3 by this destroy, SF1 is there already.
  expect(nextBitNodeOf({ currentNode: 4, ownedSF: { 1: 3, 4: 2 } })).toEqual({ bitNode: 1, replay: REPLAY });
  // BN1.3 destroyed with SF4 at 3: SF1 reaches 3 by this destroy, so nothing is left.
  expect(nextBitNodeOf({ currentNode: 1, ownedSF: { 1: 2, 4: 3 } })).toEqual({ bitNode: 1, replay: REPLAY });
  expect(nextBitNodeOf({ currentNode: 5, ownedSF: { 1: 3, 4: 3 } }).replay).toBe(REPLAY);
});
