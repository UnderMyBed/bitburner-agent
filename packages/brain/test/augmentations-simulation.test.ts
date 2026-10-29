// Augmentations and the reset (#210), in the simulator: a fresh 8 GB start in BN1 reaching its first install, the
// brain's rules as on Steam (the batcher, programs, home RAM, backdoors, faction work and augmentations, all on).
// - 17 virtual minutes in (`EDITED_AFTER_MS`), a harness edit stands in for the hours of work (A5's, #203): CyberSec
//   joined with the reputation for its five augmentations, NiteSec joined with none (so the decision compares, #213
//   review), and the money for the five, home's RAM upgrades (those the rest would buy, #218) and a NeuroFlux
//   Governor level.
// - The brain chooses the install because NiteSec's next comes sooner installing first ("sooner installing"), buys
//   the five in buy order through the Agent's `sim` effector, then home's RAM, then NeuroFlux Governor, and installs
//   through the gate and a save backup; the game starts boot.js after the reset, and the next Agent connects.
// - After the reset, the player's multipliers are the five's and NeuroFlux Governor's, and home has its new RAM.
// CI runs seed 1; `AUGMENTATION_SEEDS` (`1,2,3`, say) runs others.
import type { MediumSnapshotData, SlowSnapshotData } from "@bitburner-agent/core";
import { expect, test } from "vitest";
import { AUGMENTATION_BOUGHT_EVENT_KIND, AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND } from "../src/augmentations.ts";
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
/**
 * When the harness edit comes. At 20 minutes with the batcher on (#206's default), the brain rightly carries on:
 * the batcher's income and exp put NiteSec's reputation rate so high that installing (about 11 minutes to rebuild the
 * hacking level) comes later, 3.2 h against 3.0 h. At 17 it comes sooner, 4.0 h against 5.1 h (#216's review).
 */
const EDITED_AFTER_MS = 17 * MINUTE;
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
/** NeuroFlux Governor's first level after the five: 750k × 1.9⁵. */
const NEUROFLUX_LEVEL_1 = 750_000 * 1.9 ** 5;
/**
 * What the batcher may earn while the purchases go through, a minute or so, beyond the $3m over (#218): an upgrade
 * that costs more than NeuroFlux's money, the $3m and this isn't one the rule can take first.
 */
const HOME_RAM_INCOME_SLACK = 5_000_000;
const NEUROFLUX = 1.01000262;

test("AUGMENTATION_SEEDS: seeds 1 or more, or unset for seed 1; an empty or odd entry fails loudly", () => {
  expect(augmentationSeeds(undefined)).toEqual([1]);
  expect(augmentationSeeds("1, 4")).toEqual([1, 4]);
  for (const odd of ["", "1,", "0", "2.5", "x"]) expect(() => augmentationSeeds(odd)).toThrow(/AUGMENTATION_SEEDS/);
});

