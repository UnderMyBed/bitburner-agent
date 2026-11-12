// The gang (#325, slice G1 of the gangs epic #324; ascension #328, G2; equipment #330, G3): in BN2, the brain forms a
// gang, recruits, ascends members, buys their equipment and sets each member's task, by core's rule (`planGang`,
// ../../core/src/gang-rule.ts), from the gang worker's reading in the medium snapshot.
// - Only in BN2 for now: the campaign plays gangs there (BN2 ×3, docs/synthesis.md §3), where no karma is needed
//   (`PersonObjects/Player/PlayerObjectGangMethods.ts:16-18`). With SF2 elsewhere a gang needs −54,000 karma, which
//   the brain doesn't seek: not managed there, and the desired state carries no gang.
// - Forming: once a gang faction is joined (core's `gangFactionToForm`: NiteSec in practice, by A3's backdoor), the
//   `createGang` intent, irreversible, past the gate (its guard: the faction joined, ./irreversible-gate.ts; then a
//   save backup). Done once the reading shows the gang.
// - Managing: the desired state's `gang`, the recruits the respect allows, the member to ascend (G2, core's
//   `gangAscensionToMake`, with its points as read, so the worker ascends it once) and each member's task, done by the
//   Agent's worker every 10 s, which reads the gang after. A recruit is set to train at once.
// - Equipment (#330, G3): the purchases core's `planGangEquipment` makes within the money the desired state's
//   controller leaves free (`equip`, `gangMoneyHoldOf`), each with the member's points as read, and the hold as
//   `keepMoney`, so the worker spends none of it.
// - Territory warfare (#332, G4): the crew core's `planGang` puts on Territory Warfare, in the tasks, and its order to
//   engage or not (`warfare`, with the break-even the worker checks against the powers it reads); deaths counted as
//   members on Territory Warfare gone between readings (only they can die, `Gang.ts:291-303`), on the dashboard.
// - The gang's faction is left out of what the faction and augmentation rules see as joined (`withoutGangFaction`):
//   the game offers no work or donations there (`Faction/ui/FactionRoot.tsx:97-99`, `:113`; Singularity's work and
//   donation, `NetscriptFunctions/Singularity.ts:808-810`, `:934-935`). In BN2, before the gang worker's first
//   reading (a brain just started), every gang faction is left out, so no work goes to one the gang may have.
// - Its shop (#334, G5): nearly every augmentation, The Red Pill too in BN2 (`Faction/FactionHelpers.tsx:172-202`,
//   core's `augmentationsSoldBy`). A6 and A8, and the World Daemon's path, get it apart (`gangShopOf`): its reputation
//   as the slow snapshot reports it, which the gang's respect feeds (`Gang.ts:144-155`).
// - The objective at 12 members (#357, the planner's BN2 route, core's `gangObjectiveChoice`): respect or money, by the
//   time to The Red Pill's reputation at the gang's faction (`gangRouteFactionOf`: its reputation and favour, the
//   player's `faction_rep`), each objective's plan's respect a cycle its rate; money once The Red Pill is bought, queued
//   or installed. A `gangObjectiveChosen` event at each change, with both estimates; the dashboard's line says it. The
//   A/B's baseline (`bn2Route` "rules", tests alone) keeps the rule's money at 12.
// - Its silent stalls (#354, ./gang-stalls.ts): a worker problem in every reading, a member off the rule's task, or
//   the respect flat with members working, each for over a minute, watched on each new medium snapshot with the
//   rule's own plan: `stalls`, the dashboard's `gangStalled` alerts (the run report judges the same).
// - No switch (#325): in BN2 the gang is the brain's to play; the owner can move members in the game, and the brain
//   sets them back within 10 s.
import {
  augmentationBitNodeMultipliers,
  augmentationCost,
  type Bn2Route,
  factionReadingOf,
  GANG_ASCENSION_HORIZON_CAP_MS,
  GANG_EQUIPMENT_NAMES,
  GANG_FACTIONS,
  GANG_MOST_MEMBERS,
  GANG_STATS,
  GANG_TERRITORY_UPDATE_MS,
  type GangEquipmentPlan,
  type GangInformation,
  type GangMemberReading,
  type GangObjective,
  type GangObjectiveChoice,
  type GangObjectiveEstimate,
  type GangPlan,
  type GangRouteFaction,
  type GangRuleInputs,
  type GangStat,
  type GangState,
  type GangWarfareFigures,
  type GangWarfarePlan,
  gangAscensionPointsOf,
  gangEquipmentCostMultOf,
  gangFactionOf,
  gangFactionToForm,
  gangInBonusTime,
  gangObjectiveChoice,
  gangObjectiveOf,
  gangSoftcapOf,
  gangTrainingTask,
  type Intent,
  intentId,
  type JoinedFaction,
  type MediumSnapshotData,
  planGang,
  planGangEquipment,
  type SlowSnapshotData,
  TERRITORY_WARFARE_TASK,
  THE_RED_PILL,
} from "@bitburner-agent/core";
import { formatEta } from "./augmentations.ts";
import type { CloudServerPurchase } from "./cloud-servers.ts";
import { type GangStallStretch, GangStallWatch, isGangProtocolName } from "./gang-stalls.ts";
import type { TelemetryStore } from "./telemetry-store.ts";

/** The store's setting with the members the gang rule put on justice (#325's re-review), as a JSON list of names. */
export const GANG_PLACED_ON_JUSTICE_SETTING = "gang.placedOnJustice";

