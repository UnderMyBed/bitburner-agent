// Augmentations and the reset (#210), in the simulator: a fresh 8 GB start in BN1 reaching its first install, the
// brain's rules as on Steam (the batcher, programs, home RAM, backdoors, faction work and augmentations, all on).
// - 17 virtual minutes in (`EDITED_AFTER_MS`), a harness edit stands in for the hours of work (A5's, #203): CyberSec
//   joined with the reputation for its five augmentations, NiteSec joined with none (so something is left at the
//   joined factions), and the money for the five, home's RAM upgrades (those the rest would buy, #218) and a
//   NeuroFlux Governor level.
// - Under 20 minutes into the cycle with 4 or more affordable, the count rule's quick install (#222, the legacy
//   scripts'): a 30 s countdown in the game's time, then the brain chooses the install, buys the five in buy order
//   through the Agent's `sim` effector, then home's RAM, then NeuroFlux Governor, and installs through the gate and
//   a save backup; the game starts boot.js after the reset, and the next Agent connects.
// - After the reset, the player's multipliers are the five's and NeuroFlux Governor's, and home has its new RAM.
// - On to the second install (#238): NeuroFlux Governor's levels alone at 6 of 30, with nothing that counts within
//   reach. The report says so as information, and doesn't fail "Daedalus count stuck" (#229's check did).
// - Held for Daedalus's count (#243), a second test: run #3's 17:49 in the engine (25 installed, four reached, The
//   Black Hand's augmentation 12 minutes off by work, hacking past 2500), held until it's reached, then one install at
//   30; with `AUGMENTATION_DAEDALUS=1`, on to Daedalus's invitation (37.5 virtual minutes from the edit on seeds 1
//   to 5; on main's code, without the hold, 61.2 to 104.7). `AUGMENTATION_DAEDALUS_LOG` names a file for its progress.
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
/**
 * When the harness edit comes: 17 minutes, inside the quick install's 20 (core's `QUICK_INSTALL_WITHIN_MS`, #222), with
 * room for the slow snapshot showing CyberSec's reputation and the 30 s countdown.
 */
const EDITED_AFTER_MS = 17 * MINUTE;
/** From the harness edit to the reset: the countdown, five purchases a few seconds apart, the gate and its backup. */
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
/** From the first cycle's checks to the second install: about 35 virtual minutes on seeds 1 to 5 (#238). */
const SECOND_INSTALL_WITHIN_MS = 45 * MINUTE;

test("AUGMENTATION_SEEDS: seeds 1 or more, or unset for seed 1; an empty or odd entry fails loudly", () => {
  expect(augmentationSeeds(undefined)).toEqual([1]);
  expect(augmentationSeeds("1, 4")).toEqual([1, 4]);
  for (const odd of ["", "1,", "0", "2.5", "x"]) expect(() => augmentationSeeds(odd)).toThrow(/AUGMENTATION_SEEDS/);
});

