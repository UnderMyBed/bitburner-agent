// Favour first or count first (#247), in the simulator: an SF1 start (BN1.2, 32 GB home, #294's item 6), the brain's
// rules as on Steam, under each faction work policy (`FACTION_WORK_POLICY_SETTING`).
// - CI, seed 1: two minutes in, a harness edit joins BitRunners with 5 favour. Under favour first, A5 works there
//   toward the reputation that unlocks its donations at the next install (core's `favourFirstWork`), and the run report
//   says so; under count first, today's, A5's own choice, never favour first's.
// - The study, `FAVOUR_FIRST_STUDY=1`: no harness edit. Each of `FAVOUR_FIRST_SEEDS` (seed 1 unless given) under each of
//   `FAVOUR_FIRST_POLICIES` (both unless given), from the start to the first install that unlocks a faction's donations,
//   or `FAVOUR_FIRST_HOURS` virtual hours (12 unless given). It records each install, each join of the faction favour
//   first grinds at, and the unlock, and prints them as one JSON line (`favour-first result`); `FAVOUR_FIRST_LOG` names a
//   file for the progress lines and the result, so a run the watchdog stops still leaves what it reached. Heavy: one
//   seed and policy a run (the brain README's favour first suite says how), the results in #247 and its PR.
import { appendFileSync } from "node:fs";
import {
  type FactionWorkPolicy,
  factionStateOf,
  favorAfterInstall,
  favourFirstFaction,
  type MediumSnapshotData,
  reputationToUnlockDonations,
  type SlowSnapshotData,
} from "@bitburner-agent/core";
import { expect, test } from "vitest";
import { FACTION_WORK_CHOSEN_EVENT_KIND, type FactionWorkChoice, writeFactionWorkPolicy } from "../src/factions.ts";
import { runReport } from "../src/run-report.ts";
import { EPOCH_MS } from "./helpers/agent-in-simulation.ts";
import { useFreshStarts } from "./helpers/fresh-start.ts";

/** A comma-separated list from `name`, each item checked; `fallback` when unset. Anything else fails loudly. */
function listOf<T>(name: string, text: string | undefined, fallback: T[], parse: (item: string) => T | null): T[] {
  if (text === undefined) return fallback;
  const items = text.split(",").map((each) => parse(each.trim()));
  if (items.length === 0 || items.some((each) => each === null)) {
    throw new Error(`${name} is ${JSON.stringify(text)}: give a comma-separated list`);
  }
  return items as T[];
}
const seedOf = (item: string) => (/^[1-9]\d*$/.test(item) ? Number(item) : null);
const policyOf = (item: string): FactionWorkPolicy | null =>
  item === "countFirst" || item === "favourFirst" ? item : null;
const hoursOf = (text: string | undefined) => {
  const hours = text === undefined ? 12 : Number(text);
  if (!(hours > 0 && hours <= 48)) throw new Error(`FAVOUR_FIRST_HOURS is ${JSON.stringify(text)}: give 0 to 48`);
  return hours;
};

const freshStartOf = useFreshStarts();
const MINUTE = 60_000;
/** BN1 entered with SF1.1: BN1.2, home at 32 GB, as run #3's and the fast model's `{ "1": 1 }` start. */
const SF1_START = { kind: "bitnode", n: 1, sourceFiles: { 1: 1 } } as const;
const STUDY = process.env.FAVOUR_FIRST_STUDY === "1";
const SEEDS = listOf("FAVOUR_FIRST_SEEDS", process.env.FAVOUR_FIRST_SEEDS, [1], seedOf);
const POLICIES = listOf<FactionWorkPolicy>(
  "FAVOUR_FIRST_POLICIES",
  process.env.FAVOUR_FIRST_POLICIES,
  ["countFirst", "favourFirst"],
  policyOf,
);
const HORIZON_MS = hoursOf(process.env.FAVOUR_FIRST_HOURS) * 60 * MINUTE;
const LOG = process.env.FAVOUR_FIRST_LOG;
/** The harness edit's time in CI: the Agent connected and its snapshots flowing. */
const EDITED_AFTER_MS = 2 * MINUTE;
/** BN1's favour to donate, 150 (`FavorToDonateToFaction` 1). */
const DONATIONS = { FavorToDonateToFaction: 1 };

