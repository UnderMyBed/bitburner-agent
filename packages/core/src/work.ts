/**
 * Work as an activity (#151, architecture D2's player focus, owner decision 37): what the player works at, as the brain
 * wants it, converged on by the Agent when it changes and every 30 s. Faction work, company work (#153), crime (#156)
 * and classes (#158). Shared by the in-game code and the brain; plain literals, as in factions.ts.
 */
import { CLASS_LOCATION_NAMES, CLASS_LOCATIONS, CLASS_TYPE_NAMES, CLASS_TYPES } from "./classes.ts";
import { COMPANY_NAMES, JOB_FIELDS } from "./companies.ts";
import { CRIME_NAMES } from "./crimes.ts";
import { FACTION_NAMES } from "./factions.ts";
import type { EffectorBackend } from "./intents.ts";

/** A faction's kinds of work, as the game names them (`Enums.ts`, `FactionWorkType`). */
export const FACTION_WORK_TYPES = ["hacking", "field", "security"] as const;
export type FactionWorkType = (typeof FACTION_WORK_TYPES)[number];

/**
 * The work the brain wants: faction work (#151), company work in a job field (#153), the job got first if need be, or
 * a crime, committed again and again (#156), or a class at a university or gym (#158, classes.ts). `focus` false
 * leaves the player free (the game gains less unless the implant says not, or for a class or part-time job).
 */
export type Work =
  | { kind: "faction"; faction: string; workType: FactionWorkType; focus: boolean }
  | { kind: "company"; company: string; field: string; focus: boolean }
  | { kind: "crime"; crime: string; focus: boolean }
  | { kind: "class"; location: string; classType: string; focus: boolean };

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

/** Home worker: converges the player's work on company work through the game's page (#153), focus included. */
export const COMPANY_WORK_WORKER_NAME = "company-work.js";

/** Home worker: converges the player's work on a crime through the game's page (#156), focus included. */
export const CRIME_WORK_WORKER_NAME = "crime-work.js";

/** Home worker: converges the player's work on a class through the game's page (#158), focus included. */
export const CLASS_WORK_WORKER_NAME = "class-work.js";

type Parsed<Value> = { ok: true; message: Value } | { ok: false; reason: string };

/** `work` from outside (the protocol, the dashboard, the store): the known fields only, or why it isn't valid. */
export function parseWork(value: unknown): Parsed<Work | null> {
  if (value === null || value === undefined) return { ok: true, message: null };
  if (typeof value !== "object") return { ok: false, reason: "work isn't an object" };
  const { kind, faction, workType, company, field, crime, location, classType, focus } = value as Record<
    string,
    unknown
  >;
  if (typeof focus !== "boolean") return { ok: false, reason: "work's focus isn't a boolean" };
  if (kind === "company") {
    if (!COMPANY_NAMES.includes(company as string)) {
      return { ok: false, reason: "work's company isn't one of the game's" };
    }
    if (typeof field !== "string" || !Object.hasOwn(JOB_FIELDS, field)) {
      return { ok: false, reason: "work's field isn't one of the game's job fields" };
    }
    return { ok: true, message: { kind, company: company as string, field, focus } };
  }
  if (kind === "crime") {
    if (!CRIME_NAMES.includes(crime as string)) return { ok: false, reason: "work's crime isn't one of the game's" };
    return { ok: true, message: { kind, crime: crime as string, focus } };
  }
  if (kind === "class") {
    if (!CLASS_LOCATION_NAMES.includes(location as string)) {
      return { ok: false, reason: "work's location isn't one of the game's universities or gyms" };
    }
    if (!CLASS_TYPE_NAMES.includes(classType as string)) {
      return { ok: false, reason: "work's classType isn't one of the game's courses or gym stats" };
    }
    // A course only at a university, a stat only at a gym (`Locations/ui/UniversityLocation.tsx:51-82`, `GymLocation.tsx:42-53`).
    if (CLASS_TYPES[classType as string]?.at !== CLASS_LOCATIONS[location as string]?.kind) {
      return { ok: false, reason: `work's classType isn't taught at ${location as string}` };
    }
    return { ok: true, message: { kind, location: location as string, classType: classType as string, focus } };
  }
  if (kind !== "faction") return { ok: false, reason: "work's kind isn't faction, company, crime or class" };
  if (!FACTION_NAMES.includes(faction as string)) {
    return { ok: false, reason: "work's faction isn't one of the game's" };
  }
  if (!FACTION_WORK_TYPES.includes(workType as FactionWorkType)) {
    return { ok: false, reason: `work's workType isn't one of ${FACTION_WORK_TYPES.join(", ")}` };
  }
  return { ok: true, message: { kind, faction: faction as string, workType: workType as FactionWorkType, focus } };
}
