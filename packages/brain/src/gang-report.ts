// The run report's gang section (#325, G1 of #324): in BN2, when the gang formed, its members over time, the respect
// and money it earned, the wanted penalty against the rule's bound, and the task mix, from the medium snapshots' gang
// readings (the Agent's gang worker, every 10 s). What can stall fails the report, each after a time computed from
// the game or the brain's own pace:
// - no gang formed while a gang faction is joined, for over `GANG_FORM_WITHIN_MS`;
// - a recruit the respect allows (core's `gangRecruitsAllowed`) not made, for over `GANG_RECRUIT_WITHIN_MS`;
// - the wanted penalty's share above its floor over the rule's bound (core's `gangLostShare`, `gangLostShareBound`),
//   off course, for longer than `GANG_WANTED_OVER_BOUND_MS`, one justice member's time to halve the wanted level: the
//   rule's own test for more members on justice (core's `planGang`), a member off justice and the wanted level, with
//   the members' tasks now, not back at the bound within that time (`gangWantedRecovers`). With every member on
//   justice it's all the game allows, however long the decay takes;
// - the outcome, whatever that forecast: over the bound with a member off justice for `GANG_WANTED_OUTCOME_MS`;
// - the gang unread (no reading, or the worker's problem) in BN2 for over `GANG_UNREAD_WITHIN_MS`;
// - an ascension the rule makes (core's `gangAscensionToMake`, #328, G2) not made, for over `GANG_ASCEND_WITHIN_MS`;
// - equipment the rule buys (core's `planGangEquipment`, #330, G3), with the money above the reading's `keepMoney`
//   (the brain's holds, as the worker was given them), not bought, for over `GANG_EQUIP_WITHIN_MS`;
// - territory warfare (#332, G4) engaged while the rule's own measure (core's `gangWarfareMeasure`, with the members
//   on Territory Warfare as read) says the clashes lose, or off while it says they pay, for over
//   `GANG_WARFARE_WITHIN_MS`;
// - the silent stalls (#354, ./gang-stalls.ts): one of the worker's problems in every reading, a member off the rule's
//   task, or the respect flat while the rule has members working, each for over a minute, the worker's cadence. The
//   rule's plan for them is the brain's: its justice members kept as the brain keeps them (`placedOnJustice`, from
//   the plan at the reading before; at the window's first, those on justice), and bonus time.
// The gang's faction (#334, G5): its reputation and favour at the window's last slow snapshot, its reputation by hour
// (the route's bottleneck, #335's review), the augmentations A6 bought there in the window (its `augmentationBought`
// events), and The Red Pill's route there in BN2, with its estimate at the cycle's rate (core's `gangRedPillEtaMs`).
// Its stalls (reached there, not installed within 15 minutes; not rising while A6 holds for it) are the World
// Daemon's, section 3's path and failures.
// BN2's route (#357, slice 1): (2), the objective at 12 members, recomputed from the snapshots (core's
// `gangObjectiveChoice` with the gang's faction as the slow snapshot then shows it, `gangRouteFactionOf`), against the
// brain's `gangObjectiveChosen` events; the section's other checks read that objective. It fails on an objective at 12
// without its estimates; one that differs from core's for over `GANG_OBJECTIVE_DIFFERS_WITHIN_MS`; and none from the
// brain at 12 members for `GANG_OBJECTIVE_NEVER_MS` online, added up across the BitNode. And (1): an install chosen in
// BN2 before the gang, with avmnite-02h's level read (a static snapshot), without the planner's estimates for it. And
// (3), slice 2: each install chosen in BN2 with the gang formed, with its cost (its `gangCost`: the reputation lost,
// the favour gained, The Red Pill's estimate then); one before The Red Pill without the planner's (3) estimates fails.
// The ascensions themselves (G2) are seen as a member's ascension points rising between readings (core's
// `gangAscensionPointsOf`), each with its largest multiplier gain and the respect it had earned, by hour; the
// equipment bought (G3) as an item new in a member's lists, its cost the discounted one at the reading before; the
// deaths (G4) as a member on Territory Warfare at the reading before gone (`gangDeathsBetween`). Clashes won and lost
// aren't read: the game counts neither; the territory and power by hour show what they came to.
import {
  augmentationBitNodeMultipliers,
  augmentationCost,
  factionReadingOf,
  GANG_CYCLE_MS,
  GANG_EQUIPMENT,
  GANG_FACTIONS,
  GANG_MOST_MEMBERS,
  GANG_ROUTE_SERVER,
  GANG_STATS,
  GANG_WANTED_RECOVERY_MS,
  type GangAscensionAppraisal,
  type GangEquipmentAppraisal,
  type GangMemberReading,
  type GangObjective,
  type GangObjectiveChoice,
  type GangPlan,
  type GangRuleInputs,
  type GangWarfareMeasure,
  gangAscensionPointsOf,
  gangAscensionToMake,
  gangEquipment,
  gangEquipmentCost,
  gangEquipmentCostMultOf,
  gangFactionOf,
  gangInBonusTime,
  gangLostShare,
  gangLostShareBound,
  gangObjectiveChoice,
  gangObjectiveOf,
  gangRecruitsAllowed,
  gangRedPillEtaMs,
  gangSoftcapOf,
  gangTerritoryPerUpdate,
  gangWantedRecovers,
  gangWarfareBasis,
  gangWarfareMeasure,
  isGangJusticeTask,
  type MediumSnapshotData,
  planGang,
  planGangEquipment,
  type SlowSnapshotData,
  type StaticSnapshotData,
  TERRITORY_WARFARE_TASK,
  THE_RED_PILL,
} from "@bitburner-agent/core";
import {
  AUGMENTATION_BOUGHT_EVENT_KIND,
  AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND,
  AUGMENTATION_NOT_QUEUED_EVENT_KIND,
  describeGangInstallCost,
  formatEta,
  GANG_FORMED_ROUTE,
  GANG_FORMING_ROUTE,
  type GangInstallCost,
} from "./augmentations.ts";
import {
  bitNodeOfSlow,
  describeObjective,
  describeTaskMix,
  GANG_BITNODE,
  GANG_OBJECTIVE_CHOSEN_EVENT_KIND,
  gangBitNodeKeyOf,
  gangDeathsBetween,
  gangRouteFactionOf,
  gangShopOf,
  gangSnapshotOf,
  gangWarfareFiguresOf,
  topAscensionGain,
} from "./gang.ts";
import { GANG_STALL_KINDS, type GangStallStretch, GangStallWatch } from "./gang-stalls.ts";
import { formatDuration, formatIsoTime } from "./gap-report.ts";
import type { StoredEvent } from "./telemetry-store.ts";
import { HACKING_EXP_GAP_MS } from "./world-daemon.ts";

