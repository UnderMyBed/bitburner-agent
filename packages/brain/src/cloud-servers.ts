// The brain's side of cloud servers (#194, M4 phase A slice A2): which to buy or upgrade, by a payback rule over the
// game's prices and the hack loop's measured income, sent to the Agent as a `buyServer` or `upgradeServer` intent. The
// hack loop runs on them (hack-loop.ts, `hackLoopHosts`). The dashboard's switch turns it on and off; on is the
// default, as for the other purchases. Which purchase goes first, of this, the programs and home RAM, is the
// controller's (desired-state.ts).
import {
  CLOUD_SERVER_MAX_RAM,
  CLOUD_SERVER_NAME_PREFIX,
  isBrainCloudServerName,
  isCloudServerRam,
  isHacknetServerName,
  type MediumSnapshotData,
  type SlowSnapshotData,
  type StaticSnapshotData,
} from "@bitburner-agent/core";
import { hackLoopHosts } from "./hack-loop.ts";
import { readSwitch } from "./switches.ts";
import type { TelemetryStore } from "./telemetry-store.ts";

export const CLOUD_SERVERS_ENABLED_SETTING = "cloudServers.enabled";

/** The dashboard's switch: on unless the owner turned it off. */
export function readCloudServersEnabled(store: TelemetryStore): boolean {
  return readSwitch(store, CLOUD_SERVERS_ENABLED_SETTING, true);
}

/** BN1's price of a GB of a cloud server's RAM, at every size (`Server/data/Constants.ts:4`, the multipliers 1). */
export const CLOUD_SERVER_PRICE_PER_GB = 55_000;
/** BN1's limit on cloud servers: 25 × `CloudServerLimit` (1) (`Server/ServerPurchases.ts:96-98`). */
export const CLOUD_SERVER_LIMIT = 25;
/**
 * The least RAM the brain buys a server with: 8 GB holds three of the loop's 2.4 GB threads, 90% of it used. A 4 GB
 * server holds one, 60%; a 2 GB, none.
 */
export const MIN_CLOUD_SERVER_RAM = 8;
/**
 * How far back the hack loop's income is measured: 10 minutes, a few of n00dles's hacks and grows, and nothing is
 * bought before the Agent's medium snapshots span it. The loop's income comes in steps (each host's hacks land
 * together), so a shorter window would swing with them.
 */
export const CLOUD_SERVER_INCOME_WINDOW_MS = 10 * 60_000;
/**
 * The longest a purchase may take to pay for itself at the hack loop's income per GB (#194). Tuned in the simulator
 * (cloud-servers-income.test.ts's runs, 8 seeds of 3 hours; the brain README's cloud server suite has the tables): at
 * 15 minutes the runs earned 2.8 times as much as without cloud servers ($12b more even less what the servers cost),
 * and ended with 1.9 times the money. At 30 to 240 minutes (measured with the reserve on the whole price) they earned
 * about as much but spent more than the extra on servers that hadn't paid back by the end: the income per GB is the
 * hosts' average, and a GB more earns less than the average, on the same targets.
 */
export const CLOUD_SERVER_PAYBACK_LIMIT_MS = 15 * 60_000;
/**
 * The next program or home RAM upgrade waiting for money is held back from cloud servers when the hack loop's income
 * would cover what's still short of its price within this (#194): it's nearly there, so it's bought first. One further
 * off isn't: cloud servers raise the income that brings it nearer. Tuned with the payback limit: at 1 minute the
 * programs up to HTTPWorm.exe came when they did without cloud servers, home's 1 TB a minute later and SQLInject.exe
 * about 13 minutes later; at 5 and 15 minutes the runs earned 7% and 21% less, as money waited for home RAM, which the
 * hack loop doesn't run on, and at 5 one seed's money went 11 minutes without rising.
 */
export const CLOUD_SERVER_RESERVE_HORIZON_MS = 1 * 60_000;

/**
 * What `ram` GB of cloud server costs in BN1, as the game works it out (`Server/ServerPurchases.ts:23-42`): ram ×
 * 55,000 × `CloudServerCost` × `CloudServerSoftcap`^max(0, log2(ram) − 6), the multipliers 1. An upgrade costs the
 * difference between the two sizes' prices (`ServerPurchases.ts:44-54`). Other BitNodes multiply it
 * (`BitNode/BitNode.tsx`): a later slice adds them.
 */
