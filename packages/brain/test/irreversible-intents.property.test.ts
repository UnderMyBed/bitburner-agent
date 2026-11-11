// Property test (#269): every irreversible intent the brain sends, whatever made it (the owner's queue, or a rule: the
// brain's join of a city faction, #228), goes out only past the irreversible gate (R8, #147): its guard holding on the
// connected Agent's latest medium snapshot; its own save backup, asked for while it was the gate's first and since the
// Agent connected, answered saved at the moment it goes out, and not older than `RELEASED_SNAPSHOTS` medium snapshots
// while it stays out; and alone. The rules are on, as in a live run, with the hack loop off so intents go without its
// snapshots. The owner may queue an ally of the rule's join (Aevum, Sector-12's group) or an install and cancel it,
// each of which puts an intent ahead of a rule's join already out (#269 review). In some runs the brain installs
// (#210: CyberSec's five queued, no money left) or destroys the BitNode (#215: The Red Pill in, w0r1d_d43m0n rooted at
// its level), so the owner's queuing goes ahead of the brain's own reset, out or not (#271). The gate's example tests
// are desired-state.test.ts's; the reset and done rules over the owner's queue, PR #268's property.
import { ControlChannel } from "@bitburner-agent/bridge";
import { ManualClock, MemoryConnection } from "@bitburner-agent/bridge/test-helpers";
import {
  AUGMENTATION_NAMES,
  augmentationsSoldBy,
  CONTROL_PROTOCOL_VERSION,
  type DesiredState,
  encodeControlMessage,
  FACTION_ENEMIES,
  type Intent,
  type IntentOutcome,
  type IntentRequest,
  intentId,
  isIrreversibleIntent,
  type SnapshotTier,
  WORLD_DAEMON,
} from "@bitburner-agent/core";
import fc from "fast-check";
import { expect, test } from "vitest";
import { DesiredStateController } from "../src/desired-state.ts";
import { RELEASED_SNAPSHOTS } from "../src/irreversible-gate.ts";
import type { SaveBackupEvent } from "../src/save-backups.ts";
import { TelemetryStore } from "../src/telemetry-store.ts";
import { mediumData, slowData, staticServer } from "./helpers/snapshot-fixtures.ts";

const TOKEN = "the-token";
const intentOf = (request: IntentRequest): Intent => ({ ...request, id: intentId(request.action, request.args) });
/** What the owner may queue: an install, enemies' joins and an ally's (Aevum, Sector-12's group), a travel. */
const OWNER_INTENTS: Intent[] = [
  intentOf({ action: "installAugmentations", args: {} }),
  intentOf({ action: "joinFaction", args: { faction: "Chongqing" } }),
  intentOf({ action: "joinFaction", args: { faction: "Sector-12" } }),
  intentOf({ action: "joinFaction", args: { faction: "Aevum" } }),
  intentOf({ action: "travel", args: { city: "Aevum" } }),
];
const OWNER_INTENTS_BY_ID = new Map(OWNER_INTENTS.map((each) => [each.id, each]));
/** Invitations the slow snapshot may carry: city factions of groups A and B, and CyberSec, which has no enemies. */
const INVITABLE = ["Sector-12", "Aevum", "Chongqing", "New Tokyo", "CyberSec"];
/** Factions a medium snapshot may show joined (the owner's doing, or the Agent's). */
const JOINABLE = ["Sector-12", "Aevum", "Chongqing", "Volhaven", "CyberSec"];
const SAVED_BACKUP: SaveBackupEvent = { type: "saveBackup", atMs: 1, file: "saves/E0/x.json.gz", sizeBytes: 10 };
const FAILED_BACKUP: SaveBackupEvent = { type: "saveBackup", atMs: 1, failure: "the game sent its save as text" };
/** The join intent of an id like "joinFaction(Sector-12)". */
const joinOf = (id: string): Intent => intentOf({ action: "joinFaction", args: { faction: id.slice(12, -1) } });
const NETWORK = {
  servers: [
    staticServer("home", { moneyMax: 0 }),
    staticServer("n00dles"),
    staticServer(WORLD_DAEMON, { requiredHackingSkill: 3000, numOpenPortsRequired: 5 }),
  ],
};
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
/** Whether `id` is an install's or a destroy's: the brain's own resets, when not the owner's (#210, #215). */
const isReset = (id: string) => id === "installAugmentations()" || id.startsWith("destroyBitNode(");