/**
 * How long a gang faction may be joined with no gang formed: 5 minutes. The gate holds the intent for 2 medium
 * snapshots (20 s) and a save backup, then the Agent tries it every 30 s (`INTENT_RETRY_ROUNDS`): 9 tries' time.
 */
export const GANG_FORM_WITHIN_MS = 5 * 60_000;
/**
 * How long a recruit the respect allows may wait: 1 minute. The brain names it on the next medium snapshot (10 s), the
 * Agent's worker recruits it within 10 s, and the next medium snapshot shows it: under 30 s, twice over.
 */
export const GANG_RECRUIT_WITHIN_MS = 60_000;
/**
 * How long the wanted penalty may stay over the rule's bound off course (core's `GANG_WANTED_RECOVERY_MS`): one member
 * on a justice task's time to halve the wanted level by the game's decay alone (`Gang.ts:161`), about 23 min.
 */
export const GANG_WANTED_OVER_BOUND_MS = GANG_WANTED_RECOVERY_MS;
/**
 * How long the wanted penalty may stay over the rule's bound with a member off justice, whatever the rule's forecast
 * (#325's review): the recovery time, half again for the forecast's error (the gains move as the members' levels do).
 * The outcome check: a forecast wrong in a way the rule can't see (bonus time's slower decay, say) shows here.
 */
export const GANG_WANTED_OUTCOME_MS = 1.5 * GANG_WANTED_RECOVERY_MS;
/** How long the gang may go unread in BN2: 5 minutes, 30 of the worker's runs. */
export const GANG_UNREAD_WITHIN_MS = 5 * 60_000;
/**
 * How long an ascension the rule makes may wait (G2): 1 minute, as a recruit (`GANG_RECRUIT_WITHIN_MS`): the brain
 * names it on the next medium snapshot, the Agent's worker runs at once on the changed state, and the next medium
 * snapshot shows it.
 */
export const GANG_ASCEND_WITHIN_MS = GANG_RECRUIT_WITHIN_MS;
/**
 * How long equipment the rule buys may wait (G3): 1 minute, as a recruit (`GANG_RECRUIT_WITHIN_MS`): the brain orders
 * it on the next medium snapshot, the Agent's worker runs at once on the changed state, and the next medium snapshot
 * shows it.
 */
export const GANG_EQUIP_WITHIN_MS = GANG_RECRUIT_WITHIN_MS;
/**
 * How long territory warfare may stay on while the rule's measure says the clashes lose, or off while it says they pay
 * (G4): 1 minute, as a recruit (`GANG_RECRUIT_WITHIN_MS`): the brain orders it on the next medium snapshot, the
 * Agent's worker runs at once on the changed state, and the next medium snapshot shows it.
 */
export const GANG_WARFARE_WITHIN_MS = GANG_RECRUIT_WITHIN_MS;

/**
 * How long the brain's objective at 12 members may differ from core's recomputed from the snapshots (#357): a minute,
 * as a recruit's (`GANG_RECRUIT_WITHIN_MS`): the brain chooses on each medium snapshot, the report on the slow snapshot
 * of the time, a minute apart at most.
 */
export const GANG_OBJECTIVE_DIFFERS_WITHIN_MS = GANG_RECRUIT_WITHIN_MS;
/**
 * How long the gang may be at 12 members with no objective from the brain (#357's (2)): 10 minutes online, added up
 * across the BitNode as #361's level-only time is (each interval between two readings that both show it, up to the
 * hacking experience's gap, `HACKING_EXP_GAP_MS`: the brain down longer counts none).
 */
export const GANG_OBJECTIVE_NEVER_MS = 10 * 60_000;

/** A reading at 12 members (#357): its BitNode, and core's choice from the snapshots then. */
interface AtTwelve {
  atMs: number;
  bitNode: string;
  choice: GangObjectiveChoice;
}

/** Whether an estimate as the event carries it is whole (#357): its rates numbers, its time a number or null (never). */
function estimateWhole(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const { respectPerCycle, reputationPerSecond, etaMs } = value as Record<string, unknown>;
  const finite = (each: unknown) => typeof each === "number" && Number.isFinite(each);
  return finite(respectPerCycle) && finite(reputationPerSecond) && (etaMs === null || finite(etaMs));
}

/** A death seen (G4): a member on Territory Warfare at the reading before, gone. */
interface Death {
  atMs: number;
  name: string;
}

/** An upgrade bought (G3): new in a member's lists between two readings, at its cost then. */
interface Purchase {
  atMs: number;
  name: string;
  equipment: string;
  cost: number;
}

/** An ascension seen (G2): a member's points risen between two readings. */
interface Ascension {
  atMs: number;
  name: string;
  /** Its largest multiplier gain, the ascension multiplier after over before. */
  gain: number;
  /** The respect it had earned at the reading before: what the gang lost, to within a reading's (10 s) earnings. */
  respect: number;
}

/** A reading of the gang at a medium snapshot. */
interface GangPoint {
  atMs: number;
  members: number;
  respect: number;
  /** $ a second, over the gang's last process. */
  moneyPerSecond: number;
  /** 1 − the game's penalty: the share of respect and money the wanted level takes. */
  penalty: number;
  lostShare: number;
  bound: number;
  /** Territory warfare (G4): the gang's share and power, and whether engaged (null: not read, an older Agent). */
  territory: number;
  power: number;
  engaged: boolean | null;
  /** What the rule read: the plan, for the task mix, is worked out only for an hour's last reading. */
  inputs: GangRuleInputs;
  /** The objective then (#357): core's choice at 12, the rule's under it. */
  objective: GangObjective;
}

/** The rule's plan at a reading (core's `planGang`), with the objective then (#357). */
const planAt = (point: GangPoint): GangPlan => planGang(point.inputs, point.objective);

/** A stretch a condition held, from its first medium snapshot to its last (or the window's end). */
interface Stretch {
  fromMs: number;
  toMs: number;
  detail: string;
}

/** A condition's stretches, and the one open now. */
class Stretches {
  readonly closed: Stretch[] = [];
  #open: Stretch | null = null;

