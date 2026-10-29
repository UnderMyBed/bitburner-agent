// Augmentations and the reset (#210), in the simulator: a fresh 8 GB start in BN1 reaching its first install, the
// brain's rules as on Steam (the hack loop, programs, home RAM, backdoors and augmentations, all on). 20 virtual
// minutes in, a harness edit stands in for the hours of CyberSec's work (A5's, #203): CyberSec joined with the
// reputation for its five augmentations, and the money for them. The brain chooses the install (nothing else is worth
// installing at the joined factions), buys the five in buy order through the Agent's `sim` effector, then NeuroFlux
// Governor with what money is left, and installs through the gate and a save backup; the game starts boot.js after the reset, and the next
// Agent connects. 20 minutes after the reset, the hacking level is above where it was 20 minutes after the start. CI
// runs seed 1; `AUGMENTATION_SEEDS` (`1,2,3`, say) runs others.
import type { MediumSnapshotData, SlowSnapshotData } from "@bitburner-agent/core";
import { expect, test } from "vitest";
import { AUGMENTATION_BOUGHT_EVENT_KIND } from "../src/augmentations.ts";
import { runReport } from "../src/run-report.ts";
import { EPOCH_MS } from "./helpers/agent-in-simulation.ts";
import { useFreshStarts } from "./helpers/fresh-start.ts";

/** `AUGMENTATION_SEEDS`: seeds 1 or more, comma separated; unset, seed 1 alone (CI). Anything else fails loudly. */
function augmentationSeeds(text: string | undefined): number[] {
  if (text === undefined) return [1];
  const seeds = text.split(",").map((each) => each.trim());
  if (!seeds.every((each) => /^[1-9]\d*$/.test(each))) {
    throw new Error(`AUGMENTATION_SEEDS is ${JSON.stringify(text)}: give seeds 1 or more, comma separated`);
  }
  return seeds.map(Number);
}

const freshStartOf = useFreshStarts();
const SEEDS = augmentationSeeds(process.env.AUGMENTATION_SEEDS);
const MINUTE = 60_000;
/** How long each cycle runs before its hacking level is compared. */
const COMPARED_AFTER_MS = 20 * MINUTE;
/** From the harness edit to the reset: the decision, five purchases a few seconds apart, the gate and its backup. */
const INSTALLED_WITHIN_MS = 10 * MINUTE;
/** CyberSec's five in buy order, and their money then: 70m + 125m × 1.9 + 10m × 1.9² + 7.5m × 1.9³ + 4m × 1.9⁴. */
const FIVE = [
  "Cranial Signal Processors - Gen I",
  "Cranial Signal Processors - Gen II",
  "BitWire",
  "Synaptic Enhancement Implant",
  "Neurotrainer I",
];
const FIVE_COST = 447_170_900;

test("AUGMENTATION_SEEDS: seeds 1 or more, or unset for seed 1; an empty or odd entry fails loudly", () => {
  expect(augmentationSeeds(undefined)).toEqual([1]);
  expect(augmentationSeeds("1, 4")).toEqual([1, 4]);
  for (const odd of ["", "1,", "0", "2.5", "x"]) expect(() => augmentationSeeds(odd)).toThrow(/AUGMENTATION_SEEDS/);
});

