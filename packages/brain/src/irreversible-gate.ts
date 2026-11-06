// The gate before an irreversible intent (R2, R8, #147): its guard on consecutive medium snapshots from the connected
// Agent, then a save backup, then it goes out. The desired state's controller holds one gate per irreversible intent it
// judges (its `#judgedQueue`: the owner's queue, the brain's destroy and install, then the rules' irreversible
// intents, #269), and sends only the intents it lets through.
// - One irreversible intent at a time, in the queue's order: the next one's guard is judged only once the first is done
//   or cancelled, so two that conflict (Sector-12 and Chongqing, enemies) never go out together. A gate that is no
//   longer first (an intent queued ahead of it since: the owner's, ahead of a rule's) goes back to counting, out or
//   not: only the first is judged, so it's withdrawn, and goes out again only once first, past its guard and a new
//   backup.
// - The guard fails closed: a medium snapshot it can't read holds the intent, with the reason.
// - Each backup is asked for by one request, and only that request's answer counts: a backup asked for before the
//   count started again releases nothing.
// - A reset's guard on the queue (nothing queued before it undone) reads only the brain's queue, so it's judged on
//   every update too, not just on medium snapshots (#271): the owner's queuing ahead of the brain's own install or
//   destroy withdraws it at once, out or not, and it needs its guard and a new backup again.
// - Once out, its guard is still judged on every medium snapshot: failing, the intent is withdrawn. Not done after
//   `RELEASED_SNAPSHOTS` (about 10 minutes, a try every 30 s), it's withdrawn too, and goes out again only past a new
//   backup, so the backup is never older than that when the game acts.
// - After a failed backup, the guard must hold on `GUARD_SNAPSHOTS_AFTER_FAILED_BACKUP` before the next is asked for,
//   so a backup that can't be taken (no Remote File API connection) is tried once a minute, not every 20 s.
// - Everything here is in memory: a disconnect, a new Agent or a restarted brain starts every gate again, the safe way.
import {
  FACTION_ENEMIES,
  type Intent,
  isIrreversibleIntent,
  type MediumSnapshotData,
  resetsTheGame,
  type StaticSnapshotData,
  WORLD_DAEMON,
  worldDaemonProblem,
} from "@bitburner-agent/core";
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
  /** Why its guard's snapshot part failed on the latest medium snapshot, or null. */
  guardFailure: string | null;
  /** Why its guard's queue part failed (#271), judged on every update as well as on medium snapshots, or null. */
  queueFailure: string | null;
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
  queueFailure: null,
  restartedBecause: null,
  backupRequest: null,
  releasedSnapshots: 0,
});

/**
 * Why `intent`'s guard doesn't hold on `medium`, or null if it does (R2), `queue` being the queue the gates judge
 * (the owner's first) and `staticData` the connected Agent's static snapshot. A snapshot without what a guard reads
 * fails it: the Agent's word, so never assumed.
 * - Joining a faction: none of its enemies is joined (the game refuses a banned faction then:
 *   `Faction/ui/FactionsRoot.tsx:89`, Singularity's `joinFaction`).
 * - An intent that resets the game, installing augmentations (#164) or destroying the BitNode (#175): nothing queued
 *   before it is still undone. What was queued before it (a purchase, say) was for this game, and goes first. The
 *   augmentations queued can't be an install's guard: no NS call shows them without Singularity. Done intents leave
 *   the queue, so the first one left is the one undone.
 * - Destroying the BitNode, then: w0r1d_d43m0n's preconditions (core's `worldDaemonProblem`), so it's held before any
 *   backup. Reachable: among the medium snapshot's servers, which `scan` finds from home only once The Red Pill is
 *   installed. Root, there too, and the hacking level against its required level, from the static snapshot: 3000 times
 *   the BitNode's `WorldDaemonDifficulty` (`Server/ServerHelpers.ts:383-385`), fixed for the BitNode. The game also
 *   allows a destroy with every Black Op done (`NetscriptFunctions/Singularity.ts:1176-1186`); the guard doesn't count
 *   that route, the conservative direction.
 */
export function guardFailure(
  intent: Intent,
  medium: MediumSnapshotData,
  queue: Intent[],
  staticData: StaticSnapshotData | null,
): string | null {
  return queueGuardFailure(intent, queue) ?? snapshotGuardFailure(intent, medium, staticData);
}

