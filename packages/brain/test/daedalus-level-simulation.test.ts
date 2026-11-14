// After Daedalus's count (#413), in the simulator: the A/B of the planner's install timing by the time to the
// invitation's hacking 2,500 against the count rule's (main's, `levelTiming` "count rule"), from one BN4 save at the
// count met, on one seed, the seeds' random streams from the Agent's first connection (`fixedAgentStart`, so seeds
// differ). Harness edits stand in for the BitNode so far, before the Agent: 36 installed and applied
// (`applyInstalledAugmentations`), so the count is met and m is 4.03; hacking 2,000; BitRunners at 20,000, The Black
// Hand at none, $1t, home at 512 TB (BN4.2's at its count). A prior install in the run, alike in both arms (#413's
// review: so a κ is carried, #389's rule): the Augmentations switch off for the rate's window (11 min), then on, and
// the count rule installs NeuroFlux Governor's levels, carrying the κ measured. Then 21 minutes past it (beyond the
// quick install's 20, #413's second review), each arm's rules as they come, and BitRunners at 240,000 (Neural
// Accelerator and Embedded Netburner Module Core Implant reached, Cranial Signal Processors - Gen V 10,000 off,
// Artificial Bio-neural Network Implant 35,000), $1t again; each arm runs to Daedalus's invitation, 45 virtual minutes
// at most. Each arm, a test of its own, logs its time to the invitation from that grant, its installs from the prior
// install on (minutes from the grant), and the level each minute; a measure, not a bar. Measured 2026-11-14, seeds
// 1-3: in the 21 minutes the count rule makes a quick install of NeuroFlux Governor alone (at -7 min), so at the grant
// it is in a quick install's window again and installs Neural Accelerator and the Core Implant at 1 min; the planner
// installs NeuroFlux Governor's levels at -10 min (its level timing's choice, the levels raising m) and the two at 0 or
// 1 min. Daedalus at 7, 7 and 8 min (the planner) against 8, 8 and 8 (the count rule). CI runs seed 1;
// `DAEDALUS_LEVEL_SEEDS` (`1,2,3`, say) runs others; `DAEDALUS_LEVEL_LOG=1` prints the planner's lines.
import {
  hackingExpOfLevel,
  levellingInstallMultipliers,
  QUICK_INSTALL_WITHIN_MS,
  type SlowSnapshotData,
} from "@bitburner-agent/core";
import { expect, test } from "vitest";
import {
  AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND,
  type LevelTimingPolicy,
  readCarriedLevelRise,
} from "../src/augmentations.ts";
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
/** Each arm's bound after the grant: 45 virtual minutes, both arms' invitation within it (7-8 min). */
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
      // Off until the rate's window is whole, so the prior install carries a κ (#389's rule, #413's review).
      augmentations: false,
      beforeAgent: async ({ simulation }) => {
        for (const name of INSTALLED) await simulation.diagnostics.giveInstalledAugmentation(name);
        await simulation.diagnostics.applyInstalledAugmentations();
        await simulation.diagnostics.gainHackingExp(hackingExpOfLevel(LEVEL, M));
        await simulation.diagnostics.setHomeRam(HOME_GB);
        // Before the prior install, 20,000 at BitRunners: NeuroFlux Governor's levels its reach, nothing of its hacking set.
        await simulation.diagnostics.joinFactionWithReputation("BitRunners", 20_000);
        await simulation.diagnostics.joinFactionWithReputation("The Black Hand", 0);
        await simulation.diagnostics.setMoney(1e12);
      },
      // The seeds' random streams from the Agent's first connection, so seeds differ (#413's second review).
      fixedAgentStart: true,
    });
    const { game, simulation } = fresh;
    const slow = () => fresh.latest<SlowSnapshotData>("slow");
    // The prior install in the run, both arms alike (the count rule's: no κ carried yet, so the level route's
    // unpriced): the rate's window whole first, then the switch on; the install carries the κ measured over it.
    await game.run(11 * MINUTE);
    fresh.controller().setAugmentationsEnabled(true);
    const firstReset = slow()?.resetInfo.lastAugReset;
    await game.runUntil(() => slow()?.resetInfo.lastAugReset !== firstReset, 10 * MINUTE);
    expect(slow()?.resetInfo.lastAugReset).not.toBe(firstReset);
    expect(readCarriedLevelRise(fresh.data.store)).not.toBeNull();
    // Past the quick install's 20 minutes after it (core's `QUICK_INSTALL_WITHIN_MS`, #413's second review: so the count
    // rule's arm isn't its quick install by construction), the brain's rules as they come meanwhile.
    const afterPriorMs = game.clock.now();
    await game.run(QUICK_INSTALL_WITHIN_MS + MINUTE);
    // The BitNode so far: BitRunners 240,000 in (Gen V 10,000 off, ABNI 35,000), $1t.
    await simulation.diagnostics.joinFactionWithReputation("BitRunners", BITRUNNERS_REP);
    await simulation.diagnostics.joinFactionWithReputation("The Black Hand", 0);
    await simulation.diagnostics.setMoney(1e12);
    const startMs = game.clock.now();
    let invitedAtMs: number | null = null;
    let levelAtStart: number | null = null;
    const levels: (number | null)[] = [];
    while (game.clock.now() < startMs + ARM_MS && invitedAtMs === null) {
      await game.run(MINUTE);
      const medium = fresh.medium();
      const level = (medium?.player as { skills?: { hacking?: number } } | undefined)?.skills?.hacking ?? null;
      levels.push(level);
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
      .filter((event) => event.kind === AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND && event.atMs >= afterPriorMs)
      .map(
        (event) =>
          ({ atMs: event.atMs, ...(event.detail as object) }) as {
            atMs: number;
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
        `; installs: ${chosen.map((each) => `${each.reason} at ${((each.atMs - startMs) / MINUTE).toFixed(0)} min (${each.set.map((one) => one.augmentation).join(", ")})`).join("; ") || "none"}` +
        `; hacking ${levelAtStart} → ${player?.skills?.hacking}, m ${player?.mults?.hacking?.toFixed(3)}; ` +
        `m at the start ${M.toFixed(3)}; the level each minute: ${levels.join(" ")}`,
    );
    if (process.env.DAEDALUS_LEVEL_LOG === "1") {
      for (const line of fresh.brain.logLines.filter((each) => each.includes("after Daedalus"))) console.log(line);
    }
    invited.set(seed, { ...invited.get(seed), [policy]: invitedAtMs === null ? null : invitedAtMs - startMs });
    // Each arm reaches the invitation within the bound: the A/B measures something.
    expect(invitedAtMs).not.toBeNull();
    if (policy === "planner") {
      // The planner's installs after the count are its own, by the time to the level, with their estimates.
      for (const each of chosen.filter((one) => one.atMs >= startMs)) {
        expect(each.reason).toBe("Daedalus's level");
        expect(each.timing?.words).toMatch(/^after Daedalus's count, to its invitation's hacking 2,500 \(#413\)/);
      }
      // Against main's (the count rule's arm, run first): a measure, not a bar (#413's second review: as it comes).
      const baseline = invited.get(seed)?.["count rule"];
      expect(baseline).toBeDefined();
      console.log(
        `seed ${seed}: the planner ${((invitedAtMs as number) - startMs) / MINUTE} min against the count rule's ` +
          `${(baseline as number) / MINUTE}`,
      );
    }
  },
);
