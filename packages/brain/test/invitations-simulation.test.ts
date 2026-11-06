// Daedalus's count (#228), in the simulator: the end of the live run of 2026-11-04, which stalled at 23 of the 30
// installed augmentations Daedalus needs, and the brain's way on from it, against the real engine.
// - Before the Agent, harness edits stand in for that run: the four hacker factions' set with a hacking value and
//   NeuroFlux Governor installed (23), those four joined, donations unlocked at The Black Hand and BitRunners (150
//   favour), hacking past 6,000, $2m, in Sector-12; and 20 minutes of the game's time, so no quick install (#222) takes
//   NeuroFlux Governor alone first. The hack loop, programs, home RAM and cloud servers are off: the money is the
//   harness's.
// - Short of the count, nothing of the city groups' within the money: the brain travels to Ishima, Tian Di Hui invites
//   (the game's check, every 2 s) and A5 joins it, then works for it: its two with a hacking value first (#203), then,
//   past them (a harness edit), the rest, for the count.
// - With $100m, the city group (owner decision 54): B, the most that count, Ishima first (the player is there), then
//   Chongqing and New Tokyo, back to Ishima; none of A's or C's joined.
// - A harness edit stands in for that work's hours (Tian Di Hui's reputation for all eight) and the money: A6 counts
//   Tian Di Hui's eight and the two no-value augmentations The Black Hand and BitRunners sell (by donation), buys them
//   and installs: 33 installed. Hacking and money edited back past Daedalus's other requirements, it invites.
// CI runs seed 1; `DAEDALUS_COUNT_SEEDS` (`1,2,3`, say) runs others.
import { augmentationsSoldBy, isWorthInstalling, type SlowSnapshotData } from "@bitburner-agent/core";
import { expect, test } from "vitest";
import { AUGMENTATION_BOUGHT_EVENT_KIND, AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND } from "../src/augmentations.ts";
import { FACTION_WORK_CHOSEN_EVENT_KIND } from "../src/factions.ts";
import { CITY_GROUP_CHOSEN_EVENT_KIND, INVITATION_TRAVEL_EVENT_KIND } from "../src/invitations.ts";
import { runReport } from "../src/run-report.ts";
import { EPOCH_MS } from "./helpers/agent-in-simulation.ts";
import { useFreshStarts } from "./helpers/fresh-start.ts";

/** `DAEDALUS_COUNT_SEEDS`: seeds 1 or more, comma separated; unset, seed 1 alone (CI). Anything else fails loudly. */
function daedalusCountSeeds(text: string | undefined): number[] {
  if (text === undefined) return [1];
  const seeds = text.split(",").map((each) => each.trim());
  if (!seeds.every((each) => /^[1-9]\d*$/.test(each))) {
    throw new Error(`DAEDALUS_COUNT_SEEDS is ${JSON.stringify(text)}: give seeds 1 or more, comma separated`);
  }
  return seeds.map(Number);
}

const freshStartOf = useFreshStarts();
const SEEDS = daedalusCountSeeds(process.env.DAEDALUS_COUNT_SEEDS);
const MINUTE = 60_000;
const HACKERS = ["CyberSec", "NiteSec", "The Black Hand", "BitRunners"];
/** The four's set with a hacking value (22) and NeuroFlux Governor: run #2's 23. */
const RUN_2 = [
  ...[...new Set(HACKERS.flatMap((faction) => augmentationsSoldBy(faction, 1, null)))].filter((name) =>
    isWorthInstalling(name),
  ),
  "NeuroFlux Governor",
];
const TIAN_DI_HUI_EIGHT = augmentationsSoldBy("Tian Di Hui", 1, null).filter((name) => name !== "NeuroFlux Governor");
/** Hacking experience past level 6,000 at any multiplier from 1 (`calculateSkill`: 32 × ln(exp + 534.6) − 200). */
const PAST_6000_EXP = 1e90;
/** Each stage's bound: a travel and a join, a slow snapshot or two apart; purchases, an install through the gate. */
const STAGE_MS = 15 * MINUTE;

