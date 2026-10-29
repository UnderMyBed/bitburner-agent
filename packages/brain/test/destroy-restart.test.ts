// Destroying a BitNode and the restart after it, in the simulator (#175, architecture §5.7): the Agent's side. The
// owner queues a destroy; the brain's gate lets it out (nothing undone queued before it, w0r1d_d43m0n's preconditions
// on two medium snapshots, a save backup); the Agent destroys through the simulator's own effector (the terminal's
// backdoor, then the BitVerse's portal) or its Singularity worker; every script dies, the Agent too; the game starts
// `agent/boot.js` 500 ms after entering the next BitNode, which starts the next Agent, in a new session. Chaos: the
// brain down mid-destroy, a reload just after it, and a save that starts at the BitVerse before a portal is picked.
// The `ui` backend's restart (the page timer through the BitVerse) is E2's.

import { gunzipSync } from "node:zlib";
import {
  AGENT_SIM_EFFECTORS_GLOBAL,
  type FastSnapshotData,
  PORT_OPENER_PROGRAMS,
  type SlowSnapshotData,
} from "@bitburner-agent/core";
import type { Simulation } from "@bitburner-agent/sim";
import { expect, test } from "vitest";
import type { IntentView } from "../src/desired-state.ts";
import { startBrainInSimulation } from "./helpers/brain-in-simulation.ts";
import { type FreshGame, ownerRunsOnHome, useFreshStarts, withoutSimEffectors } from "./helpers/fresh-start.ts";

const freshStart = useFreshStarts();
const DESTROY_ID = "destroyBitNode(2)";
const DAEMON = "w0r1d_d43m0n";
/** Hacking exp for level 3042 in BN1 (`calculateSkill`: 32 × ln(exp + 534.6) − 200): w0r1d_d43m0n needs 3000. */
const DAEMON_LEVEL_EXP = 1e44;

/**
 * The owner's way to The Red Pill's requirements, as harness steps: The Red Pill queued (a harness edit) and installed
 * through the simulator's own install, which links w0r1d_d43m0n to The-Cave (`Prestige.ts:174-182`); then, unless
 * said, hacking exp for its level (a harness edit), and the port openers bought (the simulator's own effectors) and run
 * on it with NUKE.exe. $1t, so the purchases go through.
 */
async function toTheRedPill(game: FreshGame, { rooted = true, levelled = true } = {}) {
  await game.simulation.diagnostics.queueAugmentation("The Red Pill");
  await ownerRunsOnHome(
    game,
    `export async function main(ns) { globalThis.${AGENT_SIM_EFFECTORS_GLOBAL}.installQueuedAugmentations(""); }`,
  );
  await game.simulation.diagnostics.setMoney(1e12);
  if (levelled) await game.simulation.diagnostics.gainHackingExp(DAEMON_LEVEL_EXP);
  if (!rooted) return;
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
}

/**
 * A fresh start at The Red Pill's requirements (`toTheRedPill`), with the brain's desired state, and purchases off, so
 * only the owner's queue moves the game. With `singularity`, BN1 with SF1.1 and SF4.3, home at 64 GB so the 33.9 GB
 * worker fits beside the Agent, and the simulator's own effectors taken away after the setup.
 */
async function readyToDestroy({ singularity = false, rooted = true, levelled = true, withDesiredState = true } = {}) {
  const fresh = await freshStart({
    withDesiredState,
    ...(singularity ? { fixture: { kind: "bitnode", n: 1, sourceFiles: { 1: 1, 4: 3 } } as const } : {}),
    beforeAgent: async (game) => {
      await toTheRedPill(game, { rooted, levelled });
      if (singularity) {
        await game.simulation.diagnostics.setHomeRam(64);
        await withoutSimEffectors(game);
      }
    },
  });
  if (withDesiredState) {
    fresh.controller().setProgramsEnabled(false);
    fresh.controller().setHomeRamEnabled(false);
  }
  // The connected Agent's first slow snapshot, so the brain knows the game's last reset before the destroy, and the
  // Agent whether the game has Singularity.
  await fresh.game.runUntil(() => fresh.latest<SlowSnapshotData>("slow") !== null, 10_000);
  return fresh;
}

type Fresh = Awaited<ReturnType<typeof readyToDestroy>>;

const slow = (fresh: Fresh) => fresh.latest<SlowSnapshotData>("slow");
const agentSessions = (fresh: Fresh, brain = fresh.brain) =>
  brain.channelEvents.flatMap((event) => (event.type === "agentConnected" ? [event.agentSessionId] : []));
