// Property tests (#179): the brain's half of the reconciler's rules, whatever comes in between (snapshots, guards that
// fail, save backups that fail, the Agent's reports, resets with the brain up or down and the clock set back,
// reconnects, a restarted brain), with the rules off (the owner's queue alone) or on (as in a live run). The Agent
// runs only what the latest desired state sends, and never again what it reported done while it's sent (the intent
// runner's properties, packages/ingame/test/agent/intent-runner.test.ts), so what holds of what's sent here holds of
// what runs in the game:
// - nothing queued after an intent that resets the game (an install, #164; a destroy, #175) goes before the reset,
//   nor a rule's irreversible intent (#269); and the reset goes only once what was queued before it is done;
// - the irreversible gate (R8, #147): one irreversible intent at a time, whatever made it; each with its guard holding
//   on the latest medium snapshot since the Agent connected; and each goes out only at the moment its own save backup
//   (asked while it was the gates' first, this session, and still so) is answered saved;
// - an intent of the owner's the Agent reported done, or a reset intent once its reset shows, never goes again unless
//   queued again: a new Agent holds no intents, so this keeps a done one from running twice across a reset;
// - and it gets done: from a stable game (guards holding, backups saved, every intent done), the owner's queue drains,
//   each intent in it sent.
// Each rule's example tests are desired-state.test.ts's; the reset itself, in the simulator, install-restart.test.ts's
// and destroy-restart.test.ts's.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ControlChannel } from "@bitburner-agent/bridge";
import { ManualClock, MemoryConnection } from "@bitburner-agent/bridge/test-helpers";
import {
  CONTROL_PROTOCOL_VERSION,
  type DesiredState,
  encodeControlMessage,
  FACTION_ENEMIES,
  INTENT_ACTIONS,
  type Intent,
  type IntentOutcome,
  type IntentRequest,
  intentId,
  isIrreversibleIntent,
  resetsTheGame,
  type SnapshotTier,
  WORLD_DAEMON,
} from "@bitburner-agent/core";
import fc from "fast-check";
import { afterAll, beforeAll, expect, test } from "vitest";
import { DesiredStateController } from "../src/desired-state.ts";
import { readManualIntents } from "../src/manual-intents.ts";
import type { SaveBackupEvent } from "../src/save-backups.ts";
import { TelemetryStore } from "../src/telemetry-store.ts";
import { mediumData, slowData, staticServer } from "./helpers/snapshot-fixtures.ts";

const TOKEN = "the-token";
const intentOf = (request: IntentRequest): Intent => ({ ...request, id: intentId(request.action, request.args) });
/** Every action; three joins (Sector-12 and Chongqing are enemies, so irreversible; CyberSec isn't); two destroys. */
const OWNER_INTENTS: Intent[] = [
  intentOf({ action: "buyTor", args: { vendor: "Alpha Enterprises" } }),
  intentOf({ action: "buyProgram", args: { program: "BruteSSH.exe" } }),
  intentOf({ action: "upgradeHomeRam", args: { fromRam: 8, vendor: "Alpha Enterprises" } }),
  intentOf({ action: "travel", args: { city: "Aevum" } }),
  intentOf({ action: "joinFaction", args: { faction: "Sector-12" } }),
  intentOf({ action: "joinFaction", args: { faction: "Chongqing" } }),
  intentOf({ action: "joinFaction", args: { faction: "CyberSec" } }),
  intentOf({ action: "purchaseAugmentation", args: { faction: "CyberSec", augmentation: "Neurotrainer I", level: 1 } }),
  intentOf({ action: "donateToFaction", args: { faction: "Sector-12", amount: 1_000_000, reputation: 1 } }),
  intentOf({ action: "buyServer", args: { hostname: "pserv-0", ram: 8 } }),
  intentOf({ action: "upgradeServer", args: { hostname: "pserv-0", ram: 64 } }),
  intentOf({ action: "backdoor", args: { hostname: "CSEC" } }),
  intentOf({ action: "installAugmentations", args: {} }),
  intentOf({ action: "destroyBitNode", args: { nextBitNode: 2 } }),
  intentOf({ action: "destroyBitNode", args: { nextBitNode: 3 } }),
];
const OWNER_INTENTS_BY_ID = new Map(OWNER_INTENTS.map((each) => [each.id, each]));
const JOINABLE = ["Sector-12", "Chongqing", "Aevum", "CyberSec"];
/** Invitations the slow snapshot may carry, for the rules' joins (#203, #228): city factions and CyberSec. */
const INVITABLE = ["Sector-12", "Aevum", "Chongqing", "New Tokyo", "CyberSec"];
/** The rules' switches, off in a run with the rules off. The hack loop is off in every run, so intents go at once. */
const RULE_SWITCHES = [
  "batcher.enabled",
  "programs.enabled",
  "homeRam.enabled",
  "cloudServers.enabled",
  "augmentations.enabled",
  "factionWork.enabled",
  "worldDaemon.enabled",
  "share.enabled",
];
const SAVED_BACKUP: SaveBackupEvent = { type: "saveBackup", atMs: 1, file: "saves/E0/x.json.gz", sizeBytes: 10 };
const FAILED_BACKUP: SaveBackupEvent = { type: "saveBackup", atMs: 1, failure: "the game sent its save as text" };
/** The static snapshot once The Red Pill is in: w0r1d_d43m0n among the servers, at 3000 hacking. */
const STATIC_WITH_DAEMON = {
  servers: [
    staticServer("home", { moneyMax: 0 }),
    staticServer(WORLD_DAEMON, { requiredHackingSkill: 3000, numOpenPortsRequired: 5 }),
  ],
};