test.each(SEEDS)(
  "seed %i: from a fresh start, CyberSec's five, home RAM and NeuroFlux Governor installed, the Agent back; then a " +
    "NeuroFlux-only install at 6 of 30, information, not a failure",
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
      | { reason: string; onlineMs: number; affordable: number; affordableWithNeuroFlux: number }
      | undefined;
    // The count rule's quick install (#222): under 20 minutes online, 4 or more affordable with NeuroFlux.
    expect(chosen?.reason).toBe("quick install");
    expect(chosen?.affordable).toBe(5);
    expect(chosen?.affordableWithNeuroFlux).toBeGreaterThanOrEqual(6);
    expect(chosen?.onlineMs).toBeLessThan(20 * MINUTE);
    expect(brain.logLines).toContainEqual(
      expect.stringMatching(/^augmentations: install countdown started, 30 s, a quick install, within 20 min of /),
    );
    expect(brain.logLines).toContainEqual(expect.stringMatching(/^augmentations: install countdown ended \(/));
    expect(brain.logLines).toContainEqual(
      expect.stringMatching(
        /^augmentations: install chosen, \S+ min online this cycle: buying Cranial Signal Processors - Gen I, .*, a quick /,
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

    // The run report: the count rule's progress, the decision, the purchases and the install, the Agent back, and no
    // failure. Each line with --verbose (#245); by default, the cycle's set in one line, in buy order.
    const reportWindow = { environment: "E1", sinceMs: EPOCH_MS, untilMs: game.clock.now() } as const;
    expect(runReport(fresh.data.store, reportWindow).text.split("\n")).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^ {4}BN1\\.1 1: bought \\d+ for \\$[\\d,]+: ${FIVE.join(", ")}, NeuroFlux Governor ×\\d+ ` +
            "\\(levels? [\\d–]+\\); 1 install chosen \\(quick install\\); install sent \\(the brain's\\)$",
        ),
      ),
    );
    const { text, failures } = runReport(fresh.data.store, reportWindow, { verbose: true });
    const lines = text.split("\n");
    expect(lines).toContainEqual(
      expect.stringMatching(/^ {4}\S+ {2}progress: 5 of 8 new augmentations affordable .*install countdown \(a quick /),
    );
    expect(lines).toContainEqual(expect.stringMatching(/^ {4}\S+ {2}install chosen, .*; a quick install, /));
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

    // The second install (#238), NeuroFlux Governor's levels alone on seeds 1 to 5: the factions joined this cycle
    // (NiteSec, The Black Hand, Tian Di Hui, group B, CyberSec again) have too little reputation for anything they sell
    // that isn't owned, so nothing that counts is within reach. That's section 3's information, not a failure.
    await game.runUntil(() => (slow()?.resetInfo.lastAugReset ?? resetAt) !== resetAt, SECOND_INSTALL_WITHIN_MS);
    expect(slow()?.resetInfo.lastAugReset).not.toBe(resetAt);
    await game.run(MINUTE);
    expect(Object.keys(slow()?.resetInfo.ownedAugs ?? {})).toHaveLength(6);
    const second = runReport(fresh.data.store, { environment: "E1", sinceMs: EPOCH_MS, untilMs: game.clock.now() });
    expect(second.text.split("\n")).toContainEqual(
      expect.stringMatching(
        /^ {4}\S+ {2}installed NeuroFlux Governor only at 6 of 30 augmentations installed: nothing that counts within reach$/,
      ),
    );
    expect(brain.logLines).toContain(
      "world daemon: installed NeuroFlux Governor only at 6 of 30 augmentations installed: nothing that counts within " +
        "reach",
    );
    expect(second.failures).toEqual([]);
    // The cycles (#244): the quick install's, the NeuroFlux Governor one's, and the third under way, each judged.
    const cycles = second.text
      .slice(second.text.indexOf("2b. Augmentation cycles"), second.text.indexOf("3. Actions"))
      .split("\n");
    expect(cycles).toContainEqual(
      expect.stringMatching(/^ {4}cycle 1 from .*, ended by an install \(quick install\)$/),
    );
    expect(cycles).toContainEqual(
      expect.stringMatching(/^ {6}installed: \d+ \(.*Neurotrainer I.*\); Daedalus's count 0 → 6 of 30$/),
    );
    expect(cycles).toContainEqual(expect.stringMatching(/^ {4}cycle 2 from .*, ended by an install \(.+\)$/));
    expect(cycles).toContainEqual(
      expect.stringMatching(/^ {6}installed: \d+ \(NeuroFlux Governor ×\d+\); Daedalus's count 6 → 6 of 30$/),
    );
    expect(cycles).toContainEqual(expect.stringMatching(/^ {4}cycle 3 from .*, not ended in the window$/));
    expect(cycles.filter((line) => /^ {6}held back by: \w+.* \(\d+% of .* online judged\)/.test(line))).toHaveLength(3);
    expect(cycles).toContainEqual(
      expect.stringMatching(/^ {6}favour: CyberSec 0 → \d+(\.\d+)?( \(predicted\))?; donations at 150$/),
    );
    console.log(
      `seed ${seed}: hacking ${levelBefore} 17 min after the start, ${levelAfter} 20 min after the install (home ` +
        `${homeRamBefore} GB, then ${homeRam()} GB); ` +
        `installed ${Object.entries(installed)
          .map(([name, level]) => (level > 1 ? `${name} ${level}` : name))
          .join(", ")}; ${((resetAt - editedAtMs) / 1000).toFixed(0)} s from the edit to the reset`,
    );
  },
);

// --- Held for Daedalus's count (#243): run #3's 17:49 in the engine, on to Daedalus's invitation --------------------

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
 * The Black Hand's augmentation this far off by A5's work when the four are reached: run #3's was 17 minutes; 12 here,
 * within the 20-minute hold with room for the purchases and the work's start.
 */
const BLACK_HAND_OFF_MS = 12 * MINUTE;
/**
 * The hacking ramp after an install, a harness edit standing in for it (the same in both runs, as the suite can't run
 * the hours to hacking 2500): this long after each reset, hacking past 2500 and $200b (Daedalus's other two
 * requirements, `FactionInfo.tsx:141-142`). About run #3's 28-minute cycle less the work and purchases in it.
 */
const RAMP_MS = 20 * MINUTE;
/** Hacking experience past level 2500 at any multiplier from 1 (`calculateSkill`: 32 × ln(exp + 534.6) − 200). */
const PAST_2500_EXP = 1e40;
/** Each stage's bound: the hold and the install; on to Daedalus, the cycles to its invitation. */
const HELD_WITHIN_MS = 45 * MINUTE;
const DAEDALUS_WITHIN_MS = 3 * 60 * MINUTE;

test("AUGMENTATION_DAEDALUS: 1 on, unset or 0 off; anything else fails loudly", () => {
  expect([toDaedalus(undefined), toDaedalus("0"), toDaedalus("1")]).toEqual([false, false, true]);
  for (const odd of ["", "true", "2"]) expect(() => toDaedalus(odd)).toThrow(/AUGMENTATION_DAEDALUS/);
});

test.each(SEEDS)(
  "seed %i: at 25 of 30 with four reached, the install held for The Black Hand (#243), then 30 installed" +
    (TO_DAEDALUS ? ", and on to Daedalus's invitation" : ""),
  { timeout: TO_DAEDALUS ? 1_800_000 : 300_000 },
  async (seed) => {
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
    // Sharing off, so A5's rate is A6's (the share's bonus left out); the money kept until the hold or the commit, and
    // no install before the edit (a quick install of NeuroFlux Governor's levels would reset its hacking level).
    const controller = fresh.controller();
    controller.setAugmentationsEnabled(false);
    controller.setShareEnabled(false);
    controller.setProgramsEnabled(false);
    controller.setHomeRamEnabled(false);
    controller.setCloudServersEnabled(false);

    // 15 minutes in, hacking past 2500; a minute on, A5's hacking work at a faction (CyberSec, joined by its backdoor),
    // at favour 0: The Black Hand's rate too. At it, the harness puts The Black Hand's augmentation 12 minutes off, the
    // four within reach, and the money for them and it. The hold then has A5 work for The Black Hand.
    await game.run(15 * MINUTE);
    await simulation.diagnostics.gainHackingExp(PAST_2500_EXP);
    await game.run(MINUTE);
    await game.runUntil(() => controller.factionsView().choice?.workType === "hacking", 10 * MINUTE);
    expect((fresh.medium()?.player.skills as { hacking?: number } | undefined)?.hacking).toBeGreaterThanOrEqual(2500);
    expect(controller.factionsView().choice?.favor).toBe(0);
    const rate = controller.factionsView().choice?.reputationPerSecond as number;
    expect(rate).toBeGreaterThan(0);
    await simulation.diagnostics.joinFactionWithReputation(BLACK_HAND, 100_000 - (rate * BLACK_HAND_OFF_MS) / 1000);
    await simulation.diagnostics.joinFactionWithReputation("CyberSec", 18_750);
    await simulation.diagnostics.joinFactionWithReputation("NiteSec", 20_000);
    await simulation.diagnostics.setMoney(50e9);
    controller.setAugmentationsEnabled(true);
    const editedAtMs = game.clock.now();
    note(`seed ${seed}: edited at ${at(editedAtMs)}, The Black Hand at ${rate.toFixed(2)} a second`);
    const held = () => controller.augmentationsView().progress?.countHold != null;
    await game.runUntil(() => held() || controller.augmentationsView().committed, 5 * MINUTE);
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

    // The hold, then its end as The Black Hand's reputation comes, and the install of the five: 30 of 30.
    await until(() => installs.length > 0, HELD_WITHIN_MS);
    expect(brain.logLines).toContainEqual(
      expect.stringMatching(
        new RegExp(
          "^augmentations: install held for Daedalus's count: Daedalus's count reachable this cycle, The Black Hand " +
            "in ~1\\d min \\(by work at The Black Hand, ",
        ),
      ),
    );
    expect(brain.logLines).toContain(
      "augmentations: the hold for Daedalus's count is over: the count reached at this install",
    );
    const chosen = fresh.data.store
      .eventsInWindow({ environment: "E1", sinceMs: editedAtMs, untilMs: game.clock.now() })
      .filter((event) => event.kind === AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND)
      .map((event) => event.detail as { set: { augmentation: string }[] });
    expect(chosen).toHaveLength(1);
    expect(chosen[0]?.set.map((each) => each.augmentation).sort()).toEqual([BLACK_HAND, ...REACHED_FOUR].sort());
    await game.run(MINUTE);
    expect(installedCount()).toBe(30);
    // Each progress line, with --verbose (#245).
    const { text, failures } = runReport(
      fresh.data.store,
      { environment: "E1", sinceMs: EPOCH_MS, untilMs: game.clock.now() },
      { verbose: true },
    );
    expect(text.split("\n")).toContainEqual(
      expect.stringMatching(
        /^ {4}\S+ {2}progress: .*; held: Daedalus's count reachable this cycle, The Black Hand in ~/,
      ),
    );
    expect(failures).toEqual([]);
    const heldMs = (resetsSeenAtMs[0] ?? Number.NaN) - editedAtMs;
    note(`seed ${seed}: held, then installed at 30: ${(heldMs / MINUTE).toFixed(1)} min from the edit to the reset`);

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