  /** At a medium snapshot: the condition holds (with `detail`), or not (null). */
  add(atMs: number, detail: string | null): void {
    if (detail === null) {
      if (this.#open !== null) this.closed.push(this.#open);
      this.#open = null;
      return;
    }
    if (this.#open === null) this.#open = { fromMs: atMs, toMs: atMs, detail };
    else this.#open.toMs = atMs;
  }

  /** Every stretch, the open one to `endMs`. */
  all(endMs: number): Stretch[] {
    return this.#open === null ? this.closed : [...this.closed, { ...this.#open, toMs: endMs }];
  }
}

/** The gang over a window, folded from the slow and medium snapshots in order of arrival. */
export class GangFold {
  readonly #bitNodes: { atMs: number; bitNode: number }[] = [];
  readonly #points: GangPoint[] = [];
  readonly #problems = new Map<string, number>();
  #mediumInBitNode2 = 0;
  #formed: { atMs: number; faction: string } | null = null;
  /** The first reading of the window showed the gang already formed: none read "none formed" before it. */
  #formedBefore = false;
  #sawNone = false;
  #lastAtMs: number | null = null;
  readonly #notFormed = new Stretches();
  readonly #recruitWaiting = new Stretches();
  readonly #overBound = new Stretches();
  readonly #overBoundOffJustice = new Stretches();
  readonly #unread = new Stretches();
  readonly #ascensionWaiting = new Stretches();
  readonly #ascensions: Ascension[] = [];
  readonly #equipmentWaiting = new Stretches();
  readonly #purchases: Purchase[] = [];
  readonly #warfareLosing = new Stretches();
  readonly #warfarePaying = new Stretches();
  readonly #deaths: Death[] = [];
  /**
   * The silent stalls (#354): their stretches closed, and the watch with those open. An open one ends at the last
   * reading showing it, not at the window's end as the section's others do (#364's review): it's judged between
   * readings, and there's none after the last.
   */
  readonly #stallStretches: GangStallStretch[] = [];
  readonly #stalls = new GangStallWatch((stretch) => this.#stallStretches.push(stretch));
  /** The rule's justice members in its plan at the reading before, as the brain keeps them; null: none read yet. */
  #placed: string[] | null = null;
  /** The cost multiplier at the reading before: what a purchase since cost. */
  #lastCostMult: number | null = null;
  /** Each member at the reading before, by name: its ascension points rising says it ascended. */
  #lastMembers = new Map<string, GangMemberReading>();
  /** The window's last slow snapshot in BN2 (#334), the gang's faction carried: its reputation, The Red Pill's route. */
  #lastSlow: SlowSnapshotData | null = null;
  /** That snapshot's game time, for the cycle's rate (#335's review). */
  #lastSlowGameTimeMs: number | null = null;
  /** The gang's faction's reputation at each BN2 slow snapshot showing it (#335's review), for the hours. */
  readonly #reputations: { atMs: number; reputation: number }[] = [];
  /** When a static snapshot first showed avmnite-02h's level (#357's (1)), or null: its estimates are due from then. */
  #routeLevelReadAtMs: number | null = null;
  /** The BN2 slow snapshots in order (#357): the one of a medium reading's time, for (2)'s choice then. */
  readonly #slows: { atMs: number; data: SlowSnapshotData }[] = [];
  /** Each BN2 gang reading (#357): whether a gang was formed then, for an install before it. */
  readonly #formedAt: { atMs: number; formed: boolean }[] = [];
  /** The readings at 12 members (#357), with core's choice. */
  readonly #atTwelve: AtTwelve[] = [];
  /** Core's last choice (#357), and the slow snapshot and members it's from: worked out again as either changes. */
  #lastChoice: { slow: SlowSnapshotData | null; members: number; choice: GangObjectiveChoice } | null = null;

  /** A static snapshot (#357): avmnite-02h's level read, (1)'s estimates due from then. */
  addStatic(atMs: number, data: StaticSnapshotData): void {
    if (this.#routeLevelReadAtMs !== null) return;
    const servers = Array.isArray(data?.servers) ? data.servers : [];
    const level = servers.find((each) => each?.hostname === GANG_ROUTE_SERVER)?.requiredHackingSkill;
    if (typeof level === "number" && Number.isFinite(level)) this.#routeLevelReadAtMs = atMs;
  }

  /** The BN2 slow snapshot last taken by `atMs` (#357), or null. */
  #slowAt(atMs: number): SlowSnapshotData | null {
    let found: SlowSnapshotData | null = null;
    for (const each of this.#slows) {
      if (each.atMs > atMs) break;
      found = each.data;
    }
    return found;
  }

  /**
   * A slow snapshot, taken at the game's `gameTimeMs`: the BitNode from then on; in BN2, the last, for the gang's
   * faction (#334), and its reputation then (#335's review).
   */
  addSlow(atMs: number, data: SlowSnapshotData, gameTimeMs: number | null = null): void {
    const bitNode = bitNodeOfSlow(data);
    if (bitNode !== null) this.#bitNodes.push({ atMs, bitNode });
    if (bitNode !== GANG_BITNODE) return;
    this.#slows.push({ atMs, data });
    this.#lastSlow = data;
    this.#lastSlowGameTimeMs = gameTimeMs;
    const shop = gangShopOf(data, gangFactionOf(data));
    if (shop !== null) this.#reputations.push({ atMs, reputation: shop.reputation });
  }

  /** The BitNode at `atMs`: the last slow snapshot's by then, or the first one's after, with none before. */
  #bitNodeAt(atMs: number): number | null {
    let found: number | null = this.#bitNodes[0]?.bitNode ?? null;
    for (const { atMs: slowAtMs, bitNode } of this.#bitNodes) {
      if (slowAtMs > atMs) break;
      found = bitNode;
    }
    return found;
  }

  /** A medium snapshot (a whole one: a thinned one says nothing of the gang). */
  addMedium(atMs: number, data: MediumSnapshotData): void {
    if (this.#bitNodeAt(atMs) !== GANG_BITNODE) {
      for (const stretches of [
        this.#notFormed,
        this.#recruitWaiting,
        this.#overBound,
        this.#overBoundOffJustice,
        this.#unread,
        this.#ascensionWaiting,
        this.#equipmentWaiting,
        this.#warfareLosing,
        this.#warfarePaying,
      ]) {
        stretches.add(atMs, null);
      }
      this.#stalls.add(null);
      this.#placed = null;
      this.#lastMembers = new Map();
      return;
    }
    this.#mediumInBitNode2 += 1;
    this.#lastAtMs = atMs;
    const snapshot = gangSnapshotOf(data);
    const factions = (data.player as { factions?: unknown } | undefined)?.factions;
    const joined = Array.isArray(factions) ? GANG_FACTIONS.filter((faction) => factions.includes(faction)) : [];
    this.#unread.add(
      atMs,
      snapshot.kind === "absent"
        ? "no gang reading in the medium snapshot"
        : snapshot.kind === "unread"
          ? snapshot.problem
          : null,
    );
    this.#notFormed.add(atMs, snapshot.kind === "none" && joined.length > 0 ? `${joined.join(", ")} joined` : null);
    if (snapshot.kind === "none") this.#sawNone = true;
    if (snapshot.kind === "none" || snapshot.kind === "gang") {
      this.#formedAt.push({ atMs, formed: snapshot.kind === "gang" });
    }
    if (snapshot.kind !== "gang") {
      this.#recruitWaiting.add(atMs, null);
      this.#overBound.add(atMs, null);
      this.#overBoundOffJustice.add(atMs, null);
      this.#ascensionWaiting.add(atMs, null);
      this.#equipmentWaiting.add(atMs, null);
      this.#warfareLosing.add(atMs, null);
      this.#warfarePaying.add(atMs, null);
      this.#stalls.add(null);
      // The brain keeps its justice members while the gang is unread; none with none formed (../gang.ts).
      if (snapshot.kind === "none") this.#placed = null;
      // A gang gone (another BitNode's start) has none of these members; one unread keeps them.
      if (snapshot.kind === "none") this.#lastMembers = new Map();
      return;
    }
    const { gang, members, problems } = snapshot;
    for (const problem of problems) if (!this.#problems.has(problem)) this.#problems.set(problem, atMs);
    if (this.#formed === null) {
      this.#formed = { atMs, faction: gang.faction };
      this.#formedBefore = !this.#sawNone;
    }
    const allowed = gangRecruitsAllowed(gang.respect, members.length);
    this.#recruitWaiting.add(
      atMs,
      allowed > 0 ? `${allowed} allowed at ${members.length} members, respect ${Math.round(gang.respect)}` : null,
    );
    const lostShare = gangLostShare(gang);
    const bound = gangLostShareBound(members.length);
    // The rule's condition for more members on justice: over the bound, not on course back to it within the recovery
    // time with the members' tasks now (core's `gangWantedRecovers`), and a member off justice.
    const tasks = members.map((member) => member.task);
    const offJustice = tasks.filter((task) => !isGangJusticeTask(task)).length;
    this.#overBound.add(
      atMs,
      lostShare > bound &&
        offJustice > 0 &&
        !gangWantedRecovers(gang, members, tasks, gangInBonusTime(gang.bonusTimeMs))
        ? `${percent(lostShare)} over ${percent(bound)}, wanted ${Math.round(gang.wantedLevel)}, ` +
            `${members.length - offJustice} of ${members.length} on justice, off course`
        : null,
    );
    // The outcome, whatever the forecast: over the bound with a member off justice.
    this.#overBoundOffJustice.add(
      atMs,
      lostShare > bound && offJustice > 0
        ? `${percent(lostShare)} over ${percent(bound)}, wanted ${Math.round(gang.wantedLevel)}, ` +
            `${members.length - offJustice} of ${members.length} on justice`
        : null,
    );
    const warfare = gangWarfareFiguresOf(gang);
    const inputs: GangRuleInputs = {
      gang: { respect: gang.respect, wantedLevel: gang.wantedLevel, territory: gang.territory },
      isHacking: gang.isHacking,
      members,
      softcap: gangSoftcapOf(GANG_BITNODE),
      ...(warfare === undefined ? {} : { warfare }),
    };
    // The objective (#357): at 12 core's choice from the slow snapshot of the time (worked out again as it or the
    // members change: the brain's, every 10 s, follows it within a minute), else the rule's.
    const objective = this.#objectiveAt(atMs, inputs, gang.faction, data);
    // The silent stalls (#354), on the rule's plan as the brain has it: its justice members and bonus time too, and
    // (#357) the objective.
    const plan = planGang(
      {
        ...inputs,
        placedOnJustice:
          this.#placed ?? members.filter((member) => isGangJusticeTask(member.task)).map((each) => each.name),
        bonusTime: gangInBonusTime(gang.bonusTimeMs),
      },
      objective,
    );
    this.#placed = plan.assignments.filter((each) => each.role === "justice").map((each) => each.name);
    this.#stalls.add({ atMs, gang, members, problems, plan, softcap: inputs.softcap });
    // Territory warfare (G4): the rule's measure with the crew as read, against the flag. The measure's worth only
    // when the clashes gain territory at all: else they lose, whatever it's worth.
    if (warfare === undefined) {
      this.#warfareLosing.add(atMs, null);
      this.#warfarePaying.add(atMs, null);
    } else {
      const crew = members.filter((member) => member.task === TERRITORY_WARFARE_TASK).map((member) => member.name);
      const expected = gangTerritoryPerUpdate(warfare.power, gang.territory, warfare.others);
      const measure = expected > 0 ? gangWarfareMeasure(inputs, gangWarfareBasis(inputs, objective), crew) : null;
      const detail = describeMeasure(measure, expected, crew.length);
      this.#warfareLosing.add(atMs, warfare.engaged && measure?.pays !== true ? detail : null);
      this.#warfarePaying.add(atMs, !warfare.engaged && measure?.pays === true ? detail : null);
    }
    for (const name of gangDeathsBetween([...this.#lastMembers.values()], members)) this.#deaths.push({ atMs, name });
    // The ascensions since the reading before, and the rule's own (core's `gangAscensionToMake`, as the brain's plan
    // has it) not made.
    let ascended = false;
    // The equipment bought since (G3): new in the member's lists, its upgrades against none if it ascended since.
    const costMult = gangEquipmentCostMultOf(gang);
    const boughtBefore = this.#purchases.length;
    for (const member of members) {
      const before = this.#lastMembers.get(member.name);
      // Only against a reading with the lists: an Agent upgraded in the window would show every item as bought.
      if (before === undefined || before.upgrades === undefined || before.augmentations === undefined) continue;
      const rose = gangAscensionPointsOf(member) > gangAscensionPointsOf(before);
      const had = new Set([...(rose ? [] : (before.upgrades ?? [])), ...(before.augmentations ?? [])]);
      for (const item of [...(member.upgrades ?? []), ...(member.augmentations ?? [])]) {
        if (had.has(item)) continue;
        const cost = gangEquipmentCost(gangEquipment(item), this.#lastCostMult ?? costMult);
        this.#purchases.push({ atMs, name: member.name, equipment: item, cost });
      }
    }
    this.#lastCostMult = costMult;
    for (const member of members) {
      const before = this.#lastMembers.get(member.name);
      if (before === undefined || gangAscensionPointsOf(member) <= gangAscensionPointsOf(before)) continue;
      ascended = true;
      const gains = Object.fromEntries(
        GANG_STATS.map((stat) => [stat, member[`${stat}_asc_mult`] / before[`${stat}_asc_mult`]]),
      ) as Record<(typeof GANG_STATS)[number], number>;
      this.#ascensions.push({ atMs, name: member.name, gain: topAscensionGain(gains), respect: before.earnedRespect });
    }
    this.#lastMembers = new Map(members.map((member) => [member.name, member]));
    const due = ascended ? null : gangAscensionToMake(inputs, objective);
    this.#ascensionWaiting.add(
      atMs,
      due === null
        ? null
        : `${due.name}'s, multipliers up to ×${topAscensionGain(due.result).toFixed(2)}, a gain of ` +
            `${whole(due.gain)} over a cost of ${whole(due.cost)} in ${formatDuration(due.horizonMs)}`,
    );
    // The rule's equipment (core's `planGangEquipment`) with the money above the reading's `keepMoney`, none bought
    // since the reading before.
    const money = (data.player as { money?: unknown } | undefined)?.money;
    const keepMoney = (data.gang as { keepMoney?: unknown } | null | undefined)?.keepMoney;
    const free = typeof money === "number" && typeof keepMoney === "number" ? money - keepMoney : 0;
    const top =
      this.#purchases.length > boughtBefore || ascended
        ? null
        : gangEquipmentDue(inputs, due, free, costMult, objective);
    this.#equipmentWaiting.add(
      atMs,
      top === null
        ? null
        : `${top.equipment} for ${top.name}, $${whole(top.cost)} for $${whole(top.gain)} more money in ` +
            `${formatDuration(top.horizonMs)}, $${whole(free)} above the $${whole(keepMoney as number)} held`,
    );
    this.#points.push({
      atMs,
      members: members.length,
      respect: gang.respect,
      moneyPerSecond: (gang.moneyGainRate * 1000) / GANG_CYCLE_MS,
      penalty: 1 - gang.wantedPenalty,
      lostShare,
      bound,
      territory: gang.territory,
      power: gang.power,
      engaged: warfare === undefined ? null : warfare.engaged,
      inputs,
      objective,
    });
  }

  /**
   * The objective at a reading (#357): under 12 the rule's; with 12, core's choice from the slow snapshot of the time
   * (`gangRouteFactionOf`, `gangObjectiveChoice`), kept with the reading for the section's checks.
   */
  #objectiveAt(atMs: number, inputs: GangRuleInputs, faction: string, data: MediumSnapshotData): GangObjective {
    const members = inputs.members.length;
    if (members < GANG_MOST_MEMBERS) return gangObjectiveOf(members);
    const slow = this.#slowAt(atMs);
    let last = this.#lastChoice;
    if (last === null || last.slow !== slow || last.members !== members) {
      last = { slow, members, choice: gangObjectiveChoice(inputs, gangRouteFactionOf(slow, faction, data)) };
      this.#lastChoice = last;
    }
    this.#atTwelve.push({ atMs, bitNode: gangBitNodeKeyOf(slow), choice: last.choice });
    return last.choice.objective;
  }

  /**
   * The gang's faction's lines (#334): its reputation and favour, the augmentations bought there in the window
   * (`events`), and The Red Pill's route; none before a slow snapshot shows the gang's faction.
   */
  #factionLines(events: readonly StoredEvent[]): string[] {
    const slow = this.#lastSlow;
    const faction = gangFactionOf(slow);
    if (slow === null || faction === null) return ["  the gang's faction: not shown by a slow snapshot in the window"];
    const shop = gangShopOf(slow, faction);
    const bought = events
      .filter((event) => event.kind === AUGMENTATION_BOUGHT_EVENT_KIND)
      .map((event) => event.detail as { augmentation?: unknown; faction?: unknown })
      .filter((detail) => detail.faction === faction && typeof detail.augmentation === "string")
      .map((detail) => detail.augmentation as string);
    const installed = Object.hasOwn(slow.resetInfo?.ownedAugs ?? {}, THE_RED_PILL);
    const state = factionReadingOf(slow)?.state ?? null;
    const queued = state?.queuedAugmentations.includes(THE_RED_PILL) ?? false;
    // By hour from the first reading (an install's zeroing shows as a fall).
    const first = this.#reputations[0];
    const hours = new Map<number, number[]>();
    for (const { atMs, reputation } of this.#reputations) {
      const hour = Math.floor((atMs - (first?.atMs ?? atMs)) / 3_600_000);
      hours.set(hour, [...(hours.get(hour) ?? []), reputation]);
    }
    const byHour = [...hours].map(
      ([hour, values]) => `hour ${hour + 1} ${whole(values[0] as number)} → ${whole(values.at(-1) as number)}`,
    );
    // The estimate at the cycle's rate, as A8 and section 3's path have it.
    const info = slow.resetInfo;
    const lastAugReset = info?.lastAugReset;
    const estimate = (): string => {
      if (shop === null || info === undefined || typeof lastAugReset !== "number") return "its estimate unread";
      const needed = augmentationCost(THE_RED_PILL, {
        installed: info.ownedAugs,
        queued: state?.queuedAugmentations ?? [],
        sourceFile11Level: info.ownedSF["11"] ?? 0,
        bitNodeMultipliers: augmentationBitNodeMultipliers(info.currentNode, info.ownedSF),
      }).reputation;
      const sinceResetMs =
        this.#lastSlowGameTimeMs === null ? null : Math.max(0, this.#lastSlowGameTimeMs - lastAugReset);
      const etaMs = gangRedPillEtaMs(shop.reputation, needed, sinceResetMs);
      return (
        `its reputation ${whole(shop.reputation)} of ${whole(needed)}, ` +
        (Number.isFinite(etaMs)
          ? `about ${formatDuration(etaMs)} more at the cycle's rate`
          : sinceResetMs === null
            ? "its estimate unread (no game time)"
            : "none earned this cycle yet") +
        " (section 3's path fails if it's reached and not installed)"
      );
    };
    return [
      `  the gang's faction (#334), its shop nearly every augmentation: ${faction}, ` +
        (shop === null
          ? "not in the faction state"
          : `reputation ${whole(shop.reputation)}, favour ${shop.favor.toFixed(1)}`) +
        " at the window's last slow snapshot; bought there in the window: " +
        (bought.length === 0 ? "none" : `${bought.length} (${bought.join(", ")})`),
      `  the gang's faction's reputation by hour, at its slow snapshots: ${byHour.join("; ") || "none read"}`,
      `  The Red Pill's route: from ${faction}, the gang's faction, no Daedalus needed in BN2; ` +
        (installed
          ? "installed"
          : queued
            ? "queued, to install"
            : bought.includes(THE_RED_PILL)
              ? "bought"
              : estimate()),
    ];
  }

  /**
   * The section's lines, its failures added to `failures`; `events` the window's, for the gang's faction (#334) and BN2's
   * route (#357); `before`, the brain's objective chosen before the window (#357), its last `gangObjectiveChosen`.
   */
  section(
    failures: string[],
    windowEndMs: number,
    events: readonly StoredEvent[] = [],
    before: readonly StoredEvent[] = [],
  ): string[] {
    const lines = [
      "7. The gang (#325, ascension G2, equipment G3, territory G4, its faction's shop G5; played in BN2 only for now)",
    ];
    if (this.#mediumInBitNode2 === 0) {
      lines.push("  not in BN2 in the window: no gang played");
      return lines;
    }
    const endMs = this.#lastAtMs ?? windowEndMs;
    const first = this.#points[0];
    if (this.#formed === null) {
      const notFormed = this.#notFormed.all(endMs).at(-1);
      lines.push(
        notFormed === undefined
          ? "  formed: no; no gang faction joined (NiteSec comes with avmnite-02h's backdoor)"
          : `  formed: no; ${notFormed.detail} since ${formatIsoTime(notFormed.fromMs)}`,
      );
    } else {
      lines.push(
        this.#formedBefore
          ? `  formed: with ${this.#formed.faction}, before the window`
          : `  formed: with ${this.#formed.faction}, first seen ${formatIsoTime(this.#formed.atMs)}`,
      );
      lines.push(...this.#factionLines(events));
    }
    if (first !== undefined) {
      lines.push(`  by hour, from ${formatIsoTime(first.atMs)}:`);
      const hours = new Map<number, GangPoint[]>();
      const hourOf = (atMs: number) => Math.floor((atMs - first.atMs) / 3_600_000);
      for (const point of this.#points) {
        const hour = hourOf(point.atMs);
        hours.set(hour, [...(hours.get(hour) ?? []), point]);
      }
      const nextAt = new Map(this.#points.map((point, index) => [point, this.#points[index + 1]?.atMs ?? null]));
      for (const [hour, points] of hours) {
        const start = points[0] as GangPoint;
        const end = points.at(-1) as GangPoint;
        const seconds = Math.max(1, (end.atMs - start.atMs) / 1000);
        const money = points.reduce((sum, each) => sum + each.moneyPerSecond, 0) / points.length;
        const worst = points.reduce((top, each) => (each.lostShare > top.lostShare ? each : top));
        const ascensions = this.#ascensions.filter((each) => hourOf(each.atMs) === hour);
        const purchases = this.#purchases.filter((each) => hourOf(each.atMs) === hour);
        const items = new Map<string, number>();
        for (const { equipment } of purchases) items.set(equipment, (items.get(equipment) ?? 0) + 1);
        const spent = purchases.reduce((sum, each) => sum + each.cost, 0);
        const deaths = this.#deaths.filter((each) => hourOf(each.atMs) === hour);
        // The time engaged: each reading engaged, to the next (the window's last to the hour's end, or the window's).
        const hourEndMs = Math.min(windowEndMs, first.atMs + (hour + 1) * 3_600_000);
        const engagedMs = points.reduce(
          (sum, each) => (each.engaged === true ? sum + Math.max(0, (nextAt.get(each) ?? hourEndMs) - each.atMs) : sum),
          0,
        );
        const warfareRead = points.some((each) => each.engaged !== null);
        lines.push(
          `    hour ${hour + 1}: ${start.members} → ${end.members} members; respect ${whole(start.respect)} → ` +
            `${whole(end.respect)} (${((end.respect - start.respect) / seconds).toFixed(2)}/s); ` +
            `$${whole(money)}/s on average; wanted penalty ${percent(start.penalty)} → ${percent(end.penalty)}, ` +
            `above its floor at most ${percent(worst.lostShare)} (the bound then ${percent(worst.bound)}, at ` +
            `${worst.members} members); ` +
            `tasks at its end: ${describeTaskMix(planAt(end))}; ` +
            (ascensions.length === 0
              ? "no ascensions"
              : `${ascensions.length} ascension${ascensions.length === 1 ? "" : "s"} (` +
                ascensions
                  .map((each) => `${each.name} ×${each.gain.toFixed(2)}, ${whole(each.respect)} respect`)
                  .join("; ") +
                ")") +
            "; " +
            (purchases.length === 0
              ? "no equipment bought"
              : `${purchases.length} equipment bought for $${whole(spent)} (` +
                [...items].map(([item, count]) => (count === 1 ? item : `${item} ×${count}`)).join(", ") +
                ")") +
            `; territory ${percent(start.territory)} → ${percent(end.territory)}, power ${start.power.toFixed(1)} → ` +
            `${end.power.toFixed(1)}; ` +
            (warfareRead ? `warfare engaged ${formatDuration(engagedMs)}` : "warfare not read") +
            `; ${deaths.length === 0 ? "no deaths" : `${deaths.length} death${deaths.length === 1 ? "" : "s"} (${deaths.map((each) => each.name).join(", ")})`}`,
        );
      }
      lines.push(
        "  clashes won and lost: not read, the game counts neither (the territory and power show what they came to)",
      );
    }
    lines.push("  problems the gang worker reported, as first seen:");
    if (this.#problems.size === 0) lines.push("    none");
    for (const [problem, atMs] of this.#problems) lines.push(`    ${formatIsoTime(atMs)}: ${problem}`);
    const stalls = [...this.#stallStretches, ...this.#stalls.open()].sort((a, b) => a.fromMs - b.fromMs);
    const judged: [readonly Stretch[], number, string][] = [
      [this.#notFormed.all(endMs), GANG_FORM_WITHIN_MS, "no gang formed with a gang faction joined"],
      [this.#recruitWaiting.all(endMs), GANG_RECRUIT_WITHIN_MS, "a recruit the respect allows not made"],
      [this.#overBound.all(endMs), GANG_WANTED_OVER_BOUND_MS, "the wanted penalty over the rule's bound, off course,"],
      [
        this.#overBoundOffJustice.all(endMs),
        GANG_WANTED_OUTCOME_MS,
        "the wanted penalty over the rule's bound with a member off justice",
      ],
      [this.#unread.all(endMs), GANG_UNREAD_WITHIN_MS, "the gang unread in BN2"],
      [this.#ascensionWaiting.all(endMs), GANG_ASCEND_WITHIN_MS, "an ascension the rule makes not made"],
      [
        this.#equipmentWaiting.all(endMs),
        GANG_EQUIP_WITHIN_MS,
        "equipment the rule buys, with the money free, not bought",
      ],
      [
        this.#warfareLosing.all(endMs),
        GANG_WARFARE_WITHIN_MS,
        "territory warfare engaged while the rule's measure says it loses",
      ],
      [
        this.#warfarePaying.all(endMs),
        GANG_WARFARE_WITHIN_MS,
        "territory warfare off while the rule's measure says it pays",
      ],
      ...GANG_STALL_KINDS.map(
        ({ kind, withinMs, what }) =>
          [stalls.filter((each) => each.kind === kind), withinMs, what] as [readonly Stretch[], number, string],
      ),
    ];
    for (const [stretches, withinMs, what] of judged) {
      lines.push(`  ${what} for ${formatDuration(withinMs)} or more:`);
      const long = stretches.filter((each) => each.toMs - each.fromMs >= withinMs);
      if (long.length === 0) lines.push("    none");
      for (const { fromMs, toMs, detail } of long) {
        const line =
          `${what} for ${formatDuration(toMs - fromMs)}, from ${formatIsoTime(fromMs)} to ` +
          `${formatIsoTime(toMs)} (${detail})`;
        lines.push(`    ${line}`);
        failures.push(line);
      }
    }
    lines.push(...this.#routeLines(events, before, endMs, failures));
    return lines;
  }

  /**
   * BN2's route (#357, slice 1), its lines and failures: (2)'s objective at 12, the brain's (its events) against core's
   * from the snapshots, and (1)'s estimates on an install before the gang.
   */
  #routeLines(events: readonly StoredEvent[], before: readonly StoredEvent[], endMs: number, failures: string[]) {
    const lines: string[] = [];
    const fail = (line: string) => {
      lines.push(`    ${line}`);
      failures.push(line);
    };
    const chosen = [...before, ...events].filter((event) => event.kind === GANG_OBJECTIVE_CHOSEN_EVENT_KIND);
    lines.push("  the objective at 12 members (#357), the brain's as chosen:");
    const inWindow = events.filter((event) => event.kind === GANG_OBJECTIVE_CHOSEN_EVENT_KIND);
    if (inWindow.length === 0) lines.push("    none chosen in the window");
    for (const { atMs, detail } of inWindow) {
      const fields = detail as Record<string, unknown>;
      const estimates = fields.reason !== "estimates" || (estimateWhole(fields.respect) && estimateWhole(fields.money));
      const eta = (value: unknown) => formatEta((value as { etaMs?: number | null } | null)?.etaMs ?? null);
      const words =
        fields.reason === "estimates"
          ? `${String(fields.objective)}, The Red Pill in respect's ${eta(fields.respect)}, money's ${eta(fields.money)}`
          : `${String(fields.objective)} (${String(fields.reason)})`;
      if (estimates) lines.push(`    ${formatIsoTime(atMs)}: ${words}`);
      else fail(`the objective at 12 without its estimates: ${String(fields.objective)} at ${formatIsoTime(atMs)}`);
    }
    // At each reading at 12: the brain's objective then (its last event by then, of the same BitNode, the event's
    // `bitNode`, #368's review), against core's. Core's is money from The Red Pill's `augmentationBought` in the
    // BitNode on (#368's review): A6's queue has it before a slow snapshot shows it queued, and the brain's choice with it.
    // Bought until a purchase reported done shows never queued (`augmentationNotQueued`, #368's re-review): the brain's
    // queue drops it then, and so its owned (that alert's own failure, not this one's).
    const redPillEvents = events
      .filter(
        (event) =>
          (event.kind === AUGMENTATION_BOUGHT_EVENT_KIND || event.kind === AUGMENTATION_NOT_QUEUED_EVENT_KIND) &&
          (event.detail as { augmentation?: unknown } | null)?.augmentation === THE_RED_PILL,
      )
      .map((event) => ({
        atMs: event.atMs,
        bought: event.kind === AUGMENTATION_BOUGHT_EVENT_KIND,
        bitNode: gangBitNodeKeyOf(this.#slowAt(event.atMs)),
      }));
    /** The Red Pill bought by `atMs` in `bitNode`: the last of its events there by then a purchase. */
    const boughtAt = (atMs: number, bitNode: string) =>
      redPillEvents.findLast((each) => each.atMs <= atMs && each.bitNode === bitNode)?.bought === true;
    const owned: GangObjectiveChoice = { objective: "money", reason: "The Red Pill owned", respect: null, money: null };
    const differs = new Stretches();
    let neverMs = 0;
    let lastNever: { atMs: number; bitNode: string } | null = null;
    const latest = new Map<string, StoredEvent>();
    let index = 0;
    for (const { atMs, bitNode, choice: read } of this.#atTwelve) {
      for (; index < chosen.length && (chosen[index] as StoredEvent).atMs <= atMs; index += 1) {
        const event = chosen[index] as StoredEvent;
        latest.set(String((event.detail as { bitNode?: unknown } | null)?.bitNode), event);
      }
      const choice = boughtAt(atMs, bitNode) ? owned : read;
      const brains = latest.get(bitNode);
      const brainObjective = (brains?.detail as { objective?: unknown } | undefined)?.objective;
      if (brainObjective === undefined) {
        if (lastNever !== null && lastNever.bitNode === bitNode && atMs - lastNever.atMs <= HACKING_EXP_GAP_MS) {
          neverMs += atMs - lastNever.atMs;
        }
        lastNever = { atMs, bitNode };
        differs.add(atMs, null);
        continue;
      }
      lastNever = null;
      differs.add(
        atMs,
        choice.reason !== "unread" && brainObjective !== choice.objective
          ? `the brain's ${String(brainObjective)}, core's ${describeObjective(choice)}`
          : null,
      );
    }
    lines.push(
      `  the objective at 12 differing from core's (from the snapshots) for ${formatDuration(GANG_OBJECTIVE_DIFFERS_WITHIN_MS)} or more:`,
    );
    const long = differs.all(endMs).filter((each) => each.toMs - each.fromMs >= GANG_OBJECTIVE_DIFFERS_WITHIN_MS);
    if (long.length === 0) lines.push("    none");
    for (const { fromMs, toMs, detail } of long) {
      fail(
        `the objective at 12 differing from core's for ${formatDuration(toMs - fromMs)}, from ${formatIsoTime(fromMs)} ` +
          `to ${formatIsoTime(toMs)} (${detail})`,
      );
    }
    lines.push(
      `  at 12 members with no objective from the brain, added up, for ${formatDuration(GANG_OBJECTIVE_NEVER_MS)} or more:`,
    );
    if (neverMs >= GANG_OBJECTIVE_NEVER_MS) {
      fail(
        `at 12 members with no objective from the brain for ${formatDuration(neverMs)} online, added up (#357's (2))`,
      );
    } else {
      lines.push("    none");
    }
    // (1): an install chosen in BN2 before the gang, with avmnite-02h's level read, without its estimates.
    lines.push(
      "  installs chosen in BN2 before the gang, avmnite-02h's level read, without the planner's estimates (#357):",
    );
    let before1 = 0;
    for (const { atMs, kind, detail } of events) {
      if (kind !== AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND || this.#bitNodeAt(atMs) !== GANG_BITNODE) continue;
      if (this.#routeLevelReadAtMs === null || this.#routeLevelReadAtMs > atMs) continue;
      const reading = this.#formedAt.findLast((each) => each.atMs <= atMs);
      if (reading === undefined || reading.formed) continue;
      const timing = (detail as { timing?: { route?: unknown; gang?: { installNowMs?: unknown } } } | null)?.timing;
      const installNowMs = timing?.gang?.installNowMs;
      if (timing?.route === GANG_FORMING_ROUTE && typeof installNowMs === "number" && Number.isFinite(installNowMs)) {
        continue;
      }
      before1 += 1;
      fail(
        `install chosen in BN2 before the gang without the planner's estimates: at ${formatIsoTime(atMs)}, ` +
          `${GANG_ROUTE_SERVER}'s level read, its reason ${String((detail as { reason?: unknown } | null)?.reason)}`,
      );
    }
    if (before1 === 0) lines.push("    none");
    // (3): each install chosen in BN2 with the gang formed, its cost there; one before The Red Pill (not its own, nor
    // levelling's after it) without the planner's estimates fails.
    lines.push("  installs chosen in BN2 with the gang (#357's (3)), each one's cost:");
    let withGang = 0;
    for (const { atMs, kind, detail } of events) {
      if (kind !== AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND || this.#bitNodeAt(atMs) !== GANG_BITNODE) continue;
      if (this.#formedAt.findLast((each) => each.atMs <= atMs)?.formed !== true) continue;
      withGang += 1;
      const fields = (detail ?? {}) as { reason?: unknown; timing?: unknown; gangCost?: unknown };
      const reason = String(fields.reason);
      const cost = fields.gangCost as GangInstallCost | undefined;
      const words =
        cost === undefined
          ? reason === THE_RED_PILL || reason === "the hacking level"
            ? "The Red Pill's own, or after it: no cost there"
            : "its cost not recorded"
          : describeGangInstallCost(cost);
      lines.push(`    ${formatIsoTime(atMs)}: ${reason}; ${words}`);
      const timing = fields.timing as
        | { route?: unknown; gangInstall?: { installNow?: unknown }; gang?: { installNowMs?: unknown } }
        | undefined;
      const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value);
      // (3)'s; or (1)'s, in the minute after the gang formed before a slow snapshot shows its faction (#368).
      const estimated =
        (timing?.route === GANG_FORMED_ROUTE && finite(timing.gangInstall?.installNow)) ||
        (timing?.route === GANG_FORMING_ROUTE && finite(timing.gang?.installNowMs));
      const redPillInstalled = Object.hasOwn(this.#slowAt(atMs)?.resetInfo?.ownedAugs ?? {}, THE_RED_PILL);
      if (reason !== THE_RED_PILL && reason !== "the hacking level" && !redPillInstalled && !estimated) {
        fail(
          `install chosen in BN2 with the gang before The Red Pill without the planner's estimates: at ` +
            `${formatIsoTime(atMs)}, its reason ${reason}`,
        );
      }
    }
    if (withGang === 0) lines.push("    none");
    return lines;
  }
}

const whole = (value: number) => Math.round(value).toLocaleString("en-US");
const percent = (share: number) => `${(share * 100).toFixed(1)}%`;

/**
 * The measure at a reading (G4), for a failure's detail: the clashes expected to lose territory or gain none (null:
 * the measure wasn't needed), or the territory's worth an update against the deaths' cost, with the crew's size.
 */
function describeMeasure(measure: GangWarfareMeasure | null, expected: number, crew: number): string {
  if (measure === null) {
    const what = expected === 0 ? "gain no territory" : "lose territory";
    return `the clashes expected to ${what}, ${crew} on Territory Warfare`;
  }
  return (
    `the territory expected worth ${whole(measure.gainPerUpdate)} an update against deaths costing ` +
    `${whole(measure.deathCostPerUpdate + measure.tailCostPerUpdate)}, ${crew} on Territory Warfare`
  );
}

/**
 * The first upgrade the rule buys with `free` dollars (core's `planGangEquipment`), as the brain would: the ascension
 * the rule makes (`due`) first, each member's forecasts worked out there. None, before any of that, with the money
 * short of the cheapest upgrade.
 */
function gangEquipmentDue(
  inputs: GangRuleInputs,
  due: GangAscensionAppraisal | null,
  free: number,
  costMult: number,
  objective: GangObjective,
): GangEquipmentAppraisal | null {
  const cheapest = Math.min(...GANG_EQUIPMENT.map((each) => each.cost)) * costMult;
  if (!(free >= cheapest)) return null;
  const plan = { assignments: [], ascend: due, objective };
  return planGangEquipment(inputs, plan, { budget: free, costMult }).buy[0] ?? null;
}