/**
 * What an Agent's round does with each intent sent, by its index in `OWNER_INTENTS`: done, or not. A reset intent done
 * resets the game (its Agent dies, the next connects to the reset game); `doneNoReset` is an install with nothing left
 * to install. A rule's intent stays not done.
 */
const anyAnswers = fc.array(fc.constantFrom("done", "done", "notDone", "doneNoReset"), {
  minLength: OWNER_INTENTS.length,
  maxLength: OWNER_INTENTS.length,
});
const anyIndex = fc.nat({ max: OWNER_INTENTS.length - 1 });
const indexesWhere = (keep: (each: Intent) => boolean) =>
  OWNER_INTENTS.flatMap((each, index) => (keep(each) ? [index] : []));
/** The owner's queue to start with: mostly with an intent that resets the game, anywhere in it. */
const anyInitialQueue = fc
  .tuple(
    fc.uniqueArray(fc.constantFrom(...indexesWhere((each) => !resetsTheGame(each))), { maxLength: 5 }),
    fc.option(fc.constantFrom(...indexesWhere(resetsTheGame)), { freq: 4 }),
    fc.nat(),
  )
  .map(([others, reset, at]) => {
    if (reset === null) return others;
    const position = at % (others.length + 1);
    return [...others.slice(0, position), reset, ...others.slice(position)];
  });
/** A medium snapshot: mostly no faction joined and w0r1d_d43m0n ready, so guards hold and gates open. */
const anyMedium = fc.record({
  factions: fc.oneof(
    { arbitrary: fc.constant([] as string[]), weight: 3 },
    { arbitrary: fc.subarray(JOINABLE), weight: 1 },
  ),
  daemonReady: fc.oneof({ arbitrary: fc.constant(true), weight: 3 }, { arbitrary: fc.constant(false), weight: 1 }),
});
type Medium = typeof anyMedium extends fc.Arbitrary<infer Each> ? Each : never;
/**
 * What happens next: the owner queues or cancels; a medium snapshot; a save backup's answer; the three medium
 * snapshots a gate needs and every backup asked for answered, mostly saved (`release`, so gates open often); an
 * Agent's round, a reset with the brain up or down, and the game's clock moved on or set back (#167); a slow snapshot,
 * with invitations; a reconnect; or a restarted brain.
 */
const anyStep = fc.oneof(
  { arbitrary: fc.record({ kind: fc.constant("queue" as const), index: anyIndex }), weight: 2 },
  { arbitrary: fc.record({ kind: fc.constant("cancel" as const), index: anyIndex }), weight: 1 },
  { arbitrary: fc.record({ kind: fc.constant("medium" as const), medium: anyMedium }), weight: 3 },
  { arbitrary: fc.record({ kind: fc.constant("backup" as const), saved: fc.boolean() }), weight: 2 },
  {
    arbitrary: fc.record({
      kind: fc.constant("release" as const),
      medium: anyMedium,
      saved: fc.oneof({ arbitrary: fc.constant(true), weight: 3 }, { arbitrary: fc.constant(false), weight: 1 }),
    }),
    weight: 4,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("agentRound" as const),
      answers: anyAnswers,
      brainDownAcrossReset: fc.boolean(),
      clockSetBack: fc.boolean(),
    }),
    weight: 4,
  },
  { arbitrary: fc.record({ kind: fc.constant("slow" as const), invited: fc.subarray(INVITABLE) }), weight: 1 },
  { arbitrary: fc.record({ kind: fc.constant("reconnect" as const) }), weight: 1 },
  { arbitrary: fc.record({ kind: fc.constant("restart" as const) }), weight: 1 },
);
type Step = typeof anyStep extends fc.Arbitrary<infer Each> ? Each : never;

