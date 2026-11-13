// Hacknet to Netburners' invitation (#387, roadmap #347 Track 2, 3a): the brain's first Hacknet code, and only what the
// invitation needs. Netburners sells five augmentations at 1,875 to 12,500 reputation, among the cheapest that count
// toward Daedalus's count, and no run had ever joined it (scratchpad/m4/predaedalus/findings.md). Its invitation needs
// hacking 80 and Hacknet totals of 100 levels, 8 GB RAM and 4 cores over every node (`Faction/FactionInfo.tsx:675`,
// `Faction/FactionJoinCondition.ts:215-264`): core's `hacknetSetupPlan` finds the cheapest way (6 nodes, about $170k
// from none at ×1), and Hacknet is lost at each install (`PlayerObjectGeneralMethods.ts:130`).
// - **The planner's candidate** (owner decision 67): while Netburners isn't joined, hacking is 80 and one of its five
//   isn't installed or queued, the controller hands A6 the route (`netburnersRoute`), and install timing's countables
//   count them (core's `countablesToCome`: the setup's money at the income, the game's check, then the reputation at
//   A5's rate). Once invited, A5 joins it (no enemies) and works there, and A6 buys there, as at any other faction.
// - **The purchase** (`HacknetRule`): only while the planner's wait waits for one of them (A6's `netburnersWaitedFor`),
//   so never while installing now, nor once they're installed or queued, nor where Hacknet servers stand in (BN9, SF9:
//   left out), nor where the planner's wait doesn't reach them (the setup not worth its τ). Then the
//   `buyHacknetSetup` intent, after a program or home RAM (the purchase order: they first, then Hacknet, then cloud
//   servers), with the money above every hold cloud servers keep (`#reserveForOtherPurchase`) and home RAM's
//   (Daedalus's, the countdown's, The Red Pill's, an invitation's); while it waits for money, cloud servers keep its
//   price as they keep a program's. Bought again each cycle, as the install loses it.
// - **Seen:** each phase logged and stored (wanted, with the setup's estimate; bought; invited), the dashboard's
//   factions panel, and the run report's factions section. No invitation within the estimate and 10 minutes is loud
//   (decision 45): a log line, the event, a run report failure.
// - **Left out, labelled:** Hacknet's money (small, not counted); hashes (SF9); the nodes' own state, which the brain
//   doesn't read: the setup's cost is from no node (the most it costs: cautious); the worker buys from what's there.
import {
  augmentationsSoldBy,
  type FactionState,
  type HacknetCostMultipliers,
  hacknetServersInEffect,
  hacknetSetupPlan,
  type Intent,
  intentId,
  NETBURNERS,
  NETBURNERS_INVITATION,
  NEUROFLUX_GOVERNOR,
  type NetburnersRoute,
  THE_RED_PILL,
} from "@bitburner-agent/core";

/** The rule's intent (#387): one, with no arguments; done once the game shows the totals. */
export const HACKNET_SETUP_INTENT: Intent = {
  id: intentId("buyHacknetSetup", {}),
  action: "buyHacknetSetup",
  args: {},
};

/** Past the setup's estimate by this with no invitation, it's loud (#387, decision 45). */
export const NETBURNERS_NOT_INVITED_AFTER_MS = 10 * 60_000;

/** The rule's events (#387), for the run report. */
export const HACKNET_SETUP_EVENT_KIND = "hacknetSetup";

export interface HacknetEvent {
  type: typeof HACKNET_SETUP_EVENT_KIND;
  atMs: number;
  /**
   * wanted: the planner's wait reaches Netburners' countables (the setup's cost, and the estimate to the invitation);
   * bought: the worker reported the totals; invited: Netburners invited or joined; notInvited: none past the estimate
   * and 10 minutes.
   */
  phase: "wanted" | "bought" | "invited" | "notInvited";
  cost: number;
  /** The setup's money at the income and the game's check (A6's τ part), when wanted; else the first's. */
  estimateMs: number | null;
  /** Since it was first wanted this cycle, for invited and notInvited. */
  sinceWantedMs: number | null;
}

