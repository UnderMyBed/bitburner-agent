// The hacking ceilings (#196, M4 phase A slice A1), from the snapshots alone: the most hacking income a second could
// earn at the player's hacking then (core's `batcherIncomePerGigabyteSecond` and `hackingIncomePerGigabyteSecond`,
// from the game's formulas), and what hacking actually earned (the slow snapshot's `moneySources.hacking`). The score
// is on the RAM the brain's hacking uses (the hack loop's hosts); the bound, which a run never passes, on all the RAM a
// script could run on. The dashboard's rows and the run report's section 5. Upper bounds, not plans. And each target's
// batcher income on the hosts' RAM, a medium snapshot at a time, for section 6's stuck target check (#275).
import {
  batcherIncomePerGigabyteSecond,
  batchIncomeMostPerSecond,
  type HackingPlayer,
  type HackingTarget,
  hackingIncomePerGigabyteSecond,
  type MediumSnapshotData,
  type SlowSnapshotData,
  type StaticSnapshotData,
  usableRamGb,
} from "@bitburner-agent/core";
import { MEDIUM_SNAPSHOT_GAP_MS } from "./backdoors.ts";
import { bitNodeHackingOf } from "./batcher.ts";
import { formatIsoTime } from "./gap-report.ts";
import { chooseHackHosts } from "./hack-loop.ts";
import type { Environment, TelemetryStore } from "./telemetry-store.ts";

/** The ceilings at one snapshot, or why they can't be said. */
export type HackingCeiling =
  | {
      known: true;
      /**
       * The score (#196): $ a second a batcher could earn with the brain's hacking RAM (the hack loop's hosts), on its
       * best target: what the batcher (A7) is judged on.
       */
      batcherIncomePerSecond: number;
      /** The batcher ceiling's target; null with nothing the player can hack yet. */
      target: string | null;
      /** The hacking ceiling on the same RAM: $ a second any hacker could earn there. */
      incomePerSecond: number;
      /** The hack loop's hosts, and their RAM in all. */
      hostCount: number;
      hostRamGb: number;
      /**
       * The bound: the hacking ceiling on all the RAM a script could run on (every rooted server: the game's, home,
       * cloud and Hacknet servers), with its count and RAM. Hacking that earns more means the formula is wrong.
       */
      boundIncomePerSecond: number;
      rootedCount: number;
      rootedRamGb: number;
    }
  | { known: false; reason: string };

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * The player's skills and multipliers the formulas read, or the first missing (the snapshot is the Agent's word), in
 * `bitNode`, the slow snapshot's: its `ScriptHackMoney` folded into `hacking_money` (#321, `Hacking.ts:53-54`) and its
 * `ServerGrowthRate` into `hacking_grow` (#334, `Server/formulas/grow.ts:22-28`; core's
 * `bitNodeHackingMultipliers`, BN1's in a BitNode it hasn't them for, which the run report lists). No BitNode read
 * (no slow snapshot then) is a ceiling unknown, never BN1's.
 */
function hackingPlayerOf(player: unknown, bitNode: number | null): HackingPlayer | string {
  const { skills, mults } = (player ?? {}) as { skills?: Record<string, unknown>; mults?: Record<string, unknown> };
  for (const skill of ["hacking", "intelligence"]) {
    if (!isNumber(skills?.[skill])) return `the medium snapshot's player has no skills.${skill}`;
  }
  for (const mult of ["hacking_chance", "hacking_speed", "hacking_money", "hacking_grow"]) {
    if (!isNumber(mults?.[mult])) return `the medium snapshot's player has no mults.${mult}`;
  }
  if (bitNode === null) return "no slow snapshot says the BitNode (its hacking multipliers)";
  const { ScriptHackMoney, ServerGrowthRate } = bitNodeHackingOf(bitNode).multipliers;
  return {
    skills,
    mults: {
      ...mults,
      hacking_money: (mults?.hacking_money as number) * ScriptHackMoney,
      hacking_grow: (mults?.hacking_grow as number) * ServerGrowthRate,
    },
  } as unknown as HackingPlayer;
}

type MediumServer = MediumSnapshotData["servers"][number];

