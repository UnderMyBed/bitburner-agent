// Augmentations and the reset (#210), in the simulator: a fresh 8 GB start in BN1 reaching its first install, the
// brain's rules as on Steam (the batcher, programs, home RAM, backdoors, faction work and augmentations, all on).
// - 17 virtual minutes in (`EDITED_AFTER_MS`), a harness edit stands in for the hours of work (A5's, #203): CyberSec
//   joined with the reputation for its five augmentations, NiteSec joined with none (so something is left at the
//   joined factions), and the money for the five, home's RAM upgrades (those the rest would buy, #218) and a
//   NeuroFlux Governor level.
// - Short of Daedalus's count, the planner's install timing (#343; the count rule's quick install, #222, before it):
//   six new to the count (the five and NeuroFlux Governor's first level) about 17 minutes into the cycle, nothing more
//   to come soon (NiteSec at 0), so installing now is the shortest; held while #228's hold keeps city group B's money
//   (to 20 minutes), then at once, no countdown. The brain buys the five in
//   buy order through the Agent's `sim` effector, then home's RAM, then NeuroFlux Governor, and installs through the
//   gate and a save backup; the game starts boot.js after the reset, and the next Agent connects.
// - After the reset, the player's multipliers are the five's and NeuroFlux Governor's, and home has its new RAM.
// - 20 minutes on, the planner's progress: NeuroFlux Governor's levels alone add nothing to the count (6 of 30), so no
//   install is on offer (the count rule's second install, about 35 minutes on, was those, #238).
// - The planner's install timing (#343; #243's hold before it), a second test: run #3's 17:49 in the engine (25
//   installed, four reached, hacking past 2500). The Black Hand's augmentation 12 minutes off by work, inside the
//   estimate of installing now (this cycle's time online, the four making 29 of 30): the planner waits until it's
//   reached, then one install at 30; with `AUGMENTATION_DAEDALUS=1`, on to Daedalus's invitation (37.5 virtual
//   minutes from the edit on seeds 1 to 5 with #243's hold; without it, 61.2 to 104.7). `AUGMENTATION_DAEDALUS_LOG`
//   names a file for its progress. Three times the cycle's time online off instead, outside it: installed now, at 29.
// CI runs seed 1, to the install; `AUGMENTATION_SEEDS` (`1,2,3`, say) runs others.
import { appendFileSync } from "node:fs";
import { augmentationsSoldBy, DAEDALUS, type MediumSnapshotData, type SlowSnapshotData } from "@bitburner-agent/core";
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
/** When the harness edit comes: 17 minutes (inside the count rule's quick install's 20, #222, before #343). */
const EDITED_AFTER_MS = 17 * MINUTE;
/** From the harness edit to the reset: the choice, five purchases a few seconds apart, the gate and its backup. */
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
/** The brain's line as it queues the install, before the install's gate and its save backup (augmentations.ts). */
const INSTALL_QUEUED = /^augmentations: installing \d+ queued \(the gate, then a save backup first\)$/;

test("AUGMENTATION_SEEDS: seeds 1 or more, or unset for seed 1; an empty or odd entry fails loudly", () => {
  expect(augmentationSeeds(undefined)).toEqual([1]);
  expect(augmentationSeeds("1, 4")).toEqual([1, 4]);
  for (const odd of ["", "1,", "0", "2.5", "x"]) expect(() => augmentationSeeds(odd)).toThrow(/AUGMENTATION_SEEDS/);
});

