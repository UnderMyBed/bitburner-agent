// The dashboard's timeline of BitNodes and installs (#285, architecture §7): each BitNode played (its number and
// level), its start and how it ended, its cycles with their time online and the augmentations each install put in.
// It's the campaign report's own model (`campaign-model.ts`), kept up to date rather than read again: the page asks
// every 2 s, and the store holds about 525,000 slow snapshots a year. Each slow snapshot is folded once, and the events
// of the campaign's three kinds appended once, so a poll reads only what was stored since the last.
// - **The first read** takes the store as it was when it began (to its newest row then), in the report's order (by
//   arrival), `TIMELINE_BATCH` slow snapshots each time the page asks, so it never holds the brain up for long; the
//   page says how far it has got.
// - **After it,** each slow snapshot stored since, in the order stored. The same campaign as `npm run campaign`'s, but
//   for one edge: the brain's clock set back while it runs, where the report's order by arrival differs from the
//   order stored (the timeline's, until the brain restarts).
// Like the report, it reads only the slow snapshots' `resetInfo` and the events, so a store thinned (#283) gives the
// same timeline.
import { describeAugmentations } from "../augmentation-report.ts";
import { CAMPAIGN_EVENT_KINDS, type CampaignCycle, CampaignFold, campaignViews } from "../campaign-model.ts";
import type { Environment, StoredEvent, TelemetryStore } from "../telemetry-store.ts";

/** Slow snapshots folded each time the page asks, in the first read: a year's in 27 polls, under a minute (#285). */
export const TIMELINE_BATCH = 20_000;

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
  /** The installs that ended it, none for the BitNode's newest, or one ended by its BitNode's end. */
  endedBy: TimelineInstall[];
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
  /** Augmentations installed at its last look, or null where not recorded. */
  augmentations: number | null;
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
  /** Why it couldn't be read (the brain logs it), or null. */
  problem: string | null;
  /** In the order played. */
  bitNodes: TimelineBitNode[];
}

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
const EMPTY_VIEW: CampaignTimelineView = {
  version: 0,
  reading: null,
  slowSnapshots: 0,
  unread: 0,
  problem: null,
  bitNodes: [],
};

/**
 * The timeline over one environment of the store, read a little at a time (`read`, each time the dashboard builds its
 * status).
 */
export class CampaignTimeline {
  readonly #store: TelemetryStore;
  readonly #environment: Environment;
  readonly #batch: number;
  readonly #onError: (error: unknown) => void;
  readonly #fold = new CampaignFold();
  readonly #events: StoredEvent[] = [];
  #lastEventId = 0;
  /** The first read's end (the store's newest row as it began; null before it), and its place in order of arrival. */
  #firstReadThroughId: number | null = null;
  #after = { receivedAtMs: Number.MIN_SAFE_INTEGER, id: 0 };
  #firstReadDone = false;
  /** The newest row folded after the first read. */
  #lastId = 0;
  #version = 0;
  #view: CampaignTimelineView | null = null;
  #problem: string | null = null;
  /** Slow snapshots read from the store, every read counted: what each poll costs. */
  slowSnapshotsRead = 0;

  constructor({
    store,
    environment,
    batch = TIMELINE_BATCH,
    onError = () => {},
  }: {
    store: TelemetryStore;
    environment: Environment;
    batch?: number;
    /** A failure, once each time it changes (the brain logs it): the page shows it too. */
    onError?: (error: unknown) => void;
  }) {
    this.#store = store;
    this.#environment = environment;
    this.#batch = batch;
    this.#onError = onError;
  }

