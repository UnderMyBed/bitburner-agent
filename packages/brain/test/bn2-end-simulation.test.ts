// BN2's end (#356, #352's findings, slice 5): the destroy out of BN2 and the gang after it, which no other suite runs
// (destroy-restart's boot BN1, bn5-path's enters BN2 and stays). From BN2 with SF1.3, SF4.3 and SF5.1 as the
// campaign's order enters it (bn5-path's destroy), the brain's rules as on Steam (all on), the simulator's own
// effectors taken away so the Agent works through Singularity and its workers. Coverage only. Harness edits stand in
// for the hours: The Red Pill installed and w0r1d_d43m0n rooted before the Agent (destroy-restart's `toTheRedPill`),
// NiteSec joined for the gang (gang-simulation's), hacking past BN1's 3,000 but short of BN2's 15,000.
// - BN2.1: the brain forms the gang with NiteSec through the gate, and holds the destroy at 15,000, 3,000 ×
//   `WorldDaemonDifficulty` 5 (`BitNode/BitNode.tsx:596`, `Server/ServerHelpers.ts:383-385`).
// - Past 15,000: the brain's own destroy enters BN2.2 (owner decision 66, core's `nextBitNodeOf`: SF2 short of 3), SF2.1
//   gained. The destroy takes the gang and every gang's figures and the factions joined
//   (`PersonObjects/Player/PlayerObjectGeneralMethods.ts:157-158`, `:111` by `:145`).
// - BN2.2: the gang rule drops the first gang's faction (the next Agent's session starts with no slow snapshot), reads
//   none, NiteSec joined again by a harness edit, and the brain forms the second gang, `createGang(NiteSec)` again.
// - The run report across both BN2s: the gang's faction carried per BitNode (`GangFactionCarry`, keyed by
//   `lastNodeReset`), the gang's checks (#354's silent stalls too), the time to the destroy (#362: none in BN2, said
//   once a BitNode), and PASS.
// One seed, as bn5-path's: a thin slice, no sweep.
import {
  AGENT_SIM_EFFECTORS_GLOBAL,
  AUGMENTATION_BITNODE_MULTIPLIERS,
  gangFactionOf,
  nextBitNodeOf,
  PORT_OPENER_PROGRAMS,
  type SlowSnapshotData,
  type StaticSnapshotData,
} from "@bitburner-agent/core";
import { expect, test } from "vitest";
import { DESTROY_ESTIMATED_EVENT_KIND } from "../src/destroy-estimate.ts";
import { GangFactionCarry, type GangView, gangSnapshotOf } from "../src/gang.ts";
import { runReport } from "../src/run-report.ts";
import { BITNODE_DESTROY_SENT_EVENT_KIND } from "../src/world-daemon.ts";
import { EPOCH_MS } from "./helpers/agent-in-simulation.ts";
import { type FreshGame, ownerRunsOnHome, useFreshStarts, withoutSimEffectors } from "./helpers/fresh-start.ts";

const freshStartOf = useFreshStarts();
const MINUTE = 60_000;
const SOURCE_FILES = { 1: 3, 4: 3, 5: 1 };
const BN2 = { kind: "bitnode", n: 2, sourceFiles: SOURCE_FILES } as const;
const RED_PILL = "The Red Pill";
const DAEMON = "w0r1d_d43m0n";
const FACTION = "NiteSec";
/** w0r1d_d43m0n's level in BN1, which `WorldDaemonDifficulty` multiplies (`Server/ServerHelpers.ts:383-385`). */
const BN1_DAEMON_LEVEL = 3_000;

/** Each stage's bound: the gang formed through the gate, or a destroy through the gate and the next Agent. */
const STAGE_MS = 10 * MINUTE;

/**
 * The hacking level's multiplier: SF1.3's ×1.28 and SF5.1's ×1.08 (`SourceFile/applySourceFile.ts`), BN2's
 * `HackingLevelMultiplier` 0.8 (`BitNode/BitNode.tsx:577`).
 */
const LEVEL_MULT = 1.28 * 1.08 * 0.8;
/** Hacking experience for the middle of `level` (`calculateSkill`: floor(m × (32 ln(exp + 534.6) − 200))). */
const expFor = (level: number) => Math.exp(((level + 0.5) / LEVEL_MULT + 200) / 32) - 534.6;
/** Past BN1's 3,000, short of BN2's 15,000: held. */
const HELD_LEVEL = 5_000;
/** Past 15,000 (a harness edit for the hours of it). */
const PAST_LEVEL = 15_100;

/** The Agent sessions the brain has seen connect. */
const agentSessions = (brain: { channelEvents: { type: string }[] }) =>
  brain.channelEvents.filter((event) => event.type === "agentConnected").length;

