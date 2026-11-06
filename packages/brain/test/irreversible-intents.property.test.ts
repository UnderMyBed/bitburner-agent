// Property test (#269): every irreversible intent the brain sends, whatever made it (the owner's queue, or a rule: the
// brain's join of a city faction, #228), goes out only past the irreversible gate (R8, #147): its guard holding on the
// connected Agent's latest medium snapshot, a save backup asked for since the Agent connected and answered saved, and
// alone. The rules are on, as in a live run, with the hack loop off so intents go without its snapshots. The gate's
// own example tests are desired-state.test.ts's; the reset and done rules over the owner's queue, #179's property.
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
import type { SaveBackupEvent } from "../src/save-backups.ts";
import { TelemetryStore } from "../src/telemetry-store.ts";
import { mediumData, slowData, staticServer } from "./helpers/snapshot-fixtures.ts";

const TOKEN = "the-token";
const intentOf = (request: IntentRequest): Intent => ({ ...request, id: intentId(request.action, request.args) });
/** What the owner may queue: an install, two enemies' joins, a travel. */
const OWNER_INTENTS: Intent[] = [
  intentOf({ action: "installAugmentations", args: {} }),
  intentOf({ action: "joinFaction", args: { faction: "Chongqing" } }),
  intentOf({ action: "joinFaction", args: { faction: "Sector-12" } }),
  intentOf({ action: "travel", args: { city: "Aevum" } }),
];
/** Invitations the slow snapshot may carry: city factions of groups A and B, and CyberSec, which has no enemies. */
const INVITABLE = ["Sector-12", "Aevum", "Chongqing", "New Tokyo", "CyberSec"];
/** Factions a medium snapshot may show joined (the owner's doing, or the Agent's). */
const JOINABLE = ["Sector-12", "Aevum", "Chongqing", "Volhaven", "CyberSec"];
const SAVED_BACKUP: SaveBackupEvent = { type: "saveBackup", atMs: 1, file: "saves/E0/x.json.gz", sizeBytes: 10 };
const FAILED_BACKUP: SaveBackupEvent = { type: "saveBackup", atMs: 1, failure: "the game sent its save as text" };
/** What the gate's `waitingFor` says while it holds an intent (./irreversible-gate.ts, `waitingFor`). */
const GATE_HOLDS = [
  /^waiting for the guard/,
  /^waiting for a save backup/,
  /^held: /,
  /one irreversible intent at a time$/,
];
const TAKING_BACKUP = "waiting for a save backup";
const NOT_JUDGED_YET = "waiting for the guard: not judged yet";
const NETWORK = { servers: [staticServer("home", { moneyMax: 0 }), staticServer("n00dles")] };

const anyFactionsJoined = fc.oneof(
  { arbitrary: fc.constant([] as string[]), weight: 3 },
  { arbitrary: fc.subarray(JOINABLE), weight: 1 },
);
const anyOwnerIntent = fc.nat({ max: OWNER_INTENTS.length - 1 });
/**
 * What happens next: the owner queues or cancels; a medium snapshot (some factions joined); a slow one (some
 * invitations); a save backup's answer; the three medium snapshots and saved backups a gate needs (`release`); the
 * Agent's round, reporting each intent sent done or not; a reconnect.
 */
const anyStep = fc.oneof(
  { arbitrary: fc.record({ kind: fc.constant("queue" as const), index: anyOwnerIntent }), weight: 2 },
  { arbitrary: fc.record({ kind: fc.constant("cancel" as const), index: anyOwnerIntent }), weight: 1 },
  { arbitrary: fc.record({ kind: fc.constant("medium" as const), factions: anyFactionsJoined }), weight: 3 },
  { arbitrary: fc.record({ kind: fc.constant("slow" as const), invited: fc.subarray(INVITABLE) }), weight: 2 },
  { arbitrary: fc.record({ kind: fc.constant("backup" as const), saved: fc.boolean() }), weight: 2 },
  { arbitrary: fc.record({ kind: fc.constant("release" as const), factions: anyFactionsJoined }), weight: 3 },
  {
    arbitrary: fc.record({ kind: fc.constant("agentRound" as const), done: fc.array(fc.boolean(), { maxLength: 8 }) }),
    weight: 2,
  },
  { arbitrary: fc.record({ kind: fc.constant("reconnect" as const) }), weight: 1 },
);
type Step = typeof anyStep extends fc.Arbitrary<infer Each> ? Each : never;

