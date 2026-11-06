/**
 * The city group to join this cycle (#228, owner decision 54), moved from the brain to core (#260) so the fast model
 * (packages/model) joins the same factions: each group's worth, what its invitations cost, and the choice. Pure, from
 * core's faction and augmentation data; the brain's invitation rule (packages/brain/src/invitations.ts) reads the
 * snapshots, calls these, and travels.
 */
import { type DaedalusCount, isWorthInstalling } from "./augmentation-plan.ts";
import { augmentationsSoldBy } from "./augmentations.ts";
import { FACTIONS } from "./faction-data.ts";
import type { FactionState } from "./faction-state.ts";
import { hackingValue } from "./faction-work.ts";
import {
  CITY_FACTION_GROUPS,
  FACTION_ENEMIES,
  FACTION_NAMES,
  TIAN_DI_HUI,
  TIAN_DI_HUI_HACKING,
  TIAN_DI_HUI_MONEY,
} from "./factions.ts";
import { TECH_VENDORS, TRAVEL_COST } from "./locations.ts";

/** Where the brain goes for Tian Di Hui's invitation: a Tian Di Hui city with a tech vendor (Omega Software). */
export const TIAN_DI_HUI_TRAVEL_CITY = "Ishima";

/** What the rule reads (#228): the faction state, the reset info, the player. */
export interface InvitationInputs {
  state: FactionState;
  count: DaedalusCount;
  currentNode: number;
  /** The game's last install: the city group's choice is kept for its cycle. */
  lastAugReset: number;
  installed: Readonly<Record<string, number>>;
  hackingLevel: number;
  money: number;
  city: string;
  /** The city factions the owner queued `joinFaction` for (#228 review): one fixes the group. */
  ownersJoins?: readonly string[];
}

/** A city faction's invitation: its city and money (core's `FACTIONS`, `Faction/FactionInfo.tsx:495-555`). */
export function cityInvitation(faction: string): { city: string; money: number } {
  const requirements = FACTIONS[faction]?.inviteRequirements ?? [];
  const city = requirements.find((each) => each.type === "city")?.city;
  const money = requirements.find((each) => each.type === "money")?.money;
  if (typeof city !== "string" || typeof money !== "number") throw new RangeError(`${faction} isn't a city faction`);
  return { city, money };
}

/** Tian Di Hui's augmentations A6 would install (core's `isWorthInstalling`, short or not), not installed or queued. */
export function tianDiHuiWanted(
  state: FactionState,
  currentNode: number,
  installed: Readonly<Record<string, number>>,
  short: boolean,
): string[] {
  return augmentationsSoldBy(TIAN_DI_HUI, currentNode, null).filter(
    (name) =>
      isWorthInstalling(name, short) && !Object.hasOwn(installed, name) && !state.queuedAugmentations.includes(name),
  );
}

export const joinedOrInvited = (state: FactionState, faction: string) =>
  state.invitations.includes(faction) || state.joined.some((each) => each.name === faction);

/** One city group's worth this cycle (#228). */
export interface CityGroupValue {
  group: string;
  /** Its factions that sell something of value, not joined: those it visits and joins. */
  factions: string[];
  /** What they sell of value. */
  augmentations: string[];
  /** Short of Daedalus's count, how many; else their hacking values summed. */
  value: number;
  /** The travels its visits take from where the player is, and the money they need (the most held, and the tickets). */
  travels: number;
  money: number;
  affordable: boolean;
}

/** The choice and why: the group (null for none), and every group's worth. */
export interface CityGroupChoice {
  group: string | null;
  factions: string[];
  short: boolean;
  values: { group: string; value: number; affordable: boolean }[];
}

/** A stop: its city, the invitations it's for (not yet shown), and the money to hold for them. */
export interface Visit {
  city: string;
  factions: string[];
  money: number;
}

/** The stops for a group (null: none) and Tian Di Hui's, the one where the player is first (#228). */
export function visitsFor(
  group: string | null,
  factions: readonly string[],
  tianDiHui: boolean,
  city: string,
): Visit[] {
  const visits: Visit[] = [];
  const add = (visitCity: string, faction: string, money: number) => {
    const visit = visits.find((each) => each.city === visitCity);
    if (visit === undefined) visits.push({ city: visitCity, factions: [faction], money });
    else {
      visit.factions.push(faction);
      visit.money = Math.max(visit.money, money);
    }
  };
  // Group B's Ishima is its tech vendor, so its stop comes last, with Tian Di Hui's; elsewhere Tian Di Hui's goes
  // first.
  if (tianDiHui && group !== "B") add(TIAN_DI_HUI_TRAVEL_CITY, TIAN_DI_HUI, TIAN_DI_HUI_MONEY);
  for (const faction of CITY_FACTION_GROUPS.find((each) => each.name === group)?.factions ?? []) {
    if (factions.includes(faction)) add(cityInvitation(faction).city, faction, cityInvitation(faction).money);
  }
  if (tianDiHui && group === "B") add(TIAN_DI_HUI_TRAVEL_CITY, TIAN_DI_HUI, TIAN_DI_HUI_MONEY);
  const here = visits.findIndex((each) => each.city === city);
  return here <= 0 ? visits : [visits[here] as Visit, ...visits.filter((_, index) => index !== here)];
}

