// Install timing (#343), in the simulator: decision 67's A/B (point 6), the planner against the count rule (the brain's
// timing short of Daedalus's count before #343, with #243's hold: `installTiming` "count rule"), on one seed and one
// mid-BitNode start each, 90 virtual minutes, the brain's rules as on Steam otherwise. Harness edits stand in for the
// BitNode so far, before the Agent: 15 of Daedalus's 30 installed (CyberSec's five, Tian Di Hui's eight, Augmented
// Targeting I and NeuroFlux Governor) and home at 64 GB. Each arm, a test of its own, logs Daedalus's count installed
// by the end (NeuroFlux Governor once), its installs, what's queued, and the money; the planner's run report has none
// of #343's failures. A measure, not a bar: the figures go in the PR. Opt-in, `INSTALL_TIMING_SEEDS` (`1`, or `1,2,3`
// say): an arm takes 2.5 to 6 minutes of real time (seed 1: 146 s and over 300 s), past a CI suite's minute.
import { augmentationsSoldBy, type MediumSnapshotData, type SlowSnapshotData } from "@bitburner-agent/core";
import { expect, test } from "vitest";
import { AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND, type InstallTimingPolicy } from "../src/augmentations.ts";
import { runReport } from "../src/run-report.ts";
import { EPOCH_MS } from "./helpers/agent-in-simulation.ts";
import { useFreshStarts } from "./helpers/fresh-start.ts";

/** `INSTALL_TIMING_SEEDS`: seeds 1 or more, comma separated; unset, none (CI). Anything else fails loudly. */
function installTimingSeeds(text: string | undefined): number[] {
  if (text === undefined) return [];
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
const HOME_GB = 64;
/** 15 installed: what a BN1 cycle or three buys first, leaving NiteSec's, The Black Hand's and BitRunners' to buy. */
const INSTALLED = [
  ...augmentationsSoldBy("CyberSec", 1, null),
  ...augmentationsSoldBy("Tian Di Hui", 1, null),
  "Augmented Targeting I",
].filter((name, index, all) => all.indexOf(name) === index);

test("INSTALL_TIMING_SEEDS: seeds 1 or more, or unset for none (CI); an empty or odd entry fails loudly", () => {
  expect(installTimingSeeds(undefined)).toEqual([]);
  expect(installTimingSeeds("1, 4")).toEqual([1, 4]);
  for (const odd of ["", "1,", "0", "2.5", "x"]) expect(() => installTimingSeeds(odd)).toThrow(/INSTALL_TIMING_SEEDS/);
});

test.each(SEEDS.flatMap((seed) => (["count rule", "planner"] as const).map((policy) => ({ seed, policy }))))(
  "seed $seed, $policy: 90 virtual minutes from 15 of 30 installed, its count, installs and money",
  { timeout: 900_000 },
  async ({ seed, policy }: { seed: number; policy: InstallTimingPolicy }) => {
    expect(INSTALLED).toHaveLength(15);
    const fresh = await freshStartOf({
      withDesiredState: true,
      seed,
      installTiming: policy,
      beforeAgent: async ({ simulation }) => {
        await simulation.diagnostics.setHomeRam(HOME_GB);
        for (const name of INSTALLED) await simulation.diagnostics.giveInstalledAugmentation(name);
      },
    });
    const { game } = fresh;
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
      .map((event) => event.detail as { reason: string; onlineMs: number; timing?: { adding: number } });
    const medium: MediumSnapshotData | null = fresh.medium();
    const count = Object.keys(slow()?.resetInfo.ownedAugs ?? {}).length;
    const money = (medium?.player as { money?: number } | undefined)?.money ?? Number.NaN;
    const timing = fresh.controller().augmentationsView().progress?.timing;
    console.log(
      `seed ${seed}, ${policy}: Daedalus's count ${count} of 30 after ${resets.size - 1} installs ` +
        `(${chosen.map((each) => `${each.reason} at ${(each.onlineMs / MINUTE).toFixed(0)} min online`).join(", ") || "none chosen"}), ` +
        `${slow()?.factions?.state?.queuedAugmentations.length ?? 0} queued, $${(money / 1e9).toFixed(2)}b` +
        (timing === undefined || timing === null ? "" : `; the planner: ${timing.words}`),
    );
    expect(count).toBeGreaterThanOrEqual(15);
    if (policy === "planner") {
      // None of #343's failures: an install short of the count without its estimates, one adding nothing to it, a wait
      // overdue. (The count rule's installs short of the count are failures by design.)
      const { failures } = runReport(fresh.data.store, window);
      expect(failures.filter((each) => /planner's estimates|NeuroFlux-only install|wait overdue/.test(each))).toEqual(
        [],
      );
      for (const each of chosen) expect(each.timing?.adding).toBeGreaterThan(0);
    }
  },
);
