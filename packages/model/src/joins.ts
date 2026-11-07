/**
 * How long a join takes after its terms are met (#294's item 1): the game's timings and the brain's and the Agent's
 * cadence, as an exact expectation, not fitted. Until #294 the model joined at the step the terms were met; BN1.3's
 * brain joined BitRunners 1 to 6 minutes after its level allowed (#263's extract). A faction counts as joined once the
 * brain's slow snapshot shows it: A5 works from that snapshot's faction state (packages/brain/src/factions.ts).
 * - **The clocks.** The Agent's rounds every 2 s, its medium snapshot every 5th round and its slow one every 30th,
 *   counted from the same round, so every slow snapshot is a medium one (core's `SNAPSHOT_TIER_PERIOD_MS`;
 *   packages/ingame/src/agent/snapshotter.ts:4-5). The game's invitation check runs on its own clock, every 10 engine
 *   cycles of 200 ms (`engine.tsx:177-182`, `Constants.ts:19`). The terms are met at a time uniform against both.
 * - **A hacker faction** (CyberSec, NiteSec, The Black Hand, BitRunners): the brain asks for the backdoor at the
 *   first medium snapshot that shows its server rooted at the level (packages/brain/src/backdoors.ts
 *   `chooseBackdoor`), one server at a time in that order; the Agent tries it in its next round, which starts it, and
 *   again every 15 rounds until it's installed (packages/ingame/src/agent/intent-runner.ts); the brain sees it done in
 *   the next round's fast snapshot and asks for the next at the medium snapshot after. The backdoor takes a quarter of
 *   the hack time (`Terminal/Terminal.ts:242`, `NetscriptFunctions/Singularity.ts:525`) at security 1
 *   (`Server/ServerHelpers.ts:367` skips the data's 0, so `Server/Server.ts:79-83` leaves 1). The game invites at its
 *   next check; the Agent's faction state reader answers the dialog and opens the Factions page at the next slow
 *   snapshot (packages/ingame/src/page/faction-state-page.ts); the brain joins it (`chooseJoin`), the Agent in its
 *   next round, and the next slow snapshot shows it joined.
 * - **One join a slow snapshot:** the brain joins the first invitation in the order invited and sees it joined only in
 *   the next slow snapshot, so the next join waits for that (`JoinPipeline`).
 * - **Tian Di Hui:** the brain travels to Ishima at the medium snapshot that shows hacking 50 and the money
 *   (packages/brain/src/invitations.ts), the Agent in its next round; then as a hacker faction from the game's check.
 * - **A city group:** a travel a city, the next once the slow snapshot shows the last's invitation; each join waits
 *   at the irreversible gate (`GATE_MEDIUM_SNAPSHOTS` medium snapshots and a save backup,
 *   packages/brain/src/irreversible-gate.ts), within the slow snapshot's minute.
 * - **Daedalus:** the game's check on its terms, then the slow snapshot.
 * Left out: the hack loop's root (every 30 s, packages/ingame/src/agent/hack-loop.ts), as the level, not the port
 * opener, comes last in the model's runs; a slow snapshot that waits a round or more for time to read the factions.
 * Untestable by design: the join's own round and a city faction's gate both fall inside the minute to the next slow
 * snapshot, so they never move a join's time, and no parity case can see them.
 */
import { SNAPSHOT_TIER_PERIOD_MS } from "@bitburner-agent/core";

const { fast: ROUND_MS, medium: MEDIUM_MS, slow: SLOW_MS } = SNAPSHOT_TIER_PERIOD_MS;
/** The game's invitation check: every 10 engine cycles (`engine.tsx:177-182`) of 200 ms (`Constants.ts:19`). */
export const INVITATION_CHECK_MS = 10 * 200;
/** The irreversible gate's medium snapshots before a city faction's join goes out (the brain's `GUARD_SNAPSHOTS`). */
export const GATE_MEDIUM_SNAPSHOTS = 2;
/** Rounds between the Agent's tries of an intent not done (packages/ingame/src/agent/intent-runner.ts:23). */
export const ROUNDS_BETWEEN_TRIES = 15;

/**
 * A backdoor's time, ms: a quarter of the game's hack time (`Hacking.ts:60-80`) on the faction's server at security 1,
 * `5 × (2.5 × required + 500) / (hacking + 50)` s over the hacking speed (BN1's multiplier 1, no intelligence).
 */
export function backdoorMs(requiredHacking: number, hacking: number, hackingSpeed: number): number {
  return ((5 * (2.5 * requiredHacking + 500)) / (hacking + 50) / hackingSpeed / 4) * 1000;
}

