// Augmentations in the run report (#210): the installs the slow snapshots show, and the augmentation rule's events (its
// decisions, progress on the count rule (#222), purchases, installs sent and cycles called off), with the failures: a
// purchase not queued, an install sent with no reset seen after it, an install reported done with no reset after it,
// and a cycle overdue its install (#222). Donations (#225): each made, and two failures: a donation the faction state
// never showed, and donations unused (one within reach for 30 minutes online with the brain counting none).
import {
  acceptsDonations,
  augmentationBitNodeMultipliers,
  augmentationCost,
  augmentationsSoldBy,
  daedalusCountOf,
  donationsUnlocked,
  donationToReach,
  FACTION_NAMES,
  factionReadingKind,
  factionReadingOf,
  favorAfterInstall,
  favorToDonate,
  installGains,
  isWorthInstalling,
  type MediumSnapshotData,
  missingPrerequisites,
  NEUROFLUX_GOVERNOR,
  reputationToUnlockDonations,
  type SlowSnapshotData,
} from "@bitburner-agent/core";
import {
  AUGMENTATION_BOUGHT_EVENT_KIND,
  AUGMENTATION_CYCLE_CALLED_OFF_EVENT_KIND,
  AUGMENTATION_DONATED_EVENT_KIND,
  AUGMENTATION_DONATION_FAILED_EVENT_KIND,
  AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND,
  AUGMENTATION_INSTALL_NOT_RESET_EVENT_KIND,
  AUGMENTATION_INSTALL_SENT_EVENT_KIND,
  AUGMENTATION_NOT_QUEUED_EVENT_KIND,
  AUGMENTATION_PROGRESS_EVENT_KIND,
  advanceOnlineClock,
  describeDonation,
  describeProgress,
  describeReason,
  formatEta,
  type OnlineClock,
} from "./augmentations.ts";
import type { StoredEvent } from "./telemetry-store.ts";

/** The augmentation rule's events (#210): section 3's, so left out of section 1's timeline. */
export const AUGMENTATION_EVENT_KINDS = [
  AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND,
  AUGMENTATION_PROGRESS_EVENT_KIND,
  AUGMENTATION_BOUGHT_EVENT_KIND,
  AUGMENTATION_NOT_QUEUED_EVENT_KIND,
  AUGMENTATION_CYCLE_CALLED_OFF_EVENT_KIND,
  AUGMENTATION_INSTALL_SENT_EVENT_KIND,
  AUGMENTATION_INSTALL_NOT_RESET_EVENT_KIND,
  AUGMENTATION_DONATED_EVENT_KIND,
  AUGMENTATION_DONATION_FAILED_EVENT_KIND,
];

/**
 * Donations unused (#225): an augmentation within reach by a donation (a joined faction with donations unlocked sells
 * it, the money covers its price and the donation for its missing reputation) this long online, the Augmentations
 * switch on, with the brain's progress counting none by donation, and nothing bought, donated or chosen to install.
 */
export const DONATIONS_UNUSED_ONLINE_MS = 30 * 60_000;

/** What a slow snapshot shows within reach by a donation (#225), before the money: each, at its donor. */
interface DonationOffer {
  augmentation: string;
  faction: string;
  price: number;
  missing: number;
}

/**
 * A cycle this long online with no install chosen is overdue (#222): the bar is 1 from 14 h (core's `installBars`), so
 * by 16 h anything affordable is installed, and nothing affordable in 16 h is reputation stuck, a failure too.
 */
export const INSTALL_OVERDUE_ONLINE_MS = 16 * 3_600_000;

/** An install the slow snapshots show: another `lastAugReset`, and what `ownedAugs` gained. */
interface SeenInstall {
  /** When the first slow snapshot showing it arrived. */
  seenAtMs: number;
  /** The augmentations it installed, NeuroFlux Governor once per level. */
  installed: string[];
}

export const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
export const formatMoney = (money: unknown) =>
  isFiniteNumber(money) ? `$${Math.round(money).toLocaleString("en-US")}` : "unknown";
const formatReputation = (reputation: unknown) =>
  isFiniteNumber(reputation) ? Math.round(reputation).toLocaleString("en-US") : "unknown";
export const fieldsOf = (detail: unknown) =>
  (typeof detail === "object" && detail !== null ? detail : {}) as Record<string, unknown>;

/**
 * Why a stored install was chosen, in words. An earlier brain's (#210, before #222) gave its reason as "nothing reachable"
 * or "sooner installing" with the next augmentation's two ways, or, earlier still, none: "nothing left" with no way
 * carrying on, else "sooner installing", as main's report inferred it.
 */