export function cloudServerPrice(ram: number): number {
  return ram * CLOUD_SERVER_PRICE_PER_GB;
}

/** The hack loop's income over the window: per second, and per GB of its hosts' RAM per second. */
export interface HackLoopIncomeRate {
  perSecond: number;
  perGbSecond: number;
}

/**
 * The hack loop's income, from the connected Agent's medium snapshots (#194): money's rises added up (a purchase lowers
 * money, which isn't income), over the hosts' RAM × time (`hackLoopHosts`, each stretch at the RAM the snapshot that
 * starts it shows), across the last `CLOUD_SERVER_INCOME_WINDOW_MS`. Money from work (crime, a company job) counts too,
 * which errs toward buying. Forgotten when the Agent disconnects or another connects, as the snapshots are.
 */
export class HackLoopIncome {
  #samples: { atMs: number; money: number; hostsRam: number }[] = [];

  /**
   * A medium snapshot, received at `atMs`, with the static snapshot that says which servers are the game's: one whose
   * money isn't a number, or with no static snapshot yet, is skipped.
   */
  add(atMs: number, staticData: StaticSnapshotData | null, mediumData: MediumSnapshotData): void {
    const money = mediumData?.player?.money;
    // Without the static snapshot, the hosts aren't known: the Agent's first round sends it after the medium one.
    if (staticData === null || typeof money !== "number" || !Number.isFinite(money)) return;
    const hostsRam = hackLoopHosts(staticData, mediumData).reduce((total, host) => total + host.ram, 0);
    this.#samples.push({ atMs, money, hostsRam });
    // Keep the newest sample at or before the window's start, and those after it.
    const windowStart = atMs - CLOUD_SERVER_INCOME_WINDOW_MS;
    while (this.#samples.length > 1 && (this.#samples[1] as { atMs: number }).atMs <= windowStart) {
      this.#samples.shift();
    }
  }

  clear(): void {
    this.#samples = [];
  }

  /** The rate over the window, or null until the samples span it, or with no RAM to earn on. */
  rate(): HackLoopIncomeRate | null {
    const first = this.#samples[0];
    const last = this.#samples.at(-1);
    if (first === undefined || last === undefined) return null;
    if (last.atMs - first.atMs < CLOUD_SERVER_INCOME_WINDOW_MS) return null;
    let earned = 0;
    let gbSeconds = 0;
    for (let index = 1; index < this.#samples.length; index++) {
      const before = this.#samples[index - 1] as { atMs: number; money: number; hostsRam: number };
      const after = this.#samples[index] as { atMs: number; money: number };
      earned += Math.max(0, after.money - before.money);
      gbSeconds += (before.hostsRam * (after.atMs - before.atMs)) / 1000;
    }
    if (!(gbSeconds > 0)) return null;
    return { perSecond: earned / ((last.atMs - first.atMs) / 1000), perGbSecond: earned / gbSeconds };
  }
}

/** A cloud server of the player's, and its RAM (GB). */
export interface CloudServer {
  hostname: string;
  ram: number;
}

/** A cloud server purchase: a new server, or more RAM for one, with its price and how long it takes to pay back. */
export interface CloudServerPurchase {
  action: "buyServer" | "upgradeServer";
  hostname: string;
  /** The RAM it has after. */
  ram: number;
  price: number;
  paybackMs: number;
}

/** The cloud servers, the next purchase and why it isn't bought yet. */
export interface CloudServersPlan {
  /** The player's cloud servers, by name, or none before the snapshots say. */
  servers: CloudServer[];
  next: CloudServerPurchase | null;
  /** Why nothing is bought now, for the dashboard, or null when something is (or all are at the most RAM). */
  waitingFor: string | null;
}

/** Money held back for another purchase: its price, and what it is, for the dashboard. */
export interface MoneyReserve {
  amount: number;
  forWhat: string;
}

/**
 * The player's cloud servers, the brain's and the owner's: the medium snapshot's servers that aren't home, a Hacknet
 * server, or one of the game's own (the static snapshot's, not purchased), with their RAM (a positive number), by name.
 * They all count toward the game's limit; the brain upgrades only its own (`isBrainCloudServerName`). The medium
 * snapshot scans every 10 s, so it has a server bought since the static one; the slow snapshot's list is the game's
 * word, but a minute behind.
 */
