// The gang (#325, slice G1 of the gangs epic #324): in BN2, the brain forms a gang, recruits, and sets each member's
// task, by core's rule (`planGang`, ../../core/src/gang-rule.ts), from the gang worker's reading in the medium
// snapshot.
// - Only in BN2 for now: the campaign plays gangs there (BN2 ×3, docs/synthesis.md §3), where no karma is needed
//   (`PersonObjects/Player/PlayerObjectGangMethods.ts:16-18`). With SF2 elsewhere a gang needs −54,000 karma, which
//   the brain doesn't seek: not managed there, and the desired state carries no gang.
// - Forming: once a gang faction is joined (core's `gangFactionToForm`: NiteSec in practice, by A3's backdoor), the
//   `createGang` intent, irreversible, past the gate (its guard: the faction joined, ./irreversible-gate.ts; then a
//   save backup). Done once the reading shows the gang.
// - Managing: the desired state's `gang`, the recruits the respect allows and each member's task, done by the Agent's
//   worker every 10 s, which reads the gang after. A recruit is set to train at once.
// - The gang's faction is left out of what the faction and augmentation rules see as joined (`withoutGangFaction`):
//   the game offers no work or donations there (`Faction/ui/FactionRoot.tsx:97-99`, `:113`; Singularity's work and
//   donation, `NetscriptFunctions/Singularity.ts:808-810`, `:934-935`), and its shop is nearly every augmentation
//   (`Faction/FactionHelpers.tsx:172-202`), which core doesn't model yet (G5). In BN2, before the gang worker's first
//   reading (a brain just started), every gang faction is left out, so no work goes to one the gang may have.
// - No switch (#325): in BN2 the gang is the brain's to play; the owner can move members in the game, and the brain
//   sets them back within 10 s.
import {
  GANG_FACTIONS,
  GANG_STATS,
  type GangInformation,
  type GangMemberReading,
  type GangPlan,
  type GangState,
  gangFactionOf,
  gangFactionToForm,
  gangSoftcapOf,
  gangTrainingTask,
  type Intent,
  intentId,
  MAX_GANG_MEMBER_NAME_LENGTH,
  type MediumSnapshotData,
  planGang,
  type SlowSnapshotData,
} from "@bitburner-agent/core";

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
    ...GANG_STATS.flatMap((stat) => [stat, `${stat}_exp`, `${stat}_mult`, `${stat}_asc_mult`]),
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
  return {
    kind: "gang",
    gang: gang as unknown as GangInformation,
    members: members as GangMemberReading[],
    problems,
  };
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
 * donations there, and its shop isn't modelled until G5. `slowData` itself is left as it is; null, or none of them
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

/** Whether the protocol takes `name` as a member's (core's `parseGangState`): an owner's longer name is skipped. */
const isProtocolName = (name: string) => name !== "" && name.length <= MAX_GANG_MEMBER_NAME_LENGTH;

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
}

const formatCount = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
const percent = (share: number) => `${(share * 100).toFixed(share < 0.1 ? 1 : 0)}%`;

/** "2 training, 3 on Phishing, 1 on justice (Ethical Hacking)": the plan's task mix. */
export function describeTaskMix(plan: GangPlan): string {
  const counts = new Map<string, number>();
  for (const { role, task } of plan.assignments) {
    const label = role === "training" ? "training" : role === "justice" ? `on justice (${task})` : `on ${task}`;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, count]) => `${count} ${label}`).join(", ") || "no members";
}

export class GangRule {
  readonly #log: (line: string) => void;
  #view: GangView = { stage: "notManaged", line: "Gang: not managed (no slow snapshot yet)", plan: null };
  /** The faction of the gang the last reading showed, or null. */
  #faction: string | null = null;
  /** In BN2 with no reading yet that says whether there's a gang, or whose: every gang faction is held out. */
  #holding = false;
  /** The members the rule put on justice in its last plan (#325's re-review): only those are kept there, the hysteresis. */
  #placed: string[] = [];
  #lastLogged = "";

  constructor(log: (line: string) => void = () => {}) {
    this.#log = log;
  }

  /** Where the rule stands, for the dashboard. */
  view(): GangView {
    return this.#view;
  }

  /** The gang's faction, as the last reading showed it, or null: none formed, or none read. */
  gangFaction(): string | null {
    return this.#faction;
  }

