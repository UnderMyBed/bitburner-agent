/**
 * Destroying a BitNode (#175, M3's eleventh slice): w0r1d_d43m0n's backdoor, then the next BitNode. Shared by the
 * in-game code and the brain. The constants are plain literals, as in deploy-layout.ts.
 */
import { WORLD_DAEMON } from "./cloud-servers.ts";

/** Home worker: destroys the BitNode through the game's page. */
export const DESTROY_BITNODE_WORKER_NAME = "destroy-bitnode.js";

/** The BitNodes a destroy can enter: 1 to this (`BitNode/Constants.ts:1`, `validBitNodes`). */
export const BITNODE_COUNT = 15;

/** Whether `value` is a BitNode a destroy can enter: a whole number from 1 to 15. */
export function isBitNodeNumber(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= BITNODE_COUNT;
}

/** The augmentation whose install links w0r1d_d43m0n to The-Cave (`Prestige.ts:174-182`). */
export const THE_RED_PILL = "The Red Pill";

/** w0r1d_d43m0n as a destroy needs it, once it's reachable. */
export interface WorldDaemonStanding {
  rooted: boolean;
  hackingLevel: number;
  /** Its `requiredHackingSkill`: 3000 × the BitNode's `WorldDaemonDifficulty` (`Server/ServerHelpers.ts:383-385`). */
  requiredHackingLevel: number;
}

/**
 * The Black Ops a destroy can go by (#398): all of them done (`numberOfBlackOperations`,
 * `Bladeburner/data/BlackOperations.ts:735`, the 21 of core's `BLADEBURNER_BLACK_OPS`).
 */
export const BLACK_OPS_COUNT = 21;

/**
 * Why w0r1d_d43m0n can't be destroyed now, or null: worded once, for the brain's guard and every backend (§5.6).
 * `standing` is null while it isn't reachable: with no network links before The Red Pill is installed, no NS call
 * sees it (`NetscriptFunctions.ts:1051-1055`). Then root and the hacking level, as the terminal's `backdoor` checks
 * them (`Terminal/commands/backdoor.ts:23-32`) and Singularity's `destroyW0r1dD43m0n` (`Singularity.ts:1170-1175`).
 * Or (#398) the Black Ops: Singularity's destroy takes either, all 21 done in place of the hacking level and root
 * (`Singularity.ts:1176-1183`), as the Black Ops page's button does (`Bladeburner/ui/BlackOpPage.tsx:39-52`).
 * `blackOpsDone`, the count done, or null where it isn't read (no Bladeburner): with it, a problem says both routes.
 */
export function worldDaemonProblem(
  standing: WorldDaemonStanding | null,
  blackOpsDone: number | null = null,
): string | null {
  if (blackOpsDone !== null && blackOpsDone >= BLACK_OPS_COUNT) return null;
  const hacking = redPillRouteProblem(standing);
  if (hacking === null || blackOpsDone === null) return hacking;
  return `${hacking}; and ${blackOpsDone} of the ${BLACK_OPS_COUNT} Black Ops done`;
}

/** The Red Pill's route's part of `worldDaemonProblem`: reachable, rooted, the hacking level. */
function redPillRouteProblem(standing: WorldDaemonStanding | null): string | null {
  if (standing === null) return `${WORLD_DAEMON} isn't reachable: ${THE_RED_PILL} isn't installed`;
  if (!standing.rooted) return `no root access on ${WORLD_DAEMON} (NUKE.exe first)`;
  if (standing.hackingLevel < standing.requiredHackingLevel) {
    return `hacking level ${standing.hackingLevel}: ${WORLD_DAEMON} needs ${standing.requiredHackingLevel}`;
  }
  return null;
}

/**
 * A BitNode's win route (#398): The Red Pill's (w0r1d_d43m0n's hacking level) or the Black Ops'. In BN6 and BN7 the
 * rules offer the Black Ops alone (#359): The Red Pill's is hopeless there by the formulas (w0r1d_d43m0n at hacking
 * 6,000 at a level multiplier of 0.35, `NO_WIN_ROUTE`'s note), and the planner's estimates of both say so
 * (`chooseWinRoute`, ./bladeburner-route.ts). On this route the Red Pill's holds, levelling and A8's Red Pill path are
 * off. Elsewhere The Red Pill's.
 */
export type WinRoute = "redPill" | "blackOps";

/** The BitNodes whose win route is the Black Ops (#398): BN6, and BN7 once Bladeburner's B8 makes it playable. */
export const BLACK_OPS_ROUTE_BITNODES: readonly number[] = [6, 7];

/** `bitNode`'s win route (#398). */
export function winRouteOf(bitNode: number): WinRoute {
  return BLACK_OPS_ROUTE_BITNODES.includes(bitNode) ? "blackOps" : "redPill";
}

/**
 * The BitNode multipliers on the prices the brain pays (#321), by the game's names: home RAM's
 * (`PlayerObjectServerMethods.ts:38`) and cloud servers' (`Server/ServerPurchases.ts:23-42`, `:96-98`).
 */
