/**
 * Cloud servers (#159, M3's ninth slice): the servers the player buys with `ns.cloud.purchaseServer`, which needs no
 * Singularity. Shared by the in-game code and the brain. The constants are plain literals, as in deploy-layout.ts.
 */

/** The most RAM a cloud server can have, in GB, before the BitNode's multiplier (`Server/data/Constants.ts:13`). */
export const CLOUD_SERVER_MAX_RAM = 2 ** 20;

/** The prefixes the game keeps for Hacknet servers (`NetscriptFunctions/Cloud.ts:46`): it refuses them. */
export const RESERVED_HOSTNAME_PREFIXES = ["hacknet-node-", "hacknet-server-"];

/** Home worker: buys one cloud server through the NS API, with or without Singularity. */
export const BUY_SERVER_WORKER_NAME = "buy-server.js";

/**
 * The server whose name the brain never buys a cloud server under (#161 review). Before The Red Pill it has no network
 * links (`Server/data/servers.ts`, `Prestige.ts:175-181`), so `ns.serverExists` hides it, yet the purchase finds it
 * and renames the new server `w0r1d_d43m0n-0` (`Server/ServerHelpers.ts:42-65`). Its backdoor ends the BitNode
 * (`Terminal/Terminal.ts:382-387`): that's slice 11's irreversible `destroyBitNode`, never a `backdoor` intent (#162).
 */
export const WORLD_DAEMON = "w0r1d_d43m0n";

/** The longest hostname the brain asks for: the game sets none, but a hostname is shown and typed. */
export const MAX_CLOUD_SERVER_HOSTNAME_LENGTH = 64;

/** An IP address, as the game tells one (also refused as a server for a backdoor, #162) (`Types/strings.ts:10-14`): the game refuses it as a hostname. */
export const IP_ADDRESS =
  /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;

/**
 * A hostname the brain may buy a server under: letters, digits, `.`, `_` and `-`, starting with a letter or digit, so a
 * terminal command (`connect`) takes it as one word; not an IP address, nor one of the game's reserved prefixes, nor
 * `WORLD_DAEMON`.
 */
export function isCloudServerHostname(hostname: unknown): hostname is string {
  return (
    typeof hostname === "string" &&
    hostname !== WORLD_DAEMON &&
    new RegExp(`^[A-Za-z0-9][A-Za-z0-9._-]{0,${MAX_CLOUD_SERVER_HOSTNAME_LENGTH - 1}}$`).test(hostname) &&
    !IP_ADDRESS.test(hostname) &&
    !RESERVED_HOSTNAME_PREFIXES.some((prefix) => hostname.startsWith(prefix))
  );
}

/** A RAM a cloud server can be bought with, in GB: a power of two, from 1 to the most (`ServerPurchases.ts:23-42`). */
export function isCloudServerRam(ram: unknown): ram is number {
  return (
    Number.isSafeInteger(ram) &&
    (ram as number) >= 1 &&
    (ram as number) <= CLOUD_SERVER_MAX_RAM &&
    Math.log2(ram as number) % 1 === 0
  );
}
