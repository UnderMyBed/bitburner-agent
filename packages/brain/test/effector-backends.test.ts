// The Effectors' `sim` and `singularity` backends in the simulator (#145): the brain sends intents, and the Agent does
// them through the simulator's own effectors, or, in a game with SF4.3, through its Singularity workers. The `ui`
// backend is E2's (packages/e2/test/effectors.e2.test.ts): the simulator renders no page. Joining a faction (#147) goes
// through the brain's gate for irreversible intents: two medium snapshots with its guard holding, then a save backup.
// Buying augmentations (#149): from a faction joined with reputation, NeuroFlux Governor a level at a time. Work
// (#151, #153): faction work, and company work, the job applied for first. Buying a cloud server (#159): one NS worker
// for the page's backend and Singularity's alike.
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
import { ownerRunsOnHome, useFreshStarts, withoutSimEffectors } from "./helpers/fresh-start.ts";

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
const sectorWork = (workType: Extract<Work, { kind: "faction" }>["workType"], focus: boolean): Work => ({
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

/** The player's company work, its job there, and focus, as the game saves them: `null` for none. */
async function savedCompanyWork(fresh: { simulation: { save(): Promise<Uint8Array> } }) {
  const saveObject = JSON.parse(gunzipSync(await fresh.simulation.save()).toString("utf8"));
  const player = JSON.parse(saveObject.data.PlayerSave).data;
  const work = player.currentWork;
  if (work?.ctor !== "CompanyWork") return null;
  const company = work.data.companyName;
  return { company, job: player.jobs[company], focus: player.focus };
}

/** A fresh start in Sector-12 with money for a ticket, the hack loop off. */
function withTicketMoney(options: { singularity: boolean } = { singularity: false }) {
  return freshStart({
    withDesiredState: false,
    ...(options.singularity ? { fixture: { kind: "bitnode", n: 1, sourceFiles: { 1: 1, 4: 3 } } as const } : {}),
    beforeAgent: async (game) => {
      await game.simulation.diagnostics.setMoney(1e10);
      if (options.singularity) await withoutSimEffectors(game);
    },
  });
}

const noodleBar = (focus: boolean): Work => ({ kind: "company", company: "Noodle Bar", field: "Waiter", focus });

/** Sends a travel to `city` and runs until the medium snapshot shows the player there. */
async function travelledTo(fresh: Awaited<ReturnType<typeof withTicketMoney>>, city: string) {
  fresh.brain.channel.setDesiredState({
    hackLoop: HACK_LOOP_OFF,
    intents: [intent({ action: "travel", args: { city } })],
  });
  await fresh.game.runUntil(() => fresh.medium()?.player.city === city, 30_000);
}

test("company work (sim, #153): in New Tokyo, a Waiter at Noodle Bar, focused, then unfocused; the job held, from any city", async () => {
  const fresh = await withTicketMoney();
  await travelledTo(fresh, "New Tokyo");
  expect(await workedAt(fresh, noodleBar(true))).toEqual({ converged: true, problem: null, backend: "sim" });
  expect(await savedCompanyWork(fresh)).toEqual({ company: "Noodle Bar", job: "Waiter", focus: true });
  expect((await fresh.simulation.diagnostics.game()).page).toBe("Work");
  await workedAt(fresh, noodleBar(false));
  expect(await savedCompanyWork(fresh)).toEqual({ company: "Noodle Bar", job: "Waiter", focus: false });
  expect((await fresh.simulation.diagnostics.game()).page).not.toBe("Work");
  // Back in Sector-12, working for its faction meanwhile: the job held is worked again from there, as the Job page does.
  await travelledTo(fresh, "Sector-12");
  await fresh.simulation.diagnostics.joinFactionWithReputation("Sector-12", 0);
  await workedAt(fresh, { kind: "faction", faction: "Sector-12", workType: "hacking", focus: false });
  expect(await savedCompanyWork(fresh)).toBeNull();
  expect(await workedAt(fresh, noodleBar(true))).toEqual({ converged: true, problem: null, backend: "sim" });
  expect(await savedCompanyWork(fresh)).toEqual({ company: "Noodle Bar", job: "Waiter", focus: true });
});

test("company work (sim, #153): not in the company's city, or not qualified, isn't converged, with the reason", async () => {
  const fresh = await withTicketMoney();
  expect(await workedAt(fresh, noodleBar(true), false)).toMatchObject({
    converged: false,
    problem: "no Noodle Bar in the city (is the player in its city?)",
  });
  // MegaCorp is in Sector-12, but its first software job wants more hacking than a new game has.
  const software: Work = { kind: "company", company: "MegaCorp", field: "Software", focus: true };
  expect(await workedAt(fresh, software, false)).toMatchObject({
    converged: false,
    problem: "not qualified for a Software job at MegaCorp yet",
  });
  // DeltaOne offers Business from Operations Manager up, which the page lists only once the player qualifies.
  const business: Work = { kind: "company", company: "DeltaOne", field: "Business", focus: true };
  expect(await workedAt(fresh, business, false)).toMatchObject({
    converged: false,
    problem: "no Business job open to the player at DeltaOne (none offered, or not qualified yet)",
  });
  expect(await savedCompanyWork(fresh)).toBeNull();
});

test("company work (singularity, #153): with SF4.3, through its Singularity worker, from any city", async () => {
  const fresh = await withTicketMoney({ singularity: true });
  await fresh.game.runUntil(() => fresh.medium() !== null, 15_000);
  // Singularity's `applyToCompany` and `workForCompany` don't ask where the player is: Noodle Bar from Sector-12,
  // started unfocused, then focused.
  expect(await workedAt(fresh, noodleBar(false))).toMatchObject({ converged: true, backend: "singularity" });
  expect(await savedCompanyWork(fresh)).toEqual({ company: "Noodle Bar", job: "Waiter", focus: false });
  await workedAt(fresh, noodleBar(true));
  expect(await savedCompanyWork(fresh)).toEqual({ company: "Noodle Bar", job: "Waiter", focus: true });
  const software: Work = { kind: "company", company: "MegaCorp", field: "Software", focus: true };
  expect(await workedAt(fresh, software, false)).toMatchObject({
    converged: false,
    problem: "MegaCorp didn't hire for a Software job (not qualified yet, or not offered to applyToCompany)",
  });
});

const server = (hostname: string, ram = 8) => intent({ action: "buyServer", args: { hostname, ram } });
/** An 8 GB server's price in BN1: 55,000 a GB (`Server/data/Constants.ts:4`). */
const EIGHT_GB_PRICE = 8 * 55_000;

/** The owner's script that buys 1 GB servers until the game refuses: the BitNode's limit, 25. */
const BUY_TO_THE_LIMIT = 'export async function main(ns) { while (ns.cloud.purchaseServer("owners", 1) !== "") {} }';

/**
 * A fresh start with `money`, the simulator's effectors taken away unless `sim`, in a game with SF4.3 if `singularity`,
 * and the owner's servers bought to the limit first if `atTheLimit`.
 */
function forServers(
  money: number,
  { sim, singularity, atTheLimit = false }: { sim: boolean; singularity: boolean; atTheLimit?: boolean },
) {
  return freshStart({
    withDesiredState: false,
    ...(singularity ? { fixture: { kind: "bitnode", n: 1, sourceFiles: { 1: 1, 4: 3 } } as const } : {}),
    beforeAgent: async (game) => {
      await game.simulation.diagnostics.setMoney(money);
      if (atTheLimit) await ownerRunsOnHome(game, BUY_TO_THE_LIMIT);
      if (!sim) await withoutSimEffectors(game);
    },
  });
}
type ForServers = Awaited<ReturnType<typeof forServers>>;

/** The medium snapshot's RAM for `hostname`, once a snapshot shows it; undefined until then. */
async function serverRamSeen(fresh: ForServers, hostname: string) {
  const ramOf = () => fresh.medium()?.servers.find((each) => each.hostname === hostname)?.maxRam;
  await fresh.game.runUntil(() => ramOf() !== undefined, 15_000);
  return ramOf();
}

/** `pserv-0` bought once, paid for once; sent again, done with nothing paid; and the two refusals before any purchase. */
async function boughtOnceAndRefused(fresh: ForServers, backend: "sim" | "ui") {
  await fresh.game.runUntil(() => fresh.money() !== null, 10_000);
  const moneyBefore = fresh.money() as number;
  const outcomes = await boughtEach(fresh, [server("pserv-0")]);
  expect(outcomes).toEqual([{ id: "buyServer(pserv-0, 8)", done: true, tries: 1, problem: null, backend }]);
  expect(await serverRamSeen(fresh, "pserv-0")).toBe(8);
  await fresh.game.runUntil(() => fresh.money() === moneyBefore - EIGHT_GB_PRICE, 5_000);
  // Sent again as a new intent, and at another RAM: the player's server of that name, done, nothing more paid.
  fresh.brain.channel.setDesiredState({ hackLoop: HACK_LOOP_OFF, intents: [] });
  await fresh.game.run(2_000);
  const again = await boughtEach(fresh, [server("pserv-0"), server("pserv-0", 64)]);
  expect(again.map(({ done, problem }) => [done, problem])).toEqual([
    [true, null],
    [true, null],
  ]);
  await fresh.game.run(2_000);
  expect(fresh.money()).toBe(moneyBefore - EIGHT_GB_PRICE);
  // A name the game's servers have: nothing bought (the game would have named it n00dles-0).
  fresh.brain.channel.setDesiredState({ hackLoop: HACK_LOOP_OFF, intents: [server("n00dles")] });
  expect(await triedOnce(fresh, "buyServer(n00dles, 8)")).toMatchObject({
    done: false,
    problem: "n00dles is the name of a server that isn't the player's",
    backend,
  });
  // Without the money, the price says why.
  await fresh.simulation.diagnostics.setMoney(EIGHT_GB_PRICE - 1);
  fresh.brain.channel.setDesiredState({ hackLoop: HACK_LOOP_OFF, intents: [server("pserv-1")] });
  expect(await triedOnce(fresh, "buyServer(pserv-1, 8)")).toMatchObject({
    done: false,
    problem: "not enough money: the 8 GB server costs $440000",
    backend,
  });
  const servers = fresh.medium()?.servers.map((each) => each.hostname) ?? [];
  expect(servers.filter((hostname) => /^(n00dles-|pserv-1)/.test(hostname))).toEqual([]);
}

test("buying a server (sim, #159): bought once; again, done with nothing paid; a game server's name and the money refused", async () => {
  await boughtOnceAndRefused(await forServers(1e10, { sim: true, singularity: false }), "sim");
});

test("buying a server (its worker, #159): on a fresh save's 8 GB home beside the Agent, through the NS API alone", async () => {
  await boughtOnceAndRefused(await forServers(1e10, { sim: false, singularity: false }), "ui");
});

test("buying a server (its worker, #159): with SF4.3 still the same worker, reported as ui; at the limit of 25, refused", async () => {
  const fresh = await forServers(1e10, { sim: false, singularity: true });
  await fresh.game.runUntil(() => fresh.medium() !== null, 15_000);
  expect(await boughtEach(fresh, [server("pserv-0")])).toMatchObject([{ done: true, backend: "ui" }]);
  // The owner buys up to the limit (the BitNode's 25; home has room beside the Agent); the next is refused, saying so.
  await ownerRunsOnHome(fresh, BUY_TO_THE_LIMIT);
  fresh.brain.channel.setDesiredState({ hackLoop: HACK_LOOP_OFF, intents: [server("pserv-1")] });
  expect(await triedOnce(fresh, "buyServer(pserv-1, 8)")).toMatchObject({
    done: false,
    problem: "the game's limit of 25 cloud servers is reached",
    backend: "ui",
  });
});

test("buying a server (sim, #159): at the limit of 25, refused as the worker refuses it", async () => {
  const fresh = await forServers(1e10, { sim: true, singularity: false, atTheLimit: true });
  fresh.brain.channel.setDesiredState({ hackLoop: HACK_LOOP_OFF, intents: [server("pserv-0")] });
  expect(await triedOnce(fresh, "buyServer(pserv-0, 8)")).toMatchObject({
    done: false,
    problem: "the game's limit of 25 cloud servers is reached",
    backend: "sim",
  });
});
