// The Effectors' `sim` and `singularity` backends in the simulator (#145): the brain sends intents, and the Agent does
// them through the simulator's own effectors, or, in a game with SF4.3, through its Singularity workers. The `ui`
// backend is E2's (packages/e2/test/effectors.e2.test.ts): the simulator renders no page. Joining a faction (#147) goes
// through the brain's gate for irreversible intents: two medium snapshots with its guard holding, then a save backup.
// Buying augmentations (#149): from a faction joined with reputation, NeuroFlux Governor a level at a time.
import { gunzipSync } from "node:zlib";
import {
  type DesiredState,
  type FastSnapshotData,
  type Intent,
  type IntentRequest,
  intentId,
  type MediumSnapshotData,
  type Work,
} from "@bitburner-agent/core";
import { expect, test } from "vitest";
import { useFreshStarts, withoutSimEffectors } from "./helpers/fresh-start.ts";

const freshStart = useFreshStarts();
const intent = (request: IntentRequest): Intent => ({ ...request, id: intentId(request.action, request.args) });
const HACK_LOOP_OFF: DesiredState["hackLoop"] = { enabled: false, target: null, hosts: [] };
const homeRamOf = (medium: MediumSnapshotData | null) =>
  medium?.servers.find((server) => server.hostname === "home")?.maxRam;

/** The four actions of #141, home's RAM upgraded from `homeRam`. In order: the TOR router before a program. */
const fourActions = (homeRam: number) => [
  intent({ action: "buyTor", args: { vendor: "Alpha Enterprises" } }),
  intent({ action: "buyProgram", args: { program: "BruteSSH.exe" } }),
  intent({ action: "upgradeHomeRam", args: { fromRam: homeRam, vendor: "Alpha Enterprises" } }),
  intent({ action: "travel", args: { city: "Aevum" } }),
];
/** Whether the medium snapshot shows all four done. */
const allFourDone = (medium: MediumSnapshotData | null, homeRam: number) =>
  medium?.hasTorRouter === true &&
  medium.programs.includes("BruteSSH.exe") &&
  homeRamOf(medium) === homeRam * 2 &&
  medium.player.city === "Aevum";

test("sim backend: with money, each action is done through the simulator's own effectors", async () => {
  const fresh = await freshStart({
    withDesiredState: false,
    beforeAgent: async ({ simulation }) => simulation.diagnostics.setMoney(1e10),
  });
  fresh.brain.channel.setDesiredState({ hackLoop: HACK_LOOP_OFF, intents: fourActions(8) });
  await fresh.game.runUntil(() => allFourDone(fresh.medium(), 8), 30_000);
  const outcomes = fresh.latest<FastSnapshotData>("fast")?.intents ?? [];
  expect(outcomes.map(({ done, backend }) => [done, backend])).toEqual(Array(4).fill([true, "sim"]));
});

test("sim backend: without the money, each is not done, with the reason, and tried again in 30 s", async () => {
  const fresh = await freshStart({
    withDesiredState: false,
    beforeAgent: async ({ simulation }) => simulation.diagnostics.setMoney(0),
  });
  fresh.brain.channel.setDesiredState({ hackLoop: HACK_LOOP_OFF, intents: fourActions(8) });
  // Two tries each: at once (once the intents arrive), then 30 s later.
  await fresh.game.run(36_000);
  const outcomes = fresh.latest<FastSnapshotData>("fast")?.intents ?? [];
  expect(outcomes.map(({ done, tries, backend }) => [done, tries, backend])).toEqual(Array(4).fill([false, 2, "sim"]));
  expect(outcomes.map((outcome) => outcome.problem)).toEqual([
    "the game didn't sell the TOR router (is the money there?)",
    "no TOR router to buy programs through",
    "the game didn't upgrade home's RAM (is the money there?)",
    "not in Aevum after travelling (is the $200k ticket there?)",
  ]);
});

test("singularity backend: in BN1 with SF1.1 and SF4.3, the simulator's effectors taken away, each through its Singularity worker", async () => {
  // SF1.1 starts home at 32 GB, room for any Singularity worker beside the Agent.
  const fresh = await freshStart({
    withDesiredState: false,
    fixture: { kind: "bitnode", n: 1, sourceFiles: { 1: 1, 4: 3 } },
    beforeAgent: async (game) => {
      await game.simulation.diagnostics.setMoney(1e10);
      await withoutSimEffectors(game);
    },
  });
  expect(homeRamOf(fresh.medium())).toBeUndefined();
  await fresh.game.runUntil(() => homeRamOf(fresh.medium()) !== undefined, 15_000);
  const homeRam = homeRamOf(fresh.medium()) as number;
  fresh.brain.channel.setDesiredState({ hackLoop: HACK_LOOP_OFF, intents: fourActions(homeRam) });
  await fresh.game.runUntil(() => allFourDone(fresh.medium(), homeRam), 30_000);
  const outcomes = fresh.latest<FastSnapshotData>("fast")?.intents ?? [];
  expect(outcomes.map(({ done, backend }) => [done, backend])).toEqual(Array(4).fill([true, "singularity"]));
});

