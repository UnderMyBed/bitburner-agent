// After Daedalus's count (#413), in the simulator: the A/B of the planner's install timing by the time to the
// invitation's hacking 2,500 against the count rule's (main's, `levelTiming` "count rule"), from one BN4 save at the
// count met, on one seed, each arm bounded at 45 virtual minutes (about 40 s of real time each). Harness edits stand in
// for the BitNode so far, before the Agent: 36 installed and applied (`applyInstalledAugmentations`), so the count is
// met and m is 4.03; hacking 2,000; BitRunners joined at 240,000 (its Neural Accelerator and Embedded Netburner Module
// Core Implant reached, Cranial Signal Processors - Gen V 10,000 off, Artificial Bio-neural Network Implant 35,000),
// The Black Hand at none, $1t, home at 512 TB (BN4.2's at its count), and 21 minutes of the cycle past (no quick
// install). Each arm, a test of its own, logs its time to Daedalus's invitation (from the Agent's first snapshot),
// its installs, and the level and m at the end. Measured 2026-11-14 on seed 1: the count rule installs at once on its
// bar (Neural Accelerator, the Core Implant and NeuroFlux Governor's levels), then a quick install at 9 min of
// NeuroFlux Governor alone, Daedalus at 25 min; the planner waits for Gen V (13 min) and installs all three, Daedalus
// at 21 min. CI runs seed 1; `DAEDALUS_LEVEL_SEEDS` (`1,2,3`, say) runs others.
import { hackingExpOfLevel, levellingInstallMultipliers, type SlowSnapshotData } from "@bitburner-agent/core";
import { expect, test } from "vitest";
import { AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND, type LevelTimingPolicy } from "../src/augmentations.ts";
import { EPOCH_MS } from "./helpers/agent-in-simulation.ts";
import { useFreshStarts } from "./helpers/fresh-start.ts";

/** `DAEDALUS_LEVEL_SEEDS`: seeds 1 or more, comma separated; unset, seed 1 alone (CI). Anything else fails loudly. */
function levelSeeds(text: string | undefined): number[] {
  if (text === undefined) return [1];
  const seeds = text.split(",").map((each) => each.trim());
  if (!seeds.every((each) => /^[1-9]\d*$/.test(each))) {
    throw new Error(`DAEDALUS_LEVEL_SEEDS is ${JSON.stringify(text)}: give seeds 1 or more, comma separated`);
  }
  return seeds.map(Number);
}

const freshStartOf = useFreshStarts();
const SEEDS = levelSeeds(process.env.DAEDALUS_LEVEL_SEEDS);
const MINUTE = 60_000;
/** Each arm's bound: 45 virtual minutes, both arms' invitation within it on seed 1 (25 and 21). */
const ARM_MS = 45 * MINUTE;
/**
 * Installed at the count: BN4.3's 30 to its count (the run report's c1-c11, NeuroFlux Governor once) and its c12's
 * five (#413's `postcount.txt`), and QLink (Illuminati's, the level ×1.75) in place of NeuroFlux Governor's 43 levels
 * and more: m 4.03 with SF1.3's 1.28, where 2,500 needs about 1.3e11 experience; BitRunners' hacking set left.
 */
const INSTALLED = [
  "Speech Processor Implant",
  "Social Negotiation Assistant (S.N.A)",
  "Nuoptimal Nootropic Injector Implant",
  "ADR-V1 Pheromone Gene",
  "Speech Enhancement",
  "BitWire",
  "Synaptic Enhancement Implant",
  "Neurotrainer I",
  "Wired Reflexes",
  "NeuroFlux Governor",
  "INFRARET Enhancement",
  "Combat Rib I",
  "Augmented Targeting I",
  "Artificial Synaptic Potentiation",
  "Cranial Signal Processors - Gen I",
  "Neurotrainer II",
  "Neural Wit Amplifier",
  "NutriGen Implant",
  "Neural-Retention Enhancement",
  "Embedded Netburner Module",
  "Cranial Signal Processors - Gen II",
  "Magnetism Amplifier",
  "Cranial Signal Processors - Gen III",
  "CRTX42-AA Gene Modification",
  "CashRoot Starter Kit",
  "Augmented Targeting II",
  "Combat Rib II",
  "DermaForce Particle Barrier",
  "Nanofiber Weave",
  "Neuregen Gene Modification",
  "Neuralstimulator",
  "Enhanced Myelin Sheathing",
  "Cranial Signal Processors - Gen IV",
  "The Black Hand",
  "DataJack",
  "QLink",
];
/** The level multiplier they leave: SF1.3's 1.28 (BN4's HackingLevelMultiplier 1) times theirs. */
const M = 1.28 * levellingInstallMultipliers(0, INSTALLED).hacking;
const BITRUNNERS_REP = 240_000;
const LEVEL = 2000;
/** BN4.2's home at its count (`rebuild.txt`'s c9: 524,288 GB), the batcher's RAM and the experience's. */
const HOME_GB = 524_288;
/** Each arm's time to Daedalus's invitation, ms from the Agent's first snapshot, by seed; null not within the bound. */
const invited = new Map<number, Partial<Record<LevelTimingPolicy, number | null>>>();

