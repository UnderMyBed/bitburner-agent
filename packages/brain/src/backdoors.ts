// Backdoors for the hacker factions (#195, M4 phase A slice A3): the brain asks for a backdoor on CSEC, avmnite-02h,
// I.I.I.I and run4theh111z (core's `HACKER_FACTION_SERVERS`) as soon as each can be installed, so CyberSec, NiteSec,
// The Black Hand and BitRunners invite the player (`Faction/FactionInfo.tsx:489`, `:464-466`, `:419`, `:402`). Sent as
// the `backdoor` intent (#162). Joining them is slice A5's (#203, ./factions.ts). Also what the dashboard's `backdoorOverdue` alert and the
// run report (#185) read of them.
// - The game's terms (`Terminal/commands/backdoor.ts:23-32`): root, and the hacking level at the server's required
//   level. An install recreates the servers (`Prestige.ts:74`, `:98`), so after one they're backdoored again.
// - No switch: a backdoor costs no money and changes nothing a later choice depends on (#162).
// - How long: a quarter of the hacking time (`Terminal/Terminal.ts:233-243`), `5 × (2.5 × required × security + 500) /
//   (hacking + 50)` s over the speed multipliers (`Hacking.ts:60-80`). These four start at security 1 (their data's 0
//   is skipped as falsy, `Server/ServerHelpers.ts:367`, so `Server/Server.ts:79-83` gives 1): about 8 s for CSEC at
//   hacking 55, 4 to 5 s for the others at their levels, about 3.3 times that in BN14 (`HackingSpeedMultiplier` 0.3).
// - Known limit: a brain restarted between a backdoor's end and the Agent's try that sends the terminal home leaves the
//   terminal on that server (decision 42), as no snapshot says which server the terminal is on.
import {
  HACKER_FACTION_SERVERS,
  type Intent,
  intentId,
  type MediumSnapshotData,
  type StaticSnapshotData,
} from "@bitburner-agent/core";

/** The server to backdoor now, and what made it due. */
export interface DueBackdoor {
  hostname: string;
  faction: string;
  hackingLevel: number;
  requiredHackingSkill: number;
}

/** What the rule found in the snapshots. */
export interface BackdoorPlan {
  /** The server to backdoor now, or null. */
  next: DueBackdoor | null;
  /** The hacker factions' servers the medium snapshot shows backdoored, in order. */
  installed: string[];
  /** Why none is due now, or null: one is, or all four are backdoored. */
  waitingFor: string | null;
}

/** A server's backdoor due since a medium snapshot, for the dashboard's `backdoorOverdue` alert. */
export interface BackdoorDue {
  hostname: string;
  sinceMs: number;
}

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** The player's hacking level in a medium snapshot, or null: it's the Agent's word. */
function hackingLevelOf(mediumData: MediumSnapshotData): number | null {
  const level = (mediumData.player?.skills as { hacking?: unknown } | undefined)?.hacking;
  return isNumber(level) ? level : null;
}

/** The medium snapshot's server named `hostname`, or undefined. */
function mediumServerOf(mediumData: MediumSnapshotData, hostname: string) {
  return (Array.isArray(mediumData.servers) ? mediumData.servers : []).find((server) => server?.hostname === hostname);
}

/** Whether the medium snapshot shows `hostname` backdoored, or null when it doesn't say (no server, no field). */
function backdoorInstalledIn(mediumData: MediumSnapshotData, hostname: string): boolean | null {
  const installed = mediumServerOf(mediumData, hostname)?.backdoorInstalled;
  return typeof installed === "boolean" ? installed : null;
}

/** Where one server's backdoor stands: installed, due (the terminal would take it), or not yet, with why. */
type Standing =
  | { installed: true }
  | { installed: false; due: true; hackingLevel: number; requiredHackingSkill: number }
  | { installed: false; due: false; waitingFor: string };

/**
 * `hostname`'s backdoor in the snapshots: installed; due when the medium snapshot shows it rooted and not backdoored,
 * with the hacking level at or above its required level (the static snapshot's), the terminal's own terms; otherwise
 * why not. What the snapshots don't say as expected fails closed: not due.
 */