/** Some servers' RAM a script can use (core's `usableRamGb`, whole threads), their RAM, and their best cores. */
function ramOf(servers: (MediumServer | undefined)[]): { usableGb: number; ramGb: number; cores: number } {
  let usableGb = 0;
  let ramGb = 0;
  let cores = 1;
  for (const server of servers) {
    if (isNumber(server?.maxRam)) {
      ramGb += server.maxRam;
      usableGb += usableRamGb(server.maxRam);
    }
    if (isNumber(server?.cpuCores)) cores = Math.max(cores, server.cpuCores);
  }
  return { usableGb, ramGb, cores };
}

/**
 * The ceilings now (#196). The targets are the game's servers rooted, with money (core's figures are 0 for one needing
 * more hacking than the player has: a hack thread's share is 0 there, Hacking.ts:52).
 * - **The score, on the brain's hacking RAM:** the hack loop's hosts (`chooseHackHosts`, `hackLoopHosts`'s names,
 *   the brain's cloud servers among them since #194), the RAM their whole threads can use in the medium snapshot
 *   (`usableRamGb`), times the best target's batcher ceiling and, beside it, its hacking ceiling.
 * - **The bound, on all the RAM a script could run on:** every rooted server's, home's and the player's own included,
 *   times the best target's hacking ceiling. The owner's scripts, a terminal `hack` and A7 on home all count in what
 *   hacking earns, so all count here.
 * Each takes the best cores among its servers for all their RAM: loose where their cores differ. Unknown without both
 * snapshots or the player's skills and multipliers. Given `incomes`, it fills each target's batcher income on the
 * hosts' RAM (#275): its batcher ceiling a GB times that RAM, at most what batches can take from its money (core's
 * `batchIncomeMostPerSecond`), the run report's measure of a target against the best.
 */
export function hackingCeiling(
  staticData: StaticSnapshotData | null | undefined,
  mediumData: MediumSnapshotData | null | undefined,
  bitNode: number | null,
  incomes?: Map<string, number>,
): HackingCeiling {
  if (!Array.isArray(staticData?.servers)) return { known: false, reason: "no static snapshot" };
  if (!Array.isArray(mediumData?.servers)) return { known: false, reason: "no medium snapshot" };
  const player = hackingPlayerOf(mediumData.player, bitNode);
  if (typeof player === "string") return { known: false, reason: player };
  const now = new Map(
    mediumData.servers
      .filter((server) => typeof server?.hostname === "string")
      .map((server) => [server.hostname, server]),
  );
  const targets: [string, HackingTarget][] = [];
  for (const server of staticData.servers) {
    const { hostname, moneyMax, minDifficulty, requiredHackingSkill, serverGrowth } = server ?? {};
    // The game's own: home is purchased too (PlayerObjectGeneralMethods.ts:72).
    if (
      typeof hostname === "string" &&
      server.purchasedByPlayer === false &&
      now.get(hostname)?.hasAdminRights === true &&
      isNumber(moneyMax) &&
      isNumber(minDifficulty) &&
      isNumber(requiredHackingSkill) &&
      isNumber(serverGrowth)
    ) {
      targets.push([hostname, { moneyMax, minDifficulty, requiredHackingSkill, serverGrowth }]);
    }
  }
  /** The best target by `perGigabyteSecond` at `cores`, and its figure; 0 and null with none. `each` sees every one. */
  const best = (
    perGigabyteSecond: typeof hackingIncomePerGigabyteSecond,
    cores: number,
    each?: (hostname: string, target: HackingTarget, figure: number) => void,
  ) => {
    let found: { target: string | null; perGigabyteSecond: number } = { target: null, perGigabyteSecond: 0 };
    for (const [hostname, target] of targets) {
      const figure = perGigabyteSecond(target, player, cores);
      each?.(hostname, target, figure);
      if (figure > found.perGigabyteSecond) found = { target: hostname, perGigabyteSecond: figure };
    }
    return found;
  };
  const hostNames = chooseHackHosts(staticData, mediumData);
  const hosts = ramOf(hostNames.map((hostname) => now.get(hostname)));
  const rootedServers = mediumData.servers.filter(
    (server) => server?.hasAdminRights === true && isNumber(server.maxRam) && server.maxRam > 0,
  );
  const rooted = ramOf(rootedServers);
  const batcher = best(
    batcherIncomePerGigabyteSecond,
    hosts.cores,
    incomes &&
      ((hostname, target, figure) =>
        incomes.set(hostname, Math.min(figure * hosts.usableGb, batchIncomeMostPerSecond(target, player)))),
  );
  return {
    known: true,
    batcherIncomePerSecond: hosts.usableGb * batcher.perGigabyteSecond,
    target: batcher.target,
    incomePerSecond: hosts.usableGb * best(hackingIncomePerGigabyteSecond, hosts.cores).perGigabyteSecond,
    hostCount: hostNames.length,
    hostRamGb: hosts.ramGb,
    boundIncomePerSecond: rooted.usableGb * best(hackingIncomePerGigabyteSecond, rooted.cores).perGigabyteSecond,
    rootedCount: rootedServers.length,
    rootedRamGb: rooted.ramGb,
  };
}