/**
 * From a medium snapshot to the first slow snapshot after an invitation, its mean: the invitation `beforeCheckMs`
 * after the medium snapshot and then at the game's next check, uniform over `INVITATION_CHECK_MS` on its own clock;
 * the medium snapshot after the invitation (the later one, for the share of the check's spread past a snapshot);
 * then half the rest of a slow snapshot's minute, the medium snapshot's place among its six uniform. Exact.
 */
function toSlowAfterMedium(beforeCheckMs: number): number {
  const next = MEDIUM_MS * Math.ceil(beforeCheckMs / MEDIUM_MS);
  const pastShare = Math.max(0, beforeCheckMs + INVITATION_CHECK_MS - next) / INVITATION_CHECK_MS;
  return next + pastShare * MEDIUM_MS + (SLOW_MS - MEDIUM_MS) / 2;
}

/**
 * The joins of a cycle, in the order their terms are met, each at the time the brain's slow snapshot shows it joined:
 * the mean over the clocks' phases, exact where the order of the waits doesn't change from one phase to another
 * (tested against the brain's own rules in packages/brain/test/backdoors.test.ts). Times in ms on any one clock; a
 * fresh pipeline each cycle.
 */
export class JoinPipeline {
  /** When the next backdoor may be asked for: the medium snapshot after the last one's reported done. */
  #backdoorFreeAtMs = Number.NEGATIVE_INFINITY;
  /** When the last join shows in a slow snapshot: the next is chosen there at the soonest. */
  #joinFreeAtMs = Number.NEGATIVE_INFINITY;

  /** When the next backdoor may be asked for, ms (for its tests). */
  get backdoorFreeAtMs(): number {
    return this.#backdoorFreeAtMs;
  }

  /** A join chosen at the slow snapshot `seenAtMs` (or the one showing the last join), shown a slow snapshot later. */
  #join(seenAtMs: number): number {
    this.#joinFreeAtMs = Math.max(seenAtMs, this.#joinFreeAtMs) + SLOW_MS;
    return this.#joinFreeAtMs;
  }

  /** A hacker faction whose server's terms (the level, the ports) are met at `termsAtMs`. */
  hackerFaction(termsAtMs: number, requiredHacking: number, hacking: number, hackingSpeed: number): number {
    const askedAtMs = Math.max(termsAtMs + MEDIUM_MS / 2, this.#backdoorFreeAtMs);
    const takesMs = backdoorMs(requiredHacking, hacking, hackingSpeed);
    // Tried in the next round, which starts it; done at the first try after it ends; seen in the next round's fast
    // snapshot, and the next asked for at the medium snapshot after.
    const triesMs = ROUNDS_BETWEEN_TRIES * ROUND_MS;
    const doneAfterMs = ROUND_MS + triesMs * Math.max(1, Math.ceil(takesMs / triesMs));
    this.#backdoorFreeAtMs = askedAtMs + MEDIUM_MS * Math.ceil((doneAfterMs + ROUND_MS) / MEDIUM_MS);
    return this.#join(askedAtMs + toSlowAfterMedium(ROUND_MS + takesMs));
  }

  /** Tian Di Hui, with hacking 50 and the money in hand at `termsAtMs`: the travel, then the game's check. */
  tianDiHui(termsAtMs: number): number {
    return this.#join(termsAtMs + MEDIUM_MS / 2 + toSlowAfterMedium(ROUND_MS));
  }

  /** Daedalus, its terms met at `termsAtMs`: the game's check, then the next slow snapshot. */
  daedalus(termsAtMs: number): number {
    return this.#join(termsAtMs + INVITATION_CHECK_MS / 2 + SLOW_MS / 2);
  }

  /**
   * A city group's `factions` factions in the order visited, the money in hand at `termsAtMs`: the first travel at
   * the medium snapshot after, each next at the slow snapshot that shows the last's invitation, so a slow snapshot
   * apart, as the joins are: the joins' queue carries the visits. Each join goes through the gate within its slow
   * snapshot's minute (two medium snapshots and a backup, then the Agent's round).
   */
  cityGroup(termsAtMs: number, factions: number): number[] {
    if (GATE_MEDIUM_SNAPSHOTS * MEDIUM_MS + ROUND_MS >= SLOW_MS) throw new RangeError("the gate outlasts a minute");
    const firstSeenAtMs = termsAtMs + MEDIUM_MS / 2 + toSlowAfterMedium(ROUND_MS);
    return Array.from({ length: factions }, () => this.#join(firstSeenAtMs));
  }
}
