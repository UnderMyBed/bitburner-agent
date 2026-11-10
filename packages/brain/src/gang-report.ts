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
// - the gang unread (no reading, or the worker's problem) in BN2 for over `GANG_UNREAD_WITHIN_MS`.
import {
  GANG_CYCLE_MS,
  GANG_FACTIONS,
  GANG_WANTED_RECOVERY_MS,
  type GangPlan,
  gangInBonusTime,
  gangLostShare,
  gangLostShareBound,
  gangRecruitsAllowed,
  gangSoftcapOf,
  gangWantedRecovers,
  isGangJusticeTask,
  type MediumSnapshotData,
  planGang,
  type SlowSnapshotData,
} from "@bitburner-agent/core";
import { bitNodeOfSlow, describeTaskMix, GANG_BITNODE, gangSnapshotOf } from "./gang.ts";
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
  plan: GangPlan;
}

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
      ]) {
        stretches.add(atMs, null);
      }
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
    const plan = planGang({
      gang: { respect: gang.respect, wantedLevel: gang.wantedLevel, territory: gang.territory },
      isHacking: gang.isHacking,
      members,
      softcap: gangSoftcapOf(GANG_BITNODE),
    });
    this.#points.push({
      atMs,
      members: members.length,
      respect: gang.respect,
      moneyPerSecond: (gang.moneyGainRate * 1000) / GANG_CYCLE_MS,
      penalty: 1 - gang.wantedPenalty,
      lostShare,
      bound,
      plan,
    });
  }

  /** The section's lines, its failures added to `failures`. */
  section(failures: string[], windowEndMs: number): string[] {
    const lines = ["7. The gang (#325; played in BN2 only for now)"];
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
      for (const point of this.#points) {
        const hour = Math.floor((point.atMs - first.atMs) / 3_600_000);
        hours.set(hour, [...(hours.get(hour) ?? []), point]);
      }
      for (const [hour, points] of hours) {
        const start = points[0] as GangPoint;
        const end = points.at(-1) as GangPoint;
        const seconds = Math.max(1, (end.atMs - start.atMs) / 1000);
        const money = points.reduce((sum, each) => sum + each.moneyPerSecond, 0) / points.length;
        const worst = points.reduce((top, each) => (each.lostShare > top.lostShare ? each : top));
        lines.push(
          `    hour ${hour + 1}: ${start.members} → ${end.members} members; respect ${whole(start.respect)} → ` +
            `${whole(end.respect)} (${((end.respect - start.respect) / seconds).toFixed(2)}/s); ` +
            `$${whole(money)}/s on average; wanted penalty ${percent(start.penalty)} → ${percent(end.penalty)}, ` +
            `above its floor at most ${percent(worst.lostShare)} (the bound then ${percent(worst.bound)}, at ` +
            `${worst.members} members); ` +
            `tasks at its end: ${describeTaskMix(end.plan)}`,
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