/** The rule's justice members from the store; none with no store or setting, or one that isn't a list of names. */
export function readPlacedOnJustice(store: TelemetryStore | null): string[] {
  const value = store?.getSetting(GANG_PLACED_ON_JUSTICE_SETTING) ?? null;
  if (value === null) return [];
  try {
    const names: unknown = JSON.parse(value);
    return Array.isArray(names) && names.every((name) => typeof name === "string") ? names : [];
  } catch {
    return [];
  }
}

/** The only BitNode the brain plays a gang in for now (#325). */
export const GANG_BITNODE = 2;

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/**
 * The medium snapshot's gang reading, checked, as the brain and the run report take it: absent (an older Agent, or no
 * gang managed), unread (the worker's problem), none formed, or the gang and its members. The Agent's word: a reading
 * whose figures aren't numbers is unread.
 */
export type GangSnapshot =
  | { kind: "absent" }
  | { kind: "unread"; problem: string }
  | { kind: "none"; problems: string[] }
  | { kind: "gang"; gang: GangInformation; members: GangMemberReading[]; problems: string[] };

/** The reading in `mediumData` (`MediumSnapshotData.gang`), checked. */
export function gangSnapshotOf(mediumData: unknown): GangSnapshot {
  const reading = isObject(mediumData) ? mediumData.gang : undefined;
  if (reading === undefined || reading === null) return { kind: "absent" };
  if (!isObject(reading)) return { kind: "unread", problem: "the gang reading isn't an object" };
  const problems = Array.isArray(reading.problems) ? reading.problems.filter((each) => typeof each === "string") : [];
  if (reading.gang === null) {
    return problems.length > 0 ? { kind: "unread", problem: problems.join("; ") } : { kind: "none", problems };
  }
  const gang = reading.gang;
  const numbers = ["respect", "wantedLevel", "wantedPenalty", "territory", "respectGainRate", "moneyGainRate"];
  if (!isObject(gang) || typeof gang.faction !== "string" || typeof gang.isHacking !== "boolean") {
    return { kind: "unread", problem: "the gang reading has no faction or kind" };
  }
  if (!numbers.every((key) => isNumber(gang[key])))
    return { kind: "unread", problem: "the gang's figures aren't numbers" };
  const memberNumbers = [
    "earnedRespect",
    "respectGain",
    "moneyGain",
    "wantedLevelGain",
    ...GANG_STATS.flatMap((stat) => [stat, `${stat}_exp`, `${stat}_mult`, `${stat}_asc_mult`, `${stat}_asc_points`]),
  ];
  const members = Array.isArray(reading.members) ? reading.members : [];
  const wellFormed = members.every(
    (member) =>
      isObject(member) &&
      typeof member.name === "string" &&
      typeof member.task === "string" &&
      memberNumbers.every((key) => isNumber(member[key])),
  );
  if (!wellFormed || !Array.isArray(reading.members)) {
    return { kind: "unread", problem: "a gang member's figures aren't numbers" };
  }
  // The equipment (G3): absent from an older Agent; else the game's, by name.
  const isEquipmentList = (list: unknown) =>
    list === undefined ||
    (Array.isArray(list) && list.every((name) => typeof name === "string" && GANG_EQUIPMENT_NAMES.includes(name)));
  const equipped = (member: unknown) =>
    isEquipmentList((member as Record<string, unknown>).upgrades) &&
    isEquipmentList((member as Record<string, unknown>).augmentations);
  if (!members.every(equipped)) {
    return { kind: "unread", problem: "a gang member's equipment isn't the game's" };
  }
  if (gang.equipmentCostMult !== undefined && !(isNumber(gang.equipmentCostMult) && gang.equipmentCostMult > 0)) {
    return { kind: "unread", problem: "the gang's equipment cost multiplier isn't a number" };
  }
  // Territory warfare (G4): absent from an older Agent; else the flag, the clash chance and the other gangs' figures.
  const isOther = (other: unknown) =>
    isObject(other) &&
    typeof other.faction === "string" &&
    ["power", "territory", "winChance"].every((key) => isNumber(other[key]));
  const warfareRead =
    gang.otherGangs === undefined ||
    (typeof gang.territoryWarfareEngaged === "boolean" &&
      isNumber(gang.territoryClashChance) &&
      isNumber(gang.power) &&
      Array.isArray(gang.otherGangs) &&
      gang.otherGangs.every(isOther));
  if (!warfareRead) return { kind: "unread", problem: "the gang's territory warfare figures aren't numbers" };
  return {
    kind: "gang",
    gang: gang as unknown as GangInformation,
    members: members as GangMemberReading[],
    problems,
  };
}

/**
 * Territory warfare's figures (G4) from a reading: its power, flag, clash chance and the other gangs; none from an older
 * Agent, which reads no other gangs.
 */
export function gangWarfareFiguresOf(gang: GangInformation): GangWarfareFigures | undefined {
  if (gang.otherGangs === undefined) return undefined;
  return {
    power: gang.power,
    engaged: gang.territoryWarfareEngaged === true,
    clashChance: gang.territoryClashChance ?? 0,
    others: gang.otherGangs.map(({ faction, power, territory }) => ({ faction, power, territory })),
  };
}

/**
 * The members gone since the reading before who were on Territory Warfare then (G4): the deaths, as only they can die
 * (`Gang.ts:291-303`) and nothing else takes a member from the gang but an owner's rename (`renameMember`), which would
 * count as one.
 */