/** A target and what a batcher could earn a second on it with the hosts' RAM (#275). */
export interface TargetIncome {
  target: string;
  incomePerSecond: number;
}

/**
 * Each target's batcher income on the hosts' RAM at one medium snapshot (#275), as `hackingCeiling` fills them, held
 * by index into the fold's names (a 14-hour store's 5,000 medium snapshots, without a map each), and the best of them.
 */
export class TargetIncomesAt {
  readonly #names: ReadonlyMap<string, number>;
  readonly #incomes: Float64Array;
  /** The player's hacking level then, or null where the snapshot doesn't say. */
  readonly hacking: number | null;
  /** The target the most, with it: null with none above 0 (nothing hackable rooted). */
  readonly best: TargetIncome | null;

  constructor(names: ReadonlyMap<string, number>, incomes: ReadonlyMap<string, number>, hacking: number | null) {
    this.#names = names;
    this.#incomes = new Float64Array(names.size).fill(Number.NaN);
    let best: TargetIncome | null = null;
    for (const [target, incomePerSecond] of incomes) {
      this.#incomes[names.get(target) as number] = incomePerSecond;
      if (incomePerSecond > (best?.incomePerSecond ?? 0)) best = { target, incomePerSecond };
    }
    this.hacking = hacking;
    this.best = best;
  }

  /** A target's income then; null for one that wasn't a target (not rooted, the player's own, or no figures). */
  incomeOf(target: string): number | null {
    const index = this.#names.get(target);
    const income = index === undefined ? undefined : this.#incomes[index];
    return income === undefined || Number.isNaN(income) ? null : income;
  }
}

/** Each medium snapshot's targets' batcher incomes on the hosts' RAM (#275), in time order, for the run report. */
export class BatcherTargetIncomes {
  readonly #names = new Map<string, number>();
  readonly #points: { atMs: number; incomes: TargetIncomesAt | null }[] = [];

  /** A medium snapshot's, at `atMs`; null `incomes` where its ceilings were unknown. */
  add(atMs: number, incomes: ReadonlyMap<string, number> | null, hacking: number | null): void {
    if (incomes === null) {
      this.#points.push({ atMs, incomes: null });
      return;
    }
    for (const target of incomes.keys()) if (!this.#names.has(target)) this.#names.set(target, this.#names.size);
    this.#points.push({ atMs, incomes: new TargetIncomesAt(this.#names, incomes, hacking) });
  }

  /**
   * The incomes in force at `atMs`: the latest medium snapshot's by then. Null (unknown) before the first, from one
   * over `MEDIUM_SNAPSHOT_GAP_MS` old (a degraded medium tier: its RAM and root rights stale), or from before an
   * install (`resetsMs`) that falls between it and `atMs`, which takes the cloud servers and the root rights away
   * (#277's review); and where its ceilings were unknown.
   */
  at(atMs: number, resetsMs: readonly number[] = []): TargetIncomesAt | null {
    const points = this.#points;
    // The last at or before `atMs`, by halves.
    let [low, high] = [0, points.length - 1];
    let found = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if ((points[middle] as { atMs: number }).atMs <= atMs) {
        found = middle;
        low = middle + 1;
      } else high = middle - 1;
    }
    const point = points[found];
    if (point === undefined || atMs - point.atMs > MEDIUM_SNAPSHOT_GAP_MS) return null;
    if (resetsMs.some((resetMs) => resetMs > point.atMs && resetMs <= atMs)) return null;
    return point.incomes;
  }
}

