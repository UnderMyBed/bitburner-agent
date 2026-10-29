// The dashboard's status (#93): everything the page shows, read from the store whenever it's asked for. The alerts are
// rules over the same reads (alerts.ts), so nothing here keeps state.
import {
  type FastSnapshotData,
  type GameInfo,
  gameDrift,
  type MediumSnapshotData,
  SNAPSHOT_TIERS,
  type SnapshotTier,
} from "@bitburner-agent/core";
import type { HackLoopView, HomeRamView, IntentView, ProgramsView } from "../desired-state.ts";
import { DEFAULT_GAP_THRESHOLD_MS, findGaps, type Gap } from "../gap-report.ts";
import { RELAUNCH_EVENT_KIND, readSupervisionSwitch, SUPERVISION_GAVE_UP_EVENT_KIND } from "../supervision.ts";
import type { Environment, TelemetryStore } from "../telemetry-store.ts";
import type { WorkView } from "../work.ts";
import { type Alert, activeAlerts, type IncomeFacts } from "./alerts.ts";

/** The gap report's window on the dashboard: the last 24 h. */
export const GAP_WINDOW_MS = 24 * 60 * 60_000;
export const RECENT_EVENT_COUNT = 50;
/** The newest gaps listed; the count and total cover them all. */
export const LISTED_GAP_COUNT = 20;
const RECENT_RELAUNCH_COUNT = 10;
/** The event the brain records as it starts: everything stored after it is this run of the brain. */
export const BRAIN_STARTED_EVENT_KIND = "brainStarted";

export interface DashboardStatus {
  nowMs: number;
  environment: Environment;
  brainRelease: string;
  brainStartedAtMs: number;
  /** As of this run of the brain: an Agent connected before it started isn't connected now. */
  agent: {
    connected: boolean;
    /** When it connected, or when it last disconnected; null if no Agent has connected since the brain started. */
    sinceMs: number | null;
    agentSessionId: string | null;
    deploymentId: string | null;
    game: GameInfo | null;
    /** How the Agent's game differs from the pinned one, or null. */
    versionDrift: string | null;
  };
  /** Each tier's last snapshot, from any run of the brain, or null if there's none. */
  tiers: Record<SnapshotTier, { receivedAtMs: number; ageMs: number } | null>;
  /** From the latest fast and medium snapshots; null where they don't have it. */
  values: {
    money: number | null;
    hackingLevel: number | null;
    homeRamUsed: number | null;
    homeMaxRam: number | null;
    homeScripts: number | null;
    pageHeapUsedBytes: number | null;
    degradedTiers: SnapshotTier[];
  };
  /** The gap report over the last 24 h: every gap counted, the newest 20 listed (newest first). */
  gaps: {
    sinceMs: number;
    untilMs: number;
    thresholdMs: number;
    /** Fast snapshots in the window. */
    count: number;
    longestIntervalMs: number;
    gapCount: number;
    totalGapMs: number;
    newestGaps: Gap[];
  };
  alerts: Alert[];
  /** The newest 50, newest first. */
  events: { atMs: number; kind: string; detail: unknown }[];
  supervision: {
    /**
     * `off` where this brain doesn't supervise (only Steam's game is, on Windows). Otherwise paused takes precedence:
     * while paused, nothing is relaunched either way.
     */
    state: "off" | "running" | "paused" | "gaveUp";
    paused: boolean;
    gaveUpAtMs: number | null;
    /** The supervisor's newest relaunches (#94), newest first. */
    relaunches: { atMs: number; detail: unknown }[];
  };
  /** The hack loop (#134): its switch, and what the brain has set for the Agent (its controller's view). */
  hackLoop: HackLoopView;
  /** The hacking programs (#136): owned, being bought, or what they wait for. */
  programs: ProgramsView;
  /** Home's RAM (#138): its size, the upgrade being bought, or what it waits for. */
  homeRam: HomeRamView;
  /** The intents sent (#141), in order, each with its source and how it went. */
  intents: IntentView[];
  /** The work the brain manages (#151), and how the Agent last reported it. */
  work: WorkView;
}

export interface DashboardStatusOptions {
  store: TelemetryStore;
  environment: Environment;
  brainRelease: string;
  brainStartedAtMs: number;
  /** The id of this run's `brainStarted` event: "since the brain started" is every event stored after it. */
  brainStartedEventId: number;
  /** Whether this brain runs the supervisor (#94). */
  supervising: boolean;
  /** The hack loop's controller's view (#134): what it set, not worked out again here. */
  hackLoop: HackLoopView;
  /** The hacking programs' view (#136), likewise. */
  programs: ProgramsView;
  /** Home RAM's view (#138), likewise. */
  homeRam: HomeRamView;
  /** The intents' view (#141), likewise. */
  intents: IntentView[];
  /** The work's view (#151), likewise. */
  work: WorkView;
  /** The money's last rise (#184), from the brain's `IncomeWatch`, for the `incomeStalled` alert. */
  income: IncomeFacts | null;
  nowMs: number;
}

/** A field of an event's detail as text, or "" if it isn't there. */
const detailText = (detail: unknown, field: string) => {
  const value = (detail as Record<string, unknown> | null)?.[field];
  return value === undefined || value === null ? "" : String(value);
};

