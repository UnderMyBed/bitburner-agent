// The hacking ceiling (#196, M4 phase A slice A1): the most hacking income a second the hack loop's hosts' RAM could
// earn at the player's hacking then (core's `hackingIncomePerGigabyteSecond`, from the game's formulas), and what
// hacking actually earned (the slow snapshot's `moneySources.hacking`), from the snapshots alone: the dashboard's rows
// and the run report's section 5. An upper bound, not a plan: the batcher (A7) is scored against it.
import {
  type HackingPlayer,
  type HackingTarget,
  hackingIncomePerGigabyteSecond,
  type MediumSnapshotData,
  type SlowSnapshotData,
  type StaticSnapshotData,
} from "@bitburner-agent/core";
import { formatIsoTime } from "./gap-report.ts";
import { chooseHackHosts } from "./hack-loop.ts";
import type { Environment, TelemetryStore } from "./telemetry-store.ts";

/** The ceiling at one snapshot, or why it can't be said. */
export type HackingCeiling =
  | {
      known: true;
      /** $ a second: the hosts' RAM times the best target's income a GB-second. */
      incomePerSecond: number;
      /** The target it's earned on; null with nothing the player can hack yet. */
      target: string | null;
      /** The hack loop's hosts, and their RAM in all. */
      hostCount: number;
      hostRamGb: number;
    }
  | { known: false; reason: string };

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** The player's skills and multipliers the formulas read, or the first missing (the snapshot is the Agent's word). */
function hackingPlayerOf(player: unknown): HackingPlayer | string {
  const { skills, mults } = (player ?? {}) as { skills?: Record<string, unknown>; mults?: Record<string, unknown> };
  for (const skill of ["hacking", "intelligence"]) {
    if (!isNumber(skills?.[skill])) return `the medium snapshot's player has no skills.${skill}`;
  }
  for (const mult of ["hacking_chance", "hacking_speed", "hacking_money", "hacking_grow"]) {
    if (!isNumber(mults?.[mult])) return `the medium snapshot's player has no mults.${mult}`;
  }
  return { skills, mults } as unknown as HackingPlayer;
}

/**
 * The ceiling now (#196): the hack loop's hosts (`chooseHackHosts`; A2, #194, makes them `hackLoopHosts`), their
 * `maxRam` in the medium snapshot added up, times the best income a GB-second among the targets: the game's servers
 * rooted, with money, needing at most the player's hacking (core's `hackingIncomePerGigabyteSecond`, with the hosts'
 * best cores). Unknown without both snapshots or the player's skills and multipliers.
 */
export function hackingCeiling(
  staticData: StaticSnapshotData | null | undefined,
  mediumData: MediumSnapshotData | null | undefined,
): HackingCeiling {
  if (!Array.isArray(staticData?.servers)) return { known: false, reason: "no static snapshot" };
  if (!Array.isArray(mediumData?.servers)) return { known: false, reason: "no medium snapshot" };
  const player = hackingPlayerOf(mediumData.player);
  if (typeof player === "string") return { known: false, reason: player };
  const now = new Map(
    mediumData.servers
      .filter((server) => typeof server?.hostname === "string")
      .map((server) => [server.hostname, server]),
  );
  const hosts = chooseHackHosts(staticData, mediumData);
  let hostRamGb = 0;
  let cores = 1;
  for (const host of hosts) {
    const server = now.get(host);
    if (isNumber(server?.maxRam)) hostRamGb += server.maxRam;
    if (isNumber(server?.cpuCores)) cores = Math.max(cores, server.cpuCores);
  }
  let best: { target: string; perGigabyteSecond: number } | null = null;
  for (const server of staticData.servers) {
    const { hostname, moneyMax, minDifficulty, requiredHackingSkill, serverGrowth } = server ?? {};
    // The game's own: home is purchased too (PlayerObjectGeneralMethods.ts:72).
    if (
      typeof hostname !== "string" ||
      server.purchasedByPlayer !== false ||
      now.get(hostname)?.hasAdminRights !== true ||
      !isNumber(moneyMax) ||
      !isNumber(minDifficulty) ||
      !isNumber(requiredHackingSkill) ||
      !isNumber(serverGrowth)
    ) {
      continue;
    }
    // One needing more hacking than the player has earns 0: a hack thread's share is 0 there (Hacking.ts:52).
    const target: HackingTarget = { moneyMax, minDifficulty, requiredHackingSkill, serverGrowth };
    const perGigabyteSecond = hackingIncomePerGigabyteSecond(target, player, cores);
    if (perGigabyteSecond > 0 && (best === null || perGigabyteSecond > best.perGigabyteSecond)) {
      best = { target: hostname, perGigabyteSecond };
    }
  }
  return {
    known: true,
    incomePerSecond: best === null ? 0 : hostRamGb * best.perGigabyteSecond,
    target: best?.target ?? null,
    hostCount: hosts.length,
    hostRamGb,
  };
}

