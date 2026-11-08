// The dashboard's timeline of BitNodes and installs (#285, architecture §7): each BitNode played (its number and
// level), its start and how it ended, its cycles with their time online and the augmentations each install put in.
// It's the campaign report's own model (`campaign-model.ts`), kept up to date rather than read again: the page asks
// every 2 s, and the store holds about 525,000 slow snapshots a year. Each slow snapshot is folded once, and the events
// of the campaign's three kinds appended once, so a poll reads only what was stored since the last.
// - **The first read** takes the store as it was when it began (to its newest row then), in the report's order (by
//   arrival), `TIMELINE_BATCH` slow snapshots each time the page asks, so it never holds the brain up for long; the
//   page says how far it has got.
// - **After it,** the slow snapshots stored since, in the order stored, at most `TIMELINE_BATCH` a poll too (the page
//   closed for days). The same campaign as `npm run campaign`'s, but for one edge: the brain's clock set back while it
//   runs, where the report's order by arrival differs from the order stored (the timeline's, until the brain restarts).
// Like the report, it reads only the slow snapshots' `resetInfo` and the events, so a store thinned (#283) gives the
// same timeline.
import { NEUROFLUX_GOVERNOR } from "@bitburner-agent/core";
import { describeAugmentations, isFiniteNumber } from "../augmentation-report.ts";
import { CAMPAIGN_EVENT_KINDS, type CampaignCycle, CampaignFold, campaignViews, sum } from "../campaign-model.ts";
import type { Environment, SlowResetInfo, StoredEvent, TelemetryStore } from "../telemetry-store.ts";

/** Slow snapshots folded each time the page asks, in the first read: a year's in 27 polls, under a minute (#285). */
export const TIMELINE_BATCH = 20_000;
/**
 * Rows of any tier stored since the last read up to which the next goes by the row id's range (`slowResetInfoAfterId`):
 * past this (the page closed for days), by the slow tier's index instead, not reading every other tier's rows.
 */
export const RECENT_ROWS = 10_000;

/** An install, as the timeline shows the cycle it ended. */
export interface TimelineInstall {
  /** By the brain's clock: the new cycle's start. */
  atMs: number;
  /** Not sent by the brain's own rule (your queue, the game's Install button, a Soft Reset). */
  byHand: boolean;
  /** How many augmentations it installed (NeuroFlux Governor once a level), and which; null where not recorded. */
  augmentationCount: number | null;
  augmentations: string | null;
}

/** A cycle of a BitNode (`CampaignCycle`), in the order first seen. */
export interface TimelineCycle {
  kind: CampaignCycle["kind"];
  startMs: number;
  onlineMs: number;
  /** Its time online at least this: the BitNode's first cycle, where its start (or an install before) went unseen. */
  onlineAtLeast: boolean;
  /** The BitNode's cycle at its last look: it goes on in it, or ended with it (not always the last listed: a save). */
  current: boolean;
  /**
   * The installs that ended it: none for the current one, or for one left for a save loaded (`leftForSaveAtMs`), or
   * one the store saw no end of.
   */
  endedBy: TimelineInstall[];
  /** Each time a save loaded left it, for another cycle (the brain's clock). */
  leftForSaveAtMs: number[];
}

/** A BitNode as the timeline shows it: the campaign report's row for it, and its cycles. */
export interface TimelineBitNode {
  /** "BN1.4 #2": its number and level, numbered when played again. */
  name: string;
  startMs: number;
  /** How the store came to it: begun before the store's first record, a save loaded, or null (seen from its start). */
  start: "before the store" | "a save loaded" | null;
  /** How it ended, `{at}` where its time `endedAtMs` goes (`describeEnding`): "destroyed {at} (at the cap)". */
  ending: string;
  endedAtMs: number | null;
  /**
   * An end seen: false while it goes on, both "not yet" (`endedAtMs` null) and "destroy sent {at}, the next BitNode not
   * seen" (its time the destroy sent's): the times run "so far" in either.
   */
  ended: boolean;
  destroyed: boolean;
  /** Its wall clock and time online, to its end or so far (not destroyed); at least these where its start's unseen. */
  wallMs: number;
  onlineMs: number;
  soFar: boolean;
  wallAtLeast: boolean;
  onlineAtLeast: boolean;
  /** The time online left out (an offline gap, the brain or the Agent away), and in how many gaps. */
  leftOutMs: number;
  gapCount: number;
  /** Its cycles and installs (by hand among them), at least these where its first look showed an install already. */
  cycles: number;
  installs: number;
  byHand: number;
  countsAtLeast: boolean;
  /** Saves loaded within it (another cycle's `lastAugReset` seen already, or before the last look): not installs. */
  savesLoaded: number;
  /** At its last look: the kinds of augmentation installed, and NeuroFlux Governor's level; null where not recorded. */
  augmentations: { kinds: number; neuroFluxLevel: number } | null;
  releases: string[];
  cycleList: TimelineCycle[];
}