/** How many travels the visits take from `city`. */
function travelsFrom(city: string, visits: readonly Visit[]): number {
  let at = city;
  let travels = 0;
  for (const visit of visits) {
    if (visit.city !== at) travels += 1;
    at = visit.city;
  }
  return travels;
}

/** Whether Tian Di Hui is wanted and still to visit for: not joined or invited, and the hacking level for it. */
export function tianDiHuiVisit(inputs: InvitationInputs, wanted: readonly string[]): boolean {
  return wanted.length > 0 && !joinedOrInvited(inputs.state, TIAN_DI_HUI) && inputs.hackingLevel >= TIAN_DI_HUI_HACKING;
}

/**
 * Each city group's worth (#228): what its factions sell that A6 would install (short or not), not installed or
 * queued, nor sold by a joined faction or Tian Di Hui when it will join (joined, invited, or wanted at hacking 50).
 */
export function cityGroupValues(inputs: InvitationInputs): CityGroupValue[] {
  const { state, count, currentNode, installed, hackingLevel, money, city } = inputs;
  const wanted = tianDiHuiWanted(state, currentNode, installed, count.short);
  const elsewhere = new Set<string>();
  for (const { name } of state.joined) {
    if (FACTION_NAMES.includes(name))
      for (const each of augmentationsSoldBy(name, currentNode, null)) elsewhere.add(each);
  }
  const tianDiHuiJoins =
    joinedOrInvited(state, TIAN_DI_HUI) || (wanted.length > 0 && hackingLevel >= TIAN_DI_HUI_HACKING);
  if (tianDiHuiJoins) for (const each of augmentationsSoldBy(TIAN_DI_HUI, currentNode, null)) elsewhere.add(each);
  const ofValue = (faction: string) =>
    augmentationsSoldBy(faction, currentNode, null).filter(
      (name) =>
        isWorthInstalling(name, count.short) &&
        !Object.hasOwn(installed, name) &&
        !state.queuedAugmentations.includes(name) &&
        !elsewhere.has(name),
    );
  return CITY_FACTION_GROUPS.map(({ name: group, factions: members }) => {
    const factions = members.filter(
      (faction) => !state.joined.some((each) => each.name === faction) && ofValue(faction).length > 0,
    );
    const augmentations = [...new Set(factions.flatMap(ofValue))];
    const value = count.short
      ? augmentations.length
      : augmentations.reduce((sum, name) => sum + hackingValue(name, hackingLevel), 0);
    const visits = visitsFor(group, factions, tianDiHuiVisit(inputs, wanted), city);
    // Group B's last stop away from Ishima: the hop to its tech vendor too (#228 review).
    const last = visits.at(-1)?.city;
    const endHop = group === "B" && last !== undefined && TECH_VENDORS[last] === undefined ? 1 : 0;
    const travels = travelsFrom(city, visits) + endHop;
    const needed = Math.max(0, ...visits.map((visit) => visit.money)) + travels * TRAVEL_COST;
    return { group, factions, augmentations, value, travels, money: needed, affordable: money >= needed };
  });
}

/** The group a city faction joined is in, or null: fixed for the cycle, the game having banned the rest. */
export function joinedGroup(state: FactionState): string | null {
  const joined = state.joined.find((each) => FACTION_ENEMIES[each.name] !== undefined);
  return groupOf(joined?.name ?? null);
}

/** The city group `faction` is in, or null. */
function groupOf(faction: string | null): string | null {
  return CITY_FACTION_GROUPS.find((group) => group.factions.includes(faction ?? ""))?.name ?? null;
}

/**
 * The city group to join this cycle (#228): the one a city faction joined is in; else the one of a city faction the
 * owner queued to join (#228 review: their join would wait on its invitation, and the brain's join of another group's
 * would ban it); else `kept`, the cycle's choice once made (its travels under way, it isn't chosen again on the money
 * or the value moving); else the most value of those the money can earn, ties to the fewest travels, then the groups'
 * order. None with value: none.
 */
export function chooseCityGroup(
  values: readonly CityGroupValue[],
  state: FactionState,
  kept: string | null = null,
  ownersJoins: readonly string[] = [],
): CityGroupValue | null {
  const fixed = joinedGroup(state) ?? groupOf(ownersJoins.find((faction) => groupOf(faction) !== null) ?? null);
  if (fixed !== null) return values.find((each) => each.group === fixed) ?? null;
  const keptValue = values.find((each) => each.group === kept);
  if (keptValue !== undefined) return keptValue;
  let best: CityGroupValue | null = null;
  for (const each of values) {
    if (!(each.value > 0) || !each.affordable) continue;
    if (best === null || each.value > best.value || (each.value === best.value && each.travels < best.travels)) {
      best = each;
    }
  }
  return best;
}
