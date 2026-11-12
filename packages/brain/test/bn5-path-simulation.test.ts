// BN5's path (#348, #346's findings): the two stretches of a BN5.1 run that the BN5 start (bn5-start-simulation)
// doesn't reach, from BN5 with SF1.3 and SF4.3 as the campaign's order enters it, the brain's rules as on Steam, the
// simulator's own effectors taken away so the Agent works through Singularity (×1 RAM with SF4.3). Coverage only.
// - An install at BN5's prices: `AugmentationMoneyCost` 2 (`BitNode.tsx:676`), the first BitNode the brain plays with
//   one other than 1. Harness edits stand in for the work: CyberSec joined with the reputation for its five, and the
//   money for them, home's RAM and a NeuroFlux Governor level at BN5's prices. The brain buys them in buy order and
//   installs through the gate.
// - The destroy at BN5's World Daemon: w0r1d_d43m0n's level ×1.5, 4,500 (`BitNode.tsx:691`,
//   `Server/ServerHelpers.ts:383-385`). The Red Pill installed and w0r1d_d43m0n rooted before the Agent (destroy-
//   restart's `toTheRedPill`), hacking first past BN1's 3,000 but short of 4,500 (held), then past it: the brain's own
//   destroy enters BN2.1 (owner decision 66, core's `nextBitNodeOf`), SF5.1 gained, and the next Agent connects.
// One seed each, as the BN5 start: a thin slice, no sweep.
import {
  AGENT_SIM_EFFECTORS_GLOBAL,
  type AugmentationPurchaseState,
  augmentationBitNodeMultipliers,
  augmentationCost,
  NEUROFLUX_GOVERNOR,
  nextBitNodeOf,
  PORT_OPENER_PROGRAMS,
  type SlowSnapshotData,
  type StaticSnapshotData,
} from "@bitburner-agent/core";
import type { Simulation } from "@bitburner-agent/sim";
import { expect, test } from "vitest";
import { AUGMENTATION_BOUGHT_EVENT_KIND, AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND } from "../src/augmentations.ts";
import { DESTROY_ESTIMATED_EVENT_KIND, type DestroyEstimateRecord } from "../src/destroy-estimate.ts";
import { runReport } from "../src/run-report.ts";
import { BITNODE_DESTROY_SENT_EVENT_KIND } from "../src/world-daemon.ts";
import { EPOCH_MS } from "./helpers/agent-in-simulation.ts";
import { type FreshGame, ownerRunsOnHome, useFreshStarts, withoutSimEffectors } from "./helpers/fresh-start.ts";

const freshStartOf = useFreshStarts();
const MINUTE = 60_000;
const SOURCE_FILES = { 1: 3, 4: 3 };
const BN5 = { kind: "bitnode", n: 5, sourceFiles: SOURCE_FILES } as const;
const RED_PILL = "The Red Pill";
const DAEMON = "w0r1d_d43m0n";

/** Each stage's bound: purchases a few seconds apart, the gate and its backup; or a destroy through the gate. */
const STAGE_MS = 10 * MINUTE;

/** CyberSec's five in buy order (augmentations-simulation's). */
const FIVE = [
  "Cranial Signal Processors - Gen I",
  "Cranial Signal Processors - Gen II",
  "BitWire",
  "Synaptic Enhancement Implant",
  "Neurotrainer I",
];

/** The brain's line as it queues the install, before the install's gate and its save backup (augmentations.ts). */
const INSTALL_QUEUED = /^augmentations: installing \d+ queued \(the gate, then a save backup first\)$/;

/** The Agent sessions the brain has seen connect. */
const agentSessions = (brain: { channelEvents: { type: string }[] }) =>
  brain.channelEvents.filter((event) => event.type === "agentConnected").length;

/** A purchase state in BitNode `n` with SF1.3 and SF4.3, nothing installed, `queued` queued. */
const stateIn = (n: number, queued: string[]): AugmentationPurchaseState => ({
  installed: {},
  queued,
  sourceFile11Level: 0,
  bitNodeMultipliers: augmentationBitNodeMultipliers(n, SOURCE_FILES),
});
/** Core's price of the `index`th of `names` bought in BitNode `n`, the ones before it queued. */
const priceInBuyOrder = (n: number, names: string[], index: number) =>
  augmentationCost(names[index] as string, stateIn(n, names.slice(0, index))).money;