test.each(SEEDS)(
  "seed %i: from a fresh start, the planner installs CyberSec's five, home RAM and NeuroFlux Governor, the Agent " +
    "back; then nothing new to the count at 6 of 30, no install on offer (#343)",
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
    // The backups counted as the install is queued, before its gate: the city factions' joins after the edit each take
    // their own at their gate, one of them (seed 1: New Tokyo's) after the commit.
    await game.runUntil(() => brain.logLines.some((line) => INSTALL_QUEUED.test(line)), INSTALLED_WITHIN_MS);
    const backupsBefore = brain.saveBackupEvents.length;
    await game.runUntil(() => (slow()?.resetInfo.lastAugReset ?? startedAt) !== startedAt, INSTALLED_WITHIN_MS);
    const resetAt = slow()?.resetInfo.lastAugReset as number;
    expect(resetAt).not.toBe(startedAt);

    // The brain's choice, then its purchases in buy order, each from CyberSec at its price then; then the install,
    // through its gate and one save backup.
    const chosen = fresh.data.store
      .eventsInWindow({ environment: "E1", sinceMs: editedAtMs, untilMs: game.clock.now() })
      .find((event) => event.kind === AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND)?.detail as
      | { reason: string; onlineMs: number; affordable: number; affordableWithNeuroFlux: number; timing?: unknown }
      | undefined;
    // The planner's install for Daedalus's count (#343): six new to it (NeuroFlux Governor's first level counts, none
    // installed yet), installing now the shortest; at once, no countdown.
    expect(chosen).toMatchObject({
      reason: "Daedalus's count",
      affordable: 5,
      short: { installed: 0, required: 30 },
      timing: { needed: 30, adding: 6, choice: 0 },
    });
    // Not while #228's hold keeps city group B's money (#343): the edit's money has group B chosen, $30m held in Ishima,
    // then Chongqing's and New Tokyo's invitations; installing now waits for the last (seed 1: 20.0 min online, where the
    // count rule's quick install, before #343, came at about 17.5, inside its 20 minutes).
    const lineAt = (pattern: RegExp) => brain.logLines.findIndex((line) => pattern.test(line));
    expect(lineAt(/^invitations: in Ishima: \$30,000,000 held for Ishima's invitation/)).toBeGreaterThan(-1);
    expect(lineAt(/^invitations: New Tokyo invited in New Tokyo$/)).toBeGreaterThan(-1);
    expect(lineAt(/^invitations: New Tokyo invited in New Tokyo$/)).toBeLessThan(
      lineAt(/^augmentations: install chosen,/),
    );
    expect(brain.logLines.filter((line) => line.includes("install countdown"))).toEqual([]);
    expect(brain.logLines).toContainEqual(
      expect.stringMatching(
        /^augmentations: install chosen, \S+ min online this cycle: buying Cranial Signal Processors - Gen I, .*, Daedalus's count: .*; chosen: install now$/,
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
      // At the tech vendor in the player's city: Ishima's, once the brain has travelled for Tian Di Hui (#228).
      const vendors = ["Alpha Enterprises", "Omega Software"].map(
        (vendor) => `augmentations: upgradeHomeRam(${ram}, ${vendor}) done, before the install (home's RAM stays)`,
      );
      expect(brain.logLines.some((line) => vendors.includes(line))).toBe(true);
    }
    // The install's gate: one save backup, its own (destroy-restart's check).
    expect(brain.saveBackupEvents.slice(backupsBefore)).toEqual([
      expect.objectContaining({ file: expect.any(String) }),
    ]);
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

    // The run report: the planner's progress, the decision, the purchases and the install, the Agent back, and no
    // failure. Each line with --verbose (#245); by default, the cycle's set in one line, in buy order.
    const reportWindow = { environment: "E1", sinceMs: EPOCH_MS, untilMs: game.clock.now() } as const;
    expect(runReport(fresh.data.store, reportWindow).text.split("\n")).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^ {4}BN1\\.1 1: bought \\d+ for \\$[\\d,]+: ${FIVE.join(", ")}, NeuroFlux Governor ×\\d+ ` +
            "\\(levels? [\\d–]+\\); 1 install chosen \\(Daedalus's count\\); install sent \\(the brain's\\)$",
        ),
      ),
    );
    const { text, failures } = runReport(fresh.data.store, reportWindow, { verbose: true });
    const lines = text.split("\n");
    expect(lines).toContainEqual(
      expect.stringMatching(
        /^ {4}\S+ {2}progress: 5 of 8 new augmentations affordable .*; the planner: 0 of 30 .*: install now$/,
      ),
    );
    expect(lines).toContainEqual(
      expect.stringMatching(/^ {4}\S+ {2}install chosen, .*; Daedalus's count: the planner's shortest time to it is /),
    );
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
    // Sharing on (#230): Tian Di Hui's work at the cycle's start shares home beside the hosts, and no batch is short
    // while the share is on the batches' hosts.
    expect(lines).toContainEqual(expect.stringMatching(/^ {4}shared for \d+ min: /));
    expect(lines).toContainEqual(
      expect.stringMatching(/^ {4}while sharing on the batches' hosts: \d+ late, \d+ lost, 0 short; on home alone: /),
    );
    // No batch short of RAM at all (#232): as the cloud servers are bought back after the install, the plan grows to
    // most of the hosts' RAM, and the batcher fits each batch to the RAM as it will be held (seeds 1 to 5).
    expect(lines).toContain("  short of RAM: none");
    expect(failures).toEqual([]);

    // The second cycle, 20 minutes on: the planner's progress; nothing new to the count (NeuroFlux Governor's level
    // installed already), so no install (the count rule's second, about 35 minutes on, was its levels alone, #238).
    const timing = fresh.controller().augmentationsView().progress?.timing;
    expect(timing).toMatchObject({ needed: 24, adding: 0 });
    expect(timing?.choice).not.toBe(0);
    // The cycles (#244): the planner's install's, and the second under way, each judged.
    const cycles = text.slice(text.indexOf("2b. Augmentation cycles"), text.indexOf("3. Actions")).split("\n");
    expect(cycles).toContainEqual(
      expect.stringMatching(/^ {4}cycle 1 from .*, ended by an install \(Daedalus's count\)$/),
    );
    expect(cycles).toContainEqual(
      expect.stringMatching(/^ {6}installed: \d+ \(.*Neurotrainer I.*\); Daedalus's count 0 → 6 of 30$/),
    );
    expect(cycles).toContainEqual(expect.stringMatching(/^ {4}cycle 2 from .*, not ended in the window$/));
    const judged = cycles.filter((line) => /^ {6}held back by: \w+.* \(\d+% of .* online judged\)/.test(line));
    expect(judged).toHaveLength(2);
    expect(cycles).toContainEqual(
      expect.stringMatching(/^ {6}favour: CyberSec 0 → \d+(\.\d+)?( \(predicted\))?; donations at 150$/),
    );
    console.log(
      `seed ${seed}: hacking ${levelBefore} 17 min after the start, ${levelAfter} 20 min after the install (home ` +
        `${homeRamBefore} GB, then ${homeRam()} GB); ` +
        `then ${timing?.words}; installed ${Object.entries(installed)
          .map(([name, level]) => (level > 1 ? `${name} ${level}` : name))
          .join(", ")}; ${((resetAt - editedAtMs) / 1000).toFixed(0)} s from the edit to the reset`,
    );
  },
);

// --- The planner's install timing (#343; #243's hold before it): run #3's 17:49 in the engine, on to Daedalus -------

/** `AUGMENTATION_DAEDALUS`: 1, on to Daedalus's invitation; unset or 0 (CI), to the install. Else it fails loudly. */
function toDaedalus(text: string | undefined): boolean {
  if (text === undefined || text === "0") return false;
  if (text === "1") return true;
  throw new Error(`AUGMENTATION_DAEDALUS is ${JSON.stringify(text)}: give 1, or 0 (or leave it unset)`);
}
const TO_DAEDALUS = toDaedalus(process.env.AUGMENTATION_DAEDALUS);
const BLACK_HAND = "The Black Hand";
/**
 * Before the Agent, harness edits stand in for the run so far: 25 installed, the cheap ones every faction the brain
 * could join soon sells (so none comes within reach in the hold, and Tian Di Hui isn't visited): The Black Hand's all
 * but its own augmentation, Tian Di Hui's eight, city group A's (Sector-12 and Aevum, joined, banning B and C), Gen I
 * and NeuroFlux Governor. At the edit, hacking past 2500 too: Daedalus's requirement reached this cycle, so the count
 * is what's missing (the hold's condition, #243 review).
 */
const RUN_3_INSTALLED = [
  ...augmentationsSoldBy(BLACK_HAND, 1, null).filter((name) => name !== BLACK_HAND && name !== "NeuroFlux Governor"),
  ...augmentationsSoldBy("Tian Di Hui", 1, null).filter((name) => name !== "NeuroFlux Governor"),
  "Augmented Targeting I",
  "Augmented Targeting II",
  "CashRoot Starter Kit",
  "PCMatrix",
  "Synaptic Enhancement Implant",
  "Neurotrainer I",
  "Cranial Signal Processors - Gen I",
  "NeuroFlux Governor",
];
/**
 * Four reached by the edit, CyberSec joined at 18,750 and NiteSec at 20,000: the install takes the count to 29 of 30
 * (run #3's four came from BitRunners and The Black Hand).
 */
const REACHED_FOUR = [
  "Cranial Signal Processors - Gen II",
  "BitWire",
  "Neurotrainer II",
  "Neural-Retention Enhancement",
];
/**
 * The Black Hand's augmentation this far off by A5's work when the four are reached, inside: run #3's was 17
 * minutes; 12 here, inside installing now's estimate (this cycle's time online, about 17 minutes at the edit: one more
 * cycle for the last), with room for the purchases and the work's start. Outside: three times that time online.
 */
const BLACK_HAND_OFF_MS = 12 * MINUTE;
const OUTSIDE_TIMES = 3;
/**
 * The hacking ramp after an install, a harness edit standing in for it (the same in both runs, as the suite can't run
 * the hours to hacking 2500): this long after each reset, hacking past 2500 and $200b (Daedalus's other two
 * requirements, `FactionInfo.tsx:141-142`). About run #3's 28-minute cycle less the work and purchases in it.
 */
const RAMP_MS = 20 * MINUTE;
/** Hacking experience past level 2500 at any multiplier from 1 (`calculateSkill`: 32 × ln(exp + 534.6) − 200). */
const PAST_2500_EXP = 1e40;
/** Each stage's bound: the wait and the install; on to Daedalus, the cycles to its invitation. */
const HELD_WITHIN_MS = 45 * MINUTE;
const DAEDALUS_WITHIN_MS = 3 * 60 * MINUTE;

test("AUGMENTATION_DAEDALUS: 1 on, unset or 0 off; anything else fails loudly", () => {
  expect([toDaedalus(undefined), toDaedalus("0"), toDaedalus("1")]).toEqual([false, false, true]);
  for (const odd of ["", "true", "2"]) expect(() => toDaedalus(odd)).toThrow(/AUGMENTATION_DAEDALUS/);
});

test.each(
  SEEDS.flatMap((seed) => [
    { seed, inside: true },
    { seed, inside: false },
  ]),
)(
  "seed $seed: at 25 of 30 with four reached, The Black Hand inside the estimate ($inside): the planner waits for it, " +
    "then 30 installed" +
    (TO_DAEDALUS ? ", and on to Daedalus's invitation" : "") +
    "; outside, installed now at 29",
  { timeout: TO_DAEDALUS ? 1_800_000 : 300_000 },
  async ({ seed, inside }) => {
    expect(RUN_3_INSTALLED).toHaveLength(25);
    expect(REACHED_FOUR).toHaveLength(4);
    const fresh = await freshStartOf({
      withDesiredState: true,
      seed,
      beforeAgent: async ({ simulation }) => {
        for (const augmentation of RUN_3_INSTALLED)
          await simulation.diagnostics.giveInstalledAugmentation(augmentation);
        await simulation.diagnostics.joinFactionWithReputation("Sector-12", 0);
        await simulation.diagnostics.joinFactionWithReputation("Aevum", 0);
        await simulation.diagnostics.joinFactionWithReputation(BLACK_HAND, 0);
      },
    });
    const { game, brain, simulation } = fresh;
    const slow = () => fresh.latest<SlowSnapshotData>("slow");
    const startMs = game.clock.now();
    const at = (ms: number) => `${((ms - startMs) / MINUTE).toFixed(1)} min`;
    const notes: string[] = [];
    const note = (line: string) => {
      notes.push(line);
      if (process.env.AUGMENTATION_DAEDALUS_LOG) appendFileSync(process.env.AUGMENTATION_DAEDALUS_LOG, `${line}\n`);
    };
    // Sharing off, so A5's rate is A6's (the share's bonus left out); the money kept until the wait or the commit, and
    // no install before the edit (a quick install of NeuroFlux Governor's levels would reset its hacking level).
    const controller = fresh.controller();
    controller.setAugmentationsEnabled(false);
    controller.setShareEnabled(false);
    controller.setProgramsEnabled(false);
    controller.setHomeRamEnabled(false);
    controller.setCloudServersEnabled(false);

    // 15 minutes in, hacking past 2500; a minute on, A5's hacking work at a faction (CyberSec, joined by its backdoor),
    // at favour 0: The Black Hand's rate too. At it, the harness puts The Black Hand's augmentation 12 minutes off (or
    // three times the cycle's time online), the four within reach, and the money for them and it. A wait then has A5
    // work for The Black Hand.
    await game.run(15 * MINUTE);
    await simulation.diagnostics.gainHackingExp(PAST_2500_EXP);
    await game.run(MINUTE);
    await game.runUntil(() => controller.factionsView().choice?.workType === "hacking", 10 * MINUTE);
    expect((fresh.medium()?.player.skills as { hacking?: number } | undefined)?.hacking).toBeGreaterThanOrEqual(2500);
    expect(controller.factionsView().choice?.favor).toBe(0);
    const rate = controller.factionsView().choice?.reputationPerSecond as number;
    expect(rate).toBeGreaterThan(0);
    const offMs = inside ? BLACK_HAND_OFF_MS : OUTSIDE_TIMES * (game.clock.now() - startMs);
    await simulation.diagnostics.joinFactionWithReputation(BLACK_HAND, 100_000 - (rate * offMs) / 1000);
    await simulation.diagnostics.joinFactionWithReputation("CyberSec", 18_750);
    await simulation.diagnostics.joinFactionWithReputation("NiteSec", 20_000);
    await simulation.diagnostics.setMoney(50e9);
    controller.setAugmentationsEnabled(true);
    const editedAtMs = game.clock.now();
    note(
      `seed ${seed}: edited at ${at(editedAtMs)}, The Black Hand at ${rate.toFixed(2)} a second, ` +
        `${(offMs / MINUTE).toFixed(1)} min off`,
    );
    const waiting = () => (controller.augmentationsView().progress?.timing?.choice ?? 0) > 0;
    await game.runUntil(() => waiting() || controller.augmentationsView().committed, 5 * MINUTE);
    controller.setProgramsEnabled(true);
    controller.setHomeRamEnabled(true);
    controller.setCloudServersEnabled(true);

    // Each install's time and count; the hacking ramp's stand-in after each; Daedalus's invitation.
    const startedAt = slow()?.resetInfo.lastAugReset as number;
    let lastReset = startedAt;
    const resetsSeenAtMs: number[] = [];
    let ramped = true;
    const installs: string[] = [];
    const daedalusSeen = () => {
      const state = slow()?.factions?.state;
      return (
        state?.invitations.includes(DAEDALUS) === true || state?.joined.some((each) => each.name === DAEDALUS) === true
      );
    };
    const installedCount = () => Object.keys(slow()?.resetInfo.ownedAugs ?? {}).length;
    const watch = async () => {
      const reset = slow()?.resetInfo.lastAugReset as number;
      if (reset !== lastReset) {
        lastReset = reset;
        const seenAtMs = game.clock.now();
        resetsSeenAtMs.push(seenAtMs);
        ramped = false;
        installs.push(`${at(seenAtMs)}: ${installedCount()}`);
        note(`seed ${seed}: install seen at ${at(seenAtMs)}, ${installedCount()} installed`);
      }
      const lastSeenAtMs = resetsSeenAtMs.at(-1);
      if (!ramped && lastSeenAtMs !== undefined && game.clock.now() >= lastSeenAtMs + RAMP_MS) {
        ramped = true;
        await simulation.diagnostics.gainHackingExp(PAST_2500_EXP);
        await simulation.diagnostics.setMoney(200e9);
      }
    };
    const until = async (done: () => boolean, withinMs: number) => {
      const endMs = game.clock.now() + withinMs;
      while (!done()) {
        if (game.clock.now() > endMs) throw new Error(`not within ${withinMs / MINUTE} virtual minutes`);
        await game.run(30_000);
        await watch();
      }
    };

    // Inside: the wait, then the install of the five as The Black Hand's reputation comes: 30 of 30. Outside: the
    // four at once, 29 of 30.
    await until(() => installs.length > 0, HELD_WITHIN_MS);
    const waits = brain.logLines.filter((line) => line.startsWith("augmentations: the planner's install timing: "));
    const chosen = fresh.data.store
      .eventsInWindow({ environment: "E1", sinceMs: editedAtMs, untilMs: game.clock.now() })
      .filter((event) => event.kind === AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND)
      .map((event) => event.detail as { set: { augmentation: string }[]; reason: string; timing?: { choice: number } });
    expect(chosen).toHaveLength(1);
    expect(chosen[0]).toMatchObject({ reason: "Daedalus's count", timing: { choice: 0 } });
    await game.run(MINUTE);
    // A wait logged before the edit's slow snapshot (The Black Hand at 0, nothing reached) isn't the four's.
    const waitedWithFour = waits.filter((line) => line.includes(", 4 new at an install, "));
    if (!inside) {
      expect(waitedWithFour).toEqual([]);
      expect(chosen[0]?.set.map((each) => each.augmentation).sort()).toEqual([...REACHED_FOUR].sort());
      expect(installedCount()).toBe(29);
      const { failures } = runReport(fresh.data.store, {
        environment: "E1",
        sinceMs: EPOCH_MS,
        untilMs: game.clock.now(),
      });
      expect(failures).toEqual([]);
      note(
        `seed ${seed}: installed now at 29: ${(((resetsSeenAtMs[0] ?? Number.NaN) - editedAtMs) / MINUTE).toFixed(1)} min from the edit to the reset`,
      );
      console.log(notes.join("\n"));
      return;
    }
    expect(waitedWithFour).toEqual([
      expect.stringMatching(
        new RegExp(
          "^augmentations: the planner's install timing: 25 of 30 installed, 4 new at an install, \\d+ min this cycle " +
            "\\(T[^)]*\\); to Daedalus's count: install now \\d+ min, wait for The Black Hand \\(1\\d min, by work at " +
            "The Black Hand\\) 1\\d min; chosen: wait for 1$",
        ),
      ),
    ]);
    expect(chosen[0]?.set.map((each) => each.augmentation).sort()).toEqual([BLACK_HAND, ...REACHED_FOUR].sort());
    expect(installedCount()).toBe(30);
    // Each progress line, with --verbose (#245).
    const { text, failures } = runReport(
      fresh.data.store,
      { environment: "E1", sinceMs: EPOCH_MS, untilMs: game.clock.now() },
      { verbose: true },
    );
    expect(text.split("\n")).toContainEqual(
      expect.stringMatching(/^ {4}\S+ {2}progress: .*; the planner: 25 of 30 installed, .*; chosen: wait for 1$/),
    );
    expect(failures).toEqual([]);
    const heldMs = (resetsSeenAtMs[0] ?? Number.NaN) - editedAtMs;
    note(`seed ${seed}: waited, then installed at 30: ${(heldMs / MINUTE).toFixed(1)} min from the edit to the reset`);

    if (TO_DAEDALUS) {
      await until(daedalusSeen, DAEDALUS_WITHIN_MS);
      note(
        `seed ${seed}: Daedalus invited ${((game.clock.now() - editedAtMs) / MINUTE).toFixed(1)} min after the edit; ` +
          `installs ${installs.join(", ")}`,
      );
      const after = runReport(fresh.data.store, { environment: "E1", sinceMs: EPOCH_MS, untilMs: game.clock.now() });
      expect(after.failures).toEqual([]);
    }
    console.log(notes.join("\n"));
  },
);