/** Hacking's money since the install, at one slow snapshot. */
export interface HackingMoneyPoint {
  atMs: number;
  hacking: number;
}

/** The slow snapshot's `moneySources.hacking`, or null where it has none (an Agent from before #196). */
export function hackingMoneyOf(data: SlowSnapshotData | null | undefined): number | null {
  const hacking = data?.moneySources?.hacking;
  return isNumber(hacking) ? hacking : null;
}

/**
 * What hacking earned from one point to the next: the rise, or after a fall (an install resets the count,
 * PlayerObjectGeneralMethods.ts:128) the count since.
 */
export function hackingEarnedBetween(from: HackingMoneyPoint, to: HackingMoneyPoint): number {
  return to.hacking >= from.hacking ? to.hacking - from.hacking : to.hacking;
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

/** What the dashboard shows of hacking (#196). */
export interface HackingView {
  /** The ceiling at the newest static and medium snapshots. */
  ceiling: HackingCeiling;
  /** What hacking earned a second over the last `DASHBOARD_HACKING_WINDOW_MS` of slow snapshots, or null. */
  incomePerSecond: number | null;
}

/** The dashboard's hacking rows, from the store's newest snapshots and its last 10 minutes of slow ones. */
export function hackingView({
  store,
  environment,
  nowMs,
  staticData,
  mediumData,
}: {
  store: TelemetryStore;
  environment: Environment;
  nowMs: number;
  staticData: StaticSnapshotData | null | undefined;
  mediumData: MediumSnapshotData | null | undefined;
}): HackingView {
  const points: HackingMoneyPoint[] = [];
  const window = { environment, tier: "slow", sinceMs: nowMs - DASHBOARD_HACKING_WINDOW_MS, untilMs: nowMs };
  for (const { receivedAtMs, data } of store.iterateSnapshotsInWindow(window)) {
    const hacking = hackingMoneyOf(data as SlowSnapshotData);
    if (hacking !== null) points.push({ atMs: receivedAtMs, hacking });
  }
  return { ceiling: hackingCeiling(staticData, mediumData), incomePerSecond: hackingIncomePerSecond(points) };
}

// --- The run report's section ---------------------------------------------------------------------------------------

/** The stretches the report adds up separately. */
export const HACKING_STRETCH_MS = 60 * 60_000;

/** One stretch between slow snapshots, judged: what hacking earned, and the ceiling's $ over it. */
interface JudgedInterval {
  fromMs: number;
  toMs: number;
  earned: number;
  ceiling: number;
}

/** What hacking earned against the ceiling's $ over a stretch, and their times. */
export interface HackingAgainstCeiling {
  fromMs: number;
  toMs: number;
  /** The time in it judged: between slow snapshots with the money sources, where the ceiling was known throughout. */
  judgedMs: number;
  earned: number;
  ceiling: number;
}

/**
 * The run report's fold (#196): fed each tier's snapshots in time order, static first (the report reads them so),
 * since each medium snapshot's ceiling uses the static snapshot then (the latest before it, else the first).
 */
export class HackingFold {
  readonly #statics: { atMs: number; data: StaticSnapshotData }[] = [];
  readonly #ceilings: { atMs: number; ceiling: HackingCeiling }[] = [];
  readonly #money: HackingMoneyPoint[] = [];
  #slowCount = 0;
  #firstServersMoney: Map<string, number> | null = null;
  #lastServersMoney: Map<string, number> | null = null;
  readonly #ignored: ReadonlySet<string>;

  /** `ignored`: the player's own servers, whose money isn't hacked. */
  constructor(ignored: ReadonlySet<string>) {
    this.#ignored = ignored;
  }

  addStatic(atMs: number, data: StaticSnapshotData): void {
    this.#statics.push({ atMs, data });
  }

  addSlow(atMs: number, data: SlowSnapshotData): void {
    this.#slowCount++;
    const hacking = hackingMoneyOf(data);
    if (hacking !== null) this.#money.push({ atMs, hacking });
  }

  addMedium(atMs: number, data: MediumSnapshotData): void {
    const staticThen = this.#statics.filter((each) => each.atMs <= atMs).at(-1) ?? this.#statics[0];
    this.#ceilings.push({ atMs, ceiling: hackingCeiling(staticThen?.data, data) });
    const serversMoney = new Map(
      (Array.isArray(data.servers) ? data.servers : [])
        .filter((server) => typeof server?.hostname === "string" && isNumber(server.moneyAvailable))
        .map((server) => [server.hostname, server.moneyAvailable as number]),
    );
    this.#firstServersMoney ??= serversMoney;
    this.#lastServersMoney = serversMoney;
  }

  /** The ceiling at the last medium snapshot. */
  get latestCeiling(): HackingCeiling | null {
    return this.#ceilings.at(-1)?.ceiling ?? null;
  }

  /**
   * How much the game's servers' money fell from the first medium snapshot to the last, server by server: money they
   * held at the start that hacking took and nothing grew back, so no RAM paid for it in the window.
   */
  serversMoneyFell(): number {
    let fell = 0;
    for (const [hostname, first] of this.#firstServersMoney ?? []) {
      const last = this.#lastServersMoney?.get(hostname);
      if (!this.#ignored.has(hostname) && last !== undefined && first > last) fell += first - last;
    }
    return fell;
  }

  /**
   * Each interval between slow snapshots with the money sources where the ceiling was known throughout: what hacking
   * earned in it, and the ceiling's $ over it, the ceiling stepping at each medium snapshot (before the first, the
   * first's).
   */
  judgedIntervals(): JudgedInterval[] {
    const ceilings = this.#ceilings;
    const intervals: JudgedInterval[] = [];
    // The first medium snapshot after the interval's start.
    let after = 0;
    for (let index = 1; index < this.#money.length; index++) {
      const from = this.#money[index - 1] as HackingMoneyPoint;
      const to = this.#money[index] as HackingMoneyPoint;
      while (after < ceilings.length && (ceilings[after] as { atMs: number }).atMs <= from.atMs) after++;
      let inForce = ceilings[after - 1] ?? ceilings[0];
      if (inForce === undefined) continue;
      let ceiling = 0;
      let known = true;
      let atMs = from.atMs;
      for (let change = after; ; change++) {
        const next = ceilings[change];
        const untilMs = next !== undefined && next.atMs < to.atMs ? next.atMs : to.atMs;
        if (inForce.ceiling.known) ceiling += (inForce.ceiling.incomePerSecond * (untilMs - atMs)) / 1000;
        else known = false;
        if (next === undefined || untilMs === to.atMs) break;
        [atMs, inForce] = [untilMs, next];
      }
      if (known) intervals.push({ fromMs: from.atMs, toMs: to.atMs, earned: hackingEarnedBetween(from, to), ceiling });
    }
    return intervals;
  }

  /** The window's intervals added up, and each `HACKING_STRETCH_MS` of it from the first. */
  totals(): { whole: HackingAgainstCeiling | null; stretches: HackingAgainstCeiling[] } {
    const intervals = this.judgedIntervals();
    const first = intervals[0];
    if (first === undefined) return { whole: null, stretches: [] };
    const add = (sum: HackingAgainstCeiling | undefined, interval: JudgedInterval): HackingAgainstCeiling => ({
      fromMs: sum?.fromMs ?? interval.fromMs,
      toMs: interval.toMs,
      judgedMs: (sum?.judgedMs ?? 0) + interval.toMs - interval.fromMs,
      earned: (sum?.earned ?? 0) + interval.earned,
      ceiling: (sum?.ceiling ?? 0) + interval.ceiling,
    });
    let whole: HackingAgainstCeiling | undefined;
    const stretches: HackingAgainstCeiling[] = [];
    for (const interval of intervals) {
      whole = add(whole, interval);
      const stretch = Math.floor((interval.fromMs - first.fromMs) / HACKING_STRETCH_MS);
      stretches[stretch] = add(stretches[stretch], interval);
    }
    return { whole: whole ?? null, stretches: stretches.filter((each) => each !== undefined) };
  }

  /** Section 5's lines; a line in `failures` for hacking that earned more than the ceiling allows. */
  section(failures: string[]): string[] {
    const lines = [
      "5. Hacking (actual: the slow snapshots' money sources; the ceiling: the most the hack loop's hosts' RAM could " +
        "earn at the hacking level then, from the game's formulas)",
    ];
    const latest = this.latestCeiling;
    lines.push(`  the ceiling now: ${describeCeiling(latest)}`);
    if (this.#money.length < 2) {
      lines.push(
        this.#slowCount > this.#money.length
          ? "  actual: unknown: the slow snapshots carry no money sources (an Agent from before #196)"
          : "  actual: unknown: fewer than two slow snapshots in the window",
      );
      return lines;
    }
    const { whole, stretches } = this.totals();
    if (whole === null) {
      lines.push("  against the ceiling: not judged, the ceiling was unknown throughout");
      return lines;
    }
    lines.push(`  ${describeAgainst(whole)}`);
    const unjudgedMs = (this.#money.at(-1)?.atMs ?? 0) - (this.#money[0]?.atMs ?? 0) - whole.judgedMs;
    if (unjudgedMs > 0) lines.push(`    not judged: ${hoursOf(unjudgedMs)} with the ceiling unknown`);
    if (stretches.length > 1) {
      lines.push("  each hour:");
      for (const stretch of stretches) lines.push(`    ${describeAgainst(stretch)}`);
    }
    const allowance = this.serversMoneyFell();
    if (whole.earned > whole.ceiling + allowance) {
      const line =
        `hacking income above the ceiling: ${formatDollars(whole.earned)} earned from ` +
        `${formatIsoTime(whole.fromMs)} to ${formatIsoTime(whole.toMs)}, against at most ` +
        `${formatDollars(whole.ceiling + allowance)} (the ceiling's ${formatDollars(whole.ceiling)} and the ` +
        `${formatDollars(allowance)} the game's servers' money fell by): the ceiling's formula or the measure is wrong`;
      lines.push(`  ${line}`);
      failures.push(line);
    }
    return lines;
  }
}

const formatDollars = (money: number) => `$${Math.round(money).toLocaleString("en-US")}`;
const formatPerSecond = (perSecond: number) => `${formatDollars(perSecond)}/s`;
const hoursOf = (durationMs: number) => `${(durationMs / 3_600_000).toFixed(1)} h`;

/** "$1,234/s against a ceiling of $5,678/s: 21.7%, from … to …" */
function describeAgainst(stretch: HackingAgainstCeiling): string {
  const seconds = stretch.judgedMs / 1000;
  const percent = stretch.ceiling > 0 ? `${((stretch.earned / stretch.ceiling) * 100).toFixed(1)}%` : "n/a";
  return (
    `${formatPerSecond(stretch.earned / seconds)} against a ceiling of ${formatPerSecond(stretch.ceiling / seconds)}: ` +
    `${percent}, from ${formatIsoTime(stretch.fromMs)} to ${formatIsoTime(stretch.toMs)} (${hoursOf(stretch.judgedMs)})`
  );
}

/** "$5,678/s on max-hardware, with 520 GB on 40 servers", or why it's unknown. */
export function describeCeiling(ceiling: HackingCeiling | null): string {
  if (ceiling === null) return "unknown: no medium snapshot";
  if (!ceiling.known) return `unknown: ${ceiling.reason}`;
  const servers = ceiling.hostCount === 1 ? "server" : "servers";
  const hosts = `${Math.round(ceiling.hostRamGb * 100) / 100} GB on ${ceiling.hostCount} ${servers}`;
  return ceiling.target === null
    ? `$0/s: nothing the player can hack is rooted (${hosts})`
    : `${formatPerSecond(ceiling.incomePerSecond)} on ${ceiling.target}, with ${hosts}`;
}