test.each(SEEDS)(
  "seed %i: from a fresh start, CyberSec's five, home RAM and NeuroFlux Governor bought and installed, the Agent back",
  { timeout: 300_000 },
  async (seed) => {
    const fresh = await freshStartOf({ withDesiredState: true, seed });
    const { game, brain, simulation } = fresh;
    const slow = () => fresh.latest<SlowSnapshotData>("slow");
    const hacking = (medium: MediumSnapshotData | null) =>
      (medium?.player.skills as { hacking?: number } | undefined)?.hacking ?? Number.NaN;

    // The first cycle, until the edit: its hacking level.
    await game.run(EDITED_AFTER_MS);
    const levelBefore = hacking(fresh.medium());
    const homeRam = () => fresh.medium()?.servers.find((server) => server.hostname === "home")?.maxRam;
    const startedAt = slow()?.resetInfo.lastAugReset as number;
    // Programs, home RAM and cloud servers paused until the install is chosen (then programs and cloud servers stand
    // down, and home RAM is the rule's), so none takes the edit's money before the next slow snapshot shows CyberSec's
    // reputation; 20 s on, a medium snapshot shows home's RAM settled.
    fresh.controller().setProgramsEnabled(false);
    fresh.controller().setHomeRamEnabled(false);
    fresh.controller().setCloudServersEnabled(false);
    await game.run(20_000);
    const homeRamBefore = homeRam();

    // The harness edit: CyberSec's reputation for all five, NiteSec joined, and the money for the five, home's RAM
    // and a NeuroFlux Governor level, with $3m over. Committed, the rule buys home's RAM while the money covers its
    // next upgrade, and only then NeuroFlux Governor (augmentations.ts, the committed steps; home-ram.ts,
    // `chooseHomeRamUpgrade`). So the money is for every upgrade that what's left for NeuroFlux would also buy (#218):
    // on seed 4 home is still 16 GB at the edit, and with one upgrade's money the rule took a second, 32 to 64 GB
    // ($10.1m), out of NeuroFlux's $18.6m, and installed without a level.
    const homeRamNow = homeRamBefore as number;
    const upgradePrice = (ram: number) => ram * 32_000 * 1.58 ** Math.log2(ram);
    let homeRamAfter = homeRamNow;
    let homeRamPrice = 0;
    do {
      homeRamPrice += upgradePrice(homeRamAfter);
      homeRamAfter *= 2;
    } while (upgradePrice(homeRamAfter) <= NEUROFLUX_LEVEL_1 + 3_000_000 + HOME_RAM_INCOME_SLACK);
    await simulation.diagnostics.joinFactionWithReputation("CyberSec", 18_750);
    await simulation.diagnostics.joinFactionWithReputation("NiteSec", 0);
    await simulation.diagnostics.setMoney(FIVE_COST + homeRamPrice + NEUROFLUX_LEVEL_1 + 3_000_000);
    const editedAtMs = game.clock.now();
    await game.runUntil(() => fresh.controller().augmentationsView().committed, INSTALLED_WITHIN_MS);
    fresh.controller().setProgramsEnabled(true);
    fresh.controller().setHomeRamEnabled(true);
    fresh.controller().setCloudServersEnabled(true);
    await game.runUntil(() => (slow()?.resetInfo.lastAugReset ?? startedAt) !== startedAt, INSTALLED_WITHIN_MS);
    const resetAt = slow()?.resetInfo.lastAugReset as number;
    expect(resetAt).not.toBe(startedAt);

    // The brain's choice, then its purchases in buy order, each from CyberSec at its price then; then the install,
    // through its gate and one save backup.
    const chosen = fresh.data.store
      .eventsInWindow({ environment: "E1", sinceMs: editedAtMs, untilMs: game.clock.now() })
      .find((event) => event.kind === AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND)?.detail as
      | { reason: string; without: { faction: string; ms: number | null } | null; with: { ms: number | null } | null }
      | undefined;
    // Decided by the comparison: NiteSec's next sooner installing first.
    expect(chosen?.reason).toBe("sooner installing");
    expect(chosen?.without?.faction).toBe("NiteSec");
    expect(chosen?.with?.ms as number).toBeLessThan(chosen?.without?.ms ?? Number.POSITIVE_INFINITY);
    expect(brain.logLines).toContainEqual(
      expect.stringMatching(
        /^augmentations: install chosen, \S+ \S+ since the last: buying Cranial Signal Processors - Gen I, .* sooner /,
      ),
    );
    const bought = fresh.data.store
      .eventsInWindow({ environment: "E1", sinceMs: editedAtMs, untilMs: game.clock.now() })
      .filter((event) => event.kind === AUGMENTATION_BOUGHT_EVENT_KIND)
      .map((event) => event.detail as { augmentation: string; faction: string; queueLength: number });
    expect(bought.slice(0, 5).map((each) => [each.augmentation, each.faction, each.queueLength])).toEqual(
      FIVE.map((augmentation, index) => [augmentation, "CyberSec", index + 1]),
    );
    // Then home's RAM and NeuroFlux Governor's first level, before the install.
    expect(bought.map((each) => each.augmentation)).toEqual([...FIVE, "NeuroFlux Governor"]);
    for (let ram = homeRamNow; ram < homeRamAfter; ram *= 2) {
      expect(brain.logLines).toContainEqual(
        `augmentations: upgradeHomeRam(${ram}, Alpha Enterprises) done, before the install (home's RAM stays)`,
      );
    }
    expect(brain.saveBackupEvents.filter((event) => "file" in event).length).toBeGreaterThanOrEqual(1);
    expect(brain.logLines.filter((line) => line.includes("NOT QUEUED"))).toEqual([]);

    // The reset game: the five installed, the next Agent back, the cycle over.
    const installed = slow()?.resetInfo.ownedAugs ?? {};
    expect(installed).toEqual({ ...Object.fromEntries(FIVE.map((name) => [name, 1])), "NeuroFlux Governor": 1 });
    const sessions = brain.channelEvents.filter((event) => event.type === "agentConnected");
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    expect(fresh.controller().augmentationsView()).toMatchObject({ committed: false, notQueued: [] });
    expect(fresh.controller().installAwaitingRestart()).toBeNull();

    // After the reset: the multipliers the five and the NeuroFlux level bring (`Augmentations.ts`'s data), and home's
    // new RAM, which an install keeps. The hacking level 20 minutes on is logged, not judged: home's RAM differs too.
    await game.runUntil(() => game.clock.now() >= resetAt + COMPARED_AFTER_MS, COMPARED_AFTER_MS + MINUTE);
    const levelAfter = hacking(fresh.medium());
    const mults = fresh.medium()?.player.mults as Record<string, number> | undefined;
    expect(mults?.hacking).toBeCloseTo(1.05 * 1.05 * 1.07 * NEUROFLUX, 6);
    expect(mults?.hacking_speed).toBeCloseTo(1.03 * 1.01 * 1.02 * NEUROFLUX, 6);
    expect(mults?.hacking_exp).toBeCloseTo(1.1 * NEUROFLUX, 6);
    expect(mults?.hacking_chance).toBeCloseTo(1.05 * NEUROFLUX, 6);
    expect(homeRam()).toBe(homeRamAfter);

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
      `seed ${seed}: hacking ${levelBefore} 17 min after the start, ${levelAfter} 20 min after the install (home ` +
        `${homeRamBefore} GB, then ${homeRam()} GB); ` +
        `installed ${Object.entries(installed)
          .map(([name, level]) => (level > 1 ? `${name} ${level}` : name))
          .join(", ")}; ${((resetAt - editedAtMs) / 1000).toFixed(0)} s from the edit to the reset`,
    );
  },
);
