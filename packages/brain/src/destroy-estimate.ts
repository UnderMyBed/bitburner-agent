// The time to the destroy (#360, decision 67's point 2): the brain's estimate of the time online to its BitNode's
// destroy, end to end (core's `destroyEstimate`), made and recorded at the BitNode's start (its first slow snapshot),
// at each install (a new `lastAugReset`), at Daedalus joined, and at levelling's first choice; the campaign report puts
// each against the outcome (./destroy-estimate-report.ts), and the run report fails one with a term never reached (#360
// amended: the rest are reported, not judged).
// - The inputs: the BitNode's time online, the campaign's clock (`advanceOnlineClock` keyed by its `lastNodeReset`,
//   kept in the store so a restart carries it on); Daedalus's count (core's `daedalusCountOf`); A5's ETA for The Red
//   Pill's hold (its first `factionWorkChosen` choice at Daedalus, the join's moment waiting for it: with the share if
//   it runs then; cautious, the store's 1.2-2.6× the hold); levelling's chosen candidate's estimate (#336); and
//   the prior, the last destroyed BitNode's stretches, the same number first (./campaign-model.ts), read from the store
//   once a BitNode and kept with the rest.
// - Restarts: the setting `destroyEstimate.last` (the BitNode's and the cycle's resets, the moments made, the clock and
//   the last estimate) keeps a restart from repeating one. An install made while the brain was down is estimated at
//   the first slow snapshot after it, and marked late (that snapshot more than a slow gap after the install).
//   A brain with no note for the BitNode records its first look "first seen" unless it's the store's first slow snapshot
//   of the BitNode (the hindcast has that start or install); a save loaded,
//   an earlier `lastAugReset`, isn't estimated again.
// - Daedalus's route (BN1, BN4, BN5) and BN2's gang (#357's slice 3: core's `DESTROY_ESTIMATE_BITNODES`,
//   `destroyRouteOf`): in another BitNode, no estimate, said once in the log. Black Ops (#359) is a later slice.
// - BN2, the gang's route: A is the planner's τ_g (A6's timing, route "gang forming") until the gang forms, kept formed
//   in the note (an install keeps the gang); BC is (3)'s chosen estimate (route "gang formed") and The Red Pill's
//   install. A cycle's estimate (its start, an install, a first look) waits for its route's figure, τ_g before the gang
//   (the experience rate's whole window after the reset: A6 measures none before it, #378's review) or (3)'s with it
//   (the gang read again after an install's restart), as the join waits for A5's choice: `DESTROY_ROUTE_WAIT_MS` online
//   at most, kept in the note, its `late` from its first slow snapshot; a new cycle with one still waiting drops it,
//   said in the log. A6's timing is taken only for the cycle the slow snapshot shows (its progress's `lastAugReset`:
//   A6 keeps the last cycle's view on its early returns, #378's review). The gang formed is a moment of its own, made at
//   once (a fresh gang trains first, so (3)'s comes minutes on: BC none, the plan's time to earning said); a cycle's
//   estimate still waiting then goes first, as it stood before the gang. At a first look with the gang unread (no
//   reading yet says whether there's one), whether it's formed is unknown: no moment for it, and the cycle's estimate
//   waits, until a reading says (#378's review).
import {
  augmentationBitNodeMultipliers,
  DAEDALUS,
  type DaedalusStage,
  type DestroyEstimate,
  type DestroyGangInputs,
  type DestroyPrior,
  type DestroyTermLabel,
  type DestroyTermName,
  daedalusCountOf,
  destroyEstimate,
  destroyRouteOf,
  donationsUnlocked,
  type FactionWorkChoice,
  factionReadingOf,
  type SlowSnapshotData,
  THE_RED_PILL,
} from "@bitburner-agent/core";
import {
  AUGMENTATION_SLOW_GAP_MS,
  advanceOnlineClock,
  GANG_FORMED_ROUTE,
  GANG_FORMING_ROUTE,
  type InstallTimingView,
  type OnlineClock,
} from "./augmentations.ts";
import {
  CAMPAIGN_EVENT_KINDS,
  CampaignFold,
  campaignViews,
  destroyPriorOf,
  destroyStretchesOf,
} from "./campaign-model.ts";
import { bitNodeLabel } from "./cycle-report.ts";
import type { GangStallStretch } from "./gang-stalls.ts";
import { formatDuration } from "./gap-report.ts";
import { LEVELLING_CHOSEN_EVENT_KIND, type LevellingView } from "./levelling.ts";
import type { Environment, TelemetryStore } from "./telemetry-store.ts";
import { HACKING_EXP_WINDOW_MS } from "./world-daemon.ts";

