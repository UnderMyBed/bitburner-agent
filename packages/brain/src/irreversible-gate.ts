// The gate before an irreversible intent (R2, R8, #147): its guard on consecutive medium snapshots from the connected
// Agent, then a save backup, then it goes out. The desired state's controller holds one gate per irreversible intent in
// the owner's queue, and sends only the intents it lets through.
// - One irreversible intent at a time, in the queue's order: the next one's guard is judged only once the first is done
//   or cancelled, so two that conflict (Sector-12 and Chongqing, enemies) never go out together.
// - The guard fails closed: a medium snapshot it can't read holds the intent, with the reason.
// - Each backup is asked for by one request, and only that request's answer counts: a backup asked for before the
//   count started again releases nothing.
// - Once out, its guard is still judged on every medium snapshot: failing, the intent is withdrawn. Not done after
//   `RELEASED_SNAPSHOTS` (about 10 minutes, a try every 30 s), it's withdrawn too, and goes out again only past a new
//   backup, so the backup is never older than that when the game acts.
// - After a failed backup, the guard must hold on `GUARD_SNAPSHOTS_AFTER_FAILED_BACKUP` before the next is asked for,
//   so a backup that can't be taken (no Remote File API connection) is tried once a minute, not every 20 s.
// - Everything here is in memory: a disconnect, a new Agent or a restarted brain starts every gate again, the safe way.
import { FACTION_ENEMIES, type Intent, isIrreversibleIntent, type MediumSnapshotData } from "@bitburner-agent/core";
import type { SaveBackupEvent } from "./save-backups.ts";

/** Consecutive medium snapshots an irreversible intent's guard must hold on before its backup (R8). */
export const GUARD_SNAPSHOTS = 2;
/** The same after a failed backup: a minute of medium snapshots before the next is asked for. */
export const GUARD_SNAPSHOTS_AFTER_FAILED_BACKUP = 6;
/** Medium snapshots a released intent may stay out undone before it needs a new backup: about 10 minutes. */
export const RELEASED_SNAPSHOTS = 60;

/** What the gates need of the brain's save backups: one now, and its own event (`SaveBackups.backupNow`). */
export interface BackupsBeforeIrreversibleIntents {
  backupNow(): Promise<SaveBackupEvent>;
}

/** Where one irreversible intent is on its way out. */
interface Gate {
  stage: "counting" | "takingBackup" | "released";
  /** Consecutive medium snapshots on which its guard held, while counting. */
  heldSnapshots: number;
  /** The snapshots the count needs now: more after a failed backup. */
  snapshotsNeeded: number;
  /** Why its guard failed on the latest medium snapshot, or null. */
  guardFailure: string | null;
  /** Why the count started again (a failed backup, a release that went stale), or null. */
  restartedBecause: string | null;
  /** The request of the backup being taken: only its answer counts. */
  backupRequest: object | null;
  /** Medium snapshots since it was released. */
  releasedSnapshots: number;
}

const newGate = (): Gate => ({
  stage: "counting",
  heldSnapshots: 0,
  snapshotsNeeded: GUARD_SNAPSHOTS,
  guardFailure: null,
  restartedBecause: null,
  backupRequest: null,
  releasedSnapshots: 0,
});

/**
 * Why `intent`'s guard doesn't hold on `medium`, or null if it does (R2), `queue` being the owner's manual queue.
 * - Joining a faction: none of its enemies is joined (the game refuses a banned faction then:
 *   `Faction/ui/FactionsRoot.tsx:89`, Singularity's `joinFaction`). A snapshot without the list of factions joined fails
 *   it: the Agent's word, so never assumed.
 * - Installing augmentations (#164): nothing queued before it is still undone. It resets the game, so what was queued
 *   before it (a purchase, say) was for this game, and goes first. The augmentations queued can't be the guard: no NS
 *   call shows them without Singularity. Done intents leave the queue, so the first one left is the one undone.
 */
export function guardFailure(intent: Intent, medium: MediumSnapshotData, queue: Intent[]): string | null {
  if (intent.action === "installAugmentations") {
    const first = queue[0];
    return first === undefined || first.id === intent.id ? null : `${first.id}, queued before it, isn't done`;
  }
  if (intent.action !== "joinFaction") return null;
  const joined = (medium.player as { factions?: unknown } | undefined)?.factions;
  if (!Array.isArray(joined)) return "the medium snapshot has no list of the factions joined";
  const joinedEnemy = (FACTION_ENEMIES[intent.args.faction] ?? []).find((enemy) => joined.includes(enemy));
  return joinedEnemy === undefined ? null : `${intent.args.faction}'s enemy ${joinedEnemy} is joined`;
}

