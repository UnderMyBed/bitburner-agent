// The World Daemon (#215), in the simulator: from a harness-edited late game to the end of BN1.1, the brain's rules as
// on Steam (the hack loop, programs, home RAM, cloud servers, backdoors, faction work, augmentations and the destroy,
// all on).
// - Before the Agent, harness edits stand in for the run so far: 30 augmentations installed (Daedalus's count in BN1),
//   the hacking level past 2500, and $200b. The game invites Daedalus within seconds; A5 joins it.
// - Joined, a harness edit puts Daedalus's reputation just short of The Red Pill's 2.5m: A5 works for it, A6 holds
//   ordinary installs, then chooses the install for it ("The Red Pill"), buys the set the money covers, home's RAM and
//   NeuroFlux Governor, The Red Pill last, and installs through the gate and a save backup.
// - After the reset, w0r1d_d43m0n is linked; a harness edit stands in for the hours back to its level (hacking past
//   3000, and $1t). The brain buys the port openers, the hack loop roots it, and the World Daemon rule destroys BN1
//   into BN1 through the gate and a backup; the game starts boot.js, and the next Agent connects in BN1 with SF1.1.
// CI runs seed 1; `WORLD_DAEMON_SEEDS` (`1,2,3`, say) runs others.
import {
  AUGMENTATION_NAMES,
  augmentationsSoldBy,
  isWorthInstalling,
  type MediumSnapshotData,
  PORT_OPENER_PROGRAMS,
  type SlowSnapshotData,
} from "@bitburner-agent/core";
import { expect, test } from "vitest";
import { AUGMENTATION_BOUGHT_EVENT_KIND, AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND } from "../src/augmentations.ts";
import { runReport } from "../src/run-report.ts";
import { BITNODE_DESTROY_SENT_EVENT_KIND } from "../src/world-daemon.ts";
import { EPOCH_MS } from "./helpers/agent-in-simulation.ts";
import { useFreshStarts } from "./helpers/fresh-start.ts";

/** `WORLD_DAEMON_SEEDS`: seeds 1 or more, comma separated; unset, seed 1 alone (CI). Anything else fails loudly. */
function worldDaemonSeeds(text: string | undefined): number[] {
  if (text === undefined) return [1];
  const seeds = text.split(",").map((each) => each.trim());
  if (!seeds.every((each) => /^[1-9]\d*$/.test(each))) {
    throw new Error(`WORLD_DAEMON_SEEDS is ${JSON.stringify(text)}: give seeds 1 or more, comma separated`);
  }
  return seeds.map(Number);
}

const freshStartOf = useFreshStarts();
const SEEDS = worldDaemonSeeds(process.env.WORLD_DAEMON_SEEDS);
const MINUTE = 60_000;
const RED_PILL = "The Red Pill";
/** Hacking experience past level 3000 at any multiplier from 1 (`calculateSkill`: 32 × ln(exp + 534.6) − 200). */
const PAST_3000_EXP = 1e44;
/** CyberSec's shop: joined with its reputation, so an ordinary install would be chosen but for Daedalus's hold. */
const CYBERSEC = augmentationsSoldBy("CyberSec", 1, null);
/**
 * Thirty augmentations worth installing, none of CyberSec's, given installed: Daedalus's count in BN1
 * (`FactionInfo.tsx:141-142`).
 */
const THIRTY = AUGMENTATION_NAMES.filter((name) => isWorthInstalling(name) && !CYBERSEC.includes(name)).slice(0, 30);
/** Each stage's bound: a join, a reputation's last stretch, purchases, an install or a destroy through the gate. */
const STAGE_MS = 15 * MINUTE;

test("WORLD_DAEMON_SEEDS: seeds 1 or more, or unset for seed 1; an empty or odd entry fails loudly", () => {
  expect(worldDaemonSeeds(undefined)).toEqual([1]);
  expect(worldDaemonSeeds("1, 4")).toEqual([1, 4]);
  for (const odd of ["", "1,", "0", "2.5", "x"]) expect(() => worldDaemonSeeds(odd)).toThrow(/WORLD_DAEMON_SEEDS/);
});

