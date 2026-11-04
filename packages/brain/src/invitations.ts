// Travel for invitations, and Daedalus's count (#228, owner decision 54): 30 installed augmentations in BN1
// (`BitNodeMultipliers.DaedalusAugsRequirement`), NeuroFlux Governor counted once (`FactionJoinCondition.ts:130`; its
// levels are one entry's, `Augmentation/AugmentationHelpers.ts:55-58`). Short of it (core's `daedalusCountOf`), A6
// installs any augmentation and A5 works for any (core's `isWorthInstalling`); this rule brings the factions selling
// them within reach.
// - Tian Di Hui: no enemies, eight augmentations, and an invitation only for a player in Chongqing, New Tokyo or Ishima,
//   with hacking 50 and $1m held at the game's check (`Faction/FactionInfo.tsx:680-692`), every 10 engine cycles,
//   about 2 s (`engine.tsx:154`, `:177-183`). While it sells one A6 would install, neither installed nor queued, and it
//   isn't joined or invited, with hacking 50, the brain visits Ishima: a Tian Di Hui city with a tech vendor
//   (`TECH_VENDORS`), so home RAM and the TOR router are still bought there.
// - The city factions (owner decision 54: the brain chooses, by computed value). Joining one bans its enemies
//   (`Faction/FactionHelpers.tsx:45-48`) until the next install lifts every ban (`Faction/Faction.ts:77-85`), so the
//   brain chooses one group of core's `CITY_FACTION_GROUPS` a cycle: A (Sector-12, Aevum), B (Chongqing, New Tokyo,
//   Ishima) or C (Volhaven). A group's value is what its factions sell that A6 would install, not installed or queued,
//   nor sold by a joined faction or Tian Di Hui (when it will join): short of Daedalus's count, how many; otherwise
//   their hacking values summed (core's `hackingValue`). The choice: the most value, of the groups whose invitations
//   the money can earn (each faction's money, `Faction/FactionInfo.tsx:495-555`, and the tickets); ties to the fewest
//   travels, then the group's order. None with value, none chosen. Kept for the cycle once chosen (and fixed by a city
//   faction joined); A5 joins only its factions that sell something of value, and never another group's.
// - The visits: each a city and the invitations it's for, the one where the player is first, Tian Di Hui's with group
//   B's Ishima (one stop for both). Travel (#141's intent) to the next, with its money and the ticket; there, its money
//   is held from cloud servers, home RAM and programs (as #215's $100b for Daedalus) until the invitations show; held
//   5 minutes with the money and none, the `notInvited` phase is loud. Group B ends in Ishima, its tech vendor.
// - Each cycle afresh: an install puts the player back in Sector-12 (`PlayerObjectGeneralMethods.ts:104`) and drops
//   every faction. No travel with the owner's work set (a class or a job is in a city), the owner's own travel queued,
//   or the Augmentations switch off; and with an install under way (A6's countdown or commit), none for invitations,
//   only from Chongqing or New Tokyo to Ishima's tech vendor, so home's RAM is still bought before it. The irreversible
//   gate's enemy guard stays under the joins.
// - The reach: how many more augmentations the brain could still install, and where: the joined factions, those
//   inviting without enemies, the hacker factions (A3's backdoors), Tian Di Hui once the hacking level allows it, and
//   the city group. Short, with the count
//   and the reach under the requirement and no install under way for `DAEDALUS_OUT_OF_REACH_AFTER_MS`, is the World
//   Daemon's "Daedalus out of reach" (./world-daemon.ts): a failure.
import {
  augmentationsSoldBy,
  CITY_FACTION_GROUPS,
  type DaedalusCount,
  FACTION_ENEMIES,
  FACTION_NAMES,
  FACTIONS,
  type FactionState,
  HACKER_FACTION_SERVERS,
  hackingValue,
  type Intent,
  intentId,
  isWorthInstalling,
  NEUROFLUX_GOVERNOR,
  TECH_VENDORS,
  THE_RED_PILL,
  TIAN_DI_HUI,
  TIAN_DI_HUI_CITIES,
  TIAN_DI_HUI_HACKING,
  TIAN_DI_HUI_MONEY,
  TRAVEL_COST,
} from "@bitburner-agent/core";

