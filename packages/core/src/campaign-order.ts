/**
 * The next BitNode (#321, owner decision 66; the whole order since #323): the campaign's draft order
 * (docs/synthesis.md §3), each step entered only if the brain can play its BitNode. A destroy gives the destroyed
 * BitNode's Source-File a level, up to `SOURCE_FILE_TOP_LEVEL` but for BN12's (`RedPill.tsx:16-52`, `giveSourceFile`),
 * then enters the BitNode chosen (`RedPill.tsx:54-66`, `enterBitNode`), so the next is chosen from the Source-Files as
 * they'll be after it: the first step of the order still short of its level whose BitNode is playable (core has its
 * hacking multipliers and prices, `bitNodeUnplayableReason`), the unplayable ones before it said. With none, BitNode 1
 * is played again for the run (#311's replay).
 */
import { bitNodeUnplayableReason, listedBitNodes } from "./bitnodes.ts";

/** A Source-File's top level but for BN12's, which has none: destroying its BitNode again gives no level. */
export const SOURCE_FILE_TOP_LEVEL = 3;
/** BitNode 12's Source-File has no top level (`RedPill.tsx:28`). */
export const UNCAPPED_SOURCE_FILE = 12;

/** A step of the order: play `bitNode` until its Source-File is at `level`; `row` is synthesis §3's. */
export interface CampaignStep {
  bitNode: number;
  level: number;
  row: number;
}

/**
 * Synthesis §3's draft order, row by row. A row with no count plays its BitNodes to the goal's level (owner decision 1:
 * SF1-11 and SF13-15 at 3, SF12 to 50, CHALLENGE_BN12).
 */
export const CAMPAIGN_ORDER: readonly CampaignStep[] = [
  { bitNode: 1, level: 1, row: 1 }, // BN1.1: the forced start
  { bitNode: 4, level: 3, row: 2 }, // BN4 ×3: Singularity at ×1 RAM
  { bitNode: 1, level: 3, row: 3 }, // BN1.2-1.3: the easiest clears
  { bitNode: 5, level: 1, row: 4 }, // BN5 ×1: intelligence, the BitNode multipliers
  { bitNode: 2, level: 3, row: 5 }, // BN2 ×3: gangs
  { bitNode: 6, level: 3, row: 6 }, // BN6/BN7 ×3: Bladeburner
  { bitNode: 7, level: 3, row: 6 },
  { bitNode: 3, level: 3, row: 7 }, // BN3 ×3: corporations
  { bitNode: 5, level: 3, row: 8 }, // the mid tier: BN5.2-3, BN9, BN11, BN8, BN15, BN10
  { bitNode: 9, level: 3, row: 8 },
  { bitNode: 11, level: 3, row: 8 },
  { bitNode: 8, level: 3, row: 8 },
  { bitNode: 15, level: 3, row: 8 },
  { bitNode: 10, level: 3, row: 8 },
  { bitNode: 13, level: 3, row: 9 }, // the hardest: BN13, BN14
  { bitNode: 14, level: 3, row: 9 },
  { bitNode: 12, level: 50, row: 10 }, // BN12: SF12 to 50
];

/** The BitNode played again once nothing playable in the order has a level to gain (#311): BN1, the brain's first. */
export const REPLAY_BITNODE = 1;

/** A BitNode of the order passed over: it has a level to gain, but the brain can't play it yet, and why. */
export interface SkippedBitNode {
  bitNode: number;
  reason: string;
}

/**
 * The next BitNode; why it's a replay (nothing playable in the order left to gain), or null; and the BitNodes skipped
 * on the way to it, in the order's sequence.
 */
export interface NextBitNode {
  bitNode: number;
  replay: string | null;
  skipped: SkippedBitNode[];
}

/**
 * The Source-Files after destroying `currentNode`: its own a level up, to the top but for BN12's (`giveSourceFile`).
 * `ownedSF` is `getResetInfo`'s, the active levels, after any `sourceFileOverrides` (`NetscriptFunctions.ts:1491`),
 * where `giveSourceFile` raises the owned ones: they differ only with overrides, which the brain never sets.
 */
export function sourceFilesAfterDestroy(
  currentNode: number,
  ownedSF: Readonly<Record<string, number>>,
): Record<string, number> {
  const level = ownedSF[String(currentNode)] ?? 0;
  const raised = currentNode === UNCAPPED_SOURCE_FILE ? level + 1 : Math.min(level + 1, SOURCE_FILE_TOP_LEVEL);
  return { ...ownedSF, [String(currentNode)]: Math.max(level, raised) };
}

/**
 * The BitNode the brain's destroy of `currentNode` enters (#321, #323): the first step of `CAMPAIGN_ORDER` whose
 * Source-File, after the destroy, is under its level and whose BitNode is playable (`unplayable` null: core's
 * `bitNodeUnplayableReason`, a test's otherwise), each unplayable one before it skipped; with none, `REPLAY_BITNODE`,
 * a replay, saying why.
 */
export function nextBitNodeOf({
  currentNode,
  ownedSF,
  unplayable = bitNodeUnplayableReason,
}: {
  currentNode: number;
  ownedSF: Readonly<Record<string, number>>;
  unplayable?: (bitNode: number) => string | null;
}): NextBitNode {
  const after = sourceFilesAfterDestroy(currentNode, ownedSF);
  const levelOf = (bitNode: number) => after[String(bitNode)] ?? 0;
  const skipped: SkippedBitNode[] = [];
  for (const step of CAMPAIGN_ORDER) {
    if (levelOf(step.bitNode) >= step.level) continue;
    const reason = unplayable(step.bitNode);
    if (reason === null) return { bitNode: step.bitNode, replay: null, skipped };
    if (!skipped.some((each) => each.bitNode === step.bitNode)) skipped.push({ bitNode: step.bitNode, reason });
  }
  const played = new Set(CAMPAIGN_ORDER.map((step) => step.bitNode).filter((bitNode) => unplayable(bitNode) === null));
  const levels = [...played].sort((a, b) => a - b).map((bitNode) => `Source-File ${bitNode} at ${levelOf(bitNode)}`);
  return {
    bitNode: REPLAY_BITNODE,
    replay: `the campaign's order has nothing playable left to gain (${levels.join(", ")}), but the run`,
    skipped,
  };
}

/**
 * The skipped BitNodes in words (#323), runs with one reason together: "BN2, BN6, BN7 and BN3 skipped: no hacking
 * multipliers or prices yet"; null with none. The brain's log line, the dashboard and the run report say it.
 */
export function describeSkipped(skipped: readonly SkippedBitNode[]): string | null {
  const runs: { bitNodes: number[]; reason: string }[] = [];
  for (const { bitNode, reason } of skipped) {
    const last = runs.at(-1);
    if (last?.reason === reason) last.bitNodes.push(bitNode);
    else runs.push({ bitNodes: [bitNode], reason });
  }
  return runs.length === 0
    ? null
    : runs.map((run) => `${listedBitNodes(run.bitNodes)} skipped: ${run.reason}`).join("; ");
}
