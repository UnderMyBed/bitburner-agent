/**
 * The next BitNode (#321, owner decision 66): the campaign's draft order (docs/synthesis.md §3), as far as the brain
 * plays it. A destroy gives the destroyed BitNode's Source-File a level, up to `SOURCE_FILE_TOP_LEVEL` but for BN12's
 * (`RedPill.tsx:16-52`, `giveSourceFile`), then enters the BitNode chosen (`RedPill.tsx:54-66`, `enterBitNode`),
 * so the next is chosen from the Source-Files as they'll be after it: the first step of the order still short of its
 * level. With none, BitNode 1 is played again for the run (#311's replay).
 */

/** A Source-File's top level but for BN12's, which has none: destroying its BitNode again gives no level. */
export const SOURCE_FILE_TOP_LEVEL = 3;
/** BitNode 12's Source-File has no top level (`RedPill.tsx:28`). */
export const UNCAPPED_SOURCE_FILE = 12;

/** A step of the order: play `bitNode` until its Source-File is at `level`. */
export interface CampaignStep {
  bitNode: number;
  level: number;
}

/**
 * The draft order's first three rows (synthesis §3): BN1.1, the forced start; BN4 ×3, Singularity at ×1 RAM; BN1.2-1.3.
 * The rest (BN5 on) waits for the brain to play them.
 */
export const CAMPAIGN_ORDER: readonly CampaignStep[] = [
  { bitNode: 1, level: 1 },
  { bitNode: 4, level: 3 },
  { bitNode: 1, level: 3 },
];

/** The BitNode played again once nothing in the order has a level to gain (#311): the one the brain is built for. */
export const REPLAY_BITNODE = 1;

/** The next BitNode, and why it's a replay (nothing in the order left to gain), or null. */
export interface NextBitNode {
  bitNode: number;
  replay: string | null;
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
 * The BitNode the brain's destroy of `currentNode` enters (#321): the first step of `CAMPAIGN_ORDER` whose Source-File,
 * after the destroy, is under its level; with none, `REPLAY_BITNODE`, a replay, saying why.
 */
export function nextBitNodeOf({
  currentNode,
  ownedSF,
}: {
  currentNode: number;
  ownedSF: Readonly<Record<string, number>>;
}): NextBitNode {
  const after = sourceFilesAfterDestroy(currentNode, ownedSF);
  const levelOf = (bitNode: number) => after[String(bitNode)] ?? 0;
  const step = CAMPAIGN_ORDER.find((each) => levelOf(each.bitNode) < each.level);
  if (step !== undefined) return { bitNode: step.bitNode, replay: null };
  const levels = [...new Set(CAMPAIGN_ORDER.map((each) => each.bitNode))]
    .sort((a, b) => a - b)
    .map((bitNode) => `Source-File ${bitNode} at ${levelOf(bitNode)}`);
  return {
    bitNode: REPLAY_BITNODE,
    replay: `the campaign's order has nothing left to gain (${levels.join(", ")}), but the run`,
  };
}