/** Stored at each estimate (#360), for the campaign report and the run report. */
export const DESTROY_ESTIMATED_EVENT_KIND = "destroyEstimated";
/** The rule's note (#360), kept in the store so a restarted brain neither repeats an estimate nor loses its clock. */
export const DESTROY_ESTIMATE_SETTING = "destroyEstimate.last";
/**
 * In BN2, the longest a cycle's estimate waits for its route's figure (#357's slice 3), online: the experience rate's own
 * window (`HACKING_EXP_WINDOW_MS`, 10 min), over which A6 measures τ_g (#378's review: its first minutes overstate it),
 * and a slow gap (`AUGMENTATION_SLOW_GAP_MS`, 3 min): the wait starts at the cycle's first slow snapshot, the window at
 * its first medium one, which can come later, and without the gap the bound's slow snapshot lands before the window's
 * last medium one (the controller test's case). (3)'s needs the gang read and earning again after an install's restart.
 * Past it, made with the term none, said so.
 */
export const DESTROY_ROUTE_WAIT_MS = HACKING_EXP_WINDOW_MS + AUGMENTATION_SLOW_GAP_MS;

/**
 * Where an estimate is made: the BitNode's start, an install, Daedalus joined, BN2's gang formed (#357), levelling's
 * first choice; or "first seen", a cycle not the BitNode's first that a brain with no note for the BitNode sees first (a
 * first deploy mid-cycle): the hindcast has its install already, so it's listed apart and left out of the summaries.
 */
export type DestroyMoment = "start" | "install" | "first seen" | "joined" | "gang formed" | "levelling";

/**
 * Where the BitNode stood at it, for the campaign report's ratios by moment: an install short of the count, the count
 * met, the donations install (the install after the join), The Red Pill installed.
 */
export type DestroyStage =
  | "start"
  | "install"
  | "count met"
  | "joined"
  | "gang formed"
  | "donations install"
  | "The Red Pill installed"
  | "levelling"
  | "first seen";

/** A term as stored: Infinity can't be JSON, so a term that's never has `never` and no ms. */
export interface StoredDestroyTerm {
  term: DestroyTermName;
  ms: number | null;
  never: boolean;
  atLeast: boolean;
  source: string;
  label: DestroyTermLabel;
}

/** An estimate as the event stores it (and the campaign report's hindcast makes it). */
export interface DestroyEstimateRecord {
  moment: DestroyMoment;
  stage: DestroyStage;
  /** Made more than a slow gap after its moment (an install while the brain was down). */
  late: boolean;
  /** Its label ("BN1.3"), and its resets: the campaign report matches it to the BitNode by its `lastNodeReset`. */
  bitNode: string;
  currentNode: number;
  lastNodeReset: number;
  lastAugReset: number;
  /** The BitNode's time online at it, t. */
  onlineMs: number;
  /** Null where it's never. */
  remainingMs: number | null;
  totalMs: number | null;
  atLeast: boolean;
  never: boolean;
  count: number;
  required: number;
  requiredLevel: number;
  /** The prior's label, or null with none. */
  prior: string | null;
  terms: StoredDestroyTerm[];
}

export type DestroyEstimateEvent = { type: typeof DESTROY_ESTIMATED_EVENT_KIND; atMs: number } & DestroyEstimateRecord;

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const finiteOrNull = (ms: number) => (Number.isFinite(ms) ? ms : null);

/** The stage at a moment (`DestroyStage`), from the estimate's inputs. */
export function destroyStageOf(
  moment: DestroyMoment,
  { redPillInstalled, daedalus, countMet }: { redPillInstalled: boolean; daedalus: DaedalusStage; countMet: boolean },
): DestroyStage {
  if (
    moment === "start" ||
    moment === "joined" ||
    moment === "gang formed" ||
    moment === "levelling" ||
    moment === "first seen"
  ) {
    return moment;
  }
  if (redPillInstalled) return "The Red Pill installed";
  if (daedalus === "donations installed") return "donations install";
  return countMet ? "count met" : "install";
}

