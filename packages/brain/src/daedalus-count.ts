// Reaching Daedalus's count of installed augmentations (#228): 30 in BN1 (`BitNodeMultipliers.DaedalusAugsRequirement`),
// NeuroFlux Governor counted once (`FactionJoinCondition.ts:130`; its levels are one entry's,
// `Augmentation/AugmentationHelpers.ts:55-58`). Short of it (core's `daedalusCountOf`), A6 installs any augmentation and
// A5 works for any (core's `isWorthInstalling`); this is the rest:
// - Tian Di Hui's invitation: it has no enemies and sells eight augmentations, but invites only a player in Chongqing,
//   New Tokyo or Ishima, with hacking 50 and $1m held at the game's check (`Faction/FactionInfo.tsx:680-692`), every
//   10 engine cycles, about 2 s (`engine.tsx:154`, `:177-183`). While it sells one A6 would install, neither installed
//   nor queued, it isn't joined or invited, the hacking level is 50, and the money covers $1m and the ticket
//   (`TRAVEL_COST`), the brain travels to Ishima (#141's intent): a Tian Di Hui city, and the only one with a tech
//   vendor (`TECH_VENDORS`), so home RAM and the TOR router are still bought there and nothing travels back. In a Tian
//   Di Hui city, until the invitation shows, $1m is held from cloud servers, home RAM and programs, as #215's $100b for
//   Daedalus is. An install puts the player back in Sector-12 (`PlayerObjectGeneralMethods.ts:104`) and drops every
//   faction: the rule runs again while Tian Di Hui still sells something wanted. Not with the owner's work set (a class
//   or a job is in a city) or the Augmentations switch off (nothing the brain installs needs it).
// - The reach: the installed count, and how many more the brain could still install: those sold by a joined faction,
//   one invited (A5 joins it, but for one with enemies, the owner's), or Tian Di Hui once the hacking level allows the
//   travel. Short, with the count plus the reach under the requirement and no install under way, for
//   `DAEDALUS_OUT_OF_REACH_AFTER_MS`, is the World Daemon's "Daedalus out of reach" (./world-daemon.ts): a failure.
import {
  augmentationsSoldBy,
  type DaedalusCount,
  FACTION_ENEMIES,
  FACTION_NAMES,
  type FactionState,
  type Intent,
  intentId,
  isWorthInstalling,
  NEUROFLUX_GOVERNOR,
  TIAN_DI_HUI,
  TIAN_DI_HUI_CITIES,
  TIAN_DI_HUI_HACKING,
  TIAN_DI_HUI_MONEY,
  THE_RED_PILL,
  TRAVEL_COST,
} from "@bitburner-agent/core";

/** Where the brain travels for Tian Di Hui's invitation: a Tian Di Hui city with a tech vendor (Omega Software). */
export const TIAN_DI_HUI_TRAVEL_CITY = "Ishima";

/** The `travel` intent to Ishima (#141's). */
export const TIAN_DI_HUI_TRAVEL_INTENT: Intent = {
  id: intentId("travel", { city: TIAN_DI_HUI_TRAVEL_CITY }),
  action: "travel",
  args: { city: TIAN_DI_HUI_TRAVEL_CITY },
};

/**
 * Held in a Tian Di Hui city this long with the money and no invitation (the game checks every 2 s), it's the
 * `notInvited` phase: an event, a log line and a run report failure. 5 minutes: the faction state's reader sees an
 * invitation within one.
 */
export const TIAN_DI_HUI_NOT_INVITED_AFTER_MS = 5 * 60_000;

/** The rule's events (#228), for the run report. */
export const TIAN_DI_HUI_EVENT_KIND = "tianDiHui";

export type TianDiHuiEvent = {
  type: typeof TIAN_DI_HUI_EVENT_KIND;
  atMs: number;
  /** The travel asked for; the $1m held in its city; the invitation shown (the hold over); none in 5 minutes. */
  phase: "travel" | "hold" | "invited" | "notInvited";
  /** What Tian Di Hui sells that A6 would install. */
  wanted: string[];
  /** Daedalus's count then (#228). */
  installed: number;
  required: number;
};