const view = (views: IntentView[], id: string) => views.find((each) => each.id === id);
/** The game's BitNode entries since `simulation` booted (a reload's simulation starts its own log). */
const bitNodeEntries = async (simulation: Simulation) =>
  (await simulation.events(0)).events.filter(
    (event) => event.type === "bitnodeDestroyed" || event.type === "bitnodeFlumed",
  );

/**
 * Queues the destroy into BitNode 2, and whatever `queuedAfter` queues after it, and runs until the Agent destroys: its
 * connection to the brain closes as it dies. Returns the last BitNode reset before it.
 */
async function destroyed(fresh: Fresh, queuedAfter: () => void = () => {}) {
  const lastNodeResetBefore = slow(fresh)?.resetInfo.lastNodeReset as number;
  expect(slow(fresh)?.resetInfo).toMatchObject({ currentNode: 1 });
  expect(fresh.controller().addManualIntent({ action: "destroyBitNode", args: { nextBitNode: 2 } })).toMatchObject({
    ok: true,
  });
  queuedAfter();
  await fresh.game.runUntil(
    () => fresh.brain.channelEvents.some((event) => event.type === "agentDisconnected"),
    60_000,
  );
  return { lastNodeResetBefore };
}

/** BN2, as the latest slow snapshot shows it: the BitNode reset moved, and `sourceFiles` held. Returns that reset. */
function expectInBitNode2(fresh: Fresh, lastNodeResetBefore: number, sourceFiles: Record<string, number>): number {
  const resetInfo = slow(fresh)?.resetInfo;
  expect(resetInfo).toMatchObject({ currentNode: 2, ownedSF: sourceFiles, ownedAugs: {} });
  expect(resetInfo?.lastNodeReset).not.toBe(lastNodeResetBefore);
  return resetInfo?.lastNodeReset as number;
}

/** Still the one destroy, and no other Agent session: nothing destroyed again, 30 s on. */
async function expectDestroyedOnce(fresh: Fresh, resetAt: number, sessions: number, brain = fresh.brain) {
  await fresh.game.run(30_000);
  expect(agentSessions(fresh, brain)).toHaveLength(sessions);
  expect(slow(fresh)?.resetInfo).toMatchObject({ currentNode: 2, lastNodeReset: resetAt });
}

test("destroying BN1 into BN2 (sim): past the gate, the backdoor and the portal; the next Agent in BN2, the destroy off the queue, what's after it in BN2", async () => {
  const fresh = await readyToDestroy();
  const backupsBefore = fresh.brain.saveBackupEvents.length;
  // Queued after the destroy, the travel waits for it: with $1t now, it would be done in this BitNode.
  const { lastNodeResetBefore } = await destroyed(fresh, () => {
    fresh.controller().addManualIntent({ action: "travel", args: { city: "Aevum" } });
    expect(view(fresh.controller().intentsView(), "travel(Aevum)")?.waitingFor).toBe(
      `waiting for ${DESTROY_ID} first: queued after a destroy, it's for the next BitNode`,
    );
  });
  expect(fresh.medium()?.player.city).toBe("Sector-12");
  expect(fresh.brain.saveBackupEvents.slice(backupsBefore)).toEqual([
    expect.objectContaining({ file: expect.any(String) }),
  ]);
  // boot.js, started 500 ms after entering BN2, starts the next Agent: a new session, the same deployment.
  await fresh.game.runUntil(() => agentSessions(fresh).length === 2, 10_000);
  await fresh.game.runUntil(() => view(fresh.controller().intentsView(), DESTROY_ID) === undefined, 10_000);
  // BN1's Source-File, the first: SF1.1. Home starts at 32 GB with it (`Prestige.ts:246-253`).
  const resetAt = expectInBitNode2(fresh, lastNodeResetBefore, { 1: 1 });
  expect(await bitNodeEntries(fresh.simulation)).toEqual([
    expect.objectContaining({ type: "bitnodeDestroyed", destroyed: 1, entered: 2 }),
  ]);
  // The travel goes now, tried in BN2, where the money is the new start's: not enough for the ticket.
  await fresh.game.runUntil(
    () => (view(fresh.controller().intentsView(), "travel(Aevum)")?.outcome?.tries ?? 0) >= 1,
    15_000,
  );
  expect(view(fresh.controller().intentsView(), "travel(Aevum)")?.outcome).toMatchObject({
    done: false,
    problem: "not in Aevum after travelling (is the $200k ticket there?)",
  });
  expect(fresh.brain.saveBackupEvents.slice(backupsBefore)).toHaveLength(1);
  await expectDestroyedOnce(fresh, resetAt, 2);
  expect(await bitNodeEntries(fresh.simulation)).toHaveLength(1);
});