export interface BitNodePriceMultipliers {
  HomeComputerRamCost: number;
  CloudServerCost: number;
  CloudServerSoftcap: number;
  CloudServerLimit: number;
  CloudServerMaxRam: number;
}

/** The defaults (`BitNode/BitNodeMultipliers.ts:115-140`): BN1's (`BitNode/BitNode.tsx:572-574`). */
const DEFAULT_PRICE_MULTIPLIERS: BitNodePriceMultipliers = {
  HomeComputerRamCost: 1,
  CloudServerCost: 1,
  CloudServerSoftcap: 1,
  CloudServerLimit: 1,
  CloudServerMaxRam: 1,
};

/**
 * The BitNodes core has the prices of (#321, #323: the campaign's order; BN2 since #334; BN6 and BN7 since #367): BN2,
 * BN4, BN5, BN6 and BN7 set only the softcap among the prices (`BitNode.tsx:575-597`: 1.3; `:633-661`, `:663-693`:
 * 1.2; `:694-727`, `:728-769`: 2).
 */
const BITNODE_PRICE_MULTIPLIERS: Readonly<Record<number, BitNodePriceMultipliers>> = {
  1: DEFAULT_PRICE_MULTIPLIERS,
  2: { ...DEFAULT_PRICE_MULTIPLIERS, CloudServerSoftcap: 1.3 },
  4: { ...DEFAULT_PRICE_MULTIPLIERS, CloudServerSoftcap: 1.2 },
  5: { ...DEFAULT_PRICE_MULTIPLIERS, CloudServerSoftcap: 1.2 },
  6: { ...DEFAULT_PRICE_MULTIPLIERS, CloudServerSoftcap: 2 },
  7: { ...DEFAULT_PRICE_MULTIPLIERS, CloudServerSoftcap: 2 },
};

/** `bitNode`'s price multipliers, or null for a BitNode the brain doesn't know them in yet: it buys neither there. */
export function bitNodePriceMultipliers(bitNode: number): BitNodePriceMultipliers | null {
  const multipliers = BITNODE_PRICE_MULTIPLIERS[bitNode];
  return multipliers === undefined ? null : { ...multipliers };
}

/**
 * The BitNode multipliers on hacking the brain's formulas need (#321) that the snapshots don't carry, nor Singularity
 * read without SF5 (`getBitNodeMultipliers`): the share of money a hack thread takes, `hacking_money` ×
 * `ScriptHackMoney` (`Hacking.ts:53-54`); a thread's exp, `hacking_exp` × `HackExpGain` (`Hacking.ts:37`); since #334, a
 * grow's growth, `hacking_grow` × `ServerGrowthRate` (`Server/formulas/grow.ts:22-28`), and the level, `mults.hacking` ×
 * `HackingLevelMultiplier` (`PersonObjects/Person.ts:60-63`). The brain folds them into the player's `hacking_money`,
 * `hacking_exp`, `hacking_grow` and `hacking` where it reads the player, so every formula on those (the hack loop's
 * threads, the batcher's plan and level forecast, the ceilings) is the game's.
 */
export interface BitNodeHackingMultipliers {
  ScriptHackMoney: number;
  HackExpGain: number;
  ServerGrowthRate: number;
  HackingLevelMultiplier: number;
}

/** The defaults (`BitNode/BitNodeMultipliers.ts`): BN1's, 1 each. */
const DEFAULT_HACKING_MULTIPLIERS: BitNodeHackingMultipliers = {
  ScriptHackMoney: 1,
  HackExpGain: 1,
  ServerGrowthRate: 1,
  HackingLevelMultiplier: 1,
};

/**
 * The BitNodes core has the hacking multipliers of (#321, #323, #334, #367): BN1's the defaults, BN2's, BN4's, BN5's,
 * BN6's and BN7's their own (`BitNode/BitNode.tsx:575-597`: `ServerGrowthRate` and `HackingLevelMultiplier` 0.8;
 * `:633-661`: `ScriptHackMoney` 0.2, `HackExpGain` 0.4; `:663-693`: 0.15 and 0.5; `:694-727`: `ScriptHackMoney`
 * 0.75, `HackExpGain` 0.25, `HackingLevelMultiplier` 0.35; `:728-769`: the same, but `ScriptHackMoney` 0.5). Their
 * other multipliers on hacking (`ServerWeakenRate`, `HackingSpeedMultiplier`, `ScriptHackMoneyGain`) are 1 in all six.
 * What they set on the servers (`ServerMaxMoney`, `ServerStartingMoney` and `ServerStartingSecurity`) the snapshots
 * read.
 */