test("the knobs: lists of seeds and policies, or the defaults; hours 0 to 48; anything else fails loudly", () => {
  expect(listOf("X", undefined, [1], seedOf)).toEqual([1]);
  expect(listOf("X", "1, 4", [1], seedOf)).toEqual([1, 4]);
  expect(listOf("X", "favourFirst", [], policyOf)).toEqual(["favourFirst"]);
  for (const odd of ["", "1,", "0", "2.5", "x"]) expect(() => listOf("X", odd, [1], seedOf)).toThrow(/X is/);
  expect(() => listOf("X", "favour first", [], policyOf)).toThrow(/X is/);
  expect(hoursOf(undefined)).toBe(12);
  expect(hoursOf("6.5")).toBe(6.5);
  for (const odd of ["0", "-1", "49", "x"]) expect(() => hoursOf(odd)).toThrow(/FAVOUR_FIRST_HOURS/);
});

test.each(POLICIES)(
  "seed 1, BitRunners joined at 5 favour: under %s, favour first's work toward its donations only under favour first",
  { timeout: 180_000 },
  async (policy) => {
    const fresh = await freshStartOf({ withDesiredState: true, seed: 1, fixture: SF1_START });
    const { game, simulation } = fresh;
    writeFactionWorkPolicy(fresh.data.store, policy);
    await game.run(EDITED_AFTER_MS);
    await simulation.diagnostics.joinFactionWithReputation("BitRunners", 0);
    await simulation.diagnostics.setFactionFavor("BitRunners", 5);
    const editedAtMs = game.clock.now();
    const chosen = () =>
      fresh.data.store
        .eventsInWindow({ environment: "E1", sinceMs: editedAtMs, untilMs: game.clock.now() })
        .filter((event) => event.kind === FACTION_WORK_CHOSEN_EVENT_KIND)
        .map((event) => event.detail as FactionWorkChoice);
    // The slow snapshot (60 s) shows BitRunners joined; the work's chosen at the next update.
    await game.runUntil(() => chosen().some((each) => each.faction === "BitRunners"), 3 * MINUTE);
    const report = runReport(
      fresh.data.store,
      { environment: "E1", sinceMs: EPOCH_MS, untilMs: game.clock.now() },
      { verbose: true },
    );
    if (policy === "favourFirst") {
      const first = chosen().find((each) => each.faction === "BitRunners");
      expect(first).toMatchObject({
        faction: "BitRunners",
        target: "donations",
        favor: 5,
        reputationNeeded: reputationToUnlockDonations(5, DONATIONS),
        favourFirst: true,
      });
      expect(report.text).toMatch(
        /hacking for BitRunners, for [^\n]*: donations at the next install, [^\n]*favour 5\.0, 150\.0 after the next install at it, [^\n]*\), favour first \(the faction selling the most countable augmentations\)/,
      );
    } else {
      expect(chosen().every((each) => each.favourFirst === undefined)).toBe(true);
      expect(report.text).not.toMatch(/favour first/);
    }
  },
);

/** One install: when (virtual ms from the start), the count after it, and the favour it banked at favour first's faction. */
interface InstallRecord {
  atMs: number;
  installed: number;
  /** The favour banked at each joined faction, by the game's formula on its last reading (a lower bound). */
  banked: Record<string, number>;
}

/** What a run reached, for #247's table. */
interface StudyResult {
  seed: number;
  policy: FactionWorkPolicy;
  horizonMs: number;
  /** Virtual ms run, and the real seconds it took. */
  ranMs: number;
  realSeconds: number;
  installs: InstallRecord[];
  /** Each join of favour first's faction (BitRunners in BN1): virtual ms. */
  grindFactionJoins: number[];
  /** The first install that unlocked a faction's donations, or null within the horizon. */
  donationsUnlocked: { atMs: number; faction: string; install: number; installed: number } | null;
  /** At the end: the hacking level, and the favour each faction would bank at an install then. */
  hacking: number | null;
  favourIfInstalledNow: Record<string, number>;
  /** Faction work choices stored, favour first's among them: the policy took. */
  choices: number;
  favourFirstChoices: number;
}