let directory: string;
let storeCount = 0;
/** Across the runs, so the property is seen to reach what it checks. */
const reached = {
  resetsInTheSteps: 0,
  brainDownAcrossReset: 0,
  clockSetBack: 0,
  failedBackupsWhileTaking: 0,
  runsWithARuleJoinOut: 0,
};
beforeAll(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "desired-state-property-"));
});
afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

/**
 * A brain on a fresh store, an Agent connected to it, the steps played, then a stable game until the owner's queue
 * drains: what each desired state sent breaks of the rules, checked against the queue as the owner made it (the order
 * queued), not the brain's own.
 */
async function play(rulesOn: boolean, initialQueue: number[], steps: Step[]): Promise<string[]> {
  const store = TelemetryStore.open(path.join(directory, `telemetry-${++storeCount}.sqlite`));
  store.setSetting("hackLoop.enabled", "false");
  if (!rulesOn) for (const setting of RULE_SWITCHES) store.setSetting(setting, "false");
  /** The game's last resets, as its slow snapshot says. */
  const gameResets = { lastAugReset: 1_000_000, lastNodeReset: 1_000_000 };
  /** The owner's queue, by id, in the order queued; and the owner's intents done (reported, or reset) since. */
  const ownerQueue: string[] = [];
  const unqueue = (id: string) => {
    if (ownerQueue.includes(id)) ownerQueue.splice(ownerQueue.indexOf(id), 1);
  };
  const ownersDone = new Set<string>();
  const sentEver = new Set<string>();
  const everQueuedByOwner = new Set<string>();
  let aRuleJoinWentOut = false;
  const violations: string[] = [];
  let sequenceNumber = 0;
  let sessionNumber = 0;
  let channel = new ControlChannel({ token: TOKEN, clock: new ManualClock() });
  // Set by `startBrain`, the first thing a run does.
  let controller!: DesiredStateController;
  /**
   * Each backup asked for: the session it was asked in, the intent it was for (the first irreversible one the gates
   * judge then: the owner's in the order queued, then the rules'), and whether it's still that intent's (false once
   * another went ahead of it, so its gate started again).
   */
  let pendingBackups: {
    answer: (event: SaveBackupEvent) => void;
    askedInSession: number;
    forId: string | null;
    current: boolean;
  }[] = [];
  let connection = new MemoryConnection();
  let statesChecked = 0;
  /** The latest medium snapshot since the Agent connected, or null before one. */
  let latestMedium: Medium | null = null;
  /** The irreversible intents in the last state sent on this connection. */
  let irreversibleSentBefore = new Set<string>();
  /** The first irreversible intent the gates judge: the owner's first, then the rules' (in their view's order). */
  const firstJudged = (): string | null => {
    const owners = ownerQueue.filter((id) => isIrreversibleIntent(OWNER_INTENTS_BY_ID.get(id) as Intent));
    const rules = controller
      .intentsView()
      .filter((view) => view.source !== "manual" && view.id.startsWith("joinFaction("))
      .map((view) => view.id)
      .filter((id) => isIrreversibleIntent(intentOf({ action: "joinFaction", args: { faction: id.slice(12, -1) } })));
    return owners[0] ?? rules[0] ?? null;
  };

  const send = (tier: SnapshotTier, data: unknown) =>
    connection.receive(
      encodeControlMessage({
        protocolVersion: CONTROL_PROTOCOL_VERSION,
        type: "snapshot",
        agentSessionId: `session-${sessionNumber}`,
        tier,
        sequenceNumber: ++sequenceNumber,
        gameTimeMs: 1_000,
        data,
      }),
    );
  const desiredStatesSent = () =>
    connection
      .sentMessages()
      .filter((message) => message.type === "desiredState")
      .map((message) => message as unknown as DesiredState);
  /** Why `irreversible`'s guard fails on the latest medium snapshot, or null. */
  const guardFailure = (irreversible: Intent): string | null => {
    if (latestMedium === null) return "no medium snapshot since the Agent connected";
    if (irreversible.action === "joinFaction") {
      const enemy = (FACTION_ENEMIES[irreversible.args.faction] ?? []).find((each) =>
        latestMedium?.factions.includes(each),
      );
      return enemy === undefined ? null : `its enemy ${enemy} is joined`;
    }
    if (irreversible.action === "destroyBitNode" && !latestMedium.daemonReady) return "w0r1d_d43m0n isn't ready";
    return null;
  };
  /**
   * Checks what was sent since the last check. `savedFor`: the intent whose own backup, asked this session and still
   * its own, this action answered saved: the only one that may go out on it.
   */
  const checkSentStates = (savedFor: string | null = null) => {
    const states = desiredStatesSent();
    const sources = new Map(controller.intentsView().map((view) => [view.id, view.source]));
    for (const state of states.slice(statesChecked)) {
      const ids = state.intents.map((each) => each.id);
      for (const id of ids) sentEver.add(id);
      const resetAt = ownerQueue.findIndex((id) => resetsTheGame(OWNER_INTENTS_BY_ID.get(id) as Intent));
      const irreversible = state.intents.filter(isIrreversibleIntent);
      if (resetAt !== -1) {
        const reset = ownerQueue[resetAt] as string;
        for (const id of ownerQueue.slice(resetAt + 1)) {
          if (ids.includes(id)) violations.push(`${id} sent before ${reset}, queued before it, reset the game`);
        }
        // A rule's irreversible intent (#269) is for this game's invitations too: it waits for the reset.
        for (const each of irreversible) {
          if (!ownerQueue.includes(each.id)) violations.push(`a rule's ${each.id} sent before ${reset}, queued`);
        }
        // And what was queued before it, for this game, is done first: it goes out only first in the queue.
        if (resetAt > 0 && ids.includes(reset)) {
          violations.push(`${reset} sent with ${ownerQueue.slice(0, resetAt).join(", ")} queued before it, undone`);
        }
      }
      if (irreversible.length > 1) {
        violations.push(`irreversible intents sent together: ${irreversible.map((each) => each.id).join(", ")}`);
      }
      for (const each of irreversible) {
        const failure = guardFailure(each);
        if (failure !== null) violations.push(`${each.id} sent, its guard failing: ${failure}`);
        // Going out now: only on its own backup, answered saved by this action.
        if (!irreversibleSentBefore.has(each.id) && savedFor !== each.id) {
          violations.push(`${each.id} went out with no backup of its own answered saved`);
        }
        // A rule's own join out: one the owner never queued (an owner's gate passes to a rule's same id).
        if (!everQueuedByOwner.has(each.id)) aRuleJoinWentOut = true;
      }
      // The owner's, done: never again. A rule may ask for the same id again (a join, until a snapshot shows it).
      for (const id of ids) {
        if (ownersDone.has(id) && (sources.get(id) ?? "manual") === "manual") violations.push(`${id} sent again, done`);
      }
      irreversibleSentBefore = new Set(irreversible.map((each) => each.id));
    }
    statesChecked = states.length;
    // A backup is its intent's only while that stays the gates' first: pushed back, its gate counts again.
    const first = firstJudged();
    for (const pending of pendingBackups) if (pending.forId !== first) pending.current = false;
  };
  const slowWith = (invited: string[]) => {
    const data = slowData();
    data.resetInfo = { ...data.resetInfo, ...gameResets };
    data.factions = {
      backend: "sim",
      state: { joined: [], invitations: invited, queuedAugmentations: [] },
      problem: null,
    };
    return data;
  };
  /** An Agent connects, in a new session, and sends its static and slow snapshots: every gate starts again. */
  const connect = () => {
    connection = new MemoryConnection();
    statesChecked = 0;
    sessionNumber += 1;
    latestMedium = null;
    irreversibleSentBefore = new Set();
    channel.accept(connection);
    connection.receive(
      encodeControlMessage({
        protocolVersion: CONTROL_PROTOCOL_VERSION,
        type: "hello",
        token: TOKEN,
        deploymentId: "deployment-a",
        agentSessionId: `session-${sessionNumber}`,
        game: { version: "3.0.1", versionNumber: 51, commit: "3162fd2", platform: "Steam" },
      }),
    );
    checkSentStates();
    send("static", STATIC_WITH_DAEMON);
    checkSentStates();
    send("slow", slowWith(["Sector-12"]));
    checkSentStates();
  };
  /** A brain starts on the store: its own channel, controller and save backups (each answered by a step). */
  const startBrain = () => {
    channel = new ControlChannel({ token: TOKEN, clock: new ManualClock() });
    channel.setDeploymentState({ deployedId: "deployment-a", hold: false, deployFailed: false });
    pendingBackups = [];
    const backupNow = () =>
      new Promise<SaveBackupEvent>((answer) => {
        pendingBackups.push({ answer, askedInSession: sessionNumber, forId: firstJudged(), current: true });
      });
    controller = new DesiredStateController({ channel, store, saveBackups: { backupNow } });
  };
  const queue = (index: number) => {
    const { id, ...request } = OWNER_INTENTS[index] as Intent;
    ownersDone.delete(id);
    if (!ownerQueue.includes(id)) ownerQueue.push(id);
    everQueuedByOwner.add(id);
    expect(controller.addManualIntent(request as IntentRequest)).toMatchObject({ ok: true });
    checkSentStates();
  };
  const medium = (snapshot: Medium) => {
    latestMedium = snapshot;
    const hacking = snapshot.daemonReady ? 3000 : 100;
    const player = { money: 1e9, city: "Sector-12", hasTorRouter: true, homeRam: 2 ** 20, factions: snapshot.factions };
    send("medium", mediumData(hacking, { [WORLD_DAEMON]: true }, player));
    checkSentStates();
  };
  /** Answers the oldest backup asked for (`all`: every one, oldest first), each then seen by the controller. */
  const answerBackups = async (saved: boolean, { all = false } = {}) => {
    for (const { answer, askedInSession, forId, current } of pendingBackups.splice(
      0,
      all ? pendingBackups.length : 1,
    )) {
      const itsOwn = current && askedInSession === sessionNumber;
      if (!saved && itsOwn) reached.failedBackupsWhileTaking += 1;
      answer(saved ? SAVED_BACKUP : FAILED_BACKUP);
      await new Promise((resolve) => setImmediate(resolve));
      checkSentStates(saved && itsOwn ? forId : null);
    }
  };
  /** The Agent's round: each intent sent done or not, in order; a reset intent done resets the game. */
  const agentRound = (
    answerOf: (id: string) => string,
    { brainDownAcrossReset = false, clockSetBack = false, inTheSteps = true } = {},
  ) => {
    const sent = desiredStatesSent().at(-1)?.intents ?? [];
    const outcomes: IntentOutcome[] = [];
    let reset: Intent | null = null;
    for (const each of sent) {
      const answer = OWNER_INTENTS_BY_ID.has(each.id) ? answerOf(each.id) : "notDone";
      if (resetsTheGame(each) && answer === "done") {
        reset = each;
        break;
      }
      const done = resetsTheGame(each)
        ? each.action === "installAugmentations" && answer === "doneNoReset"
        : answer !== "notDone";
      outcomes.push({ id: each.id, done, tries: 1, problem: done ? null : "not yet", backend: "sim" });
      if (done && ownerQueue.includes(each.id)) {
        unqueue(each.id);
        ownersDone.add(each.id);
      }
    }
    send("fast", { degradedTiers: [], pageHeapUsedBytes: null, game: null, intents: outcomes });
    checkSentStates();
    if (reset === null) return;
    // The reset kills the Agent; the brain may be down meanwhile (a crash, a restart), so the next one meets it.
    connection.dropFromGameSide();
    checkSentStates();
    if (brainDownAcrossReset) startBrain();
    // The game takes the reset time from the clock, which may have been set back (#167): another, not a later one.
    const moved = clockSetBack ? -500 : 1_000;
    gameResets.lastAugReset += moved;
    if (reset.action === "destroyBitNode") gameResets.lastNodeReset += moved;
    if (inTheSteps) {
      reached.resetsInTheSteps += 1;
      if (brainDownAcrossReset) reached.brainDownAcrossReset += 1;
      if (clockSetBack) reached.clockSetBack += 1;
    }
    // Done by the reset: what was queued after it may go now; it, never again (if the owner's).
    if (ownerQueue.includes(reset.id)) ownersDone.add(reset.id);
    unqueue(reset.id);
    connect();
  };

  try {
    startBrain();
    connect();
    for (const index of initialQueue) queue(index);
    for (const step of steps) {
      if (step.kind === "queue") queue(step.index);
      else if (step.kind === "cancel") {
        const { id } = OWNER_INTENTS[step.index] as Intent;
        unqueue(id);
        controller.cancelManualIntent(id);
        checkSentStates();
      } else if (step.kind === "medium") medium(step.medium);
      else if (step.kind === "backup") await answerBackups(step.saved);
      else if (step.kind === "release") {
        for (let each = 0; each < 3; each += 1) medium(step.medium);
        await answerBackups(step.saved, { all: true });
      } else if (step.kind === "agentRound") {
        const indexOf = (id: string) => OWNER_INTENTS.findIndex((each) => each.id === id);
        agentRound((id) => step.answers[indexOf(id)] ?? "notDone", step);
      } else if (step.kind === "slow") {
        send("slow", slowWith(step.invited));
        checkSentStates();
      } else if (step.kind === "reconnect") {
        connection.dropFromGameSide();
        connect();
      } else {
        connection.dropFromGameSide();
        startBrain();
        connect();
      }
    }
    // A stable game from here: guards holding, backups saved, every intent of the owner's done. The owner's queue
    // drains, at most one irreversible intent (or reset) a round, and each intent left in it is sent on the way.
    const leftToDo = [...ownerQueue];
    for (let round = 0; round < 25 && (ownerQueue.length > 0 || readManualIntents(store).length > 0); round += 1) {
      for (let each = 0; each < 3; each += 1) medium({ factions: [], daemonReady: true });
      await answerBackups(true, { all: true });
      agentRound(() => "done", { inTheSteps: false });
    }
    const stillQueued = [...ownerQueue, ...readManualIntents(store).map((each) => each.id)];
    if (stillQueued.length > 0) violations.push(`the owner's queue never drained: ${stillQueued.join(", ")}`);
    const neverSent = leftToDo.filter((id) => !sentEver.has(id));
    if (neverSent.length > 0) violations.push(`never sent: ${neverSent.join(", ")}`);
    if (aRuleJoinWentOut) reached.runsWithARuleJoinOut += 1;
    return violations;
  } finally {
    store.close();
  }
}