/** Core's estimate as recorded: the event's, or the hindcast's. */
export function destroyEstimateRecord(
  estimate: DestroyEstimate,
  facts: {
    moment: DestroyMoment;
    stage: DestroyStage;
    late: boolean;
    currentNode: number;
    ownedSF: Readonly<Record<string, number>>;
    lastNodeReset: number;
    lastAugReset: number;
    onlineMs: number;
    count: number;
    prior: DestroyPrior | null;
  },
): DestroyEstimateRecord {
  return {
    moment: facts.moment,
    stage: facts.stage,
    late: facts.late,
    bitNode: bitNodeLabel(facts.currentNode, facts.ownedSF),
    currentNode: facts.currentNode,
    lastNodeReset: facts.lastNodeReset,
    lastAugReset: facts.lastAugReset,
    onlineMs: facts.onlineMs,
    remainingMs: estimate.never ? null : estimate.remainingMs,
    totalMs: estimate.never ? null : estimate.totalMs,
    atLeast: estimate.atLeast,
    never: estimate.never,
    count: facts.count,
    required: estimate.required,
    requiredLevel: estimate.requiredLevel,
    prior: facts.prior?.bitNode ?? null,
    terms: estimate.terms.map((term) => ({
      term: term.term,
      ms: term.ms === null ? null : finiteOrNull(term.ms),
      never: term.ms === Number.POSITIVE_INFINITY,
      atLeast: term.atLeast,
      source: term.source,
      label: term.label,
    })),
  };
}

const MOMENTS: readonly string[] = ["start", "install", "first seen", "joined", "gang formed", "levelling"];
const isTerm = (value: unknown): value is StoredDestroyTerm => {
  const term = value as Partial<StoredDestroyTerm> | null;
  return (
    typeof term?.term === "string" &&
    (term.ms === null || isFiniteNumber(term.ms)) &&
    typeof term.never === "boolean" &&
    typeof term.source === "string" &&
    typeof term.label === "string"
  );
};

/** A stored estimate, or null for a detail the brain didn't write. */
export function parseDestroyEstimate(detail: unknown): DestroyEstimateRecord | null {
  const record = detail as Partial<DestroyEstimateRecord> | null;
  if (
    typeof record?.moment !== "string" ||
    !MOMENTS.includes(record.moment) ||
    typeof record.stage !== "string" ||
    typeof record.bitNode !== "string" ||
    !isFiniteNumber(record.lastNodeReset) ||
    !isFiniteNumber(record.lastAugReset) ||
    !isFiniteNumber(record.onlineMs) ||
    !(record.remainingMs === null || isFiniteNumber(record.remainingMs)) ||
    typeof record.never !== "boolean" ||
    !Array.isArray(record.terms) ||
    !record.terms.every(isTerm)
  ) {
    return null;
  }
  return record as DestroyEstimateRecord;
}

/** "2 h 10 min", "never", "none" for a stored time. */
const describeMs = (ms: number | null, never = false) => (never ? "never" : ms === null ? "none" : formatDuration(ms));

/** "A 0 (done), BC 1 h 40 min (either way: the prior's B + C (BN1.2)), D none (optimistic: no prior: none)". */
export function describeTerms(terms: readonly StoredDestroyTerm[]): string {
  return terms
    .map(
      (term) =>
        `${term.term} ${describeMs(term.ms, term.never)}${term.atLeast && term.ms !== null ? " at least" : ""} ` +
        `(${term.label}: ${term.source})`,
    )
    .join(", ");
}

/** A moment in the estimate's line, where its name alone doesn't read. */
const MOMENT_WORDS: Partial<Record<DestroyMoment, string>> = {
  levelling: "levelling's first choice",
  "gang formed": "the gang formed",
};

/** The estimate in a line: the dashboard's, the log's and the run report's. */
export function describeDestroyEstimate(record: DestroyEstimateRecord): string {
  const atLeast = record.atLeast ? "at least " : "";
  return (
    `the destroy (#360), at ${MOMENT_WORDS[record.moment] ?? record.moment}` +
    `${record.late ? " (late)" : ""} with ${formatDuration(record.onlineMs)} online: ` +
    (record.never
      ? "never (a term never reached)"
      : `${atLeast}${describeMs(record.remainingMs)} to go, ${atLeast}${describeMs(record.totalMs)} in all`) +
    `; ${describeTerms(record.terms)}`
  );
}

/** What the store gives a BitNode the rule first sees (#360): its prior, and its time online and count met so far. */
export interface DestroySeed {
  prior: DestroyPrior | null;
  onlineMs: number;
  countMetOnlineMs: number | null;
  /** The store had a slow snapshot of the BitNode before this one: its start, if seen, is the hindcast's already. */
  seenBefore: boolean;
}