export interface CampaignTimelineView {
  /** Moves on each time the timeline changes: the page draws it again only then. */
  version: number;
  /** During the first read: the slow snapshots folded so far (no BitNode is shown till it's done). Null once done. */
  reading: { slowSnapshots: number } | null;
  /** Slow snapshots folded, and those with no `resetInfo` to read (left out). */
  slowSnapshots: number;
  unread: number;
  /**
   * Slow snapshots the fold failed on (each a failure in the model: the first logged), skipped, or partly applied where
   * it failed part way, and the first one's row and why.
   */
  failed: { count: number; first: string } | null;
  /** Why it couldn't be read just now (the brain logs it), or null. */
  problem: string | null;
  /** In the order played. */
  bitNodes: TimelineBitNode[];
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The timeline over one environment of the store, read a little at a time (`read`, each time the dashboard builds its
 * status).
 */
export class CampaignTimeline {
  readonly #store: TelemetryStore;
  readonly #environment: Environment;
  readonly #batch: number;
  readonly #recentRows: number;
  readonly #onError: (error: unknown) => void;
  readonly #fold = new CampaignFold();
  readonly #events: StoredEvent[] = [];
  #lastEventId = 0;
  /** The first read's end (the store's newest row as it began; null before it), and its place in order of arrival. */
  #firstReadThroughId: number | null = null;
  #after = { receivedAtMs: Number.MIN_SAFE_INTEGER, id: 0 };
  #firstReadDone = false;
  /** After the first read, the row it reads on from: the first read's end, then the newest slow snapshot folded. */
  #lastId = 0;
  /** Something was folded or appended since the view was built: built again on the next read, even after a failure. */
  #dirty = true;
  #version = 0;
  #view: CampaignTimelineView | null = null;
  #problem: string | null = null;
  #failed: { count: number; first: string } | null = null;
  /** Slow snapshots read from the store, every read counted, and the reads by the tier index: what each poll costs. */
  slowSnapshotsRead = 0;
  tierIndexReads = 0;

  constructor({
    store,
    environment,
    batch = TIMELINE_BATCH,
    recentRows = RECENT_ROWS,
    onError = () => {},
  }: {
    store: TelemetryStore;
    environment: Environment;
    batch?: number;
    recentRows?: number;
    /** A failure, once each time its message changes (the brain logs it); the page shows it too. */
    onError?: (error: unknown) => void;
  }) {
    this.#store = store;
    this.#environment = environment;
    this.#batch = batch;
    this.#recentRows = recentRows;
    this.#onError = onError;
  }