test.each(SEEDS)(
  "seed %i: from a fresh start, CyberSec's five bought in buy order and installed, the Agent back, hacking faster",
  { timeout: 300_000 },
  async (seed) => {
    const fresh = await freshStartOf({ withDesiredState: true, seed });
    const { game, brain, simulation } = fresh;
    const slow = () => fresh.latest<SlowSnapshotData>("slow");
    const hacking = (medium: MediumSnapshotData | null) =>
      (medium?.player.skills as { hacking?: number } | undefined)?.hacking ?? Number.NaN;

    // The first cycle, 20 minutes in: its hacking level.
    await game.run(COMPARED_AFTER_MS);
    const levelBefore = hacking(fresh.medium());
    const homeRam = () => fresh.medium()?.servers.find((server) => server.hostname === "home")?.maxRam;
    const homeRamBefore = homeRam();
    const startedAt = slow()?.resetInfo.lastAugReset as number;

    // The harness edit: CyberSec's reputation for all five, and the money for them, with a little over.
    await simulation.diagnostics.joinFactionWithReputation("CyberSec", 18_750);
    await simulation.diagnostics.setMoney(FIVE_COST + 2_000_000);
    const editedAtMs = game.clock.now();
    await game.runUntil(() => (slow()?.resetInfo.lastAugReset ?? startedAt) !== startedAt, INSTALLED_WITHIN_MS);
    const resetAt = slow()?.resetInfo.lastAugReset as number;
    expect(resetAt).not.toBe(startedAt);

    // The brain's choice, then its purchases in buy order, each from CyberSec at its price then; then the install,
    // through its gate and one save backup.
    expect(brain.logLines).toContainEqual(
      expect.stringMatching(
        /^augmentations: install chosen, \S+ \S+ since the last: buying Cranial Signal Processors - Gen I, .* nothing else worth installing at the joined factions$/,
      ),
    );
    const bought = fresh.data.store
      .eventsInWindow({ environment: "E1", sinceMs: editedAtMs, untilMs: game.clock.now() })
      .filter((event) => event.kind === AUGMENTATION_BOUGHT_EVENT_KIND)
      .map((event) => event.detail as { augmentation: string; faction: string; queueLength: number });
    expect(bought.slice(0, 5).map((each) => [each.augmentation, each.faction, each.queueLength])).toEqual(
      FIVE.map((augmentation, index) => [augmentation, "CyberSec", index + 1]),
    );
    expect(brain.saveBackupEvents.filter((event) => "file" in event).length).toBeGreaterThanOrEqual(1);
    expect(brain.logLines.filter((line) => line.includes("NOT QUEUED"))).toEqual([]);

    // The reset game: the five installed, the next Agent back, the cycle over.
    const installed = slow()?.resetInfo.ownedAugs ?? {};
    expect(Object.keys(installed)).toEqual(expect.arrayContaining(FIVE));
    const sessions = brain.channelEvents.filter((event) => event.type === "agentConnected");
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    expect(fresh.controller().augmentationsView()).toMatchObject({ committed: false, notQueued: [] });
    expect(fresh.controller().installAwaitingRestart()).toBeNull();

    // 20 minutes after the reset: hacking above the first cycle's at the same point.
    await game.runUntil(() => game.clock.now() >= resetAt + COMPARED_AFTER_MS, COMPARED_AFTER_MS + MINUTE);
    const levelAfter = hacking(fresh.medium());
    expect(levelAfter).toBeGreaterThan(levelBefore);
    const mults = fresh.medium()?.player.mults as { hacking?: number } | undefined;
    expect(mults?.hacking).toBeCloseTo(1.05 * 1.05 * 1.07 * 1.01000262 ** (installed["NeuroFlux Governor"] ?? 0), 6);

    // The run report: the decision, the purchases and the install, the Agent back, and no failure.
    const { text, failures } = runReport(fresh.data.store, {
      environment: "E1",
      sinceMs: EPOCH_MS,
      untilMs: game.clock.now(),
    });
    const lines = text.split("\n");
    expect(lines).toContainEqual(expect.stringMatching(/^ {4}\S+ {2}install chosen, /));
    for (const augmentation of FIVE) {
      expect(lines).toContainEqual(
        expect.stringMatching(
          new RegExp(`^ {4}\\S+ {2}bought ${augmentation} from CyberSec for \\$[\\d,]+ \\(queue \\d\\)$`),
        ),
      );
    }
    expect(lines).toContainEqual(expect.stringMatching(/^ {4}\S+ {2}install sent \(the brain's\): /));
    expect(lines).toContainEqual(
      expect.stringMatching(
        /^ {4}\S+ {2}installed \(seen in a slow snapshot\): .*hacking ×1\.1\d\d.*the Agent disconnected at /,
      ),
    );
    expect(failures).toEqual([]);
    console.log(
      `seed ${seed}: hacking ${levelBefore} 20 min after the start, ${levelAfter} 20 min after the install (home ` +
        `${homeRamBefore} GB, then ${homeRam()} GB); ` +
        `installed ${Object.entries(installed)
          .map(([name, level]) => (level > 1 ? `${name} ${level}` : name))
          .join(", ")}; ${((resetAt - editedAtMs) / 1000).toFixed(0)} s from the edit to the reset`,
    );
  },
);