/** What the travel rule reads (#228): the faction state, the reset info's installs, the player. */
export interface TianDiHuiInputs {
  state: FactionState;
  count: DaedalusCount;
  currentNode: number;
  installed: Readonly<Record<string, number>>;
  hackingLevel: number;
  money: number;
  city: string;
}

/** The rule's choice: travel, hold (the money), or neither, and why not; and what's wanted there. */
export interface TianDiHuiPlan {
  travel: boolean;
  hold: number;
  wanted: string[];
  /** Why there's no travel or hold, or null. */
  waitingFor: string | null;
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

/** The travel for Tian Di Hui's invitation, or the hold in its city, or neither (#228). */
export function planTianDiHui({
  state,
  count,
  currentNode,
  installed,
  hackingLevel,
  money,
  city,
}: TianDiHuiInputs): TianDiHuiPlan {
  const wanted = tianDiHuiWanted(state, currentNode, installed, count.short);
  const none = (waitingFor: string): TianDiHuiPlan => ({ travel: false, hold: 0, wanted, waitingFor });
  if (wanted.length === 0) return none("nothing Tian Di Hui sells that A6 would install, not owned");
  if (state.joined.some((faction) => faction.name === TIAN_DI_HUI)) return none("Tian Di Hui joined");
  if (state.invitations.includes(TIAN_DI_HUI)) return none("Tian Di Hui's invitation, to join");
  if (hackingLevel < TIAN_DI_HUI_HACKING) {
    return none(`hacking ${TIAN_DI_HUI_HACKING} for Tian Di Hui's invitation (${Math.floor(hackingLevel)} now)`);
  }
  if (TIAN_DI_HUI_CITIES.includes(city)) return { travel: false, hold: TIAN_DI_HUI_MONEY, wanted, waitingFor: null };
  const needed = TIAN_DI_HUI_MONEY + TRAVEL_COST;
  if (money < needed) {
    return none(`${formatMoney(needed)} to travel to ${TIAN_DI_HUI_TRAVEL_CITY} for Tian Di Hui (${formatMoney(money)} now)`);
  }
  return { travel: true, hold: 0, wanted, waitingFor: null };
}

const formatMoney = (money: number) => `$${Math.round(money).toLocaleString("en-US")}`;

/** How many more augmentations are within reach, and where (#228): the World Daemon's line and its failure. */
export interface DaedalusReach {
  more: number;
  /** Each faction's share, in the order they're counted; none of 0. */
  by: { faction: string; count: number }[];
}

/**
 * What the brain could still install toward Daedalus's count: each augmentation not installed (queued ones count: the
 * next install installs them) but The Red Pill, once, at the first of the factions it can buy from: those joined, in
 * the faction state's order; those inviting without enemies (A5 joins them); then Tian Di Hui, while the hacking level
 * allows its invitation (the travel's money comes with time). NeuroFlux Governor counts while none is installed.
 * Prerequisites aren't weighed: each one's is sold by a faction that sells it in BN1.
 */
export function daedalusReach(
  state: FactionState,
  currentNode: number,
  installed: Readonly<Record<string, number>>,
  hackingLevel: number,
): DaedalusReach {
  const factions: string[] = [];
  const add = (faction: string) => {
    if (FACTION_NAMES.includes(faction) && !factions.includes(faction)) factions.push(faction);
  };
  for (const { name } of state.joined) add(name);
  for (const name of state.invitations) if (FACTION_ENEMIES[name] === undefined) add(name);
  if (hackingLevel >= TIAN_DI_HUI_HACKING) add(TIAN_DI_HUI);
  const counted = new Set<string>();
  const by: DaedalusReach["by"] = [];
  for (const faction of factions) {
    let count = 0;
    for (const name of augmentationsSoldBy(faction, currentNode, null)) {
      if (name === THE_RED_PILL || Object.hasOwn(installed, name) || counted.has(name)) continue;
      if (name === NEUROFLUX_GOVERNOR && Object.hasOwn(installed, NEUROFLUX_GOVERNOR)) continue;
      counted.add(name);
      count += 1;
    }
    if (count > 0) by.push({ faction, count });
  }
  return { more: counted.size, by };
}

/** The reach in words: "10 more within reach (BitRunners 1, The Black Hand 1, Tian Di Hui 8)". */
export function describeReach(reach: DaedalusReach): string {
  if (reach.more === 0) return "none more within reach";
  return `${reach.more} more within reach (${reach.by.map(({ faction, count }) => `${faction} ${count}`).join(", ")})`;
}

/** What the controller hands the rule each update. */
export interface TianDiHuiRuleInputs {
  /** The plan's inputs, or null where the snapshots don't say: nothing is asked or held. */
  inputs: TianDiHuiInputs | null;
  /** The owner's work set (it may be a class or a job in a city) or the Augmentations switch off: no travel. */
  stood: string | null;
  nowMs: number | null;
}

/** What the dashboard shows of it (#228). */
export interface TianDiHuiView {
  traveling: boolean;
  hold: number;
  wanted: string[];
  waitingFor: string | null;
}

/**
 * The travel rule as the controller runs it (#228): the intent to send and the money to hold, logging and storing each
 * change of phase: the travel asked for, the hold in a Tian Di Hui city, the invitation shown, and none within
 * `TIAN_DI_HUI_NOT_INVITED_AFTER_MS` of holding (loud: logged, stored, a run report failure).
 */
export class TianDiHuiRule {
  readonly #log: (line: string) => void;
  readonly #emit: (event: TianDiHuiEvent) => void;
  #phase: "travel" | "hold" | null = null;
  #holdingSinceMs: number | null = null;
  #notInvitedStored = false;
  #view: TianDiHuiView = { traveling: false, hold: 0, wanted: [], waitingFor: null };