/** What the controller reads for the rule (#387): Netburners' state this cycle, from the snapshots. */
export interface NetburnersFacts {
  lastAugReset: number;
  joined: boolean;
  invited: boolean;
  /** What it sells in the BitNode (core's `augmentationsSoldBy`), and those neither installed nor queued. */
  sold: string[];
  toInstall: string[];
  hackingLevel: number;
  /** BN9 or SF9: left out. */
  hacknetServers: boolean;
  /** The setup's cost from no node, by the player's multipliers (`getPlayer().mults`). */
  cost: number;
}

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** The player's Hacknet cost multipliers from `getPlayer().mults` (#387), or null where any is missing. */
export function hacknetMultipliersOf(player: unknown): HacknetCostMultipliers | null {
  const mults = (player as { mults?: Record<string, unknown> } | null | undefined)?.mults;
  const purchaseCost = mults?.hacknet_node_purchase_cost;
  const levelCost = mults?.hacknet_node_level_cost;
  const ramCost = mults?.hacknet_node_ram_cost;
  const coreCost = mults?.hacknet_node_core_cost;
  if (!isNumber(purchaseCost) || !isNumber(levelCost) || !isNumber(ramCost) || !isNumber(coreCost)) return null;
  return { purchaseCost, levelCost, ramCost, coreCost };
}

/**
 * Netburners' facts this cycle (#387), or null where the snapshots don't say (no faction state, a BitNode core doesn't
 * know).
 */
export function netburnersFactsOf({
  state,
  lastAugReset,
  currentNode,
  installed,
  ownedSF,
  bitNodeOptions,
  hackingLevel,
  mults,
}: {
  state: FactionState;
  lastAugReset: number;
  currentNode: number;
  installed: Readonly<Record<string, number>>;
  ownedSF: Readonly<Record<string, number>>;
  bitNodeOptions: Readonly<Record<string, unknown>>;
  hackingLevel: number;
  mults: HacknetCostMultipliers;
}): NetburnersFacts | null {
  let sold: string[];
  try {
    sold = augmentationsSoldBy(NETBURNERS, currentNode, null);
  } catch {
    return null;
  }
  return {
    lastAugReset,
    joined: state.joined.some((each) => each.name === NETBURNERS),
    invited: state.invitations.includes(NETBURNERS),
    sold,
    toInstall: sold.filter(
      (name) =>
        name !== NEUROFLUX_GOVERNOR &&
        name !== THE_RED_PILL &&
        !Object.hasOwn(installed, name) &&
        !state.queuedAugmentations.includes(name),
    ),
    hackingLevel,
    hacknetServers: hacknetServersInEffect(currentNode, ownedSF, bitNodeOptions),
    cost: hacknetSetupPlan([], mults).cost,
  };
}

/** Why Netburners' countables aren't the planner's now (#387), or null: they are. */
export function netburnersLeftOut(facts: NetburnersFacts | null): string | null {
  if (facts === null) return "the Agent's snapshots";
  if (facts.hacknetServers) return "nothing: Hacknet servers here (BN9 or SF9), left out";
  if (facts.joined) return "nothing: Netburners joined (A5 and A6 have it)";
  if (facts.toInstall.length === 0) return "nothing: Netburners' augmentations installed or queued";
  if (facts.hackingLevel < NETBURNERS_INVITATION.hacking) {
    return `hacking ${NETBURNERS_INVITATION.hacking} for Netburners' invitation (${Math.floor(facts.hackingLevel)} now)`;
  }
  return null;
}

/**
 * A6's route to Netburners' countables (#387, core's `NetburnersRoute`), or null where they aren't the planner's
 * (`netburnersLeftOut`). The setup's money is 0 once the worker reported it bought this cycle, or once invited.
 */
export function netburnersRoute(facts: NetburnersFacts | null, bought: boolean): NetburnersRoute | null {
  if (facts === null || netburnersLeftOut(facts) !== null) return null;
  return {
    sold: facts.sold,
    setupMoney: bought || facts.invited ? 0 : facts.cost,
    invited: facts.invited,
  };
}

/** What the controller hands the rule each update. */
export interface HacknetRuleInputs {
  facts: NetburnersFacts | null;
  /** A6's: the planner's wait waits for one of Netburners' countables, and their time to its invitation (τ's part). */
  waitedFor: { beforeJoinMs: number } | null;
  /** The worker reported the totals (the connected Agent's done). */
  done: boolean;
  /** An install chosen or counting down: Hacknet is lost at it. */
  installUnderWay: boolean;
  /** The purchase going first (a program or home RAM), in words, or null. */
  other: string | null;
  money: number | null;
  /** The money it leaves alone, the most of the holds, and what for. */
  hold: { amount: number; forWhat: string };
  nowMs: number | null;
}

/** What the dashboard shows (#387). */
export interface HacknetView {
  /** Wanted this cycle: the planner waits for Netburners' countables. */
  wanted: boolean;
  /** The setup's cost from no node, or null before the snapshots. */
  cost: number | null;
  /** Asked for now. */
  buying: boolean;
  /** Bought this cycle (the worker's word). */
  bought: boolean;
  invited: boolean;
  waitingFor: string | null;
}

