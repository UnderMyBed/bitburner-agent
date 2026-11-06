// Property test (#269): every irreversible intent the brain sends, whatever made it (the owner's queue, or a rule: the
// brain's join of a city faction, #228), goes out only past the irreversible gate (R8, #147): its guard holding on the
// connected Agent's latest medium snapshot; its own save backup, asked for while it was the gate's first and since the
// Agent connected, answered saved at the moment it goes out, and not older than `RELEASED_SNAPSHOTS` medium snapshots
// while it stays out; and alone. The rules are on, as in a live run, with the hack loop off so intents go without its
// snapshots. The owner may queue an ally of the rule's join (Aevum, Sector-12's group) or an install and cancel it,
// each of which puts an intent ahead of a rule's join already out (#269 review). The gate's example tests are
// desired-state.test.ts's; the reset and done rules over the owner's queue, PR #268's property.
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
  type Intent,
  type IntentOutcome,
  type IntentRequest,
  intentId,
  isIrreversibleIntent,
  type SnapshotTier,
} from "@bitburner-agent/core";
import fc from "fast-check";
import { afterAll, beforeAll, expect, test } from "vitest";
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
const NETWORK = { servers: [staticServer("home", { moneyMax: 0 }), staticServer("n00dles")] };

const anyFactionsJoined = fc.oneof(
  { arbitrary: fc.constant([] as string[]), weight: 3 },
  { arbitrary: fc.subarray(JOINABLE), weight: 1 },
);
const anyOwnerIntent = fc.nat({ max: OWNER_INTENTS.length - 1 });
/**
 * What happens next: the owner queues or cancels, or queues an install and cancels it at once; a medium snapshot (some
 * factions joined); a slow one (some invitations); a save backup's answer; the three medium snapshots and saved
 * backups a gate needs (`release`, sometimes with the owner queuing meanwhile); the Agent's round, reporting each intent sent done or not; a reconnect.
 */
const anyStep = fc.oneof(
  { arbitrary: fc.record({ kind: fc.constant("queue" as const), index: anyOwnerIntent }), weight: 2 },
  { arbitrary: fc.record({ kind: fc.constant("cancel" as const), index: anyOwnerIntent }), weight: 1 },
  { arbitrary: fc.record({ kind: fc.constant("installThenCancel" as const) }), weight: 1 },
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
    arbitrary: fc.record({ kind: fc.constant("agentRound" as const), done: fc.array(fc.boolean(), { maxLength: 8 }) }),
    weight: 2,
  },
  { arbitrary: fc.record({ kind: fc.constant("reconnect" as const) }), weight: 1 },
);
type Step = typeof anyStep extends fc.Arbitrary<infer Each> ? Each : never;

let directory: string;
let storeCount = 0;
/** Across the runs, so the property is seen to reach what it's for. */
const reached = { runsWithARuleJoinOut: 0, ruleJoinsOutWhenTheOwnerWentAhead: 0 };
beforeAll(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "irreversible-intents-property-"));
});
afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

/** A brain with every rule on, an Agent connected, the steps played: what each desired state sent breaks of R8. */
async function play(steps: Step[]): Promise<string[]> {
  const store = TelemetryStore.open(path.join(directory, `telemetry-${++storeCount}.sqlite`));
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
    return owners[0] ?? rules[0] ?? null;
  };
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
        gameTimeMs: 1_000,
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
    return ownerQueue[0] === irreversible.id ? null : `${ownerQueue[0]}, queued before it, isn't done`;
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
        if (!everQueuedByOwner.has(each.id)) aRuleJoinWentOut = true;
      }
      irreversibleSentBefore = new Set(irreversible.map((each) => each.id));
    }
    statesChecked = states.length;
    // A backup is its intent's only while that stays the gates' first: pushed back, its gate counts again.
    const first = firstJudged();
    for (const pending of pendingBackups) if (pending.forId !== first) pending.current = false;
  };
  const invitedTo = (invited: string[]) => {
    const data = slowData();
    data.factions = {
      backend: "sim",
      state: { joined: [], invitations: invited, queuedAugmentations: [] },
      problem: null,
    };
    return data;
  };
  const medium = (factions: string[]) => {
    latestMediumFactions = factions;
    mediumsSeen += 1;
    send(
      "medium",
      mediumData(100, {}, { money: 1e9, city: "Sector-12", hasTorRouter: true, homeRam: 2 ** 20, factions }),
    );
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
    if (isIrreversibleIntent(OWNER_INTENTS[index] as Intent)) {
      for (const out of irreversibleSentBefore) {
        if (!everQueuedByOwner.has(out)) reached.ruleJoinsOutWhenTheOwnerWentAhead += 1;
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
          const done = step.done[index] ?? false;
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
    return violations;
  } finally {
    store.close();
  }
}

test("every irreversible intent sent, the owner's or a rule's: past its guard, its own backup, and alone", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(anyStep, { maxLength: 40, size: "medium" }), async (steps) => {
      expect(await play(steps)).toEqual([]);
    }),
    { numRuns: 100, endOnFailure: true },
  );
  // Reached: a rule's own join out (a city faction's the owner never queued), and the owner putting an irreversible
  // intent ahead of one out, #269 review's two cases. The seeds aren't fixed, so the floors sit where no seed misses
  // them: over 40 measured blocks of 100 runs, the first ranged 17 to 35 (mean 24, sd 4: its floor is 5 sd below), the
  // second 6 to 17 (mean 11, sd 3: none at all, its floor, is about e^-11 at that mean). At 0 the generator no longer
  // gets there.
  expect(reached.runsWithARuleJoinOut).toBeGreaterThanOrEqual(3);
  expect(reached.ruleJoinsOutWhenTheOwnerWentAhead).toBeGreaterThanOrEqual(1);
});
