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

/** The BitNodes the brain plays (#321, the campaign's order): BN4 sets only the softcap (`BitNode/BitNode.tsx:633-661`). */
const BITNODE_PRICE_MULTIPLIERS: Readonly<Record<number, BitNodePriceMultipliers>> = {
  1: DEFAULT_PRICE_MULTIPLIERS,
  4: { ...DEFAULT_PRICE_MULTIPLIERS, CloudServerSoftcap: 1.2 },
};

/** `bitNode`'s price multipliers, or null for a BitNode the brain doesn't know them in yet: it buys neither there. */
export function bitNodePriceMultipliers(bitNode: number): BitNodePriceMultipliers | null {
  const multipliers = BITNODE_PRICE_MULTIPLIERS[bitNode];
  return multipliers === undefined ? null : { ...multipliers };
}

/**
 * What the brain takes as BN1's in `bitNode` though the game has it otherwise (#321): worded, for the brain's log line
 * and the run report, a known risk each until a slice models it. None in BN1. BN4's (`BitNode/BitNode.tsx:633-661`):
 * its hacking, which the snapshots don't carry and Singularity can't read there (`getBitNodeMultipliers` needs SF5).
 */
export function bitNodeAssumptions(bitNode: number): string[] {
  if (bitNode === 1) return [];
  if (bitNode === 4) {
    return [
      "the money a hack thread takes: the hack loop, the batcher and the hacking ceilings take ScriptHackMoney as 1, " +
        "it's 0.2 in BN4 (Hacking.ts:54), so a batch takes about a fifth of what it plans (fewer threads than " +
        "it could, never more) and the ceilings are 5 times too high",
      "hacking exp: the batcher's level forecast takes HackExpGain as 1, it's 0.4 in BN4 (Hacking.ts:37), so it " +
        "forecasts levels sooner than they come",
    ];
  }
  return [
    `BitNode ${bitNode}'s multipliers: the brain knows BN1's and BN4's only, so it buys no home RAM or cloud servers ` +
      "here, and its hacking takes BN1's",
  ];
}