const formatMoney = (money: number) => `$${Math.round(money).toLocaleString("en-US")}`;
/** "45 s", "12 min", "3.4 h". */
const describeDuration = (ms: number) =>
  ms < 90_000
    ? `${Math.round(ms / 1000)} s`
    : ms < 90 * 60_000
      ? `${Math.round(ms / 60_000)} min`
      : `${(ms / 3_600_000).toFixed(1)} h`;

/**
 * The rule (#387): the `buyHacknetSetup` intent while the planner waits for Netburners' countables and the money above
 * the holds covers the setup, its phases logged and stored once a cycle, and no invitation past the estimate and 10
 * minutes loud. In memory alone: a restarted brain starts the cycle's clock again (cautious: never a false failure).
 */
export class HacknetRule {
  readonly #log: (line: string) => void;
  readonly #emit: (event: HacknetEvent) => void;
  /** This cycle's: when first wanted, its estimate and cost, and each phase stored. */
  #cycle: {
    lastAugReset: number;
    wantedAtMs: number | null;
    estimateMs: number | null;
    cost: number;
    bought: boolean;
    invited: boolean;
    notInvited: boolean;
  } | null = null;
  #view: HacknetView = { wanted: false, cost: null, buying: false, bought: false, invited: false, waitingFor: null };

  constructor({
    log = () => {},
    emit = () => {},
  }: { log?: (line: string) => void; emit?: (event: HacknetEvent) => void }) {
    this.#log = log;
    this.#emit = emit;
  }

  view(): HacknetView {
    return this.#view;
  }

  /** The setup's price while wanted and not bought (cloud servers keep it as they keep a program's), else 0. */
  reserve(): number {
    return this.#view.wanted && !this.#view.bought && this.#view.cost !== null ? this.#view.cost : 0;
  }

  /** Bought this cycle, by the worker's word: A6's route then has no setup money left. */
  bought(lastAugReset: number | null): boolean {
    return this.#cycle !== null && this.#cycle.lastAugReset === lastAugReset && this.#cycle.bought;
  }

  update({ facts, waitedFor, done, installUnderWay, other, money, hold, nowMs }: HacknetRuleInputs): Intent | null {
    const atMs = nowMs ?? 0;
    if (facts === null) {
      this.#view = { ...this.#view, wanted: false, buying: false, waitingFor: "the Agent's snapshots" };
      return null;
    }
    if (this.#cycle?.lastAugReset !== facts.lastAugReset) {
      this.#cycle = {
        lastAugReset: facts.lastAugReset,
        wantedAtMs: null,
        estimateMs: null,
        cost: facts.cost,
        bought: false,
        invited: false,
        notInvited: false,
      };
    }
    const cycle = this.#cycle;
    const emit = (phase: HacknetEvent["phase"], sinceWantedMs: number | null = null) =>
      this.#emit({
        type: HACKNET_SETUP_EVENT_KIND,
        atMs,
        phase,
        cost: cycle.cost,
        estimateMs: cycle.estimateMs,
        sinceWantedMs,
      });
    const sinceWanted = cycle.wantedAtMs === null ? null : atMs - cycle.wantedAtMs;
    // Bought (the worker's word), noted before an invitation seen in the same update: the intent goes once invited.
    if (done && !cycle.bought && cycle.wantedAtMs !== null) {
      cycle.bought = true;
      this.#log(`hacknet: the setup for Netburners' invitation bought (${formatMoney(cycle.cost)} at most)`);
      emit("bought", sinceWanted);
    }
    // The invitation (or the join, if a slow snapshot shows it first), after the rule wanted it.
    if (cycle.wantedAtMs !== null && !cycle.invited && (facts.invited || facts.joined)) {
      cycle.invited = true;
      this.#log(`hacknet: Netburners invited, ${describeDuration(sinceWanted ?? 0)} after the setup was wanted`);
      emit("invited", sinceWanted);
    }
    const leftOut = netburnersLeftOut(facts);
    const wanted = leftOut === null && !facts.invited && waitedFor !== null && !installUnderWay;
    if (wanted && cycle.wantedAtMs === null) {
      cycle.wantedAtMs = atMs;
      cycle.estimateMs = waitedFor.beforeJoinMs;
      this.#log(
        `hacknet: the planner waits for Netburners' countables: its Hacknet setup, ${formatMoney(facts.cost)}, ` +
          `its invitation in ~${describeDuration(waitedFor.beforeJoinMs)}`,
      );
      emit("wanted");
    }
    // No invitation past the estimate and 10 minutes, the setup wanted all along: loud, once a cycle.
    if (
      cycle.wantedAtMs !== null &&
      !cycle.invited &&
      !cycle.notInvited &&
      sinceWanted !== null &&
      sinceWanted > (cycle.estimateMs ?? 0) + NETBURNERS_NOT_INVITED_AFTER_MS
    ) {
      cycle.notInvited = true;
      this.#log(
        `hacknet: NOT INVITED: Netburners hasn't invited ${describeDuration(sinceWanted)} after its setup was wanted ` +
          `(estimate ${describeDuration(cycle.estimateMs ?? 0)})${cycle.bought ? "" : ", the setup not bought"}`,
      );
      emit("notInvited", sinceWanted);
    }
    const view = (buying: boolean, waitingFor: string | null): Intent | null => {
      this.#view = {
        wanted,
        cost: facts.cost,
        buying,
        bought: cycle.bought,
        invited: facts.invited || facts.joined,
        waitingFor,
      };
      return buying ? HACKNET_SETUP_INTENT : null;
    };
    if (leftOut !== null) return view(false, leftOut);
    if (facts.invited) return view(false, "nothing: Netburners invited (A5 joins it)");
    if (installUnderWay) return view(false, "the install under way (Hacknet is lost at it)");
    if (waitedFor === null) return view(false, "the planner's wait to reach Netburners' countables");
    // Bought (#387's review): asked for no more, so it holds neither the purchase's turn nor any money (cloud servers,
    // gang equipment), and the worker isn't run again; the invitation's clock goes on.
    if (cycle.bought || done) return view(false, "Netburners' invitation (the setup bought)");
    if (other !== null) return view(false, `${other} first`);
    if (money === null) return view(false, "the player's money in the Agent's medium snapshot");
    if (money - hold.amount < facts.cost) {
      return view(
        false,
        hold.amount > 0
          ? `money above the ${formatMoney(hold.amount)} held for ${hold.forWhat} (${formatMoney(facts.cost)} the setup)`
          : `${formatMoney(facts.cost)} for the setup (${formatMoney(money)} now)`,
      );
    }
    return view(true, null);
  }
}

