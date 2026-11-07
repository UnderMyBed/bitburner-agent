/**
 * How long a join takes after its terms are met (#294's item 1): the game's timings and the brain's and the Agent's
 * cadence, each wait at its mean, not fitted. Until #294 the model joined at the step the terms were met; BN1.3's brain
 * joined BitRunners 1 to 6 minutes after its level allowed (#263's extract). The faction counts as joined once the
 * brain's slow snapshot shows it: A5 works from that snapshot's faction state (packages/brain/src/factions.ts).
 * - **The snapshots** (core's `SNAPSHOT_TIER_PERIOD_MS`): the Agent's round every 2 s, the medium snapshot every 10 s,
 *   the slow one, with the faction state, every 60 s (packages/ingame/src/agent/snapshotter.ts). A wait for the next of
 *   a period is half of it, on average.
 * - **A hacker faction** (CyberSec, NiteSec, The Black Hand, BitRunners): the brain asks for the backdoor at the first
 *   medium snapshot that shows its server rooted at the level (packages/brain/src/backdoors.ts `chooseBackdoor`); the
 *   Agent starts it in its next round (packages/ingame/src/agent/intent-runner.ts); the backdoor takes a quarter of the
 *   hack time (`Terminal/Terminal.ts:242`, `NetscriptFunctions/Singularity.ts:525`), at the server's security 1 (`Server/Server.ts:79-83`:
 *   its data's 0 is skipped); the game checks for invitations every 10 engine cycles of 200 ms (`engine.tsx:177-182`);
 *   the Agent's dialog watcher answers the invitation in its next round, which opens the Factions page at the next slow
 *   snapshot (packages/ingame/src/page/faction-state-page.ts); the brain joins it (`chooseJoin`), the Agent in its next
 *   round, and the next slow snapshot, a period after, shows it joined.
 * - **Tian Di Hui:** in Sector-12 after an install, the brain travels to Ishima once a medium snapshot shows hacking 50
 *   and the money (packages/brain/src/invitations.ts), then as a hacker faction from the game's check.
 * - **A city group:** a travel and an invitation a city, each shown in a slow snapshot before the next travel; each
 *   join waits at the irreversible gate (two medium snapshots and a save backup, packages/brain/src/irreversible-gate.ts
 *   `GUARD_SNAPSHOTS`) and a slow snapshot before the next, one at a time.
 * - **Daedalus:** the game's check, then as a hacker faction's invitation.
 * Left out: the hack loop's root (every 30 s, packages/ingame/src/agent/hack-loop.ts), as the level, not the port
 * opener, comes last in the model's runs; a save backup's seconds.
 */
import { SNAPSHOT_TIER_PERIOD_MS } from "@bitburner-agent/core";

const { fast: ROUND_MS, medium: MEDIUM_MS, slow: SLOW_MS } = SNAPSHOT_TIER_PERIOD_MS;
/** The game's invitation check: every 10 engine cycles (`engine.tsx:177-182`) of 200 ms (`Constants.ts:19`). */
export const INVITATION_CHECK_MS = 10 * 200;
/** The irreversible gate's medium snapshots before a city faction's join goes out (the brain's `GUARD_SNAPSHOTS`). */
export const GATE_MEDIUM_SNAPSHOTS = 2;

/** From an invitation in the game to the faction joined in the brain's slow snapshot: the tail every join shares. */
const FROM_INVITATION_MS = INVITATION_CHECK_MS / 2 + ROUND_MS + SLOW_MS / 2 + SLOW_MS;

/**
 * A backdoor's time, ms: a quarter of the game's hack time (`Hacking.ts:59-80`) on the faction's server at security 1,
 * `5 × (2.5 × required + 500) / (hacking + 50)` s over the hacking speed (BN1's multiplier 1, no intelligence).
 */
export function backdoorMs(requiredHacking: number, hacking: number, hackingSpeed: number): number {
  return ((5 * (2.5 * requiredHacking + 500)) / (hacking + 50) / hackingSpeed / 4) * 1000;
}

/** A hacker faction: from its server rooted at the level to the faction joined in the brain's slow snapshot, ms. */
export function hackerFactionJoinMs(requiredHacking: number, hacking: number, hackingSpeed: number): number {
  return MEDIUM_MS / 2 + ROUND_MS + backdoorMs(requiredHacking, hacking, hackingSpeed) + FROM_INVITATION_MS;
}

/** Tian Di Hui: from hacking 50 and the money in hand to the faction joined in the brain's slow snapshot, ms. */
export function tianDiHuiJoinMs(): number {
  return MEDIUM_MS / 2 + ROUND_MS + FROM_INVITATION_MS;
}

/** Daedalus: from its terms met to the faction joined in the brain's slow snapshot, ms. */
export function daedalusJoinMs(): number {
  return FROM_INVITATION_MS;
}

/**
 * A city group's factions, in the order visited: from the money in hand to each joined in the brain's slow snapshot,
 * ms. Each city a travel and its invitation shown in a slow snapshot; each join after its invitation and the one
 * before, through the irreversible gate, then shown a slow snapshot later.
 */
export function cityGroupJoinsMs(factions: number): number[] {
  const visitMs = MEDIUM_MS / 2 + ROUND_MS + INVITATION_CHECK_MS / 2 + ROUND_MS + SLOW_MS / 2;
  const joinMs = GATE_MEDIUM_SNAPSHOTS * MEDIUM_MS + ROUND_MS + SLOW_MS;
  const joined: number[] = [];
  for (let index = 0; index < factions; index++) {
    joined.push(Math.max((index + 1) * visitMs, joined[index - 1] ?? 0) + joinMs);
  }
  return joined;
}
