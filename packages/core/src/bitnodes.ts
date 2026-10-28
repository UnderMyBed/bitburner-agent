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