  constructor({
    log = () => {},
    emit = () => {},
  }: { log?: (line: string) => void; emit?: (event: TianDiHuiEvent) => void }) {
    this.#log = log;
    this.#emit = emit;
  }

  view(): TianDiHuiView {
    return this.#view;
  }

  /** The money held for Tian Di Hui's invitation: $1m in its city until it invites, else 0. */
  hold(): number {
    return this.#view.hold;
  }

  update({ inputs, stood, nowMs }: TianDiHuiRuleInputs): Intent | null {
    if (inputs === null) {
      this.#view = { traveling: false, hold: 0, wanted: [], waitingFor: "the Agent's snapshots" };
      return null;
    }
    const plan = planTianDiHui(inputs);
    const travel = plan.travel && stood === null;
    this.#view = {
      traveling: travel,
      hold: plan.hold,
      wanted: plan.wanted,
      waitingFor: plan.travel && stood !== null ? stood : plan.waitingFor,
    };
    const atMs = nowMs ?? 0;
    const emit = (phase: TianDiHuiEvent["phase"]) =>
      this.#emit({
        type: TIAN_DI_HUI_EVENT_KIND,
        atMs,
        phase,
        wanted: plan.wanted,
        installed: inputs.count.installed,
        required: inputs.count.required,
      });
    const forCount = inputs.count.short
      ? ` (Daedalus's count: ${inputs.count.installed} of ${inputs.count.required} installed)`
      : "";
    const phase = travel ? "travel" : plan.hold > 0 ? "hold" : null;
    if (phase !== this.#phase) {
      if (phase === "travel") {
        this.#log(
          `tian di hui: travelling to ${TIAN_DI_HUI_TRAVEL_CITY} for its invitation: it sells ${plan.wanted.length} to ` +
            `install (${plan.wanted.join(", ")})${forCount}`,
        );
        emit("travel");
      } else if (phase === "hold") {
        this.#log(`tian di hui: in ${inputs.city}: ${formatMoney(plan.hold)} held for its invitation${forCount}`);
        emit("hold");
        this.#holdingSinceMs = atMs;
        this.#notInvitedStored = false;
      } else if (this.#phase !== null) {
        // Over: invited (a slow snapshot can show it before a medium one shows the city), or no longer wanted.
        const invited =
          inputs.state.invitations.includes(TIAN_DI_HUI) ||
          inputs.state.joined.some((faction) => faction.name === TIAN_DI_HUI);
        const what = this.#phase === "hold" ? "the hold" : "the travel";
        this.#log(`tian di hui: ${what} is over: ${invited ? "invited" : (plan.waitingFor ?? "no longer wanted")}`);
        if (invited) emit("invited");
      }
      if (phase !== "hold") this.#holdingSinceMs = null;
      this.#phase = phase;
    }
    // The clock runs only with the money the invitation needs: short of it, the hold is still gathering it.
    if (phase === "hold" && inputs.money < TIAN_DI_HUI_MONEY) this.#holdingSinceMs = atMs;
    if (
      phase === "hold" &&
      !this.#notInvitedStored &&
      this.#holdingSinceMs !== null &&
      atMs - this.#holdingSinceMs >= TIAN_DI_HUI_NOT_INVITED_AFTER_MS
    ) {
      this.#notInvitedStored = true;
      this.#log(
        `tian di hui: NOT INVITED: ${Math.floor((atMs - this.#holdingSinceMs) / 60_000)} min in ${inputs.city} with ` +
          `hacking ${Math.floor(inputs.hackingLevel)} and ${formatMoney(inputs.money)}, and no invitation`,
      );
      emit("notInvited");
    }
    return travel ? TIAN_DI_HUI_TRAVEL_INTENT : null;
  }
}