test("destroying (singularity): with SF4.3 and a 64 GB home, through its worker's destroyW0r1dD43m0n, which names boot.js for after it", async () => {
  const fresh = await readyToDestroy({ singularity: true });
  const { lastNodeResetBefore } = await destroyed(fresh);
  await fresh.game.runUntil(() => agentSessions(fresh).length === 2, 10_000);
  await fresh.game.runUntil(() => fresh.controller().intentsView().length === 0, 10_000);
  // SF1.1 raised to SF1.2; SF4.3 kept.
  const resetAt = expectInBitNode2(fresh, lastNodeResetBefore, { 1: 2, 4: 3 });
  expect(await bitNodeEntries(fresh.simulation)).toEqual([
    expect.objectContaining({ type: "bitnodeDestroyed", destroyed: 1, entered: 2 }),
  ]);
  await expectDestroyedOnce(fresh, resetAt, 2);
});

test.each([
  ["w0r1d_d43m0n unrooted", { rooted: false }, "no root access on w0r1d_d43m0n (NUKE.exe first)"],
  ["the hacking level short", { levelled: false }, /^hacking level \d+: w0r1d_d43m0n needs 3000$/],
])("the guard (%s): held, saying why, with no backup", async (_description, options, problem) => {
  const fresh = await readyToDestroy(options);
  const backupsBefore = fresh.brain.saveBackupEvents.length;
  fresh.controller().addManualIntent({ action: "destroyBitNode", args: { nextBitNode: 2 } });
  await fresh.game.run(30_000);
  const waitingFor = view(fresh.controller().intentsView(), DESTROY_ID)?.waitingFor;
  expect(waitingFor?.replace(/^held: /, "")).toMatch(problem);
  expect(fresh.brain.saveBackupEvents.slice(backupsBefore)).toEqual([]);
  expect(fresh.latest<FastSnapshotData>("fast")?.intents).toEqual([]);
});

/** The player's terminal history, as the game saves it: what's been typed. */
async function typedSoFar(simulation: Simulation): Promise<string[]> {
  const saveObject = JSON.parse(gunzipSync(await simulation.save()).toString("utf8"));
  return (JSON.parse(saveObject.data.PlayerSave).data as { terminalCommandHistory: string[] }).terminalCommandHistory;
}

const BEFORE_THE_RED_PILL = "w0r1d_d43m0n isn't reachable: The Red Pill isn't installed";
test.each([
  ["sim", false, "before The Red Pill", {}, BEFORE_THE_RED_PILL],
  ["sim", false, "unrooted", { rooted: false }, "no root access on w0r1d_d43m0n (NUKE.exe first)"],
  ["sim", false, "the level short", { levelled: false }, /^hacking level \d+: w0r1d_d43m0n needs 3000$/],
  ["singularity", true, "before The Red Pill", {}, BEFORE_THE_RED_PILL],
  ["singularity", true, "unrooted", { rooted: false }, "no root access on w0r1d_d43m0n (NUKE.exe first)"],
  ["singularity", true, "the level short", { levelled: false }, /^hacking level \d+: w0r1d_d43m0n needs 3000$/],
])(
  "the effector's own refusals (%s, %#), past no gate: in the guard's words, nothing typed",
  async (backend, singularity, setup, options, problem) => {
    const fresh =
      setup === "before The Red Pill"
        ? await freshStart({
            withDesiredState: false,
            ...(singularity ? { fixture: { kind: "bitnode", n: 1, sourceFiles: { 1: 1, 4: 3 } } as const } : {}),
            beforeAgent: async (game) => {
              if (!singularity) return;
              await game.simulation.diagnostics.setHomeRam(64);
              await withoutSimEffectors(game);
            },
          })
        : await readyToDestroy({ singularity, withDesiredState: false, ...options });
    await fresh.game.runUntil(() => fresh.latest("slow") !== null, 15_000);
    const typedBefore = await typedSoFar(fresh.simulation);
    const destroy = { id: DESTROY_ID, action: "destroyBitNode" as const, args: { nextBitNode: 2 } };
    fresh.brain.channel.setDesiredState({ hackLoop: { enabled: false, target: null, hosts: [] }, intents: [destroy] });
    const outcome = () => fresh.latest<FastSnapshotData>("fast")?.intents?.[0];
    await fresh.game.runUntil(() => (outcome()?.tries ?? 0) >= 1, 15_000);
    expect(outcome()).toMatchObject({ done: false, backend });
    expect(outcome()?.problem).toMatch(problem);
    expect(await typedSoFar(fresh.simulation)).toEqual(typedBefore);
    expect((await fresh.simulation.summary()).bitNodeN).toBe(1);
    expect((await fresh.simulation.diagnostics.game()).page).toBe("Terminal");
  },
);