test("the pool has every action an intent can name, so a new action needs a place here", () => {
  expect(new Set(OWNER_INTENTS.map((each) => each.action))).toEqual(new Set(INTENT_ACTIONS));
});

test("resets wait for what's ahead, what's after waits for them; the gate; nothing done again; it drains", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.boolean(),
      anyInitialQueue,
      fc.array(anyStep, { maxLength: 50, size: "medium" }),
      async (rulesOn, initialQueue, steps) => {
        expect(await play(rulesOn, initialQueue, steps)).toEqual([]);
      },
    ),
    // A failure is reported as found: shrinking over fresh stores could run past the test's time limit.
    { numRuns: 100, endOnFailure: true },
  );
  // What the property is there for, reached: resets in the steps, with the brain down across one and the clock set
  // back; a failed backup answering a gate's own request; and runs with a rule's own join out. The seeds aren't
  // fixed, so the floors sit where no seed misses them. Over 40 measured blocks of 100 runs (min to max, mean, sd):
  // resets 17 to 36 (28, 4.9); brain down 10 to 22 (14.6, 3.1); clock set back 6 to 24 (14.7, 4.1); failed backups
  // 41 to 87 (62, 9.4); rule joins out 35 to 56 (45, 4.3). Each floor is 5 sd below its mean, or 1 where that is
  // under 1 (none at all, at a mean of 14, is about e^-14). At 0 the generator no longer gets there.
  expect(reached.resetsInTheSteps).toBeGreaterThanOrEqual(3);
  expect(reached.brainDownAcrossReset).toBeGreaterThanOrEqual(1);
  expect(reached.clockSetBack).toBeGreaterThanOrEqual(1);
  expect(reached.failedBackupsWhileTaking).toBeGreaterThanOrEqual(15);
  expect(reached.runsWithARuleJoinOut).toBeGreaterThanOrEqual(20);
});