/** Hacking's money since the install, at one slow snapshot, and the install it counts from. */
export interface HackingMoneyPoint {
  atMs: number;
  hacking: number;
  /** `resetInfo.lastAugReset`: when the last install was; null where the snapshot doesn't say. */
  lastAugReset: number | null;
}

/** The slow snapshot's `moneySources.hacking` and `resetInfo.lastAugReset`, or null without the money sources. */
export function hackingMoneyOf(data: SlowSnapshotData | null | undefined): Omit<HackingMoneyPoint, "atMs"> | null {
  const hacking = data?.moneySources?.hacking;
  const lastAugReset = data?.resetInfo?.lastAugReset;
  return isNumber(hacking) ? { hacking, lastAugReset: isNumber(lastAugReset) ? lastAugReset : null } : null;
}

/** Whether an install came between two points: their `lastAugReset`s differ. */
const installedBetween = (from: HackingMoneyPoint, to: HackingMoneyPoint) =>
  from.lastAugReset !== null && to.lastAugReset !== null && from.lastAugReset !== to.lastAugReset;

/**
 * What hacking earned from one point to the next (#196): after an install, which resets the count
 * (PlayerObjectGeneralMethods.ts:126-128), the count since; otherwise its rise, or 0 where it fell, as on a game
 * relaunch, which loads the save's older count.
 */
export function hackingEarnedBetween(from: HackingMoneyPoint, to: HackingMoneyPoint): number {
  if (installedBetween(from, to)) return to.hacking;
  return Math.max(0, to.hacking - from.hacking);
}

/** What hacking earned over the points, in order, a second: null with fewer than two, or none between. */
export function hackingIncomePerSecond(points: HackingMoneyPoint[]): number | null {
  const first = points[0];
  const last = points.at(-1);
  if (first === undefined || last === undefined || !(last.atMs > first.atMs)) return null;
  let earned = 0;
  for (let index = 1; index < points.length; index++) {
    earned += hackingEarnedBetween(points[index - 1] as HackingMoneyPoint, points[index] as HackingMoneyPoint);
  }
  return (earned / (last.atMs - first.atMs)) * 1000;
}

// --- The dashboard's rows ---------------------------------------------------------------------------------------------

/** How far back the dashboard's hacking income looks: ten slow snapshots. */
export const DASHBOARD_HACKING_WINDOW_MS = 10 * 60_000;

/** What the dashboard shows of hacking (#196), with its rows' text, so the page and the report say it the same way. */
export interface HackingView {
  /** The ceilings at the newest static and medium snapshots. */
  ceiling: HackingCeiling;
  /** What hacking earned a second over the last `DASHBOARD_HACKING_WINDOW_MS` of slow snapshots, or null. */
  incomePerSecond: number | null;
  ceilingText: string;
  incomeText: string;
}

/** The dashboard's hacking rows, from the store's newest snapshots and its last 10 minutes of slow ones. */
export function hackingView({
  store,
  environment,
  nowMs,
  staticData,
  mediumData,
  bitNode,
}: {
  store: TelemetryStore;
  environment: Environment;
  nowMs: number;
  staticData: StaticSnapshotData | null | undefined;
  mediumData: MediumSnapshotData | null | undefined;
  /** The BitNode the newest slow snapshot shows (#321), for its hacking multipliers; null without one. */
  bitNode: number | null;
}): HackingView {
  const points: HackingMoneyPoint[] = [];
  const window = { environment, tier: "slow", sinceMs: nowMs - DASHBOARD_HACKING_WINDOW_MS, untilMs: nowMs };
  for (const { receivedAtMs, data } of store.iterateSnapshotsInWindow(window)) {
    const money = hackingMoneyOf(data as SlowSnapshotData);
    if (money !== null) points.push({ atMs: receivedAtMs, ...money });
  }
  const ceiling = hackingCeiling(staticData, mediumData, bitNode);
  const incomePerSecond = hackingIncomePerSecond(points);
  const ofCeilings =
    incomePerSecond !== null && ceiling.known && ceiling.batcherIncomePerSecond > 0
      ? `: ${percentOf(incomePerSecond, ceiling.batcherIncomePerSecond)} of the batcher ceiling now, ` +
        `${percentOf(incomePerSecond, ceiling.incomePerSecond)} of the ceiling`
      : "";
  return {
    ceiling,
    incomePerSecond,
    ceilingText: describeCeiling(ceiling),
    incomeText:
      incomePerSecond === null
        ? "— (not two slow snapshots with the money sources in the last 10 min)"
        : `${formatPerSecond(incomePerSecond)} over the last 10 min${ofCeilings}`,
  };
}