export function gangDeathsBetween(
  before: readonly { name: string; task: string }[],
  now: readonly { name: string }[],
): string[] {
  const names = new Set(now.map((member) => member.name));
  return before
    .filter((member) => member.task === TERRITORY_WARFARE_TASK && !names.has(member.name))
    .map((member) => member.name);
}

/** The BitNode a slow snapshot shows, or null. */
export function bitNodeOfSlow(slowData: SlowSnapshotData | null | undefined): number | null {
  const currentNode = slowData?.resetInfo?.currentNode;
  return isNumber(currentNode) ? currentNode : null;
}

/** The factions a medium snapshot shows joined, or none. */
function joinedFactionsOf(mediumData: MediumSnapshotData | null): string[] {
  const factions = (mediumData?.player as { factions?: unknown } | undefined)?.factions;
  return Array.isArray(factions) ? factions.filter((each): each is string => typeof each === "string") : [];
}

/**
 * The slow snapshot with `hidden` (the gang's faction, `GangRule.hiddenFactions`) left out of the faction state's
 * joined factions (#325): what the faction, augmentation and World Daemon rules decide on. The game offers no work or
 * donations there; its shop is A6's apart (#334, `gangShopOf`). `slowData` itself is left as it is; null, or none of them
 * joined, it's returned as it is.
 */
export function withoutGangFaction(
  slowData: SlowSnapshotData | null,
  hidden: readonly string[],
): SlowSnapshotData | null {
  const state = slowData?.factions?.state;
  if (slowData === null || !Array.isArray(state?.joined)) return slowData;
  if (!state.joined.some((faction) => hidden.includes(faction?.name))) return slowData;
  const factions = slowData.factions as NonNullable<SlowSnapshotData["factions"]>;
  return {
    ...slowData,
    factions: { ...factions, state: { ...state, joined: state.joined.filter((each) => !hidden.includes(each.name)) } },
  };
}

/**
 * The gang's faction as A6, A8 and the World Daemon's path see it (#334, G5): `faction`'s entry in the faction state of
 * `slowData` as the Agent sent it (the gang's faction left in: not `withoutGangFaction`'s), its reputation the game's
 * own. Null with no gang (`faction` null), or the faction state not showing it.
 */
export function gangShopOf(
  slowData: SlowSnapshotData | null | undefined,
  faction: string | null,
): JoinedFaction | null {
  if (faction === null) return null;
  const joined = factionReadingOf(slowData)?.state?.joined ?? [];
  return joined.find((each) => each.name === faction) ?? null;
}

/** The gang's objective chosen at 12 members (#357, the planner's (2)): at each change, with both estimates. */
export const GANG_OBJECTIVE_CHOSEN_EVENT_KIND = "gangObjectiveChosen";

/** (2)'s estimate as the event and the dashboard carry it: its time null for never (JSON has no Infinity). */
export interface GangObjectiveEstimateView {
  respectPerCycle: number;
  reputationPerSecond: number;
  etaMs: number | null;
}

export type GangEvent = {
  type: typeof GANG_OBJECTIVE_CHOSEN_EVENT_KIND;
  atMs: number;
  objective: GangObjective;
  reason: GangObjectiveChoice["reason"];
  members: number;
  respect: GangObjectiveEstimateView | null;
  money: GangObjectiveEstimateView | null;
  /** The gang's faction's reputation and favour, `faction_rep`, and The Red Pill's reputation, as read. */
  reputation: number;
  favor: number;
  factionRep: number;
  needed: number;
};

/** An estimate as the event carries it. */
export function gangObjectiveEstimateView(estimate: GangObjectiveEstimate | null): GangObjectiveEstimateView | null {
  if (estimate === null) return null;
  const { respectPerCycle, reputationPerSecond, etaMs } = estimate;
  return { respectPerCycle, reputationPerSecond, etaMs: Number.isFinite(etaMs) ? etaMs : null };
}

/**
 * The gang's faction as (2) reads it (#357, core's `GangRouteFaction`): its reputation and favour in `slowData`'s faction
 * state (`gangShopOf`), the player's `faction_rep` in `mediumData`, The Red Pill's reputation (`augmentationCost`), and
 * whether it's owned: installed, queued, or `bought` (A6's purchase reported done, not shown queued yet). Null where
 * the snapshots don't say it all, or core doesn't know the BitNode.
 */
export function gangRouteFactionOf(
  slowData: SlowSnapshotData | null | undefined,
  faction: string,
  mediumData: unknown,
  bought = false,
): GangRouteFaction | null {
  const shop = gangShopOf(slowData, faction);
  const info = slowData?.resetInfo;
  const state = factionReadingOf(slowData)?.state ?? null;
  const factionRep = (mediumData as { player?: { mults?: { faction_rep?: unknown } } } | null)?.player?.mults
    ?.faction_rep;
  if (shop === null || info === undefined || state === null || !isNumber(factionRep)) return null;
  let needed: number;
  try {
    needed = augmentationCost(THE_RED_PILL, {
      installed: info.ownedAugs,
      queued: state.queuedAugmentations,
      sourceFile11Level: info.ownedSF["11"] ?? 0,
      bitNodeMultipliers: augmentationBitNodeMultipliers(info.currentNode, info.ownedSF),
    }).reputation;
  } catch {
    return null;
  }
  const redPillOwned =
    bought || Object.hasOwn(info.ownedAugs, THE_RED_PILL) || state.queuedAugmentations.includes(THE_RED_PILL);
  return { reputation: shop.reputation, favor: shop.favor, factionRep, needed, redPillOwned };
}