export function buildDashboardStatus({
  store,
  environment,
  brainRelease,
  brainStartedAtMs,
  brainStartedEventId,
  supervising,
  hackLoop,
  programs,
  homeRam,
  intents,
  work,
  income,
  nowMs,
}: DashboardStatusOptions): DashboardStatus {
  const sinceStart = { environment, afterEventId: brainStartedEventId };
  const latestOfTier = Object.fromEntries(
    SNAPSHOT_TIERS.map((tier) => [tier, store.latestSnapshot({ environment, tier })]),
  ) as Record<SnapshotTier, ReturnType<TelemetryStore["latestSnapshot"]>>;
  const fast = latestOfTier.fast?.data as FastSnapshotData | undefined;
  const medium = latestOfTier.medium?.data as MediumSnapshotData | undefined;

  const connectionEvent = store.latestEvent({ ...sinceStart, kinds: ["agentConnected", "agentDisconnected"] });
  // The session, deployment and game come from the connect; a disconnect names only the session.
  const connectEvent = store.latestEvent({ ...sinceStart, kinds: ["agentConnected"] });
  const connected = connectEvent?.detail as
    | { agentSessionId: string; deploymentId: string; game: GameInfo }
    | undefined;

  const versionDriftEvent = store.latestEvent({ ...sinceStart, kinds: ["versionDrift"] });
  // A connection that finds the deployment already in place resolves an earlier failure as much as a new deploy does.
  const deployEvent = store.latestEvent({ ...sinceStart, kinds: ["deployed", "deploymentCurrent", "deployFailed"] });
  const supervision = readSupervisionSwitch(store);
  // The give-up's cause (#127): its event, from any run of the brain (a give-up lasts until resumed). Only the event
  // recorded with this give-up, so an older one can't give the wrong cause if recording this one failed.
  const gaveUpEvent = store.latestEvent({ environment, kinds: [SUPERVISION_GAVE_UP_EVENT_KIND], afterEventId: 0 });
  const gaveUpCause = gaveUpEvent?.atMs === supervision.gaveUpAtMs ? gaveUpEvent.detail : null;

  const gapWindow = { sinceMs: nowMs - GAP_WINDOW_MS, untilMs: nowMs, thresholdMs: DEFAULT_GAP_THRESHOLD_MS };
  const gapReport = findGaps(store.fastSnapshotTimes({ environment, ...gapWindow }), gapWindow);

  return {
    nowMs,
    environment,
    brainRelease,
    brainStartedAtMs,
    agent: {
      connected: connectionEvent?.kind === "agentConnected",
      sinceMs: connectionEvent?.atMs ?? null,
      agentSessionId: connected?.agentSessionId ?? null,
      deploymentId: connected?.deploymentId ?? null,
      game: connected?.game ?? null,
      versionDrift: connected ? gameDrift(connected.game) : null,
    },
    tiers: Object.fromEntries(
      SNAPSHOT_TIERS.map((tier) => {
        const latest = latestOfTier[tier];
        return [tier, latest ? { receivedAtMs: latest.receivedAtMs, ageMs: nowMs - latest.receivedAtMs } : null];
      }),
    ) as DashboardStatus["tiers"],
    values: {
      money: fast?.game?.money ?? null,
      hackingLevel: (medium?.player?.skills as { hacking?: number } | undefined)?.hacking ?? null,
      homeRamUsed: fast?.game?.homeRamUsed ?? null,
      homeMaxRam: fast?.game?.homeMaxRam ?? null,
      homeScripts: fast?.game?.homeProcesses.length ?? null,
      pageHeapUsedBytes: fast?.pageHeapUsedBytes ?? null,
      degradedTiers: fast?.degradedTiers ?? [],
    },
    gaps: {
      ...gapWindow,
      count: gapReport.count,
      longestIntervalMs: gapReport.longestIntervalMs,
      gapCount: gapReport.gaps.length,
      totalGapMs: gapReport.gaps.reduce((total, gap) => total + gap.lengthMs, 0),
      newestGaps: gapReport.gaps.slice(-LISTED_GAP_COUNT).reverse(),
    },
    alerts: activeAlerts({
      nowMs,
      brainStartedAtMs,
      lastFastSnapshotAtMs: latestOfTier.fast?.receivedAtMs ?? null,
      versionDrift: versionDriftEvent
        ? { atMs: versionDriftEvent.atMs, detail: detailText(versionDriftEvent.detail, "detail") }
        : null,
      lastDeploy: deployEvent
        ? {
            atMs: deployEvent.atMs,
            failed: deployEvent.kind === "deployFailed",
            detail: detailText(deployEvent.detail, "reason"),
          }
        : null,
      supervisionGaveUp: supervision.gaveUpAtMs === null ? null : { atMs: supervision.gaveUpAtMs, detail: gaveUpCause },
      // Only what's well formed: the snapshot is the Agent's word.
      blockingDialog: typeof fast?.dialogs?.blocking === "string" ? fast.dialogs.blocking : null,
      intentOutcomes: (Array.isArray(fast?.intents) ? fast.intents : []).filter(
        (outcome) => typeof outcome?.id === "string" && typeof outcome.tries === "number",
      ),
      hackLoopTarget: hackLoop.enabled ? hackLoop.target : null,
      income,
    }),
    events: store
      .recentEvents({ environment, limit: RECENT_EVENT_COUNT })
      .map(({ atMs, kind, detail }) => ({ atMs, kind, detail })),
    supervision: {
      state: !supervising
        ? "off"
        : supervision.paused
          ? "paused"
          : supervision.gaveUpAtMs !== null
            ? "gaveUp"
            : "running",
      paused: supervision.paused,
      gaveUpAtMs: supervision.gaveUpAtMs,
      relaunches: store
        .recentEvents({ environment, limit: RECENT_RELAUNCH_COUNT, kinds: [RELAUNCH_EVENT_KIND] })
        .map(({ atMs, detail }) => ({ atMs, detail })),
    },
    hackLoop,
    programs,
    homeRam,
    intents,
    work,
  };
}