const BITNODE_HACKING_MULTIPLIERS: Readonly<Record<number, BitNodeHackingMultipliers>> = {
  1: DEFAULT_HACKING_MULTIPLIERS,
  2: { ...DEFAULT_HACKING_MULTIPLIERS, ServerGrowthRate: 0.8, HackingLevelMultiplier: 0.8 },
  4: { ...DEFAULT_HACKING_MULTIPLIERS, ScriptHackMoney: 0.2, HackExpGain: 0.4 },
  5: { ...DEFAULT_HACKING_MULTIPLIERS, ScriptHackMoney: 0.15, HackExpGain: 0.5 },
  6: { ...DEFAULT_HACKING_MULTIPLIERS, ScriptHackMoney: 0.75, HackExpGain: 0.25, HackingLevelMultiplier: 0.35 },
  7: { ...DEFAULT_HACKING_MULTIPLIERS, ScriptHackMoney: 0.5, HackExpGain: 0.25, HackingLevelMultiplier: 0.35 },
};

/**
 * `bitNode`'s hacking multipliers, or null for a BitNode the brain doesn't know them in yet: there it takes BN1's, said
 * by `bitNodeAssumptions` (the brain's log line and the run report), never silently.
 */
export function bitNodeHackingMultipliers(bitNode: number): BitNodeHackingMultipliers | null {
  const multipliers = BITNODE_HACKING_MULTIPLIERS[bitNode];
  return multipliers === undefined ? null : { ...multipliers };
}

/** "BN1", "BN1 and BN4", "BN1, BN2, BN4 and BN5": BitNodes in words. */
export function listedBitNodes(bitNodes: readonly number[]): string {
  const names = bitNodes.map((bitNode) => `BN${bitNode}`);
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** The BitNodes core knows (#367): those it has both the hacking multipliers and the prices of, in order. */
export function knownBitNodes(): number[] {
  return Object.keys(BITNODE_PRICE_MULTIPLIERS)
    .map(Number)
    .filter((bitNode) => bitNodeHackingMultipliers(bitNode) !== null)
    .sort((a, b) => a - b);
}

/**
 * The BitNodes core knows that the brain has no win route in yet (#367): a BitNode is playable only with one. BN6's and
 * BN7's is the 21 Black Ops (Bladeburner's epic, #359). The Red Pill's is hopeless there: w0r1d_d43m0n at hacking
 * 6,000 (3,000, `Server/data/servers.ts:1536`, × `WorldDaemonDifficulty` 2, `Server/ServerHelpers.ts:383-385`) at a
 * level multiplier of 0.35 (`BitNode.tsx:694-769`), 17,143 at ×1, against BN4's 9,000. BN6's is built (B6, #398), but
 * hopeless at a BN6.1 start by its own estimate (#400's review: 5.0 million h at combat 100, 499,000 h at 300, against
 * #336's bar, the BitNode's time so far), as the competence it needs comes from augmentations and installs, B7's: so
 * BN6 waits for B7. BN7's, at its own `BladeburnerRank` 0.6, `BladeburnerSkillCost` 2 and prices ×3, is B8's.
 */
const NO_WIN_ROUTE: ReadonlyMap<number, string> = new Map([
  [6, "no win route yet (the Black Ops, hopeless by #398's estimate until Bladeburner's B7)"],
  [7, "no win route yet (the Black Ops at BN7's multipliers, Bladeburner's B8)"],
]);
/** Why BN7 is skipped until Bladeburner's B8 (#367, #398). */
export const BITNODE_NO_WIN_ROUTE_REASON = NO_WIN_ROUTE.get(7) as string;
/** Why BN6 is skipped until Bladeburner's B7 (#398, #400's review). */
export const BITNODE_BLACK_OPS_HOPELESS_REASON = NO_WIN_ROUTE.get(6) as string;

/** The BitNodes the brain plays (#323): those core knows (`knownBitNodes`) with a win route (#367), in order. */
export function playableBitNodes(): number[] {
  return knownBitNodes().filter((bitNode) => !NO_WIN_ROUTE.has(bitNode));
}

/**
 * Why the brain can't play `bitNode` yet (#323), short, from what core lacks of it, or null where it can: the
 * campaign's order skips it, and says so. Core's tables first, then (#367) the win route.
 */
export function bitNodeUnplayableReason(bitNode: number): string | null {
  const missing = [
    ...(bitNodeHackingMultipliers(bitNode) === null ? ["hacking multipliers"] : []),
    ...(bitNodePriceMultipliers(bitNode) === null ? ["prices"] : []),
  ];
  if (missing.length > 0) return `no ${missing.join(" or ")} yet`;
  return NO_WIN_ROUTE.get(bitNode) ?? null;
}

/**
 * What the brain takes as BN1's in `bitNode` though the game may have it otherwise (#321): worded, for the brain's log
 * line and the run report, a known risk each until a slice models it. None in the BitNodes core knows (BN1, BN2, BN4,
 * BN5, BN6 and BN7, `knownBitNodes`), whose prices and hacking multipliers it has.
 */
export function bitNodeAssumptions(bitNode: number): string[] {
  if (knownBitNodes().includes(bitNode)) return [];
  return [
    `BitNode ${bitNode}'s multipliers: the brain knows those of ${listedBitNodes(knownBitNodes())} only, so it ` +
      "buys no home RAM or cloud servers here, and its hacking takes BN1's (each multiplier on it 1)",
  ];
}
