// The next BitNode (#321, owner decision 66; the whole order since #323): the campaign's draft order, the first step
// with a level to gain that the brain can play, then a replay.
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import {
  BITNODE_BLACK_OPS_ESTIMATE_REASON,
  BITNODE_NO_WIN_ROUTE_REASON,
  bitNodeUnplayableReason,
} from "../src/bitnodes.ts";
import {
  CAMPAIGN_ORDER,
  describeSkipped,
  nextBitNodeOf,
  REPLAY_BITNODE,
  SOURCE_FILE_TOP_LEVEL,
  sourceFilesAfterDestroy,
} from "../src/campaign-order.ts";

const gameSource = (file: string) =>
  readFileSync(new URL(`../../../vendor/bitburner-src/src/${file}`, import.meta.url), "utf8");

const NO_DATA = "no hacking multipliers or prices yet";
/**
 * BN6's and BN7's (#367): core has their tables; BN6's route is built (#398), its estimate with installs past the bar (#404), BN7's
 * is B8's.
 */
const NO_ROUTE = BITNODE_NO_WIN_ROUTE_REASON;
const PAST_THE_BAR = BITNODE_BLACK_OPS_ESTIMATE_REASON;
/** Every BitNode the order holds that the brain can't play yet, in the order's sequence (BN2 playable since #334). */
const UNPLAYABLE = [6, 7, 3, 9, 11, 8, 15, 10, 13, 14, 12];
/** Why each is skipped: BN6 and BN7 for the win route (#367), the rest for core's tables. */
const reasonOf = (bitNode: number) => (bitNode === 6 ? PAST_THE_BAR : bitNode === 7 ? NO_ROUTE : NO_DATA);
const REPLAY =
  "the campaign's order has nothing playable left to gain (Source-File 1 at 3, Source-File 2 at 3, " +
  "Source-File 4 at 3, Source-File 5 at 3), but the run";
const CAPS = { 1: 3, 2: 3, 4: 3, 5: 3 };
const skippedAll = UNPLAYABLE.map((bitNode) => ({ bitNode, reason: reasonOf(bitNode) }));
/** Every BitNode playable: the order as it'll be once the brain plays them all. */
const allPlayable = () => null;