  /** The timeline, with what was stored since the last read folded in. A failure is shown in it, not thrown. */
  read(): CampaignTimelineView {
    let problem: unknown = null;
    try {
      this.#update();
    } catch (error) {
      problem = error;
    }
    // Built again on anything folded, a failure part way through included.
    if (this.#dirty || this.#view === null) {
      try {
        this.#version += 1;
        this.#view = this.#viewNow();
        this.#dirty = false;
      } catch (error) {
        problem ??= error;
      }
    }
    if (problem === null) {
      this.#problem = null;
      return this.#view as CampaignTimelineView;
    }
    const message = messageOf(problem);
    if (message !== this.#problem) this.#onError(problem);
    this.#problem = message;
    return { ...(this.#view ?? this.#emptyView()), problem: message };
  }

  /** Reads what was stored since the last read. */
  #update(): void {
    const environment = this.#environment;
    if (!this.#firstReadDone) {
      this.#firstReadThroughId ??= this.#store.lastSnapshotId();
      let count = 0;
      for (const snapshot of this.#store.iterateSlowResetInfo({
        environment,
        after: this.#after,
        throughId: this.#firstReadThroughId,
        limit: this.#batch,
      })) {
        this.#fold1(snapshot);
        this.#after = { receivedAtMs: snapshot.receivedAtMs, id: snapshot.id };
        count += 1;
      }
      this.slowSnapshotsRead += count;
      if (count < this.#batch) {
        this.#firstReadDone = true;
        this.#lastId = this.#firstReadThroughId;
        this.#dirty = true;
      }
    } else {
      const newestId = this.#store.lastSnapshotId();
      const byTierIndex = newestId - this.#lastId > this.#recentRows;
      if (byTierIndex) this.tierIndexReads += 1;
      const stored = this.#store.slowResetInfoAfterId({
        environment,
        afterId: this.#lastId,
        limit: this.#batch,
        byTierIndex,
      });
      for (const snapshot of stored) {
        this.#fold1(snapshot);
        this.#lastId = snapshot.id;
      }
      // Not a full batch: every slow snapshot to the newest row as the read began is folded, so it reads on from that
      // row, not the last slow one: with slow snapshots stopped, or another environment writing, the rows since stay
      // few (and off the tier index).
      if (stored.length < this.#batch) this.#lastId = Math.max(this.#lastId, newestId);
      this.slowSnapshotsRead += stored.length;
    }
    const events = this.#store.eventsAfterId({
      environment,
      kinds: CAMPAIGN_EVENT_KINDS,
      afterEventId: this.#lastEventId,
    });
    for (const { id, atMs, kind, detail } of events) {
      this.#events.push({ atMs, kind, detail });
      this.#lastEventId = id;
      this.#dirty = true;
    }
  }

  /**
   * Folds one slow snapshot; one the fold fails on is skipped and counted (the first logged), never read again. A fold
   * failing part way may have kept part of the row (the BitNode or cycle `ResetDetection` registered, not the fold's
   * own records), so the panel says the timeline may be off from that row (`npm run campaign` fails on it).
   */
  #fold1(snapshot: SlowResetInfo): void {
    this.#dirty = true;
    try {
      this.#fold.add(snapshot);
    } catch (error) {
      if (this.#failed === null) {
        this.#failed = { count: 0, first: `row ${snapshot.id}: ${messageOf(error)}` };
        this.#onError(error);
      }
      this.#failed.count += 1;
    }
  }

  #emptyView(): CampaignTimelineView {
    return {
      version: this.#version,
      reading: this.#firstReadDone ? null : { slowSnapshots: this.#fold.slowCount },
      slowSnapshots: this.#fold.slowCount,
      unread: this.#fold.unread,
      failed: this.#failed === null ? null : { ...this.#failed },
      problem: null,
      bitNodes: [],
    };
  }

  #viewNow(): CampaignTimelineView {
    const base = this.#emptyView();
    // While the first read goes on, its newest BitNode's ending isn't known yet: none shown till it's done.
    const campaign = this.#firstReadDone ? campaignViews(this.#fold, this.#events) : null;
    if (campaign === null) return base;
    return {
      ...base,
      bitNodes: campaign.views.map((view) => {
        const { bitNode, ending } = view;
        const neuroFlux = bitNode.ownedAugs?.[NEUROFLUX_GOVERNOR];
        return {
          name: view.name,
          startMs: bitNode.startMs,
          start: view.startNote,
          ending: ending.text,
          endedAtMs: ending.atMs,
          ended: ending.ended,
          destroyed: ending.destroyedAtMs !== null,
          wallMs: view.wallMs,
          onlineMs: bitNode.clock.onlineMs,
          soFar: view.soFar,
          wallAtLeast: view.wallAtLeast,
          onlineAtLeast: view.onlineAtLeast,
          leftOutMs: sum(view.gapsMs),
          gapCount: view.gapsMs.length,
          cycles: view.cycles,
          installs: view.installs,
          byHand: view.byHand,
          countsAtLeast: view.countsAtLeast,
          savesLoaded: bitNode.savesLoadedAtMs.length,
          augmentations:
            bitNode.ownedAugs === null
              ? null
              : {
                  kinds: Object.keys(bitNode.ownedAugs).length,
                  neuroFluxLevel: isFiniteNumber(neuroFlux) ? neuroFlux : 0,
                },
          releases: [...bitNode.releases.keys()],
          cycleList: bitNode.cycleList.map((cycle, index) => ({
            kind: cycle.kind,
            startMs: cycle.startMs,
            onlineMs: cycle.onlineMs,
            onlineAtLeast: index === 0 && (view.onlineAtLeast || view.countsAtLeast),
            current: cycle === bitNode.currentCycle,
            endedBy: cycle.endedBy.map((install) => ({
              atMs: install.installedAtMs,
              byHand: install.byHand,
              augmentationCount: install.augmentations?.length ?? null,
              augmentations: install.augmentations === null ? null : describeAugmentations(install.augmentations),
            })),
            leftForSaveAtMs: [...cycle.leftForSaveAtMs],
          })),
        };
      }),
    };
  }
}