test("DAEDALUS_COUNT_SEEDS: seeds 1 or more, or unset for seed 1; an empty or odd entry fails loudly", () => {
  expect(daedalusCountSeeds(undefined)).toEqual([1]);
  expect(daedalusCountSeeds("1, 4")).toEqual([1, 4]);
  for (const odd of ["", "1,", "0", "2.5", "x"]) expect(() => daedalusCountSeeds(odd)).toThrow(/DAEDALUS_COUNT_SEEDS/);
});

test.each(SEEDS)(
  "seed %i: from run #2's 23: Tian Di Hui, city group B, Tian Di Hui's eight and two no-value ones installed, Daedalus invites",
  { timeout: 300_000 },
  async (seed) => {
    expect(RUN_2).toHaveLength(23);
    const fresh = await freshStartOf({
      withDesiredState: true,
      seed,
      beforeAgent: async ({ simulation, game }) => {
        for (const augmentation of RUN_2) await simulation.diagnostics.giveInstalledAugmentation(augmentation);
        await simulation.diagnostics.gainHackingExp(PAST_6000_EXP);
        for (const faction of HACKERS) await simulation.diagnostics.joinFactionWithReputation(faction, 0);
        await simulation.diagnostics.setFactionFavor("The Black Hand", 150);
        await simulation.diagnostics.setFactionFavor("BitRunners", 150);
        await simulation.diagnostics.setMoney(2e6);
        // Past a quick install's 20 minutes (#222): no install of NeuroFlux Governor alone comes first.
        await game.run(20 * MINUTE);
      },
    });
    const { game, simulation } = fresh;
    for (const off of ["setHackLoopEnabled", "setProgramsEnabled", "setHomeRamEnabled", "setCloudServersEnabled"]) {
      fresh.controller()[off as "setHackLoopEnabled"](false);
    }
    const slow = () => fresh.latest<SlowSnapshotData>("slow");
    const joined = () => slow()?.factions?.state?.joined.map((faction) => faction.name) ?? [];
    const events = (kind: string) =>
      fresh.data.store
        .eventsInWindow({ environment: "E1", sinceMs: EPOCH_MS, untilMs: game.clock.now() })
        .filter((event) => event.kind === kind);

    // To Ishima, Tian Di Hui's invitation, joined; then A5's work for it, for the count.
    await game.runUntil(() => joined().includes("Tian Di Hui"), STAGE_MS);
    expect(fresh.medium()?.player.city).toBe("Ishima");
    // The hold between, unless the slow snapshot showed the invitation before a medium one showed Ishima.
    const phases = events(INVITATION_TRAVEL_EVENT_KIND).map((event) => (event.detail as { phase: string }).phase);
    expect([
      ["travel", "hold", "invited"],
      ["travel", "invited"],
    ]).toContainEqual(phases);
    // Its two with a hacking value first (the hacking way again, #203); a harness edit past them (6,250) leaves the
    // way spent: then the soonest of the rest, for the count.
    await game.runUntil(() => fresh.controller().factionsView().choice?.faction === "Tian Di Hui", STAGE_MS);
    expect(fresh.controller().factionsView().choice?.count).toBeUndefined();
    await simulation.diagnostics.joinFactionWithReputation("Tian Di Hui", 7_000);
    await game.runUntil(() => fresh.controller().factionsView().choice?.count !== undefined, STAGE_MS);
    const forCount = fresh.controller().factionsView().choice;
    expect(forCount).toMatchObject({ faction: "Tian Di Hui", count: { installed: 23, required: 30 } });
    // The work at hacking past 6,000 may have passed 7,500 before the slow snapshot the choice is made on.
    expect(["Speech Processor Implant", "Nanofiber Weave", "Neuroreceptor Management Implant"]).toContain(
      forCount?.augmentation,
    );
    expect(events(AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND)).toEqual([]);

    // Money for a city group's invitations (#228, decision 54): B, the most that count (5, against A 4, C 3), Ishima's
    // first (the player is there), then Chongqing and New Tokyo, back to Ishima; none of A's or C's joined.
    await simulation.diagnostics.setMoney(100e6);
    const groupB = ["Chongqing", "New Tokyo", "Ishima"];
    await game.runUntil(
      () => groupB.every((faction) => joined().includes(faction)) && fresh.medium()?.player.city === "Ishima",
      STAGE_MS,
    );
    expect(events(CITY_GROUP_CHOSEN_EVENT_KIND).map((event) => event.detail)).toEqual([
      expect.objectContaining({ group: "B", factions: groupB, short: true }),
    ]);
    expect(joined().filter((faction) => ["Sector-12", "Aevum", "Volhaven"].includes(faction))).toEqual([]);
    expect(events(AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND)).toEqual([]);

    // The work's hours, and the money: the count reached, bought, installed.
    await simulation.diagnostics.joinFactionWithReputation("Tian Di Hui", 80_000);
    await simulation.diagnostics.setMoney(200e9);
    const startedAt = slow()?.resetInfo.lastAugReset as number;
    await game.runUntil(() => (slow()?.resetInfo.lastAugReset ?? startedAt) !== startedAt, STAGE_MS);
    const bought = events(AUGMENTATION_BOUGHT_EVENT_KIND).map(
      (event) => (event.detail as { augmentation: string }).augmentation,
    );
    const counting = bought.filter((name) => name !== "NeuroFlux Governor");
    expect(new Set(counting)).toEqual(new Set([...TIAN_DI_HUI_EIGHT, "Neural Wit Amplifier", "Magnetism Amplifier"]));
    const installed = Object.keys(slow()?.resetInfo.ownedAugs ?? {});
    expect(installed).toHaveLength(33);
    expect(events(AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND)).toHaveLength(1);

    // Daedalus's other requirements, edited back after the reset: it invites (or A5 has joined it already).
    await simulation.diagnostics.gainHackingExp(PAST_6000_EXP);
    await simulation.diagnostics.setMoney(200e9);
    await game.runUntil(
      () => joined().includes("Daedalus") || (slow()?.factions?.state?.invitations ?? []).includes("Daedalus"),
      STAGE_MS,
    );

    // The run report: the travel, the work for the count, the World Daemon's line; not out of reach. The travels'
    // intents and the work's choices as lines, with --verbose (#245).
    const { text, failures } = runReport(
      fresh.data.store,
      { environment: "E1", sinceMs: EPOCH_MS, untilMs: game.clock.now() },
      { verbose: true },
    );
    expect(text).toMatch(/ {6}\S+ {2}travel to Ishima for Tian Di Hui's invitation \(23 of 30 installed\)/);
    expect(text).toMatch(
      / {6}\S+ {2}city factions: group B \(Chongqing, New Tokyo, Ishima\): 5 augmentations that count, against A 4, C 3/,
    );
    expect(text).toMatch(/ {4}travel\(Chongqing\): done after 1 try/);
    expect(text).toMatch(/ {4}travel\(Ishima\): done after 1 try/);
    expect(text).toMatch(/hacking for Tian Di Hui, for .*, for Daedalus's count: 23 of 30 augmentations installed/);
    expect(text).toMatch(/Daedalus: (joined|invited); 33 of 30 augmentations installed/);
    expect(failures.filter((failure) => /Daedalus count stuck|NOT INVITED/.test(failure))).toEqual([]);
    const worked = events(FACTION_WORK_CHOSEN_EVENT_KIND).map((event) => (event.detail as { faction: string }).faction);
    console.log(
      `seed ${seed}: worked for ${[...new Set(worked)].join(", ")}; bought ${counting.length} that count ` +
        `(${bought.length - counting.length} NeuroFlux Governor levels); Daedalus at ` +
        `${((game.clock.now() - EPOCH_MS) / MINUTE).toFixed(1)} min`,
    );
  },
);
