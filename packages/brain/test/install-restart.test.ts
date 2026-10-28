// Installing augmentations and the restart after it, in the simulator (#164, architecture §5.7): the Agent's side.
// The owner queues an install; the brain's gate lets it out (nothing undone queued before it, two medium snapshots, a
// save backup); the Agent installs through the simulator's own effector or its Singularity worker; every script dies,
// the Agent too; the game starts `agent/boot.js` 500 ms later, which starts the next Agent, in a new session of the
// reset game. Chaos: the brain down mid-install; a reload just after it, of a save taken then (a save-then-reload) and
// of the last save from before it (a plain reload); and the reconnect to the reset game. The `ui` backend's restart
// (the page timer, the terminal, save-and-reload) is E2's.
import type { Connection } from "@bitburner-agent/bridge";
import type { FastSnapshotData, MediumSnapshotData, SlowSnapshotData } from "@bitburner-agent/core";
import { expect, test } from "vitest";
import type { IntentView } from "../src/desired-state.ts";
import { CONTROL_URL } from "./helpers/agent-in-simulation.ts";
import { RFA_URL, startBrainInSimulation } from "./helpers/brain-in-simulation.ts";
import { useFreshStarts, withoutSimEffectors } from "./helpers/fresh-start.ts";

const freshStart = useFreshStarts();
const INSTALL_ID = "installAugmentations()";
const AUGMENTATION = "Neurotrainer I";

/**
 * A fresh start with the brain's desired state, `AUGMENTATION` queued (a harness edit) unless `queued` is false, and
 * $1b; purchases off, so only the owner's queue moves the game. The hack loop is on, as by default.
 */
async function withAugmentationQueued({ singularity = false, queued = true } = {}) {
  const fresh = await freshStart({
    withDesiredState: true,
    ...(singularity ? { fixture: { kind: "bitnode", n: 1, sourceFiles: { 1: 1, 4: 3 } } as const } : {}),
    beforeAgent: async (game) => {
      await game.simulation.diagnostics.setMoney(1e9);
      if (queued) await game.simulation.diagnostics.queueAugmentation(AUGMENTATION);
      if (singularity) await withoutSimEffectors(game);
    },
  });
  fresh.controller().setProgramsEnabled(false);
  fresh.controller().setHomeRamEnabled(false);
  // The connected Agent's first slow snapshot, so the brain knows the game's last reset before the install.
  await fresh.game.runUntil(() => fresh.latest<SlowSnapshotData>("slow") !== null, 10_000);
  return fresh;
}

type Fresh = Awaited<ReturnType<typeof withAugmentationQueued>>;

const slow = (fresh: Fresh) => fresh.latest<SlowSnapshotData>("slow");
const agentSessions = (fresh: Fresh, brain = fresh.brain) =>
  brain.channelEvents.flatMap((event) => (event.type === "agentConnected" ? [event.agentSessionId] : []));
const view = (views: IntentView[], id: string) => views.find((each) => each.id === id);
/** The `tier` snapshots `brain` has received from the Agent session `session`, in order. */
const snapshotsOf = <Data>(fresh: Fresh, session: string | undefined, tier: string, brain = fresh.brain) =>
  brain.channelEvents.flatMap((event) =>
    event.type === "snapshotReceived" && event.snapshot.tier === tier && event.snapshot.agentSessionId === session
      ? [event.snapshot.data as Data]
      : [],
  );
const rooted = (medium: MediumSnapshotData, hostname: string) =>
  medium.servers.find((server) => server.hostname === hostname)?.hasAdminRights === true;

/**
 * Queues the install, and whatever `queuedAfter` queues after it, and runs until the Agent installs: its connection
 * to the brain closes as it dies. Returns the last reset before it.
 */
async function installed(fresh: Fresh, queuedAfter: () => void = () => {}) {
  const lastAugResetBefore = slow(fresh)?.resetInfo.lastAugReset as number;
  expect(fresh.controller().addManualIntent({ action: "installAugmentations", args: {} })).toMatchObject({ ok: true });
  queuedAfter();
  await fresh.game.runUntil(
    () => fresh.brain.channelEvents.some((event) => event.type === "agentDisconnected"),
    60_000,
  );
  return { lastAugResetBefore };
}

/**
 * The reset game, as the latest slow snapshot shows it: `AUGMENTATION` installed, and the last reset moved. Returns
 * that reset, so a later check can see it's the same one: installed once.
 */
function expectResetWithItInstalled(fresh: Fresh, lastAugResetBefore: number): number {
  const resetInfo = slow(fresh)?.resetInfo;
  expect(resetInfo?.ownedAugs).toEqual({ [AUGMENTATION]: 1 });
  expect(resetInfo?.lastAugReset).toBeGreaterThan(lastAugResetBefore);
  return resetInfo?.lastAugReset as number;
}