  /** The timeline, with what was stored since the last read folded in. A failure is shown in it, not thrown. */
  read(): CampaignTimelineView {
    try {
      const changed = this.#update();
      this.#problem = null;
      if (changed || this.#view === null) {
        this.#version += 1;
        this.#view = this.#viewNow();
      }
      return this.#view;
    } catch (error) {
      const problem = error instanceof Error ? error.message : String(error);
      if (problem !== this.#problem) this.#onError(error);
      this.#problem = problem;
      return { ...(this.#view ?? { ...EMPTY_VIEW, version: this.#version }), problem };
    }
  }

  /** Reads what was stored since the last read: true if anything was. */
  #update(): boolean {
    const environment = this.#environment;
    let changed = false;
    if (!this.#firstReadDone) {
      this.#firstReadThroughId ??= this.#store.lastSnapshotId();
      let count = 0;
      for (const snapshot of this.#store.iterateSlowResetInfo({
        environment,
        after: this.#after,
        throughId: this.#firstReadThroughId,
        limit: this.#batch,
      })) {
        this.#fold.add(snapshot);
        this.#after = { receivedAtMs: snapshot.receivedAtMs, id: snapshot.id };
        count += 1;
      }
      this.slowSnapshotsRead += count;
      changed = count > 0;
      if (count < this.#batch) {
        this.#firstReadDone = true;
        this.#lastId = this.#firstReadThroughId;
        changed = true;
      }
    } else {
      const stored = this.#store.slowResetInfoAfterId({ environment, afterId: this.#lastId });
      for (const snapshot of stored) {
        this.#fold.add(snapshot);
        this.#lastId = snapshot.id;
      }
      this.slowSnapshotsRead += stored.length;
      changed = stored.length > 0;
    }
    const events = this.#store.eventsAfterId({
      environment,
      kinds: CAMPAIGN_EVENT_KINDS,
      afterEventId: this.#lastEventId,
    });
    for (const { id, atMs, kind, detail } of events) {
      this.#events.push({ atMs, kind, detail });
      this.#lastEventId = id;
    }
    return changed || events.length > 0;
  }

  #viewNow(): CampaignTimelineView {
    const fold = this.#fold;
    const base = {
      version: this.#version,
      reading: this.#firstReadDone ? null : { slowSnapshots: fold.slowCount },
      slowSnapshots: fold.slowCount,
      unread: fold.unread,
      problem: null,
    };
    // While the first read goes on, its newest BitNode's ending isn't known yet: none shown till it's done.
    const campaign = this.#firstReadDone ? campaignViews(fold, this.#events) : null;
    if (campaign === null) return { ...base, bitNodes: [] };
    return {
      ...base,
      bitNodes: campaign.views.map((view) => {
        const { bitNode, ending } = view;
        return {
          name: view.name,
          startMs: bitNode.startMs,
          start: view.begunBefore ? "before the store" : bitNode.entry === "save loaded" ? "a save loaded" : null,
          ending: ending.text,
          endedAtMs: ending.atMs,
          destroyed: ending.destroyedAtMs !== null,
          wallMs: view.wallMs,
          onlineMs: bitNode.clock.onlineMs,
          soFar: ending.destroyedAtMs === null,
          wallAtLeast: bitNode.entry === "save loaded",
          onlineAtLeast: !view.startSeen,
          leftOutMs: sum(view.gapsMs),
          gapCount: view.gapsMs.length,
          cycles: view.cycles,
          installs: view.installs,
          byHand: view.byHand,
          countsAtLeast: bitNode.installedBeforeFirstLook,
          augmentations: bitNode.ownedAugs === null ? null : Object.keys(bitNode.ownedAugs).length,
          releases: [...bitNode.releases.keys()],
          cycleList: bitNode.cycleList.map((cycle) => ({
            kind: cycle.kind,
            startMs: cycle.startMs,
            onlineMs: cycle.onlineMs,
            endedBy: cycle.endedBy.map((install) => ({
              atMs: install.installedAtMs,
              byHand: install.byHand,
              augmentationCount: install.augmentations?.length ?? null,
              augmentations: install.augmentations === null ? null : describeAugmentations(install.augmentations),
            })),
          })),
        };
      }),
    };
  }
}