/** Where the brain goes for Tian Di Hui's invitation: a Tian Di Hui city with a tech vendor (Omega Software). */
export const TIAN_DI_HUI_TRAVEL_CITY = "Ishima";

/** The `travel` intent (#141's) to `city`. */
export function travelIntent(city: string): Intent {
  const args = { city };
  return { id: intentId("travel", args), action: "travel", args };
}

/**
 * Held in a city this long with the money and no invitation (the game checks every 2 s), it's the `notInvited` phase:
 * an event, a log line and a run report failure. 5 minutes: the faction state's reader sees an invitation within one.
 */
export const INVITATION_NOT_SHOWN_AFTER_MS = 5 * 60_000;

/** The rule's events (#228), for the run report. */
export const INVITATION_TRAVEL_EVENT_KIND = "invitationTravel";
export const CITY_GROUP_CHOSEN_EVENT_KIND = "cityGroupChosen";

export type InvitationEvent =
  | {
      type: typeof INVITATION_TRAVEL_EVENT_KIND;
      atMs: number;
      /** The travel asked for; the money held in the city; the invitations shown; none 5 minutes into the hold. */
      phase: "travel" | "hold" | "invited" | "notInvited";
      city: string;
      /** The invitations it's for (none: the travel to end in group B's Ishima, its tech vendor). */
      factions: string[];
      /** The money held, for a hold. */
      money: number;
      /** Daedalus's count then. */
      installed: number;
      required: number;
    }
  | ({ type: typeof CITY_GROUP_CHOSEN_EVENT_KIND; atMs: number } & CityGroupChoice);

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

const joinedOrInvited = (state: FactionState, faction: string) =>
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
  // Group B's Ishima is its tech vendor, so its stop comes last, with Tian Di Hui's; elsewhere Tian Di Hui's goes first.
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
function tianDiHuiVisit(inputs: InvitationInputs, wanted: readonly string[]): boolean {
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
    const travels = travelsFrom(city, visits);
    const needed = Math.max(0, ...visits.map((visit) => visit.money)) + travels * TRAVEL_COST;
    return { group, factions, augmentations, value, travels, money: needed, affordable: money >= needed };
  });
}

/** The group a city faction joined is in, or null: fixed for the cycle, the game having banned the rest. */
function joinedGroup(state: FactionState): string | null {
  const joined = state.joined.find((each) => FACTION_ENEMIES[each.name] !== undefined);
  return CITY_FACTION_GROUPS.find((group) => group.factions.includes(joined?.name ?? ""))?.name ?? null;
}

/**
 * The city group to join this cycle (#228): the one a city faction joined is in; else `kept`, the cycle's choice once
 * made (its travels under way, it isn't chosen again on the money or the value moving); else the most value of those
 * the money can earn, ties to the fewest travels, then the groups' order. None with value: none.
 */