test("DAEDALUS_LEVEL_SEEDS: seeds 1 or more, or unset for seed 1; an empty or odd entry fails loudly", () => {
  expect(levelSeeds(undefined)).toEqual([1]);
  expect(levelSeeds("1, 4")).toEqual([1, 4]);
  for (const odd of ["", "1,", "0", "2.5", "x"]) expect(() => levelSeeds(odd)).toThrow(/DAEDALUS_LEVEL_SEEDS/);
});

test.each(SEEDS.flatMap((seed) => (["count rule", "planner"] as const).map((policy) => ({ seed, policy }))))(
  "seed $seed, $policy: from Daedalus's count met, the time to its invitation",
  { timeout: 300_000 },
  async ({ seed, policy }: { seed: number; policy: LevelTimingPolicy }) => {
    const fresh = await freshStartOf({
      withDesiredState: true,
      seed,
      fixture: { kind: "bitnode", n: 4, sourceFiles: { 1: 3 } },
      levelTiming: policy,
      beforeAgent: async ({ simulation, game }) => {
        for (const name of INSTALLED) await simulation.diagnostics.giveInstalledAugmentation(name);
        await simulation.diagnostics.applyInstalledAugmentations();
        await simulation.diagnostics.gainHackingExp(hackingExpOfLevel(LEVEL, M));
        await simulation.diagnostics.setHomeRam(HOME_GB);
        await simulation.diagnostics.joinFactionWithReputation("BitRunners", BITRUNNERS_REP);
        await simulation.diagnostics.joinFactionWithReputation("The Black Hand", 0);
        await simulation.diagnostics.setMoney(1e12);
        // Past the quick install's 20 minutes (core's `QUICK_INSTALL_WITHIN_MS`), as a save mid-cycle at the count.
        await game.run(21 * MINUTE);
      },
    });
    const { game } = fresh;
    const slow = () => fresh.latest<SlowSnapshotData>("slow");
    const startMs = game.clock.now();
    let invitedAtMs: number | null = null;
    let levelAtStart: number | null = null;
    while (game.clock.now() < startMs + ARM_MS && invitedAtMs === null) {
      await game.run(MINUTE);
      const medium = fresh.medium();
      const level = (medium?.player as { skills?: { hacking?: number } } | undefined)?.skills?.hacking ?? null;
      levelAtStart ??= level;
      const state = slow()?.factions?.state;
      const daedalus =
        state?.invitations.includes("Daedalus") === true ||
        state?.joined.some((faction) => faction.name === "Daedalus") === true;
      if (daedalus) invitedAtMs = game.clock.now();
    }
    const window = { environment: "E1", sinceMs: EPOCH_MS, untilMs: game.clock.now() } as const;
    const chosen = fresh.data.store
      .eventsInWindow(window)
      .filter((event) => event.kind === AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND)
      .map(
        (event) =>
          event.detail as {
            reason: string;
            onlineMs: number;
            set: { augmentation: string }[];
            timing?: { words?: string };
          },
      );
    const player = fresh.medium()?.player as { skills?: { hacking?: number }; mults?: { hacking?: number } };
    console.log(
      `seed ${seed}, ${policy}: Daedalus's invitation ` +
        (invitedAtMs === null
          ? `not within ${ARM_MS / MINUTE} min`
          : `at ${((invitedAtMs - startMs) / MINUTE).toFixed(1)} min`) +
        `; installs: ${chosen.map((each) => `${each.reason} at ${(each.onlineMs / MINUTE).toFixed(0)} min (${each.set.map((one) => one.augmentation).join(", ")})`).join("; ") || "none"}` +
        `; hacking ${levelAtStart} → ${player?.skills?.hacking}, m ${player?.mults?.hacking?.toFixed(3)}; ` +
        `m at the start ${M.toFixed(3)}`,
    );
    invited.set(seed, { ...invited.get(seed), [policy]: invitedAtMs === null ? null : invitedAtMs - startMs });
    // Each arm reaches the invitation within the bound: the A/B measures something.
    expect(invitedAtMs).not.toBeNull();
    if (policy === "planner") {
      // The planner's installs after the count are its own, by the time to the level, with their estimates.
      for (const each of chosen) {
        expect(each.reason).toBe("Daedalus's level");
        expect(each.timing?.words).toMatch(/^after Daedalus's count, to its invitation's hacking 2,500 \(#413\)/);
      }
      // No slower than main's (the count rule's arm, run first).
      const baseline = invited.get(seed)?.["count rule"];
      expect(baseline).toBeDefined();
      expect(invitedAtMs as number).toBeLessThanOrEqual(startMs + (baseline as number));
    }
  },
);
