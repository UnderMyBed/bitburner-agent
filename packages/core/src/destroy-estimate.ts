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
 *   runs at the choice; cautious either way, the store's 1.2-2.6× the hold they timed: BN1.2's and BN1.3's 157 and 184
 *   min against 62 and 72, BN1.4's 35 against 30) plus
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
 * The Red Pill by the formulas; restarts and offline time (the online clock); Black Ops' route (#359); a prior scaled
 * by the multipliers.
 *
 * **BN2, the gang's route** (#357's slice 3; `destroyRouteOf`): The Red Pill is the gang's faction's (`Faction/
 * FactionHelpers.tsx:172-202`), so Daedalus's count never counts, and A and BC are the planner's BN2 route's:
 * - A, the gang formed: 0 once formed (an install keeps the gang, `Prestige.ts:133-146`), or The Red Pill installed;
 *   before, τ_g, the planner's wait for the gang (#357's (1), core's `gangFormingTiming`'s `waitMs`: avmnite-02h's level
 *   at the measured experience rate and `GANG_FORMING_STEPS_MS`), either way (the port openers' money left out,
 *   optimistic; the rate's rise with the level left out, cautious); none while it isn't measured.
 * - BC, The Red Pill: 0 once installed; with the gang, (3)'s chosen candidate's estimate (`gangInstallTiming`: keep,
 *   install now, or bank R* then install) to its reputation at the gang's faction, plus its install, the commit
 *   (`GANG_ROUTE_COMMIT_MS`, #343's 2 min), either way (#357's (3)'s labels: more than one more install left out,
 *   cautious; the money reset and the ×0.95 compounding, optimistic; the members' growth, either way); none before the
 *   gang, or with (3) not made (the gang unread, or earning no respect in the cycle), or at no rate in a pause to train
 *   (the gang rule's estimate of its end, #374, said); never at no rate outside a pause.
 * - D as Daedalus's route has it: none before The Red Pill with no prior at 15,000 (BN2.1's), so "at least"; D before
 *   The Red Pill by the formulas is a later slice.
 */
import { augmentationBitNodeMultipliers } from "./augmentations.ts";
import { daedalusAugmentationsRequired } from "./factions.ts";
import { GANG_ROUTE_COMMIT_MS } from "./gang-route.ts";

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

/** The BitNodes whose route to the destroy the estimate models: Daedalus's (#360), and BN2's gang (#357). */
export const DESTROY_ESTIMATE_BITNODES: readonly number[] = [1, 2, 4, 5];

/** A BitNode's route to The Red Pill, as the estimate models it: Daedalus's count, or the gang's faction (BN2). */
export type DestroyRoute = "daedalus" | "gang";

/** The route the estimate models in `currentNode` (`DESTROY_ESTIMATE_BITNODES`), or null: none modelled there. */
export function destroyRouteOf(currentNode: number): DestroyRoute | null {
  if (!DESTROY_ESTIMATE_BITNODES.includes(currentNode)) return null;
  return currentNode === 2 ? "gang" : "daedalus";
}

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
  /** BN2's gang route (#357): its figures, required there (`destroyRouteOf`'s "gang"); ignored elsewhere. */
  gang?: DestroyGangInputs | null;
}

/** BN2's gang route as the estimate reads it (#357's slice 3): the gang rule's and the planner's figures. */
export interface DestroyGangInputs {
  /** The gang formed in this BitNode (an install keeps it). */
  formed: boolean;
  /**
   * Before the gang: τ_g, the planner's wait for the gang (#357's (1), `gangFormingTiming`'s `waitMs`), ms; null not
   * measured (no experience rate yet, or avmnite-02h's level unread); Infinity with no experience coming.
   */
  waitMs: number | null;
  /**
   * With the gang, before The Red Pill: (3)'s choice and its estimate to The Red Pill's reputation at the gang's faction
   * (`gangInstallTiming`'s `keepMs`, `installNowMs` or `bankMs`), ms, Infinity at no rate; null not made.
   */
  redPill: { choice: "keep" | "install" | "bank"; ms: number } | null;
  /** The gang's plan earning no respect now (#374): the gang rule's estimate of the time left until it does, ms; or null. */
  earningInMs: number | null;
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
        "joined: A5's ETA for the hold (with the share if it runs at the choice; cautious, the store's 1.2-2.6× the hold)" +
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
      source: `the prior's (${prior.bitNode}), pre-#336 (levelling chosen late, or not, after its Red Pill): cautious${waiting}`,
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

/** A, BN2's gang route (#357): the gang formed. */
function gangFormedTerm(inputs: DestroyEstimateInputs, gang: DestroyGangInputs): DestroyTerm {
  if (inputs.redPillInstalled) return done("A", "The Red Pill installed");
  if (gang.formed) return done("A", "the gang formed");
  if (gang.waitMs === null) {
    return none("A", "before the gang: τ_g not measured (no experience rate yet, or avmnite-02h's level unread): none");
  }
  return {
    term: "A",
    ms: gang.waitMs,
    atLeast: false,
    source:
      "τ_g, the planner's wait for the gang (#357's (1)): avmnite-02h's level at the measured experience rate, and 70 s " +
      "for the backdoor, invitation, join and forming (the port openers' money left out: optimistic; the rate's rise " +
      "with the level: cautious)",
    label: "either way",
  };
}

/** BC, BN2's gang route (#357): The Red Pill's reputation at the gang's faction, by (3), then its install. */
function gangRedPillTerm(inputs: DestroyEstimateInputs, gang: DestroyGangInputs): DestroyTerm {
  if (inputs.redPillInstalled) return done("BC", "The Red Pill installed");
  if (!gang.formed)
    return none("BC", "before the gang: The Red Pill's reputation at its faction, (3)'s once it forms: none");
  const pause =
    gang.earningInMs === null
      ? ""
      : `; the gang's plan earning no respect now, about ${Math.round(gang.earningInMs / 60_000)} min more by the gang ` +
        "rule's estimate (#374)";
  const { redPill } = gang;
  if (redPill === null) {
    return none(
      "BC",
      `with the gang: (3)'s estimate not made (the gang unread, or no respect earned this cycle)${pause}: none`,
    );
  }
  if (redPill.ms === Number.POSITIVE_INFINITY && gang.earningInMs !== null) {
    return none("BC", `with the gang: (3)'s ${redPill.choice} at no rate now, a pause${pause}: none`);
  }
  return {
    term: "BC",
    ms: redPill.ms + GANG_ROUTE_COMMIT_MS,
    atLeast: false,
    source:
      `(3)'s choice, ${redPill.choice}: its estimate to The Red Pill's reputation at the gang's faction (#357), then ` +
      "its install, the commit (2 min, #343)",
    label: "either way",
  };
}

/** The estimate (#360): each term, the remaining and the total. In BN2 the gang's route (#357) gives A and BC. */
export function destroyEstimate(inputs: DestroyEstimateInputs): DestroyEstimate {
  const required = daedalusAugmentationsRequired(inputs.currentNode, inputs.ownedSF);
  const requiredLevel = worldDaemonRequiredLevel(inputs.currentNode, inputs.ownedSF);
  const route = destroyRouteOf(inputs.currentNode);
  const gang = inputs.gang ?? null;
  if (route === "gang" && gang === null) {
    throw new RangeError(`BitNode ${inputs.currentNode}'s estimate is the gang's route (#357): its figures are needed`);
  }
  const terms =
    route === "gang" && gang !== null
      ? [gangFormedTerm(inputs, gang), gangRedPillTerm(inputs, gang), levelTerm(inputs, requiredLevel)]
      : [countTerm(inputs, required), redPillTerm(inputs), levelTerm(inputs, requiredLevel)];
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