function describeStoredReason(fields: Record<string, unknown>): string {
  const way = (value: unknown) => {
    const each = fieldsOf(value);
    return { augmentation: typeof each.augmentation === "string" ? each.augmentation : "?", ms: each.ms };
  };
  const without = fields.without ?? null;
  const reason =
    typeof fields.reason === "string" ? fields.reason : without === null ? "nothing left" : "sooner installing";
  if (reason === "nothing reachable")
    return "nothing else reachable at a joined faction's work (a reputation rate of 0)";
  if (reason === "sooner installing") {
    const [withInstall, carryingOn] = [way(fields.with), way(without)];
    const eta = (ms: unknown) => formatEta(isFiniteNumber(ms) ? ms : null);
    return `the next sooner installing (${eta(withInstall.ms)} against ${eta(carryingOn.ms)}, ${carryingOn.augmentation})`;
  }
  return describeReason(reason, countsOf(fields) ?? {});
}

/** A stored event's counts and bars (#222), or null where they aren't numbers. */
function countsOf(fields: Record<string, unknown>) {
  const { affordable, affordableWithNeuroFlux, bar, barWithNeuroFlux } = fields;
  if (![affordable, affordableWithNeuroFlux, bar, barWithNeuroFlux].every(isFiniteNumber)) return null;
  return { affordable, affordableWithNeuroFlux, bar, barWithNeuroFlux } as Record<
    "affordable" | "affordableWithNeuroFlux" | "bar" | "barWithNeuroFlux",
    number
  >;
}

/** A stored progress's Daedalus count (#228), where it's as the brain writes it; null otherwise. */
function shortOf(value: unknown): { installed: number; required: number } | null {
  const { installed, required } = fieldsOf(value);
  return isFiniteNumber(installed) && isFiniteNumber(required) ? { installed, required } : null;
}

/**
 * A stored `augmentationProgress` (#222) in words: "5 of 8 new augmentations affordable (7 of 12 with NeuroFlux), 1.2 h
 * online this cycle; the bar falls to 7 in 48 min", then the countdown or the hold.
 */
function describeStoredProgress(fields: Record<string, unknown>): string {
  const counts = countsOf(fields);
  if (counts === null) return "the counts not stored";
  const number = (value: unknown) => (isFiniteNumber(value) ? value : null);
  const countdown = fieldsOf(fields.countdown);
  return (
    describeProgress({
      ...counts,
      byDonation: number(fields.byDonation) ?? 0,
      onlineMs: number(fields.onlineMs) ?? undefined,
      barFallsInMs: number(fields.barFallsInMs),
      barWithNeuroFluxFallsInMs: number(fields.barWithNeuroFluxFallsInMs),
      short: shortOf(fields.short),
    }) +
    (isFiniteNumber(countdown.endsInMs)
      ? `; install countdown${countdown.quick === true ? " (a quick install)" : ""}, ${formatEta(countdown.endsInMs)} ` +
        "left"
      : "") +
    (typeof fields.held === "string" ? `; held: ${fields.held}` : "")
  );
}

/** A donation not shown, or an install with no reset, in words: section 3 lists each, summarised or not (#245). */
function anomalyOf(kind: string, fields: Record<string, unknown>): string {
  if (kind === AUGMENTATION_DONATION_FAILED_EVENT_KIND) {
    return (
      `donation not shown: ${describeDonation(fields as never)}, the faction state showing ` +
      formatReputation(fields.shown)
    );
  }
  const queued = Array.isArray(fields.queued) ? fields.queued.map(String) : [];
  return `install reported done but the game didn't reset (queue: ${describeAugmentations(queued)})`;
}

/**
 * What a slow snapshot shows within reach by a donation (#225), its money aside: each augmentation worth installing,
 * not owned, its prerequisites owned, no joined seller's reputation reaching it, and sold by a joined faction taking
 * donations with them unlocked (the one with the most reputation); short of Daedalus's count (#228), any counts. Empty
 * where the snapshot doesn't say, or core doesn't know what it says.
 */
