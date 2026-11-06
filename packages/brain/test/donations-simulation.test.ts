// Donations (#225), in the simulator: a fresh 8 GB start in BN1, the brain's rules as on Steam, and a harness edit two
// virtual minutes in that stands in for the hours before it.
// - Donating: CyberSec joined at 5,000 reputation with 150 favour (donations unlocked), and the money for its five and
//   the donation for Cranial Signal Processors - Gen I and II's reputation. The count rule counts the five, two by
//   donation: a quick install (#222). Committed, the brain donates first, sees CyberSec's reputation rise in the
//   faction state, then buys the five in buy order, Gen II far above the reputation earned. A5 never works for
//   CyberSec.
// - Working toward favour: BitRunners joined with 100 favour, its reputation a little short of the 306,374 that makes
//   150 favour at the next install. A5 works for it to that, not to The BitRunners Neurolink's 875,000, and stops
//   there.
// CI runs seed 1; `DONATION_SEEDS` (`1,2,3`, say) runs others.
import { factionStateOf, type SlowSnapshotData } from "@bitburner-agent/core";
import { expect, test } from "vitest";
import {
  AUGMENTATION_BOUGHT_EVENT_KIND,
  AUGMENTATION_DONATED_EVENT_KIND,
  AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND,
  AUGMENTATION_PROGRESS_EVENT_KIND,
} from "../src/augmentations.ts";
import { FACTION_WORK_CHOSEN_EVENT_KIND, FACTION_WORK_STOPPED_EVENT_KIND } from "../src/factions.ts";
import { runReport } from "../src/run-report.ts";
import { EPOCH_MS } from "./helpers/agent-in-simulation.ts";
import { useFreshStarts } from "./helpers/fresh-start.ts";

/** `DONATION_SEEDS`: seeds 1 or more, comma separated; unset, seed 1 alone (CI). Anything else fails loudly. */
function donationSeeds(text: string | undefined): number[] {
  if (text === undefined) return [1];
  const seeds = text.split(",").map((each) => each.trim());
  if (!seeds.every((each) => /^[1-9]\d*$/.test(each))) {
    throw new Error(`DONATION_SEEDS is ${JSON.stringify(text)}: give seeds 1 or more, comma separated`);
  }
  return seeds.map(Number);
}

const freshStartOf = useFreshStarts();
const SEEDS = donationSeeds(process.env.DONATION_SEEDS);
const MINUTE = 60_000;
/** When the harness edit comes: the Agent connected and its snapshots flowing, well inside a quick install's 20 min. */
const EDITED_AFTER_MS = 2 * MINUTE;
const FIVE = [
  "Cranial Signal Processors - Gen I",
  "Cranial Signal Processors - Gen II",
  "BitWire",
  "Synaptic Enhancement Implant",
  "Neurotrainer I",
];
const FIVE_COST = 447_170_900;
/** Gen II's 18,750 less CyberSec's 5,000, at a new player's `faction_rep` of 1, and core's margin: $13,750,010,000. */
const DONATION = 13_750_010_000;

test("DONATION_SEEDS: seeds 1 or more, or unset for seed 1; an empty or odd entry fails loudly", () => {
  expect(donationSeeds(undefined)).toEqual([1]);
  expect(donationSeeds("1, 4")).toEqual([1, 4]);
  for (const odd of ["", "1,", "0", "2.5", "x"]) expect(() => donationSeeds(odd)).toThrow(/DONATION_SEEDS/);
});

