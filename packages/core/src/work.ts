/**
 * Work as an activity (#151, architecture D2's player focus, owner decision 37): what the player works at, as the brain
 * wants it, converged on by the Agent when it changes and every 30 s. Faction work first; company work, crime and
 * classes follow. Shared by the in-game code and the brain; plain literals, as in factions.ts.
 */
import { FACTION_NAMES } from "./factions.ts";
import type { EffectorBackend } from "./intents.ts";

/** A faction's kinds of work, as the game names them (`Enums.ts`, `FactionWorkType`). */
export const FACTION_WORK_TYPES = ["hacking", "field", "security"] as const;
export type FactionWorkType = (typeof FACTION_WORK_TYPES)[number];

/** The work the brain wants: `focus` false leaves the player free (the game gains less unless the implant says not). */
export type Work = { kind: "faction"; faction: string; workType: FactionWorkType; focus: boolean };

/** What the Agent reports of the work, in the fast snapshot: converged or not, and why not. */
export interface WorkOutcome {
  /** The game showed the desired work, with the desired focus, at the last look. */
  converged: boolean;
  /** Why not, or a problem on the way; null for none. */
  problem: string | null;
  /** The backend of the last look (#145), or null before the first. */
  backend: EffectorBackend | null;
}

/** The augmentation that makes focus irrelevant (decision 37): installed, work goes unfocused. */
export const NEURORECEPTOR_MANAGEMENT_IMPLANT = "Neuroreceptor Management Implant";

/** Home worker: converges the player's work on faction work through the game's page (#151), focus included. */
export const FACTION_WORK_WORKER_NAME = "faction-work.js";

type Parsed<Value> = { ok: true; message: Value } | { ok: false; reason: string };

/** `work` from outside (the protocol, the dashboard, the store): the known fields only, or why it isn't valid. */
export function parseWork(value: unknown): Parsed<Work | null> {
  if (value === null || value === undefined) return { ok: true, message: null };
  if (typeof value !== "object") return { ok: false, reason: "work isn't an object" };
  const { kind, faction, workType, focus } = value as Record<string, unknown>;
  if (kind !== "faction") return { ok: false, reason: "work's kind isn't faction" };
  if (!FACTION_NAMES.includes(faction as string))
    return { ok: false, reason: "work's faction isn't one of the game's" };
  if (!FACTION_WORK_TYPES.includes(workType as FactionWorkType)) {
    return { ok: false, reason: `work's workType isn't one of ${FACTION_WORK_TYPES.join(", ")}` };
  }
  if (typeof focus !== "boolean") return { ok: false, reason: "work's focus isn't a boolean" };
  return {
    ok: true,
    message: { kind, faction: faction as string, workType: workType as FactionWorkType, focus },
  };
}