export function donationOffersOf(data: SlowSnapshotData): DonationOffer[] {
  const reading = factionReadingOf(data);
  const state = reading?.state ?? null;
  const info = data.resetInfo as Partial<SlowSnapshotData["resetInfo"]> | undefined;
  if (state === null || reading === null || factionReadingKind(reading) === "unread") return [];
  if (!Number.isInteger(info?.currentNode) || typeof info?.ownedAugs !== "object" || info.ownedAugs === null) return [];
  try {
    const currentNode = info.currentNode as number;
    const ownedSF = (info.ownedSF ?? {}) as Record<string, number>;
    const multipliers = augmentationBitNodeMultipliers(currentNode, ownedSF);
    const purchaseState = {
      installed: info.ownedAugs as Record<string, number>,
      queued: state.queuedAugmentations,
      sourceFile11Level: ownedSF["11"] ?? 0,
      bitNodeMultipliers: multipliers,
    };
    const joined = state.joined.filter((faction) => FACTION_NAMES.includes(faction.name));
    const shops = new Map(
      joined.map((faction) => [faction.name, augmentationsSoldBy(faction.name, currentNode, null)]),
    );
    const owned = (name: string) =>
      Object.hasOwn(purchaseState.installed, name) || state.queuedAugmentations.includes(name);
    const { short } = daedalusCountOf({
      currentNode,
      ownedSF,
      installed: purchaseState.installed,
      joined: state.joined,
      invitations: state.invitations,
    });
    const offers: DonationOffer[] = [];
    for (const name of new Set([...shops.values()].flat())) {
      if (!isWorthInstalling(name, short) || owned(name) || missingPrerequisites(name, purchaseState).length > 0)
        continue;
      const { money, reputation } = augmentationCost(name, purchaseState);
      const sellers = joined.filter((faction) => shops.get(faction.name)?.includes(name));
      if (sellers.some((faction) => faction.reputation >= reputation)) continue;
      // No gang is modelled (none in BN1): the gang's faction would take none.
      const donors = sellers.filter(
        (faction) => acceptsDonations(faction.name, null) && donationsUnlocked(faction.favor, multipliers),
      );
      const donor = donors.reduce<(typeof donors)[number] | null>(
        (best, each) => (best === null || each.reputation > best.reputation ? each : best),
        null,
      );
      if (donor !== null)
        offers.push({ augmentation: name, faction: donor.name, price: money, missing: reputation - donor.reputation });
    }
    return offers;
  } catch {
    return [];
  }
}

/**
 * A faction's favour after the next install and when its donations unlock (#225), for the run report's faction
 * progress: "; 12.3 after the next install; donations unlock at the next install", "…at 150 favour, 230,145 more
 * reputation this cycle", or "; donations unlocked". Nothing for one that takes none, or where `slow` doesn't say.
 */
export function donationStatus(
  faction: string,
  { reputation, favor }: { reputation: number; favor: number },
  slow: SlowSnapshotData | undefined,
): string {
  const info = slow?.resetInfo as Partial<SlowSnapshotData["resetInfo"]> | undefined;
  // No gang is modelled (none in BN1): the gang's faction would take none.
  if (!acceptsDonations(faction, null) || !Number.isInteger(info?.currentNode)) return "";
  try {
    const multipliers = augmentationBitNodeMultipliers(
      info?.currentNode as number,
      (info?.ownedSF ?? {}) as Record<string, number>,
    );
    if (donationsUnlocked(favor, multipliers)) return "; donations unlocked";
    const unlock = reputationToUnlockDonations(favor, multipliers);
    return (
      `; ${favorAfterInstall(favor, reputation).toFixed(1)} after the next install; donations unlock ` +
      (reputation >= unlock
        ? "at the next install"
        : `at ${favorToDonate(multipliers)} favour, ${formatReputation(unlock - reputation)} more reputation this cycle`)
    );
  } catch {
    return "";
  }
}

/** "BitWire, NeuroFlux Governor ×2", or "none". */
export function describeAugmentations(names: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts].map(([name, count]) => (count === 1 ? name : `${name} ×${count}`)).join(", ") || "none";
}

/** The multipliers an install gained above 1, from core's data: "hacking ×1.180, hacking_speed ×1.061". */
export function describeGains(names: readonly string[]): string {
  const known = names.filter((name) => {
    try {
      installGains([name]);
      return true;
    } catch {
      return false;
    }
  });
  const gains = Object.entries(installGains(known)).filter(([, gain]) => gain !== 1);
  return gains.length === 0
    ? "no hacking multiplier"
    : gains.map(([key, gain]) => `${key} ×${gain.toFixed(3)}`).join(", ");
}

/** The slow snapshot's `lastAugReset` and `ownedAugs`, or null where they aren't as the Agent writes them. */
function resetOf(data: SlowSnapshotData) {
  const info = data.resetInfo as Partial<SlowSnapshotData["resetInfo"]> | undefined;
  const owned = info?.ownedAugs;
  if (!isFiniteNumber(info?.lastAugReset) || typeof owned !== "object" || owned === null) return null;
  if (!Object.values(owned).every(isFiniteNumber)) return null;
  return { lastAugReset: info.lastAugReset, ownedAugs: owned };
}

/** The Agent's last disconnect at or before `atMs`, and the connect after it, or null. */
function awayAround(events: readonly StoredEvent[], atMs: number) {
  const disconnect = events.filter((event) => event.kind === "agentDisconnected" && event.atMs <= atMs).at(-1);
  if (disconnect === undefined) return null;
  const connect = events.find((event) => event.kind === "agentConnected" && event.atMs >= disconnect.atMs);
  return connect === undefined ? null : { disconnectedAtMs: disconnect.atMs, connectedAtMs: connect.atMs };
}