test.each(SEEDS)(
  "seed %i: CyberSec's donations unlocked: the donation first, then Gen I and II bought far above the reputation earned",
  { timeout: 180_000 },
  async (seed) => {
    const fresh = await freshStartOf({ withDesiredState: true, seed });
    const { game, simulation } = fresh;
    await game.run(EDITED_AFTER_MS);
    // Programs, home RAM and cloud servers off: nothing else takes the money.
    fresh.controller().setProgramsEnabled(false);
    fresh.controller().setHomeRamEnabled(false);
    fresh.controller().setCloudServersEnabled(false);
    await simulation.diagnostics.joinFactionWithReputation("CyberSec", 5_000);
    await simulation.diagnostics.setFactionFavor("CyberSec", 150);
    await simulation.diagnostics.setMoney(FIVE_COST + DONATION + 1_000_000);
    const editedAtMs = game.clock.now();
    const events = () =>
      fresh.data.store.eventsInWindow({ environment: "E1", sinceMs: editedAtMs, untilMs: game.clock.now() });
    const bought = () =>
      events()
        .filter((event) => event.kind === AUGMENTATION_BOUGHT_EVENT_KIND)
        .map((event) => event.detail as { augmentation: string; faction: string });
    await game.runUntil(() => bought().length >= 2, 6 * MINUTE);

    // Counted with the donation: five affordable, two by it, a quick install.
    const progress = events()
      .filter((event) => event.kind === AUGMENTATION_PROGRESS_EVENT_KIND)
      .map((event) => event.detail as { affordable: number; byDonation: number });
    expect(progress).toContainEqual(expect.objectContaining({ affordable: 5, byDonation: 2 }));
    const chosen = events().find((event) => event.kind === AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND)?.detail as {
      reason: string;
      affordable: number;
      donations: { faction: string; reputation: number; amount: number }[];
    };
    expect(chosen).toMatchObject({ reason: "quick install", affordable: 5 });
    expect(chosen.donations).toEqual([{ faction: "CyberSec", reputation: 18_750, amount: expect.any(Number) }]);
    // A little less than $13.75b: CyberSec gains reputation passively meanwhile.
    expect(chosen.donations[0]?.amount).toBeLessThanOrEqual(DONATION);
    expect(chosen.donations[0]?.amount).toBeGreaterThan(DONATION - 100_000_000);

    // The donation first, seen in the faction state; then the purchases in buy order, Gen II far above 5,000.
    const donated = events().find((event) => event.kind === AUGMENTATION_DONATED_EVENT_KIND);
    expect(donated?.detail).toMatchObject({ faction: "CyberSec", reputation: 18_750 });
    expect((donated?.detail as { after?: number } | undefined)?.after).toBeGreaterThanOrEqual(18_750);
    expect(donated?.atMs).toBeLessThan(
      events().find((event) => event.kind === AUGMENTATION_BOUGHT_EVENT_KIND)?.atMs as number,
    );
    expect(bought().map((each) => each.augmentation)).toEqual(FIVE.slice(0, bought().length));
    expect(bought().every((each) => each.faction === "CyberSec")).toBe(true);
    // A5 never worked for CyberSec: its reputation is bought.
    const worked = events()
      .filter((event) => event.kind === FACTION_WORK_CHOSEN_EVENT_KIND)
      .map((event) => (event.detail as { faction: string }).faction);
    expect(worked).not.toContain("CyberSec");

    // The run report: the donation, by default in its cycle's line with its faction (#245), with --verbose its own
    // line; and no donation failure.
    const reportWindow = { environment: "E1", sinceMs: EPOCH_MS, untilMs: game.clock.now() } as const;
    expect(runReport(fresh.data.store, reportWindow).text).toMatch(
      /\n {4}BN1\.1 1: [^\n]*; 1 install chosen \(quick install\); 1 donation: \$[\d,]+ to CyberSec[;\n]/,
    );
    const { text, failures } = runReport(fresh.data.store, reportWindow, { verbose: true });
    expect(text).toMatch(
      / {4}\S+ {2}donated \$[\d,]+ to CyberSec \(for 18,750 reputation\): reputation 5,\d{3} → 18,7\d\d/,
    );
    expect(failures.filter((failure) => failure.startsWith("donation"))).toEqual([]);
  },
);

test.each(SEEDS)(
  "seed %i: BitRunners at 100 favour: A5 works to the 306,374 that unlocks its donations at the next install, and stops",
  { timeout: 180_000 },
  async (seed) => {
    const fresh = await freshStartOf({ withDesiredState: true, seed });
    const { game, simulation } = fresh;
    const slow = () => fresh.latest<SlowSnapshotData>("slow");
    await game.run(EDITED_AFTER_MS);
    await simulation.diagnostics.joinFactionWithReputation("BitRunners", 306_374 - 30);
    await simulation.diagnostics.setFactionFavor("BitRunners", 100);
    const editedAtMs = game.clock.now();
    const events = () =>
      fresh.data.store.eventsInWindow({ environment: "E1", sinceMs: editedAtMs, untilMs: game.clock.now() });
    const work = () =>
      events().filter((event) =>
        [FACTION_WORK_CHOSEN_EVENT_KIND, FACTION_WORK_STOPPED_EVENT_KIND].includes(event.kind),
      );
    await game.runUntil(() => work().some((event) => event.kind === FACTION_WORK_STOPPED_EVENT_KIND), 10 * MINUTE);
    const [chosen, stopped] = work();
    // Toward the favour, not The BitRunners Neurolink's 875,000.
    expect(chosen?.detail).toMatchObject({
      faction: "BitRunners",
      reputationNeeded: 306_374,
      target: "donations",
      favor: 100,
    });
    expect((chosen?.detail as { augmentationReputation?: number } | undefined)?.augmentationReputation).toBeGreaterThan(
      306_374 * 1.1,
    );
    expect(stopped?.detail).toEqual({ reason: "an augmentation worth working for at the joined factions" });
    // Stopped once a slow snapshot showed the target: within a minute's work of it.
    const reputation = factionStateOf(slow())?.joined.find((each) => each.name === "BitRunners")?.reputation as number;
    expect(reputation).toBeGreaterThanOrEqual(306_374);
    expect(reputation).toBeLessThan(306_374 + 100);
    // The run report says why the target (the choice's line, with --verbose: #245), and the favour it makes.
    const { text } = runReport(
      fresh.data.store,
      { environment: "E1", sinceMs: EPOCH_MS, untilMs: game.clock.now() },
      { verbose: true },
    );
    expect(text).toMatch(
      /hacking for BitRunners, for .* \(reputation 306,3\d\d of 306,374: donations at the next install, .* at [\d,]+; favour 100\.0, 150\.0 after the next install at it, /,
    );
    expect(text).toMatch(
      / {4}BitRunners: reputation [\d,]+ → [\d,]+, favour 100 \(unchanged\); 150\.0 after the next install; donations unlock at the next install/,
    );
  },
);