test("the order is synthesis §3's whole draft, row by row, each to level 3 but BN1.1, BN5 ×1 and BN12 to 50", () => {
  expect(CAMPAIGN_ORDER).toEqual([
    { bitNode: 1, level: 1, row: 1 },
    { bitNode: 4, level: 3, row: 2 },
    { bitNode: 1, level: 3, row: 3 },
    { bitNode: 5, level: 1, row: 4 },
    { bitNode: 2, level: 3, row: 5 },
    { bitNode: 6, level: 3, row: 6 },
    { bitNode: 7, level: 3, row: 6 },
    { bitNode: 3, level: 3, row: 7 },
    { bitNode: 5, level: 3, row: 8 },
    { bitNode: 9, level: 3, row: 8 },
    { bitNode: 11, level: 3, row: 8 },
    { bitNode: 8, level: 3, row: 8 },
    { bitNode: 15, level: 3, row: 8 },
    { bitNode: 10, level: 3, row: 8 },
    { bitNode: 13, level: 3, row: 9 },
    { bitNode: 14, level: 3, row: 9 },
    { bitNode: 12, level: 50, row: 10 },
  ]);
  expect(REPLAY_BITNODE).toBe(1);
  // Each step names its row, and the row names its BitNode, in the order the row lists them; every row is cited.
  const synthesis = readFileSync(new URL("../../../docs/synthesis.md", import.meta.url), "utf8");
  const rows = new Map(
    [...synthesis.matchAll(/^\| (\d+) \| ([^|]+) \|/gm)].map((match) => [Number(match[1]), match[2] as string]),
  );
  expect([...rows.keys()]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  expect(new Set(CAMPAIGN_ORDER.map((step) => step.row))).toEqual(new Set(rows.keys()));
  for (const [row, nodes] of rows) {
    const named = [...nodes.matchAll(/BN(\d+)/g)].map((match) => Number(match[1]));
    expect(CAMPAIGN_ORDER.filter((step) => step.row === row).map((step) => step.bitNode)).toEqual(named);
  }
  expect(rows.get(4)).toBe("BN5 ×1");
  expect(rows.get(8)).toContain("BN5.2–3");
  // The goal's levels (owner decision 1): SF1-11 and SF13-15 at 3, SF12 to 50 (CHALLENGE_BN12).
  const decisions = readFileSync(new URL("../../../docs/decisions/owner-decisions.md", import.meta.url), "utf8");
  expect(decisions).toContain("SF1–11 and SF13–15 at level 3; SF12 to level 50 (CHALLENGE_BN12)");
  const tops = new Map(CAMPAIGN_ORDER.map((step) => [step.bitNode, step.level]));
  expect([...tops.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  for (const [bitNode, level] of tops) expect(level).toBe(bitNode === 12 ? 50 : SOURCE_FILE_TOP_LEVEL);
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

test("playable: BN1, BN2, BN4 and BN5, whose hacking multipliers and prices core has; the rest say what's missing", () => {
  expect([1, 2, 4, 5].map(bitNodeUnplayableReason)).toEqual([null, null, null, null]);
  expect(UNPLAYABLE.map(bitNodeUnplayableReason)).toEqual(UNPLAYABLE.map(reasonOf));
});

test.each([
  ["BN1.1 (a fresh save)", 1, {}, 4],
  ["BN1.2", 1, { 1: 1 }, 4],
  ["BN1.4 at the cap", 1, { 1: 3 }, 4],
  ["BN4.1, from BN1.4", 4, { 1: 3 }, 4],
  ["BN4.2", 4, { 1: 3, 4: 1 }, 4],
  ["BN4.1 from BN1.2: SF1 short of 3 still", 4, { 1: 1 }, 4],
  ["BN4.3 from BN1.2: then BN1, for SF1's levels", 4, { 1: 1, 4: 2 }, 1],
  ["BN1.2 with SF4.3 (the legacy baseline's)", 1, { 1: 1, 4: 3 }, 1],
  ["BN4.3 after BN1.4 (#321's replay): into BN5", 4, { 1: 3, 4: 2 }, 5],
  ["BN1.3 with SF4.3: into BN5", 1, { 1: 2, 4: 3 }, 5],
  // #334: BN2 playable, BN5.1 goes into it, synthesis §3's row 5, three times.
  ["BN5.1: into BN2", 5, { 1: 3, 4: 3 }, 2],
  ["BN2.1: into BN2 again", 2, { 1: 3, 4: 3, 5: 1 }, 2],
  ["BN2.2: into BN2 again", 2, { 1: 3, 4: 3, 5: 1, 2: 1 }, 2],
  ["another BitNode, the order short", 3, { 1: 3 }, 4],
])("%s: into the BitNode given, nothing skipped before it", (_name, currentNode, ownedSF, next) => {
  expect(nextBitNodeOf({ currentNode, ownedSF })).toEqual({ bitNode: next, replay: null, skipped: [] });
});

test("skipping: past BN2 ×3, the unplayable rows before BN5.2-3 are skipped, each said with why", () => {
  // BN2.3 destroyed: BN6, BN7 and BN3 come first, and the brain plays none, so BN5 again, row 8's. BN6 and BN7 (#367)
  // for want of a win route only: core has their tables now.
  const skipped = [6, 7, 3].map((bitNode) => ({ bitNode, reason: reasonOf(bitNode) }));
  expect(nextBitNodeOf({ currentNode: 2, ownedSF: { 1: 3, 4: 3, 5: 1, 2: 2 } })).toEqual({
    bitNode: 5,
    replay: null,
    skipped,
  });
  expect(describeSkipped(skipped)).toBe(
    `BN6 skipped: ${PAST_THE_BAR}; BN7 skipped: ${NO_ROUTE}; BN3 skipped: ${NO_DATA}`,
  );
  // A save with SF2.3 already: BN5.1 has nothing to gain in BN2, never said as skipped.
  expect(nextBitNodeOf({ currentNode: 5, ownedSF: { 1: 3, 4: 3, 2: 3 } })).toEqual({
    bitNode: 5,
    replay: null,
    skipped,
  });
  // Without BN5's data, BN4.3 skips it into BN2, BN5 said.
  const noBn5 = (bitNode: number) => (bitNode === 5 ? "no prices yet" : bitNodeUnplayableReason(bitNode));
  expect(nextBitNodeOf({ currentNode: 4, ownedSF: { 1: 3, 4: 2 }, unplayable: noBn5 })).toEqual({
    bitNode: 2,
    replay: null,
    skipped: [{ bitNode: 5, reason: "no prices yet" }],
  });
  // And with BN2 at its level too, a replay: each skipped once, though BN5 is in two rows; runs said together.
  const next = nextBitNodeOf({ currentNode: 4, ownedSF: { 1: 3, 2: 3, 4: 2 }, unplayable: noBn5 });
  expect(next.bitNode).toBe(1);
  expect(next.skipped.map((each) => each.bitNode)).toEqual([5, ...UNPLAYABLE]);
  expect(describeSkipped(next.skipped.slice(0, 3))).toBe(
    `BN5 skipped: no prices yet; BN6 skipped: ${PAST_THE_BAR}; BN7 skipped: ${NO_ROUTE}`,
  );
  expect(describeSkipped([])).toBeNull();
});

test("the cap: SF12 to 50, uncapped; every other Source-File to 3, then the next step", () => {
  const threes = Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14, 15].map((bitNode) => [bitNode, 3]));
  const into = (currentNode: number, ownedSF: Record<number, number>) =>
    nextBitNodeOf({ currentNode, ownedSF, unplayable: allPlayable });
  expect(into(14, { ...threes, 14: 2 })).toEqual({ bitNode: 12, replay: null, skipped: [] });
  expect(into(12, { ...threes, 12: 48 })).toEqual({ bitNode: 12, replay: null, skipped: [] });
  expect(into(12, { ...threes, 12: 49 }).bitNode).toBe(1);
  expect(into(12, { ...threes, 12: 49 }).replay).toContain("Source-File 12 at 50, Source-File 13 at 3");
  // At 3, BN13's destroy gives no more: on to BN14.
  expect(into(13, { ...threes, 14: 0 })).toEqual({ bitNode: 14, replay: null, skipped: [] });
  // Each BitNode in the order, playable, is entered in turn from a fresh save's SF1.1.
  const seen: number[] = [];
  let ownedSF: Record<string, number> = {};
  let current = 1;
  for (let destroys = 0; destroys < 200; destroys++) {
    const next = nextBitNodeOf({ currentNode: current, ownedSF, unplayable: allPlayable });
    ownedSF = sourceFilesAfterDestroy(current, ownedSF);
    if (next.replay !== null) break;
    if (seen.at(-1) !== next.bitNode) seen.push(next.bitNode);
    current = next.bitNode;
  }
  expect(seen).toEqual([4, 1, 5, 2, 6, 7, 3, 5, 9, 11, 8, 15, 10, 13, 14, 12]);
  expect(ownedSF[12]).toBe(50);
});

test("nothing playable left to gain: BN1 again, a replay saying why and what was skipped, from any BitNode", () => {
  for (const [currentNode, ownedSF] of [
    [1, CAPS],
    [4, CAPS],
    [5, CAPS],
    // BN5.3 destroyed: SF5 reaches 3 by this destroy.
    [5, { 1: 3, 2: 3, 4: 3, 5: 2 }],
    // BN2.3 destroyed after BN5.3: SF2 reaches 3 by this destroy.
    [2, { 1: 3, 2: 2, 4: 3, 5: 3 }],
    [2, CAPS],
  ] as const) {
    expect(nextBitNodeOf({ currentNode, ownedSF })).toEqual({ bitNode: 1, replay: REPLAY, skipped: skippedAll });
  }
  expect(describeSkipped(skippedAll)).toBe(
    `BN6 skipped: ${PAST_THE_BAR}; BN7 skipped: ${NO_ROUTE}; BN3, BN9, BN11, BN8, BN15, BN10, BN13, BN14 and BN12 skipped: ${NO_DATA}`,
  );
});