function standingOf(hostname: string, staticData: StaticSnapshotData, mediumData: MediumSnapshotData): Standing {
  const notYet = (waitingFor: string) => ({ installed: false as const, due: false as const, waitingFor });
  const staticServer = (Array.isArray(staticData.servers) ? staticData.servers : []).find(
    (server) => server?.hostname === hostname,
  );
  const mediumServer = mediumServerOf(mediumData, hostname);
  const installed = backdoorInstalledIn(mediumData, hostname);
  if (installed === true) return { installed: true };
  const required = staticServer?.requiredHackingSkill;
  if (mediumServer === undefined || installed === null || !isNumber(required)) {
    return notYet(`${hostname} in the Agent's snapshots`);
  }
  if (mediumServer.hasAdminRights !== true) {
    const ports = staticServer?.numOpenPortsRequired;
    return notYet(
      `root on ${hostname}` +
        (isNumber(ports) ? ` (the hack loop roots it with ${ports} port opener${ports === 1 ? "" : "s"})` : ""),
    );
  }
  const hackingLevel = hackingLevelOf(mediumData);
  if (hackingLevel === null) return notYet("the hacking level in the Agent's medium snapshot");
  if (hackingLevel < required) return notYet(`hacking ${hackingLevel}: ${hostname} needs ${required}`);
  return { installed: false, due: true, hackingLevel, requiredHackingSkill: required };
}

/**
 * The first of the hacker factions' servers, in order, whose backdoor is due (`standingOf`). One that isn't is passed
 * over, so it never holds up a later one; the first one passed over says why none is due.
 */
export function chooseBackdoor(staticData: StaticSnapshotData, mediumData: MediumSnapshotData): BackdoorPlan {
  const installed: string[] = [];
  let waitingFor: string | null = null;
  for (const { hostname, faction } of HACKER_FACTION_SERVERS) {
    const standing = standingOf(hostname, staticData, mediumData);
    if (standing.installed) {
      installed.push(hostname);
    } else if (standing.due) {
      const { hackingLevel, requiredHackingSkill } = standing;
      return { next: { hostname, faction, hackingLevel, requiredHackingSkill }, installed, waitingFor: null };
    } else {
      waitingFor ??= standing.waitingFor;
    }
  }
  return { next: null, installed, waitingFor };
}

/** The `backdoor` intent on `hostname`. */
export function backdoorIntent(hostname: string): Intent {
  const args = { hostname };
  return { id: intentId("backdoor", args), action: "backdoor", args };
}

/**
 * What the controller hands the rule: the connected Agent's snapshots, when the medium one arrived, the game's
 * `lastAugReset` (the slow snapshot's) or null, and the intents the Agent reports done (its latest fast snapshot).
 */
export interface BackdoorInputs {
  staticData: StaticSnapshotData | null;
  mediumData: MediumSnapshotData | null;
  mediumAtMs: number | null;
  resetAt: number | null;
  doneIds: ReadonlySet<string>;
}

/**
 * The rule as the desired state's controller runs it: the intent to send, the brain's log as it asks for a backdoor
 * and as a medium snapshot shows it installed, and since when each is due (the `backdoorOverdue` alert). Called on
 * every update, so it logs only on a change.
 * - Asked for until the connected Agent reports it done, as the owner's queue is (#141), not only until a medium
 *   snapshot shows it installed: every backdoor outlasts the Agent's 2 s round and goes on alone, and the try after it,
 *   which finds it installed, types `home` (#162, decision 42). Done, the Agent never runs it again while it's sent; a
 *   new Agent's worker finds it installed and only sends the terminal home. Never asked for twice.
 * - A server asked for, seen installed, then shown not backdoored (`false`, not just missing from a snapshot) is gone:
 *   a reset, asked for afresh. Another `lastAugReset` forgets what was asked for too (a destroy after a refused try).
 * - A REPEATED line when it asks for a server it saw backdoored since the game's last reset (`lastAugReset`): only a
 *   save loaded over the game, or a bug, would undo one. Not before the connected Agent's slow snapshot says the reset:
 *   after an install, the next Agent's first medium snapshot can come first.
 */
