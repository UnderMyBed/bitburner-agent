// Property tests (#179): the brain's half of the reconciler's rules on the owner's queue, whatever comes in between
// (snapshots, guards that fail, save backups that fail, the Agent's reports, resets, reconnects, a restarted brain).
// The Agent runs only what the latest desired state sends, and never again what it reported done while it's sent (the
// intent runner's properties, packages/ingame/test/agent/intent-runner.test.ts), so what holds of what's sent here
// holds of what runs in the game:
// - nothing queued after an intent that resets the game (an install, #164; a destroy, #175) goes before the reset,
//   and the reset goes only once what was queued before it is done;
// - one irreversible intent at a time (#147);
// - an intent the Agent reported done, or a reset intent once its reset shows, never goes again unless queued again: a
//   new Agent holds no intents, so this is what keeps a done one from running twice across a reset or a reconnect.
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
import type { SaveBackupEvent } from "../src/save-backups.ts";
import { TelemetryStore } from "../src/telemetry-store.ts";
import { mediumData, slowData, staticServer } from "./helpers/snapshot-fixtures.ts";

const TOKEN = "the-token";
const intent = (request: IntentRequest): Intent => ({ ...request, id: intentId(request.action, request.args) });
/** Every action; three joins (Sector-12 and Chongqing are enemies, so irreversible; CyberSec isn't); two destroys. */
const POOL: Intent[] = [
  intent({ action: "buyTor", args: { vendor: "Alpha Enterprises" } }),
  intent({ action: "buyProgram", args: { program: "BruteSSH.exe" } }),
  intent({ action: "upgradeHomeRam", args: { fromRam: 8, vendor: "Alpha Enterprises" } }),
  intent({ action: "travel", args: { city: "Aevum" } }),
  intent({ action: "joinFaction", args: { faction: "Sector-12" } }),
  intent({ action: "joinFaction", args: { faction: "Chongqing" } }),
  intent({ action: "joinFaction", args: { faction: "CyberSec" } }),
  intent({ action: "purchaseAugmentation", args: { faction: "CyberSec", augmentation: "Neurotrainer I", level: 1 } }),
  intent({ action: "donateToFaction", args: { faction: "Sector-12", amount: 1_000_000, reputation: 1 } }),
  intent({ action: "buyServer", args: { hostname: "pserv-0", ram: 8 } }),
  intent({ action: "upgradeServer", args: { hostname: "pserv-0", ram: 64 } }),
  intent({ action: "backdoor", args: { hostname: "CSEC" } }),
  intent({ action: "installAugmentations", args: {} }),
  intent({ action: "destroyBitNode", args: { nextBitNode: 2 } }),
  intent({ action: "destroyBitNode", args: { nextBitNode: 3 } }),
];
const POOL_BY_ID = new Map(POOL.map((each) => [each.id, each]));
const FACTIONS = ["Sector-12", "Chongqing", "CyberSec"];
/** The rules' switches, off: what's sent is the owner's queue alone. The hack loop off too, so it goes at once. */
const SWITCHES_OFF = [
  "hackLoop.enabled",
  "batcher.enabled",
  "programs.enabled",
  "homeRam.enabled",
  "cloudServers.enabled",
  "augmentations.enabled",
  "factionWork.enabled",
  "worldDaemon.enabled",
  "share.enabled",
];
const SAVED: SaveBackupEvent = { type: "saveBackup", atMs: 1, file: "saves/E0/x.json.gz", sizeBytes: 10 };
const FAILED: SaveBackupEvent = { type: "saveBackup", atMs: 1, failure: "the game sent its save as text" };
/** The static snapshot once The Red Pill is in: w0r1d_d43m0n among the servers, at 3000 hacking. */
const STATIC = {
  servers: [
    staticServer("home", { moneyMax: 0 }),
    staticServer(WORLD_DAEMON, { requiredHackingSkill: 3000, numOpenPortsRequired: 5 }),
  ],
};

/**
 * What an Agent's round does with each intent sent, by its index in `POOL`: done, or not. A reset intent done resets the
 * game (its Agent dies, the next connects to the reset game); `doneNoReset` is an install with nothing left to install.
 */
const anyAnswers = fc.array(fc.constantFrom("done", "done", "notDone", "doneNoReset"), {
  minLength: POOL.length,
  maxLength: POOL.length,
});
const anyIndex = fc.nat({ max: POOL.length - 1 });
const indexesWhere = (keep: (each: Intent) => boolean) => POOL.flatMap((each, index) => (keep(each) ? [index] : []));
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
  kind: fc.constant("medium" as const),
  factions: fc.oneof(
    { arbitrary: fc.constant([] as string[]), weight: 3 },
    { arbitrary: fc.subarray(FACTIONS), weight: 1 },
  ),
  daemonReady: fc.oneof({ arbitrary: fc.constant(true), weight: 3 }, { arbitrary: fc.constant(false), weight: 1 }),
});
/**
 * What happens next: the owner queues or cancels, a medium snapshot, a save backup's answer, the two medium snapshots
 * and saved backup a gate needs (`release`, so gates open often), an Agent's round, a slow snapshot, a reconnect, or
 * a restarted brain.
 */
