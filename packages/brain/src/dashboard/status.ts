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
import { DEFAULT_GAP_THRESHOLD_MS, findGaps, type Gap } from "../gap-report.ts";
import { readSupervisionSwitch } from "../supervision.ts";
import type { Environment, TelemetryStore } from "../telemetry-store.ts";
import { type Alert, activeAlerts } from "./alerts.ts";

/** The gap report's window: the evidence for M2's 24 h criterion. */
export const GAP_WINDOW_MS = 24 * 60 * 60_000;
export const RECENT_EVENT_COUNT = 50;
const RECENT_RELAUNCH_COUNT = 10;

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
  /** The gap report over the last 24 h. */
  gaps: {
    sinceMs: number;
    untilMs: number;
    thresholdMs: number;
    count: number;
    longestIntervalMs: number;
    gaps: Gap[];
  };
  alerts: Alert[];
  /** The newest 50, newest first. */
  events: { atMs: number; kind: string; detail: unknown }[];
  supervision: {
    /** Paused takes precedence: while paused, nothing is relaunched either way. */
    state: "running" | "paused" | "gaveUp";
    paused: boolean;
    gaveUpAtMs: number | null;
    /** The supervisor's newest relaunches (#94), newest first. */
    relaunches: { atMs: number; detail: unknown }[];
  };
}

export interface DashboardStatusOptions {
  store: TelemetryStore;
  environment: Environment;
  brainRelease: string;
  brainStartedAtMs: number;
  nowMs: number;
}

export function buildDashboardStatus({
  store,
  environment,
  brainRelease,
  brainStartedAtMs,
  nowMs,
}: DashboardStatusOptions): DashboardStatus {
  const sinceStart = { environment, sinceMs: brainStartedAtMs };
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
  const deployEvent = store.latestEvent({ ...sinceStart, kinds: ["deployed", "deployFailed"] });
  const supervision = readSupervisionSwitch(store);

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
    gaps: { ...gapWindow, ...gapReport },
    alerts: activeAlerts({
      nowMs,
      brainStartedAtMs,
      lastFastSnapshotAtMs: latestOfTier.fast?.receivedAtMs ?? null,
      versionDrift: versionDriftEvent
        ? { atMs: versionDriftEvent.atMs, detail: String((versionDriftEvent.detail as { detail?: unknown }).detail) }
        : null,
      lastDeploy: deployEvent
        ? {
            atMs: deployEvent.atMs,
            failed: deployEvent.kind === "deployFailed",
            detail: String((deployEvent.detail as { reason?: unknown }).reason ?? ""),
          }
        : null,
      supervisionGaveUpAtMs: supervision.gaveUpAtMs,
    }),
    events: store
      .recentEvents({ environment, limit: RECENT_EVENT_COUNT })
      .map(({ atMs, kind, detail }) => ({ atMs, kind, detail })),
    supervision: {
      state: supervision.paused ? "paused" : supervision.gaveUpAtMs !== null ? "gaveUp" : "running",
      paused: supervision.paused,
      gaveUpAtMs: supervision.gaveUpAtMs,
      relaunches: store
        .recentEvents({ environment, limit: RECENT_RELAUNCH_COUNT, kinds: ["relaunch"] })
        .map(({ atMs, detail }) => ({ atMs, detail })),
    },
  };
}
