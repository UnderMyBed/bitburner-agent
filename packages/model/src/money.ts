/**
 * The cycle's money in hand (#263): the game's hacking income since the install (the curves' gross) less what the brain
 * spends through the cycle, by the brain's own rules (packages/brain/src/desired-state.ts `#choosePurchase`,
 * `#chooseProgramOrHomeRam` and `#reserveForOtherPurchase`; packages/brain/src/cloud-servers.ts
 * `chooseCloudServerPurchase`; packages/brain/src/home-ram.ts), one purchase at a time (`nextPurchase`):
 * - a program (the TOR router and the port openers) or home's RAM, the cheaper of those the money covers: a program
 *   not in the install's countdown (they're lost at it) nor into The Red Pill's donation's money; home's RAM not into
 *   any money A6 holds;
 * - else a cloud server: none before the income window (10 min), then the largest power of two of RAM the money covers,
 *   less the cheaper of the next program and home's RAM if the income brings it within a minute and less what A6 holds
 *   from cloud servers, that pays for itself within 15 min at the income a GB of the hack loop's hosts (the rooted
 *   world servers and the cloud servers); a new server from 8 GB while fewer than 25, else the smallest one upgraded.
 * Tested against the brain's own choice on the same purse and income (packages/brain/test/desired-state.test.ts,
 * "brain against the fast model"). Run #3's BN1.2 (#263's comment) bears the rules out: the cloud servers' 25 × 1 PB
 * ($1.44t) by 30 min each cycle from the 3rd; home's upgrades at core's price (in the 4th cycle, $416.68t on servers
 * all told: the $1.44t of cloud servers, 512 TB → 1 PB → 2 PB of home's). The augmentations are bought at the commit.
 */
import { CLOUD_SERVER_MAX_RAM, HOME_RAM_LIMIT, homeRamUpgradePrice } from "@bitburner-agent/core";

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
/** The most purchases a step: a guard, never reached in BN1 (6 programs, 30 of home's, 25 × 18 of cloud). */
const MOST_PURCHASES_A_STEP = 1000;

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
 * The brain's next purchase with `cash` in hand, the hack loop's `income` a second (null before it's measured over the
 * window), the time online, A6's holds and the rooted world servers' RAM (the hack loop's other hosts); null for none.
 */
export function nextPurchase(
  purse: Purse,
  cash: number,
  income: number | null,
  onlineMs: number,
  holds: Holds,
  worldRamGb: number,
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
  return cloudPurchase(purse, cash, income, onlineMs, holds, worldRamGb, [programPrice, homeRamPrice]);
}

/**
 * The purse after the step's purchases, one after another (`nextPurchase`), with the cycle's `gross` income so far (the
 * money in hand is `gross` less `spent`), the income, the time online, A6's holds and the world servers' RAM.
 */
export function spendThroughCycle(
  purse: Purse,
  gross: number,
  income: number | null,
  onlineMs: number,
  holds: Holds,
  worldRamGb: number,
): Purse {
  const after: Purse = { ...purse, cloudServersRamGb: [...purse.cloudServersRamGb] };
  for (let bought = 0; bought < MOST_PURCHASES_A_STEP; bought++) {
    const purchase = nextPurchase(after, gross - after.spent, income, onlineMs, holds, worldRamGb);
    if (purchase === null) break;
    after.spent += purchase.price;
    if (purchase.kind === "program") after.programs += 1;
    else if (purchase.kind === "homeRam") after.homeRamGb *= 2;
    else if (purchase.serverIndex === null) after.cloudServersRamGb.push(purchase.ramGb);
    else after.cloudServersRamGb[purchase.serverIndex] = purchase.ramGb;
  }
  return after;
}

/** The brain's next cloud purchase (`chooseCloudServerPurchase` with `#reserveForOtherPurchase`), or null. */
function cloudPurchase(
  purse: Purse,
  cash: number,
  income: number | null,
  onlineMs: number,
  holds: Holds,
  worldRamGb: number,
  waitingPrices: readonly (number | undefined)[],
): Purchase | null {
  if (onlineMs < CLOUD_SERVER_INCOME_WINDOW_MS || income === null || !(income > 0)) return null;
  const servers = purse.cloudServersRamGb;
  const atTheLimit = servers.length >= CLOUD_SERVER_LIMIT;
  const serverIndex = atTheLimit ? servers.indexOf(Math.min(...servers)) : null;
  const fromRamGb = serverIndex === null ? 0 : (servers[serverIndex] as number);
  if (fromRamGb >= CLOUD_SERVER_MAX_RAM) return null;
  // The cheaper of the next program and home's RAM (the program's even in the countdown, as the brain's plan has it),
  // held if the income brings it within the horizon.
  const cheaperWaiting = Math.min(...waitingPrices.filter((price): price is number => price !== undefined));
  const heldForNext = cheaperWaiting - cash <= (income * CLOUD_SERVER_RESERVE_HORIZON_MS) / 1000 ? cheaperWaiting : 0;
  const spendable = cash - Math.max(holds.fromCloudServers, heldForNext);
  // The hack loop's income a GB a second over its hosts: the rooted world servers and the cloud servers.
  const perGbSecond = income / (worldRamGb + cloudRamOf(purse));
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