export function chooseCityGroup(
  values: readonly CityGroupValue[],
  state: FactionState,
  kept: string | null = null,
): CityGroupValue | null {
  const fixed = joinedGroup(state);
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

/** The rule's plan: the travel (a city) or the hold, the group and the factions to join, and why nothing. */
export interface InvitationPlan {
  travel: string | null;
  hold: number;
  /** The city where the money is held, and the invitations it's held for. */
  holdFor: Visit | null;
  /** The visit travelled to. */
  next: Visit | null;
  group: CityGroupValue | null;
  values: CityGroupValue[];
  /** The city factions A5 may join: the group's that sell something of value. */
  cityFactions: string[];
  /** What Tian Di Hui sells that A6 would install. */
  tianDiHui: string[];
  waitingFor: string | null;
}

/**
 * The travel or the hold for the visits still to make (#228), with `kept` the cycle's city group so far and its factions
 * when chosen: they stay its to join, though a join can move what the others are worth (a faction joined that sells a
 * hacking value ends being short of Daedalus's count, and with it a no-value faction's worth).
 */
export function planInvitations(
  inputs: InvitationInputs,
  kept: { group: string; factions: readonly string[] } | null = null,
): InvitationPlan {
  const { state, count, currentNode, installed, money, city } = inputs;
  const wanted = tianDiHuiWanted(state, currentNode, installed, count.short);
  const values = cityGroupValues(inputs);
  const chosen = chooseCityGroup(values, state, kept?.group ?? null);
  const keptFactions = chosen !== null && chosen.group === kept?.group ? kept.factions : [];
  const factions = (CITY_FACTION_GROUPS.find((each) => each.name === chosen?.group)?.factions ?? []).filter(
    (faction) =>
      (keptFactions.includes(faction) || (chosen?.factions ?? []).includes(faction)) &&
      !state.joined.some((each) => each.name === faction),
  );
  const group = chosen === null ? null : { ...chosen, factions };
  const visits = visitsFor(group?.group ?? null, group?.factions ?? [], tianDiHuiVisit(inputs, wanted), city).map(
    (visit) => ({ ...visit, factions: visit.factions.filter((faction) => !joinedOrInvited(state, faction)) }),
  );
  const pending = visits.filter((visit) => visit.factions.length > 0);
  const base = {
    group,
    values,
    cityFactions: group?.factions ?? [],
    tianDiHui: wanted,
    hold: 0,
    holdFor: null,
    next: null,
    travel: null,
  };
  const here = pending.find((visit) => visit.city === city);
  if (here !== undefined) {
    // Held for those not yet invited here: the most one of them needs.
    const held = Math.max(
      ...here.factions.map((faction) => (faction === TIAN_DI_HUI ? TIAN_DI_HUI_MONEY : cityInvitation(faction).money)),
    );
    return { ...base, hold: held, holdFor: { ...here, money: held }, waitingFor: null };
  }
  const next = pending[0];
  if (next !== undefined) {
    const needed = next.money + TRAVEL_COST;
    if (money < needed) {
      return {
        ...base,
        waitingFor: `${formatMoney(needed)} to travel to ${next.city} for ${invitationsOf(next.factions)} (${formatMoney(money)} now)`,
      };
    }
    return { ...base, travel: next.city, next, waitingFor: null };
  }
  // Group B's visits done away from Ishima: on to its tech vendor.
  if (group?.group === "B" && TECH_VENDORS[city] === undefined && TIAN_DI_HUI_CITIES.includes(city)) {
    if (money < TRAVEL_COST) return { ...base, waitingFor: `the ticket to ${TIAN_DI_HUI_TRAVEL_CITY}` };
    return {
      ...base,
      travel: TIAN_DI_HUI_TRAVEL_CITY,
      next: { city: TIAN_DI_HUI_TRAVEL_CITY, factions: [], money: 0 },
      waitingFor: null,
    };
  }
  const reasons = [
    ...(wanted.length > 0 && inputs.hackingLevel < TIAN_DI_HUI_HACKING
      ? [`hacking ${TIAN_DI_HUI_HACKING} for Tian Di Hui's invitation (${Math.floor(inputs.hackingLevel)} now)`]
      : []),
    ...(group === null && values.some((each) => each.value > 0)
      ? [`the money for a city group's invitations (${values.map(describeGroupNeed).join("; ")})`]
      : []),
  ];
  const nothing =
    group === null && wanted.length === 0 && !values.some((each) => each.value > 0)
      ? "no invitation to travel for: Tian Di Hui sells nothing to install, and no city group has value"
      : "every invitation travelled for shown";
  return { ...base, waitingFor: reasons.length > 0 ? reasons.join("; ") : nothing };
}

const formatMoney = (money: number) => `$${Math.round(money).toLocaleString("en-US")}`;
const invitationsOf = (factions: readonly string[]) =>
  factions.length === 0 ? "its tech vendor" : `${factions.map((faction) => `${faction}'s`).join(" and ")} invitation`;
const describeGroupNeed = (each: CityGroupValue) =>
  `${each.group} needs ${formatMoney(each.money)}${each.value > 0 ? "" : ", no value"}`;

/** A group's value in words: "5 augmentations that count", or "hacking value 0.42". */
export function describeGroupValue(value: number, short: boolean): string {
  return short ? `${value} augmentation${value === 1 ? "" : "s"} that count` : `hacking value ${value.toFixed(2)}`;
}

/** The choice in words: "group B (Chongqing, Ishima): 5 augmentations that count, against A 4, C 3". */
export function describeCityGroupChoice({ group, factions, short, values }: CityGroupChoice): string {
  const others = values
    .filter((each) => each.group !== group)
    .map(
      (each) =>
        `${each.group} ${short ? each.value : each.value.toFixed(2)}${each.affordable ? "" : " (the money short)"}`,
    )
    .join(", ");
  const chosen = values.find((each) => each.group === group);
  if (group === null || chosen === undefined) return `no city group: none with value the money can earn (${others})`;
  return `group ${group} (${factions.join(", ")}): ${describeGroupValue(chosen.value, short)}, against ${others}`;
}

// --- The rule, as the controller runs it ------------------------------------------------------------------------------

/** What the controller hands the rule each update. */
export interface InvitationRuleInputs {
  /** The plan's inputs, or null where the snapshots don't say: nothing is asked or held. */
  inputs: InvitationInputs | null;
  /** Why the brain doesn't travel now (the owner's work, its own travel queued, the switch off), or null. */
  stood: string | null;
  /**
   * An install under way (A6's countdown or commit): it puts the player back in Sector-12 and drops every faction, so
   * no invitation is travelled for or held; but from a city with no tech vendor (Chongqing, New Tokyo), the player goes
   * to Ishima's, so A6 can still buy home's RAM before it (it stays).
   */
  beforeInstall?: boolean;
  nowMs: number | null;
}

/** What the dashboard shows of it (#228). */
export interface InvitationView {
  /** The city travelled to now, or null. */
  travel: string | null;
  hold: number;
  /** The city group chosen, in words, or null before the snapshots. */
  cityGroup: string | null;
  /** The city factions A5 may join. */
  cityFactions: string[];
  waitingFor: string | null;
}

/**
 * The rule (#228): the travel to send and the money to hold, the city group and the factions A5 may join; each change
 * of the group's choice and of each visit's phase logged and stored, and no invitation 5 minutes into a hold with the
 * money loud (logged, stored, a run report failure).
 */
export class InvitationRule {
  readonly #log: (line: string) => void;
  readonly #emit: (event: InvitationEvent) => void;
  /** The cycle's city group (its `lastAugReset`), once chosen. */
  #kept: { lastAugReset: number; group: string; factions: string[] } | null = null;
  /** The choice last stored, as a key. */
  #lastChoice: string | null = null;
  /** The phase under way: a travel to or a hold in a city, for its invitations. */
  #phase: { kind: "travel" | "hold"; city: string; factions: string[] } | null = null;
  #holdingSinceMs: number | null = null;
  #notShownStored = false;
  #view: InvitationView = { travel: null, hold: 0, cityGroup: null, cityFactions: [], waitingFor: null };

  constructor({
    log = () => {},
    emit = () => {},
  }: { log?: (line: string) => void; emit?: (event: InvitationEvent) => void }) {
    this.#log = log;
    this.#emit = emit;
  }

  view(): InvitationView {
    return this.#view;
  }

  /** The money held for an invitation: in its city until it shows, else 0. */
  hold(): number {
    return this.#view.hold;
  }

  /** The city factions A5 may join this cycle: the chosen group's that sell something of value. */
  cityFactions(): string[] {
    return this.#view.cityFactions;
  }

  update({ inputs, stood, beforeInstall = false, nowMs }: InvitationRuleInputs): Intent | null {
    if (inputs === null) {
      this.#view = { ...this.#view, travel: null, hold: 0, waitingFor: "the Agent's snapshots" };
      return null;
    }
    const atMs = nowMs ?? 0;
    const kept = this.#kept?.lastAugReset === inputs.lastAugReset ? this.#kept : null;
    const plan = planInvitations(inputs, kept);
    // Its factions to join: those chosen, and any of value since; each joined stays out of the list (A5 has it).
    this.#kept =
      plan.group === null
        ? null
        : {
            lastAugReset: inputs.lastAugReset,
            group: plan.group.group,
            factions: [
              ...new Set([...(kept?.group === plan.group.group ? kept.factions : []), ...plan.group.factions]),
            ],
          };
    const choice: CityGroupChoice = {
      group: plan.group?.group ?? null,
      factions: plan.group?.factions ?? [],
      short: inputs.count.short,
      values: plan.values.map(({ group, value, affordable }) => ({ group, value, affordable })),
    };
    // Stored once a cycle's choice changes, not as its factions join (they leave its list).
    const choiceKey = JSON.stringify([inputs.lastAugReset, choice.group]);
    if (choiceKey !== this.#lastChoice && (choice.group !== null || this.#lastChoice !== null)) {
      this.#lastChoice = choiceKey;
      this.#emit({ type: CITY_GROUP_CHOSEN_EVENT_KIND, atMs, ...choice });
      this.#log(`invitations: city factions: ${describeCityGroupChoice(choice)}`);
    }
    if (beforeInstall) {
      const toVendor = TECH_VENDORS[inputs.city] === undefined && inputs.money >= TRAVEL_COST;
      const travel = toVendor && stood === null ? TIAN_DI_HUI_TRAVEL_CITY : null;
      this.#view = {
        travel,
        hold: 0,
        cityGroup: describeCityGroupChoice(choice),
        cityFactions: plan.cityFactions,
        waitingFor: "the install under way (it puts the player back in Sector-12)",
      };
      const vendorTrip = {
        ...plan,
        hold: 0,
        holdFor: null,
        next: { city: TIAN_DI_HUI_TRAVEL_CITY, factions: [], money: 0 },
      };
      this.#phases(vendorTrip, travel, inputs, atMs);
      return travel === null ? null : travelIntent(travel);
    }
    const travel = stood === null ? plan.travel : null;
    this.#view = {
      travel,
      hold: plan.hold,
      cityGroup: describeCityGroupChoice(choice),
      cityFactions: plan.cityFactions,
      waitingFor: plan.travel !== null && stood !== null ? stood : plan.waitingFor,
    };
    this.#phases(plan, travel, inputs, atMs);
    return travel === null ? null : travelIntent(travel);
  }

  /** Each change of phase logged and stored, and a hold with no invitation in 5 minutes made loud. */
  #phases(plan: InvitationPlan, travel: string | null, inputs: InvitationInputs, atMs: number): void {
    const { count, state } = inputs;
    const emit = (phase: "travel" | "hold" | "invited" | "notInvited", city: string, factions: string[], money = 0) =>
      this.#emit({
        type: INVITATION_TRAVEL_EVENT_KIND,
        atMs,
        phase,
        city,
        factions,
        money,
        installed: count.installed,
        required: count.required,
      });
    const forCount = count.short ? ` (Daedalus's count: ${count.installed} of ${count.required} installed)` : "";
    const phase =
      travel !== null && plan.next !== null
        ? { kind: "travel" as const, city: travel, factions: plan.next.factions }
        : plan.holdFor !== null
          ? { kind: "hold" as const, city: plan.holdFor.city, factions: plan.holdFor.factions }
          : null;
    if (JSON.stringify(phase) !== JSON.stringify(this.#phase)) {
      const before = this.#phase;
      if (before !== null) {
        // Shown: a slow snapshot can show an invitation before a medium one shows the city.
        const shown = before.factions.filter((faction) => joinedOrInvited(state, faction));
        if (shown.length > 0) {
          this.#log(`invitations: ${shown.join(", ")} invited in ${before.city}`);
          emit("invited", before.city, shown);
        }
      }
      if (phase?.kind === "travel") {
        this.#log(`invitations: travelling to ${phase.city} for ${invitationsOf(phase.factions)}${forCount}`);
        emit("travel", phase.city, phase.factions);
      } else if (phase?.kind === "hold") {
        this.#log(
          `invitations: in ${phase.city}: ${formatMoney(plan.hold)} held for ${invitationsOf(phase.factions)}${forCount}`,
        );
        emit("hold", phase.city, phase.factions, plan.hold);
      }
      if (phase?.kind !== "hold" || before?.kind !== "hold" || before.city !== phase.city) {
        this.#holdingSinceMs = phase?.kind === "hold" ? atMs : null;
        this.#notShownStored = false;
      }
      this.#phase = phase;
    }
    // The clock runs only with the money the invitations need: short of it, the hold is still gathering it.
    if (phase?.kind === "hold" && inputs.money < plan.hold) this.#holdingSinceMs = atMs;
    if (
      phase?.kind === "hold" &&
      !this.#notShownStored &&
      this.#holdingSinceMs !== null &&
      atMs - this.#holdingSinceMs >= INVITATION_NOT_SHOWN_AFTER_MS
    ) {
      this.#notShownStored = true;
      this.#log(
        `invitations: NOT INVITED: ${Math.floor((atMs - this.#holdingSinceMs) / 60_000)} min in ${phase.city} with ` +
          `hacking ${Math.floor(inputs.hackingLevel)} and ${formatMoney(inputs.money)}, and no ` +
          invitationsOf(phase.factions),
      );
      emit("notInvited", phase.city, phase.factions, plan.hold);
    }
  }
}