/** (2)'s choice in words: "respect, The Red Pill in 118.2 h (money's 790.4 h)", or why it's money. */
export function describeObjective(choice: GangObjectiveChoice): string {
  if (choice.reason === "The Red Pill owned") return "money, The Red Pill bought, queued or installed";
  if (choice.reason === "unread") return "money, the gang's faction unread (The Red Pill's reputation unknown)";
  const chosen = choice.objective === "respect" ? choice.respect : choice.money;
  const other = choice.objective === "respect" ? choice.money : choice.respect;
  const eta = (ms: number | undefined) => (ms === undefined || !Number.isFinite(ms) ? "never" : formatEta(ms));
  return (
    `${choice.objective}, The Red Pill in ${eta(chosen?.etaMs)} ` +
    `(${choice.objective === "respect" ? "money" : "respect"}'s ${eta(other?.etaMs)})`
  );
}

const isProtocolName = isGangProtocolName;

/**
 * The gang's faction carried forward within a BitNode (#325's re-review), for the reports: an Agent's first slow
 * snapshot after it starts comes before its gang worker's first reading, so its `gangFaction` is null though the gang
 * is there. A BitNode is its `currentNode` and `lastNodeReset`: a destroy starts another, with no gang.
 */
export class GangFactionCarry {
  #bitNode: string | null = null;
  #faction: string | null = null;

  /** `slow` with the gang's faction it, or an earlier one of its BitNode, showed. */
  of(slow: SlowSnapshotData): SlowSnapshotData {
    const info = slow?.resetInfo;
    const bitNode = `${String(info?.currentNode)}:${String(info?.lastNodeReset)}`;
    if (bitNode !== this.#bitNode) {
      this.#bitNode = bitNode;
      this.#faction = null;
    }
    const faction = gangFactionOf(slow);
    if (faction !== null) this.#faction = faction;
    return faction === null && this.#faction !== null ? { ...slow, gangFaction: this.#faction } : slow;
  }
}

/** What the rule wants now: the gang's forming intent, or null; and the desired state's gang, or null for none. */
export interface GangDecision {
  intent: Intent | null;
  gang: GangState | null;
}

/** The dashboard's line, and where the rule stands. */
export interface GangView {
  stage: "notManaged" | "waiting" | "noFaction" | "forming" | "managed";
  line: string;
  /** The rule's plan while it manages a gang, or null. */
  plan: GangPlan | null;
  /** The equipment rule's (G3) while it manages a gang, once the brain has said what money it may spend; or null. */
  equipment: GangEquipmentPlan | null;
}

/**
 * The money gang equipment leaves alone (G3, #330), as the brain holds it for its other spending, and what for:
 * Infinity spends none (an install chosen).
 */
export interface GangMoneyHold {
  amount: number;
  forWhat: string;
}

/**
 * The hold gang equipment leaves alone (G3): the most of `reserves` (the brain's holds, each of which keeps the same
 * money from what it holds it from, so the largest covers the rest), plus each of `purchases` on top (money already
 * spoken for: the purchase going out, the cloud server waiting). Infinity in any, Infinity: none spent.
 */
export function gangMoneyHoldOf(
  reserves: readonly GangMoneyHold[],
  purchases: readonly GangMoneyHold[],
): GangMoneyHold {
  const most = reserves.reduce<GangMoneyHold | null>(
    (top, each) => (each.amount > 0 && (top === null || each.amount > top.amount) ? each : top),
    null,
  );
  const holds = [...(most === null ? [] : [most]), ...purchases.filter((each) => each.amount > 0)];
  return {
    amount: holds.reduce((sum, each) => sum + each.amount, 0),
    forWhat: holds.map((each) => each.forWhat).join(" and ") || "nothing",
  };
}

/**
 * The money spoken for on top of the holds (G3, #330's review), `gangMoneyHoldOf`'s `purchases`: the purchase going out
 * this round at its plan's price (a program or the TOR router at the programs plan's, home RAM at its plan's, a cloud
 * server at the cloud plan's next), and the cloud server that pays back and waits for money (`awaitingMoney`) while
 * cloud servers would buy it: switched on, with the hack loop on (they only run it), no install chosen (they're lost
 * at it), and no problem holding them back (until the owner turns them off and on again, maybe for good). A price not
 * a finite number counts as none.
 */
export function gangPurchasesSpokenFor({
  purchase,
  prices,
  cloud,
}: {
  purchase: { intent: Intent; forWhat: string } | null;
  prices: { programs?: number | null; homeRam?: number | null; cloudServer?: number | null };
  cloud: {
    awaiting?: CloudServerPurchase | undefined;
    enabled: boolean;
    hackLoop: boolean;
    committed: boolean;
    problem: boolean;
  };
}): GangMoneyHold[] {
  const held: GangMoneyHold[] = [];
  if (purchase !== null) {
    const { action } = purchase.intent;
    const price =
      action === "buyTor" || action === "buyProgram"
        ? prices.programs
        : action === "upgradeHomeRam"
          ? prices.homeRam
          : action === "buyServer" || action === "upgradeServer"
            ? prices.cloudServer
            : 0;
    held.push({ amount: typeof price === "number" && Number.isFinite(price) ? price : 0, forWhat: purchase.forWhat });
  }
  const waiting = cloud.awaiting;
  if (waiting !== undefined && cloud.enabled && cloud.hackLoop && !cloud.committed && !cloud.problem) {
    held.push({ amount: waiting.price, forWhat: `${waiting.hostname} with ${waiting.ram} GB` });
  }
  return held;
}