  /**
   * The factions the other rules mustn't see as joined (`withoutGangFaction`): the gang's; in BN2 before a reading
   * says whether there's one, every gang faction; else none.
   */
  hiddenFactions(): readonly string[] {
    if (this.#faction !== null) return [this.#faction];
    return this.#holding ? GANG_FACTIONS : [];
  }

  /** The decision on the latest snapshots. Null for both outside BN2: no gang is managed. */
  update({
    mediumData,
    slowData,
  }: {
    mediumData: MediumSnapshotData | null;
    slowData: SlowSnapshotData | null;
  }): GangDecision {
    const bitNode = bitNodeOfSlow(slowData);
    if (bitNode !== GANG_BITNODE) {
      this.#faction = null;
      this.#holding = false;
      this.#placed = [];
      const why = bitNode === null ? "no slow snapshot yet" : `gangs play in BN2 only for now; this is BN${bitNode}`;
      return this.#decide({ stage: "notManaged", line: `Gang: not managed (${why})`, plan: null }, null, null);
    }
    // Managed from here on: the worker reads the gang even before one is formed.
    const read: GangState = { recruit: [], tasks: {} };
    const snapshot = gangSnapshotOf(mediumData);
    if (snapshot.kind === "absent" || snapshot.kind === "unread") {
      this.#holding = this.#faction === null;
      const why = snapshot.kind === "unread" ? `unread: ${snapshot.problem}` : "waiting for the gang worker's reading";
      return this.#decide({ stage: "waiting", line: `Gang: ${why}`, plan: null }, null, read);
    }
    this.#holding = false;
    if (snapshot.kind === "none") {
      this.#faction = null;
      this.#placed = [];
      const faction = gangFactionToForm(joinedFactionsOf(mediumData));
      if (faction === null) {
        const line = "Gang: none yet: no gang faction joined (NiteSec comes with avmnite-02h's backdoor)";
        return this.#decide({ stage: "noFaction", line, plan: null }, null, read);
      }
      const intent: Intent = { action: "createGang", args: { faction }, id: intentId("createGang", { faction }) };
      return this.#decide({ stage: "forming", line: `Gang: forming with ${faction}`, plan: null }, intent, read);
    }
    const { gang, members } = snapshot;
    this.#faction = gang.faction;
    const plan = planGang({
      gang: { respect: gang.respect, wantedLevel: gang.wantedLevel, territory: gang.territory },
      isHacking: gang.isHacking,
      members,
      softcap: gangSoftcapOf(GANG_BITNODE),
      placedOnJustice: this.#placed,
    });
    this.#placed = plan.assignments.filter((each) => each.role === "justice").map((each) => each.name);
    const tasks: Record<string, string> = {};
    // A member the owner named past what the protocol takes is left as it is: the Agent would refuse the whole state.
    for (const { name, task } of plan.assignments) if (isProtocolName(name)) tasks[name] = task;
    for (const name of plan.recruit) tasks[name] = gangTrainingTask(gang.isHacking);
    const line =
      `Gang: ${gang.faction}'s, ${formatCount(members.length, "member")} of 12 (${describeTaskMix(plan)}); ` +
      `respect ${Math.round(gang.respect).toLocaleString("en-US")}, wanted penalty ${percent(1 - gang.wantedPenalty)}` +
      ` (above its floor ${percent(plan.lostShare)}, bound ${percent(plan.bound)}); ` +
      `$${Math.round(gang.moneyGainRate * 5).toLocaleString("en-US")}/s`;
    return this.#decide({ stage: "managed", line, plan }, null, { recruit: plan.recruit, tasks });
  }

  #decide(view: GangView, intent: Intent | null, gang: GangState | null): GangDecision {
    this.#view = view;
    // Logged on a change of stage, recruits or task mix, not each figure.
    const logged =
      view.plan === null
        ? view.line
        : `${this.#faction}'s gang: ${formatCount(view.plan.assignments.length, "member")} ` +
          `(${describeTaskMix(view.plan)})` +
          (view.plan.recruit.length > 0 ? `; recruiting ${view.plan.recruit.join(", ")}` : "");
    // Not managed (outside BN2, every other BitNode's brain) is never logged: it's no news.
    if (logged !== this.#lastLogged && view.stage !== "notManaged") {
      this.#log(logged.startsWith("Gang: ") ? `gang: ${logged.slice(6)}` : `gang: ${logged}`);
    }
    this.#lastLogged = logged;
    return { intent, gang };
  }
}