test.skipIf(!STUDY).each(SEEDS.flatMap((seed) => POLICIES.map((policy) => [seed, policy] as const)))(
  "study, seed %i under %s: from an SF1 start to the first donations unlocked",
  { timeout: 48 * 60 * MINUTE },
  async (seed, policy) => {
    const realStart = Date.now();
    const fresh = await freshStartOf({ withDesiredState: true, seed, fixture: SF1_START });
    const { game } = fresh;
    writeFactionWorkPolicy(fresh.data.store, policy);
    const startMs = game.clock.now();
    const slow = () => fresh.latest<SlowSnapshotData>("slow");
    const say = (line: string) => {
      if (LOG !== undefined) appendFileSync(LOG, `${line}\n`);
    };
    const grindFaction = () => favourFirstFaction(1, slow()?.resetInfo.ownedAugs ?? {}).faction;
    say(`seed ${seed}, ${policy}: set up in ${((Date.now() - realStart) / 1000).toFixed(1)} s real`);
    const installs: InstallRecord[] = [];
    const grindFactionJoins: number[] = [];
    let donationsUnlocked: StudyResult["donationsUnlocked"] = null;
    let lastReset = slow()?.resetInfo.lastAugReset ?? null;
    let lastState = factionStateOf(slow());
    let grindJoined = false;
    let nextProgressMs = 0;
    while (game.clock.now() - startMs < HORIZON_MS && donationsUnlocked === null) {
      await game.run(30_000);
      const now = slow();
      const atMs = game.clock.now() - startMs;
      const reset = now?.resetInfo.lastAugReset ?? null;
      if (reset !== null && lastReset !== null && reset !== lastReset) {
        // An install: what the last reading before it banks, by the game's formula (`Faction/formulas/favor.ts`).
        const banked = Object.fromEntries(
          (lastState?.joined ?? []).map((each) => [each.name, favorAfterInstall(each.favor, each.reputation)]),
        );
        const record = { atMs, installed: Object.keys(now?.resetInfo.ownedAugs ?? {}).length, banked };
        installs.push(record);
        grindJoined = false;
        say(`  install ${installs.length} at ${(atMs / MINUTE).toFixed(1)} min: ${JSON.stringify(record)}`);
        const unlocked = Object.entries(banked).find(([, favor]) => favor >= DONATIONS.FavorToDonateToFaction * 150);
        if (unlocked !== undefined) {
          donationsUnlocked = { atMs, faction: unlocked[0], install: installs.length, installed: record.installed };
        }
      }
      lastReset = reset ?? lastReset;
      const state = factionStateOf(now);
      if (state !== null) lastState = state;
      // A faction rejoined with its donations unlocked, where the last reading before the install fell short of it.
      const rejoined = state?.joined.find((each) => each.favor >= 150);
      if (donationsUnlocked === null && rejoined !== undefined && installs.length > 0) {
        const install = installs.at(-1) as InstallRecord;
        donationsUnlocked = {
          atMs: install.atMs,
          faction: rejoined.name,
          install: installs.length,
          installed: install.installed,
        };
      }
      const grind = grindFaction();
      if (!grindJoined && state?.joined.some((each) => each.name === grind)) {
        grindJoined = true;
        grindFactionJoins.push(atMs);
        say(`  ${grind} joined at ${(atMs / MINUTE).toFixed(1)} min`);
      }
      if (atMs >= nextProgressMs) {
        nextProgressMs += 10 * MINUTE;
        const medium = fresh.medium() as MediumSnapshotData | null;
        const hacking = (medium?.player.skills as { hacking?: number } | undefined)?.hacking;
        const at = state?.joined.find((each) => each.name === grind);
        say(
          `  v ${(atMs / MINUTE).toFixed(0)} min, real ${((Date.now() - realStart) / 1000).toFixed(0)} s: hacking ` +
            `${hacking}, money ${fresh.money()?.toExponential(2)}, installs ${installs.length}, installed ` +
            `${Object.keys(now?.resetInfo.ownedAugs ?? {}).length}, ${grind} ` +
            (at ? `rep ${Math.round(at.reputation)} favour ${at.favor.toFixed(1)}` : "not joined"),
        );
      }
    }
    const events = fresh.data.store
      .eventsInWindow({ environment: "E1", sinceMs: EPOCH_MS, untilMs: game.clock.now() })
      .filter((event) => event.kind === FACTION_WORK_CHOSEN_EVENT_KIND);
    const medium = fresh.medium() as MediumSnapshotData | null;
    const result: StudyResult = {
      seed,
      policy,
      horizonMs: HORIZON_MS,
      ranMs: game.clock.now() - startMs,
      realSeconds: Math.round((Date.now() - realStart) / 1000),
      installs,
      grindFactionJoins,
      donationsUnlocked,
      hacking: (medium?.player.skills as { hacking?: number } | undefined)?.hacking ?? null,
      favourIfInstalledNow: Object.fromEntries(
        (lastState?.joined ?? []).map((each) => [each.name, favorAfterInstall(each.favor, each.reputation)]),
      ),
      choices: events.length,
      favourFirstChoices: events.filter((event) => (event.detail as FactionWorkChoice).favourFirst === true).length,
    };
    const line = `favour-first result ${JSON.stringify(result)}`;
    console.log(line);
    say(line);
    // The policy took: favour first's work under favour first once its faction was joined, never under count first.
    if (policy === "countFirst" || grindFactionJoins.length === 0) expect(result.favourFirstChoices).toBe(0);
    else expect(result.favourFirstChoices).toBeGreaterThan(0);
  },
);