test("the brain down mid-destroy: the restarted brain, the note in its store, drops it on BN2's slow snapshot: never sent again", async () => {
  const fresh = await readyToDestroy();
  const { lastNodeResetBefore } = await destroyed(fresh);
  fresh.brain.stop();
  await fresh.game.run(30_000);
  const restarted = startBrainInSimulation(fresh.game, {
    build: fresh.build,
    data: fresh.data,
    withDesiredState: true,
  });
  const controller = restarted.desiredState;
  if (!controller) throw new Error("no controller");
  await fresh.game.runUntil(() => agentSessions(fresh, restarted).length === 1, 60_000);
  await fresh.game.runUntil(() => controller.intentsView().length === 0, 70_000);
  const resetAt = expectInBitNode2(fresh, lastNodeResetBefore, { 1: 1 });
  // Never sent to the next Agent: none of its fast snapshots names it.
  const sentAgain = restarted.channelEvents.some(
    (event) =>
      event.type === "snapshotReceived" &&
      event.snapshot.tier === "fast" &&
      ((event.snapshot.data as FastSnapshotData).intents ?? []).some((each) => each.id === DESTROY_ID),
  );
  expect(sentAgain).toBe(false);
  await expectDestroyedOnce(fresh, resetAt, 1, restarted);
  expect(await bitNodeEntries(fresh.simulation)).toHaveLength(1);
});

test("a save-then-reload just after the destroy, before boot.js's 500 ms: autoexec brings the Agent back in BN2; done once", async () => {
  const fresh = await readyToDestroy();
  const { lastNodeResetBefore } = await destroyed(fresh);
  // Step by step until the portal's look (every 100 ms) has entered BN2: boot.js starts 500 ms later, so not yet.
  for (let step = 0; (await fresh.simulation.diagnostics.game()).page !== "Terminal"; step++) {
    if (step > 10) throw new Error("never left the BitVerse");
    await fresh.game.step();
  }
  expect(await bitNodeEntries(fresh.simulation)).toHaveLength(1);
  expect((await fresh.simulation.ps("home")).filter((process) => process.filename.endsWith("/agent.js"))).toEqual([]);
  const reloaded = await fresh.reload();
  await fresh.game.runUntil(() => agentSessions(fresh).length === 2, 15_000);
  await fresh.game.runUntil(() => fresh.controller().intentsView().length === 0, 70_000);
  const resetAt = expectInBitNode2(fresh, lastNodeResetBefore, { 1: 1 });
  await expectDestroyedOnce(fresh, resetAt, 2);
  expect(await bitNodeEntries(reloaded)).toEqual([]);
});