export class BackdoorRule {
  readonly #log: (line: string) => void;
  /** Each server seen backdoored: when (the medium snapshot's arrival), and `lastAugReset` then, or null. */
  readonly #seen = new Map<string, { atMs: number; resetAt: number | null }>();
  /** The server asked for, when, and when a medium snapshot first showed it installed (or null), or null. */
  #asked: { hostname: string; atMs: number; installedAtMs: number | null } | null = null;
  /** The last `lastAugReset` the rule was given, or null. */
  #lastResetAt: number | null = null;
  /** Each server whose backdoor is due, since the first medium snapshot in a row that showed it due. */
  readonly #dueSince = new Map<string, number>();
  #plan: BackdoorPlan | null = null;

  constructor(log: (line: string) => void = () => {}) {
    this.#log = log;
  }

  /** The last plan, or null before the connected Agent's static and medium snapshots. */
  get plan(): BackdoorPlan | null {
    return this.#plan;
  }

  /** Each server whose backdoor is due, and since when, in the four's order: none without the Agent's snapshots. */
  due(): BackdoorDue[] {
    return [...this.#dueSince].map(([hostname, sinceMs]) => ({ hostname, sinceMs }));
  }

  /** The backdoor to send now, or null: none due, or no snapshots from the connected Agent yet. */
  intent({ staticData, mediumData, mediumAtMs, resetAt, doneIds }: BackdoorInputs): Intent | null {
    if (staticData === null || mediumData === null || mediumAtMs === null) {
      this.#plan = null;
      this.#dueSince.clear();
      return null;
    }
    const plan = chooseBackdoor(staticData, mediumData);
    this.#plan = plan;
    for (const { hostname } of HACKER_FACTION_SERVERS) {
      const standing = standingOf(hostname, staticData, mediumData);
      if (standing.installed || !standing.due) this.#dueSince.delete(hostname);
      else if (!this.#dueSince.has(hostname)) this.#dueSince.set(hostname, mediumAtMs);
    }
    if (resetAt !== null) {
      // Another game: what was asked for in the last one is forgotten, and what it saw installed.
      if (this.#lastResetAt !== null && this.#lastResetAt !== resetAt) this.#asked = null;
      this.#lastResetAt = resetAt;
      for (const [hostname, seen] of this.#seen) {
        if (seen.resetAt !== null && seen.resetAt !== resetAt) this.#seen.delete(hostname);
      }
    }
    for (const hostname of plan.installed) {
      const seen = this.#seen.get(hostname);
      if (seen === undefined) this.#seen.set(hostname, { atMs: mediumAtMs, resetAt });
      else if (seen.resetAt === null && resetAt !== null) seen.resetAt = resetAt;
    }
    const asked = this.#asked;
    if (asked !== null && plan.installed.includes(asked.hostname)) {
      if (asked.installedAtMs === null) {
        asked.installedAtMs = mediumAtMs;
        const seconds = Math.round((mediumAtMs - asked.atMs) / 1000);
        this.#log(`backdoor: ${asked.hostname} backdoored, ${seconds} s after it was asked for`);
      }
      const intent = backdoorIntent(asked.hostname);
      // Until the Agent says it's done: the terminal sent home.
      if (!doneIds.has(intent.id)) return intent;
      this.#asked = null;
    } else if (asked?.installedAtMs != null) {
      // Seen installed, and shown not backdoored now: a reset. Asked for afresh when it's due. Kept while a snapshot
      // doesn't say.
      if (backdoorInstalledIn(mediumData, asked.hostname) === false) this.#asked = null;
      else return backdoorIntent(asked.hostname);
    }
    const { next } = plan;
    if (next === null) return null;
    if (this.#asked?.hostname !== next.hostname) {
      this.#asked = { hostname: next.hostname, atMs: mediumAtMs, installedAtMs: null };
      this.#log(
        `backdoor: asking for ${next.hostname} (hacking ${next.hackingLevel}, needs ${next.requiredHackingSkill}), ` +
          `for ${next.faction}'s invitation`,
      );
      const seen = this.#seen.get(next.hostname);
      if (seen !== undefined && resetAt !== null && seen.resetAt === resetAt) {
        this.#log(
          `backdoor REPEATED: asking for ${next.hostname} again, though the game showed it backdoored at ` +
            `${new Date(seen.atMs).toISOString()}, since its last reset`,
        );
      }
    }
    return backdoorIntent(next.hostname);
  }
}

// --- What the run report reads (#185) ---------------------------------------------------------------------------------

/**
 * Medium snapshots (every 10 s) further apart than this are a gap: a due stretch ends there, as the heartbeat's gap
 * is a failure of its own.
 */
export const MEDIUM_SNAPSHOT_GAP_MS = 30_000;

/** A stretch in which a server's backdoor was due, from the first medium snapshot that showed it to the last. */
export interface DueStretch {
  hostname: string;
  fromMs: number;
  toMs: number;
  /** Still due at the window's last medium snapshot. */
  ongoing: boolean;
}

/**
 * The hacker factions' servers over a run's snapshots, folded one at a time for the run report: each server's
 * `backdoorInstalled` as it changed, and the stretches its backdoor was due, each ended by a gap in the medium
 * snapshots. Each medium snapshot is judged against the newest static snapshot before it (an install rolls the
 * servers' required levels again), or the window's first; with none in the window, none is judged.
 */
export class BackdoorTimeline {
  readonly #statics: { atMs: number; data: StaticSnapshotData }[] = [];
  /** Per server, each change of `backdoorInstalled`, in order: the first medium snapshot that showed it. */
  readonly #changes = new Map<string, { atMs: number; installed: boolean }[]>();
  readonly #openStretches = new Map<string, DueStretch>();
  readonly due: DueStretch[] = [];
  #firstMediumAtMs: number | null = null;
  #lastMediumAtMs: number | null = null;