/** The part of `intent`'s guard that reads the snapshots, or null: a join's enemies, w0r1d_d43m0n's preconditions. */
export function snapshotGuardFailure(
  intent: Intent,
  medium: MediumSnapshotData,
  staticData: StaticSnapshotData | null,
): string | null {
  if (intent.action === "destroyBitNode") return worldDaemonGuardFailure(medium, staticData);
  if (intent.action !== "joinFaction") return null;
  const joined = (medium.player as { factions?: unknown } | undefined)?.factions;
  if (!Array.isArray(joined)) return "the medium snapshot has no list of the factions joined";
  const joinedEnemy = (FACTION_ENEMIES[intent.args.faction] ?? []).find((enemy) => joined.includes(enemy));
  return joinedEnemy === undefined ? null : `${intent.args.faction}'s enemy ${joinedEnemy} is joined`;
}

/**
 * The part of `intent`'s guard that reads only the queue, not a snapshot (#271), or null: a reset's, nothing queued
 * before it undone. Judged on every update as well as on medium snapshots, as the owner's queuing can put an intent
 * ahead of the brain's own install or destroy (#210, #215) at any time. The join's guard and w0r1d_d43m0n's read the
 * snapshots, so they wait for the next.
 */
export function queueGuardFailure(intent: Intent, queue: Intent[]): string | null {
  if (!resetsTheGame(intent)) return null;
  const first = queue[0];
  return first !== undefined && first.id !== intent.id ? `${first.id}, queued before it, isn't done` : null;
}

/** w0r1d_d43m0n's preconditions on the snapshots (#175): `worldDaemonProblem`, or what a snapshot lacks for them. */
function worldDaemonGuardFailure(medium: MediumSnapshotData, staticData: StaticSnapshotData | null): string | null {
  const daemon = medium.servers?.find((server) => server.hostname === WORLD_DAEMON);
  if (daemon === undefined) return worldDaemonProblem(null);
  const hackingLevel = (medium.player?.skills as { hacking?: unknown } | undefined)?.hacking;
  if (typeof hackingLevel !== "number") return "the medium snapshot has no hacking level";
  const requiredHackingLevel = staticData?.servers?.find(
    (server) => server.hostname === WORLD_DAEMON,
  )?.requiredHackingSkill;
  if (typeof requiredHackingLevel !== "number") {
    return `the static snapshot has no required hacking level for ${WORLD_DAEMON}`;
  }
  return worldDaemonProblem({ rooted: daemon.hasAdminRights === true, hackingLevel, requiredHackingLevel });
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

  /**
   * The queue now: a gate for each irreversible intent in it, in its order; those that left are dropped. One no longer
   * first goes back to counting (#269 review): only the first is judged, so one left out or counting there would go on
   * unwatched, and go out beside the first, or on a stale release. The first's guard on the queue
   * (`queueGuardFailure`) is judged here too, on every update (#271): failing, it goes back to counting, out or not,
   * so it needs its guard and a new backup again once what's ahead of it is done.
   */
  sync(queue: Intent[]): void {
    const kept = new Map<string, Gate>();
    for (const intent of queue.filter(isIrreversibleIntent))
      kept.set(intent.id, this.#gates.get(intent.id) ?? newGate());
    let isFirstGate = true;
    for (const [id, gate] of kept) {
      if (isFirstGate) this.#judgeQueueGuard(gate, queue.find((each) => each.id === id) as Intent, queue);
      else if (gate.stage !== "counting" || gate.heldSnapshots > 0) {
        this.#restart(gate, "another irreversible intent was queued ahead of it");
      }
      isFirstGate = false;
    }
    this.#gates = kept;
  }

  /** The first gate's guard on the queue alone (#271): failing, back to counting, its count and backup gone. */
  #judgeQueueGuard(gate: Gate, intent: Intent, queue: Intent[]): void {
    gate.queueFailure = queueGuardFailure(intent, queue);
    if (gate.queueFailure !== null && (gate.stage !== "counting" || gate.heldSnapshots > 0)) this.#restart(gate, null);
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

  /**
   * A medium snapshot from the connected Agent, with its static one: the first gate's guard, its backup, or its release
   * going stale.
   */
  mediumSnapshot(medium: MediumSnapshotData, queue: Intent[], staticData: StaticSnapshotData | null): void {
    const [first] = this.#gates;
    if (first === undefined) return;
    const [id, gate] = first;
    const intent = queue.find((each) => each.id === id);
    if (intent === undefined) return;
    gate.queueFailure = queueGuardFailure(intent, queue);
    gate.guardFailure = snapshotGuardFailure(intent, medium, staticData);
    if (gate.queueFailure !== null || gate.guardFailure !== null) {
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
    // Both parts' reasons: what's queued ahead, and what the latest snapshot showed.
    const held = [gate.queueFailure, gate.guardFailure].filter((reason) => reason !== null);
    if (held.length > 0) return `held: ${held.join("; ")}`;
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