// --- Daedalus's reach (#228) ------------------------------------------------------------------------------------------

/** How many more augmentations are within reach, and where (#228): the World Daemon's line and its failure. */
export interface DaedalusReach {
  more: number;
  /** Each faction's share, in the order they're counted; none of 0. */
  by: { faction: string; count: number }[];
}

/**
 * What the brain could still install toward Daedalus's count: each augmentation not installed (queued ones count: the
 * next install installs them) but The Red Pill, once, at the first of the factions it can buy from: those joined, in
 * the faction state's order; those inviting without enemies (A5 joins them); the hacker factions, whose invitations A3's
 * backdoors bring as the hacking level grows (./backdoors.ts: without them the early game, where only CyberSec is
 * joined, would seem out of reach); Tian Di Hui, while the hacking level allows its invitation (the travel's money comes
 * with time); then the city group: the one a city faction joined is in, else
 * the one selling the most of the rest (its money comes with time too). NeuroFlux Governor counts while none is
 * installed. Prerequisites aren't weighed: each one's is sold by a faction that sells it in BN1.
 */
export function daedalusReach(
  state: FactionState,
  currentNode: number,
  installed: Readonly<Record<string, number>>,
  hackingLevel: number,
): DaedalusReach {
  const counted = new Set<string>();
  const by: DaedalusReach["by"] = [];
  const newOf = (faction: string) =>
    augmentationsSoldBy(faction, currentNode, null).filter(
      (name) =>
        name !== THE_RED_PILL &&
        !Object.hasOwn(installed, name) &&
        !counted.has(name) &&
        !(name === NEUROFLUX_GOVERNOR && Object.hasOwn(installed, NEUROFLUX_GOVERNOR)),
    );
  const done: string[] = [];
  const add = (faction: string) => {
    if (!FACTION_NAMES.includes(faction) || done.includes(faction)) return;
    done.push(faction);
    const fresh = newOf(faction);
    for (const name of fresh) counted.add(name);
    if (fresh.length > 0) by.push({ faction, count: fresh.length });
  };
  for (const { name } of state.joined) add(name);
  for (const name of state.invitations) if (FACTION_ENEMIES[name] === undefined) add(name);
  for (const { faction } of HACKER_FACTION_SERVERS) add(faction);
  if (hackingLevel >= TIAN_DI_HUI_HACKING) add(TIAN_DI_HUI);
  const fixed = joinedGroup(state);
  const group =
    CITY_FACTION_GROUPS.find((each) => each.name === fixed) ??
    CITY_FACTION_GROUPS.reduce((best, each) => {
      const size = (members: readonly string[]) => new Set(members.flatMap(newOf)).size;
      return size(each.factions) > size(best.factions) ? each : best;
    });
  for (const faction of group.factions) add(faction);
  return { more: counted.size, by };
}