const anyStep = fc.oneof(
  { arbitrary: fc.record({ kind: fc.constant("add" as const), index: anyIndex }), weight: 2 },
  { arbitrary: fc.record({ kind: fc.constant("cancel" as const), index: anyIndex }), weight: 1 },
  { arbitrary: anyMedium, weight: 3 },
  { arbitrary: fc.record({ kind: fc.constant("backup" as const), saved: fc.boolean() }), weight: 2 },
  { arbitrary: fc.record({ kind: fc.constant("release" as const), medium: anyMedium }), weight: 4 },
  { arbitrary: fc.record({ kind: fc.constant("agentRound" as const), answers: anyAnswers }), weight: 4 },
  { arbitrary: fc.record({ kind: fc.constant("slow" as const) }), weight: 1 },
  { arbitrary: fc.record({ kind: fc.constant("reconnect" as const) }), weight: 1 },
  { arbitrary: fc.record({ kind: fc.constant("restart" as const) }), weight: 1 },
);
type Step = typeof anyStep extends fc.Arbitrary<infer Each> ? Each : never;

let directory: string;
let runs = 0;
beforeAll(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "desired-state-property-"));
});
afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

/**
 * A brain on a fresh store, an Agent connected to it, and the steps played: what each desired state sent breaks of
 * the rules, checked against the queue as the owner made it (the order queued), not the brain's own.
 */
