// Install timing (#343), in the simulator: decision 67's A/B (point 6), the planner against the count rule (the brain's
// timing short of Daedalus's count before #343, with #243's hold: `installTiming` "count rule"), on one seed and one
// mid-BitNode start each, 90 virtual minutes, the brain's rules as on Steam but home RAM and cloud servers (off, so the
// money is the augmentations' and an arm runs in under a minute). Harness edits stand in for the BitNode so far, before
// the Agent: 15 of Daedalus's 30 installed (CyberSec's five, Tian Di Hui's eight, Augmented Targeting I and NeuroFlux
// Governor), hacking past 2,500, NiteSec and The Black Hand joined at 20,000 and BitRunners at 0 (each sells
// countables, some reached, the rest by A5's work within the window), and $5b. Each arm, a test of its own, logs
// Daedalus's count installed by the end (NeuroFlux Governor once), its installs and the money; the planner's report
// has none of #343's failures. A measure, not a bar: the figures go in the PR. CI runs seed 1;
// `INSTALL_TIMING_SEEDS` (`1,2,3`, say) runs others.
import { augmentationsSoldBy, type MediumSnapshotData, type SlowSnapshotData } from "@bitburner-agent/core";
import { expect, test } from "vitest";
import { AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND, type InstallTimingPolicy } from "../src/augmentations.ts";
import { runReport } from "../src/run-report.ts";
import { EPOCH_MS } from "./helpers/agent-in-simulation.ts";
import { useFreshStarts } from "./helpers/fresh-start.ts";

/** `INSTALL_TIMING_SEEDS`: seeds 1 or more, comma separated; unset, seed 1 alone (CI). Anything else fails loudly. */
function installTimingSeeds(text: string | undefined): number[] {
  if (text === undefined) return [1];
  const seeds = text.split(",").map((each) => each.trim());
  if (!seeds.every((each) => /^[1-9]\d*$/.test(each))) {
    throw new Error(`INSTALL_TIMING_SEEDS is ${JSON.stringify(text)}: give seeds 1 or more, comma separated`);
  }
  return seeds.map(Number);
}

const freshStartOf = useFreshStarts();
const SEEDS = installTimingSeeds(process.env.INSTALL_TIMING_SEEDS);
const MINUTE = 60_000;
/** Each arm's length: 90 virtual minutes (decision 67's short bounded seeds). */
const ARM_MS = 90 * MINUTE;
/** 15 installed: what a BN1 cycle or three buys first, leaving NiteSec's, The Black Hand's and BitRunners' to buy. */
const INSTALLED = [
  ...augmentationsSoldBy("CyberSec", 1, null),
  ...augmentationsSoldBy("Tian Di Hui", 1, null),
  "Augmented Targeting I",
].filter((name, index, all) => all.indexOf(name) === index);
/** Hacking experience past level 2,500 at any multiplier from 1 (`calculateSkill`: 32 × ln(exp + 534.6) − 200). */
const PAST_2500_EXP = 1e40;

test("INSTALL_TIMING_SEEDS: seeds 1 or more, or unset for seed 1; an empty or odd entry fails loudly", () => {
  expect(installTimingSeeds(undefined)).toEqual([1]);
  expect(installTimingSeeds("1, 4")).toEqual([1, 4]);
  for (const odd of ["", "1,", "0", "2.5", "x"]) expect(() => installTimingSeeds(odd)).toThrow(/INSTALL_TIMING_SEEDS/);
});

test.each(SEEDS.flatMap((seed) => (["count rule", "planner"] as const).map((policy) => ({ seed, policy }))))(
  "seed $seed, $policy: 90 virtual minutes from 15 of 30 installed, its count, installs and money",
  { timeout: 300_000 },
  async ({ seed, policy }: { seed: number; policy: InstallTimingPolicy }) => {
    expect(INSTALLED).toHaveLength(15);
    const fresh = await freshStartOf({
      withDesiredState: true,
      seed,
      installTiming: policy,
      beforeAgent: async ({ simulation }) => {
        for (const name of INSTALLED) await simulation.diagnostics.giveInstalledAugmentation(name);
        await simulation.diagnostics.gainHackingExp(PAST_2500_EXP);
        await simulation.diagnostics.joinFactionWithReputation("NiteSec", 20_000);
        await simulation.diagnostics.joinFactionWithReputation("The Black Hand", 20_000);
        await simulation.diagnostics.joinFactionWithReputation("BitRunners", 0);
        await simulation.diagnostics.setMoney(5e9);
      },
    });
    const { game } = fresh;
    fresh.controller().setHomeRamEnabled(false);
    fresh.controller().setCloudServersEnabled(false);
    const slow = () => fresh.latest<SlowSnapshotData>("slow");
    const startMs = game.clock.now();
    const resets = new Set<number>();
    while (game.clock.now() < startMs + ARM_MS) {
      await game.run(MINUTE);
      const reset = slow()?.resetInfo.lastAugReset;
      if (reset !== undefined) resets.add(reset);
    }
    const window = { environment: "E1", sinceMs: EPOCH_MS, untilMs: game.clock.now() } as const;
    const chosen = fresh.data.store
      .eventsInWindow(window)
      .filter((event) => event.kind === AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND)
      .map(
        (event) => event.detail as { reason: string; onlineMs: number; set: unknown[]; timing?: { adding: number } },
      );
    const medium: MediumSnapshotData | null = fresh.medium();
    const count = Object.keys(slow()?.resetInfo.ownedAugs ?? {}).length;
    const money = (medium?.player as { money?: number } | undefined)?.money ?? Number.NaN;
    const timing = fresh.controller().augmentationsView().progress?.timing;
    const installs = chosen.map(
      (each) => `${each.reason} at ${(each.onlineMs / MINUTE).toFixed(0)} min online (${each.set.length} in its set)`,
    );
    console.log(
      `seed ${seed}, ${policy}: Daedalus's count 15 → ${count} of 30 after ${resets.size - 1} installs ` +
        `(${installs.join(", ") || "none chosen"}), $${(money / 1e9).toFixed(2)}b at the end` +
        (timing === undefined || timing === null ? "" : `; the planner: ${timing.words}`),
    );
    expect(count).toBeGreaterThanOrEqual(15);
    if (policy === "planner") {
      // None of #343's failures: an install short of the count without its estimates, a NeuroFlux-only one, a wait
      // overdue. (The count rule's installs short of the count are failures by design.)
      const { failures } = runReport(fresh.data.store, window);
      expect(failures.filter((each) => /planner's estimates|NeuroFlux-only install|wait overdue/.test(each))).toEqual(
        [],
      );
      for (const each of chosen) expect(each.timing?.adding).toBeGreaterThan(0);
    }
  },
);