/** A slow snapshot as the rule seeds from it: the store's row's fields. */
export interface SeedSnapshot {
  receivedAtMs: number;
  gameTimeMs: number;
  resetInfo: Record<string, unknown>;
}

/**
 * The seed for the BitNode `live` shows (#360), from the store's slow snapshots' `resetInfo` and the campaign's
 * events (the campaign fold, ./campaign-model.ts), `live` folded last so its BitNode's start ends the one before even
 * if it isn't stored yet: the prior (`destroyPriorOf`), and the BitNode's time online and count met so far. Read once
 * a BitNode: it reads every slow snapshot's `resetInfo` alone, as the campaign report does.
 */
export function readDestroySeed(store: TelemetryStore, environment: Environment, live: SeedSnapshot): DestroySeed {
  const fold = new CampaignFold();
  const events = store.readTransaction(() => {
    for (const snapshot of store.iterateSlowResetInfo({ environment })) fold.add(snapshot);
    return store.eventsInWindow({
      environment,
      sinceMs: 0,
      untilMs: Number.MAX_SAFE_INTEGER,
      kinds: [...CAMPAIGN_EVENT_KINDS, LEVELLING_CHOSEN_EVENT_KIND],
    });
  });
  fold.add({ id: 0, release: "", ...live });
  const levellingChosenAtMs = events
    .filter((each) => each.kind === LEVELLING_CHOSEN_EVENT_KIND)
    .map((each) => each.atMs);
  const views =
    campaignViews(
      fold,
      events.filter((each) => each.kind !== LEVELLING_CHOSEN_EVENT_KIND),
    )?.views ?? [];
  const index = views.findLastIndex((view) => view.bitNode.lastNodeReset === live.resetInfo.lastNodeReset);
  const view = views[index];
  if (view === undefined) return { prior: null, onlineMs: 0, countMetOnlineMs: null, seenBefore: false };
  return {
    prior: destroyPriorOf(views, index, levellingChosenAtMs),
    onlineMs: view.bitNode.clock.onlineMs,
    countMetOnlineMs: destroyStretchesOf(view).countMetOnlineMs,
    seenBefore: view.bitNode.firstSlowAtMs < live.receivedAtMs,
  };
}

/** The rule's note as stored (`DESTROY_ESTIMATE_SETTING`). */
interface DestroyNote {
  lastNodeReset: number;
  /** The cycle last estimated (its start or install), or null before it. */
  lastAugReset: number | null;
  /** The BitNode's online clock, keyed by its `lastNodeReset` (the campaign's). */
  clock: OnlineClock;
  countMetOnlineMs: number | null;
  /** The cycle Daedalus was first joined in, or null: the joined moment made. */
  joinedCycle: number | null;
  /** Levelling's first choice estimated. */
  levelled: boolean;
  prior: DestroyPrior | null;
  last: DestroyEstimateRecord | null;
  /**
   * BN2 (#357): the gang formed in the BitNode (an install keeps it); null unknown, a first look with the gang unread
   * (#378's review). Absent in an earlier note: not.
   */
  gangFormed: boolean | null;
  /** BN2 (#357): the cycle's estimate waiting for its route's figure, or null. Absent in an earlier note: none. */
  pending: PendingMoment | null;
}

/** A cycle's estimate waiting in BN2 (#357): its moment, `late` as its first slow snapshot had it, and since when. */
interface PendingMoment {
  moment: DestroyMoment;
  late: boolean;
  sinceOnlineMs: number;
}

const isPending = (value: unknown): value is PendingMoment => {
  const pending = value as Partial<PendingMoment> | null;
  return (
    typeof pending?.moment === "string" &&
    MOMENTS.includes(pending.moment) &&
    typeof pending.late === "boolean" &&
    isFiniteNumber(pending.sinceOnlineMs)
  );
};

