// The work the owner wants (#151, owner decision 37): set on the dashboard, kept in the store so it survives restarts
// of the brain, and sent in the desired state as `work`, its focus worked out here. Choosing work is M4's planner.
import {
  NEURORECEPTOR_MANAGEMENT_IMPLANT,
  parseWork,
  type SlowSnapshotData,
  type Work,
  type WorkOutcome,
} from "@bitburner-agent/core";
import type { TelemetryStore } from "./telemetry-store.ts";

export const WORK_SETTING = "work.desired";

/** The work as the owner sets it: what, not the focus, which the brain works out (`workFocus`). */
export type OwnersWork = Omit<Work, "focus">;

/** What the dashboard shows of the work. */
export interface WorkView {
  /** What the brain sends, focus included; null while no work is managed. */
  desired: Work | null;
  /** How it went, from the connected Agent's latest fast snapshot, or null. */
  outcome: WorkOutcome | null;
}

/** `request` (`{ faction, workType }`, or null to stop managing work) as the owner's work, or why it isn't valid. */
export function parseOwnersWork(
  request: unknown,
): { ok: true; work: OwnersWork | null } | { ok: false; reason: string } {
  if (request === null) return { ok: true, work: null };
  const parsed = parseWork({ kind: "faction", ...(request as object), focus: true });
  if (!parsed.ok) return parsed;
  if (parsed.message === null) return { ok: true, work: null };
  const { focus: _focus, ...work } = parsed.message;
  return { ok: true, work };
}

/** The owner's work, or null. A value the brain didn't write fails, rather than guess. */
export function readOwnersWork(store: TelemetryStore): OwnersWork | null {
  const value = store.getSetting(WORK_SETTING);
  if (value === null) return null;
  let request: unknown;
  try {
    request = JSON.parse(value);
  } catch {
    throw new Error(`the store's ${WORK_SETTING} isn't JSON`);
  }
  const parsed = parseOwnersWork(request);
  if (!parsed.ok) throw new Error(`the store's ${WORK_SETTING} isn't valid: ${parsed.reason}`);
  return parsed.work;
}

export function writeOwnersWork(store: TelemetryStore, work: OwnersWork | null): void {
  store.setSetting(WORK_SETTING, JSON.stringify(work));
}

/**
 * Whether work goes focused (decision 37): yes, for full gains, unless the Neuroreceptor Management Implant is
 * installed, which gives them unfocused too. Before the slow snapshot says, focused.
 */
export function workFocus(slowData: SlowSnapshotData | null): boolean {
  const installed = slowData?.resetInfo?.ownedAugs;
  return !(typeof installed === "object" && installed !== null && NEURORECEPTOR_MANAGEMENT_IMPLANT in installed);
}

/** The Agent's work outcome, from its fast snapshot: only a well-formed one, as it's its word. */
export function reportedWorkOutcome(outcome: unknown): WorkOutcome | null {
  const fields = outcome as Partial<WorkOutcome> | null;
  if (
    typeof fields?.converged !== "boolean" ||
    !(fields.problem === null || typeof fields.problem === "string") ||
    ![null, "sim", "singularity", "ui"].includes(fields.backend as string | null)
  ) {
    return null;
  }
  return { converged: fields.converged, problem: fields.problem, backend: fields.backend ?? null };
}
