/**
 * The time to the BitNode's destroy (#360, decision 67's point 2: the planner's one score), one estimate end to end,
 * by Daedalus's route (BN1, BN4, BN5): remaining = A + BC + D, the total the time online so far plus it. Pure, so the
 * brain, the run report and the campaign report call the same function.
 * - A, Daedalus's count (`DaedalusAugsRequirement`, N): 0 once met; otherwise t·(N − c)/c, the BitNode's mean (c the
 *   count installed, `daedalusCountOf`'s, and t the BitNode's time online so far), fitted online; at the start (c = 0)
 *   the prior's. Optimistic after a big early cycle (BN1.4's c3-c5: 0.30-0.53 of what was left), cautious where later
 *   factions bring more (BN4.1's c3-c7: 1.7-2.7): either way.
 * - BC, the invitation and The Red Pill: 0 once installed; after the donations install, the prior's Red Pill cycle;
 *   once Daedalus is joined, A5's ETA for the hold (its first choice there, to the favour target: with the share if it
 *   runs at the choice, else about 1.6× cautious, BN1.2's and BN1.3's 157 and 184 min against 98 and 114 with it) plus
 *   that cycle, cautious (the level's rise left out); before, the prior's B + C less the time since the count was met, never less than the
 *   prior's Red Pill cycle (BN1's vary 2-4×: either way).
 * - D, w0r1d_d43m0n's level (3000 × `WorldDaemonDifficulty`, `worldDaemonRequiredLevel`): once The Red Pill is
 *   installed, levelling's chosen candidate's estimate (#336); before, the prior's D where its level is this BitNode's,
 *   else none (optimistic: the total is "at least"). A prior whose D came before levelling (no levelling choice before
 *   its destroy: BN4.1's 419 min, 409 of them at the money pace) is cautious.
 * The prior is the last destroyed BitNode, the same number first (the brain's campaign fold measures its stretches).
 * With no prior, its terms are none and the total "at least". A term that's never (a rate of 0) makes the estimate
 * hopeless.
 * Left out, each labelled in the issue: B's hacking 2,500 and $100b by the formulas, and C with the level's rise (the
 * prior's until slice 2); install timing's per-cycle shape for A (right for its choice, wrong for the total); D before
 * The Red Pill by the formulas; restarts and offline time (the online clock); the gang's and Black Ops' routes; a
 * prior scaled by the multipliers.
 */
import { augmentationBitNodeMultipliers } from "./augmentations.ts";
import { daedalusAugmentationsRequired } from "./factions.ts";

/** w0r1d_d43m0n's base hacking requirement (`Server/data/servers.ts`'s 3000), before the BitNode's multiplier. */
export const WORLD_DAEMON_BASE_LEVEL = 3000;

/**
 * w0r1d_d43m0n's hacking requirement in the current BitNode (#360): 3000 × its `WorldDaemonDifficulty`
 * (`Server/ServerHelpers.ts:383-385`, no rounding): BN1 3,000, BN2 15,000, BN4 9,000, BN5 4,500; BN12's grows with its
 * level, 3000 × 1.02^level (`BitNode/BitNode.tsx:993`).
 */
export function worldDaemonRequiredLevel(currentNode: number, ownedSF: Readonly<Record<string, number>>): number {
  return WORLD_DAEMON_BASE_LEVEL * augmentationBitNodeMultipliers(currentNode, ownedSF).WorldDaemonDifficulty;
}

/** The BitNodes whose route to the destroy the estimate models (#360): Daedalus's alone. BN2's gang is #357's. */
export const DESTROY_ESTIMATE_BITNODES: readonly number[] = [1, 4, 5];

/** How a term bears on the total: done (0, exact), or optimistic, cautious, or either way for it. */
export type DestroyTermLabel = "done" | "optimistic" | "cautious" | "either way";

export type DestroyTermName = "A" | "BC" | "D";