/** The reach in words: "10 more within reach (BitRunners 1, The Black Hand 1, Tian Di Hui 8)". */
export function describeReach(reach: DaedalusReach): string {
  if (reach.more === 0) return "none more within reach";
  return `${reach.more} more within reach (${reach.by.map(({ faction, count }) => `${faction} ${count}`).join(", ")})`;
}

// --- What the run report reads (#228) ---------------------------------------------------------------------------------

type Stored = { atMs: number; kind: string; detail: unknown };

/** The stored events' fields, as the run report reads them. */
const fieldsOf = (detail: unknown) =>
  (typeof detail === "object" && detail !== null ? detail : {}) as Record<string, unknown>;
const namesOf = (value: unknown) =>
  Array.isArray(value) ? value.filter((each): each is string => typeof each === "string") : [];

/** A stored event in words. */
function describeInvitationEvent(kind: string, detail: unknown): string {
  const fields = fieldsOf(detail);
  if (kind === CITY_GROUP_CHOSEN_EVENT_KIND) {
    const values = Array.isArray(fields.values) ? (fields.values as CityGroupChoice["values"]) : [];
    return `city factions: ${describeCityGroupChoice({
      group: typeof fields.group === "string" ? fields.group : null,
      factions: namesOf(fields.factions),
      short: fields.short === true,
      values,
    })}`;
  }
  const { phase, city, money, installed, required } = fields;
  const factions = namesOf(fields.factions);
  const count =
    typeof installed === "number" && typeof required === "number" ? ` (${installed} of ${required} installed)` : "";
  if (phase === "travel") return `travel to ${String(city)} for ${invitationsOf(factions)}${count}`;
  if (phase === "hold") {
    return `${formatMoney(typeof money === "number" ? money : 0)} held in ${String(city)} for ${invitationsOf(factions)}`;
  }
  if (phase === "invited") return `invited: ${factions.join(", ")}, in ${String(city)}`;
  if (phase === "notInvited") {
    return (
      `NOT INVITED ${INVITATION_NOT_SHOWN_AFTER_MS / 60_000} min into the hold in ${String(city)}: ` +
      `${factions.join(", ")}${count}`
    );
  }
  return `${String(phase)} (not a phase this brain stores)`;
}

