/**
 * Home's RAM upgrades (#138, M3's third slice), bought at a tech vendor: each doubles home's RAM. Shared by the in-game
 * code and the brain.
 */

/** The most RAM home can have, in GB (`Server/data/Constants.ts:6`): no upgrade from here. */
export const HOME_RAM_LIMIT = 2 ** 30;

/** Home worker: upgrades home's RAM once through the game's page. */
export const UPGRADE_HOME_RAM_WORKER_NAME = "upgrade-home-ram.js";

/** A size home's RAM can be upgraded from: a power of two GB, from 1 up to below the limit. */
export function isUpgradableHomeRam(ram: unknown): ram is number {
  return (
    Number.isSafeInteger(ram) &&
    (ram as number) >= 1 &&
    (ram as number) < HOME_RAM_LIMIT &&
    Math.log2(ram as number) % 1 === 0
  );
}