/**
 * Home's RAM upgrade price at `ram` GB (`PersonObjects/Player/PlayerObjectServerMethods.ts:30-40`; BN5's
 * `HomeComputerRamCost` is 1).
 */
const upgradePrice = (ram: number) => ram * 32_000 * 1.58 ** Math.log2(ram);

/** The game's own price now (`getAugCost`, which Singularity's `getAugmentationPrice` returns, `Singularity.ts:151-156`). */
async function gamePrices(simulation: Simulation, names: string[]) {
  const costs = await simulation.diagnostics.augmentationCosts();
  return names.map((name) => costs[name]?.moneyCost);
}

test("an install at BN5's prices: CyberSec's five, home's RAM and NeuroFlux Governor bought through Singularity at ×2, in buy order, and installed through the gate", async () => {
  const fresh = await freshStartOf({ withDesiredState: true, fixture: BN5, beforeAgent: withoutSimEffectors });
  const { game, brain, simulation } = fresh;
  const controller = fresh.controller();
  const slow = () => fresh.latest<SlowSnapshotData>("slow");
  const homeRam = () => fresh.medium()?.servers.find((server) => server.hostname === "home")?.maxRam;

  // BN5's ×2, three ways: core's table, core's price against BN1's, and the game's own `getAugCost` before any is bought.
  expect(augmentationBitNodeMultipliers(5, SOURCE_FILES)).toMatchObject({
    AugmentationMoneyCost: 2,
    AugmentationRepCost: 1,
  });
  const set = [...FIVE, NEUROFLUX_GOVERNOR];
  const unqueued = set.map((name) => augmentationCost(name, stateIn(5, [])).money);
  expect(unqueued).toEqual(set.map((name) => 2 * augmentationCost(name, stateIn(1, [])).money));
  expect(await gamePrices(simulation, set)).toEqual(unqueued);

  // The first slow snapshot, then home's RAM settled with programs, home RAM and cloud servers paused, so none takes
  // the edit's money before a slow snapshot shows CyberSec's reputation (augmentations-simulation's pause).
  await game.runUntil(() => slow() !== null, MINUTE);
  controller.setProgramsEnabled(false);
  controller.setHomeRamEnabled(false);
  controller.setCloudServersEnabled(false);
  await game.run(20_000);
  const homeRamBefore = homeRam() as number;
  const startedAt = slow()?.resetInfo.lastAugReset as number;

  // The harness edit: CyberSec's reputation for the five, NiteSec joined with none, and the money at BN5's prices for
  // the five, NeuroFlux Governor's next level and every home RAM upgrade the rest would also buy (#218), $3m over.
  const fiveCost = FIVE.reduce((sum, _name, index) => sum + priceInBuyOrder(5, FIVE, index), 0);
  const neuroflux = priceInBuyOrder(5, set, FIVE.length);
  expect(fiveCost).toBe(2 * 447_170_900);
  let homeRamAfter = homeRamBefore;
  let homeRamPrice = 0;
  do {
    homeRamPrice += upgradePrice(homeRamAfter);
    homeRamAfter *= 2;
  } while (upgradePrice(homeRamAfter) <= neuroflux + 3_000_000 + 5_000_000);
  await simulation.diagnostics.joinFactionWithReputation("CyberSec", 18_750);
  await simulation.diagnostics.joinFactionWithReputation("NiteSec", 0);
  await simulation.diagnostics.setMoney(fiveCost + homeRamPrice + neuroflux + 3_000_000);
  const editedAtMs = game.clock.now();
  await game.runUntil(() => controller.augmentationsView().committed, STAGE_MS);
  const sessionsBefore = agentSessions(brain);
  controller.setProgramsEnabled(true);
  controller.setHomeRamEnabled(true);
  controller.setCloudServersEnabled(true);
  // The backups counted as the install is queued, before its gate: the city factions' joins after the edit each take
  // their own at their gate (augmentations-simulation's count).
  await game.runUntil(() => brain.logLines.some((line) => INSTALL_QUEUED.test(line)), STAGE_MS);
  const backupsBefore = brain.saveBackupEvents.length;
  await game.runUntil(() => (slow()?.resetInfo.lastAugReset ?? startedAt) !== startedAt, STAGE_MS);
  const resetSeenAtMs = game.clock.now();

  const events = (kind: string) =>
    fresh.data.store
      .eventsInWindow({ environment: "E1", sinceMs: editedAtMs, untilMs: game.clock.now() })
      .filter((event) => event.kind === kind)
      .map((event) => event.detail);
  expect(events(AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND)).toEqual([
    expect.objectContaining({ reason: "Daedalus's count", affordable: 5 }),
  ]);
  // In buy order, each at BN5's price then: core's (×2 BN1's) and the game's (its unqueued price × 1.9 a queued one).
  const bought = events(AUGMENTATION_BOUGHT_EVENT_KIND) as {
    augmentation: string;
    faction: string;
    price: number;
    queueLength: number;
  }[];
  expect(bought.map((each) => [each.augmentation, each.faction, each.queueLength])).toEqual(
    set.map((augmentation, index) => [augmentation, "CyberSec", index + 1]),
  );
  bought.forEach((each, index) => {
    expect(each.price).toBe(priceInBuyOrder(5, set, index));
    expect(each.price).toBeCloseTo(2 * priceInBuyOrder(1, set, index), 0);
    expect(each.price).toBeCloseTo((unqueued[index] as number) * 1.9 ** index, 0);
  });
  for (let ram = homeRamBefore; ram < homeRamAfter; ram *= 2) {
    expect(brain.logLines).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^augmentations: upgradeHomeRam\\(${ram}, [\\w ]+\\) done, before the install \\(home's RAM stays\\)$`,
        ),
      ),
    );
  }
  // The install's gate: one save backup, its own (destroy-restart's check).
  expect(brain.saveBackupEvents.slice(backupsBefore)).toEqual([expect.objectContaining({ file: expect.any(String) })]);
  expect(brain.logLines.filter((line) => line.includes("NOT QUEUED"))).toEqual([]);

  // The reset: the set installed, home's RAM kept, the next Agent back.
  expect(slow()?.resetInfo).toMatchObject({ currentNode: 5 });
  expect(slow()?.resetInfo.ownedSF).toEqual(SOURCE_FILES);
  expect(slow()?.resetInfo.ownedAugs).toEqual(Object.fromEntries(set.map((name) => [name, 1])));
  await game.runUntil(() => agentSessions(brain) > sessionsBefore, MINUTE);
  await game.run(MINUTE);
  expect(agentSessions(brain)).toBe(sessionsBefore + 1);
  expect(brain.saveBackupEvents.slice(backupsBefore)).toHaveLength(1);
  expect(homeRam()).toBe(homeRamAfter);
  expect(controller.augmentationsView()).toMatchObject({ committed: false, notQueued: [] });
  expect(controller.installAwaitingRestart()).toBeNull();

  // The time to the destroy (#360): estimated at the start and at the install, at BN5's level (3000 × 1.5), with no
  // BitNode destroyed in the store for a prior (so at least), A at the install by the BitNode's mean.
  const estimates = fresh.data.store
    .eventsInWindow({ environment: "E1", sinceMs: 0, untilMs: game.clock.now() })
    .filter((event) => event.kind === DESTROY_ESTIMATED_EVENT_KIND)
    .map((event) => event.detail as DestroyEstimateRecord);
  expect(
    estimates.map((each) => [each.moment, each.bitNode, each.count, each.requiredLevel, each.prior, each.atLeast]),
  ).toEqual([
    ["start", "BN5.1", 0, 4_500, null, true],
    ["install", "BN5.1", set.length, 4_500, null, true],
  ]);
  const [, install] = estimates;
  expect(install?.terms[0]).toMatchObject({ term: "A", label: "either way" });
  expect(install?.terms[0]?.ms).toBeCloseTo(((install?.onlineMs ?? 0) * (30 - set.length)) / set.length, 6);
  expect(controller.worldDaemonView().lines).toContainEqual(
    expect.stringMatching(/^time to the destroy \(#360\), at install /),
  );

  // The run report: each purchase at its BN5 price, through Singularity; the install done; and no failure.
  const window = { environment: "E1", sinceMs: EPOCH_MS, untilMs: game.clock.now() } as const;
  const { text, failures } = runReport(fresh.data.store, window, { verbose: true });
  const lines = text.split("\n");
  const money = (price: number) => `\\$${Math.round(price).toLocaleString("en-US")}`;
  bought.forEach(({ augmentation, price }, index) => {
    const level = augmentation === NEUROFLUX_GOVERNOR ? " \\(level 1\\)" : "";
    expect(lines).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^ {4}\\S+ {2}bought ${augmentation}${level} from CyberSec for ${money(price)} \\(queue ${index + 1}\\)$`,
        ),
      ),
    );
  });
  const purchases = lines.filter((each) => /^ {4}(purchaseAugmentation|upgradeHomeRam)\(/.test(each));
  expect(purchases).toHaveLength(set.length + Math.log2(homeRamAfter / homeRamBefore));
  expect(purchases.every((each) => /: done after 1 try \(singularity\); /.test(each))).toBe(true);
  // The install's worker dies in the reset before it reports; the slow snapshot after shows it done (#286).
  expect(lines).toContainEqual(
    expect.stringMatching(
      /^ {4}installAugmentations\(\): done: the reset followed, \d+ tr(y|ies)( \(singularity\))?; /,
    ),
  );
  // Nothing through the page: every action with a backend went through Singularity.
  expect(lines.filter((line) => /^ {4}\w+\(.*\((ui|sim)\)/.test(line))).toEqual([]);
  // The time to the destroy (#360): section 3 lists the estimates, section 4 judges them (none never).
  expect(lines).toContainEqual(expect.stringMatching(/^ {4}\S+ {2}time to the destroy \(#360\), at install with /));
  const judged = lines.indexOf("  the time to the destroy (#360: a term never reached):");
  expect(judged).toBeGreaterThan(0);
  expect(lines[judged + 1]).toBe("    none");
  expect(failures).toEqual([]);
  expect(lines.at(-1)).toBe("Verdict: PASS");
  console.log(
    `install at BN5's prices: $${Math.round(bought.reduce((sum, each) => sum + each.price, 0)).toLocaleString("en-US")} ` +
      `for ${bought.length}; home ${homeRamBefore} → ${homeRamAfter} GB; ` +
      `${((resetSeenAtMs - editedAtMs) / 1000).toFixed(0)} s from the edit to the reset`,
  );
}, 180_000);

/** Hacking experience (`Person.ts:50`, no multiplier) for a BN5 level past BN1's 3,000 but short of 4,500 at SF1.3. */
const PAST_3000_EXP = 1e45;
/** And past 4,500. Level: floor(1.28 × (32 × ln(exp + 534.6) − 200)), SF1.3's hacking ×1.28 (`calculateSkill`). */
const PAST_4500_EXP = 1e55;

/**
 * destroy-restart's `toTheRedPill` in BN5: The Red Pill queued (a harness edit) and installed through the simulator's
 * own install, which links w0r1d_d43m0n (`Prestige.ts:174-182`); hacking past 3,000; $1t; the port openers bought and
 * run on it with NUKE.exe; home at 64 GB so Singularity's 33.9 GB destroy fits beside the Agent; the simulator's
 * effectors then taken away.
 */
async function toTheRedPillInBn5(game: FreshGame) {
  await game.simulation.diagnostics.queueAugmentation(RED_PILL);
  await ownerRunsOnHome(
    game,
    `export async function main(ns) { globalThis.${AGENT_SIM_EFFECTORS_GLOBAL}.installQueuedAugmentations(""); }`,
  );
  await game.simulation.diagnostics.setMoney(1e12);
  await game.simulation.diagnostics.gainHackingExp(PAST_3000_EXP);
  // Each NS call by name: the game charges RAM for the names it sees.
  await ownerRunsOnHome(
    game,
    `export async function main(ns) {
      const sim = globalThis.${AGENT_SIM_EFFECTORS_GLOBAL};
      sim.buyTorRouter();
      for (const program of ${JSON.stringify(PORT_OPENER_PROGRAMS)}) sim.buyDarkwebProgram(program);
      const daemon = "${DAEMON}";
      ns.brutessh(daemon); ns.ftpcrack(daemon); ns.relaysmtp(daemon); ns.httpworm(daemon); ns.sqlinject(daemon);
      ns.nuke(daemon);
    }`,
  );
  await game.simulation.diagnostics.setHomeRam(64);
  await withoutSimEffectors(game);
}

test("the destroy at BN5's World Daemon: held short of 4,500, then the brain's own destroy through Singularity enters BN2.1, SF5.1 gained, the next Agent back", async () => {
  const fresh = await freshStartOf({ withDesiredState: true, fixture: BN5, beforeAgent: toTheRedPillInBn5 });
  const { game, brain, simulation } = fresh;
  const controller = fresh.controller();
  const slow = () => fresh.latest<SlowSnapshotData>("slow");
  const hacking = () => (fresh.medium()?.player.skills as { hacking?: number } | undefined)?.hacking ?? 0;
  await game.runUntil(() => slow() !== null && fresh.medium() !== null, MINUTE);
  const before = slow()?.resetInfo;
  expect(before).toMatchObject({ currentNode: 5, ownedAugs: { [RED_PILL]: 1 } });
  expect(before?.ownedSF).toEqual(SOURCE_FILES);
  const nodeResetBefore = before?.lastNodeReset as number;

  // 4,500 in the game's static snapshot: BN1's 3,000 × BN5's 1.5.
  const required = fresh
    .latest<StaticSnapshotData>("static")
    ?.servers?.find((server) => server.hostname === DAEMON)?.requiredHackingSkill;
  expect(required).toBe(4_500);
  // The next BitNode by the campaign's order: BN2, SF5 to 1.
  expect(nextBitNodeOf({ currentNode: 5, ownedSF: SOURCE_FILES })).toEqual({ bitNode: 2, replay: null, skipped: [] });

  // Past BN1's 3,000, short of 4,500: held, in the guard's words, nothing destroyed.
  const level = hacking();
  expect(level).toBeGreaterThan(3_000);
  expect(level).toBeLessThan(4_500);
  await game.run(MINUTE);
  expect(controller.worldDaemonView()).toMatchObject({
    destroying: false,
    nextBitNode: 2,
    replay: null,
    skipped: null,
  });
  expect(controller.worldDaemonView().path?.daemon).toMatchObject({
    reachable: true,
    rooted: true,
    requiredHackingLevel: 4_500,
    problem: expect.stringMatching(/^hacking level \d+: w0r1d_d43m0n needs 4500$/),
  });
  expect(slow()?.resetInfo.lastNodeReset).toBe(nodeResetBefore);

  // Past 4,500 (a harness edit for the hours of it): the brain's own destroy, through the gate and a backup.
  const backupsBefore = brain.saveBackupEvents.length;
  const sessionsBefore = agentSessions(brain);
  await simulation.diagnostics.gainHackingExp(PAST_4500_EXP);
  const levelledAtMs = game.clock.now();
  await game.runUntil(() => (slow()?.resetInfo.lastNodeReset ?? nodeResetBefore) !== nodeResetBefore, STAGE_MS);
  const enteredSeenAtMs = game.clock.now();

  // BN2.1: SF5.1 gained beside SF1.3 and SF4.3; the next Agent connected.
  expect(slow()?.resetInfo).toMatchObject({ currentNode: 2, ownedAugs: {} });
  expect(slow()?.resetInfo.ownedSF).toEqual({ 1: 3, 4: 3, 5: 1 });
  // Through Singularity's `destroyW0r1dD43m0n`, which enters the next BitNode straight (`Singularity.ts:1188-1190`):
  // the page's way (the terminal's backdoor, then the portal) would reach the BitVerse first.
  expect(
    (await simulation.events(0)).events.filter((event) =>
      ["bitnodeDestroyed", "bitnodeFlumed", "bitverseReached"].includes(event.type),
    ),
  ).toEqual([expect.objectContaining({ type: "bitnodeDestroyed", destroyed: 5, entered: 2 })]);
  expect(agentSessions(brain)).toBe(sessionsBefore + 1);
  // The destroy's gate: one save backup, its own (destroy-restart's check).
  expect(brain.saveBackupEvents.slice(backupsBefore)).toEqual([expect.objectContaining({ file: expect.any(String) })]);
  const stored = (kind: string) =>
    fresh.data.store
      .eventsInWindow({ environment: "E1", sinceMs: 0, untilMs: game.clock.now() })
      .filter((event) => event.kind === kind)
      .map((event) => event.detail);
  expect(stored(BITNODE_DESTROY_SENT_EVENT_KIND)).toEqual([
    { source: "brain", nextBitNode: 2, replay: null, skipped: null },
  ]);
  expect(brain.logLines).toContainEqual(
    expect.stringMatching(/^world daemon: w0r1d_d43m0n rooted at hacking \d+: destroying the BitNode, into BitNode 2/),
  );
  await game.run(MINUTE);
  expect(controller.intentsView().map((view) => view.id)).not.toContain("destroyBitNode(2)");
  expect(controller.worldDaemonView()).toMatchObject({ destroying: false, stall: null });

  // The run report: BN5.1 destroyed into BN2.1, SF5.1 there, the destroy done, and no failure.
  const window = { environment: "E1", sinceMs: EPOCH_MS, untilMs: game.clock.now() } as const;
  const { text, failures } = runReport(fresh.data.store, window, { verbose: true });
  const lines = text.split("\n");
  expect(lines.find((each) => each.startsWith("  BitNodes: "))).toMatch(
    /^ {2}BitNodes: BN5\.1 from \S+, destroyed after [^,]+, into BN2\.1; BN2\.1 from \S+, not destroyed, /,
  );
  expect(lines).toContain("    Source-Files: SF1.3, SF4.3, SF5.1 (unchanged)");
  // The time to the destroy (#360): at the first cycle the brain sees, The Red Pill's (the harness installed it before the
  // Agent, so a first look at a cycle not the BitNode's first): A and B + C done, D none (no BitNode destroyed in the
  // store for a prior), at 4,500. None in BN2 (the gang's route, #357), said once.
  const estimates = stored(DESTROY_ESTIMATED_EVENT_KIND) as DestroyEstimateRecord[];
  expect(estimates[0]).toMatchObject({
    moment: "first seen",
    stage: "first seen",
    bitNode: "BN5.1",
    requiredLevel: 4_500,
    atLeast: true,
  });
  expect(estimates[0]?.terms.map((term) => [term.term, term.ms, term.label])).toEqual([
    ["A", 0, "done"],
    ["BC", 0, "done"],
    ["D", null, "optimistic"],
  ]);
  expect(estimates.every((each) => each.bitNode === "BN5.1")).toBe(true);
  expect(brain.logLines.filter((line) => line.startsWith("destroy estimate: none in BitNode 2"))).toHaveLength(1);
  console.log(`destroy estimates in BN5.1: ${estimates.map((each) => each.moment).join(", ")}`);
  expect(lines).toContainEqual(expect.stringMatching(/^ {4}\S+ {2}destroy sent \(the brain's\), into BitNode 2$/));
  // Its worker dies in the reset before it reports; the slow snapshot after shows it done (#286).
  expect(lines).toContainEqual(
    expect.stringMatching(/^ {4}destroyBitNode\(2\): done: the reset followed, \d+ tr(y|ies)( \(singularity\))?; /),
  );
  expect(failures).toEqual([]);
  expect(lines.at(-1)).toBe("Verdict: PASS");
  console.log(
    `destroy at BN5's World Daemon: held at hacking ${level} of 4,500; ` +
      `${((enteredSeenAtMs - levelledAtMs) / 1000).toFixed(0)} s from past 4,500 to BN2.1 seen`,
  );
}, 180_000);