const formatDollars = (money: number) => `$${Math.round(money).toLocaleString("en-US")}`;

/**
 * The plan's equipment (G3), for the dashboard: "buying NUKE Rootkit for member-02 ($4,762,000, $6,100,000 more
 * money by its next ascension)", and how many more; with none bought, the best that pays and the hold it waits above,
 * or that none pays back within 15 minutes (or within its horizon: an augmentation's day, a lost item's next
 * ascension).
 */
export function describeEquipment(equipment: GangEquipmentPlan, hold: GangMoneyHold): string {
  const [first, ...more] = equipment.buy;
  const by = (each: { kept: boolean }) => (each.kept ? "in a day" : "by its next ascension");
  if (first !== undefined) {
    return (
      `buying ${first.equipment} for ${first.name} (${formatDollars(first.cost)}, ${formatDollars(first.gain)} more ` +
      `money ${by(first)})${more.length > 0 ? ` and ${more.length} more` : ""}`
    );
  }
  const best = equipment.paying[0];
  if (best === undefined) return "no equipment pays back within 15 minutes";
  const waiting = !Number.isFinite(hold.amount)
    ? `${hold.forWhat}, which spends everything`
    : hold.amount > 0
      ? `money above the ${formatDollars(hold.amount)} held for ${hold.forWhat}`
      : "money";
  return `${best.equipment} for ${best.name} pays (${formatDollars(best.cost)}), waiting for ${waiting}`;
}

const formatCount = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
const percent = (share: number) => `${(share * 100).toFixed(share < 0.1 ? 1 : 0)}%`;

/** A territory update's time (`GANG_TERRITORY_UPDATE_MS`): 180 an hour. */
const UPDATES_AN_HOUR = 3_600_000 / GANG_TERRITORY_UPDATE_MS;

/**
 * Territory warfare (G4), for the dashboard: "territory 14.3%, power 2.1; warfare off: the clashes would lose
 * territory (win chance 4.0%–9.0%); none on Territory Warfare; 0 deaths seen". On, the territory expected an hour; off
 * with the clashes gaining, that their deaths would cost more; off with none expected (equal powers, or no other gang
 * with territory), that they'd gain none; with no figures (an older Agent), territory and power only.
 */
export function describeWarfare(warfare: GangWarfarePlan | null, gang: GangInformation, deaths: number): string {
  const share = `territory ${(gang.territory * 100).toFixed(1)}%, power ${gang.power.toFixed(1)}`;
  if (warfare === null) return `${share}; warfare not read (an older Agent)`;
  const { measure } = warfare;
  const chances =
    measure.winChances === null
      ? "no other gang has territory"
      : `win chance ${percent(measure.winChances.least)}–${percent(measure.winChances.most)}`;
  const hourly = `${percent(measure.territoryPerUpdate * UPDATES_AN_HOUR)} territory an hour`;
  const state = warfare.engage
    ? `warfare on: ${hourly} expected (${chances})`
    : measure.territoryPerUpdate > 0
      ? `warfare off: its deaths would cost more than the ${hourly} it'd gain is worth (${chances})`
      : measure.territoryPerUpdate === 0
        ? `warfare off: the clashes would gain no territory (${chances})`
        : `warfare off: the clashes would lose territory (${chances})`;
  const crew =
    warfare.crew.length === 0
      ? "none on Territory Warfare"
      : `${warfare.crew.length} on Territory Warfare (about ${warfare.deaths.toFixed(1)} deaths expected in a day engaged)`;
  return `${share}; ${state}; ${crew}; ${formatCount(deaths, "death")} seen`;
}

/** "2 training, 3 on Phishing, 1 on justice (Ethical Hacking)": the plan's task mix. */
export function describeTaskMix(plan: GangPlan): string {
  const counts = new Map<string, number>();
  for (const { role, task } of plan.assignments) {
    const label = role === "training" ? "training" : role === "justice" ? `on justice (${task})` : `on ${task}`;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, count]) => `${count} ${label}`).join(", ") || "no members";
}

/** The largest of an ascension's multiplier gains, "×1.45": what it gave the member's best stat. */
export function topAscensionGain(result: Record<GangStat, number>): number {
  return Math.max(...GANG_STATS.map((stat) => result[stat]));
}

/**
 * The plan's ascension (G2): "ascending member-02 (multipliers up to ×1.45, 60 respect lost)"; with none, the soonest
 * member's next, "next ascension: member-02's, in about 12 min" (training's horizon, `gangTimeToAscensionMs`).
 */
export function describeAscension(plan: GangPlan): string {
  if (plan.ascend !== null) {
    const { name, result } = plan.ascend;
    return (
      `ascending ${name} (multipliers up to ×${topAscensionGain(result).toFixed(2)}, ` +
      `${Math.round(result.respect).toLocaleString("en-US")} respect lost)`
    );
  }
  const next = plan.assignments.reduce<GangPlan["assignments"][number] | null>(
    (soonest, each) => (soonest === null || each.nextAscensionMs < soonest.nextAscensionMs ? each : soonest),
    null,
  );
  if (next === null || next.nextAscensionMs >= GANG_ASCENSION_HORIZON_CAP_MS) return "no ascension due within a day";
  if (next.nextAscensionMs === 0)
    return `${next.name}'s ascension pays, held (on justice, the wanted bound or a recruit's respect)`;
  return `next ascension: ${next.name}'s, in about ${Math.max(1, Math.round(next.nextAscensionMs / 60_000))} min`;
}

