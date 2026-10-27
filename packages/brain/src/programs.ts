// The brain's side of buying the hacking programs (#136, M3's second slice): the next item to buy, sent to the Agent in
// the desired state (architecture D2). The dashboard's switch turns it on and off; on is the default, as for the hack
// loop (owner decision 34's pattern).
import {
  type DesiredState,
  type MediumSnapshotData,
  PORT_OPENER_PROGRAMS,
  TECH_VENDORS,
  TOR_ROUTER,
} from "@bitburner-agent/core";
import { readSwitch } from "./switches.ts";
import type { TelemetryStore } from "./telemetry-store.ts";

export const PROGRAMS_ENABLED_SETTING = "programs.enabled";

/** What each item costs: the TOR router (`Constants.ts:44`) and the dark web's programs (`DarkWeb/DarkWebItems.ts`). */
export const PURCHASE_PRICES: Readonly<Record<string, number>> = {
  [TOR_ROUTER]: 200e3,
  "BruteSSH.exe": 500e3,
  "FTPCrack.exe": 1.5e6,
  "relaySMTP.exe": 5e6,
  "HTTPWorm.exe": 30e6,
  "SQLInject.exe": 250e6,
};

/** The dashboard's switch: on unless the owner turned it off. */
export function readProgramsEnabled(store: TelemetryStore): boolean {
  return readSwitch(store, PROGRAMS_ENABLED_SETTING, true);
}

/** What's owned, what's next and why it isn't bought yet. */
export interface PurchasePlan {
  /** The TOR router and the port openers owned, in buying order. */
  owned: string[];
  /** The next item to buy now, or null. */
  next: DesiredState["programs"]["next"];
  /** What the first item not owned costs, or null when everything is owned. */
  price: number | null;
  /** Why nothing is bought now, for the dashboard, or null when something is (or everything's owned). */
  waitingFor: string | null;
}

/**
 * The next item, in buying order (the TOR router, then the port openers cheapest first): the first not owned, if the
 * player's money covers it. The TOR router needs a tech vendor in the player's city. Snapshot data comes from the
 * game, so nothing in it is taken on trust: what can't be read counts as not owned, and as no money.
 */
export function chooseNextPurchase(mediumData: MediumSnapshotData): PurchasePlan {
  const ownedPrograms = Array.isArray(mediumData.programs) ? mediumData.programs : [];
  const owned = [
    ...(mediumData.hasTorRouter === true ? [TOR_ROUTER] : []),
    ...PORT_OPENER_PROGRAMS.filter((program) => ownedPrograms.includes(program)),
  ];
  const item = [TOR_ROUTER, ...PORT_OPENER_PROGRAMS].find((each) => !owned.includes(each));
  if (item === undefined) return { owned, next: null, price: null, waitingFor: null };
  const money = typeof mediumData.player?.money === "number" ? mediumData.player.money : 0;
  const price = PURCHASE_PRICES[item];
  // Fail fast: an item with no price would otherwise always look affordable.
  if (price === undefined) throw new Error(`no price for ${item}`);
  const waiting = (waitingFor: string): PurchasePlan => ({ owned, next: null, price, waitingFor });
  if (money < price) return waiting(`money for ${item} ($${price.toLocaleString("en-US")})`);
  if (item !== TOR_ROUTER) return { owned, next: { item, vendor: null }, price, waitingFor: null };
  const city = mediumData.player?.city;
  const vendor = typeof city === "string" ? TECH_VENDORS[city] : undefined;
  if (vendor === undefined) return waiting(`travel: no tech vendor sells the TOR router in ${String(city)}`);
  return { owned, next: { item, vendor }, price, waitingFor: null };
}