// --- The run report's section ---------------------------------------------------------------------------------------

/** The stretches the report adds up separately. */
export const HACKING_STRETCH_MS = 60 * 60_000;
/** The stretch the report's headline takes the best of: A7's score. */
export const HACKING_BEST_STRETCH_MS = 10 * 60_000;

/** What hacking earned over a stretch, and the ceilings' $ over it: the score's two and the bound. */
export interface HackingAgainstCeiling {
  fromMs: number;
  toMs: number;
  /** The time in it judged: between slow snapshots with the money sources, where the ceilings were known throughout. */
  judgedMs: number;
  earned: number;
  batcher: number;
  ceiling: number;
  bound: number;
}

/** The ceilings' figures a second, at one medium snapshot. */
type Rates = Pick<HackingAgainstCeiling, "batcher" | "ceiling" | "bound">;

/** A stretch between two slow snapshots in which hacking's count fell or an install came: a relaunch or a reset. */
interface Break {
  fromMs: number;
  toMs: number;
}

/**
 * The run report's fold (#196): fed the static snapshots, then the slow ones, then the medium ones, each in time order
 * (the report reads them so). Each medium snapshot's ceilings use the static snapshot then (the latest before it, else
 * the first); its servers' money is taken between the breaks the slow snapshots show.
 */
export class HackingFold {
  readonly #statics: { atMs: number; data: StaticSnapshotData }[] = [];
  readonly #ceilings: { atMs: number; ceiling: HackingCeiling }[] = [];
  readonly #money: HackingMoneyPoint[] = [];
  /** Each slow snapshot's BitNode (#321), for the medium snapshots' hacking multipliers: the newest by then. */
  readonly #bitNodes: { atMs: number; bitNode: number }[] = [];
  readonly #breaks: Break[] = [];
  #slowCount = 0;
  /** Between breaks: the game's servers' money at the first medium snapshot and the last. */
  readonly #serversMoney = new Map<number, { first: Map<string, number>; last: Map<string, number> }>();
  readonly #ignored: ReadonlySet<string>;
  /** Each medium snapshot's targets' batcher incomes on the hosts' RAM (#275): section 6's stuck target check. */
  readonly targetIncomes = new BatcherTargetIncomes();

  /** `ignored`: the player's own servers, whose money isn't hacked. */
  constructor(ignored: ReadonlySet<string>) {
    this.#ignored = ignored;
  }

  addStatic(atMs: number, data: StaticSnapshotData): void {
    this.#statics.push({ atMs, data });
  }

