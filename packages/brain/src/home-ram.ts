// The brain's side of upgrading home's RAM (#138, M3's third slice): the next upgrade, sent to the Agent as an intent
// (#141). The dashboard's switch turns it on and off; on is the default, as for the other activities (owner decision
// 34's pattern). Which purchase goes first, of this and the programs, is the controller's (desired-state.ts).
import {
  HOME_RAM_LIMIT,
  isUpgradableHomeRam,
  type MediumSnapshotData,
  type SlowSnapshotData,
  TECH_VENDORS,
} from "@bitburner-agent/core";
import { readSwitch } from "./switches.ts";
import type { TelemetryStore } from "./telemetry-store.ts";

export const HOME_RAM_ENABLED_SETTING = "homeRam.enabled";

/** Home's limit with the BitNode option `restrictHomePCUpgrade` (`Server/ServerPurchases.ts:177`). */
const RESTRICTED_HOME_RAM_LIMIT = 128;

/** The dashboard's switch: on unless the owner turned it off. */
export function readHomeRamEnabled(store: TelemetryStore): boolean {
  return readSwitch(store, HOME_RAM_ENABLED_SETTING, true);
}

/**
 * What doubling home's RAM from `ram` GB costs in BN1, as the game works it out
 * (`PersonObjects/Player/PlayerObjectServerMethods.ts:30`), in the same order so the result is the same number. Other
 * BitNodes multiply it (`HomeComputerRamCost`, `BitNode/BitNode.tsx`): a later slice adds them.
 */
export function homeRamUpgradePrice(ram: number): number {
  return ram * 32_000 * 1.58 ** Math.log2(ram);
}

/** Home's RAM, the next upgrade and why it isn't bought yet. */
export interface HomeRamPlan {
  /** Home's RAM (GB), or null if the snapshot doesn't say. */
  ram: number | null;
  /** The upgrade to buy now, from `fromRam` GB at the tech vendor `vendor`, or null. */
  next: { fromRam: number; vendor: string } | null;
  /** What the next upgrade costs, or null where there's none (the limit) or its price isn't known. */
  price: number | null;
  /** Why nothing is bought now, for the dashboard, or null when something is (or home is at its limit). */
  waitingFor: string | null;
}

/**
 * The next upgrade: home's RAM doubled, if the player's money covers it, at the tech vendor in the player's city. The
 * price is known in BN1 only so far, so the BitNode comes from the slow snapshot (null until the Agent sends one).
 * Snapshot data comes from the game, so nothing in it is taken on trust: a home RAM that can't be read is no upgrade.
 */
export function chooseHomeRamUpgrade(mediumData: MediumSnapshotData, slowData: SlowSnapshotData | null): HomeRamPlan {
  const servers = Array.isArray(mediumData.servers) ? mediumData.servers : [];
  const homeRam = servers.find((server) => server?.hostname === "home")?.maxRam;
  // The game's limit is no upgrade, but a size all the same.
  const ram = isUpgradableHomeRam(homeRam) || homeRam === HOME_RAM_LIMIT ? homeRam : null;
  const plan = (waitingFor: string | null, price: number | null = null): HomeRamPlan => ({
    ram,
    next: null,
    price,
    waitingFor,
  });
  if (ram === null) return plan("home's RAM in a medium snapshot");
  if (slowData === null) return plan("the Agent's slow snapshot (which BitNode)");
  const resetInfo = slowData.resetInfo as Partial<SlowSnapshotData["resetInfo"]> | undefined;
  const limit = resetInfo?.bitNodeOptions?.restrictHomePCUpgrade === true ? RESTRICTED_HOME_RAM_LIMIT : HOME_RAM_LIMIT;
  if (ram >= limit) return plan(null);
  if (resetInfo?.currentNode !== 1) {
    return plan(`the home RAM price in BitNode ${String(resetInfo?.currentNode)} (not known yet)`);
  }
  const price = homeRamUpgradePrice(ram);
  const money = typeof mediumData.player?.money === "number" ? mediumData.player.money : 0;
  if (money < price) {
    return plan(`money for ${ram * 2} GB ($${Math.ceil(price).toLocaleString("en-US")})`, price);
  }
  const city = mediumData.player?.city;
  const vendor = typeof city === "string" ? TECH_VENDORS[city] : undefined;
  if (vendor === undefined) return plan(`travel: no tech vendor sells home RAM in ${String(city)}`, price);
  return { ram, next: { fromRam: ram, vendor }, price, waitingFor: null };
}