/**
 * A fresh start with the brain's desired state and $20m: a new game is in Sector-12, so the game invites the player to
 * Sector-12 within its 2 s check. Purchases off, so only the owner's queue moves the game.
 */
async function withTwentyMillion(options: { singularity: boolean }) {
  const fresh = await freshStart({
    withDesiredState: true,
    ...(options.singularity ? { fixture: { kind: "bitnode", n: 1, sourceFiles: { 1: 1, 4: 3 } } as const } : {}),
    beforeAgent: async (game) => {
      await game.simulation.diagnostics.setMoney(2e7);
      if (options.singularity) await withoutSimEffectors(game);
    },
  });
  fresh.controller().setProgramsEnabled(false);
  fresh.controller().setHomeRamEnabled(false);
  return fresh;
}

type FreshWithMoney = Awaited<ReturnType<typeof withTwentyMillion>>;

/** The factions joined, as the latest medium snapshot says. */
const joined = (fresh: FreshWithMoney) => (fresh.medium()?.player.factions as string[] | undefined) ?? [];

/** The Agent's log lines naming `text`. */
async function agentLogLines(fresh: FreshWithMoney, text: string) {
  const [agent] = (await fresh.simulation.ps("home")).filter((process) => process.filename.endsWith("/agent.js"));
  if (!agent) throw new Error("no Agent on home");
  return (await fresh.simulation.logs(agent.pid)).filter((line) => line.includes(text));
}

/**
 * Queues joining `faction` and runs until the brain sends it, checking it waited: at least two medium snapshots from
 * the Agent, and a save backup that succeeded, between the queueing and the sending.
 */
async function joinedThroughTheGate(fresh: FreshWithMoney, faction: string) {
  const channelEventsBefore = fresh.brain.channelEvents.length;
  const backupEventsBefore = fresh.brain.saveBackupEvents.length;
  expect(fresh.controller().addManualIntent({ action: "joinFaction", args: { faction } })).toMatchObject({ ok: true });
  const view = () =>
    fresh
      .controller()
      .intentsView()
      .find((each) => each.id === `joinFaction(${faction})`);
  expect(view()?.waitingFor).toMatch(/^waiting for the guard to hold on 2 consecutive medium snapshots/);
  await fresh.game.runUntil(() => view()?.waitingFor === null, 60_000);
  const mediumsBeforeSending = fresh.brain.channelEvents
    .slice(channelEventsBefore)
    .filter((event) => event.type === "snapshotReceived" && event.snapshot.tier === "medium").length;
  expect(mediumsBeforeSending).toBeGreaterThanOrEqual(2);
  expect(fresh.brain.saveBackupEvents.slice(backupEventsBefore)).toContainEqual(
    expect.objectContaining({ file: expect.any(String) }),
  );
}
test("joining Sector-12 (sim): sent only after two medium snapshots and a save backup, then done; its enemies are held", async () => {
  const fresh = await withTwentyMillion({ singularity: false });
  await joinedThroughTheGate(fresh, "Sector-12");
  await fresh.game.runUntil(() => joined(fresh).includes("Sector-12"), 15_000);
  // Done, and reported so: the queue drops it.
  expect(await agentLogLines(fresh, "join Sector-12")).toEqual(["agent: join Sector-12 (sim): done"]);
  await fresh.game.runUntil(() => fresh.controller().intentsView().length === 0, 5_000);
  // Sector-12 bans Chongqing: joining it now is held by the guard, saying why.
  fresh.controller().addManualIntent({ action: "joinFaction", args: { faction: "Chongqing" } });
  await fresh.game.run(11_000);
  expect(
    fresh
      .controller()
      .intentsView()
      .find((each) => each.id === "joinFaction(Chongqing)")?.waitingFor,
  ).toBe("held: Chongqing's enemy Sector-12 is joined");
});

