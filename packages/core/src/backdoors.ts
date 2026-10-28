/**
 * Backdoors (#162, M3's ninth slice): the terminal's `backdoor`, on a server reached by `connect` from home. Shared by
 * the in-game code and the brain. The constants are plain literals, as in deploy-layout.ts.
 */

/** Home worker: installs a backdoor through the terminal on the game's page. */
export const BACKDOOR_WORKER_NAME = "backdoor.js";

/** The longest hostname an intent names; the game's own are far shorter. */
export const MAX_HOSTNAME_LENGTH = 64;

/**
 * A server's hostname as an intent may name it: 1 to 64 letters, digits, `.`, `_` or `-`. The game's own servers
 * include `.`, `I.I.I.I` and `w0r1d_d43m0n` (`Server/data/servers.ts`).
 */
export function isServerHostname(hostname: unknown): hostname is string {
  return typeof hostname === "string" && new RegExp(`^[A-Za-z0-9._-]{1,${MAX_HOSTNAME_LENGTH}}$`).test(hostname);
}
