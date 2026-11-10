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
//   (the brain's holds, as the worker was given them), not bought, for over `GANG_EQUIP_WITHIN_MS`.
// The ascensions themselves (G2) are seen as a member's ascension points rising between readings (core's
// `gangAscensionPointsOf`), each with its largest multiplier gain and the respect it had earned, by hour; the
// equipment bought (G3) as an item new in a member's lists, its cost the discounted one at the reading before.
import {
  GANG_CYCLE_MS,
  GANG_EQUIPMENT,
  GANG_FACTIONS,
  GANG_STATS,
  GANG_WANTED_RECOVERY_MS,
  type GangAscensionAppraisal,
  type GangEquipmentAppraisal,
  type GangMemberReading,
  type GangPlan,
  type GangRuleInputs,
  gangAscensionPointsOf,
  gangAscensionToMake,
  gangEquipment,
  gangEquipmentCost,
  gangEquipmentCostMultOf,
  gangInBonusTime,
  gangLostShare,
  gangLostShareBound,
  gangObjectiveOf,
  gangRecruitsAllowed,
  gangSoftcapOf,
  gangWantedRecovers,
  isGangJusticeTask,
  type MediumSnapshotData,
  planGang,
  planGangEquipment,
  type SlowSnapshotData,
} from "@bitburner-agent/core";
import { bitNodeOfSlow, describeTaskMix, GANG_BITNODE, gangSnapshotOf, topAscensionGain } from "./gang.ts";
import { formatDuration, formatIsoTime } from "./gap-report.ts";

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
  /** What the rule read: the plan, for the task mix, is worked out only for an hour's last reading. */
  inputs: GangRuleInputs;
}

/** The rule's plan at a reading (core's `planGang`). */
const planAt = (point: GangPoint): GangPlan => planGang(point.inputs);

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
  /** The cost multiplier at the reading before: what a purchase since cost. */
  #lastCostMult: number | null = null;
  /** Each member at the reading before, by name: its ascension points rising says it ascended. */
  #lastMembers = new Map<string, GangMemberReading>();

  /** A slow snapshot: the BitNode from then on. */
  addSlow(atMs: number, data: SlowSnapshotData): void {
    const bitNode = bitNodeOfSlow(data);
    if (bitNode !== null) this.#bitNodes.push({ atMs, bitNode });
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
      ]) {
        stretches.add(atMs, null);
      }
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
    if (snapshot.kind !== "gang") {
      this.#recruitWaiting.add(atMs, null);
      this.#overBound.add(atMs, null);
      this.#overBoundOffJustice.add(atMs, null);
      this.#ascensionWaiting.add(atMs, null);
      this.#equipmentWaiting.add(atMs, null);
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
    const inputs: GangRuleInputs = {
      gang: { respect: gang.respect, wantedLevel: gang.wantedLevel, territory: gang.territory },
      isHacking: gang.isHacking,
      members,
      softcap: gangSoftcapOf(GANG_BITNODE),
    };
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
    const due = ascended ? null : gangAscensionToMake(inputs, gangObjectiveOf(members.length));
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
      this.#purchases.length > boughtBefore || ascended ? null : gangEquipmentDue(inputs, due, free, costMult);
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
      inputs,
    });
  }

  /** The section's lines, its failures added to `failures`. */
  section(failures: string[], windowEndMs: number): string[] {
    const lines = ["7. The gang (#325, ascension G2, equipment G3; played in BN2 only for now)"];
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
    }
    if (first !== undefined) {
      lines.push(`  by hour, from ${formatIsoTime(first.atMs)}:`);
      const hours = new Map<number, GangPoint[]>();
      const hourOf = (atMs: number) => Math.floor((atMs - first.atMs) / 3_600_000);
      for (const point of this.#points) {
        const hour = hourOf(point.atMs);
        hours.set(hour, [...(hours.get(hour) ?? []), point]);
      }
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
                ")"),
        );
      }
    }
    lines.push("  problems the gang worker reported, as first seen:");
    if (this.#problems.size === 0) lines.push("    none");
    for (const [problem, atMs] of this.#problems) lines.push(`    ${formatIsoTime(atMs)}: ${problem}`);
    const judged = [
      [this.#notFormed, GANG_FORM_WITHIN_MS, "no gang formed with a gang faction joined"],
      [this.#recruitWaiting, GANG_RECRUIT_WITHIN_MS, "a recruit the respect allows not made"],
      [this.#overBound, GANG_WANTED_OVER_BOUND_MS, "the wanted penalty over the rule's bound, off course,"],
      [
        this.#overBoundOffJustice,
        GANG_WANTED_OUTCOME_MS,
        "the wanted penalty over the rule's bound with a member off justice",
      ],
      [this.#unread, GANG_UNREAD_WITHIN_MS, "the gang unread in BN2"],
      [this.#ascensionWaiting, GANG_ASCEND_WITHIN_MS, "an ascension the rule makes not made"],
      [this.#equipmentWaiting, GANG_EQUIP_WITHIN_MS, "equipment the rule buys, with the money free, not bought"],
    ] as const;
    for (const [stretches, withinMs, what] of judged) {
      lines.push(`  ${what} for ${formatDuration(withinMs)} or more:`);
      const long = stretches.all(endMs).filter((each) => each.toMs - each.fromMs >= withinMs);
      if (long.length === 0) lines.push("    none");
      for (const { fromMs, toMs, detail } of long) {
        const line =
          `${what} for ${formatDuration(toMs - fromMs)}, from ${formatIsoTime(fromMs)} to ` +
          `${formatIsoTime(toMs)} (${detail})`;
        lines.push(`    ${line}`);
        failures.push(line);
      }
    }
    return lines;
  }
}

const whole = (value: number) => Math.round(value).toLocaleString("en-US");
const percent = (share: number) => `${(share * 100).toFixed(1)}%`;

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
): GangEquipmentAppraisal | null {
  const cheapest = Math.min(...GANG_EQUIPMENT.map((each) => each.cost)) * costMult;
  if (!(free >= cheapest)) return null;
  return planGangEquipment(inputs, { assignments: [], ascend: due }, { budget: free, costMult }).buy[0] ?? null;
}