/** Still the one reset, and no other Agent session: nothing installed again, 30 s on. */
async function expectInstalledOnce(fresh: Fresh, resetAt: number, sessions: number, brain = fresh.brain) {
  await fresh.game.run(30_000);
  expect(agentSessions(fresh, brain)).toHaveLength(sessions);
  expect(slow(fresh)?.resetInfo).toMatchObject({ lastAugReset: resetAt, ownedAugs: { [AUGMENTATION]: 1 } });
}

test("reconnecting to the reset game (sim): the next Agent's session, the install off the queue, what's after it in the new game", async () => {
  const fresh = await withAugmentationQueued();
  const backupsBefore = fresh.brain.saveBackupEvents.length;
  // Queued after the install, the travel waits for it: with $1b now, it would be done in this game.
  const { lastAugResetBefore } = await installed(fresh, () => {
    fresh.controller().addManualIntent({ action: "travel", args: { city: "Aevum" } });
    expect(view(fresh.controller().intentsView(), "travel(Aevum)")?.waitingFor).toMatch(/^waiting for install/);
  });
  expect(fresh.medium()?.player.city).toBe("Sector-12");
  // One backup, before the install; the old Agent never reports it done: it died installing.
  expect(fresh.brain.saveBackupEvents.slice(backupsBefore)).toEqual([
    expect.objectContaining({ file: expect.any(String) }),
  ]);
  // boot.js, started 500 ms after the reset, starts the next Agent: a new session, the same deployment.
  await fresh.game.runUntil(() => agentSessions(fresh).length === 2, 10_000);
  const [before, after] = agentSessions(fresh);
  expect(after).not.toBe(before);
  // Its first slow snapshot shows the reset: the brain takes the install off its queue then, with no second backup.
  await fresh.game.runUntil(() => view(fresh.controller().intentsView(), INSTALL_ID) === undefined, 10_000);
  const resetAt = expectResetWithItInstalled(fresh, lastAugResetBefore);
  // The travel goes now, tried in the reset game, where the money is the new start's: not enough for the ticket.
  await fresh.game.runUntil(
    () => (view(fresh.controller().intentsView(), "travel(Aevum)")?.outcome?.tries ?? 0) >= 1,
    15_000,
  );
  expect(view(fresh.controller().intentsView(), "travel(Aevum)")?.outcome).toMatchObject({
    done: false,
    problem: "not in Aevum after travelling (is the $200k ticket there?)",
  });
  // The hack loop in the reset game, from the new session's own snapshots: n00dles unrooted by the reset, then the
  // target chosen and rooted again.
  const newMediums = () => snapshotsOf<MediumSnapshotData>(fresh, after, "medium");
  expect(newMediums()[0] && rooted(newMediums()[0] as MediumSnapshotData, "n00dles")).toBe(false);
  await fresh.game.runUntil(() => newMediums().some((medium) => rooted(medium, "n00dles")), 60_000);
  expect(fresh.controller().hackLoopView()).toMatchObject({ enabled: true, waiting: false, target: "n00dles" });
  expect(fresh.brain.saveBackupEvents.slice(backupsBefore)).toHaveLength(1);
  await expectInstalledOnce(fresh, resetAt, 2);
});

test("installing (singularity): with SF4.3, through its Singularity worker, which names boot.js for after the reset", async () => {
  const fresh = await withAugmentationQueued({ singularity: true });
  const { lastAugResetBefore } = await installed(fresh);
  await fresh.game.runUntil(() => agentSessions(fresh).length === 2, 10_000);
  await fresh.game.runUntil(() => fresh.controller().intentsView().length === 0, 10_000);
  const resetAt = expectResetWithItInstalled(fresh, lastAugResetBefore);
  await expectInstalledOnce(fresh, resetAt, 2);
});

test.each([
  ["sim", false],
  ["singularity", true],
])("nothing queued (%s): done at once, with no reset", async (backend, singularity) => {
  const fresh = await withAugmentationQueued({ queued: false, singularity });
  const [session] = agentSessions(fresh);
  const lastAugResetBefore = slow(fresh)?.resetInfo.lastAugReset;
  fresh.controller().addManualIntent({ action: "installAugmentations", args: {} });
  // Past the gate, the Agent reports it done (nothing to install), and the queue drops it.
  await fresh.game.runUntil(() => fresh.controller().intentsView().length === 0, 60_000);
  // A slow snapshot taken after it (they come every 60 s): no reset.
  const slowsAtDone = snapshotsOf(fresh, session, "slow").length;
  await fresh.game.runUntil(() => snapshotsOf(fresh, session, "slow").length > slowsAtDone, 65_000);
  expect(snapshotsOf<SlowSnapshotData>(fresh, session, "slow").at(-1)?.resetInfo).toMatchObject({
    lastAugReset: lastAugResetBefore,
    ownedAugs: {},
  });
  expect(agentSessions(fresh)).toHaveLength(1);
  expect(fresh.brain.channelEvents.some((event) => event.type === "agentDisconnected")).toBe(false);
  expect(fresh.latest<FastSnapshotData>("fast")?.intents).toEqual([]);
  // Reported done by the backend under test, at its first try: the game's own check, nothing left to install.
  const reportedDone = snapshotsOf<FastSnapshotData>(fresh, session, "fast")
    .flatMap((fast) => fast.intents ?? [])
    .filter((outcome) => outcome.id === INSTALL_ID && outcome.done);
  expect(reportedDone[0]).toMatchObject({ backend, problem: null, tries: 1 });
  // As the page: its Install is disabled with nothing queued, so the game's refusal never shows.
  const alerts = (await fresh.simulation.events(0)).events.filter((event) => event.type === "alert");
  expect(alerts.map((event) => ("text" in event ? event.text : ""))).not.toContainEqual(
    expect.stringMatching(/not purchased any Augmentations/),
  );
});