/** Augmentations over a run (#210), folded from the slow snapshots one at a time. */
export class AugmentationTimeline {
  readonly installs: SeenInstall[] = [];
  /** The slow snapshots' resets, in order: when the first showing each arrived, and its `lastAugReset`. */
  readonly #resets: { atMs: number; lastAugReset: number }[] = [];
  #owned: Record<string, number> | null = null;
  /**
   * Each cycle over the window (#222): its `lastAugReset`, its first and last slow snapshots' arrivals, and its time
   * online, folded through the rule's own `advanceOnlineClock`.
   */
  readonly #cycles: { lastAugReset: number; firstAtMs: number; lastAtMs: number; onlineMs: number }[] = [];
  #clock: OnlineClock | null = null;
  /** Each slow snapshot's offers by donation (#225), and the medium snapshots' money and `faction_rep`. */
  readonly #offers: {
    atMs: number;
    gameTimeMs: number;
    lastAugReset: number;
    offers: DonationOffer[];
    factionWorkRepGain: number;
  }[] = [];
  readonly #money: { atMs: number; money: number; factionRep: number }[] = [];

  /** A medium snapshot, in time order (#225): the money and `faction_rep` a donation is weighed with. */
  addMedium(atMs: number, data: MediumSnapshotData): void {
    const player = data.player as { money?: unknown; mults?: { faction_rep?: unknown } } | undefined;
    const money = player?.money;
    const factionRep = player?.mults?.faction_rep;
    if (isFiniteNumber(money) && isFiniteNumber(factionRep)) this.#money.push({ atMs, money, factionRep });
  }

  /** A slow snapshot, which arrived at `atMs`, taken at the game's time `gameTimeMs` (the bars' clock's). */
  addSlow(atMs: number, data: SlowSnapshotData, gameTimeMs: number): void {
    const reset = resetOf(data);
    if (reset === null) return;
    this.#clock = advanceOnlineClock(this.#clock, gameTimeMs, reset.lastAugReset).clock;
    let cycle = this.#cycles.at(-1);
    if (cycle?.lastAugReset !== reset.lastAugReset) {
      cycle = { lastAugReset: reset.lastAugReset, firstAtMs: atMs, lastAtMs: atMs, onlineMs: 0 };
      this.#cycles.push(cycle);
    }
    cycle.lastAtMs = atMs;
    cycle.onlineMs = this.#clock.onlineMs;
    const info = data.resetInfo as Partial<SlowSnapshotData["resetInfo"]> | undefined;
    let factionWorkRepGain = 1;
    try {
      factionWorkRepGain = augmentationBitNodeMultipliers(
        info?.currentNode as number,
        (info?.ownedSF ?? {}) as Record<string, number>,
      ).FactionWorkRepGain;
    } catch {}
    this.#offers.push({
      atMs,
      gameTimeMs,
      lastAugReset: reset.lastAugReset,
      offers: donationOffersOf(data),
      factionWorkRepGain,
    });
    const previous = this.#resets.at(-1);
    if (previous !== undefined && previous.lastAugReset !== reset.lastAugReset) {
      const installed: string[] = [];
      for (const [name, level] of Object.entries(reset.ownedAugs)) {
        for (let each = this.#owned?.[name] ?? 0; each < level; each += 1) installed.push(name);
      }
      this.installs.push({ seenAtMs: atMs, installed });
    }
    if (previous?.lastAugReset !== reset.lastAugReset) this.#resets.push({ atMs, lastAugReset: reset.lastAugReset });
    this.#owned = reset.ownedAugs;
  }

  /** Section 3's lines: each decision, purchase, install sent, install seen and cycle called off, in time order. */
  actionLines(events: readonly StoredEvent[], formatTime: (ms: number) => string): string[] {
    const entries: { atMs: number; text: string }[] = [];
    for (const { atMs, kind, detail } of events) {
      const fields = fieldsOf(detail);
      if (kind === AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND) {
        const set = Array.isArray(fields.set) ? (fields.set as { augmentation?: unknown }[]) : [];
        // An earlier brain's (#210) gave the game's time since the install; this one, the time online (#222).
        const since = isFiniteNumber(fields.onlineMs)
          ? `${formatEta(fields.onlineMs)} online this cycle`
          : `${formatEta(isFiniteNumber(fields.sinceResetMs) ? fields.sinceResetMs : null)} since the last`;
        entries.push({
          atMs,
          text:
            `install chosen, ${since}: buying ` +
            `${set.map((each) => String(each.augmentation)).join(", ") || "nothing more"} (${formatMoney(fields.cost)}); ` +
            describeStoredReason(fields) +
            (Array.isArray(fields.donations) && fields.donations.length > 0
              ? `; donating first: ${fields.donations.map((each) => describeDonation(fieldsOf(each) as never)).join(", ")}`
              : ""),
        });
      } else if (kind === AUGMENTATION_DONATED_EVENT_KIND) {
        entries.push({
          atMs,
          text:
            `donated ${describeDonation(fields as never)}: reputation ${formatReputation(fields.before)} → ` +
            formatReputation(fields.after),
        });
      } else if (kind === AUGMENTATION_DONATION_FAILED_EVENT_KIND) {
        entries.push({ atMs, text: anomalyOf(kind, fields) });
      } else if (kind === AUGMENTATION_PROGRESS_EVENT_KIND) {
        entries.push({ atMs, text: `progress: ${describeStoredProgress(fields)}` });
      } else if (kind === AUGMENTATION_BOUGHT_EVENT_KIND) {
        const level = fields.augmentation === NEUROFLUX_GOVERNOR ? ` (level ${String(fields.level)})` : "";
        entries.push({
          atMs,
          text:
            `bought ${String(fields.augmentation)}${level} from ${String(fields.faction)} for ` +
            `${formatMoney(fields.price)} (queue ${String(fields.queueLength)})`,
        });
      } else if (kind === AUGMENTATION_INSTALL_SENT_EVENT_KIND) {
        const queued = Array.isArray(fields.queued) ? fields.queued.map(String) : [];
        entries.push({
          atMs,
          text:
            `install sent (${fields.source === "manual" ? "yours" : "the brain's"}): ` + describeAugmentations(queued),
        });
      } else if (kind === AUGMENTATION_CYCLE_CALLED_OFF_EVENT_KIND) {
        entries.push({ atMs, text: `install cycle called off: ${String(fields.reason)}` });
      } else if (kind === AUGMENTATION_INSTALL_NOT_RESET_EVENT_KIND) {
        entries.push({ atMs, text: anomalyOf(kind, fields) });
      }
    }
    for (const install of this.installs) {
      const away = awayAround(events, install.seenAtMs);
      entries.push({
        atMs: install.seenAtMs,
        text:
          `installed (seen in a slow snapshot): ${describeAugmentations(install.installed)}; ` +
          describeGains(install.installed) +
          (away === null
            ? ""
            : `; the Agent disconnected at ${formatTime(away.disconnectedAtMs)} and was back ` +
              `${formatEta(away.connectedAtMs - away.disconnectedAtMs)} later`),
      });
    }
    entries.sort((a, b) => a.atMs - b.atMs);
    const lines = ["  augmentations (the brain's install decisions and purchases, and the installs):"];
    for (const { atMs, text } of entries) lines.push(`    ${formatTime(atMs)}  ${text}`);
    if (entries.length === 0) lines.push("    none");
    return lines;
  }

  /**
   * Section 3's summary (#245; `actionLines` with --verbose): a line a cycle (`cycleOf` names it, as 2b does) with the
   * set bought, NeuroFlux Governor's levels as one count, and its total price; the installs chosen and called off; the
   * donations; the installs sent. A donation not shown, or an install with no reset, is listed under its cycle all the
   * same. The progress events and the installs seen are left out: 2b says how each cycle went and what it installed.
   */
  summaryLines(
    events: readonly StoredEvent[],
    formatTime: (ms: number) => string,
    cycleOf: (atMs: number) => string,
  ): string[] {
    interface Tally {
      bought: string[];
      levels: number[];
      spent: number;
      chosen: number;
      /** The reasons the installs were chosen for, as stored ("count reached"), each once. */
      reasons: string[];
      calledOff: number;
      donations: number;
      donated: number;
      sent: string[];
      anomalies: string[];
    }
    const cycles = new Map<string, Tally>();
    const tallyOf = (atMs: number) => {
      const label = cycleOf(atMs);
      const known = cycles.get(label);
      if (known !== undefined) return known;
      const tally: Tally = {
        bought: [],
        levels: [],
        spent: 0,
        chosen: 0,
        reasons: [],
        calledOff: 0,
        donations: 0,
        donated: 0,
        sent: [],
        anomalies: [],
      };
      cycles.set(label, tally);
      return tally;
    };
    for (const { atMs, kind, detail } of [...events].sort((a, b) => a.atMs - b.atMs)) {
      const fields = fieldsOf(detail);
      if (kind === AUGMENTATION_BOUGHT_EVENT_KIND) {
        const tally = tallyOf(atMs);
        if (fields.augmentation === NEUROFLUX_GOVERNOR) tally.levels.push(Number(fields.level));
        else tally.bought.push(String(fields.augmentation));
        if (isFiniteNumber(fields.price)) tally.spent += fields.price;
      } else if (kind === AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND) {
        const tally = tallyOf(atMs);
        tally.chosen += 1;
        const reason = typeof fields.reason === "string" ? fields.reason : "reason not stored";
        if (!tally.reasons.includes(reason)) tally.reasons.push(reason);
      } else if (kind === AUGMENTATION_CYCLE_CALLED_OFF_EVENT_KIND) {
        tallyOf(atMs).calledOff += 1;
      } else if (kind === AUGMENTATION_DONATED_EVENT_KIND) {
        const tally = tallyOf(atMs);
        tally.donations += 1;
        if (isFiniteNumber(fields.amount)) tally.donated += fields.amount;
      } else if (kind === AUGMENTATION_INSTALL_SENT_EVENT_KIND) {
        tallyOf(atMs).sent.push(fields.source === "manual" ? "yours" : "the brain's");
      } else if (
        kind === AUGMENTATION_DONATION_FAILED_EVENT_KIND ||
        kind === AUGMENTATION_INSTALL_NOT_RESET_EVENT_KIND
      ) {
        tallyOf(atMs).anomalies.push(`      ${formatTime(atMs)}  ${anomalyOf(kind, fields)}`);
      }
    }
    const lines = [
      "  augmentations, by cycle: the set bought, NeuroFlux Governor's levels as one count (--verbose lists each " +
        "decision and purchase):",
    ];
    const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
    for (const [label, tally] of cycles) {
      const count = tally.bought.length + tally.levels.length;
      const levels = tally.levels.filter(Number.isFinite);
      const neuroFlux =
        tally.levels.length === 0
          ? []
          : [
              `${NEUROFLUX_GOVERNOR} ×${tally.levels.length}` +
                (levels.length !== tally.levels.length
                  ? ""
                  : levels.length === 1
                    ? ` (level ${levels[0]})`
                    : ` (levels ${Math.min(...levels)}–${Math.max(...levels)})`),
            ];
      const set = [...(tally.bought.length === 0 ? [] : [describeAugmentations(tally.bought)]), ...neuroFlux];
      const parts = [
        count === 0 ? "bought none" : `bought ${count} for ${formatMoney(tally.spent)}: ${set.join(", ")}`,
      ];
      if (tally.chosen > 0 || tally.calledOff > 0) {
        parts.push(
          plural(tally.chosen, "install chosen", "installs chosen") +
            (tally.reasons.length > 0 ? ` (${tally.reasons.join(", ")})` : "") +
            (tally.calledOff > 0 ? `, ${tally.calledOff} called off` : ""),
        );
      }
      if (tally.donations > 0) {
        parts.push(`${plural(tally.donations, "donation", "donations")}, ${formatMoney(tally.donated)}`);
      }
      if (tally.sent.length > 0) parts.push(`install sent (${tally.sent.join(", ")})`);
      lines.push(`    ${label}: ${parts.join("; ")}`, ...tally.anomalies);
    }
    if (cycles.size === 0) lines.push("    none");
    return lines;
  }

  /**
   * Section 4's lines, each failure added to `failures`: a purchase not queued (the rule's event); an install reported
   * done with no reset in the next slow snapshot (the rule's event, #213 re-review); an install sent with no slow
   * snapshot showing another `lastAugReset` within `withinMs` (not judged where the window ends first, nor where the
   * cycle was called off meanwhile: withdrawn; one reported done with no reset is the failure above); and a cycle
   * overdue its install (#222, `#overdueLines`).
   */
  healthLines(
    events: readonly StoredEvent[],
    {
      untilMs,
      withinMs,
      augmentationsEnabled,
      failures,
      formatTime,
    }: {
      untilMs: number;
      withinMs: number;
      augmentationsEnabled: boolean;
      failures: string[];
      formatTime: (ms: number) => string;
    },
  ): string[] {
    const lines = ["  augmentation purchases reported done and never queued:"];
    const notQueued = events.filter((event) => event.kind === AUGMENTATION_NOT_QUEUED_EVENT_KIND);
    for (const { atMs, detail } of notQueued) {
      const fields = fieldsOf(detail);
      const level = fields.augmentation === NEUROFLUX_GOVERNOR ? ` (level ${String(fields.level)})` : "";
      const line =
        `augmentation not queued: ${String(fields.augmentation)}${level}, reported bought at ` +
        `${formatTime(Number(fields.boughtAtMs))}, not in the faction state's queue by ${formatTime(atMs)}`;
      lines.push(`    ${line}`);
      failures.push(line);
    }
    if (notQueued.length === 0) lines.push("    none");
    lines.push("  installs reported done with no reset in the next slow snapshot:");
    const notReset = events.filter((event) => event.kind === AUGMENTATION_INSTALL_NOT_RESET_EVENT_KIND);
    for (const { atMs, detail } of notReset) {
      const queued = fieldsOf(detail).queued;
      const line =
        `install reported done but the game didn't reset: at ${formatTime(atMs)}, with the faction state's queue ` +
        `${describeAugmentations(Array.isArray(queued) ? queued.map(String) : [])}`;
      lines.push(`    ${line}`);
      failures.push(line);
    }
    if (notReset.length === 0) lines.push("    none");
    lines.push(`  installs sent and not seen done (a slow snapshot with another reset) within ${formatEta(withinMs)}:`);
    let notSeen = 0;
    for (const sent of events.filter((event) => event.kind === AUGMENTATION_INSTALL_SENT_EVENT_KIND)) {
      if (sent.atMs + withinMs > untilMs) continue;
      const before = this.#resets.filter((reset) => reset.atMs <= sent.atMs).at(-1);
      const seen = this.#resets.some(
        (reset) =>
          reset.atMs > sent.atMs && reset.atMs <= sent.atMs + withinMs && reset.lastAugReset !== before?.lastAugReset,
      );
      if (seen) continue;
      const reportedDone = notReset.find((event) => event.atMs >= sent.atMs && event.atMs <= sent.atMs + withinMs);
      if (reportedDone !== undefined) {
        lines.push(
          `    install sent at ${formatTime(sent.atMs)}, reported done with no reset at ` +
            `${formatTime(reportedDone.atMs)}: the failure above`,
        );
        continue;
      }
      // Withdrawn: the cycle called off (the switch turned off) before the reset was due.
      const calledOff = events.find(
        (event) =>
          event.kind === AUGMENTATION_CYCLE_CALLED_OFF_EVENT_KIND &&
          event.atMs >= sent.atMs &&
          event.atMs <= sent.atMs + withinMs,
      );
      if (calledOff !== undefined) {
        lines.push(
          `    install sent at ${formatTime(sent.atMs)}, withdrawn at ${formatTime(calledOff.atMs)}: not a failure`,
        );
        continue;
      }
      notSeen++;
      const line =
        `install not seen done: sent at ${formatTime(sent.atMs)}, no slow snapshot with another reset ` +
        `${formatEta(withinMs)} on`;
      lines.push(`    ${line}`);
      failures.push(line);
    }
    if (notSeen === 0) lines.push("    none");
    lines.push(...this.#overdueLines(events, { augmentationsEnabled, failures, formatTime }));
    lines.push(...this.#donationLines(events, { augmentationsEnabled, failures, formatTime }));
    return lines;
  }

  /**
   * The donations' failures (#225): each donation the faction state never showed (the rule's event), and donations
   * unused: a stretch of `DONATIONS_UNUSED_ONLINE_MS` online (the slow snapshots' gaps left out, as the bars' clock
   * does) in one cycle in which every slow snapshot showed an augmentation within reach by a donation, the money (the
   * latest medium snapshot's, less what the brain's counted set and its donations cost, #225 review) covering its price
   * and its donation, while the brain's progress in force counted none by
   * donation and it bought, donated and chose to install nothing. Shown, not counted, with the switch off now.
   */
  #donationLines(
    events: readonly StoredEvent[],
    {
      augmentationsEnabled,
      failures,
      formatTime,
    }: { augmentationsEnabled: boolean; failures: string[]; formatTime: (ms: number) => string },
  ): string[] {
    const lines = ["  donations reported done and never shown in the faction's reputation:"];
    const failed = events.filter((event) => event.kind === AUGMENTATION_DONATION_FAILED_EVENT_KIND);
    for (const { atMs, detail } of failed) {
      const fields = fieldsOf(detail);
      const line =
        `donation failed: ${describeDonation(fields as never)}, reported done at ${formatTime(Number(fields.donatedAtMs))}, ` +
        `the faction state showing ${formatReputation(fields.shown)} by ${formatTime(atMs)}`;
      lines.push(`    ${line}`);
      failures.push(line);
    }
    if (failed.length === 0) lines.push("    none");
    lines.push(
      `  donations unused (one within reach ${formatEta(DONATIONS_UNUSED_ONLINE_MS)} online, counted by none)` +
        (augmentationsEnabled ? ":" : ": the Augmentations switch is off now, so these are shown, not counted:"),
    );
    const acted = [
      AUGMENTATION_BOUGHT_EVENT_KIND,
      AUGMENTATION_DONATED_EVENT_KIND,
      AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND,
    ];
    let clock: OnlineClock | null = null;
    let stretch: { fromMs: number; onlineFromMs: number; lastAugReset: number; flagged: boolean } | null = null;
    let unused = 0;
    for (const check of this.#offers) {
      clock = advanceOnlineClock(clock, check.gameTimeMs, check.lastAugReset).clock;
      const money = this.#money.findLast((each) => each.atMs <= check.atMs);
      const progress = events.findLast(
        (event) =>
          event.kind === AUGMENTATION_PROGRESS_EVENT_KIND &&
          event.atMs <= check.atMs &&
          fieldsOf(event.detail).lastAugReset === check.lastAugReset,
      );
      // The money left after the brain's counted set (#225 review): its greedy set may rightly spend it on another.
      const setCost = fieldsOf(progress?.detail).setCost;
      const left = money === undefined ? 0 : money.money - (isFiniteNumber(setCost) ? setCost : 0);
      const offer =
        money === undefined
          ? undefined
          : check.offers.find(
              (each) => each.price + donationToReach(each.missing, money.factionRep, check.factionWorkRepGain) <= left,
            );
      const counted =
        isFiniteNumber(fieldsOf(progress?.detail).byDonation) && (fieldsOf(progress?.detail).byDonation as number) > 0;
      const fromMs = stretch?.fromMs;
      const actedSince =
        fromMs !== undefined &&
        events.some((event) => acted.includes(event.kind) && event.atMs > fromMs && event.atMs <= check.atMs);
      if (offer === undefined || money === undefined || counted) {
        stretch = null;
        continue;
      }
      if (stretch === null || actedSince || stretch.lastAugReset !== check.lastAugReset) {
        stretch = {
          fromMs: check.atMs,
          onlineFromMs: clock.onlineMs,
          lastAugReset: check.lastAugReset,
          flagged: false,
        };
        continue;
      }
      const onlineMs = clock.onlineMs - stretch.onlineFromMs;
      if (onlineMs < DONATIONS_UNUSED_ONLINE_MS || stretch.flagged) continue;
      stretch.flagged = true;
      unused++;
      const donation = donationToReach(offer.missing, money.factionRep, check.factionWorkRepGain);
      const line =
        `donations unused: ${offer.augmentation} within reach at ${offer.faction} by a donation ` +
        `(${formatMoney(donation)} and its ${formatMoney(offer.price)}, with ${formatMoney(money.money)}) for ` +
        `${formatEta(onlineMs)} online from ${formatTime(stretch.fromMs)} to ${formatTime(check.atMs)}, and the brain ` +
        "counted none by donation, and bought, donated and chose to install nothing";
      lines.push(`    ${line}`);
      if (augmentationsEnabled) failures.push(line);
    }
    if (unused === 0) lines.push("    none");
    return lines;
  }

  /**
   * A cycle overdue its install (#222): its time online reaching `INSTALL_OVERDUE_ONLINE_MS`, the larger of the window's
   * slow snapshots' count and the brain's own clock in its `augmentationProgress` events (which carries time from
   * before the window), and no install chosen in it in the window (from the window's start, for the first). A failure
   * only with the Augmentations switch on (the dashboard's, now: the store keeps no history of it), and not while The
   * Red Pill's way held the rule (#215) at the cycle's last progress: shown, not counted, then. A hold for Daedalus's
   * count (#243), 30 minutes at most, doesn't excuse it.
   */
  #overdueLines(
    events: readonly StoredEvent[],
    {
      augmentationsEnabled,
      failures,
      formatTime,
    }: { augmentationsEnabled: boolean; failures: string[]; formatTime: (ms: number) => string },
  ): string[] {
    const lines = [
      `  install overdue (a cycle ${formatEta(INSTALL_OVERDUE_ONLINE_MS)} online with no install chosen)` +
        (augmentationsEnabled ? ":" : ": the Augmentations switch is off now, so these are shown, not counted:"),
    ];
    let overdue = 0;
    for (const [index, cycle] of this.#cycles.entries()) {
      const progress = events.filter(
        (event) =>
          event.kind === AUGMENTATION_PROGRESS_EVENT_KIND && fieldsOf(event.detail).lastAugReset === cycle.lastAugReset,
      );
      const onlineMs = Math.max(
        cycle.onlineMs,
        ...progress.map((event) => fieldsOf(event.detail).onlineMs).filter(isFiniteNumber),
      );
      if (onlineMs < INSTALL_OVERDUE_ONLINE_MS) continue;
      const fromMs = index === 0 ? Number.NEGATIVE_INFINITY : cycle.firstAtMs;
      const untilMs = this.#cycles[index + 1]?.firstAtMs ?? Number.POSITIVE_INFINITY;
      const chosen = events.some(
        (event) =>
          event.kind === AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND && event.atMs >= fromMs && event.atMs < untilMs,
      );
      if (chosen) continue;
      overdue++;
      const last = progress.at(-1);
      const fields = last === undefined ? {} : fieldsOf(last.detail);
      const held = typeof fields.held === "string" && (fields.countHold ?? null) === null ? fields.held : null;
      const line =
        `install overdue: ${formatEta(onlineMs)} online in the cycle seen from ${formatTime(cycle.firstAtMs)} to ` +
        `${formatTime(cycle.lastAtMs)}, and no install chosen; its last counts: ` +
        (last === undefined ? "none recorded" : describeStoredProgress(fieldsOf(last.detail)));
      const counted = augmentationsEnabled && typeof held !== "string";
      lines.push(`    ${line}${typeof held === "string" ? " (held for The Red Pill's way: not a failure)" : ""}`);
      if (counted) failures.push(line);
    }
    if (overdue === 0) lines.push("    none");
    return lines;
  }
}
