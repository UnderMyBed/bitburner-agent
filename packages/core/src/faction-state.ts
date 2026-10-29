/**
 * Faction state (#197, M4 phase A slice A4b): each joined faction's reputation and favour, the outstanding invitations,
 * and the queued augmentations (bought, not installed), read with each slow snapshot (snapshots.ts). The game keeps
 * reputation and favour on each `Faction` (`Faction/Faction.ts:17`, `:32`), the invitations and the queue on the player
 * (`PersonObjects/Player/PlayerObject.ts:44`, `PersonObjects/Person.ts:45`). No NS call has them without Singularity,
 * so the Agent reads them from the page's React props, Singularity, or the simulator, as its effectors do (§5.6).
 * Shared by the in-game code and the brain.
 */
import { EFFECTOR_BACKENDS, type EffectorBackend, type EffectorReport } from "./intents.ts";
import type { SlowSnapshotData } from "./snapshots.ts";

/** A joined faction: the player's reputation and favour with it, as the game holds them (not rounded). */
export interface JoinedFaction {
  name: string;
  reputation: number;
  favor: number;
}

export interface FactionState {
  /**
   * Every faction joined, a gang's too, in the reader's order, which means nothing: the page's (`Faction/ui/
   * FactionsRoot.tsx:227`, `:280-304`) or the order joined (`getPlayer().factions`).
   */
  joined: JoinedFaction[];
  /** The invitations not yet accepted, in the order received (`Player.factionInvitations`). */
  invitations: string[];
  /**
   * The augmentations bought and not yet installed, in the game's form (`Player.queuedAugmentations`): one entry per
   * purchase, NeuroFlux Governor once per level queued.
   */
  queuedAugmentations: string[];
}

/** What a faction state reader reports (#197): its effector report, and the state it read (null where it couldn't). */
export interface FactionStateReport extends EffectorReport {
  state: FactionState | null;
}

/** The slow snapshot's faction state: the backend that read it, the state, or why it couldn't be read. */
export interface FactionStateReading {
  backend: EffectorBackend;
  /** Null where it couldn't be read: never an empty state in its place. */
  state: FactionState | null;
  /** Why it couldn't be read, or a problem after reading it (the page not left as found); null for none. */
  problem: string | null;
}

/** Home worker: reads the faction state from the game's page (#197). */
export const FACTION_STATE_WORKER_NAME = "faction-state.js";

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((each) => typeof each === "string");
const isAmount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** `value` as a faction state if it's well formed, or null. */
export function parseFactionState(value: unknown): FactionState | null {
  if (typeof value !== "object" || value === null) return null;
  const { joined, invitations, queuedAugmentations } = value as Record<string, unknown>;
  if (!Array.isArray(joined) || !isStringList(invitations) || !isStringList(queuedAugmentations)) return null;
  const factions: JoinedFaction[] = [];
  for (const each of joined) {
    const { name, reputation, favor } = (each ?? {}) as Record<string, unknown>;
    if (typeof name !== "string" || !isAmount(reputation) || !isAmount(favor)) return null;
    factions.push({ name, reputation, favor });
  }
  return { joined: factions, invitations: [...invitations], queuedAugmentations: [...queuedAugmentations] };
}

/**
 * The slow snapshot's faction reading, if it's well formed, or null: absent (an older Agent), or not as the Agent
 * writes it. A reading with a problem is well formed; its state is null.
 */
export function factionReadingOf(slow: unknown): FactionStateReading | null {
  const reading = (slow as Partial<SlowSnapshotData> | null | undefined)?.factions as unknown;
  if (typeof reading !== "object" || reading === null) return null;
  const { backend, state, problem } = reading as Record<string, unknown>;
  if (!EFFECTOR_BACKENDS.includes(backend as EffectorBackend)) return null;
  if (problem !== null && typeof problem !== "string") return null;
  const parsed = state === null ? null : parseFactionState(state);
  if (state !== null && parsed === null) return null;
  // Neither isn't how the Agent reports: unread always says why. Both is a problem after the read (the way back).
  if (parsed === null && problem === null) return null;
  return { backend: backend as EffectorBackend, state: parsed, problem: problem as string | null };
}

/** The faction state the slow snapshot carries, or null: unread, absent, or not well formed (A5 and A6 decide on it). */
export function factionStateOf(slow: unknown): FactionState | null {
  return factionReadingOf(slow)?.state ?? null;
}
