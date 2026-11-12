// The time to the destroy against the outcome (#360, decision 67's point 5: the measure is the estimate against the
// outcome). The campaign report's section: a row per estimate, the brain's own (`destroyEstimated`, ./destroy-
// estimate.ts) and, before the brain made them, hindcast from the store's campaign fold with the same function, at each
// start and install and at Daedalus joined (its first `factionWorkChosen` for The Red Pill, with that choice's ETA as
// it was then), reading nothing after its moment; each against its BitNode's time online at the destroy, the ratio the
// estimated over the actual remaining. Then each BitNode's median and worst, and the ratios by moment over the
// campaign: Q9's (#39) measure. The run report's check: a term that's never fails it at once (a warning with the World
// Daemon's switch off). Every other estimate is reported, not judged: its ratio is the measure. No bar on the whole
// estimate against the time online so far (#360 amended): a short history (harness-made, a save loaded) or the prior's
// B + C (4.21× at BN1.4's count met) would break it. #336's bar stays on levelling's own estimate, D's.
// BN2's gang route (#357's slice 3) isn't hindcast: the store keeps no τ_g or (3)'s estimates from before #357, and
// BN2.1 is the campaign's first BN2, so its rows are the brain's own from its start.
import { DAEDALUS, destroyEstimate, destroyRouteOf, THE_RED_PILL } from "@bitburner-agent/core";
import { fieldsOf, isFiniteNumber } from "./augmentation-report.ts";
import { AUGMENTATION_SLOW_GAP_MS } from "./augmentations.ts";
import {
  type BitNodeView,
  CAMPAIGN_EVENT_KINDS,
  CampaignFold,
  campaignViews,
  destroyPriorOf,
  destroyStretchesOf,
} from "./campaign-model.ts";
import {
  DESTROY_ESTIMATED_EVENT_KIND,
  type DestroyEstimateRecord,
  type DestroyMoment,
  type DestroyStage,
  describeDestroyEstimate,
  destroyEstimateRecord,
  destroyStageOf,
  parseDestroyEstimate,
} from "./destroy-estimate.ts";
import { FACTION_WORK_CHOSEN_EVENT_KIND } from "./factions.ts";
import { formatDuration } from "./gap-report.ts";
import { LEVELLING_CHOSEN_EVENT_KIND } from "./levelling.ts";
import type { SlowResetInfo, StoredEvent } from "./telemetry-store.ts";

/**
 * The events the section reads beside the campaign's: the brain's estimates, A5's choices (the joins), and levelling's
 * choices (a prior's D from before levelling, #336, is cautious).
 */
export const DESTROY_ESTIMATE_REPORT_EVENT_KINDS = [
  ...CAMPAIGN_EVENT_KINDS,
  DESTROY_ESTIMATED_EVENT_KIND,
  FACTION_WORK_CHOSEN_EVENT_KIND,
  LEVELLING_CHOSEN_EVENT_KIND,
];

/**
 * A row whose actual remaining is under this isn't measured (left out of the summaries): the steps are a slow snapshot
 * a minute, so every time is ±1 min, over ±10% of what's left below 10 minutes (BN1.4's Red Pill row: 4 min against 1).
 */
export const SHORT_REMAINING_MS = 10 * 60_000;

/** The levelling choices' times among `events`: a prior with none before its destroy has its D from before #336. */
const levellingTimesOf = (events: readonly StoredEvent[]) =>
  events.filter((event) => event.kind === LEVELLING_CHOSEN_EVENT_KIND).map((event) => event.atMs);

/** The campaign's own events (`CAMPAIGN_EVENT_KINDS`): what its views read, so the section's others change none. */
const isCampaignEvent = (event: StoredEvent) => CAMPAIGN_EVENT_KINDS.includes(event.kind);

/** An estimate as the section shows it: the brain's own, or hindcast; when it was made (the brain's clock). */
export interface EstimateRow {
  record: DestroyEstimateRecord;
  atMs: number;
  hindcast: boolean;
}

/** A row against its outcome: the BitNode's time online at its destroy, or null not destroyed (so far). */
export interface JudgedRow extends EstimateRow {
  /** The campaign's name of its BitNode ("BN1.4 #2"), or the record's label where the fold has none. */
  name: string;
  actualTotalMs: number | null;
  actualRemainingMs: number | null;
  /** Estimated over actual remaining; null not destroyed, or never. */
  ratio: number | null;
}

