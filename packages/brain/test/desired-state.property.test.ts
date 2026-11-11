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
import { ControlChannel } from "@bitburner-agent/bridge";
import { ManualClock, MemoryConnection } from "@bitburner-agent/bridge/test-helpers";
import {
  AUGMENTATION_NAMES,
  augmentationsSoldBy,
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
import { expect, test } from "vitest";
import { DesiredStateController } from "../src/desired-state.ts";
import { readManualIntents } from "../src/manual-intents.ts";
import type { SaveBackupEvent } from "../src/save-backups.ts";
import { TelemetryStore } from "../src/telemetry-store.ts";
import { mediumData, slowData, staticServer } from "./helpers/snapshot-fixtures.ts";

const TOKEN = "the-token";
/** R8's two consecutive medium snapshots with the guard holding before a backup is asked for (written out here). */
const HELD_BEFORE_A_BACKUP = 2;
/** CyberSec's five, queued in a run where the brain installs (#210): all bought, no money left, so it installs. */
const CYBERSEC_FIVE = [
  "Cranial Signal Processors - Gen I",
  "Cranial Signal Processors - Gen II",
  "BitWire",
  "Synaptic Enhancement Implant",
  "Neurotrainer I",
];
/**
 * Installed in a run where the brain installs (#343): 25 that CyberSec doesn't sell, so CyberSec's five make Daedalus's
 * 30 and the planner installs at once, whatever the income. Short of the count by less, it holds installing now until
 * 10 minutes of slow snapshots measure the income, which a run's few minutes of the game's time never reach.
 */
const TWENTY_FIVE_INSTALLED: Record<string, number> = Object.fromEntries(
  AUGMENTATION_NAMES.filter(
    (name) =>
      !augmentationsSoldBy("CyberSec", 1, null).includes(name) &&
      name !== "NeuroFlux Governor" &&
      name !== "The Red Pill",
  )
    .slice(0, 25)
    .map((name) => [name, 1]),
);
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
  // Forming a gang (#325): irreversible, its guard NiteSec joined.
  intentOf({ action: "createGang", args: { faction: "NiteSec" } }),
];
const OWNER_INTENTS_BY_ID = new Map(OWNER_INTENTS.map((each) => [each.id, each]));
/** Whether `id` is an install's or a destroy's: the brain's own resets, when not the owner's (#210, #215). */
const isBrainsReset = (id: string) => id === "installAugmentations()" || id.startsWith("destroyBitNode(");
const JOINABLE = ["Sector-12", "Chongqing", "Aevum", "CyberSec", "NiteSec"];
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
/**
 * The steps, weighted for a run where the brain resets (`brainResets`, #210, #215) or not. Where it does, the owner's
 * queue is emptied more often (cancels, the Agent's rounds), as the brain's install and destroy go out only behind it.
 */
const stepsFor = (brainResets: boolean) =>
  fc.oneof(
    { arbitrary: fc.record({ kind: fc.constant("queue" as const), index: anyIndex }), weight: brainResets ? 1 : 2 },
    { arbitrary: fc.record({ kind: fc.constant("cancel" as const), index: anyIndex }), weight: brainResets ? 2 : 1 },
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
        rulesDone: fc.boolean(),
        brainDownAcrossReset: fc.boolean(),
        clockSetBack: fc.boolean(),
      }),
      weight: brainResets ? 5 : 4,
    },
    { arbitrary: fc.record({ kind: fc.constant("slow" as const), invited: fc.subarray(INVITABLE) }), weight: 1 },
    { arbitrary: fc.record({ kind: fc.constant("reconnect" as const) }), weight: 1 },
    { arbitrary: fc.record({ kind: fc.constant("restart" as const) }), weight: 1 },
  );
const anyStep = stepsFor(false);
type Step = typeof anyStep extends fc.Arbitrary<infer Each> ? Each : never;

