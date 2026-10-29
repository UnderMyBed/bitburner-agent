// The work the owner wants (#151, owner decision 37): set on the dashboard, kept in the store so it survives restarts
// of the brain, and sent in the desired state as `work`, its focus worked out here. With none set, the brain sends its
// own faction work (#203, ./factions.ts).
import {
  EFFECTOR_BACKENDS,
  NEURORECEPTOR_MANAGEMENT_IMPLANT,
  PART_TIME_JOB_FIELDS,
  parseWork,
  type SlowSnapshotData,
  type Work,
  type WorkOutcome,
  type WorkPromotion,
} from "@bitburner-agent/core";
import type { TelemetryStore } from "./telemetry-store.ts";

export const WORK_SETTING = "work.desired";

/** `Omit` over each member of a union, not over their common fields. */
type OmitEach<Union, Key extends PropertyKey> = Union extends unknown ? Omit<Union, Key> : never;

/** The work as the owner sets it: what, not the focus, which the brain works out (`workFocus`). */
export type OwnersWork = OmitEach<Work, "focus">;

/** What the dashboard shows of the work. */
export interface WorkView {
  /**
   * The work, focus included, as the brain sends it once it has the connected Agent's slow snapshot (and not while it
   * holds): the owner's, or else the brain's faction work (#203); null while no work is managed.
   */
  desired: Work | null;
  /** Whose it is: the owner's (set on the dashboard), the brain's faction work (#203), or null with none. */
  source: "owner" | "brain" | null;
  /** How it went, from the connected Agent's latest fast snapshot, or null. */
  outcome: WorkOutcome | null;
}

/**
 * `request` (`{ faction, workType }`, `{ kind: "company", company, field }`, `{ kind: "crime", crime }`,
 * `{ kind: "class", location, classType }`, or null to stop managing work) as the owner's work, or why it isn't valid.
 */
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
 * Whether work goes focused (decision 37): yes, for full gains, unless they come unfocused too: the Neuroreceptor
 * Management Implant installed, a part-time job (#153), or a class (#158: `ClassWork` and `calculateClassEarnings`
 * have no focus penalty, `Work/Formulas.ts:108-121`). No work is sent before the slow snapshot says; the view shows
 * focused before it, unless it's part-time or a class.
 */
export function workFocus(work: OwnersWork, slowData: SlowSnapshotData | null): boolean {
  if (work.kind === "class") return false;
  if (work.kind === "company" && PART_TIME_JOB_FIELDS.includes(work.field)) return false;
  const installed = slowData?.resetInfo?.ownedAugs;
  return !(typeof installed === "object" && installed !== null && NEURORECEPTOR_MANAGEMENT_IMPLANT in installed);
}

/** The Agent's work outcome, from its fast snapshot: only a well-formed one, as it's its word. */
export function reportedWorkOutcome(outcome: unknown): WorkOutcome | null {
  const fields = outcome as Partial<WorkOutcome> | null;
  if (
    typeof fields?.converged !== "boolean" ||
    !(fields.problem === null || typeof fields.problem === "string") ||
    !(fields.backend === null || (EFFECTOR_BACKENDS as readonly string[]).includes(fields.backend as string))
  ) {
    return null;
  }
  const promotion = reportedPromotion(fields.promotion);
  return {
    converged: fields.converged,
    problem: fields.problem,
    backend: fields.backend ?? null,
    ...(promotion === null ? {} : { promotion }),
  };
}

/** The latest promotion a work outcome reports (#155): only a well-formed one, its known fields only; else null. */
export function reportedPromotion(promotion: unknown): WorkPromotion | null {
  const fields = promotion as Partial<WorkPromotion> | null | undefined;
  const { company, from, to, gameTimeMs } = fields ?? {};
  if (typeof company !== "string" || typeof from !== "string" || typeof to !== "string") return null;
  if (typeof gameTimeMs !== "number" || !Number.isFinite(gameTimeMs)) return null;
  return { company, from, to, gameTimeMs };
}