test("joining without an invitation (sim): not done, with the reason; a faction with no enemies goes out at once", async () => {
  const fresh = await withTwentyMillion({ singularity: false });
  fresh.controller().addManualIntent({ action: "joinFaction", args: { faction: "CyberSec" } });
  expect(fresh.controller().intentsView()[0]?.waitingFor).toBeNull();
  await fresh.game.runUntil(() => (fresh.latest<FastSnapshotData>("fast")?.intents?.[0]?.tries ?? 0) >= 1, 10_000);
  expect(fresh.latest<FastSnapshotData>("fast")?.intents).toEqual([
    {
      id: "joinFaction(CyberSec)",
      done: false,
      tries: 1,
      problem: "not a member of CyberSec after joining (is there an invitation?)",
      backend: "sim",
    },
  ]);
  expect(joined(fresh)).toEqual([]);
});

test("joining Sector-12 (singularity): with SF4.3, through its Singularity worker, past the same gate", async () => {
  const fresh = await withTwentyMillion({ singularity: true });
  await joinedThroughTheGate(fresh, "Sector-12");
  await fresh.game.runUntil(() => joined(fresh).includes("Sector-12"), 15_000);
  expect(await agentLogLines(fresh, "join Sector-12")).toEqual(["agent: join Sector-12 (singularity): done"]);
});

const NEUROTRAINER = intent({
  action: "purchaseAugmentation",
  args: { faction: "CyberSec", augmentation: "Neurotrainer I", level: 1 },
});
const neuroFlux = (level: number) =>
  intent({ action: "purchaseAugmentation", args: { faction: "CyberSec", augmentation: "NeuroFlux Governor", level } });

/** A fresh start with `money`, in CyberSec with plenty of reputation, as the test sets it: the backend's to buy from. */
function inCyberSec(money: number, options: { singularity: boolean } = { singularity: false }) {
  return freshStart({
    withDesiredState: false,
    ...(options.singularity ? { fixture: { kind: "bitnode", n: 1, sourceFiles: { 1: 1, 4: 3 } } as const } : {}),
    beforeAgent: async (game) => {
      await game.simulation.diagnostics.setMoney(money);
      await game.simulation.diagnostics.joinFactionWithReputation("CyberSec", 1e6);
      if (options.singularity) await withoutSimEffectors(game);
    },
  });
}

/** The Agent's latest outcome for `id`, once it has tried it, or undefined. */
async function triedOnce(fresh: Awaited<ReturnType<typeof inCyberSec>>, id: string) {
  const outcome = () => fresh.latest<FastSnapshotData>("fast")?.intents?.find((each) => each.id === id);
  await fresh.game.runUntil(() => (outcome()?.tries ?? 0) >= 1, 10_000);
  return outcome();
}

/** Runs until the Agent reports each of `intents` done, or `timeoutMs` passes; their outcomes. */
async function boughtEach(fresh: Awaited<ReturnType<typeof inCyberSec>>, intents: Intent[], timeoutMs = 30_000) {
  fresh.brain.channel.setDesiredState({ hackLoop: HACK_LOOP_OFF, intents });
  const outcomes = () => fresh.latest<FastSnapshotData>("fast")?.intents ?? [];
  await fresh.game.runUntil(
    () => outcomes().length === intents.length && outcomes().every((each) => each.done),
    timeoutMs,
  );
  return outcomes();
}

test("buying augmentations (sim): Neurotrainer I, then NeuroFlux levels 1 and 2, each paid for once", async () => {
  const fresh = await inCyberSec(1e10);
  const outcomes = await boughtEach(fresh, [NEUROTRAINER, neuroFlux(1), neuroFlux(2)]);
  expect(outcomes.map(({ id, done, tries, backend }) => [id, done, tries, backend])).toEqual([
    [NEUROTRAINER.id, true, 1, "sim"],
    [neuroFlux(1).id, true, 1, "sim"],
    [neuroFlux(2).id, true, 1, "sim"],
  ]);
  const moneyAfter = fresh.money() as number;
  // Sent again, as new intents: each is done from the game alone, and nothing more is paid.
  fresh.brain.channel.setDesiredState({ hackLoop: HACK_LOOP_OFF, intents: [] });
  await fresh.game.run(2_000);
  const again = await boughtEach(fresh, [NEUROTRAINER, neuroFlux(2)]);
  expect(again.every((each) => each.done)).toBe(true);
  expect(fresh.money()).toBe(moneyAfter);
  // NeuroFlux is at level 2 exactly: level 4 is out of turn, the next being 3.
  fresh.brain.channel.setDesiredState({ hackLoop: HACK_LOOP_OFF, intents: [neuroFlux(4)] });
  expect((await triedOnce(fresh, neuroFlux(4).id))?.problem).toBe(
    "NeuroFlux Governor's next level is 3, not 4: the levels before it come first",
  );
});