  addSlow(atMs: number, data: SlowSnapshotData): void {
    if (this.#ceilings.length > 0) throw new Error("the slow snapshots must come before the medium ones");
    this.#slowCount++;
    const bitNode = (data?.resetInfo as { currentNode?: unknown } | undefined)?.currentNode;
    if (isNumber(bitNode)) this.#bitNodes.push({ atMs, bitNode });
    const money = hackingMoneyOf(data);
    if (money === null) return;
    const point = { atMs, ...money };
    const previous = this.#money.at(-1);
    if (previous && (installedBetween(previous, point) || point.hacking < previous.hacking)) {
      this.#breaks.push({ fromMs: previous.atMs, toMs: atMs });
    }
    this.#money.push(point);
  }

  addMedium(atMs: number, data: MediumSnapshotData): void {
    const staticThen = this.#statics.filter((each) => each.atMs <= atMs).at(-1) ?? this.#statics[0];
    const incomes = new Map<string, number>();
    // The BitNode then (#321): the newest slow snapshot's by then, else the first's (the slow snapshots come first).
    const bitNodeThen = (this.#bitNodes.filter((each) => each.atMs <= atMs).at(-1) ?? this.#bitNodes[0])?.bitNode;
    const ceiling = hackingCeiling(staticThen?.data, data, bitNodeThen ?? null, incomes);
    this.#ceilings.push({ atMs, ceiling });
    const hacking = (data.player as { skills?: { hacking?: unknown } } | undefined)?.skills?.hacking;
    this.targetIncomes.add(atMs, ceiling.known ? incomes : null, isNumber(hacking) ? hacking : null);
    // A snapshot between the slow ones around a break may be either side of it: left out.
    if (this.#breaks.some((each) => each.fromMs < atMs && atMs <= each.toMs)) return;
    const stretch = this.#breaks.filter((each) => each.toMs < atMs).length;
    const serversMoney = new Map(
      (Array.isArray(data.servers) ? data.servers : [])
        .filter((server) => typeof server?.hostname === "string" && isNumber(server.moneyAvailable))
        .map((server) => [server.hostname, server.moneyAvailable as number]),
    );
    const known = this.#serversMoney.get(stretch);
    if (known) known.last = serversMoney;
    else this.#serversMoney.set(stretch, { first: serversMoney, last: serversMoney });
  }

  /** The ceilings at the last medium snapshot. */
  get latestCeiling(): HackingCeiling | null {
    return this.#ceilings.at(-1)?.ceiling ?? null;
  }

  /**
   * How much the game's servers' money fell, server by server, from the first medium snapshot to the last between each
   * relaunch or install: money they held at the start that hacking took and nothing grew back, so no RAM paid for it.
   * Security left above where it started is the same kind of debt, not allowed for: a known slack.
   */
  serversMoneyFell(): number {
    let fell = 0;
    for (const { first, last } of this.#serversMoney.values()) {
      for (const [hostname, before] of first) {
        const after = last.get(hostname);
        if (!this.#ignored.has(hostname) && after !== undefined && before > after) fell += before - after;
      }
    }
    return fell;
  }

  /**
   * Each interval between slow snapshots with the money sources where the ceilings were known throughout: what hacking
   * earned in it, and each ceiling's $ over it, stepping at each medium snapshot (before the first, the first's).
   */
  judgedIntervals(): (Rates & { fromMs: number; toMs: number; earned: number })[] {
    const ceilings = this.#ceilings;
    const intervals: (Rates & { fromMs: number; toMs: number; earned: number })[] = [];
    // The first medium snapshot after the interval's start.
    let after = 0;
    for (let index = 1; index < this.#money.length; index++) {
      const from = this.#money[index - 1] as HackingMoneyPoint;
      const to = this.#money[index] as HackingMoneyPoint;
      while (after < ceilings.length && (ceilings[after] as { atMs: number }).atMs <= from.atMs) after++;
      let inForce = ceilings[after - 1] ?? ceilings[0];
      if (inForce === undefined) continue;
      const dollars: Rates = { batcher: 0, ceiling: 0, bound: 0 };
      let known = true;
      let atMs = from.atMs;
      for (let change = after; ; change++) {
        const next = ceilings[change];
        const untilMs = next !== undefined && next.atMs < to.atMs ? next.atMs : to.atMs;
        const { ceiling } = inForce;
        const seconds = (untilMs - atMs) / 1000;
        if (ceiling.known) {
          dollars.batcher += ceiling.batcherIncomePerSecond * seconds;
          dollars.ceiling += ceiling.incomePerSecond * seconds;
          dollars.bound += ceiling.boundIncomePerSecond * seconds;
        } else known = false;
        if (next === undefined || untilMs === to.atMs) break;
        [atMs, inForce] = [untilMs, next];
      }
      if (known)
        intervals.push({ fromMs: from.atMs, toMs: to.atMs, earned: hackingEarnedBetween(from, to), ...dollars });
    }
    return intervals;
  }

  /** The window's intervals added up, each `HACKING_STRETCH_MS` of it from the first, and the best 10 minutes. */
  totals(): {
    whole: HackingAgainstCeiling | null;
    stretches: HackingAgainstCeiling[];
    best: HackingAgainstCeiling | null;
  } {
    const intervals = this.judgedIntervals();
    const first = intervals[0];
    if (first === undefined) return { whole: null, stretches: [], best: null };
    const sum = (parts: typeof intervals): HackingAgainstCeiling => ({
      fromMs: (parts[0] as (typeof parts)[number]).fromMs,
      toMs: (parts.at(-1) as (typeof parts)[number]).toMs,
      judgedMs: parts.reduce((total, part) => total + part.toMs - part.fromMs, 0),
      earned: parts.reduce((total, part) => total + part.earned, 0),
      batcher: parts.reduce((total, part) => total + part.batcher, 0),
      ceiling: parts.reduce((total, part) => total + part.ceiling, 0),
      bound: parts.reduce((total, part) => total + part.bound, 0),
    });
    const byStretch: (typeof intervals)[] = [];
    for (const interval of intervals) {
      const stretch = Math.floor((interval.fromMs - first.fromMs) / HACKING_STRETCH_MS);
      byStretch[stretch] = [...(byStretch[stretch] ?? []), interval];
    }
    // The best run of intervals judging at least 10 minutes, by its part of the batcher ceiling: from each start, the
    // shortest run that's long enough.
    let best: HackingAgainstCeiling | null = null;
    for (let start = 0; start < intervals.length; start++) {
      let judgedMs = 0;
      for (let end = start; end < intervals.length; end++) {
        const interval = intervals[end] as (typeof intervals)[number];
        judgedMs += interval.toMs - interval.fromMs;
        if (judgedMs < HACKING_BEST_STRETCH_MS) continue;
        const run = sum(intervals.slice(start, end + 1));
        // A better one by more than rounding: of runs alike, the first.
        if (
          run.batcher > 0 &&
          (best === null || run.earned / run.batcher > (best.earned / best.batcher) * (1 + 1e-9))
        ) {
          best = run;
        }
        break;
      }
    }
    return { whole: sum(intervals), stretches: byStretch.filter((each) => each !== undefined).map(sum), best };
  }

  /**
   * Section 5's lines; a line in `failures` for hacking that earned more than all the rooted RAM could. `heldBack`, a
   * line under each hour's, or the window's with an hour or less (#245): what held the cycle back then, so a low
   * share of the ceiling while money wasn't what it waited on (reputation, say, with money unspent) doesn't read as a
   * failure.
   */
  section(failures: string[], heldBack?: (fromMs: number, toMs: number) => string): string[] {
    const lines = [
      "5. Hacking (actual: the slow snapshots' money sources; the ceilings: the most a batcher, and any hacker, could " +
        "earn with the hack loop's hosts' RAM at the hacking level then, from the game's formulas)",
    ];
    lines.push(`  the ceilings now: ${describeCeiling(this.latestCeiling)}`);
    if (this.#money.length < 2) {
      lines.push(
        this.#slowCount > this.#money.length
          ? "  actual: unknown: the slow snapshots carry no money sources (an Agent from before #196)"
          : "  actual: unknown: fewer than two slow snapshots in the window",
      );
      return lines;
    }
    const { whole, stretches, best } = this.totals();
    if (whole === null) {
      lines.push("  against the ceilings: not judged, the ceilings were unknown throughout");
      return lines;
    }
    lines.push(
      best === null
        ? "  the best 10 minutes: none yet (under 10 minutes judged)"
        : `  the best 10 minutes: ${percentOf(best.earned, best.batcher)} of the batcher ceiling ` +
            `(${perSecondOver(best.earned, best.judgedMs)} against ${perSecondOver(best.batcher, best.judgedMs)}), ` +
            `from ${formatIsoTime(best.fromMs)} to ${formatIsoTime(best.toMs)}`,
    );
    lines.push(`  over the window: ${describeAgainst(whole)}`);
    const unjudgedMs = (this.#money.at(-1)?.atMs ?? 0) - (this.#money[0]?.atMs ?? 0) - whole.judgedMs;
    if (unjudgedMs > 0) lines.push(`    not judged: ${hoursOf(unjudgedMs)} with the ceilings unknown`);
    // Under an hour, or one, the window is the hour (#245 review): its line under the window's.
    if (stretches.length <= 1 && heldBack !== undefined) lines.push(`    ${heldBack(whole.fromMs, whole.toMs)}`);
    if (stretches.length > 1) {
      lines.push("  each hour:");
      for (const stretch of stretches) {
        lines.push(`    ${describeAgainst(stretch)}`);
        if (heldBack !== undefined) lines.push(`      ${heldBack(stretch.fromMs, stretch.toMs)}`);
      }
    }
    const allowance = this.serversMoneyFell();
    if (whole.earned > whole.bound + allowance) {
      const line =
        `hacking income above what all the rooted RAM could earn: ${formatDollars(whole.earned)} earned from ` +
        `${formatIsoTime(whole.fromMs)} to ${formatIsoTime(whole.toMs)}, against at most ` +
        `${formatDollars(whole.bound + allowance)} (the hacking ceiling on every rooted server's RAM, ` +
        `${formatDollars(whole.bound)}, and the ${formatDollars(allowance)} the game's servers' money fell by): the ` +
        "ceiling's formula or the measure is wrong";
      lines.push(`  ${line}`);
      failures.push(line);
    }
    return lines;
  }
}

const formatDollars = (money: number) => `$${Math.round(money).toLocaleString("en-US")}`;
const formatPerSecond = (perSecond: number) => `${formatDollars(perSecond)}/s`;
const hoursOf = (durationMs: number) => `${(durationMs / 3_600_000).toFixed(1)} h`;
/** "12.3%", or "n/a" with nothing to take a part of. */
const percentOf = (part: number, whole: number) => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "n/a");
/** $ a second over a judged time, or "n/a" with none judged. */
const perSecondOver = (dollars: number, judgedMs: number) =>
  judgedMs > 0 ? formatPerSecond((dollars / judgedMs) * 1000) : "n/a";

/** "$1,234/s: 21.7% of the batcher ceiling ($5,678/s), 15.2% of the ceiling ($8,100/s), from … to … (1.5 h)" */
function describeAgainst(stretch: HackingAgainstCeiling): string {
  const over = (dollars: number) => perSecondOver(dollars, stretch.judgedMs);
  return (
    `${over(stretch.earned)}: ${percentOf(stretch.earned, stretch.batcher)} of the batcher ceiling ` +
    `(${over(stretch.batcher)}), ${percentOf(stretch.earned, stretch.ceiling)} of the ceiling ` +
    `(${over(stretch.ceiling)}), from ${formatIsoTime(stretch.fromMs)} to ${formatIsoTime(stretch.toMs)} ` +
    `(${hoursOf(stretch.judgedMs)})`
  );
}

/**
 * "$4,321/s for a batcher on phantasy ($5,678/s for any hacker), with 520 GB on 40 servers; on all 552 GB rooted
 * (42 servers), $6,012/s", or why it's unknown.
 */
export function describeCeiling(ceiling: HackingCeiling | null): string {
  if (ceiling === null) return "unknown: no medium snapshot";
  if (!ceiling.known) return `unknown: ${ceiling.reason}`;
  const gigabytes = (ram: number) => `${Math.round(ram * 100) / 100} GB`;
  const servers = (count: number) => `${count} ${count === 1 ? "server" : "servers"}`;
  const hosts = `${gigabytes(ceiling.hostRamGb)} on ${servers(ceiling.hostCount)}`;
  return ceiling.target === null
    ? `$0/s: nothing the player can hack is rooted (${hosts})`
    : `${formatPerSecond(ceiling.batcherIncomePerSecond)} for a batcher on ${ceiling.target} ` +
        `(${formatPerSecond(ceiling.incomePerSecond)} for any hacker), with ${hosts}; on all ` +
        `${gigabytes(ceiling.rootedRamGb)} rooted (${servers(ceiling.rootedCount)}), ` +
        formatPerSecond(ceiling.boundIncomePerSecond);
}