test("a save that starts at the BitVerse (w0r1d_d43m0n backdoored, no portal picked): autoexec's Agent there, the destroy past its gate, entered from the BitVerse", async () => {
  // The owner's backdoor on w0r1d_d43m0n, typed into the terminal (the simulator's own backdoor): the BitVerse.
  const fresh = await freshStart({
    withDesiredState: true,
    beforeAgent: async (game) => {
      await toTheRedPill(game);
      await ownerRunsOnHome(
        game,
        `export async function main(ns) { globalThis.${AGENT_SIM_EFFECTORS_GLOBAL}.backdoorServer("${DAEMON}"); }`,
      );
      // Its time is hacking time / 4: a few seconds here.
      await game.game.run(10_000);
      expect((await game.simulation.diagnostics.game()).page).toBe("BitVerse");
    },
  });
  fresh.controller().setProgramsEnabled(false);
  fresh.controller().setHomeRamEnabled(false);
  // The game saved there and loaded: it starts at the BitVerse, with no cinematic, and autoexec starts the Agent.
  const reloaded = await fresh.reload();
  expect((await reloaded.diagnostics.game()).page).toBe("BitVerse");
  const typedBefore = await typedSoFar(reloaded);
  await fresh.game.runUntil(() => agentSessions(fresh).length === 2, 15_000);
  await fresh.game.runUntil(() => slow(fresh)?.resetInfo.currentNode === 1, 10_000);
  // The hack loop rooted CSEC before the backdoor on w0r1d_d43m0n, and the level is 3042: the brain asks for CSEC's
  // backdoor (#195), which the page can't type at the BitVerse (no sidebar), so neither does the simulator's effector.
  const csecTried = () =>
    fresh.latest<FastSnapshotData>("fast")?.intents.find((outcome) => outcome.id === "backdoor(CSEC)");
  await fresh.game.runUntil(() => (csecTried()?.tries ?? 0) >= 1, 15_000);
  expect(csecTried()).toMatchObject({
    done: false,
    backend: "sim",
    problem: 'no "Terminal" in the sidebar (is its section collapsed?)',
  });
  const lastNodeResetBefore = slow(fresh)?.resetInfo.lastNodeReset as number;
  fresh.controller().addManualIntent({ action: "destroyBitNode", args: { nextBitNode: 2 } });
  await fresh.game.runUntil(() => agentSessions(fresh).length === 3, 60_000);
  // Nothing typed at the BitVerse: no `connect`, no second `backdoor`, no backdoor on CSEC.
  expect(await typedSoFar(reloaded)).toEqual(typedBefore);
  await fresh.game.runUntil(() => fresh.controller().intentsView().length === 0, 10_000);
  const resetAt = expectInBitNode2(fresh, lastNodeResetBefore, { 1: 1 });
  expect(await bitNodeEntries(reloaded)).toEqual([
    expect.objectContaining({ type: "bitnodeDestroyed", destroyed: 1, entered: 2 }),
  ]);
  // Straight to the portal: the BitVerse reached once, as the save started there, never by a second backdoor.
  const reached = (await reloaded.events(0)).events.filter((event) => event.type === "bitverseReached");
  expect(reached).toHaveLength(1);
  await expectDestroyedOnce(fresh, resetAt, 3);
});

test("at the BitVerse (#195), the simulator's backdoor sends no terminal home from a server it backdoored: no sidebar there", async () => {
  const effectors = `globalThis.${AGENT_SIM_EFFECTORS_GLOBAL}`;
  const fresh = await freshStart({
    withDesiredState: false,
    // Singularity's `connect`, for the owner's terminal at the BitVerse.
    fixture: { kind: "bitnode", n: 1, sourceFiles: { 1: 1, 4: 3 } } as const,
    beforeAgent: async (game) => {
      await toTheRedPill(game);
      // CSEC backdoored by the simulator's own effector: its terminal left there until a try sends it home.
      await ownerRunsOnHome(
        game,
        `export async function main(ns) { ns.brutessh("CSEC"); ns.nuke("CSEC"); ${effectors}.backdoorServer("CSEC"); }`,
      );
      await game.game.run(30_000);
      await ownerRunsOnHome(game, `export async function main(ns) { ${effectors}.backdoorServer("${DAEMON}"); }`);
      await game.game.run(10_000);
      expect((await game.simulation.diagnostics.game()).page).toBe("BitVerse");
    },
  });
  // The owner's terminal on CSEC again, at the BitVerse.
  await ownerRunsOnHome(fresh, 'export async function main(ns) { ns.singularity.connect("CSEC"); }');
  const savedPlayer = async () =>
    JSON.parse(JSON.parse(gunzipSync(await fresh.simulation.save()).toString("utf8")).data.PlayerSave).data as {
      currentServer: string;
    };
  expect((await savedPlayer()).currentServer).toBe("CSEC");
  const typedBefore = await typedSoFar(fresh.simulation);
  await ownerRunsOnHome(fresh, `export async function main(ns) { ${effectors}.backdoorServer("CSEC"); }`);
  expect(await typedSoFar(fresh.simulation)).toEqual(typedBefore);
  expect((await savedPlayer()).currentServer).toBe("CSEC");
});
test("into BN6 (sim): the Bladeburner cinematic left as its Continue does, so the next Agent starts on the Terminal", async () => {
  const fresh = await readyToDestroy();
  expect(fresh.controller().addManualIntent({ action: "destroyBitNode", args: { nextBitNode: 6 } })).toMatchObject({
    ok: true,
  });
  await fresh.game.runUntil(() => agentSessions(fresh).length === 2, 70_000);
  await fresh.game.runUntil(() => fresh.controller().intentsView().length === 0, 70_000);
  expect(slow(fresh)?.resetInfo).toMatchObject({ currentNode: 6, ownedSF: { 1: 1 } });
  expect((await fresh.simulation.diagnostics.game()).page).toBe("Terminal");
});