test("buying augmentations (sim): a NeuroFlux level out of turn waits, and without the money nothing is bought", async () => {
  const fresh = await inCyberSec(0);
  fresh.brain.channel.setDesiredState({ hackLoop: HACK_LOOP_OFF, intents: [NEUROTRAINER, neuroFlux(2)] });
  await fresh.game.runUntil(() => {
    const outcomes = fresh.latest<FastSnapshotData>("fast")?.intents ?? [];
    return outcomes.length === 2 && outcomes.every((each) => each.tries >= 1);
  }, 10_000);
  expect(fresh.latest<FastSnapshotData>("fast")?.intents?.map(({ done, problem }) => [done, problem])).toEqual([
    [false, "can't buy Neurotrainer I from CyberSec yet (the money, the reputation or a prerequisite?)"],
    [false, "NeuroFlux Governor's next level is 1, not 2: the levels before it come first"],
  ]);
  // As the page: its Buy is disabled, so nothing was tried, and no dialog says why not.
  const alerts = (await fresh.simulation.events(0)).events.filter((event) => event.type === "alert");
  expect(alerts.map((event) => ("text" in event ? event.text : ""))).not.toContainEqual(
    expect.stringMatching(/afford|enough money/),
  );
});

test("buying augmentations (singularity): with SF4.3, through its Singularity worker, levels in turn, refused without money", async () => {
  const fresh = await inCyberSec(1e10, { singularity: true });
  await fresh.game.runUntil(() => fresh.medium() !== null, 15_000);
  const outcomes = await boughtEach(fresh, [NEUROTRAINER, neuroFlux(1), neuroFlux(2)]);
  expect(outcomes.map(({ done, tries, backend }) => [done, tries, backend])).toEqual([
    [true, 1, "singularity"],
    [true, 1, "singularity"],
    [true, 1, "singularity"],
  ]);
  const moneyAfter = fresh.money() as number;
  // Sent again as new intents, owned ones are done from the game alone; a NeuroFlux level out of turn isn't bought.
  fresh.brain.channel.setDesiredState({ hackLoop: HACK_LOOP_OFF, intents: [] });
  await fresh.game.run(2_000);
  fresh.brain.channel.setDesiredState({ hackLoop: HACK_LOOP_OFF, intents: [NEUROTRAINER, neuroFlux(2), neuroFlux(4)] });
  await fresh.game.runUntil(() => {
    const again = fresh.latest<FastSnapshotData>("fast")?.intents ?? [];
    return again.length === 3 && again.every((each) => each.tries >= 1);
  }, 15_000);
  expect(fresh.latest<FastSnapshotData>("fast")?.intents?.map(({ done, problem }) => [done, problem])).toEqual([
    [true, null],
    [true, null],
    [false, "NeuroFlux Governor's next level is 3, not 4: the levels before it come first"],
  ]);
  expect(fresh.money()).toBe(moneyAfter);
  // Without the money, Singularity's refusal (which says no more than false).
  await fresh.simulation.diagnostics.setMoney(0);
  const signalProcessors = intent({
    action: "purchaseAugmentation",
    args: { faction: "CyberSec", augmentation: "Cranial Signal Processors - Gen I", level: 1 },
  });
  fresh.brain.channel.setDesiredState({ hackLoop: HACK_LOOP_OFF, intents: [signalProcessors] });
  expect(await triedOnce(fresh, signalProcessors.id)).toMatchObject({
    done: false,
    problem:
      "the game refused Cranial Signal Processors - Gen I from CyberSec (joined? sold by it? the money, the reputation, a prerequisite?)",
  });
});

/** The player's work and focus, as the game saves them: `null` for none. */
async function savedWork(fresh: { simulation: { save(): Promise<Uint8Array> } }) {
  const saveObject = JSON.parse(gunzipSync(await fresh.simulation.save()).toString("utf8"));
  const player = JSON.parse(saveObject.data.PlayerSave).data;
  const work = player.currentWork?.data;
  return work ? { faction: work.factionName, workType: work.factionWorkType, focus: player.focus } : null;
}

