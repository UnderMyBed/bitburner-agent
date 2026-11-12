// The time to the destroy (#360, decision 67's point 2): the brain's estimate of the time online to its BitNode's
// destroy, end to end (core's `destroyEstimate`), made and recorded at the BitNode's start (its first slow snapshot),
// at each install (a new `lastAugReset`), at Daedalus joined, and at levelling's first choice; the campaign report puts
// each against the outcome (./destroy-estimate-report.ts) and the run report fails a hopeless one.
// - The inputs: the BitNode's time online, the campaign's clock (`advanceOnlineClock` keyed by its `lastNodeReset`,
//   kept in the store so a restart carries it on); Daedalus's count (core's `daedalusCountOf`); A5's ETA for The Red
//   Pill's hold (its `factionWorkChosen` choice, with the share); levelling's chosen candidate's estimate (#336); and
//   the prior, the last destroyed BitNode's stretches, the same number first (./campaign-model.ts), read from the store
//   once a BitNode and kept with the rest.
// - Restarts: the setting `destroyEstimate.last` (the BitNode's and the cycle's resets, the moments made, the clock and
//   the last estimate) keeps a restart from repeating one. An install made while the brain was down is estimated at
//   the first slow snapshot after it, and marked late (that snapshot more than a slow gap after the install).
// - Daedalus's route alone (BN1, BN4, BN5: core's `DESTROY_ESTIMATE_BITNODES`): in another BitNode, no estimate, said
//   once in the log. BN2's gang (#357) and Black Ops (#359) are later slices.
import {
  augmentationBitNodeMultipliers,
  DAEDALUS,
  type DaedalusStage,
  DESTROY_ESTIMATE_BITNODES,
  type DestroyEstimate,
  type DestroyPrior,
  type DestroyTermLabel,
  type DestroyTermName,
  daedalusCountOf,
  destroyEstimate,
  donationsUnlocked,
  type FactionWorkChoice,
  factionReadingOf,
  type SlowSnapshotData,
  THE_RED_PILL,
} from "@bitburner-agent/core";
import { AUGMENTATION_SLOW_GAP_MS, advanceOnlineClock, type OnlineClock } from "./augmentations.ts";
import {
  CAMPAIGN_EVENT_KINDS,
  CampaignFold,
  campaignViews,
  destroyPriorOf,
  destroyStretchesOf,
} from "./campaign-model.ts";
import { bitNodeLabel } from "./cycle-report.ts";
import { formatDuration } from "./gap-report.ts";
import type { LevellingView } from "./levelling.ts";
import type { Environment, TelemetryStore } from "./telemetry-store.ts";

/** Stored at each estimate (#360), for the campaign report and the run report. */
export const DESTROY_ESTIMATED_EVENT_KIND = "destroyEstimated";
/** The rule's note (#360), kept in the store so a restarted brain neither repeats an estimate nor loses its clock. */
export const DESTROY_ESTIMATE_SETTING = "destroyEstimate.last";

/** Where an estimate is made: the BitNode's start, an install, Daedalus joined, levelling's first choice. */
export type DestroyMoment = "start" | "install" | "joined" | "levelling";

/**
 * Where the BitNode stood at it, for the campaign report's ratios by moment: an install short of the count, the count
 * met, the donations install (the install after the join), The Red Pill installed.
 */
export type DestroyStage =
  | "start"
  | "install"
  | "count met"
  | "joined"
  | "donations install"
  | "The Red Pill installed"
  | "levelling";

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
  if (moment === "start" || moment === "joined" || moment === "levelling") return moment;
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

const MOMENTS: readonly string[] = ["start", "install", "joined", "levelling"];
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