/** A5's choice for The Red Pill at Daedalus: the join, as the hindcast reads it, and the hold's ETA then. */
function daedalusHoldOf(event: StoredEvent): { etaMs: number | null } | null {
  if (event.kind !== FACTION_WORK_CHOSEN_EVENT_KIND) return null;
  const fields = fieldsOf(event.detail);
  if (fields.faction !== DAEDALUS || fields.augmentation !== THE_RED_PILL) return null;
  return { etaMs: isFiniteNumber(fields.etaSeconds) ? fields.etaSeconds * 1000 : null };
}

/**
 * The hindcast (#360): the campaign fold run over the slow snapshots in order of arrival, an estimate made at each
 * moment from the fold and the events as they stood then: a BitNode's start (its first slow snapshot, its start
 * seen), each install (a cycle's first), and Daedalus joined (A5's first choice for The Red Pill there, before the
 * next slow snapshot). Only before `untilMs` (the brain's first estimate: from then on, its own), and only for a BitNode
 * whose start the store saw (its time online is the clock's from there).
 */
export class DestroyHindcast {
  readonly fold = new CampaignFold();
  readonly rows: EstimateRow[] = [];
  readonly #events: readonly StoredEvent[];
  readonly #untilMs: number;
  /** The store's first record: an event's, or the first slow snapshot's. */
  #firstMs: number;
  /** The events up to the moment: these first. */
  #seen = 0;
  /** By BitNode (`lastNodeReset`): the cycle Daedalus was first joined in, and the hold's ETA then. */
  readonly #joined = new Map<number, { cycle: number; etaMs: number | null }>();

  /** `events`: the campaign's, and A5's choices, in the order stored. */
  constructor(events: readonly StoredEvent[], untilMs = Number.POSITIVE_INFINITY) {
    this.#events = [...events].sort((a, b) => a.atMs - b.atMs);
    this.#untilMs = untilMs;
    this.#firstMs = this.#events.find(isCampaignEvent)?.atMs ?? Number.POSITIVE_INFINITY;
  }