test.each(SEEDS)(
  "seed %i: from a late game, Daedalus joined, The Red Pill worked for, bought and installed, w0r1d_d43m0n rooted and BN1 destroyed into BN1",
  { timeout: 300_000 },
  async (seed) => {
    expect(THIRTY).toHaveLength(30);
    const fresh = await freshStartOf({
      withDesiredState: true,
      seed,
      beforeAgent: async ({ simulation }) => {
        for (const augmentation of THIRTY) await simulation.diagnostics.giveInstalledAugmentation(augmentation);
        await simulation.diagnostics.gainHackingExp(PAST_3000_EXP);
        await simulation.diagnostics.setMoney(200e9);
        // CyberSec's five within its reputation: without the hold, A6 would install them at once.
        await simulation.diagnostics.joinFactionWithReputation("CyberSec", 18_750);
      },
    });
    const { game, brain, simulation } = fresh;
    const slow = () => fresh.latest<SlowSnapshotData>("slow");
    const joined = () => slow()?.factions?.state?.joined ?? [];
    const events = (kind: string) =>
      fresh.data.store
        .eventsInWindow({ environment: "E1", sinceMs: EPOCH_MS, untilMs: game.clock.now() })
        .filter((event) => event.kind === kind);

    // Daedalus invites (the game's check, every 2 s), and A5 joins it; A6 holds the install CyberSec's five would have
    // meanwhile, saying why.
    const holds = new Set<string>();
    await game.runUntil(() => {
      const waitingFor = fresh.controller().augmentationsView().waitingFor;
      if (waitingFor !== null) holds.add(waitingFor.replace(/ \(.*$/, ""));
      return joined().some((faction) => faction.name === "Daedalus");
    }, STAGE_MS);
    expect(holds).toContain("Daedalus's invitation");
    expect(events(AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND)).toEqual([]);

    // Just short of The Red Pill: A5's work for it, A6 holding ordinary installs.
    await simulation.diagnostics.joinFactionWithReputation("Daedalus", 2.5e6 - 500);
    await game.runUntil(() => fresh.controller().factionsView().choice?.augmentation === RED_PILL, STAGE_MS);
    expect(fresh.controller().factionsView().choice).toMatchObject({ faction: "Daedalus", augmentation: RED_PILL });
    const startedAt = slow()?.resetInfo.lastAugReset as number;
    await game.runUntil(() => (slow()?.resetInfo.lastAugReset ?? startedAt) !== startedAt, STAGE_MS);

    // The install, for The Red Pill, with The Red Pill bought last, from Daedalus.
    const chosen = events(AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND).map((event) => event.detail as { reason: string });
    expect(chosen).toEqual([expect.objectContaining({ reason: "The Red Pill" })]);
    const bought = events(AUGMENTATION_BOUGHT_EVENT_KIND).map(
      (event) => event.detail as { augmentation: string; faction: string },
    );
    expect(bought.at(-1)).toMatchObject({ augmentation: RED_PILL, faction: "Daedalus" });
    expect(slow()?.resetInfo.ownedAugs).toMatchObject({ [RED_PILL]: 1 });

    // Back to w0r1d_d43m0n's level (a harness edit for the hours of it), and $1t for the port openers: the brain buys
    // them, the hack loop roots it, and the destroy goes through the gate and a backup.
    const nodeResetBefore = slow()?.resetInfo.lastNodeReset as number;
    const backupsBefore = brain.saveBackupEvents.length;
    await simulation.diagnostics.gainHackingExp(PAST_3000_EXP);
    await simulation.diagnostics.setMoney(1e12);
    // Watched as it goes: the port openers bought, and w0r1d_d43m0n rooted, before the destroy.
    let openers = false;
    let rooted = false;
    await game.runUntil(() => {
      const medium: MediumSnapshotData | null = fresh.medium();
      openers ||= PORT_OPENER_PROGRAMS.every((program) => medium?.programs.includes(program));
      rooted ||= medium?.servers.some((server) => server.hostname === "w0r1d_d43m0n" && server.hasAdminRights) === true;
      return (slow()?.resetInfo.lastNodeReset ?? nodeResetBefore) !== nodeResetBefore;
    }, STAGE_MS);
    expect({ openers, rooted }).toEqual({ openers: true, rooted: true });

    // BN1 again, with SF1.1; the next Agent back, the destroy off the queue.
    expect(slow()?.resetInfo).toMatchObject({ currentNode: 1, ownedSF: { 1: 1 }, ownedAugs: {} });
    expect(events(BITNODE_DESTROY_SENT_EVENT_KIND).map((event) => event.detail)).toEqual([
      { source: "brain", nextBitNode: 1 },
    ]);
    expect(brain.saveBackupEvents.length).toBeGreaterThan(backupsBefore);
    expect(brain.logLines).toContainEqual(
      expect.stringMatching(
        /^world daemon: w0r1d_d43m0n rooted at hacking \d+: destroying the BitNode, into BitNode 1/,
      ),
    );
    await game.run(MINUTE);
    expect(
      fresh
        .controller()
        .intentsView()
        .map((view) => view.id),
    ).not.toContain("destroyBitNode(1)");
    expect(fresh.controller().worldDaemonView()).toMatchObject({ destroying: false, stall: null });

    // The run report: The Red Pill's install and the destroy, and no failure.
    const { text, failures } = runReport(fresh.data.store, {
      environment: "E1",
      sinceMs: EPOCH_MS,
      untilMs: game.clock.now(),
    });
    const lines = text.split("\n");
    expect(lines).toContainEqual(expect.stringMatching(/The Red Pill reached: it links w0r1d_d43m0n once installed$/));
    expect(lines).toContainEqual(expect.stringMatching(/^ {4}\S+ {2}destroy sent \(the brain's\), into BitNode 1$/));
    expect(failures).toEqual([]);
    console.log(
      `seed ${seed}: ${bought.length} bought for The Red Pill's install (${bought.map((each) => each.augmentation).join(", ")}); ` +
        `destroyed at ${((game.clock.now() - EPOCH_MS) / MINUTE).toFixed(1)} min`,
    );
  },
);