/** The factions section's lines (#228): each cycle's city group, the travels, the holds and the invitations. */
export function invitationLines(events: readonly Stored[], formatTime: (ms: number) => string): string[] {
  const lines = ["    invitations travelled for (Tian Di Hui, and the city group the brain chose, decision 54):"];
  const own = events.filter((event) =>
    [INVITATION_TRAVEL_EVENT_KIND, CITY_GROUP_CHOSEN_EVENT_KIND].includes(event.kind),
  );
  for (const { atMs, kind, detail } of own) {
    lines.push(`      ${formatTime(atMs)}  ${describeInvitationEvent(kind, detail)}`);
  }
  if (own.length === 0) lines.push("      none");
  return lines;
}

/** Section 4's lines (#228): each hold with no invitation, a failure. */
export function invitationHealthLines(
  events: readonly Stored[],
  failures: string[],
  formatTime: (ms: number) => string,
): string[] {
  const lines = [
    `  invitations not shown (in the city with the money for ${INVITATION_NOT_SHOWN_AFTER_MS / 60_000} min, #228):`,
  ];
  const notShown = events.filter(
    (event) => event.kind === INVITATION_TRAVEL_EVENT_KIND && fieldsOf(event.detail).phase === "notInvited",
  );
  for (const { atMs, kind, detail } of notShown) {
    const line = `${describeInvitationEvent(kind, detail)}, at ${formatTime(atMs)}`;
    lines.push(`    ${line}`);
    failures.push(line);
  }
  if (notShown.length === 0) lines.push("    none");
  return lines;
}