  add(snapshot: SlowResetInfo): void {
    this.#firstMs = Math.min(this.#firstMs, snapshot.receivedAtMs);
    // The joins before this slow snapshot, on the fold as the last left it.
    while (this.#seen < this.#events.length && (this.#events[this.#seen] as StoredEvent).atMs < snapshot.receivedAtMs) {
      const event = this.#events[this.#seen] as StoredEvent;
      this.#seen += 1;
      const hold = daedalusHoldOf(event);
      const bitNode = this.fold.bitNodes.at(-1);
      const cycle = bitNode?.currentCycle;
      if (hold === null || bitNode === undefined || cycle === null || cycle === undefined) continue;
      if (this.#joined.has(bitNode.lastNodeReset) || cycle.redPill) continue;
      this.#joined.set(bitNode.lastNodeReset, { cycle: cycle.lastAugReset, etaMs: hold.etaMs });
      this.#estimate("joined", event.atMs, null);
    }
    const before = this.fold.bitNodes.at(-1);
    const cyclesBefore = before?.cycleList.length ?? 0;
    this.fold.add(snapshot);
    const bitNode = this.fold.bitNodes.at(-1);
    if (bitNode === undefined) return;
    const cycle = bitNode.cycleList.at(-1);
    if (bitNode !== before && cycle?.kind === "start") this.#estimate("start", snapshot.receivedAtMs, snapshot);
    else if (bitNode === before && bitNode.cycleList.length > cyclesBefore && cycle?.kind === "install") {
      this.#estimate("install", snapshot.receivedAtMs, snapshot);
    }
  }

  /** The estimate at a moment, from the fold and the events seen: nothing after it. */
  #estimate(moment: DestroyMoment, atMs: number, snapshot: SlowResetInfo | null): void {
    const bitNode = this.fold.bitNodes.at(-1);
    const cycle = bitNode?.currentCycle;
    if (atMs >= this.#untilMs || bitNode === undefined || cycle === null || cycle === undefined) return;
    // Daedalus's route alone: BN2's gang (#357) has no stored figures to hindcast from.
    if (destroyRouteOf(bitNode.currentNode) !== "daedalus" || bitNode.ownedAugs === null) return;
    const views = campaignViews(this.fold, this.#events.slice(0, this.#seen).filter(isCampaignEvent))?.views ?? [];
    const index = views.length - 1;
    const view = views[index] as BitNodeView;
    // Its time online is the clock's from its start: none for a BitNode whose start the store didn't see.
    if (!view.startSeen || bitNode.installedBeforeFirstLook || bitNode.startMs < this.#firstMs) return;
    const prior = destroyPriorOf(views, index, levellingTimesOf(this.#events.slice(0, this.#seen)));
    const { countMetOnlineMs } = destroyStretchesOf(view);
    const count = Object.keys(bitNode.ownedAugs).length;
    const redPillInstalled = Object.hasOwn(bitNode.ownedAugs, THE_RED_PILL);
    const joined = this.#joined.get(bitNode.lastNodeReset);
    const daedalus =
      joined === undefined ? "not joined" : joined.cycle === cycle.lastAugReset ? "joined" : "donations installed";
    const ownedSF = bitNode.lastOwnedSF;
    const onlineMs = bitNode.clock.onlineMs;
    const estimate = destroyEstimate({
      currentNode: bitNode.currentNode,
      ownedSF,
      onlineMs,
      count,
      redPillInstalled,
      countMetOnlineMs,
      daedalus,
      holdEtaMs: daedalus === "joined" ? (joined?.etaMs ?? null) : null,
      levellingMs: null,
      prior,
    });
    const record = destroyEstimateRecord(estimate, {
      moment,
      stage: destroyStageOf(moment, { redPillInstalled, daedalus, countMet: countMetOnlineMs !== null }),
      late: snapshot !== null && snapshot.gameTimeMs - cycle.lastAugReset > AUGMENTATION_SLOW_GAP_MS,
      currentNode: bitNode.currentNode,
      ownedSF,
      lastNodeReset: bitNode.lastNodeReset,
      lastAugReset: cycle.lastAugReset,
      onlineMs,
      count,
      prior,
    });
    this.rows.push({ record, atMs, hindcast: true });
  }
}

/** The brain's own estimates among `events`, in order; those it can't read are counted. */
export function storedEstimates(events: readonly StoredEvent[]): { rows: EstimateRow[]; unread: number } {
  const rows: EstimateRow[] = [];
  let unread = 0;
  for (const event of events) {
    if (event.kind !== DESTROY_ESTIMATED_EVENT_KIND) continue;
    const record = parseDestroyEstimate(event.detail);
    if (record === null) unread += 1;
    else rows.push({ record, atMs: event.atMs, hindcast: false });
  }
  return { rows, unread };
}

/** Each row against its BitNode's outcome, from the whole campaign (`views`): matched by its `lastNodeReset`. */
export function judgeRows(rows: readonly EstimateRow[], views: readonly BitNodeView[]): JudgedRow[] {
  return rows.map((row) => {
    const view = views.findLast(
      (each) =>
        each.bitNode.lastNodeReset === row.record.lastNodeReset && each.bitNode.currentNode === row.record.currentNode,
    );
    const destroyed = view !== undefined && view.ending.destroyedAtMs !== null;
    const actualTotalMs = destroyed ? view.bitNode.clock.onlineMs : null;
    const actualRemainingMs = actualTotalMs === null ? null : Math.max(0, actualTotalMs - row.record.onlineMs);
    const { remainingMs } = row.record;
    return {
      ...row,
      name: view?.name ?? row.record.bitNode,
      actualTotalMs,
      actualRemainingMs,
      ratio:
        actualRemainingMs === null || remainingMs === null || actualRemainingMs <= 0
          ? null
          : remainingMs / actualRemainingMs,
    };
  });
}

/** The median of `values` (sorted here), or null with none. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/** The ratio furthest from 1 either way (by its factor: 0.25 is as far as 4). */
export function worstRatio(ratios: readonly number[]): number | null {
  let worst: number | null = null;
  for (const ratio of ratios) {
    if (worst === null || Math.abs(Math.log(ratio)) > Math.abs(Math.log(worst))) worst = ratio;
  }
  return worst;
}

/** The share of `ratios` within ×`factor` of 1 (1/factor to factor). */
export const withinFactor = (ratios: readonly number[], factor: number) =>
  ratios.filter((ratio) => ratio >= 1 / factor && ratio <= factor).length;

/**
 * Why a row isn't measured (left out of the summaries), or null: an estimate that's at least (a bound), an actual
 * remaining under `SHORT_REMAINING_MS` (the minute's steps too coarse), a first look (the hindcast has its install).
 */
export function unmeasuredReason(row: JudgedRow): "at least" | "under 10 min left" | "first seen" | null {
  if (row.record.stage === "first seen") return "first seen";
  if (row.ratio !== null && row.record.atLeast) return "at least";
  if (row.actualRemainingMs !== null && row.actualRemainingMs < SHORT_REMAINING_MS) return "under 10 min left";
  return null;
}

const describeRatio = (row: JudgedRow) =>
  row.record.never
    ? "never"
    : row.ratio === null
      ? row.actualTotalMs === null
        ? "open"
        : "-"
      : `${row.record.atLeast ? "≥ " : ""}${row.ratio.toFixed(2)}` +
        (unmeasuredReason(row) === "under 10 min left" ? " (under 10 min left)" : "");
const describeMs = (ms: number | null, atLeast = false) =>
  ms === null ? "-" : `${atLeast ? "≥ " : ""}${formatDuration(ms)}`;
const describeTermsShort = (record: DestroyEstimateRecord) =>
  record.terms
    .map((term) => `${term.term} ${term.never ? "never" : term.ms === null ? "none" : formatDuration(term.ms)}`)
    .join(", ");

/** The by-moment order of the summary. */
const STAGES: readonly DestroyStage[] = [
  "start",
  "install",
  "count met",
  "joined",
  "gang formed",
  "donations install",
  "The Red Pill installed",
  "levelling",
];

/**
 * The campaign report's section (#360): every estimate, against the outcome, then each BitNode's median and worst
 * ratio, and the ratios by moment.
 */
export function destroyEstimateSection(rows: readonly JudgedRow[], unread: number, formatTime: (ms: number) => string) {
  const lines = [
    "Time to the destroy (#360), an estimate per row: the brain's own (destroyEstimated) and, before the brain made " +
      "them, hindcast from the store as it was at each moment (the same function, nothing after the moment read; A5's " +
      "ETA at a join as it was then); the ratio is the estimated remaining time online over the actual (≥: the " +
      "estimate is at least that, a term none; open: not destroyed yet; under 10 min left: a minute's steps make it ±10% " +
      "or worse). The summaries take the measured rows: not at least, 10 min or more left, not a first look:",
  ];
  if (unread > 0) lines.push(`  ${unread} destroyEstimated event(s) the report can't read, left out`);
  if (rows.length === 0) {
    lines.push(
      "  none: none of the brain's own, and no BitNode of Daedalus's route (BN1, BN4, BN5: the hindcast's) with its " +
        "start seen",
    );
    return lines;
  }
  const header = [
    "BitNode",
    "at",
    "moment",
    "online",
    "est. remaining",
    "est. total",
    "actual remaining",
    "actual total",
    "ratio",
    "terms",
  ];
  const body = rows.map((row) => [
    row.name,
    formatTime(row.atMs),
    `${row.record.stage}${row.record.late ? " (late)" : ""}${row.hindcast ? " (hindcast)" : ""}`,
    formatDuration(row.record.onlineMs),
    row.record.never ? "never" : describeMs(row.record.remainingMs, row.record.atLeast),
    row.record.never ? "never" : describeMs(row.record.totalMs, row.record.atLeast),
    row.actualRemainingMs === null ? "open" : formatDuration(row.actualRemainingMs),
    row.actualTotalMs === null ? "open" : formatDuration(row.actualTotalMs),
    describeRatio(row),
    describeTermsShort(row.record),
  ]);
  lines.push(...table([header, ...body]));
  // Only the measured rows (`unmeasuredReason`): a bound, a short remainder or a first look are listed, left out of these.
  const ratiosOf = (each: readonly JudgedRow[]) =>
    each.flatMap((row) => (row.ratio === null || unmeasuredReason(row) !== null ? [] : [row.ratio]));
  const describeSpread = (each: readonly JudgedRow[]) => {
    const ratios = ratiosOf(each);
    const mid = median(ratios);
    const worst = worstRatio(ratios);
    const reasons = (["at least", "under 10 min left", "first seen"] as const)
      .map((reason) => [reason, each.filter((row) => unmeasuredReason(row) === reason).length] as const)
      .filter(([, count]) => count > 0);
    const leftOut =
      reasons.length === 0 ? "" : `; left out: ${reasons.map(([reason, count]) => `${count} ${reason}`).join(", ")}`;
    return mid === null || worst === null
      ? `no ratio${leftOut}`
      : `${ratios.length} ratio(s), median ${mid.toFixed(2)}, worst ${worst.toFixed(2)}, ` +
          `${Math.min(...ratios).toFixed(2)}-${Math.max(...ratios).toFixed(2)}${leftOut}`;
  };
  lines.push("  each BitNode:");
  for (const name of [...new Set(rows.map((row) => row.name))]) {
    lines.push(`    ${name}: ${describeSpread(rows.filter((row) => row.name === name))}`);
  }
  lines.push("  by moment, over the campaign:");
  for (const stage of STAGES) {
    const each = rows.filter((row) => row.record.stage === stage);
    if (each.length > 0) lines.push(`    ${stage}: ${describeSpread(each)}`);
  }
  const all = ratiosOf(rows);
  if (all.length > 0) {
    const band = (factor: number) =>
      `${withinFactor(all, factor)} (${Math.round((100 * withinFactor(all, factor)) / all.length)}%)`;
    lines.push(
      `  within ×1.25: ${band(1.25)} of ${all.length}; within ×1.5: ${band(1.5)}; within ×2: ${band(2)} ` +
        "(Q9, #39; the measured rows: not at least, 10 min or more left, not a first look)",
    );
  }
  return lines;
}

/** Rows as a table: each column padded to its widest cell, indented (the campaign report's). */
function table(rows: string[][], indent = "  "): string[] {
  const widths = (rows[0] ?? []).map((_, column) => Math.max(...rows.map((row) => (row[column] ?? "").length)));
  return rows.map(
    (row) =>
      indent +
      row
        .map((cell, column) => cell.padEnd(widths[column] ?? 0))
        .join("  ")
        .trimEnd(),
  );
}

/** The section's rows over a store's slow snapshots and events (the campaign report's read): hindcast, then the brain's. */
export function destroyEstimateRows(
  slowSnapshots: Iterable<SlowResetInfo>,
  events: readonly StoredEvent[],
): { fold: CampaignFold; rows: JudgedRow[]; unread: number } {
  const stored = storedEstimates(events);
  const firstLive = stored.rows[0]?.atMs ?? Number.POSITIVE_INFINITY;
  const hindcast = new DestroyHindcast(events, firstLive);
  for (const snapshot of slowSnapshots) hindcast.add(snapshot);
  const views = campaignViews(hindcast.fold, events.filter(isCampaignEvent))?.views ?? [];
  const rows = [...hindcast.rows, ...stored.rows].sort((a, b) => a.atMs - b.atMs);
  return { fold: hindcast.fold, rows: judgeRows(rows, views), unread: stored.unread };
}

/**
 * The run report's lines (#360): the failures among the window's estimates, a term never (a rate of 0: hopeless, decision
 * 67's point 8) or an event it can't read. With the World Daemon's switch off, warnings: the destroy isn't wanted. No
 * lines with no estimate in the window.
 */
export function destroyEstimateHealthLines(
  events: readonly StoredEvent[],
  {
    failures,
    warnings,
    formatTime,
    worldDaemonEnabled = true,
  }: { failures: string[]; warnings: string[]; formatTime: (ms: number) => string; worldDaemonEnabled?: boolean },
): string[] {
  const lines = ["  the time to the destroy (#360: a term never reached):"];
  const { rows, unread } = storedEstimates(events);
  // None in the window (a brain from before #360, or a window with no moment): nothing to judge, no lines.
  if (rows.length === 0 && unread === 0) return [];
  const problems: string[] = [];
  if (unread > 0)
    problems.push(`destroy estimate: ${unread} destroyEstimated event(s) not read (not the brain's form)`);
  for (const { record, atMs } of rows) {
    const at = `at ${formatTime(atMs)} (${record.bitNode}, ${record.stage})`;
    if (record.never) {
      const never = record.terms.filter((term) => term.never).map((term) => `${term.term}: ${term.source}`);
      problems.push(`destroy estimate never ${at}: ${never.join("; ")}`);
    }
  }
  for (const problem of problems) {
    if (worldDaemonEnabled) {
      lines.push(`    ${problem}`);
      failures.push(problem);
    } else {
      const warning = `${problem} (the World Daemon's switch is off now: the destroy isn't wanted, so a warning)`;
      lines.push(`    ${warning}`);
      warnings.push(warning);
    }
  }
  if (problems.length === 0) lines.push("    none");
  return lines;
}

/** Section 3's lines (#360): each estimate the brain made in the window. */
export function destroyEstimatePathLines(events: readonly StoredEvent[], formatTime: (ms: number) => string): string[] {
  return storedEstimates(events).rows.map(
    ({ record, atMs }) => `    ${formatTime(atMs)}  time to ${describeDestroyEstimate(record)}`,
  );
}