function readNote(store: TelemetryStore): DestroyNote | null {
  const value = store.getSetting(DESTROY_ESTIMATE_SETTING);
  if (value === null) return null;
  let note: Partial<DestroyNote> | null;
  try {
    note = JSON.parse(value) as Partial<DestroyNote> | null;
  } catch {
    throw new Error(`the store's ${DESTROY_ESTIMATE_SETTING} isn't JSON`);
  }
  const clock = note?.clock;
  if (
    !isFiniteNumber(note?.lastNodeReset) ||
    !(note.lastAugReset === null || isFiniteNumber(note.lastAugReset)) ||
    !isFiniteNumber(clock?.lastAugReset) ||
    !isFiniteNumber(clock.onlineMs) ||
    !isFiniteNumber(clock.lastGameTimeMs) ||
    typeof note.levelled !== "boolean" ||
    !(note.gangFormed === undefined || note.gangFormed === null || typeof note.gangFormed === "boolean") ||
    !(note.pending === undefined || note.pending === null || isPending(note.pending))
  ) {
    throw new Error(`the store's ${DESTROY_ESTIMATE_SETTING} isn't a note the brain wrote`);
  }
  return {
    lastNodeReset: note.lastNodeReset,
    lastAugReset: note.lastAugReset,
    clock,
    countMetOnlineMs: isFiniteNumber(note.countMetOnlineMs) ? note.countMetOnlineMs : null,
    joinedCycle: isFiniteNumber(note.joinedCycle) ? note.joinedCycle : null,
    levelled: note.levelled,
    prior: note.prior ?? null,
    last: note.last === undefined || note.last === null ? null : parseDestroyEstimate(note.last),
    gangFormed: note.gangFormed === undefined ? false : note.gangFormed,
    pending: note.pending ?? null,
  };
}

/** BN2's gang route as the controller hands it (#357's slice 3): the gang rule's and A6's figures this update. */
export interface DestroyGangFacts {
  /** The gang rule manages a gang: formed. */
  formed: boolean;
  /** In BN2 with no reading yet that says whether there's a gang (the gang rule's `gangUnread`): formed or not unknown. */
  unread?: boolean;
  /** A6's planner's install timing this update (its progress's), or null: τ_g's and (3)'s. */
  timing: InstallTimingView | null;
  /** The cycle A6's progress is of (its `lastAugReset`): a timing of another cycle is left out. Absent: this one's. */
  timingLastAugReset?: number | null;
  /** The gang's plan earning no respect (#374): its stretch, with the rule's estimate; or null. */
  pause: GangStallStretch | null;
}

/**
 * Core's gang inputs from the controller's facts (#357's slice 3), `formed` as the note has it: τ_g from A6's timing on
 * the route "gang forming", (3)'s chosen candidate's estimate on "gang formed", and the pause's estimate less its time
 * so far. A timing of a cycle other than `lastAugReset` (A6's stale view, #378's review) is none.
 */
export function destroyGangInputsOf(
  facts: DestroyGangFacts | null,
  formed: boolean,
  lastAugReset?: number,
): DestroyGangInputs {
  const stale =
    lastAugReset !== undefined && facts?.timingLastAugReset != null && facts.timingLastAugReset !== lastAugReset;
  const timing = stale ? null : (facts?.timing ?? null);
  const waitMs = timing?.route === GANG_FORMING_ROUTE ? (timing.gang?.waitMs ?? null) : null;
  const install = timing?.route === GANG_FORMED_ROUTE ? (timing.gangInstall ?? null) : null;
  const ms =
    install === null
      ? null
      : install.choice === "install"
        ? install.installNowMs
        : install.choice === "bank"
          ? install.bankMs
          : install.keepMs;
  const pause = facts?.pause ?? null;
  return {
    formed,
    waitMs,
    redPill: install === null || ms === null ? null : { choice: install.choice, ms },
    earningInMs:
      pause?.estimateMs === undefined ? null : Math.max(0, pause.estimateMs - Math.max(0, pause.toMs - pause.fromMs)),
  };
}

/** What the controller hands the rule each update. */
export interface DestroyEstimateInputs {
  /** The latest slow snapshot (the gang's faction left in: it isn't Daedalus), its game time and arrival. */
  slowData: SlowSnapshotData | null;
  slowGameTimeMs: number | null;
  slowAtMs: number | null;
  /** A5's choice this update (its view's), or null. */
  factionChoice: FactionWorkChoice | null;
  /** Levelling's view this update (#336). */
  levelling: LevellingView;
  nowMs: number | null;
  /** BN2's gang route (#357's slice 3), read there alone; absent or null: no gang, nothing measured. */
  gang?: DestroyGangFacts | null;
}

interface ResetFacts {
  currentNode: number;
  lastNodeReset: number;
  lastAugReset: number;
  ownedAugs: Record<string, number>;
  ownedSF: Record<string, number>;
}