const anyFactionsJoined = fc.oneof(
  { arbitrary: fc.constant([] as string[]), weight: 3 },
  { arbitrary: fc.subarray(JOINABLE), weight: 1 },
);
const anyOwnerIntent = fc.nat({ max: OWNER_INTENTS.length - 1 });
/**
 * What happens next: the owner queues or cancels, or queues an install and cancels it at once; a medium snapshot (some
 * factions joined); a slow one (some invitations); a save backup's answer; the three medium snapshots and saved
 * backups a gate needs (`release`, sometimes with the owner queuing meanwhile); the Agent's round, reporting each
 * intent sent done or not; a reconnect.
 */
/**
 * The steps, weighted for a run where the brain resets (`brainResets`) or not. Where it does, the owner's queue is
 * emptied more often (cancels, the Agent's rounds), as the brain's install and destroy go out only behind it, and a
 * travel alone is queued more often then, #271's path.
 */
const stepsFor = (brainResets: boolean) =>
  fc.oneof(
    {
      arbitrary: fc.record({ kind: fc.constant("queue" as const), index: anyOwnerIntent }),
      weight: brainResets ? 1 : 2,
    },
    {
      arbitrary: fc.record({ kind: fc.constant("cancel" as const), index: anyOwnerIntent }),
      weight: brainResets ? 3 : 1,
    },
    { arbitrary: fc.record({ kind: fc.constant("installThenCancel" as const) }), weight: 1 },
    // A reversible intent of the owner's, alone: #271's path, ahead of the brain's own reset out (it has no gate).
    { arbitrary: fc.record({ kind: fc.constant("queueTravel" as const) }), weight: brainResets ? 2 : 1 },
    { arbitrary: fc.record({ kind: fc.constant("medium" as const), factions: anyFactionsJoined }), weight: 3 },
    { arbitrary: fc.record({ kind: fc.constant("slow" as const), invited: fc.subarray(INVITABLE) }), weight: 2 },
    { arbitrary: fc.record({ kind: fc.constant("backup" as const), saved: fc.boolean() }), weight: 2 },
    {
      arbitrary: fc.record({
        kind: fc.constant("release" as const),
        factions: anyFactionsJoined,
        queuedMeanwhile: fc.option(anyOwnerIntent, { freq: 3 }),
      }),
      weight: 3,
    },
    {
      arbitrary: fc.record({
        kind: fc.constant("agentRound" as const),
        done: fc.array(fc.boolean(), { maxLength: 8 }),
      }),
      weight: brainResets ? 4 : 2,
    },
    { arbitrary: fc.record({ kind: fc.constant("reconnect" as const) }), weight: 1 },
  );
const anyStep = stepsFor(false);
type Step = typeof anyStep extends fc.Arbitrary<infer Each> ? Each : never;

/** Across the runs, so the property is seen to reach what it's for. */
const reached = {
  runsWithARuleJoinOut: 0,
  ruleJoinsOutWhenTheOwnerWentAhead: 0,
  runsWithTheBrainsInstallOut: 0,
  runsWithTheBrainsDestroyOut: 0,
  reversibleAheadOfTheBrainsInstallOut: 0,
  reversibleAheadOfTheBrainsDestroyOut: 0,
};