/** A fresh start in Sector-12 (which offers all three kinds of work), the hack loop off. */
function inSectorTwelve(options: { singularity: boolean } = { singularity: false }) {
  return freshStart({
    withDesiredState: false,
    ...(options.singularity ? { fixture: { kind: "bitnode", n: 1, sourceFiles: { 1: 1, 4: 3 } } as const } : {}),
    beforeAgent: async (game) => {
      await game.simulation.diagnostics.joinFactionWithReputation("Sector-12", 0);
      if (options.singularity) await withoutSimEffectors(game);
    },
  });
}

/**
 * Sends `work` and runs until the Agent reports it converged (or not, with `converged` false), in a fast snapshot taken
 * after the change: the one before may still show the last work's.
 */
async function workedAt(fresh: Awaited<ReturnType<typeof inSectorTwelve>>, work: Work | null, converged = true) {
  const fastSnapshotsBefore = fresh.brain.channelEvents.filter(isFastSnapshot).length;
  fresh.brain.channel.setDesiredState({ hackLoop: HACK_LOOP_OFF, intents: [], ...(work === null ? {} : { work }) });
  const outcome = () => fresh.latest<FastSnapshotData>("fast")?.work;
  // The Agent converges after the round's snapshots, so a fast snapshot after the change may show the work just reset
  // (no backend yet): the one that counts names its backend.
  const reportedSince = () => fresh.brain.channelEvents.filter(isFastSnapshot).length - fastSnapshotsBefore >= 2;
  const tried = () => reportedSince() && outcome()?.backend != null && outcome()?.converged === converged;
  if (work !== null) await fresh.game.runUntil(tried, 15_000);
  else await fresh.game.run(4_000);
  return outcome();
}

const isFastSnapshot = (event: { type: string; snapshot?: { tier: string } }) =>
  event.type === "snapshotReceived" && event.snapshot?.tier === "fast";
const sectorWork = (workType: Work["workType"], focus: boolean): Work => ({
  kind: "faction",
  faction: "Sector-12",
  workType,
  focus,
});

test("work (sim, #151): started focused, unfocused, switched; left alone when none is wanted", async () => {
  const fresh = await inSectorTwelve();
  expect(await workedAt(fresh, sectorWork("hacking", true))).toEqual({
    converged: true,
    problem: null,
    backend: "sim",
  });
  expect(await savedWork(fresh)).toEqual({ faction: "Sector-12", workType: "hacking", focus: true });
  expect((await fresh.simulation.diagnostics.game()).page).toBe("Work");
  await workedAt(fresh, sectorWork("hacking", false));
  expect(await savedWork(fresh)).toEqual({ faction: "Sector-12", workType: "hacking", focus: false });
  expect((await fresh.simulation.diagnostics.game()).page).not.toBe("Work");
  await workedAt(fresh, sectorWork("field", false));
  expect(await savedWork(fresh)).toEqual({ faction: "Sector-12", workType: "field", focus: false });
  // None wanted: the work is the game's, untouched.
  expect(await workedAt(fresh, null)).toBeNull();
  expect(await savedWork(fresh)).toEqual({ faction: "Sector-12", workType: "field", focus: false });
});

test("work (sim, #151): a faction joined that doesn't offer the work isn't converged, with the reason", async () => {
  const fresh = await inSectorTwelve();
  // Joined, but CyberSec offers only hacking contracts.
  await fresh.simulation.diagnostics.joinFactionWithReputation("CyberSec", 0);
  const notOffered: Work = { kind: "faction", faction: "CyberSec", workType: "field", focus: true };
  expect(await workedAt(fresh, notOffered, false)).toMatchObject({
    converged: false,
    problem: "not focused on field work for CyberSec (is it joined, and does it offer it?)",
  });
  expect(await savedWork(fresh)).toBeNull();
});

test("work (singularity, #151): with SF4.3, started focused and unfocused through its Singularity worker", async () => {
  const fresh = await inSectorTwelve({ singularity: true });
  await fresh.game.runUntil(() => fresh.medium() !== null, 15_000);
  expect(await workedAt(fresh, sectorWork("security", true))).toMatchObject({
    converged: true,
    backend: "singularity",
  });
  expect(await savedWork(fresh)).toEqual({ faction: "Sector-12", workType: "security", focus: true });
  await workedAt(fresh, sectorWork("security", false));
  expect(await savedWork(fresh)).toEqual({ faction: "Sector-12", workType: "security", focus: false });
  // Another type, focused: `workForFaction` switches it.
  await workedAt(fresh, sectorWork("field", true));
  expect(await savedWork(fresh)).toEqual({ faction: "Sector-12", workType: "field", focus: true });
});