function resetFactsOf(slowData: SlowSnapshotData | null): ResetFacts | null {
  const info = slowData?.resetInfo as Partial<ResetFacts> | undefined;
  const isRecord = (value: unknown): value is Record<string, number> => typeof value === "object" && value !== null;
  if (
    !Number.isInteger(info?.currentNode) ||
    !isFiniteNumber(info?.lastNodeReset) ||
    !isFiniteNumber(info.lastAugReset) ||
    !isRecord(info.ownedAugs) ||
    !isRecord(info.ownedSF)
  ) {
    return null;
  }
  return info as ResetFacts;
}

/** The estimate's rule (#360), as the controller runs it. */
export class DestroyEstimateRule {
  readonly #store: TelemetryStore;
  readonly #log: (line: string) => void;
  readonly #emit: (event: DestroyEstimateEvent) => void;
  readonly #seedOf: (live: SeedSnapshot) => DestroySeed;
  #note: DestroyNote | null;
  /** The slow snapshot last folded into the clock (its game time). */
  #sampledGameTimeMs: number | null = null;
  /** The BitNode whose route was said to be unmodelled, once. */
  #unmodelledLogged: number | null = null;
  /** A slow snapshot of the noted BitNode seen in this run: till then, the dashboard's line may be another's. */
  #seenThisRun = false;

  constructor({
    store,
    log = () => {},
    emit = () => {},
    seedOf = () => ({ prior: null, onlineMs: 0, countMetOnlineMs: null, seenBefore: false }),
  }: {
    store: TelemetryStore;
    log?: (line: string) => void;
    emit?: (event: DestroyEstimateEvent) => void;
    /** The store's seed for a BitNode first seen (`readDestroySeed`); none (no prior, from 0) when absent. */
    seedOf?: (live: SeedSnapshot) => DestroySeed;
  }) {
    this.#store = store;
    this.#log = log;
    this.#emit = emit;
    this.#seedOf = seedOf;
    this.#note = readNote(store);
  }

  /** The latest estimate, or null before one in this BitNode. */
  last(): DestroyEstimateRecord | null {
    return this.#note?.last ?? null;
  }

  /** The dashboard's World Daemon line (#360): the latest estimate, once this run has seen a slow snapshot of its BitNode. */
  lines(): string[] {
    const last = this.last();
    return last === null || !this.#seenThisRun ? [] : [`time to ${describeDestroyEstimate(last)}`];
  }