export class IrreversibleIntentGates {
  readonly #saveBackups: BackupsBeforeIrreversibleIntents | null;
  /** Called when a backup's answer changes what goes out. */
  readonly #onChange: () => void;
  /** Each irreversible intent in the queue, in its order. */
  #gates = new Map<string, Gate>();

  constructor({
    saveBackups,
    onChange,
  }: {
    saveBackups: BackupsBeforeIrreversibleIntents | null;
    onChange: () => void;
  }) {
    this.#saveBackups = saveBackups;
    this.#onChange = onChange;
  }

  /** The queue now: a gate for each irreversible intent in it, in its order; those that left are dropped. */
  sync(queue: Intent[]): void {
    const kept = new Map<string, Gate>();
    for (const intent of queue.filter(isIrreversibleIntent))
      kept.set(intent.id, this.#gates.get(intent.id) ?? newGate());
    this.#gates = kept;
  }

  /** The connected Agent changed: every gate starts again, and a backup still being taken releases nothing. */
  forget(): void {
    this.#gates = new Map([...this.#gates.keys()].map((id) => [id, newGate()]));
  }

  /** Whether `id` may go out: any intent that isn't irreversible, or one its gate has released. */
  isReleased(id: string): boolean {
    const gate = this.#gates.get(id);
    return gate === undefined || gate.stage === "released";
  }

  /** A medium snapshot from the connected Agent: the first gate's guard, its backup, or its release going stale. */
  mediumSnapshot(medium: MediumSnapshotData, queue: Intent[]): void {
    const [first] = this.#gates;
    if (first === undefined) return;
    const [id, gate] = first;
    const intent = queue.find((each) => each.id === id);
    if (intent === undefined) return;
    gate.guardFailure = guardFailure(intent, medium, queue);
    if (gate.guardFailure !== null) {
      this.#restart(gate, null);
      return;
    }
    if (gate.stage === "released") {
      gate.releasedSnapshots += 1;
      if (gate.releasedSnapshots >= RELEASED_SNAPSHOTS) {
        this.#restart(gate, `out ${RELEASED_SNAPSHOTS} medium snapshots without being done, it needs a new backup`);
      }
      return;
    }
    if (gate.stage !== "counting") return;
    gate.heldSnapshots += 1;
    if (gate.heldSnapshots >= gate.snapshotsNeeded) this.#takeBackup(id, gate);
  }

  /** What `id` waits for before it goes out, worded to follow "not sent: ", or null if it isn't held. */
  waitingFor(id: string): string | null {
    const gate = this.#gates.get(id);
    if (gate === undefined || gate.stage === "released") return null;
    const [firstId] = this.#gates.keys();
    if (id !== firstId) return `waiting for ${firstId} first: one irreversible intent at a time`;
    if (gate.guardFailure !== null) return `held: ${gate.guardFailure}`;
    if (this.#saveBackups === null) return "waiting for a save backup, which this brain doesn't take";
    if (gate.stage === "takingBackup") return "waiting for a save backup";
    const count =
      `waiting for the guard to hold on ${gate.snapshotsNeeded} consecutive medium snapshots ` +
      `(${gate.heldSnapshots} so far)`;
    return gate.restartedBecause === null ? count : `${count}: ${gate.restartedBecause}`;
  }

  /** Back to counting from none: a backup being taken releases nothing, and a released intent is withdrawn. */
  #restart(gate: Gate, because: string | null): void {
    gate.stage = "counting";
    gate.heldSnapshots = 0;
    gate.backupRequest = null;
    gate.releasedSnapshots = 0;
    if (because !== null) gate.restartedBecause = because;
  }

  /** Asks for the backup before `gate`'s intent: on success it's released; on failure the count starts again. */
  #takeBackup(id: string, gate: Gate): void {
    if (this.#saveBackups === null) return;
    gate.stage = "takingBackup";
    const request = {};
    gate.backupRequest = request;
    void this.#saveBackups.backupNow().then((event) => {
      // Forgotten (a disconnect, the intent gone) or started again since: this answer is for nothing now.
      if (this.#gates.get(id) !== gate || gate.backupRequest !== request) return;
      gate.backupRequest = null;
      if ("file" in event) {
        gate.stage = "released";
        gate.restartedBecause = null;
        gate.snapshotsNeeded = GUARD_SNAPSHOTS;
      } else {
        this.#restart(gate, `the save backup failed: ${event.failure}`);
        gate.snapshotsNeeded = GUARD_SNAPSHOTS_AFTER_FAILED_BACKUP;
      }
      this.#onChange();
    });
  }
}
