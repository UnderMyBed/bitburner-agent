/**
 * Backdoors (#162, M3's ninth slice): the terminal's `backdoor`, on a server reached by `connect` from home. Shared by
 * the in-game code and the brain. The constants are plain literals, as in deploy-layout.ts.
 */
import { IP_ADDRESS, MAX_CLOUD_SERVER_HOSTNAME_LENGTH } from "./cloud-servers.ts";

/** Home worker: installs a backdoor through the terminal on the game's page. */
export const BACKDOOR_WORKER_NAME = "backdoor.js";

/**
 * The hacker factions' servers (#195, `Server/data/SpecialServers.ts:5-8`), in the order the brain backdoors them: the
 * ports and hacking level each needs go up (`Server/data/servers.ts:1430-1517`: 1 port and level 51-60 for CSEC, 2 and
 * 202-220, 3 and 340-365, 4 and 505-550). Each faction invites the player once its server is backdoored, and asks
 * nothing else (`Faction/FactionInfo.tsx:489`, `:464-466`, `:419`, `:402`).
 */
export const HACKER_FACTION_SERVERS: readonly { hostname: string; faction: string }[] = [
  { hostname: "CSEC", faction: "CyberSec" },
  { hostname: "avmnite-02h", faction: "NiteSec" },
  { hostname: "I.I.I.I", faction: "The Black Hand" },
  { hostname: "run4theh111z", faction: "BitRunners" },
];

/**
 * A server's hostname as an intent may name it: 1 to 64 letters, digits, `.`, `_` or `-` (the one limit on every
 * hostname an intent names, `MAX_CLOUD_SERVER_HOSTNAME_LENGTH`), and not an IP address, which `connect` would take
 * but `scan` never lists. The game's own servers include `.`, `I.I.I.I` and `w0r1d_d43m0n` (`Server/data/servers.ts`).
 */
export function isServerHostname(hostname: unknown): hostname is string {
  return (
    typeof hostname === "string" &&
    new RegExp(`^[A-Za-z0-9._-]{1,${MAX_CLOUD_SERVER_HOSTNAME_LENGTH}}$`).test(hostname) &&
    !IP_ADDRESS.test(hostname)
  );
}
