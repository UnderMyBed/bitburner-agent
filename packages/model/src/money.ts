/**
 * The cycle's money in hand (#263): the game's hacking income since the install (the curves' gross) less what the brain
 * spends through the cycle, by the brain's own rules (packages/brain/src/desired-state.ts `#choosePurchase`,
 * packages/brain/src/cloud-servers.ts `chooseCloudServerPurchase`, packages/brain/src/home-ram.ts):
 * - a program (the TOR router and the port openers) or home's RAM, the cheaper first, each once the money less what
 *   the augmentations hold covers it; no program in the install's countdown (they're lost at it);
 * - else a cloud server: none before the income window (10 min online), then the largest power of two of RAM the money
 *   covers, less the cheaper of the next program and home's RAM if the income brings it within a minute and less what
 *   the augmentations hold from cloud servers, that pays for itself within 15 min at the income a GB; a new server from
 *   8 GB while fewer than 25, else the smallest one upgraded.
 * Run #3's BN1.2 (#263's comment) bears it out: the cloud servers' 25 × 1 PB ($1.44t) by 30 min each cycle from the
 * 3rd, and home's upgrades at core's price ($416.68t in the 4th cycle: 512 TB → 1 PB → 2 PB; $997.84t, 2 PB → 4 PB, in
 * the 8th). The augmentations themselves are bought at the commit (`cycles.ts`).
 */
import { HOME_RAM_LIMIT, homeRamUpgradePrice } from "@bitburner-agent/core";

/** The TOR router (`Constants.ts:44`), then the port openers, cheapest first (`DarkWeb/DarkWebItems.ts:6-10`). */
export const PROGRAM_PRICES: readonly number[] = [200e3, 500e3, 1.5e6, 5e6, 30e6, 250e6];
/** BN1's price of a GB of a cloud server (`Server/data/Constants.ts:4`); the brain's `CLOUD_SERVER_PRICE_PER_GB`. */
export const CLOUD_SERVER_PRICE_PER_GB = 55_000;
/** BN1's limit on cloud servers (`Server/ServerPurchases.ts:96-98`); the brain's `CLOUD_SERVER_LIMIT`. */
export const CLOUD_SERVER_LIMIT = 25;
/** The least RAM the brain buys a server with; the brain's `MIN_CLOUD_SERVER_RAM`. */
export const MIN_CLOUD_SERVER_RAM = 8;
/** The most a cloud server can have (core's `CLOUD_SERVER_MAX_RAM`, `Server/data/Constants.ts:13`). */
export const CLOUD_SERVER_MAX_RAM = 2 ** 20;
/** No cloud server before the income is measured over this, online; the brain's `CLOUD_SERVER_INCOME_WINDOW_MS`. */
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
  cloud: number[];
  homeRamGb: number;
}

export function freshPurse(homeRamGb: number): Purse {
  return { spent: 0, programs: 0, cloud: [], homeRamGb };
}

/** The ports the programs bought open: one a port opener (the TOR router opens none). */
export function portsOpen(purse: Purse): number {
  return Math.max(0, purse.programs - 1);
}

export function cloudRamOf(purse: Purse): number {
  return purse.cloud.reduce((sum, each) => sum + each, 0);
}

/** What the brain holds back from a purchase this step. */
export interface Holds {
  /** From programs and home's RAM: the install's countdown (or #243's hold), Daedalus's $100b, The Red Pill's. */
  home: number;
  /** From cloud servers: that, or the lookahead's reserve, where more. */
  cloud: number;
  /** The install's countdown or #243's hold under way: no program is bought. */
  countdown: boolean;
}

export const NO_HOLDS: Holds = { home: 0, cloud: 0, countdown: false };

/**
 * The purse after the step's purchases, with the cycle's `gross` income so far (the money in hand is `gross` less
 * `spent`), its rate a second (`income`, null before there's one) and the time online.
 */
export function spendThroughCycle(
  purse: Purse,
  gross: number,
  income: number | null,
  onlineMs: number,
  holds: Holds = NO_HOLDS,
): Purse {
  const next: Purse = { ...purse, cloud: [...purse.cloud] };
  for (let bought = 0; bought < MOST_PURCHASES_A_STEP; bought++) {
    const cash = gross - next.spent;
    const program = holds.countdown ? undefined : PROGRAM_PRICES[next.programs];
    const home = next.homeRamGb < HOME_RAM_LIMIT ? homeRamUpgradePrice(next.homeRamGb) : undefined;
    const affordable = [program, home].filter((price) => price !== undefined && cash - price >= holds.home);
    const cheaper = Math.min(...(affordable as number[]));
    if (affordable.length > 0) {
      next.spent += cheaper;
      if (cheaper === program) next.programs += 1;
      else next.homeRamGb *= 2;
      continue;
    }
    const purchase = cloudPurchase(next, cash, income, onlineMs, holds, [program, home]);
    if (purchase === null) break;
    next.spent += purchase.price;
    if (purchase.index === null) next.cloud.push(purchase.ram);
    else next.cloud[purchase.index] = purchase.ram;
  }
  return next;
}

/** The brain's next cloud purchase (`chooseCloudServerPurchase`), or null. */
function cloudPurchase(
  purse: Purse,
  cash: number,
  income: number | null,
  onlineMs: number,
  holds: Holds,
  waiting: readonly (number | undefined)[],
): { index: number | null; ram: number; price: number } | null {
  if (onlineMs < CLOUD_SERVER_INCOME_WINDOW_MS || income === null || !(income > 0)) return null;
  const atTheLimit = purse.cloud.length >= CLOUD_SERVER_LIMIT;
  const index = atTheLimit ? purse.cloud.indexOf(Math.min(...purse.cloud)) : null;
  const fromRam = index === null ? 0 : (purse.cloud[index] as number);
  if (fromRam >= CLOUD_SERVER_MAX_RAM) return null;
  // The cheaper of the next program and home's RAM, held if the income brings it within the horizon.
  const cheaper = Math.min(...waiting.filter((price): price is number => price !== undefined));
  const other = cheaper - cash <= (income * CLOUD_SERVER_RESERVE_HORIZON_MS) / 1000 ? cheaper : 0;
  const spendable = cash - Math.max(holds.cloud, other);
  // The hack loop's income a GB a second, over the cloud servers (the world's servers left out: the safe side).
  const cloudRam = cloudRamOf(purse);
  const perGbSecond = cloudRam > 0 ? income / cloudRam : Number.POSITIVE_INFINITY;
  let best: { index: number | null; ram: number; price: number } | null = null;
  for (let ram = index === null ? MIN_CLOUD_SERVER_RAM : fromRam * 2; ram <= CLOUD_SERVER_MAX_RAM; ram *= 2) {
    const price = (ram - fromRam) * CLOUD_SERVER_PRICE_PER_GB;
    const paybackMs = (price / ((ram - fromRam) * perGbSecond)) * 1000;
    if (price <= spendable && paybackMs <= CLOUD_SERVER_PAYBACK_LIMIT_MS) best = { index, ram, price };
  }
  return best;
}