/** One term of the estimate: its time, where it comes from, and how it bears on the total. */
export interface DestroyTerm {
  term: DestroyTermName;
  /** Its time online, ms: null where there's none (no prior); Infinity where it's never (a rate of 0). */
  ms: number | null;
  /** A part of it is missing (its prior's Red Pill cycle): it's at least `ms`. */
  atLeast: boolean;
  source: string;
  label: DestroyTermLabel;
}

/** A destroyed BitNode's stretches (#360), online ms, as the campaign fold measures them: null where it didn't see one. */
export interface DestroyPrior {
  /** Its label, "BN1.3". */
  bitNode: string;
  currentNode: number;
  /** Start to the count met (the first cycle that starts at N). */
  aMs: number | null;
  /** The count met to The Red Pill installed. */
  bcMs: number | null;
  /** The cycle that ended with The Red Pill's install (its own cycle). */
  redPillCycleMs: number | null;
  /** The Red Pill installed to the destroy. */
  dMs: number | null;
  /** Its w0r1d_d43m0n's level (`worldDaemonRequiredLevel`): its D is this BitNode's only at the same. */
  requiredLevel: number;
  /** Its D came before levelling (#336): no levelling choice before its destroy, so the money pace's. Absent: not. */
  dBeforeLevelling?: boolean;
}

/** Where Daedalus stands: not joined; joined (the hold); or the install after the join made (the donations install). */
export type DaedalusStage = "not joined" | "joined" | "donations installed";

export interface DestroyEstimateInputs {
  currentNode: number;
  ownedSF: Readonly<Record<string, number>>;
  /** The BitNode's time online so far, t (the campaign's online clock, keyed by `lastNodeReset`). */
  onlineMs: number;
  /** Daedalus's count installed, c (`daedalusCountOf`'s `installed`: NeuroFlux Governor once). */
  count: number;
  redPillInstalled: boolean;
  /** The BitNode's time online at the count met (the start of the first cycle at N), or null not met. */
  countMetOnlineMs: number | null;
  daedalus: DaedalusStage;
  /** Joined: A5's ETA for The Red Pill's hold (`factionWorkChosen`'s, to the favour target), ms; null with none. */
  holdEtaMs: number | null;
  /** The Red Pill installed: levelling's chosen candidate's estimate (#336), ms; null before its first choice. */
  levellingMs: number | null;
  prior: DestroyPrior | null;
}

export interface DestroyEstimate {
  terms: DestroyTerm[];
  /** A + BC + D, ms (none taken as 0); Infinity where a term is never. */
  remainingMs: number;
  /** The time online so far plus the remaining. */
  totalMs: number;
  /** A term none or part missing: the total is at least this. */
  atLeast: boolean;
  /** A term never: hopeless. */
  never: boolean;
  /** N and w0r1d_d43m0n's level, as this BitNode has them. */
  required: number;
  requiredLevel: number;
}

const none = (term: DestroyTermName, source: string): DestroyTerm => ({
  term,
  ms: null,
  atLeast: true,
  source,
  label: "optimistic",
});
const done = (term: DestroyTermName, source: string): DestroyTerm => ({
  term,
  ms: 0,
  atLeast: false,
  source,
  label: "done",
});

/** A: Daedalus's count. */
function countTerm(inputs: DestroyEstimateInputs, required: number): DestroyTerm {
  const { count, onlineMs, prior } = inputs;
  if (inputs.redPillInstalled) return done("A", "The Red Pill installed");
  if (count >= required) return done("A", `the count met (${count} of ${required})`);
  if (count <= 0 || onlineMs <= 0) {
    return prior?.aMs == null
      ? none("A", "no prior: none (the start's count is 0)")
      : { term: "A", ms: prior.aMs, atLeast: false, source: `the prior's (${prior.bitNode})`, label: "either way" };
  }
  return {
    term: "A",
    ms: (onlineMs * (required - count)) / count,
    atLeast: false,
    source: `the BitNode's mean: ${count} of ${required} in its time online so far`,
    label: "either way",
  };
}