  /** Static snapshots come first, all of them, in time order. */
  addStatic(atMs: number, data: StaticSnapshotData): void {
    this.#statics.push({ atMs, data });
  }

  /** Whether there was a static snapshot to judge the medium snapshots by: without one, nothing is due. */
  get judged(): boolean {
    return this.#statics.length > 0;
  }

  /** Medium snapshots, in time order. */
  addMedium(atMs: number, data: MediumSnapshotData): void {
    this.#firstMediumAtMs ??= atMs;
    if (this.#lastMediumAtMs !== null && atMs - this.#lastMediumAtMs > MEDIUM_SNAPSHOT_GAP_MS) {
      for (const openStretch of this.#openStretches.values()) openStretch.ongoing = false;
      this.#openStretches.clear();
    }
    this.#lastMediumAtMs = atMs;
    const staticSnapshot = this.#statics.findLast((each) => each.atMs <= atMs) ?? this.#statics[0];
    for (const { hostname } of HACKER_FACTION_SERVERS) {
      const installed = backdoorInstalledIn(data, hostname);
      const changes = this.#changes.get(hostname) ?? [];
      // A snapshot that doesn't say changes nothing.
      if (installed !== null && changes.at(-1)?.installed !== installed) changes.push({ atMs, installed });
      this.#changes.set(hostname, changes);
      const standing = standingOf(hostname, staticSnapshot?.data ?? { servers: [] }, data);
      const openStretch = this.#openStretches.get(hostname);
      if (!standing.installed && standing.due) {
        if (openStretch) openStretch.toMs = atMs;
        else {
          const stretch = { hostname, fromMs: atMs, toMs: atMs, ongoing: true };
          this.#openStretches.set(hostname, stretch);
          this.due.push(stretch);
        }
      } else if (openStretch) {
        openStretch.ongoing = false;
        this.#openStretches.delete(hostname);
      }
    }
  }

  /** When the first medium snapshot came, or null if none did. */
  get firstMediumAtMs(): number | null {
    return this.#firstMediumAtMs;
  }

  /** Each change of `hostname`'s backdoor, the first medium snapshot's state first. */
  changesOf(hostname: string): readonly { atMs: number; installed: boolean }[] {
    return this.#changes.get(hostname) ?? [];
  }

  /** Whether the newest medium snapshot at or before `atMs` showed `hostname` backdoored; false before the first. */
  installedAt(hostname: string, atMs: number): boolean {
    return this.changesOf(hostname).findLast((change) => change.atMs <= atMs)?.installed ?? false;
  }
}