/** A brain with every rule on, an Agent connected, the steps played: what each desired state sent breaks of R8. */
async function play(brainsReset: "none" | "install" | "destroy", steps: Step[]): Promise<string[]> {
  // In memory (#279): a store on disk cost each run about 14 ms to create and each snapshot a write synced to disk, two
  // thirds of the floor test's 15 s locally; it timed out at 30 s on a slow CI runner (run 42345801314), and the file
  // took up to 27 s on others. Each run starts from an empty store either way, and nothing here reads one back after
  // the run, so the runs and their counts are the same.
  const store = TelemetryStore.open(":memory:");
  store.setSetting("hackLoop.enabled", "false");
  const channel = new ControlChannel({ token: TOKEN, clock: new ManualClock() });
  channel.setDeploymentState({ deployedId: "deployment-a", hold: false, deployFailed: false });
  /**
   * Each backup asked for: the connection it was asked on, and the intent it was for (the first irreversible one the
   * gates judge then: the owner's in the order queued, then the rules').
   */
  const pendingBackups: {
    answer: (event: SaveBackupEvent) => void;
    askedOn: number;
    forId: string | null;
    /** Still its intent's: false once another went ahead of it (its gate started again), or it left the head. */
    current: boolean;
  }[] = [];
  const backupNow = () =>
    new Promise<SaveBackupEvent>((answer) => {
      pendingBackups.push({ answer, askedOn: connectionNumber, forId: firstJudged(), current: true });
    });
  const controller = new DesiredStateController({ channel, store, saveBackups: { backupNow } });
  /** The owner's queue as the owner made it, by id. */
  const ownerQueue: string[] = [];
  const everQueuedByOwner = new Set<string>();
  /** The first irreversible intent the gates judge: the owner's first, then the rules' (their view's order). */
  const firstJudged = (): string | null => {
    const owners = ownerQueue.filter((id) => isIrreversibleIntent(OWNER_INTENTS_BY_ID.get(id) as Intent));
    const rules = controller
      .intentsView()
      .filter((view) => view.source !== "manual")
      .map((view) => view.id)
      .filter((id) => id.startsWith("joinFaction(") && isIrreversibleIntent(joinOf(id)));
    return owners[0] ?? brainsResets()[0] ?? rules[0] ?? null;
  };
  /** The brain's own resets in its view, in order (its destroy, then its install). */
  const brainsResets = (): string[] =>
    controller
      .intentsView()
      .filter((view) => view.source !== "manual" && isReset(view.id))
      .map((view) => view.id);
  /** The game's time, 10 s a medium snapshot on, so an install's countdown runs out (#222). */
  let gameTimeMs = 1_000;
  let theBrainsInstallWentOut = false;
  let theBrainsDestroyWentOut = false;
  /** Medium snapshots seen this run, and when (by that count) each irreversible intent out went out. */
  let mediumsSeen = 0;
  const wentOutAt = new Map<string, number>();
  let aRuleJoinWentOut = false;
  const violations: string[] = [];
  let connection = new MemoryConnection();
  let connectionNumber = 0;
  let sequenceNumber = 0;
  let statesChecked = 0;
  /** The irreversible intents in the last desired state checked on this connection. */
  let irreversibleSentBefore = new Set<string>();
  /** The factions joined in the latest medium snapshot since the Agent connected, or null before one. */
  let latestMediumFactions: string[] | null = null;

  const send = (tier: SnapshotTier, data: unknown) =>
    connection.receive(
      encodeControlMessage({
        protocolVersion: CONTROL_PROTOCOL_VERSION,
        type: "snapshot",
        agentSessionId: `session-${connectionNumber}`,
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
  /** Why `irreversible`'s guard fails on the latest medium snapshot, the owner's queue as it is, or null. */
  const guardFailure = (irreversible: Intent): string | null => {
    if (latestMediumFactions === null) return "no medium snapshot since the Agent connected";
    if (irreversible.action === "joinFaction") {
      const enemy = (FACTION_ENEMIES[irreversible.args.faction] ?? []).find((each) =>
        latestMediumFactions?.includes(each),
      );
      return enemy === undefined ? null : `its enemy ${enemy} is joined`;
    }
    // A reset, the owner's or the brain's: what's ahead of it in the queue (the owner's first) done.
    const ahead = [...ownerQueue, ...brainsResets()].find((id) => id !== irreversible.id);
    const first = [...ownerQueue, ...brainsResets()][0];
    return first === irreversible.id ? null : `${ahead}, queued before it, isn't done`;
  };
  /**
   * Checks what was sent since the last check. `savedFor`: the intent whose own backup, asked on this connection, this
   * action answered saved: the only one that may go out on it.
   */
  const checkDesiredStates = (savedFor: string | null = null) => {
    const states = desiredStatesSent();
    for (const state of states.slice(statesChecked)) {
      const irreversible = state.intents.filter(isIrreversibleIntent);
      if (irreversible.length > 1) {
        violations.push(`irreversible intents sent together: ${irreversible.map((each) => each.id).join(", ")}`);
      }
      for (const each of irreversible) {
        const failure = guardFailure(each);
        if (failure !== null) violations.push(`${each.id} sent, its guard failing: ${failure}`);
        // Going out now: only on its own backup, answered saved by this action.
        if (!irreversibleSentBefore.has(each.id)) {
          if (savedFor !== each.id) violations.push(`${each.id} went out with no backup of its own answered saved`);
          wentOutAt.set(each.id, mediumsSeen);
        }
        // Out, its backup never older than the gate allows: withdrawn after `RELEASED_SNAPSHOTS` medium snapshots. The
        // steps rarely get that far: desired-state.test.ts's "out for 60 medium snapshots and not done" pins it.
        const outFor = mediumsSeen - (wentOutAt.get(each.id) ?? mediumsSeen);
        if (outFor >= RELEASED_SNAPSHOTS) violations.push(`${each.id} still out ${outFor} medium snapshots on`);
        // A rule's own join out, past its own gate: one the owner never queued (an owner's gate passes to a rule's id).
        if (!everQueuedByOwner.has(each.id) && each.action === "joinFaction") aRuleJoinWentOut = true;
        if (!ownerQueue.includes(each.id) && each.action === "installAugmentations") theBrainsInstallWentOut = true;
        if (!ownerQueue.includes(each.id) && each.action === "destroyBitNode") theBrainsDestroyWentOut = true;
      }
      irreversibleSentBefore = new Set(irreversible.map((each) => each.id));
    }
    statesChecked = states.length;
    // A backup is its intent's only while that stays the gates' first: pushed back, its gate counts again.
    const first = firstJudged();
    for (const pending of pendingBackups) if (pending.forId !== first) pending.current = false;
    // A reset with anything queued ahead of it (a reversible intent too, which has no gate): its gate counts again.
    if (first !== null && isReset(first) && [...ownerQueue, ...brainsResets()][0] !== first) {
      for (const pending of pendingBackups) if (pending.forId === first) pending.current = false;
    }
  };
  const invitedTo = (invited: string[]) => {
    const data = slowData();
    if (brainsReset === "destroy") data.resetInfo = { ...data.resetInfo, ownedAugs: { "The Red Pill": 1 } };
    const installs = brainsReset === "install";
    if (installs) data.resetInfo = { ...data.resetInfo, ownedAugs: TWENTY_FIVE_INSTALLED };
    data.factions = {
      backend: "sim",
      state: {
        joined: installs ? [{ name: "CyberSec", reputation: 18_750, favor: 0 }] : [],
        invitations: invited,
        queuedAugmentations: installs ? CYBERSEC_FIVE : [],
      },
      problem: null,
    };
    return data;
  };
  const medium = (factions: string[]) => {
    latestMediumFactions = factions;
    mediumsSeen += 1;
    gameTimeMs += 10_000;
    // The brain's install: CyberSec joined, no money left. Its destroy: w0r1d_d43m0n rooted, at its level.
    const installs = brainsReset === "install";
    const hacking = brainsReset === "destroy" ? 3000 : installs ? 300 : 100;
    const joined = installs ? [...new Set([...factions, "CyberSec"])] : factions;
    const player = {
      money: installs ? 0 : 1e9,
      city: "Sector-12",
      hasTorRouter: true,
      homeRam: 2 ** 20,
      factions: joined,
    };
    const data = mediumData(hacking, { [WORLD_DAEMON]: true }, player);
    data.player = {
      ...data.player,
      skills: { hacking, strength: 1, defense: 1, dexterity: 1, agility: 1, charisma: 1, intelligence: 0 },
      exp: { hacking: 6_106_794 },
      mults: { faction_rep: 1, hacking: 1 },
    };
    send("medium", data);
    checkDesiredStates();
  };
  const connect = () => {
    connection = new MemoryConnection();
    connectionNumber += 1;
    statesChecked = 0;
    irreversibleSentBefore = new Set();
    latestMediumFactions = null;
    channel.accept(connection);
    connection.receive(
      encodeControlMessage({
        protocolVersion: CONTROL_PROTOCOL_VERSION,
        type: "hello",
        token: TOKEN,
        deploymentId: "deployment-a",
        agentSessionId: `session-${connectionNumber}`,
        game: { version: "3.0.1", versionNumber: 51, commit: "3162fd2", platform: "Steam" },
      }),
    );
    send("static", NETWORK);
    send("slow", invitedTo(["Sector-12"]));
    checkDesiredStates();
  };
  /** Answers the oldest backup asked for (`all`: every one), then lets the controller see it. */
  const answerBackups = async (saved: boolean, { all = false } = {}) => {
    for (const { answer, askedOn, forId, current } of pendingBackups.splice(0, all ? pendingBackups.length : 1)) {
      answer(saved ? SAVED_BACKUP : FAILED_BACKUP);
      await new Promise((resolve) => setImmediate(resolve));
      checkDesiredStates(saved && current && askedOn === connectionNumber ? forId : null);
    }
    checkDesiredStates();
  };

  /** The owner queues `OWNER_INTENTS[index]` (an irreversible one goes ahead of a rule's join out), or cancels it. */
  const queue = (index: number) => {
    const { id, ...request } = OWNER_INTENTS[index] as Intent;
    if (!ownerQueue.includes(id)) ownerQueue.push(id);
    everQueuedByOwner.add(id);
    // #271's path: a reversible intent of the owner's, which has no gate, ahead of the brain's own install or destroy.
    if (!isIrreversibleIntent(OWNER_INTENTS[index] as Intent)) {
      for (const out of irreversibleSentBefore) {
        if (ownerQueue.includes(out) && out !== id) continue;
        if (out === "installAugmentations()") reached.reversibleAheadOfTheBrainsInstallOut += 1;
        if (out.startsWith("destroyBitNode(")) reached.reversibleAheadOfTheBrainsDestroyOut += 1;
      }
    }
    // #270's: an irreversible one ahead of a rule's join out.
    if (isIrreversibleIntent(OWNER_INTENTS[index] as Intent)) {
      for (const out of irreversibleSentBefore) {
        if (!everQueuedByOwner.has(out) && out.startsWith("joinFaction(")) {
          reached.ruleJoinsOutWhenTheOwnerWentAhead += 1;
        }
      }
    }
    controller.addManualIntent(request as IntentRequest);
    checkDesiredStates();
  };
  const cancel = (index: number) => {
    const { id } = OWNER_INTENTS[index] as Intent;
    if (ownerQueue.includes(id)) ownerQueue.splice(ownerQueue.indexOf(id), 1);
    controller.cancelManualIntent(id);
    checkDesiredStates();
  };

  try {
    connect();
    for (const step of steps) {
      if (step.kind === "queue") queue(step.index);
      else if (step.kind === "cancel") cancel(step.index);
      else if (step.kind === "queueTravel") queue(OWNER_INTENTS.findIndex((each) => each.action === "travel"));
      else if (step.kind === "installThenCancel") {
        queue(0);
        cancel(0);
      } else if (step.kind === "medium") medium(step.factions);
      else if (step.kind === "slow") {
        send("slow", invitedTo(step.invited));
        checkDesiredStates();
      } else if (step.kind === "backup") await answerBackups(step.saved);
      else if (step.kind === "release") {
        for (let each = 0; each < 3; each += 1) medium(step.factions);
        // Sometimes the owner queues one while the backup is taken: an irreversible one pushes that gate back.
        if (step.queuedMeanwhile !== null) queue(step.queuedMeanwhile);
        await answerBackups(true, { all: true });
      } else if (step.kind === "agentRound") {
        const sent = desiredStatesSent().at(-1)?.intents ?? [];
        const outcomes: IntentOutcome[] = sent.map((each, index) => {
          // The brain's own reset is never reported done here: done, it resets the game, which this property leaves to
          // #179's (desired-state.property.test.ts); reported done without one, the brain calls its cycle off.
          const done = (step.done[index] ?? false) && !(isReset(each.id) && !ownerQueue.includes(each.id));
          if (done && ownerQueue.includes(each.id)) ownerQueue.splice(ownerQueue.indexOf(each.id), 1);
          return { id: each.id, done, tries: 1, problem: done ? null : "not yet", backend: "sim" };
        });
        send("fast", { degradedTiers: [], pageHeapUsedBytes: null, game: null, intents: outcomes });
        checkDesiredStates();
      } else {
        connection.dropFromGameSide();
        connect();
      }
    }
    if (aRuleJoinWentOut) reached.runsWithARuleJoinOut += 1;
    if (theBrainsInstallWentOut) reached.runsWithTheBrainsInstallOut += 1;
    if (theBrainsDestroyWentOut) reached.runsWithTheBrainsDestroyOut += 1;
    return violations;
  } finally {
    store.close();
  }
}

/**
 * How long a random property may run, shrinking a failure included, before it stops and reports the smallest failing
 * run found so far: two thirds of the test's 30 s timeout. A passing property takes about 1 s.
 */
const SHRINK_TIME_LIMIT_MS = 20_000;

/** A run: the brain's own reset in it, if any (#271), and the steps. */
const anyRun = fc
  .oneof(
    { arbitrary: fc.constant("none" as const), weight: 2 },
    // The brain's install the rarest to get out (its countdown, then the owner's queue empty), so the most often tried.
    { arbitrary: fc.constant("install" as const), weight: 2 },
    { arbitrary: fc.constant("destroy" as const), weight: 1 },
  )
  .chain((brainsReset) =>
    fc.tuple(
      fc.constant(brainsReset),
      fc.array(stepsFor(brainsReset !== "none"), {
        // Longer where the brain resets: its install's countdown and gate take a while before #271's path opens.
        maxLength: brainsReset === "none" ? 40 : 80,
        size: brainsReset === "none" ? "medium" : "large",
      }),
    ),
  );

test("every irreversible intent sent, the owner's or a rule's: past its guard, its own backup, and alone", async () => {
  // A failure is shrunk (a run takes a few ms on a store in memory, #279), until `SHRINK_TIME_LIMIT_MS`: past it, the
  // smallest found so far is reported, within the test's timeout.
  await fc.assert(
    fc.asyncProperty(anyRun, async ([brainsReset, steps]) => {
      expect(await play(brainsReset, steps)).toEqual([]);
    }),
    { numRuns: 100, interruptAfterTimeLimit: SHRINK_TIME_LIMIT_MS },
  );
});

test("the runs reach what it's for: rules' joins and the brain's resets out, the owner queuing ahead", async () => {
  // A fixed seed, so these floors can't miss on a random one: over 10 measured blocks of 100 random runs, #271's path
  // (a travel queued ahead of the brain's install out) came 0 to 6 times, its destroy's 0 to 4, and the brain's
  // install was out in 4 to 9 runs. The property above draws fresh runs each time.
  for (const key of Object.keys(reached)) (reached as Record<string, number>)[key] = 0;
  await fc.assert(
    fc.asyncProperty(anyRun, async ([brainsReset, steps]) => {
      expect(await play(brainsReset, steps)).toEqual([]);
    }),
    { numRuns: 300, seed: 271, endOnFailure: true },
  );
  // On seed 271's 300 runs (#343's, re-measured; main a3b75cc's in brackets): a rule's own join out in 28 runs, the
  // owner going ahead of one 16 times; the brain's install out in 26 [12] runs and its destroy in 21; a travel queued
  // ahead of the install out 11 [7] times, of the destroy 11.
  // Each floor about half that: below it, the generator no longer gets there, or a gate seldom lets it out.
  const floors: Record<keyof typeof reached, number> = {
    runsWithARuleJoinOut: 14,
    ruleJoinsOutWhenTheOwnerWentAhead: 8,
    runsWithTheBrainsInstallOut: 6,
    runsWithTheBrainsDestroyOut: 10,
    reversibleAheadOfTheBrainsInstallOut: 3,
    reversibleAheadOfTheBrainsDestroyOut: 5,
  };
  for (const [key, floor] of Object.entries(floors)) {
    expect([key, reached[key as keyof typeof reached] >= floor]).toEqual([key, true]);
  }
});