/** BC: the invitation and The Red Pill. */
function redPillTerm(inputs: DestroyEstimateInputs): DestroyTerm {
  const { prior } = inputs;
  if (inputs.redPillInstalled) return done("BC", "The Red Pill installed");
  const cycle = prior?.redPillCycleMs ?? null;
  if (inputs.daedalus === "donations installed") {
    return cycle === null
      ? none("BC", "after the donations install: no prior's Red Pill cycle, none")
      : {
          term: "BC",
          ms: cycle,
          atLeast: false,
          source: `after the donations install: the prior's Red Pill cycle (${prior?.bitNode})`,
          label: "either way",
        };
  }
  if (inputs.daedalus === "joined" && inputs.holdEtaMs !== null) {
    const hold = inputs.holdEtaMs;
    return {
      term: "BC",
      ms: hold + (cycle ?? 0),
      atLeast: cycle === null,
      source:
        "joined: A5's ETA for the hold (with the share if it runs at the choice; ×~1.6 cautious otherwise)" +
        (cycle === null
          ? ", no prior's Red Pill cycle (at least)"
          : `, plus the prior's Red Pill cycle (${prior?.bitNode})`),
      label: "cautious",
    };
  }
  if (prior?.bcMs == null) return none("BC", "no prior: none");
  const since = inputs.countMetOnlineMs === null ? 0 : Math.max(0, inputs.onlineMs - inputs.countMetOnlineMs);
  return {
    term: "BC",
    ms: Math.max(prior.bcMs - since, cycle ?? 0),
    atLeast: false,
    source:
      `the prior's B + C (${prior.bitNode})` +
      (inputs.countMetOnlineMs === null ? "" : ", less the time since the count was met, its Red Pill cycle at least") +
      (inputs.daedalus === "joined" ? " (joined, no hold's ETA)" : ""),
    label: "either way",
  };
}

/** D: w0r1d_d43m0n's level. */
function levelTerm(inputs: DestroyEstimateInputs, requiredLevel: number): DestroyTerm {
  const { prior } = inputs;
  if (inputs.redPillInstalled && inputs.levellingMs !== null) {
    return {
      term: "D",
      ms: inputs.levellingMs,
      atLeast: false,
      source: "levelling's chosen candidate (#336)",
      label: "either way",
    };
  }
  if (prior?.dMs == null) return none("D", "no prior: none");
  if (prior.requiredLevel !== requiredLevel) {
    return none("D", `the prior's (${prior.bitNode}) at level ${prior.requiredLevel}, not ${requiredLevel}: none`);
  }
  // After The Red Pill, before levelling's first choice: the prior's, and said so.
  const waiting = inputs.redPillInstalled ? ", levelling not yet chosen" : "";
  if (prior.dBeforeLevelling === true) {
    return {
      term: "D",
      ms: prior.dMs,
      atLeast: false,
      source: `the prior's (${prior.bitNode}), pre-#336 (no levelling choice before its destroy): cautious${waiting}`,
      label: "cautious",
    };
  }
  return {
    term: "D",
    ms: prior.dMs,
    atLeast: false,
    source: `the prior's (${prior.bitNode})${waiting}`,
    label: "either way",
  };
}

/** The estimate (#360): each term, the remaining and the total. */
export function destroyEstimate(inputs: DestroyEstimateInputs): DestroyEstimate {
  const required = daedalusAugmentationsRequired(inputs.currentNode, inputs.ownedSF);
  const requiredLevel = worldDaemonRequiredLevel(inputs.currentNode, inputs.ownedSF);
  const terms = [countTerm(inputs, required), redPillTerm(inputs), levelTerm(inputs, requiredLevel)];
  const remainingMs = terms.reduce((sum, term) => sum + (term.ms ?? 0), 0);
  return {
    terms,
    remainingMs,
    totalMs: inputs.onlineMs + remainingMs,
    atLeast: terms.some((term) => term.atLeast),
    never: terms.some((term) => term.ms === Number.POSITIVE_INFINITY),
    required,
    requiredLevel,
  };
}