/** The estimate in a line: the dashboard's, the log's and the run report's. */
export function describeDestroyEstimate(record: DestroyEstimateRecord): string {
  const atLeast = record.atLeast ? "at least " : "";
  return (
    `the destroy (#360), at ${record.moment === "levelling" ? "levelling's first choice" : record.moment}` +
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
      kinds: CAMPAIGN_EVENT_KINDS,
    });
  });
  fold.add({ id: 0, release: "", ...live });
  const views = campaignViews(fold, events)?.views ?? [];
  const index = views.findLastIndex((view) => view.bitNode.lastNodeReset === live.resetInfo.lastNodeReset);
  const view = views[index];
  if (view === undefined) return { prior: null, onlineMs: 0, countMetOnlineMs: null };
  return {
    prior: destroyPriorOf(views, index),
    onlineMs: view.bitNode.clock.onlineMs,
    countMetOnlineMs: destroyStretchesOf(view).countMetOnlineMs,
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
}

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
    typeof note.levelled !== "boolean"
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

  constructor({
    store,
    log = () => {},
    emit = () => {},
    seedOf = () => ({ prior: null, onlineMs: 0, countMetOnlineMs: null }),
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

  /** The dashboard's World Daemon line (#360): the latest estimate. */
  lines(): string[] {
    const last = this.last();
    return last === null ? [] : [`time to ${describeDestroyEstimate(last)}`];
  }

  update(inputs: DestroyEstimateInputs): void {
    const facts = resetFactsOf(inputs.slowData);
    const { slowGameTimeMs } = inputs;
    if (facts === null || !isFiniteNumber(slowGameTimeMs) || inputs.slowData === null) return;
    let note = this.#note;
    let changed = false;
    // Another BitNode (or none noted): its seed from the store, once.
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
      };
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
    if (!DESTROY_ESTIMATE_BITNODES.includes(facts.currentNode)) {
      if (this.#unmodelledLogged !== facts.lastNodeReset) {
        this.#unmodelledLogged = facts.lastNodeReset;
        this.#log(
          `destroy estimate: none in BitNode ${facts.currentNode}: its route isn't Daedalus's (#360 models BN1, BN4 ` +
            "and BN5; the gang's is #357, Black Ops #359)",
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
    if (note.countMetOnlineMs === null && count.installed >= count.required) {
      note = { ...note, countMetOnlineMs: onlineMs };
      changed = true;
    }
    const redPillInstalled = Object.hasOwn(facts.ownedAugs, THE_RED_PILL);
    const daedalus = factionReadingOf(inputs.slowData)?.state?.joined.find((faction) => faction.name === DAEDALUS);
    const moments: DestroyMoment[] = [];
    if (note.lastAugReset !== facts.lastAugReset) {
      moments.push(facts.lastAugReset === facts.lastNodeReset ? "start" : "install");
      note = { ...note, lastAugReset: facts.lastAugReset };
      changed = true;
    }
    if (daedalus !== undefined && note.joinedCycle === null && !redPillInstalled) {
      moments.push("joined");
      note = { ...note, joinedCycle: facts.lastAugReset };
      changed = true;
    }
    const levellingMs = levellingEstimateMs(inputs.levelling);
    if (redPillInstalled && !note.levelled && levellingMs !== null) {
      moments.push("levelling");
      note = { ...note, levelled: true };
      changed = true;
    }
    for (const moment of moments) {
      const favourUnlocked =
        daedalus !== undefined &&
        donationsUnlocked(daedalus.favor, augmentationBitNodeMultipliers(facts.currentNode, facts.ownedSF));
      const stage: DaedalusStage =
        (note.joinedCycle !== null && note.joinedCycle !== facts.lastAugReset) || favourUnlocked
          ? "donations installed"
          : daedalus !== undefined
            ? "joined"
            : "not joined";
      const choice = inputs.factionChoice;
      const holdEtaMs =
        stage === "joined" && choice?.faction === DAEDALUS && choice.augmentation === THE_RED_PILL
          ? choice.etaSeconds * 1000
          : null;
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
      });
      const record = destroyEstimateRecord(estimate, {
        moment,
        stage: destroyStageOf(moment, {
          redPillInstalled,
          daedalus: stage,
          countMet: note.countMetOnlineMs !== null,
        }),
        // An install the brain saw late (down at it): its first slow snapshot more than a slow gap after it.
        late:
          moment !== "joined" &&
          moment !== "levelling" &&
          slowGameTimeMs - facts.lastAugReset > AUGMENTATION_SLOW_GAP_MS,
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