  update(inputs: DestroyEstimateInputs): void {
    const facts = resetFactsOf(inputs.slowData);
    const { slowGameTimeMs } = inputs;
    if (facts === null || !isFiniteNumber(slowGameTimeMs) || inputs.slowData === null) return;
    let note = this.#note;
    let changed = false;
    // Another BitNode (or none noted): its seed from the store, once.
    const firstLook = note === null || note.lastNodeReset !== facts.lastNodeReset;
    // A first look that isn't the store's first slow snapshot of the BitNode: its start is the hindcast's already.
    let seenBefore = false;
    this.#seenThisRun = true;
    if (note === null || note.lastNodeReset !== facts.lastNodeReset) {
      const seed = this.#seedOf({
        receivedAtMs: inputs.slowAtMs ?? slowGameTimeMs,
        gameTimeMs: slowGameTimeMs,
        resetInfo: inputs.slowData.resetInfo as unknown as Record<string, unknown>,
      });
      note = {
        lastNodeReset: facts.lastNodeReset,
        lastAugReset: null,
        clock: { lastAugReset: facts.lastNodeReset, onlineMs: seed.onlineMs, lastGameTimeMs: slowGameTimeMs },
        countMetOnlineMs: seed.countMetOnlineMs,
        joinedCycle: null,
        levelled: false,
        prior: seed.prior,
        last: null,
        // A gang read formed at a first look formed before it, when isn't known: no moment of its own. Unread, whether
        // there's one isn't known yet (#378's review): null until a reading says.
        gangFormed: inputs.gang?.unread === true ? null : inputs.gang?.formed === true,
        pending: null,
      };
      seenBefore = seed.seenBefore;
      this.#sampledGameTimeMs = slowGameTimeMs;
      changed = true;
    } else if (slowGameTimeMs !== this.#sampledGameTimeMs) {
      this.#sampledGameTimeMs = slowGameTimeMs;
      const { clock } = advanceOnlineClock(note.clock, slowGameTimeMs, facts.lastNodeReset);
      if (clock !== note.clock) {
        note = { ...note, clock };
        changed = true;
      }
    }
    const route = destroyRouteOf(facts.currentNode);
    if (route === null) {
      if (this.#unmodelledLogged !== facts.lastNodeReset) {
        this.#unmodelledLogged = facts.lastNodeReset;
        this.#log(
          `destroy estimate: none in BitNode ${facts.currentNode}: its route isn't modelled (#360 models Daedalus's, ` +
            "BN1, BN4 and BN5; #357 BN2's gang; Black Ops is #359)",
        );
      }
      this.#save(note, changed);
      return;
    }
    const count = daedalusCountOf({
      currentNode: facts.currentNode,
      ownedSF: facts.ownedSF,
      installed: facts.ownedAugs,
      joined: [],
      invitations: [],
    });
    const onlineMs = note.clock.onlineMs;
    if (route === "daedalus" && note.countMetOnlineMs === null && count.installed >= count.required) {
      note = { ...note, countMetOnlineMs: onlineMs };
      changed = true;
    }
    const redPillInstalled = Object.hasOwn(facts.ownedAugs, THE_RED_PILL);
    const daedalus = factionReadingOf(inputs.slowData)?.state?.joined.find((faction) => faction.name === DAEDALUS);
    // Each estimate to make: its moment, `late` (an install the brain saw late: down at it, its first slow snapshot
    // more than a slow gap after it), and in BN2 whether the gang had formed for it.
    const moments: { moment: DestroyMoment; late: boolean; formed: boolean }[] = [];
    // BN2 (#357): the gang formed, the note's (an install keeps it) or the gang rule's now. Unknown since a first look
    // with the gang unread: the first reading says, with no moment of its own (it may have formed long before).
    const formedNow = route === "gang" && inputs.gang?.formed === true;
    if (note.gangFormed === null && inputs.gang?.unread !== true) {
      note = { ...note, gangFormed: formedNow };
      changed = true;
    }
    const unknown = note.gangFormed === null;
    const formedBefore = note.gangFormed === true;
    // Unknown only while the gang is unread, when the gang rule manages none (`formedNow` false): no moment then.
    const formedNew = formedNow && !formedBefore;
    let waiting: PendingMoment | null = null;
    // A new cycle: the start, an install, or a first look at a later one. One earlier than the noted (a save loaded) isn't
    // estimated again: its install, when it comes, is later than the noted.
    if (note.lastAugReset === null || facts.lastAugReset > note.lastAugReset) {
      const start = facts.lastAugReset === facts.lastNodeReset;
      const moment: DestroyMoment = firstLook && (seenBefore || !start) ? "first seen" : start ? "start" : "install";
      const late =
        (moment === "start" || moment === "install") && slowGameTimeMs - facts.lastAugReset > AUGMENTATION_SLOW_GAP_MS;
      // A cycle's estimate still waiting is dropped, said (decision 45): its cycle is over.
      if (note.pending !== null) {
        this.#log(
          `destroy estimate: the ${note.pending.moment} in BN2 dropped, still waiting for its figure at the next cycle (#357)`,
        );
      }
      note = { ...note, lastAugReset: facts.lastAugReset, pending: null };
      changed = true;
      // BN2 short of The Red Pill: it waits for its route's figure, kept in the note (a restart keeps it).
      if (route === "gang" && !redPillInstalled) {
        waiting = { moment, late, sinceOnlineMs: onlineMs };
        note = { ...note, pending: waiting };
      } else moments.push({ moment, late, formed: formedBefore || formedNow });
    }
    // BN2: the cycle's estimate waiting goes once its figure is in (τ_g before the gang, (3)'s with it), The Red Pill is
    // installed, or its bound is past; or, as it stood before the gang, once the gang forms.
    const pending = note.pending;
    if (route === "gang" && pending !== null) {
      const formed = formedBefore || formedNow;
      const figures = destroyGangInputsOf(inputs.gang ?? null, formed, facts.lastAugReset);
      // τ_g finite (A6 measures it over the rate's whole window; none still at the bound is never, loudly); the gang's
      // reading in, if unknown.
      const ready =
        !unknown && (formed ? figures.redPill !== null : figures.waitMs !== null && Number.isFinite(figures.waitMs));
      if (formedNew || ready || redPillInstalled || onlineMs - pending.sinceOnlineMs >= DESTROY_ROUTE_WAIT_MS) {
        moments.push({ moment: pending.moment, late: pending.late, formed: formedNew ? formedBefore : formed });
        note = { ...note, pending: null };
        changed = true;
      } else if (waiting !== null) {
        this.#log(
          `destroy estimate: the ${waiting.moment} in BN2 waits for ${unknown ? "the gang's reading" : formed ? "(3)'s estimate" : "τ_g"} (#357), ` +
            `${formatDuration(DESTROY_ROUTE_WAIT_MS)} online at most`,
        );
      }
    }
    // BN2: the gang formed, once a BitNode, short of The Red Pill; at once (its BC none while it trains first).
    if (formedNew) {
      if (!redPillInstalled) moments.push({ moment: "gang formed", late: false, formed: true });
      note = { ...note, gangFormed: true };
      changed = true;
    }
    // Daedalus joined, once A5's choice for The Red Pill there is in too (its ETA the hold's), as the hindcast reads its
    // first `factionWorkChosen`: the same moment. Daedalus's route alone.
    const choice = inputs.factionChoice;
    const holdChosen = choice?.faction === DAEDALUS && choice.augmentation === THE_RED_PILL;
    if (
      route === "daedalus" &&
      daedalus !== undefined &&
      holdChosen &&
      note.joinedCycle === null &&
      !redPillInstalled
    ) {
      moments.push({ moment: "joined", late: false, formed: false });
      note = { ...note, joinedCycle: facts.lastAugReset };
      changed = true;
    }
    // Levelling's first choice; at a cycle's first estimate that already has it as D, no second with the same figures.
    const levellingMs = levellingEstimateMs(inputs.levelling);
    if (redPillInstalled && !note.levelled && levellingMs !== null) {
      if (moments.length === 0) moments.push({ moment: "levelling", late: false, formed: formedBefore || formedNow });
      note = { ...note, levelled: true };
      changed = true;
    }
    for (const { moment, late, formed } of moments) {
      const favourUnlocked =
        daedalus !== undefined &&
        donationsUnlocked(daedalus.favor, augmentationBitNodeMultipliers(facts.currentNode, facts.ownedSF));
      // Daedalus's stage, its route alone: in BN2 The Red Pill is the gang's faction's.
      const stage: DaedalusStage =
        route === "gang"
          ? "not joined"
          : (note.joinedCycle !== null && note.joinedCycle !== facts.lastAugReset) || favourUnlocked
            ? "donations installed"
            : daedalus !== undefined
              ? "joined"
              : "not joined";
      const holdEtaMs = stage === "joined" && holdChosen ? (choice as FactionWorkChoice).etaSeconds * 1000 : null;
      const estimate = destroyEstimate({
        currentNode: facts.currentNode,
        ownedSF: facts.ownedSF,
        onlineMs,
        count: count.installed,
        redPillInstalled,
        countMetOnlineMs: note.countMetOnlineMs,
        daedalus: stage,
        holdEtaMs,
        levellingMs: redPillInstalled ? levellingMs : null,
        prior: note.prior,
        gang: route === "gang" ? destroyGangInputsOf(inputs.gang ?? null, formed, facts.lastAugReset) : null,
      });
      const record = destroyEstimateRecord(estimate, {
        moment,
        stage: destroyStageOf(moment, {
          redPillInstalled,
          daedalus: stage,
          countMet: note.countMetOnlineMs !== null,
        }),
        late,
        currentNode: facts.currentNode,
        ownedSF: facts.ownedSF,
        lastNodeReset: facts.lastNodeReset,
        lastAugReset: facts.lastAugReset,
        onlineMs,
        count: count.installed,
        prior: note.prior,
      });
      note = { ...note, last: record };
      this.#log(`destroy estimate: ${describeDestroyEstimate(record)}`);
      this.#emit({ type: DESTROY_ESTIMATED_EVENT_KIND, atMs: inputs.nowMs ?? 0, ...record });
    }
    this.#save(note, changed);
  }

  #save(note: DestroyNote, changed: boolean): void {
    this.#note = note;
    if (changed) this.#store.setSetting(DESTROY_ESTIMATE_SETTING, JSON.stringify(note));
  }
}

/** Levelling's chosen candidate's estimate (#336), ms, once it applies and has one; Infinity where it's never. */
export function levellingEstimateMs(view: LevellingView): number | null {
  const seconds = view.applies ? (view.estimates?.[view.mode] ?? null) : null;
  return seconds === null || Number.isNaN(seconds) ? null : seconds * 1000;
}