export function cloudServersOf(staticData: StaticSnapshotData, mediumData: MediumSnapshotData): CloudServer[] {
  const gameServers = new Set(
    (Array.isArray(staticData?.servers) ? staticData.servers : [])
      .filter((server) => server?.purchasedByPlayer === false)
      .map((server) => server.hostname),
  );
  return (Array.isArray(mediumData?.servers) ? mediumData.servers : [])
    .filter(
      (server) =>
        typeof server?.hostname === "string" &&
        server.hostname !== "home" &&
        !isHacknetServerName(server.hostname) &&
        !gameServers.has(server.hostname) &&
        typeof server.maxRam === "number" &&
        server.maxRam > 0,
    )
    .map((server) => ({ hostname: server.hostname, ram: server.maxRam }))
    .sort((a, b) => (a.hostname < b.hostname ? -1 : 1));
}

/**
 * The next name to buy under: `pserv-<n>`, the least n that no server's name is, or starts with followed by `-`. The
 * game names a purchase `<name>-0` when a server it can't see holds the name (`Server/ServerHelpers.ts:42-65`): that
 * name is then passed over, never bought again and again.
 */
export function nextCloudServerName(hostnames: string[]): string {
  const taken = (name: string) => hostnames.some((hostname) => hostname === name || hostname.startsWith(`${name}-`));
  let index = 0;
  while (taken(`${CLOUD_SERVER_NAME_PREFIX}${index}`)) index++;
  return `${CLOUD_SERVER_NAME_PREFIX}${index}`;
}

/** The medium snapshot's hostnames, the strings only: the Agent's word. */
function hostnamesOf(mediumData: MediumSnapshotData): string[] {
  return (Array.isArray(mediumData?.servers) ? mediumData.servers : [])
    .map((server) => server?.hostname)
    .filter((hostname): hostname is string => typeof hostname === "string");
}

const formatMoney = (money: number) => `$${Math.ceil(money).toLocaleString("en-US")}`;
const formatMinutes = (ms: number) => `${Math.ceil(ms / 60_000).toLocaleString("en-US")} min`;

/**
 * The next cloud server purchase (#194), or why there's none:
 * - **Where:** under the limit of 25 (the owner's cloud servers count), a new server, `pserv-<n>`
 *   (`nextCloudServerName`); at it, the smallest of the brain's own (ties to the first name), upgraded, never the
 *   owner's; all of its own at the most RAM, or none, nothing.
 * - **How much:** the largest power of two of RAM, at least 8 GB for a new server, whose price money covers less the
 *   `reserve`, and whose payback is within `CLOUD_SERVER_PAYBACK_LIMIT_MS`: its price over the RAM it adds times the
 *   hack loop's income per GB a second. In BN1 a GB costs the same at every size, so the payback is too: the rule buys
 *   the largest that money allows, or nothing.
 * - **`previous`**, the purchase last chosen, is kept while it's still to do and money and payback still allow it, so a
 *   purchase in flight keeps its id (and the Agent its count of tries) as money rises.
 * - **What it waits for:** the slow snapshot (the BitNode: the prices are known in BN1 only so far, as home RAM's), the
 *   income over a full window, an income that pays back in time, or the money.
 * Snapshot data comes from the game, so nothing in it is taken on trust.
 */