export class GangRule {
  readonly #log: (line: string) => void;
  #view: GangView = {
    stage: "notManaged",
    line: "Gang: not managed (no slow snapshot yet)",
    plan: null,
    equipment: null,
  };
  /** The faction of the gang the last reading showed, or null. */
  #faction: string | null = null;
  /** In BN2 with no reading yet that says whether there's a gang, or whose: every gang faction is held out. */
  #holding = false;
  /**
   * The members the rule put on justice in its last plan (#325's re-review): only those are kept there, the hysteresis.
   * Kept in the store (`GANG_PLACED_ON_JUSTICE_SETTING`) too, so a restarted brain keeps them where they are.
   */
  #placed: string[] = [];
  readonly #store: TelemetryStore | null;
  #lastLogged = "";
  /** The last decision's gang state, before its equipment (`equip`). */
  #state: GangState | null = null;
  /** What the managed decision read (G3): its medium snapshot, the rule's inputs and plan, and the equipment's cost. */
  #basis: { mediumData: unknown; inputs: GangRuleInputs; plan: GangPlan; costMult: number } | null = null;
  /** The equipment worked out for a medium snapshot (G3), the hold it was within, and the purchases sent. */
  #equipped: {
    mediumData: unknown;
    equipment: GangEquipmentPlan;
    hold: GangMoneyHold;
    buy: GangState["buy"];
    keepMoney: number | null;
  } | null = null;
  #lastBought = "";
  /** The members at the last reading (G4), with their tasks: one on Territory Warfare gone since died. */
  #lastMembers: { name: string; task: string }[] | null = null;
  /** The deaths seen since the brain started (G4). */
  #deaths = 0;
  readonly #emit: (event: GangEvent) => void;
  /** BN2's route (#357): the planner's objective at 12 members, or (the A/B's baseline) the rule's money. */
  readonly #route: Bn2Route;
  /** The objective at 12 as last chosen and sent (#357), or null under 12: an event at each change. */
  #objectiveSent: string | null = null;
  /** The silent stalls (#354), on each new medium snapshot, and the last one watched. */
  readonly #stalls = new GangStallWatch();
  #watched: unknown = null;
  /** The BitNode the last slow snapshot said, or null before any (#365's review). */
  #lastBitNode: number | null = null;

  /**
   * `store`: where the rule's justice members are kept across a restart; none (the tests), in memory only. `emit`: its
   * events (#357). `route`: the planner's objective at 12, unless a test asks for the rules' (the A/B's baseline).
   */
  constructor(
    log: (line: string) => void = () => {},
    store: TelemetryStore | null = null,
    { emit = () => {}, route = "planner" }: { emit?: (event: GangEvent) => void; route?: Bn2Route } = {},
  ) {
    this.#log = log;
    this.#store = store;
    this.#placed = readPlacedOnJustice(store);
    this.#emit = emit;
    this.#route = route;
  }

  /** Where the rule stands, for the dashboard. */
  view(): GangView {
    return this.#view;
  }

  /** The gang's faction, as the last reading showed it, or null: none formed, or none read. */
  gangFaction(): string | null {
    return this.#faction;
  }

  /** In BN2 with no reading yet that says whether there's a gang, or whose (#335's review). */
  gangUnread(): boolean {
    return this.#holding;
  }

  /**
   * The factions the other rules mustn't see as joined (`withoutGangFaction`): the gang's; in BN2 before a reading
   * says whether there's one, every gang faction; else none.
   */
  hiddenFactions(): readonly string[] {
    if (this.#faction !== null) return [this.#faction];
    return this.#holding ? GANG_FACTIONS : [];
  }

  /**
   * The silent stalls (#354) at or past their bound, by the medium snapshots watched: the `gangStalled` alerts. None
   * outside BN2, or with no gang.
   */
  stalls(): GangStallStretch[] {
    return this.#stalls.stalls();
  }

  /**
   * The decision on the latest snapshots, `mediumAtMs` when the medium one arrived (the stalls' times). Null for both
   * outside BN2: no gang is managed. `nowMs`: the controller's clock, for the events; `redPillBought`: The Red Pill
   * reported bought and not yet shown queued (A6's queue, #357).
   */
  update({
    mediumData,
    slowData,
    mediumAtMs = null,
    nowMs = null,
    redPillBought = false,
  }: {
    mediumData: MediumSnapshotData | null;
    slowData: SlowSnapshotData | null;
    mediumAtMs?: number | null;
    nowMs?: number | null;
    redPillBought?: boolean;
  }): GangDecision {
    // Each medium snapshot watched once (#354): the decision is made again on other snapshots with the same one.
    const fresh = mediumData !== this.#watched;
    this.#watched = mediumData;
    const bitNode = bitNodeOfSlow(slowData);
    if (bitNode === null) {
      // No slow snapshot (#365's review): a brain just started, or an Agent's session begun or ended (the controller
      // clears its snapshots at each). The BitNode unknown, not another: the justice members (the store's too), the
      // members read and the gang's faction kept, so a restart or a reconnect in BN2 keeps them. No gang state sent.
      this.#stalls.add(null);
      const view: GangView =
        this.#lastBitNode === GANG_BITNODE
          ? {
              stage: "waiting",
              line: "Gang: waiting for a slow snapshot to say the BitNode",
              plan: null,
              equipment: null,
            }
          : { stage: "notManaged", line: "Gang: not managed (no slow snapshot yet)", plan: null, equipment: null };
      return this.#decide(view, null, null);
    }
    this.#lastBitNode = bitNode;
    if (bitNode !== GANG_BITNODE) {
      this.#stalls.add(null);
      this.#faction = null;
      this.#holding = false;
      this.#setPlaced([]);
      // No gang here (G4): the next one's members are no deaths of this one's.
      this.#lastMembers = null;
      return this.#decide(
        {
          stage: "notManaged",
          line: `Gang: not managed (gangs play in BN2 only for now; this is BN${bitNode})`,
          plan: null,
          equipment: null,
        },
        null,
        null,
      );
    }
    // Managed from here on: the worker reads the gang even before one is formed.
    const read: GangState = { recruit: [], ascend: [], tasks: {}, buy: [], keepMoney: null, warfare: null };
    const snapshot = gangSnapshotOf(mediumData);
    if (snapshot.kind !== "gang") this.#stalls.add(null);
    if (snapshot.kind === "absent" || snapshot.kind === "unread") {
      this.#holding = this.#faction === null;
      const why = snapshot.kind === "unread" ? `unread: ${snapshot.problem}` : "waiting for the gang worker's reading";
      return this.#decide({ stage: "waiting", line: `Gang: ${why}`, plan: null, equipment: null }, null, read);
    }
    this.#holding = false;
    if (snapshot.kind === "none") {
      this.#faction = null;
      this.#setPlaced([]);
      this.#lastMembers = null;
      const faction = gangFactionToForm(joinedFactionsOf(mediumData));
      if (faction === null) {
        const line = "Gang: none yet: no gang faction joined (NiteSec comes with avmnite-02h's backdoor)";
        return this.#decide({ stage: "noFaction", line, plan: null, equipment: null }, null, read);
      }
      const intent: Intent = { action: "createGang", args: { faction }, id: intentId("createGang", { faction }) };
      return this.#decide(
        { stage: "forming", line: `Gang: forming with ${faction}`, plan: null, equipment: null },
        intent,
        read,
      );
    }
    const { gang, members } = snapshot;
    this.#faction = gang.faction;
    // Deaths (G4): members on Territory Warfare at the reading before, gone now.
    const died = this.#lastMembers === null ? [] : gangDeathsBetween(this.#lastMembers, members);
    this.#lastMembers = members.map(({ name, task }) => ({ name, task }));
    if (died.length > 0) {
      this.#deaths += died.length;
      this.#log(`gang: ${died.join(", ")} died in a clash, on Territory Warfare`);
    }
    const warfareFigures = gangWarfareFiguresOf(gang);
    const inputs: GangRuleInputs = {
      gang: { respect: gang.respect, wantedLevel: gang.wantedLevel, territory: gang.territory },
      isHacking: gang.isHacking,
      members,
      softcap: gangSoftcapOf(GANG_BITNODE),
      placedOnJustice: this.#placed,
      bonusTime: gangInBonusTime(gang.bonusTimeMs),
      ...(warfareFigures === undefined ? {} : { warfare: warfareFigures }),
    };
    // The objective (#357): at 12 members the planner's, by the time to The Red Pill's reputation at the gang's faction;
    // the rules' (the A/B's baseline) money.
    const routeFaction =
      this.#route === "planner" ? gangRouteFactionOf(slowData, gang.faction, mediumData, redPillBought) : null;
    const choice = this.#route === "planner" ? gangObjectiveChoice(inputs, routeFaction) : null;
    const plan = planGang(inputs, choice?.objective ?? gangObjectiveOf(members.length));
    this.#watchObjective(choice, routeFaction, nowMs);
    this.#basis = { mediumData, inputs, plan, costMult: gangEquipmentCostMultOf(gang) };
    this.#setPlaced(plan.assignments.filter((each) => each.role === "justice").map((each) => each.name));
    if (fresh && mediumAtMs !== null) {
      this.#stalls.add({ atMs: mediumAtMs, gang, members, problems: snapshot.problems, plan, softcap: inputs.softcap });
    }
    const tasks: Record<string, string> = {};
    // A member the owner named past what the protocol takes is left as it is: the Agent would refuse the whole state.
    for (const { name, task } of plan.assignments) if (isProtocolName(name)) tasks[name] = task;
    for (const name of plan.recruit) tasks[name] = gangTrainingTask(gang.isHacking);
    const ascending = members.find((member) => member.name === plan.ascend?.name && isProtocolName(member.name));
    const ascend =
      ascending === undefined ? [] : [{ name: ascending.name, pointsBefore: gangAscensionPointsOf(ascending) }];
    const line =
      `Gang: ${gang.faction}'s, ${formatCount(members.length, "member")} of 12 (${describeTaskMix(plan)}); ` +
      (choice !== null && members.length >= GANG_MOST_MEMBERS
        ? `objective at 12: ${describeObjective(choice)}; `
        : "") +
      `respect ${Math.round(gang.respect).toLocaleString("en-US")}, wanted penalty ${percent(1 - gang.wantedPenalty)}` +
      ` (above its floor ${percent(plan.lostShare)}, bound ${percent(plan.bound)}); ` +
      `$${Math.round(gang.moneyGainRate * 5).toLocaleString("en-US")}/s; ${describeAscension(plan)}; ` +
      describeWarfare(plan.warfare, gang, this.#deaths);
    // The order (G4): engaged with the break-even the worker checks the powers it reads against; none with none read.
    const warfare =
      plan.warfare === null
        ? null
        : {
            engage: plan.warfare.engage,
            leastTerritoryPerUpdate: plan.warfare.engage ? plan.warfare.measure.leastTerritoryPerUpdate : 0,
          };
    return this.#decide({ stage: "managed", line, plan, equipment: null }, null, {
      recruit: plan.recruit,
      ascend,
      tasks,
      buy: [],
      keepMoney: null,
      warfare,
    });
  }

  /**
   * The objective at 12 members (#357): a `gangObjectiveChosen` event and a log line at each change of objective or
   * reason, with both estimates; none while the gang's faction is unread (money meanwhile, as the rule's). Under 12,
   * forgotten, so the next 12 sends one again.
   */
  #watchObjective(choice: GangObjectiveChoice | null, read: GangRouteFaction | null, nowMs: number | null): void {
    if (choice === null || choice.reason === "recruiting") {
      this.#objectiveSent = null;
      return;
    }
    if (choice.reason === "unread" || read === null) return;
    const key = `${choice.objective} ${choice.reason}`;
    if (key === this.#objectiveSent) return;
    this.#objectiveSent = key;
    this.#emit({
      type: GANG_OBJECTIVE_CHOSEN_EVENT_KIND,
      atMs: nowMs ?? 0,
      objective: choice.objective,
      reason: choice.reason,
      members: GANG_MOST_MEMBERS,
      respect: gangObjectiveEstimateView(choice.respect),
      money: gangObjectiveEstimateView(choice.money),
      reputation: read.reputation,
      favor: read.favor,
      factionRep: read.factionRep,
      needed: read.needed,
    });
    this.#log(`gang: the objective at 12: ${describeObjective(choice)}`);
  }

  /** The rule's justice members, written to the store on a change. */
  #setPlaced(names: string[]): void {
    if (names.join("\n") === this.#placed.join("\n")) return;
    this.#placed = names;
    this.#store?.setSetting(GANG_PLACED_ON_JUSTICE_SETTING, JSON.stringify(names));
  }

  /**
   * The gang state with its equipment (G3, #330): the purchases `planGangEquipment` makes with the player's `money`
   * (the medium snapshot's) above `hold`, the brain's holds for its other spending, sent as `keepMoney` (null for
   * Infinity: none spent). Worked out once a gang reading (a medium snapshot), as the purchases are, so the state, and
   * the worker's runs, change only with it, not with each fast snapshot's holds; and again at once when an install is
   * chosen (#330's review), so none is spent from then on. The state `update` gave as it is, but while it manages the
   * gang.
   */
  equip({ money, hold }: { money: number | null; hold: GangMoneyHold }): GangState | null {
    const state = this.#state;
    const basis = this.#basis;
    if (state === null || basis === null || this.#view.stage !== "managed") return state;
    let equipped = this.#equipped;
    // Again at once when an install is chosen, or let go (the hold Infinity, or no longer): nothing is spent past it.
    const spends = Number.isFinite(hold.amount);
    if (equipped === null || equipped.mediumData !== basis.mediumData || (equipped.keepMoney !== null) !== spends) {
      const budget = typeof money === "number" && Number.isFinite(hold.amount) ? Math.max(0, money - hold.amount) : 0;
      const equipment = planGangEquipment(basis.inputs, basis.plan, { budget, costMult: basis.costMult });
      const byName = new Map(basis.inputs.members.map((member) => [member.name, member]));
      const buy = equipment.buy.flatMap(({ name, equipment: item }) => {
        const member = byName.get(name);
        return member === undefined || !isProtocolName(name)
          ? []
          : [{ name, equipment: item, pointsBefore: gangAscensionPointsOf(member) }];
      });
      const keepMoney = Number.isFinite(hold.amount) ? Math.max(0, hold.amount) : null;
      equipped = { mediumData: basis.mediumData, equipment, hold, buy, keepMoney };
      this.#equipped = equipped;
      const bought = buy.map((each) => `${each.equipment} for ${each.name}`).join(", ");
      if (bought !== this.#lastBought && bought !== "") this.#log(`gang: buying ${bought}`);
      this.#lastBought = bought;
    }
    const { equipment, hold: heldBy, buy, keepMoney } = equipped;
    const line = this.#view.line.replace(/; equipment: .*$/, "");
    this.#view = { ...this.#view, line: `${line}; equipment: ${describeEquipment(equipment, heldBy)}`, equipment };
    return { ...state, buy, keepMoney };
  }

  #decide(view: GangView, intent: Intent | null, gang: GangState | null): GangDecision {
    this.#view = view;
    this.#state = gang;
    if (view.stage !== "managed") {
      this.#basis = null;
      // No gang read: the next one's objective at 12 is sent afresh (#357).
      this.#objectiveSent = null;
    }
    // Logged on a change of stage, recruits or task mix, not each figure.
    const logged =
      view.plan === null
        ? view.line
        : `${this.#faction}'s gang: ${formatCount(view.plan.assignments.length, "member")} ` +
          `(${describeTaskMix(view.plan)})` +
          (view.plan.recruit.length > 0 ? `; recruiting ${view.plan.recruit.join(", ")}` : "") +
          (view.plan.ascend !== null ? `; ${describeAscension(view.plan)}` : "") +
          (view.plan.warfare?.engage === true ? "; territory warfare engaged" : "");
    // Not managed (outside BN2, every other BitNode's brain) is never logged: it's no news.
    if (logged !== this.#lastLogged && view.stage !== "notManaged") {
      this.#log(logged.startsWith("Gang: ") ? `gang: ${logged.slice(6)}` : `gang: ${logged}`);
    }
    this.#lastLogged = logged;
    return { intent, gang };
  }
}