test("the brain down mid-install: a new brain gates it again, and the game's check says done; installed once", async () => {
  const fresh = await withAugmentationQueued();
  const { lastAugResetBefore } = await installed(fresh);
  // The brain goes down as the old Agent dies: the next one, and the game's Remote File API, can't connect.
  fresh.brain.closeConnections();
  const refuse = (connection: Connection) => connection.close(1011, "the brain is down");
  fresh.game.listen(CONTROL_URL, refuse);
  fresh.game.listen(RFA_URL, refuse);
  await fresh.game.run(30_000);
  // A new brain, with the same store (the queue in it), knows nothing of the install it didn't send.
  const restarted = startBrainInSimulation(fresh.game, {
    build: fresh.build,
    data: fresh.data,
    withDesiredState: true,
  });
  const controller = restarted.desiredState;
  if (!controller) throw new Error("no controller");
  await fresh.game.runUntil(() => agentSessions(fresh, restarted).length === 1, 60_000);
  expect(view(controller.intentsView(), INSTALL_ID)?.waitingFor).toMatch(/^waiting for the guard/);
  // Gated again: two medium snapshots and a backup of the reset game; then the Agent finds nothing left to install.
  await fresh.game.runUntil(() => controller.intentsView().length === 0, 60_000);
  expect(restarted.saveBackupEvents.filter((event) => "file" in event).length).toBeGreaterThanOrEqual(1);
  const resetAt = expectResetWithItInstalled(fresh, lastAugResetBefore);
  await expectInstalledOnce(fresh, resetAt, 1, restarted);
});

test("a save-then-reload just after the install (as Options' kill-all does): autoexec brings the Agent back; done", async () => {
  const fresh = await withAugmentationQueued();
  const { lastAugResetBefore } = await installed(fresh);
  // Before boot.js's 500 ms, from a save taken now: it holds the reset game, and autoexec is the way back.
  await fresh.reload();
  await fresh.game.runUntil(() => agentSessions(fresh).length === 2, 15_000);
  await fresh.game.runUntil(() => fresh.controller().intentsView().length === 0, 10_000);
  const resetAt = expectResetWithItInstalled(fresh, lastAugResetBefore);
  await expectInstalledOnce(fresh, resetAt, 2);
});

test("a reload of the last save from before the install: the install is kept, sent again past a new backup, and done once", async () => {
  const fresh = await withAugmentationQueued();
  // The last save the game wrote, from before the install (nothing saves on install, the autosave every 60 s).
  const lastSaveBefore = await fresh.simulation.save();
  const backupsBefore = fresh.brain.saveBackupEvents.length;
  const { lastAugResetBefore } = await installed(fresh);
  await fresh.reload(lastSaveBefore);
  // The game as it was: the augmentation still queued, and the same last reset. The install stays queued.
  await fresh.game.runUntil(() => agentSessions(fresh).length === 2, 15_000);
  const second = agentSessions(fresh)[1];
  await fresh.game.runUntil(() => snapshotsOf(fresh, second, "slow").length > 0, 10_000);
  expect(snapshotsOf<SlowSnapshotData>(fresh, second, "slow")[0]?.resetInfo).toMatchObject({
    lastAugReset: lastAugResetBefore,
    ownedAugs: {},
  });
  expect(view(fresh.controller().intentsView(), INSTALL_ID)).toBeDefined();
  // Gated again, a new backup, installed: a third session, in the reset game, and the install off the queue.
  await fresh.game.runUntil(() => agentSessions(fresh).length === 3, 60_000);
  await fresh.game.runUntil(() => fresh.controller().intentsView().length === 0, 10_000);
  const resetAt = expectResetWithItInstalled(fresh, lastAugResetBefore);
  // A backup before each install, and one for the reloaded game's Remote File API connection.
  expect(fresh.brain.saveBackupEvents.slice(backupsBefore).filter((event) => "file" in event)).toHaveLength(3);
  await expectInstalledOnce(fresh, resetAt, 3);
});
