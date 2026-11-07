/**
 * The cycle's money in hand (#263): the game's hacking income since the install (the curves' gross) less what the brain
 * spends through the cycle, by the brain's own rules (packages/brain/src/desired-state.ts `#choosePurchase`,
 * `#chooseProgramOrHomeRam` and `#reserveForOtherPurchase`; packages/brain/src/cloud-servers.ts
 * `chooseCloudServerPurchase`; packages/brain/src/home-ram.ts), one purchase at a time (`nextPurchase`):
 * - a program (the TOR router and the port openers) or home's RAM, the cheaper of those the money covers: a program
 *   not in the install's countdown (they're lost at it) nor into The Red Pill's donation's money; home's RAM not into
 *   any money A6 holds;
 * - else a cloud server: none before the hack loop's income is measured over a full window, then the largest power of
 *   two of RAM the money covers, less the cheaper of the next program and home's RAM if the income brings it within a
 *   minute and less what A6 holds from cloud servers, that pays for itself within 15 min at the income a GB of the hack
 *   loop's hosts (the rooted world servers and the cloud servers); a new server from 8 GB while fewer than 25, else the
 *   smallest one upgraded.
 * #294: the brain's cadence and its measure of the income (#207's payback rule). It buys one purchase a medium snapshot
 * (every 10 s: the next is chosen from the snapshot that shows the last done), and measures the hack loop's income as
 * the money's rises between medium snapshots over its hosts' RAM × time, across the last 10 minutes of the Agent's
 * snapshots since it connected (`IncomeWindow`, the brain's `HackLoopIncome`): a purchase between two snapshots lowers
 * the money, so the rise it hides isn't counted, and a server just bought weighs only from its first snapshot. Tested
 * against the brain's own choice and measure on the same inputs (packages/brain/test/desired-state.test.ts and
 * cloud-servers.test.ts, "brain against the fast model"). Run #3's BN1.2 (#263's comment) bears the rules out: the
 * cloud servers' 25 × 1 PB ($1.44t) by 30 min each cycle from the 3rd; home's upgrades at core's price (in the 4th
 * cycle, $416.68t on servers all told: the $1.44t of cloud servers, 512 TB → 1 PB → 2 PB of home's). The augmentations
 * are bought at the commit.
 */
import {
  CLOUD_SERVER_MAX_RAM,
  HOME_RAM_LIMIT,
  homeRamUpgradePrice,
  SNAPSHOT_TIER_PERIOD_MS,
} from "@bitburner-agent/core";

/**
 * The TOR router (`Constants.ts:44`), then the port openers, cheapest first (`DarkWeb/DarkWebItems.ts:6-10`): the
 * brain's `PURCHASE_PRICES` in that order.
 */
export const PROGRAM_PRICES: readonly number[] = [200e3, 500e3, 1.5e6, 5e6, 30e6, 250e6];
/** BN1's price of a GB of a cloud server (`Server/data/Constants.ts:4`); the brain's `CLOUD_SERVER_PRICE_PER_GB`. */
export const CLOUD_SERVER_PRICE_PER_GB = 55_000;
/** BN1's limit on cloud servers (`Server/ServerPurchases.ts:96-98`); the brain's `CLOUD_SERVER_LIMIT`. */
export const CLOUD_SERVER_LIMIT = 25;
/** The least RAM the brain buys a server with; the brain's `MIN_CLOUD_SERVER_RAM`. */
export const MIN_CLOUD_SERVER_RAM = 8;
/** No cloud server before the income is measured over this; the brain's `CLOUD_SERVER_INCOME_WINDOW_MS`. */
export const CLOUD_SERVER_INCOME_WINDOW_MS = 10 * 60_000;
/** A server pays for itself within this at the income a GB; the brain's `CLOUD_SERVER_PAYBACK_LIMIT_MS`. */
export const CLOUD_SERVER_PAYBACK_LIMIT_MS = 15 * 60_000;
/** The next program or home's RAM is held from cloud servers if the income brings it within this; the brain's. */
export const CLOUD_SERVER_RESERVE_HORIZON_MS = 60_000;
/** The brain's purchases: one a medium snapshot (core's `SNAPSHOT_TIER_PERIOD_MS.medium`, 10 s). */
export const PURCHASE_EVERY_MS = SNAPSHOT_TIER_PERIOD_MS.medium;
/**
 * The first medium snapshot the brain's income measure takes after an install, ms: the page's timer starts the Agent
 * again within seconds of the reset (packages/ingame/src/page/install-page.ts), and its first medium snapshot comes
 * before its static one, so the measure skips it (`HackLoopIncome.add`) and starts at the next, a medium period on.
 * Rounded up to the model's 10-s ticks: 20 s.
 */