async function play(initial: number[], steps: Step[]): Promise<string[]> {
  const store = TelemetryStore.open(path.join(directory, `telemetry-${++runs}.sqlite`));
  for (const setting of SWITCHES_OFF) store.setSetting(setting, "false");
  /** The game's last resets, as its slow snapshot says. */
  const game = { lastAugReset: 1_000, lastNodeReset: 1_000 };
  /** The owner's queue, by id, in the order queued; and what's done (reported, or reset) and not queued since. */
  const queue: string[] = [];
  const unqueue = (id: string) => {
    if (queue.includes(id)) queue.splice(queue.indexOf(id), 1);
  };
  const done = new Set<string>();
  const broken: string[] = [];
  let sequenceNumber = 0;
  let session = 0;
  let channel: ControlChannel;
  let pendingBackups: ((event: SaveBackupEvent) => void)[] = [];
  let connection = new MemoryConnection();
  let seen = 0;

  const send = (tier: SnapshotTier, data: unknown) =>
    connection.receive(
      encodeControlMessage({
        protocolVersion: CONTROL_PROTOCOL_VERSION,
        type: "snapshot",
        agentSessionId: `session-${session}`,
        tier,
        sequenceNumber: ++sequenceNumber,
        gameTimeMs: 1_000,
        data,
      }),
    );
  const sentStates = () =>
    connection
      .sentMessages()
      .filter((message) => message.type === "desiredState")
      .map((message) => message as unknown as DesiredState);
  /** Each desired state sent since the last check, against the rules. */
  const check = () => {
    const states = sentStates();
    for (const state of states.slice(seen)) {
      const ids = state.intents.map((each) => each.id);
      const resetAt = queue.findIndex((id) => resetsTheGame(POOL_BY_ID.get(id) as Intent));
      if (resetAt !== -1) {
        for (const id of queue.slice(resetAt + 1)) {
          if (ids.includes(id)) broken.push(`${id} sent before ${queue[resetAt]}, queued before it, reset the game`);
        }
        // And what was queued before it, for this game, is done first: it goes out only first in the queue.
        if (resetAt > 0 && ids.includes(queue[resetAt] as string)) {
          broken.push(`${queue[resetAt]} sent with ${queue.slice(0, resetAt).join(", ")} queued before it, undone`);
        }
      }
      const irreversible = state.intents.filter(isIrreversibleIntent).map((each) => each.id);
      if (irreversible.length > 1) broken.push(`irreversible intents sent together: ${irreversible.join(", ")}`);
      for (const id of ids) if (done.has(id)) broken.push(`${id} sent again, done`);
    }
    seen = states.length;
  };
  const slow = () => ({
    ...slowData(),
    resetInfo: { ...slowData().resetInfo, lastAugReset: game.lastAugReset, lastNodeReset: game.lastNodeReset },
  });
  /** An Agent connects, in a new session, and sends its static and slow snapshots. */
  const connect = () => {
    connection = new MemoryConnection();
    seen = 0;
    session += 1;
    channel.accept(connection);
    connection.receive(
      encodeControlMessage({
        protocolVersion: CONTROL_PROTOCOL_VERSION,
        type: "hello",
        token: TOKEN,
        deploymentId: "deployment-a",
        agentSessionId: `session-${session}`,
        game: { version: "3.0.1", versionNumber: 51, commit: "3162fd2", platform: "Steam" },
      }),
    );
    check();
    send("static", STATIC);
    check();
    send("slow", slow());
    check();
  };
  /** A brain starts on the store: its own channel, controller and save backups (each answered by a `backup` step). */
  const startBrain = () => {
    channel = new ControlChannel({ token: TOKEN, clock: new ManualClock() });
    channel.setDeploymentState({ deployedId: "deployment-a", hold: false, deployFailed: false });
    pendingBackups = [];
    const backupNow = () =>
      new Promise<SaveBackupEvent>((resolve) => {
        pendingBackups.push(resolve);
      });
    return new DesiredStateController({ channel, store, saveBackups: { backupNow } });
  };

  try {
    let controller = startBrain();
    connect();
    const add = (index: number) => {
      const { id, ...request } = POOL[index] as Intent;
      done.delete(id);
      if (!queue.includes(id)) queue.push(id);
      expect(controller.addManualIntent(request as IntentRequest)).toMatchObject({ ok: true });
      check();
    };
    const medium = ({ daemonReady, factions }: { daemonReady: boolean; factions: string[] }) => {
      send("medium", mediumData(daemonReady ? 3000 : 1, { [WORLD_DAEMON]: true }, { factions }));
      check();
    };
    /** The oldest backup asked for answers (`all`: every one asked for, oldest first). */
    const backup = async (saved: boolean, { all = false } = {}) => {
      for (const answer of all ? pendingBackups.splice(0) : pendingBackups.splice(0, 1)) answer(saved ? SAVED : FAILED);
      await new Promise((resolve) => setImmediate(resolve));
      check();
    };
    for (const index of initial) add(index);
    for (const step of steps) {
      if (step.kind === "add") add(step.index);
      else if (step.kind === "cancel") {
        const { id } = POOL[step.index] as Intent;
        unqueue(id);
        controller.cancelManualIntent(id);
        check();
      } else if (step.kind === "medium") medium(step);
      else if (step.kind === "backup") await backup(step.saved);
      else if (step.kind === "release") {
        medium(step.medium);
        medium(step.medium);
        await backup(true, { all: true });
      } else if (step.kind === "agentRound") {
        // The Agent's round, in order: each intent sent done or not, reported in its fast snapshot; a reset intent done
        // resets the game, and its Agent with it.
        const held = sentStates().at(-1)?.intents ?? [];
        const outcomes: IntentOutcome[] = [];
        let reset: Intent | null = null;
        for (const each of held) {
          const answer = step.answers[POOL.findIndex((pooled) => pooled.id === each.id)] ?? "notDone";
          if (resetsTheGame(each) && answer === "done") {
            reset = each;
            break;
          }
          const isDone = resetsTheGame(each)
            ? each.action === "installAugmentations" && answer === "doneNoReset"
            : answer !== "notDone";
          outcomes.push({ id: each.id, done: isDone, tries: 1, problem: isDone ? null : "not yet", backend: "sim" });
          if (isDone) {
            unqueue(each.id);
            done.add(each.id);
          }
        }
        send("fast", { degradedTiers: [], pageHeapUsedBytes: null, game: null, intents: outcomes });
        check();
        if (reset !== null) {
          connection.dropFromGameSide();
          check();
          game.lastAugReset += 1_000;
          if (reset.action === "destroyBitNode") game.lastNodeReset += 1_000;
          // Done by the reset: what was queued after it may go now; it, never again.
          unqueue(reset.id);
          done.add(reset.id);
          connect();
        }
      } else if (step.kind === "slow") {
        send("slow", slow());
        check();
      } else if (step.kind === "reconnect") {
        connection.dropFromGameSide();
        connect();
      } else {
        connection.dropFromGameSide();
        controller = startBrain();
        connect();
      }
    }
    return broken;
  } finally {
    store.close();
  }
}

test("the pool has every action an intent can name, so a new action needs a place here", () => {
  expect(new Set(POOL.map((each) => each.action))).toEqual(new Set(INTENT_ACTIONS));
});

test("nothing queued after a reset goes before it; one irreversible intent at a time; nothing done goes again", async () => {
  await fc.assert(
    fc.asyncProperty(anyInitialQueue, fc.array(anyStep, { maxLength: 50, size: "medium" }), async (initial, steps) => {
      expect(await play(initial, steps)).toEqual([]);
    }),
    { numRuns: 150 },
  );
});