let directory: string;
let storeCount = 0;
/** Across the runs: the rule's own irreversible joins sent, so the property is seen to reach them. */
let ruleJoinsSent = 0;
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
  /** Each backup asked for, with the connection it was asked for on. */
  const pendingBackups: { answer: (event: SaveBackupEvent) => void; connectionNumber: number }[] = [];
  const backupNow = () =>
    new Promise<SaveBackupEvent>((answer) => {
      pendingBackups.push({ answer, connectionNumber });
    });
  const controller = new DesiredStateController({ channel, store, saveBackups: { backupNow } });
  /** The owner's queue as the owner made it, by id. */
  const ownerQueue: string[] = [];
  const everQueuedByOwner = new Set<string>();
  const violations: string[] = [];
  let connection = new MemoryConnection();
  let connectionNumber = 0;
  let sequenceNumber = 0;
  let statesChecked = 0;
  /** The irreversible intents in the last desired state checked on this connection. */
  let irreversibleSentBefore = new Set<string>();
  /** The factions joined in the latest medium snapshot since the Agent connected, or null before one. */
  let latestMediumFactions: string[] | null = null;
  /** Each intent's `waitingFor` after the last action: held by its gate, it may go out only on a saved backup. */
  let waitingBefore = new Map<string, string | null>();

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
  /** Checks what was sent since the last check; `action`: whether it answered saved a backup asked on this connection. */
  const checkDesiredStates = (action: "saved" | "other" = "other") => {
    const states = desiredStatesSent();
    for (const state of states.slice(statesChecked)) {
      const irreversible = state.intents.filter(isIrreversibleIntent);
      if (irreversible.length > 1) {
        violations.push(`irreversible intents sent together: ${irreversible.map((each) => each.id).join(", ")}`);
      }
      for (const each of irreversible) {
        const failure = guardFailure(each);
        if (failure !== null) violations.push(`${each.id} sent, its guard failing: ${failure}`);
        // Held by its gate before this action: only its backup, answered saved, lets it out.
        // One not seen before (a rule's new join, say) has had no gate to pass yet.
        const waited = waitingBefore.has(each.id) ? (waitingBefore.get(each.id) ?? null) : NOT_JUDGED_YET;
        const heldByGate = waited !== null && GATE_HOLDS.some((pattern) => pattern.test(waited));
        if (!irreversibleSentBefore.has(each.id) && heldByGate && !(action === "saved" && waited === TAKING_BACKUP)) {
          violations.push(`${each.id} sent, held by its gate ("${waited}") with no save backup answered saved`);
        }
        // Reached through its own gate: a join the owner never queued (an owner's gate passes to a rule's same id).
        if (!everQueuedByOwner.has(each.id)) ruleJoinsSent += 1;
      }
      irreversibleSentBefore = new Set(irreversible.map((each) => each.id));
    }
    statesChecked = states.length;
    waitingBefore = new Map(controller.intentsView().map((view) => [view.id, view.waitingFor]));
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
    // A new Agent: every gate starts again.
    waitingBefore = new Map([...waitingBefore.keys()].map((id) => [id, NOT_JUDGED_YET]));
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
    for (const { answer, connectionNumber: askedOn } of pendingBackups.splice(0, all ? pendingBackups.length : 1)) {
      answer(saved ? SAVED_BACKUP : FAILED_BACKUP);
      await new Promise((resolve) => setImmediate(resolve));
      checkDesiredStates(saved && askedOn === connectionNumber ? "saved" : "other");
    }
    checkDesiredStates();
  };

  try {
    connect();
    for (const step of steps) {
      if (step.kind === "queue") {
        const { id, ...request } = OWNER_INTENTS[step.index] as Intent;
        if (!ownerQueue.includes(id)) ownerQueue.push(id);
        everQueuedByOwner.add(id);
        controller.addManualIntent(request as IntentRequest);
        checkDesiredStates();
      } else if (step.kind === "cancel") {
        const { id } = OWNER_INTENTS[step.index] as Intent;
        if (ownerQueue.includes(id)) ownerQueue.splice(ownerQueue.indexOf(id), 1);
        controller.cancelManualIntent(id);
        checkDesiredStates();
      } else if (step.kind === "medium") medium(step.factions);
      else if (step.kind === "slow") {
        send("slow", invitedTo(step.invited));
        checkDesiredStates();
      } else if (step.kind === "backup") await answerBackups(step.saved);
      else if (step.kind === "release") {
        for (let each = 0; each < 3; each += 1) medium(step.factions);
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
    return violations;
  } finally {
    store.close();
  }
}

test("every irreversible intent sent, the owner's or a rule's: past its guard and a saved backup, and alone", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(anyStep, { maxLength: 40, size: "medium" }), async (steps) => {
      expect(await play(steps)).toEqual([]);
    }),
    { numRuns: 100, endOnFailure: true },
  );
  // The rules' own irreversible joins were reached, past their own gates: a city faction's the owner never queued.
  expect(ruleJoinsSent).toBeGreaterThan(0);
});