export const FIRST_INCOME_SAMPLE_MS = 2 * PURCHASE_EVERY_MS;

/** The hack loop's income as the brain measures it (cloud-servers.ts `HackLoopIncomeRate`): a second, a GB a second. */
export interface IncomeRate {
  perSecond: number;
  perGbSecond: number;
}

/** A medium snapshot as the brain's income measure keeps it: when, the money in hand, the hack loop's hosts' RAM. */
export interface IncomeSample {
  atMs: number;
  money: number;
  hostsRam: number;
}

/**
 * The brain's income measure (packages/brain/src/cloud-servers.ts `HackLoopIncome`), line for line: the money's rises
 * between medium snapshots added up (a purchase lowers the money, which isn't income), over the hosts' RAM × time (each
 * stretch at the RAM of the snapshot that starts it), across the last `CLOUD_SERVER_INCOME_WINDOW_MS`; null until the
 * samples span it, or with no RAM to earn on.
 */
export class IncomeWindow {
  #samples: IncomeSample[] = [];

  add(sample: IncomeSample): void {
    this.#samples.push(sample);
    const windowStart = sample.atMs - CLOUD_SERVER_INCOME_WINDOW_MS;
    while (this.#samples.length > 1 && (this.#samples[1] as IncomeSample).atMs <= windowStart) this.#samples.shift();
  }

  rate(): IncomeRate | null {
    const first = this.#samples[0];
    const last = this.#samples.at(-1);
    if (first === undefined || last === undefined) return null;
    if (last.atMs - first.atMs < CLOUD_SERVER_INCOME_WINDOW_MS) return null;
    let earned = 0;
    let gbSeconds = 0;
    for (let index = 1; index < this.#samples.length; index++) {
      const before = this.#samples[index - 1] as IncomeSample;
      const after = this.#samples[index] as IncomeSample;
      earned += Math.max(0, after.money - before.money);
      gbSeconds += (before.hostsRam * (after.atMs - before.atMs)) / 1000;
    }
    if (!(gbSeconds > 0)) return null;
    return { perSecond: earned / ((last.atMs - first.atMs) / 1000), perGbSecond: earned / gbSeconds };
  }
}

/** What the brain has spent and owns this cycle. Home's RAM is kept across installs; the rest is lost at one. */
export interface Purse {
  /** Spent since the install: programs, home's RAM and cloud servers. */
  spent: number;
  /** Of `PROGRAM_PRICES`, how many bought: the TOR router first, so the ports open are one fewer. */
  programs: number;
  /** Each cloud server's RAM, GB. */
  cloudServersRamGb: number[];
  homeRamGb: number;
}

export function freshPurse(homeRamGb: number): Purse {
  return { spent: 0, programs: 0, cloudServersRamGb: [], homeRamGb };
}

/** The ports the programs bought open: one a port opener (the TOR router opens none). */
export function portsOpen(purse: Purse): number {
  return Math.max(0, purse.programs - 1);
}

export function cloudRamOf(purse: Purse): number {
  return purse.cloudServersRamGb.reduce((sum, each) => sum + each, 0);
}

/** What A6 holds back from each purchase (packages/brain/src/desired-state.ts `#chooseProgramOrHomeRam`). */
export interface Holds {
  /** From home's RAM: the countdown's or #243's hold's money, Daedalus's $100b, The Red Pill's donation, the most. */
  fromHomeRam: number;
  /** From programs: The Red Pill's donation only (the brain's invitations' hold isn't modelled). */
  fromPrograms: number;
  /** From cloud servers (`#reserveForOtherPurchase`): A6's reserve, the lookahead's included. */
  fromCloudServers: number;
  /** The install's countdown or #243's hold under way: no program is bought (they're lost at the install). */
  countdownUnderWay: boolean;
}

export const NO_HOLDS: Holds = { fromHomeRam: 0, fromPrograms: 0, fromCloudServers: 0, countdownUnderWay: false };

/** One purchase: a program (the next of `PROGRAM_PRICES`), home's next upgrade, or a cloud server. */
export type Purchase =
  | { kind: "program"; price: number }
  | { kind: "homeRam"; fromRamGb: number; price: number }
  | { kind: "cloudServer"; serverIndex: number | null; ramGb: number; price: number };

/**
 * The brain's next purchase with `cash` in hand, the hack loop's income as the brain measures it (`IncomeWindow`; null
 * before a full window) and A6's holds; null for none. With `cloud` false no cloud server is bought (the comparison's
 * first-purchase variant).
 */
export function nextPurchase(
  purse: Purse,
  cash: number,
  income: IncomeRate | null,
  holds: Holds,
  cloud = true,
): Purchase | null {
  const programPrice = PROGRAM_PRICES[purse.programs];
  const homeRamPrice = purse.homeRamGb < HOME_RAM_LIMIT ? homeRamUpgradePrice(purse.homeRamGb) : undefined;
  const programAllowed =
    programPrice !== undefined &&
    cash >= programPrice &&
    !holds.countdownUnderWay &&
    !(holds.fromPrograms > 0 && cash - programPrice < holds.fromPrograms);
  const homeRamAllowed =
    homeRamPrice !== undefined &&
    cash >= homeRamPrice &&
    !(holds.fromHomeRam > 0 && cash - homeRamPrice < holds.fromHomeRam);
  if (programAllowed && (!homeRamAllowed || (programPrice as number) <= (homeRamPrice as number))) {
    return { kind: "program", price: programPrice as number };
  }
  if (homeRamAllowed) return { kind: "homeRam", fromRamGb: purse.homeRamGb, price: homeRamPrice as number };
  if (!cloud) return null;
  return cloudPurchase(purse, cash, income, holds, [programPrice, homeRamPrice]);
}

/** The purse after `purchase` (null: as it was). */
export function afterPurchase(purse: Purse, purchase: Purchase | null): Purse {
  if (purchase === null) return purse;
  const after: Purse = { ...purse, spent: purse.spent + purchase.price };
  if (purchase.kind === "program") after.programs += 1;
  else if (purchase.kind === "homeRam") after.homeRamGb *= 2;
  else {
    after.cloudServersRamGb = [...purse.cloudServersRamGb];
    if (purchase.serverIndex === null) after.cloudServersRamGb.push(purchase.ramGb);
    else after.cloudServersRamGb[purchase.serverIndex] = purchase.ramGb;
  }
  return after;
}

/** The brain's next cloud purchase (`chooseCloudServerPurchase` with `#reserveForOtherPurchase`), or null. */
function cloudPurchase(
  purse: Purse,
  cash: number,
  income: IncomeRate | null,
  holds: Holds,
  waitingPrices: readonly (number | undefined)[],
): Purchase | null {
  if (income === null || !(income.perGbSecond > 0)) return null;
  const servers = purse.cloudServersRamGb;
  const atTheLimit = servers.length >= CLOUD_SERVER_LIMIT;
  const serverIndex = atTheLimit ? servers.indexOf(Math.min(...servers)) : null;
  const fromRamGb = serverIndex === null ? 0 : (servers[serverIndex] as number);
  if (fromRamGb >= CLOUD_SERVER_MAX_RAM) return null;
  // The cheaper of the next program and home's RAM (the program's even in the countdown, as the brain's plan has it),
  // held if the income brings it within the horizon.
  const cheaperWaiting = Math.min(...waitingPrices.filter((price): price is number => price !== undefined));
  const heldForNext =
    cheaperWaiting - cash <= (income.perSecond * CLOUD_SERVER_RESERVE_HORIZON_MS) / 1000 ? cheaperWaiting : 0;
  const spendable = cash - Math.max(holds.fromCloudServers, heldForNext);
  // The hack loop's income a GB a second over its hosts, as the brain measures it.
  const { perGbSecond } = income;
  let best: Purchase | null = null;
  for (
    let ramGb = serverIndex === null ? MIN_CLOUD_SERVER_RAM : fromRamGb * 2;
    ramGb <= CLOUD_SERVER_MAX_RAM;
    ramGb *= 2
  ) {
    const price = (ramGb - fromRamGb) * CLOUD_SERVER_PRICE_PER_GB;
    const paybackMs = (price / ((ramGb - fromRamGb) * perGbSecond)) * 1000;
    if (price <= spendable && paybackMs <= CLOUD_SERVER_PAYBACK_LIMIT_MS)
      best = { kind: "cloudServer", serverIndex, ramGb, price };
  }
  return best;
}