/** Across the runs, so the property is seen to reach what it checks. */
const reached = {
  resetsInTheSteps: 0,
  brainDownAcrossReset: 0,
  clockSetBack: 0,
  destroysInTheSteps: 0,
  brainDownAcrossDestroy: 0,
  failedBackupsWhileTaking: 0,
  runsWithARuleJoinOut: 0,
  runsWithTheBrainsInstallOut: 0,
  runsWithTheBrainsDestroyOut: 0,
};

/**
 * A brain on a fresh store, an Agent connected to it, the steps played, then a stable game until the owner's queue
 * drains: what each desired state sent breaks of the rules, checked against the queue as the owner made it (the order
 * queued), not the brain's own.
 */
async function play(
  rulesOn: boolean,
  brainsReset: "none" | "install" | "destroy",
  initialQueue: number[],
  steps: Step[],
): Promise<string[]> {
  // In memory (#279): a store on disk cost each run about 14 ms to create and each snapshot a write synced to disk, most
  // of the runs' time. A brain started again in a run takes the same store object, as a restart reads the same file.
  const store = TelemetryStore.open(":memory:");
  store.setSetting("hackLoop.enabled", "false");
  if (!rulesOn) for (const setting of RULE_SWITCHES) store.setSetting(setting, "false");
  /** The game's last resets, as its slow snapshot says. */
  const gameResets = { lastAugReset: 1_000_000, lastNodeReset: 1_000_000 };
  /**
   * The stand-in game, for the brain's own resets (rules on): CyberSec's five queued, which the brain installs (#210),
   * until an install; The Red Pill installed, so the brain destroys the BitNode (#215), until a destroy. Its time moves
   * 10 s a medium snapshot, so the install's countdown runs out.
   */
  const standInGame = {
    augmentationsQueued: rulesOn && brainsReset === "install",
    redPill: rulesOn && brainsReset === "destroy",
    timeMs: 1_000,
  };
  /** The brain's own resets done (by the reset), never asked for again: their reasons went with the reset. */
  const brainsResetsDone = new Set<string>();
  let theBrainsInstallWentOut = false;
  let theBrainsDestroyWentOut = false;
  /** The first irreversible intent the gates judge, and the medium snapshots its guard has held on since. */
  let heldFor: string | null = null;
  let heldSnapshots = 0;
  /** The owner's queue, by id, in the order queued; and the owner's intents done (reported, or reset) since. */
  const ownerQueue: string[] = [];
  const unqueue = (id: string) => {
    if (ownerQueue.includes(id)) ownerQueue.splice(ownerQueue.indexOf(id), 1);
  };
  const ownersDone = new Set<string>();
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
  /** The brain's own resets in its view, in order (its destroy, then its install). */
  const brainsResets = (): string[] =>
    controller
      .intentsView()
      .filter((view) => view.source !== "manual" && isBrainsReset(view.id))
      .map((view) => view.id);
  /**
   * The first irreversible intent the gates judge: the owner's first (in the order queued), then the brain's resets,
   * then the rules' (in their view's order).
   */
  const firstJudged = (): string | null => {
    const owners = ownerQueue.filter((id) => isIrreversibleIntent(OWNER_INTENTS_BY_ID.get(id) as Intent));
    const rules = controller
      .intentsView()
      .filter((view) => view.source !== "manual" && view.id.startsWith("joinFaction("))
      .map((view) => view.id)
      .filter((id) => isIrreversibleIntent(intentOf({ action: "joinFaction", args: { faction: id.slice(12, -1) } })));
    return owners[0] ?? brainsResets()[0] ?? rules[0] ?? null;
  };
  /** Whether `id`'s guard holds on `snapshot`: a join's enemies; a reset first (what's before it done); w0r1d_d43m0n. */
  const guardHolds = (id: string, snapshot: Medium): boolean => {
    if (id.startsWith("joinFaction(")) {
      return !(FACTION_ENEMIES[id.slice(12, -1)] ?? []).some((enemy) => snapshot.factions.includes(enemy));
    }
    if (id.startsWith("createGang(")) return snapshot.factions.includes(id.slice(11, -1));
    if ([...ownerQueue, ...brainsResets()][0] !== id) return false;
    return !id.startsWith("destroyBitNode(") || snapshot.daemonReady;
  };

  const send = (tier: SnapshotTier, data: unknown, gameTimeMs = standInGame.timeMs) =>
    connection.receive(
      encodeControlMessage({
        protocolVersion: CONTROL_PROTOCOL_VERSION,
        type: "snapshot",
        agentSessionId: `session-${sessionNumber}`,
        tier,
        sequenceNumber: ++sequenceNumber,
        gameTimeMs,
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
    if (irreversible.action === "createGang" && !latestMedium.factions.includes(irreversible.args.faction)) {
      return `${irreversible.args.faction} isn't joined`;
    }
    return null;
  };
  /**
   * Checks what was sent since the last check. `savedFor`: the intent whose own backup, asked this session and still
   * its own, this action answered saved: the only one that may go out on it.
   */
  const checkSentStates = (savedFor: string | null = null) => {
    const states = desiredStatesSent();
    const sources = new Map(controller.intentsView().map((view) => [view.id, view.source]));
    for (const desiredState of states.slice(statesChecked)) {
      const ids = desiredState.intents.map((each) => each.id);
      const resetAt = ownerQueue.findIndex((id) => resetsTheGame(OWNER_INTENTS_BY_ID.get(id) as Intent));
      const irreversible = desiredState.intents.filter(isIrreversibleIntent);
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
        if (!everQueuedByOwner.has(each.id) && each.action === "joinFaction") aRuleJoinWentOut = true;
        // The brain's own reset: sent only with nothing of the owner's before it, and never again once done.
        if (sources.get(each.id) !== "manual" && isBrainsReset(each.id)) {
          if (each.action === "installAugmentations") theBrainsInstallWentOut = true;
          else theBrainsDestroyWentOut = true;
          if (ownerQueue.length > 0) violations.push(`the brain's ${each.id} sent with the owner's queue undone`);
          if (brainsResetsDone.has(each.id)) violations.push(`the brain's ${each.id} sent again after its reset`);
        }
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
    if (heldFor !== first) {
      heldFor = first;
      heldSnapshots = 0;
    }
  };
  const slowWith = (invited: string[]) => {
    const data = slowData();
    const brainInstalls = brainsReset === "install" && rulesOn;
    data.resetInfo = {
      ...data.resetInfo,
      ...gameResets,
      ...(standInGame.redPill ? { ownedAugs: { "The Red Pill": 1 } } : {}),
      ...(brainInstalls ? { ownedAugs: TWENTY_FIVE_INSTALLED } : {}),
    };
    data.factions = {
      backend: "sim",
      state: {
        joined: brainInstalls ? [{ name: "CyberSec", reputation: 18_750, favor: 0 }] : [],
        invitations: invited,
        queuedAugmentations: standInGame.augmentationsQueued ? CYBERSEC_FIVE : [],
      },
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
    heldSnapshots = 0;
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
    heldFor = null;
    heldSnapshots = 0;
    const backupNow = () =>
      new Promise<SaveBackupEvent>((answer) => {
        const forId = firstJudged();
        // Asked only once its guard has held on two consecutive medium snapshots (R8), counted by the model.
        if (heldFor !== forId || heldSnapshots < HELD_BEFORE_A_BACKUP) {
          violations.push(`a backup asked for ${forId} after ${heldSnapshots} medium snapshots with its guard holding`);
        }
        heldSnapshots = 0;
        pendingBackups.push({ answer, askedInSession: sessionNumber, forId, current: true });
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
    // The gates' first: its guard counted on this snapshot, or, failing, its count and its backup asked for gone.
    const first = firstJudged();
    if (first !== heldFor) {
      heldFor = first;
      heldSnapshots = 0;
    }
    if (first !== null && guardHolds(first, snapshot)) heldSnapshots += 1;
    else if (first !== null) {
      heldSnapshots = 0;
      for (const pending of pendingBackups) if (pending.forId === first) pending.current = false;
    }
    const hacking = snapshot.daemonReady ? 3000 : 100;
    const brainInstalls = brainsReset === "install" && rulesOn;
    // A run where the brain installs: CyberSec joined, all bought, no money left (#210's example).
    const factions = brainInstalls ? [...new Set([...snapshot.factions, "CyberSec"])] : snapshot.factions;
    const player = {
      money: brainInstalls ? 0 : 1e9,
      city: "Sector-12",
      hasTorRouter: true,
      homeRam: 2 ** 20,
      factions,
    };
    const data = mediumData(hacking, { [WORLD_DAEMON]: true }, player);
    data.player = {
      ...data.player,
      skills: { hacking, strength: 1, defense: 1, dexterity: 1, agility: 1, charisma: 1, intelligence: 0 },
      exp: { hacking: 6_106_794 },
      mults: { faction_rep: 1, hacking: 1 },
    };
    standInGame.timeMs += 10_000;
    send("medium", data, standInGame.timeMs);
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
      // Failed, its gate counts again from none.
      if (!saved && itsOwn) heldSnapshots = 0;
      answer(saved ? SAVED_BACKUP : FAILED_BACKUP);
      await new Promise((resolve) => setImmediate(resolve));
      checkSentStates(saved && itsOwn ? forId : null);
    }
  };
  /** The Agent's round: each intent sent done or not, in order; a reset intent done resets the game. */
  const agentRound = (
    answerOf: (id: string) => string,
    { rulesDone = false, brainDownAcrossReset = false, clockSetBack = false, inTheSteps = true } = {},
  ) => {
    const sent = desiredStatesSent().at(-1)?.intents ?? [];
    const sources = new Map(controller.intentsView().map((view) => [view.id, view.source]));
    const outcomes: IntentOutcome[] = [];
    let reset: Intent | null = null;
    for (const each of sent) {
      const owners = ownerQueue.includes(each.id) || sources.get(each.id) === "manual";
      const answer = owners ? answerOf(each.id) : rulesDone ? "done" : "notDone";
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
    // An install installs what's queued; a destroy enters the next BitNode, The Red Pill gone with the rest.
    standInGame.augmentationsQueued = false;
    if (reset.action === "destroyBitNode") standInGame.redPill = false;
    if (inTheSteps) {
      reached.resetsInTheSteps += 1;
      if (brainDownAcrossReset) reached.brainDownAcrossReset += 1;
      if (clockSetBack) reached.clockSetBack += 1;
      if (reset.action === "destroyBitNode") reached.destroysInTheSteps += 1;
      // README's case: a brain down while its destroy resets the game must not destroy the next BitNode too.
      if (reset.action === "destroyBitNode" && brainDownAcrossReset) reached.brainDownAcrossDestroy += 1;
    }
    // Done by the reset: what was queued after it may go now; it, never again (the owner's, or the brain's).
    if (ownerQueue.includes(reset.id)) ownersDone.add(reset.id);
    else brainsResetsDone.add(reset.id);
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
    // drains, at most one irreversible intent (or reset) a round.
    for (let round = 0; round < 25 && (ownerQueue.length > 0 || readManualIntents(store).length > 0); round += 1) {
      // NiteSec joined, for the gang's guard (#325): it has no enemies, so no join's guard fails on it.
      for (let each = 0; each < 3; each += 1) medium({ factions: ["NiteSec"], daemonReady: true });
      await answerBackups(true, { all: true });
      agentRound(() => "done", { inTheSteps: false });
    }
    const stillQueued = [...ownerQueue, ...readManualIntents(store).map((each) => each.id)];
    if (stillQueued.length > 0) violations.push(`the owner's queue never drained: ${stillQueued.join(", ")}`);
    if (aRuleJoinWentOut) reached.runsWithARuleJoinOut += 1;
    if (theBrainsInstallWentOut) reached.runsWithTheBrainsInstallOut += 1;
    if (theBrainsDestroyWentOut) reached.runsWithTheBrainsDestroyOut += 1;
    return violations;
  } finally {
    store.close();
  }
}

test("the pool has every action the owner can queue, so a new action needs a place here (closeGame is the switch's, #303)", () => {
  expect(new Set(OWNER_INTENTS.map((each) => each.action))).toEqual(
    new Set(INTENT_ACTIONS.filter((action) => action !== "closeGame")),
  );
});

/**
 * A run: the rules off or on; the brain's own reset, with them on (#210, #215), the rarest to get out so the most often
 * tried, from an empty queue (the owner's queue holds it back); the owner's queue to start with; the steps.
 */
const anyRun = fc
  .oneof(
    { arbitrary: fc.constant({ rulesOn: false, brainsReset: "none" as const }), weight: 2 },
    { arbitrary: fc.constant({ rulesOn: true, brainsReset: "none" as const }), weight: 1 },
    { arbitrary: fc.constant({ rulesOn: true, brainsReset: "install" as const }), weight: 2 },
    { arbitrary: fc.constant({ rulesOn: true, brainsReset: "destroy" as const }), weight: 1 },
  )
  .chain(({ rulesOn, brainsReset }) =>
    fc.tuple(
      fc.constant(rulesOn),
      fc.constant(brainsReset),
      brainsReset === "none" ? anyInitialQueue : fc.constant([] as number[]),
      fc.array(stepsFor(brainsReset !== "none"), { maxLength: 50, size: "medium" }),
    ),
  );
/**
 * How long the random property may run, shrinking a failure included, before it stops and reports the smallest failing
 * run found so far: two thirds of the test's 30 s timeout. A passing property takes under 1 s.
 */
const SHRINK_TIME_LIMIT_MS = 20_000;
const playRun = async ([rulesOn, brainsReset, initialQueue, steps]: typeof anyRun extends fc.Arbitrary<infer Run>
  ? Run
  : never) => {
  expect(await play(rulesOn, brainsReset, initialQueue, steps)).toEqual([]);
};

test("resets wait for what's ahead, what's after waits for them; the gate; nothing done again; it drains", async () => {
  // A failure is shrunk (a run takes a few ms on a store in memory, #279), until `SHRINK_TIME_LIMIT_MS`: past it, the
  // smallest found so far is reported, within the test's timeout.
  await fc.assert(fc.asyncProperty(anyRun, playRun), { numRuns: 60, interruptAfterTimeLimit: SHRINK_TIME_LIMIT_MS });
});

test("the runs reach what the property is for: resets, the brain down and the clock back, failed backups, joins", async () => {
  // A fixed seed, so these floors can't miss on a random one: the rarer counts, a destroy with the brain down across
  // it say, could be 0 in a block of random runs. The property above draws fresh runs each time.
  for (const key of Object.keys(reached)) (reached as Record<string, number>)[key] = 0;
  await fc.assert(fc.asyncProperty(anyRun, playRun), { numRuns: 100, seed: 179, endOnFailure: true });
  // On seed 179's 100 runs (#343's, re-measured; main a3b75cc's in brackets): 28 [27] resets in the steps (9 destroys),
  // the brain down across 16 [14] (6 destroys), the clock set back across 14 [15]; 51 [45] failed backups that were a
  // gate's own; a rule's own join out in 17 runs, the brain's install in 27 [24] and its destroy in 10. Each floor about
  // half that: below it, the generator no longer gets there, or a gate seldom lets it out.
  const floors: Record<keyof typeof reached, number> = {
    resetsInTheSteps: 14,
    brainDownAcrossReset: 7,
    clockSetBack: 8,
    destroysInTheSteps: 7,
    brainDownAcrossDestroy: 4,
    failedBackupsWhileTaking: 24,
    runsWithARuleJoinOut: 11,
    runsWithTheBrainsInstallOut: 12,
    runsWithTheBrainsDestroyOut: 6,
  };
  for (const [key, floor] of Object.entries(floors)) {
    expect([key, reached[key as keyof typeof reached] >= floor]).toEqual([key, true]);
  }
});