// --- What the run report reads (#228) ----------------------------------------------------------------------------------

/** The stored events' fields, as the run report reads them. */
const fieldsOf = (detail: unknown) =>
  (typeof detail === "object" && detail !== null ? detail : {}) as Record<string, unknown>;

/** A stored event in words: "travel to Ishima (23 of 30 installed; it sells 8 to install)". */
function describeTianDiHuiEvent(detail: unknown): string {
  const { phase, wanted, installed, required } = fieldsOf(detail);
  const count = typeof installed === "number" && typeof required === "number" ? `${installed} of ${required} installed; ` : "";
  const sells = Array.isArray(wanted) ? `it sells ${wanted.length} to install` : "what it sells not stored";
  if (phase === "travel") return `travel to ${TIAN_DI_HUI_TRAVEL_CITY} for its invitation (${count}${sells})`;
  if (phase === "hold") return `${formatMoney(TIAN_DI_HUI_MONEY)} held for its invitation`;
  if (phase === "invited") return "invited: the hold is over";
  if (phase === "notInvited") {
    return `NOT INVITED ${TIAN_DI_HUI_NOT_INVITED_AFTER_MS / 60_000} min into the hold (${count}${sells})`;
  }
  return `${String(phase)} (not a phase this brain stores)`;
}

/** The factions section's lines (#228): the travel, the hold and the invitation, in time order. */
export function tianDiHuiLines(events: readonly { atMs: number; kind: string; detail: unknown }[], formatTime: (ms: number) => string): string[] {
  const lines = ["    Tian Di Hui's invitation (the travel, and the $1m held for it):"];
  const own = events.filter((event) => event.kind === TIAN_DI_HUI_EVENT_KIND);
  for (const { atMs, detail } of own) lines.push(`      ${formatTime(atMs)}  ${describeTianDiHuiEvent(detail)}`);
  if (own.length === 0) lines.push("      none");
  return lines;
}

/** Section 4's lines (#228): each hold with no invitation, a failure. */
export function tianDiHuiHealthLines(
  events: readonly { atMs: number; kind: string; detail: unknown }[],
  failures: string[],
  formatTime: (ms: number) => string,
): string[] {
  const lines = [
    `  Tian Di Hui not inviting (in its city with the money for ${TIAN_DI_HUI_NOT_INVITED_AFTER_MS / 60_000} min):`,
  ];
  const notInvited = events.filter(
    (event) => event.kind === TIAN_DI_HUI_EVENT_KIND && fieldsOf(event.detail).phase === "notInvited",
  );
  for (const { atMs, detail } of notInvited) {
    const line = `Tian Di Hui ${describeTianDiHuiEvent(detail)}, at ${formatTime(atMs)}`;
    lines.push(`    ${line}`);
    failures.push(line);
  }
  if (notInvited.length === 0) lines.push("    none");
  return lines;
}