// --- What the run report reads (#387) --------------------------------------------------------------------------------

type Stored = { atMs: number; kind: string; detail: unknown };

const fieldsOf = (detail: unknown) =>
  (typeof detail === "object" && detail !== null ? detail : {}) as Record<string, unknown>;

function describeHacknetEvent(detail: unknown): string {
  const { phase, cost, estimateMs, sinceWantedMs } = fieldsOf(detail);
  const money = isNumber(cost) ? formatMoney(cost) : "?";
  const estimate = isNumber(estimateMs) ? describeDuration(estimateMs) : "?";
  const since = isNumber(sinceWantedMs) ? describeDuration(sinceWantedMs) : "?";
  if (phase === "wanted") return `the setup wanted (${money}), the invitation estimated in ${estimate}`;
  if (phase === "bought") return `the setup bought, ${since} after it was wanted`;
  if (phase === "invited") return `Netburners invited, ${since} after the setup was wanted (estimate ${estimate})`;
  if (phase === "notInvited") {
    return `NOT INVITED ${since} after the setup was wanted (estimate ${estimate}, and ${
      NETBURNERS_NOT_INVITED_AFTER_MS / 60_000
    } min)`;
  }
  return `${String(phase)} (not a phase this brain stores)`;
}

/** The factions section's lines (#387): each phase of Netburners' Hacknet setup; none where it was never wanted. */
export function hacknetLines(events: readonly Stored[], formatTime: (ms: number) => string): string[] {
  const own = events.filter((event) => event.kind === HACKNET_SETUP_EVENT_KIND);
  if (own.length === 0) return [];
  return [
    "    Netburners' Hacknet setup (#387: its invitation's totals, the cheapest way):",
    ...own.map((event) => `      ${formatTime(event.atMs)}  ${describeHacknetEvent(event.detail)}`),
  ];
}

/**
 * Section 4's lines (#387): each invitation not come within the estimate and 10 minutes, a failure; none where the
 * setup was never wanted in the window (so a report without it is as long as before).
 */
export function hacknetHealthLines(
  events: readonly Stored[],
  failures: string[],
  formatTime: (ms: number) => string,
): string[] {
  const lines = [
    `  Netburners not invited (its Hacknet setup's estimate and ${NETBURNERS_NOT_INVITED_AFTER_MS / 60_000} min, #387):`,
  ];
  if (!events.some((event) => event.kind === HACKNET_SETUP_EVENT_KIND)) return [];
  const late = events.filter(
    (event) => event.kind === HACKNET_SETUP_EVENT_KIND && fieldsOf(event.detail).phase === "notInvited",
  );
  for (const { atMs, detail } of late) {
    const line = `Netburners ${describeHacknetEvent(detail)}, at ${formatTime(atMs)}`;
    lines.push(`    ${line}`);
    failures.push(line);
  }
  if (late.length === 0) lines.push("    none");
  return lines;
}
