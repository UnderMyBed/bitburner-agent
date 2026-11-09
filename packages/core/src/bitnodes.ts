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
 * Why w0r1d_d43m0n can't be destroyed now, or null: worded once, for the brain's guard and every backend (§5.6).
 * `standing` is null while it isn't reachable: with no network links before The Red Pill is installed, no NS call
 * sees it (`NetscriptFunctions.ts:1051-1055`). Then root and the hacking level, as the terminal's `backdoor` checks
 * them (`Terminal/commands/backdoor.ts:23-32`) and Singularity's `destroyW0r1dD43m0n` (`Singularity.ts:1170-1175`).
 */
export function worldDaemonProblem(standing: WorldDaemonStanding | null): string | null {
  if (standing === null) return `${WORLD_DAEMON} isn't reachable: ${THE_RED_PILL} isn't installed`;
  if (!standing.rooted) return `no root access on ${WORLD_DAEMON} (NUKE.exe first)`;
  if (standing.hackingLevel < standing.requiredHackingLevel) {
    return `hacking level ${standing.hackingLevel}: ${WORLD_DAEMON} needs ${standing.requiredHackingLevel}`;
  }
  return null;
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
 * The BitNodes the brain plays (#321, #323: the campaign's order): BN4 and BN5 set only the softcap among the prices
 * (`BitNode.tsx:633-661`, `:663-693`).
 */
const BITNODE_PRICE_MULTIPLIERS: Readonly<Record<number, BitNodePriceMultipliers>> = {
  1: DEFAULT_PRICE_MULTIPLIERS,
  4: { ...DEFAULT_PRICE_MULTIPLIERS, CloudServerSoftcap: 1.2 },
  5: { ...DEFAULT_PRICE_MULTIPLIERS, CloudServerSoftcap: 1.2 },
};

/** `bitNode`'s price multipliers, or null for a BitNode the brain doesn't know them in yet: it buys neither there. */
export function bitNodePriceMultipliers(bitNode: number): BitNodePriceMultipliers | null {
  const multipliers = BITNODE_PRICE_MULTIPLIERS[bitNode];
  return multipliers === undefined ? null : { ...multipliers };
}

/**
 * The BitNode multipliers on hacking the brain's formulas need (#321) that the snapshots don't carry, nor Singularity
 * read without SF5 (`getBitNodeMultipliers`): the share of money a hack thread takes, `hacking_money` ×
 * `ScriptHackMoney` (`Hacking.ts:53-54`), and a thread's exp, `hacking_exp` × `HackExpGain` (`Hacking.ts:37`). The
 * brain folds them into the player's `hacking_money` and `hacking_exp` where it reads the player, so every formula on
 * those (the hack loop's threads, the batcher's plan and level forecast, the ceilings) is the game's.
 */
export interface BitNodeHackingMultipliers {
  ScriptHackMoney: number;
  HackExpGain: number;
}

/**
 * The BitNodes the brain plays (#321, #323): BN1's the defaults (`BitNode/BitNodeMultipliers.ts`), BN4's and BN5's
 * their own (`BitNode/BitNode.tsx:633-661`: `ScriptHackMoney` 0.2, `HackExpGain` 0.4; `:663-693`: 0.15 and 0.5). Their
 * other multipliers on hacking (`ServerGrowthRate`, `ServerWeakenRate`, `HackingSpeedMultiplier`,
 * `HackingLevelMultiplier`, `ScriptHackMoneyGain`) are 1 in all three. What they set on the servers (BN4's
 * `ServerMaxMoney`, BN5's `ServerStartingSecurity` and `ServerStartingMoney`) the snapshots read.
 */
const BITNODE_HACKING_MULTIPLIERS: Readonly<Record<number, BitNodeHackingMultipliers>> = {
  1: { ScriptHackMoney: 1, HackExpGain: 1 },
  4: { ScriptHackMoney: 0.2, HackExpGain: 0.4 },
  5: { ScriptHackMoney: 0.15, HackExpGain: 0.5 },
};

/**
 * `bitNode`'s hacking multipliers, or null for a BitNode the brain doesn't know them in yet: there it takes BN1's, said
 * by `bitNodeAssumptions` (the brain's log line and the run report), never silently.
 */
export function bitNodeHackingMultipliers(bitNode: number): BitNodeHackingMultipliers | null {
  const multipliers = BITNODE_HACKING_MULTIPLIERS[bitNode];
  return multipliers === undefined ? null : { ...multipliers };
}

/** "BN1", "BN1 and BN4", "BN1, BN4 and BN5": BitNodes in words. */
export function listedBitNodes(bitNodes: readonly number[]): string {
  const names = bitNodes.map((bitNode) => `BN${bitNode}`);
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** The BitNodes the brain plays (#323): those core has both the hacking multipliers and the prices of, in order. */
export function playableBitNodes(): number[] {
  return Object.keys(BITNODE_PRICE_MULTIPLIERS)
    .map(Number)
    .filter((bitNode) => bitNodeHackingMultipliers(bitNode) !== null)
    .sort((a, b) => a - b);
}

/**
 * Why the brain can't play `bitNode` yet (#323), short, from what core lacks of it, or null where it can: the
 * campaign's order skips it, and says so.
 */
export function bitNodeUnplayableReason(bitNode: number): string | null {
  const missing = [
    ...(bitNodeHackingMultipliers(bitNode) === null ? ["hacking multipliers"] : []),
    ...(bitNodePriceMultipliers(bitNode) === null ? ["prices"] : []),
  ];
  return missing.length === 0 ? null : `no ${missing.join(" or ")} yet`;
}

/**
 * What the brain takes as BN1's in `bitNode` though the game may have it otherwise (#321): worded, for the brain's log
 * line and the run report, a known risk each until a slice models it. None in the BitNodes it plays (BN1, BN4 and BN5,
 * `playableBitNodes`), whose prices and hacking multipliers core has.
 */
export function bitNodeAssumptions(bitNode: number): string[] {
  if (bitNodeUnplayableReason(bitNode) === null) return [];
  return [
    `BitNode ${bitNode}'s multipliers: the brain knows those of ${listedBitNodes(playableBitNodes())} only, so it ` +
      "buys no home RAM or cloud servers here, and its hacking takes BN1's (ScriptHackMoney and HackExpGain 1)",
  ];
}