export function chooseCloudServerPurchase({
  staticData,
  mediumData,
  slowData,
  income,
  reserve,
  previous = null,
}: {
  staticData: StaticSnapshotData;
  mediumData: MediumSnapshotData;
  slowData: SlowSnapshotData | null;
  income: HackLoopIncomeRate | null;
  reserve: MoneyReserve | null;
  previous?: CloudServerPurchase | null;
}): CloudServersPlan {
  const servers = cloudServersOf(staticData, mediumData);
  const plan = (waitingFor: string | null, next: CloudServerPurchase | null = null): CloudServersPlan => ({
    servers,
    next,
    waitingFor,
  });
  if (slowData === null) return plan("the Agent's slow snapshot (which BitNode)");
  const currentNode = (slowData.resetInfo as Partial<SlowSnapshotData["resetInfo"]> | undefined)?.currentNode;
  if (currentNode !== 1) return plan(`the cloud server prices in BitNode ${String(currentNode)} (not known yet)`);
  // The brain's own, at a RAM the game sells: an upgrade doubles it from there.
  const own = servers.filter((server) => isBrainCloudServerName(server.hostname) && isCloudServerRam(server.ram));
  const smallest = [...own].sort((a, b) => a.ram - b.ram)[0];
  const atTheLimit = servers.length >= CLOUD_SERVER_LIMIT;
  if (atTheLimit && smallest === undefined) {
    return plan(`room: the game's limit of ${CLOUD_SERVER_LIMIT} cloud servers is reached with your own`);
  }
  if (atTheLimit && smallest !== undefined && smallest.ram >= CLOUD_SERVER_MAX_RAM) return plan(null);
  const minutes = formatMinutes(CLOUD_SERVER_INCOME_WINDOW_MS);
  if (income === null) return plan(`the hack loop's income over ${minutes} (measured from the medium snapshots)`);
  if (!(income.perGbSecond > 0)) return plan(`the hack loop to earn (nothing in the last ${minutes})`);
  const money = typeof mediumData.player?.money === "number" ? mediumData.player.money : 0;
  const spendable = money - (reserve?.amount ?? 0);
  const paybackMs = (price: number, addedRam: number) => (price / (addedRam * income.perGbSecond)) * 1000;
  const fits = (purchase: CloudServerPurchase) =>
    purchase.price <= spendable && purchase.paybackMs <= CLOUD_SERVER_PAYBACK_LIMIT_MS;

  // The purchase in flight, at today's price and income.
  const kept = previous === null ? null : stillToDo(previous, servers, own, mediumData);
  if (previous !== null && kept !== null) {
    const price = cloudServerPrice(previous.ram) - cloudServerPrice(kept.fromRam);
    const refreshed = { ...previous, price, paybackMs: paybackMs(price, previous.ram - kept.fromRam) };
    if (fits(refreshed)) return plan(null, refreshed);
  }

  // Every size this purchase can be, smallest first: a new server from 8 GB, or the smallest one from twice its RAM.
  const fromRam = atTheLimit ? (smallest as CloudServer).ram : 0;
  const hostname = atTheLimit ? (smallest as CloudServer).hostname : nextCloudServerName(hostnamesOf(mediumData));
  const sizes: CloudServerPurchase[] = [];
  for (let ram = atTheLimit ? fromRam * 2 : MIN_CLOUD_SERVER_RAM; ram <= CLOUD_SERVER_MAX_RAM; ram *= 2) {
    const price = cloudServerPrice(ram) - (atTheLimit ? cloudServerPrice(fromRam) : 0);
    sizes.push({
      action: atTheLimit ? "upgradeServer" : "buyServer",
      hostname,
      ram,
      price,
      paybackMs: paybackMs(price, ram - fromRam),
    });
  }
  const largest = sizes.filter(fits).at(-1);
  if (largest !== undefined) return plan(null, largest);
  const least = sizes[0] as CloudServerPurchase;
  if (least.paybackMs > CLOUD_SERVER_PAYBACK_LIMIT_MS) {
    return plan(
      `an income that pays a server back within ${formatMinutes(CLOUD_SERVER_PAYBACK_LIMIT_MS)} (at ` +
        `$${income.perGbSecond.toFixed(2)} a GB a second, ${formatMinutes(least.paybackMs)})`,
    );
  }
  const what =
    least.action === "buyServer" ? `${least.hostname} with ${least.ram} GB` : `${least.hostname} to ${least.ram} GB`;
  const held = reserve === null ? "" : `, beyond ${formatMoney(reserve.amount)} held for ${reserve.forWhat}`;
  return plan(`money for ${what} (${formatMoney(least.price)}${held})`);
}

/**
 * Whether `purchase` is still to do, as the snapshots show, and the RAM it adds to (0 for a new server), or null: a new
 * server whose name is still the next and under the limit, or one of the brain's own (`own`) not yet at its RAM.
 */
function stillToDo(
  purchase: CloudServerPurchase,
  servers: CloudServer[],
  own: CloudServer[],
  mediumData: MediumSnapshotData,
): { fromRam: number } | null {
  if (purchase.action === "upgradeServer") {
    const server = own.find((each) => each.hostname === purchase.hostname);
    return server !== undefined && server.ram < purchase.ram ? { fromRam: server.ram } : null;
  }
  const next =
    servers.length < CLOUD_SERVER_LIMIT && nextCloudServerName(hostnamesOf(mediumData)) === purchase.hostname;
  return next ? { fromRam: 0 } : null;
}