/**
 * destroy-restart's `toTheRedPill` in BN2: The Red Pill queued (a harness edit) and installed through the simulator's
 * own install, which links w0r1d_d43m0n (`Prestige.ts:174-182`); hacking at `HELD_LEVEL`; $1t; the port openers bought
 * and run on it with NUKE.exe; home at 64 GB so Singularity's 33.9 GB destroy fits beside the Agent. Then NiteSec joined
 * with no reputation (after the install, which would leave it), and the simulator's effectors taken away.
 */
async function toTheRedPillInBn2(game: FreshGame) {
  await game.simulation.diagnostics.queueAugmentation(RED_PILL);
  await ownerRunsOnHome(
    game,
    `export async function main(ns) { globalThis.${AGENT_SIM_EFFECTORS_GLOBAL}.installQueuedAugmentations(""); }`,
  );
  await game.simulation.diagnostics.setMoney(1e12);
  await game.simulation.diagnostics.gainHackingExp(expFor(HELD_LEVEL));
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
  await game.simulation.diagnostics.joinFactionWithReputation(FACTION, 0);
  await withoutSimEffectors(game);
}

test("BN2's end: the gang formed in BN2.1, the destroy held short of 15,000, then the brain's own destroy enters BN2.2 with SF2.1, the gang gone, formed again; the report passes across both", async () => {
  const fresh = await freshStartOf({ withDesiredState: true, fixture: BN2, beforeAgent: toTheRedPillInBn2 });
  const { game, brain, simulation } = fresh;
  const controller = fresh.controller();
  const slow = () => fresh.latest<SlowSnapshotData>("slow");
  const hacking = () => (fresh.medium()?.player.skills as { hacking?: number } | undefined)?.hacking ?? 0;
  const gangKind = () => gangSnapshotOf(fresh.medium()).kind;
  const joined = () =>
    ((fresh.medium()?.player as { factions?: string[] } | undefined)?.factions ?? []).includes(FACTION);
  // The gang rule's stages in order, with the BitNode's reset each was seen in.
  const stages: { stage: GangView["stage"]; line: string; lastNodeReset: unknown }[] = [];
  const watch = () => {
    const { stage, line } = controller.gangView();
    if (stages.at(-1)?.stage !== stage) stages.push({ stage, line, lastNodeReset: slow()?.resetInfo.lastNodeReset });
  };
  const runUntil = (done: () => boolean, ms: number) =>
    game.runUntil(() => {
      watch();
      return done();
    }, ms);
  /** `ms` on, watching the stages each 10 s (a medium snapshot's period). */
  const runFor = async (ms: number) => {
    for (let ran = 0; ran < ms; ran += 10_000) {
      await game.run(10_000);
      watch();
    }
  };

  await runUntil(() => slow() !== null && fresh.medium() !== null, MINUTE);
  const before = slow()?.resetInfo;
  expect(before).toMatchObject({ currentNode: 2, ownedAugs: { [RED_PILL]: 1 } });
  expect(before?.ownedSF).toEqual(SOURCE_FILES);
  const nodeResetBefore = before?.lastNodeReset as number;

  // 15,000 in the game's static snapshot: BN1's 3,000 × BN2's `WorldDaemonDifficulty` 5, core's table.
  expect(AUGMENTATION_BITNODE_MULTIPLIERS[2]?.WorldDaemonDifficulty).toBe(5);
  const required = fresh
    .latest<StaticSnapshotData>("static")
    ?.servers?.find((server) => server.hostname === DAEMON)?.requiredHackingSkill;
  expect(required).toBe(BN1_DAEMON_LEVEL * 5);
  expect(required).toBe(15_000);
  // The next BitNode by the campaign's order: BN2 again, SF2 to 1 of its 3 (owner decision 66).
  expect(nextBitNodeOf({ currentNode: 2, ownedSF: SOURCE_FILES })).toEqual({ bitNode: 2, replay: null, skipped: [] });

  // BN2.1's gang: formed by the brain with NiteSec through the gate, then a minute of its readings.
  await runUntil(() => gangKind() === "gang", STAGE_MS);
  const first = gangSnapshotOf(fresh.medium());
  if (first.kind !== "gang") throw new Error("no gang read");
  expect(first.gang).toMatchObject({ faction: FACTION, isHacking: true });
  await runFor(MINUTE);
  expect(controller.gangView().stage).toBe("managed");

  // Past BN1's 3,000, short of 15,000: held, in the guard's words, nothing destroyed.
  const level = hacking();
  expect(level).toBe(HELD_LEVEL);
  expect(controller.worldDaemonView()).toMatchObject({
    destroying: false,
    nextBitNode: 2,
    replay: null,
    skipped: null,
  });
  expect(controller.worldDaemonView().path?.daemon).toMatchObject({
    reachable: true,
    rooted: true,
    requiredHackingLevel: 15_000,
    problem: `hacking level ${HELD_LEVEL}: w0r1d_d43m0n needs 15000`,
  });
  expect(slow()?.resetInfo.lastNodeReset).toBe(nodeResetBefore);

  // Past 15,000: the brain's own destroy, through the gate and a backup.
  const backupsBefore = brain.saveBackupEvents.length;
  const sessionsBefore = agentSessions(brain);
  await simulation.diagnostics.gainHackingExp(expFor(PAST_LEVEL));
  const levelledAtMs = game.clock.now();
  await runUntil(() => (slow()?.resetInfo.lastNodeReset ?? nodeResetBefore) !== nodeResetBefore, STAGE_MS);
  const enteredSeenAtMs = game.clock.now();
  const nodeResetAfter = slow()?.resetInfo.lastNodeReset as number;

  // BN2.2: SF2.1 gained beside the others, nothing installed; through Singularity's `destroyW0r1dD43m0n`, straight in
  // (`Singularity.ts:1188-1190`).
  expect(slow()?.resetInfo).toMatchObject({ currentNode: 2, ownedAugs: {} });
  expect(slow()?.resetInfo.ownedSF).toEqual({ ...SOURCE_FILES, 2: 1 });
  expect(
    (await simulation.events(0)).events.filter((event) =>
      ["bitnodeDestroyed", "bitnodeFlumed", "bitverseReached"].includes(event.type),
    ),
  ).toEqual([expect.objectContaining({ type: "bitnodeDestroyed", destroyed: 2, entered: 2 })]);
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

  // The gang gone with the destroy, NiteSec left: the next Agent's gang worker reads none, and the rule waits for a
  // gang faction.
  await runUntil(() => agentSessions(brain) > sessionsBefore && gangKind() === "none", 2 * MINUTE);
  expect(agentSessions(brain)).toBe(sessionsBefore + 1);
  expect(joined()).toBe(false);
  await runUntil(() => controller.gangView().stage === "noFaction", MINUTE);

  // NiteSec joined again (a harness edit, as A3's backdoor on avmnite-02h would have it): the second gang, formed by
  // the brain through the gate, then two minutes of its readings.
  const backupsBeforeSecond = brain.saveBackupEvents.filter((event) => "file" in event).length;
  await simulation.diagnostics.joinFactionWithReputation(FACTION, 0);
  const joinedAgainAtMs = game.clock.now();
  await runUntil(() => gangKind() === "gang", STAGE_MS);
  const formedAgainAtMs = game.clock.now();
  await runFor(2 * MINUTE);
  const second = gangSnapshotOf(fresh.medium());
  if (second.kind !== "gang") throw new Error("no gang read");
  expect(second.gang).toMatchObject({ faction: FACTION, isHacking: true });
  // Through the gate again: its save backup.
  expect(brain.saveBackupEvents.filter((event) => "file" in event).length).toBeGreaterThan(backupsBeforeSecond);
  expect(slow()?.resetInfo.lastNodeReset).toBe(nodeResetAfter);
  expect(controller.worldDaemonView()).toMatchObject({ destroying: false, stall: null });

  // The gang rule's stages (`GangRule.update`), BN2.1's then BN2.2's. The destroy drops the first gang's faction
  // before any "none" reading: the next Agent's session starts with no slow snapshot, so not managed (the faction
  // null, no faction hidden), then waiting for the gang worker's first reading, none, NiteSec not joined; then forming
  // and managed again once it is.
  console.log(stages.map((each) => `${each.stage} (${String(each.lastNodeReset)}): ${each.line}`).join("\n"));
  expect(stages.map((each) => each.stage)).toEqual([
    "notManaged",
    "waiting",
    "forming",
    "managed",
    "notManaged",
    "waiting",
    "noFaction",
    "forming",
    "managed",
  ]);
  expect(stages.slice(5).every((each) => each.lastNodeReset === nodeResetAfter)).toBe(true);
  expect(stages[4]?.line).toBe("Gang: not managed (no slow snapshot yet)");

  // The report's gang faction carry (`GangFactionCarry`), per BitNode by its reset, on the slow snapshots as stored: a
  // new Agent's first slow snapshot comes before its gang worker's reading, so it shows no gang's faction. In BN2.1 it
  // carries the first gang's NiteSec over that gap; in BN2.2, nothing until the second gang's own reading.
  const window = { environment: "E1", sinceMs: EPOCH_MS, untilMs: game.clock.now() } as const;
  const carry = new GangFactionCarry();
  const carried = [...fresh.data.store.iterateSnapshotsInWindow({ ...window, tier: "slow" })].map((row) => {
    const data = row.data as SlowSnapshotData;
    return {
      atMs: row.receivedAtMs,
      reset: data.resetInfo.lastNodeReset,
      sent: gangFactionOf(data),
      carried: gangFactionOf(carry.of(data)),
    };
  });
  console.log(carried.map((each) => JSON.stringify(each)).join("\n"));
  const inBn22 = carried.filter((each) => each.reset === nodeResetAfter);
  expect(carried.filter((each) => each.reset === nodeResetBefore).some((each) => each.carried === FACTION)).toBe(true);
  expect(inBn22[0]).toMatchObject({ sent: null, carried: null });
  expect(inBn22.filter((each) => each.atMs < formedAgainAtMs).every((each) => each.carried === null)).toBe(true);
  expect(inBn22.at(-1)).toMatchObject({ sent: FACTION, carried: FACTION });

  // The run report: BN2.1 destroyed into BN2.2, SF2.1 there, the destroy and both gangs' forms done, and no failure.
  const { text, failures } = runReport(fresh.data.store, window, { verbose: true });
  const lines = text.split("\n");
  const section = text.slice(text.indexOf("7. The gang"), text.indexOf("Verdict"));
  console.log(section);
  expect(lines.find((each) => each.startsWith("  BitNodes: "))).toMatch(
    /^ {2}BitNodes: BN2\.1 from \S+, destroyed after [^,]+, into BN2\.2; BN2\.2 from \S+, not destroyed, /,
  );
  // Each BitNode's own lines: BN2.1's Source-Files, then BN2.2's with SF2.1, its factions from none (the destroy left
  // NiteSec), NiteSec joined again.
  const sourceFiles = lines.filter((each) => each.startsWith("    Source-Files: "));
  expect(sourceFiles).toEqual([
    "    Source-Files: SF1.3, SF4.3, SF5.1 (unchanged)",
    "    Source-Files: SF1.3, SF2.1, SF4.3, SF5.1 (unchanged)",
  ]);
  expect(lines).toContain("    factions: none → NiteSec");
  expect(lines).toContainEqual(expect.stringMatching(/^ {4}\S+ {2}destroy sent \(the brain's\), into BitNode 2$/));
  expect(lines).toContainEqual(
    expect.stringMatching(/^ {4}destroyBitNode\(2\): done: the reset followed, \d+ tr(y|ies)( \(singularity\))?; /),
  );
  // Both gangs formed through the page's worker (no Singularity worker for it), the same intent in each BitNode, each
  // done once: BN2.1's before the destroy, BN2.2's after NiteSec was joined again.
  const formed = lines.filter((each) => each.startsWith("    createGang(NiteSec): "));
  expect(formed).toEqual([
    expect.stringMatching(/^ {4}createGang\(NiteSec\): done after 1 try \(ui\); done by /),
    expect.stringMatching(/^ {4}createGang\(NiteSec\): done after 1 try \(ui\); done by /),
  ]);
  const formedBy = formed.map((each) => Date.parse(each.replace(/^.*done by /, "")));
  expect(formedBy[0]).toBeLessThan(nodeResetAfter);
  expect(formedBy[1]).toBeGreaterThan(joinedAgainAtMs);
  expect(section).toMatch(/\n {2}formed: with NiteSec, first seen /);
  for (const what of [
    "no gang formed with a gang faction joined for 5 min or more:\n    none",
    "the gang unread in BN2 for 5 min or more:\n    none",
    "a recruit the respect allows not made for 1 min or more:\n    none",
    "an ascension the rule makes not made for 1 min or more:\n    none",
    "equipment the rule buys, with the money free, not bought for 1 min or more:\n    none",
    "a gang worker's problem in every reading for 1 min or more:\n    none",
    "a member off the rule's task for 1 min or more:\n    none",
    "the gang's respect flat with the rule's members working for 1 min or more:\n    none",
  ]) {
    expect(section).toContain(what);
  }
  // The time to the destroy (#362): none in BN2 (the gang's route, #357), said once a BitNode, each by its reset.
  expect(stored(DESTROY_ESTIMATED_EVENT_KIND)).toEqual([]);
  expect(brain.logLines.filter((line) => line.startsWith("destroy estimate: none in BitNode 2"))).toHaveLength(2);
  expect(failures).toEqual([]);
  expect(lines.at(-1)).toBe("Verdict: PASS");
  console.log(
    `BN2's end: held at hacking ${level} of 15,000; ${((enteredSeenAtMs - levelledAtMs) / 1000).toFixed(0)} s from ` +
      `past 15,000 to BN2.2 seen; the second gang ${((formedAgainAtMs - joinedAgainAtMs) / 1000).toFixed(0)} s after ` +
      "NiteSec was joined again",
  );
}, 180_000);
