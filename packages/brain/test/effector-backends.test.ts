// The Effectors' `sim` and `singularity` backends in the simulator (#145): the brain sends intents, and the Agent does
// them through the simulator's own effectors, or, in a game with SF4.3, through its Singularity workers. The `ui`
// backend is E2's (packages/e2/test/effectors.e2.test.ts): the simulator renders no page. Joining a faction (#147) goes
// through the brain's gate for irreversible intents: two medium snapshots with its guard holding, then a save backup.
// Buying augmentations (#149): from a faction joined with reputation, NeuroFlux Governor a level at a time. Work
// (#151, #153, #156, #158): faction work, company work, the job applied for first, crime, and classes. Buying a cloud
// server (#159): one NS worker for the page's backend and Singularity's alike. Backdoors (#162): through the terminal's
// own commands, the terminal busy meanwhile, or Singularity's.
import { gunzipSync } from "node:zlib";
import {
  classStartProblem,
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

/**
 * A fresh start where the player is an IT Intern at Carmichael Security, in Sector-12, with `reputation` there, at
 * hacking level 168 (`gainHackingExp`), and money for a ticket: IT Analyst wants hacking 100 there and 7,000
 * reputation (`CompanyPositionsMetadata.ts`, the company's `jobStatReqOffset` of 74).
 */
function anItIntern(reputation: number, options: { singularity: boolean } = { singularity: false }) {
  return freshStart({
    withDesiredState: false,
    ...(options.singularity ? { fixture: { kind: "bitnode", n: 1, sourceFiles: { 1: 1, 4: 3 } } as const } : {}),
    beforeAgent: async (game) => {
      await game.simulation.diagnostics.setMoney(1e10);
      await game.simulation.diagnostics.gainHackingExp(1e5);
      await game.simulation.diagnostics.employWithReputation("Carmichael Security", "IT Intern", reputation);
      if (options.singularity) await withoutSimEffectors(game);
    },
  });
}

const itAtCarmichael = (focus: boolean): Work => ({
  kind: "company",
  company: "Carmichael Security",
  field: "IT",
  focus,
});

/** The company work's game cycles, as the game saves them: they'd start again from 0 were the work restarted. */
async function companyWorkCycles(fresh: { simulation: { save(): Promise<Uint8Array> } }) {
  const saveObject = JSON.parse(gunzipSync(await fresh.simulation.save()).toString("utf8"));
  const work = JSON.parse(saveObject.data.PlayerSave).data.currentWork;
  return work?.ctor === "CompanyWork" ? (work.data.cyclesWorked as number) : null;
}

test("a promotion (sim, #155): not qualified, nothing; then qualified, taken at the next check, 10 minutes on, from Aevum", async () => {
  const fresh = await anItIntern(0);
  await travelledTo(fresh, "Aevum");
  // The work's start checks: the player doesn't qualify for IT Analyst, so the job is as it was.
  expect(await workedAt(fresh, itAtCarmichael(true))).toEqual({ converged: true, problem: null, backend: "sim" });
  expect(await savedCompanyWork(fresh)).toEqual({ company: "Carmichael Security", job: "IT Intern", focus: true });
  // Qualified now: the convergences every 30 s don't check, the one 10 minutes after the first does.
  await fresh.simulation.diagnostics.employWithReputation("Carmichael Security", "IT Intern", 7_000);
  const promotion = () => fresh.latest<FastSnapshotData>("fast")?.work?.promotion;
  await fresh.game.run(8 * 60_000);
  expect(promotion()).toBeUndefined();
  const cyclesBefore = (await companyWorkCycles(fresh)) as number;
  await fresh.game.runUntil(() => promotion() !== undefined, 3 * 60_000);
  expect(promotion()).toEqual({
    company: "Carmichael Security",
    from: "IT Intern",
    to: "IT Analyst",
    gameTimeMs: expect.any(Number),
  });
  expect(fresh.latest<FastSnapshotData>("fast")?.work).toMatchObject({ converged: true, problem: null });
  // Still the same work, focused, under the new title: not restarted, its cycles carry on.
  expect(await savedCompanyWork(fresh)).toEqual({ company: "Carmichael Security", job: "IT Analyst", focus: true });
  expect(await companyWorkCycles(fresh)).toBeGreaterThan(cyclesBefore);
  expect(fresh.medium()?.player.city).toBe("Aevum");
});

test("a promotion (singularity, #155): with SF4.3, `applyToCompany` at the work's start; nothing new, no problem", async () => {
  const fresh = await anItIntern(0, { singularity: true });
  await fresh.game.runUntil(() => fresh.medium() !== null, 15_000);
  expect(await workedAt(fresh, itAtCarmichael(false))).toEqual({
    converged: true,
    problem: null,
    backend: "singularity",
  });
  expect(await savedCompanyWork(fresh)).toEqual({ company: "Carmichael Security", job: "IT Intern", focus: false });
  // Qualified, and the work changed (focused now): a start, so a check.
  await fresh.simulation.diagnostics.employWithReputation("Carmichael Security", "IT Intern", 7_000);
  expect(await workedAt(fresh, itAtCarmichael(true))).toMatchObject({
    converged: true,
    problem: null,
    promotion: { company: "Carmichael Security", from: "IT Intern", to: "IT Analyst" },
  });
  expect(await savedCompanyWork(fresh)).toEqual({ company: "Carmichael Security", job: "IT Analyst", focus: true });
});

/**
 * A Systems Administrator at Carmichael Security, the last of IT, who qualifies for Software's Head of Engineering,
 * its `nextPosition` (`CompanyPositionsMetadata.ts:151`): 800,000 reputation, and hacking and charisma of about 600
 * (`gainHackingExp`, `gainCharismaExp`; it wants 575 and 325 there).
 */
function aSystemsAdministrator(options: { singularity: boolean }) {
  return freshStart({
    withDesiredState: false,
    ...(options.singularity ? { fixture: { kind: "bitnode", n: 1, sourceFiles: { 1: 1, 4: 3 } } as const } : {}),
    beforeAgent: async (game) => {
      await game.simulation.diagnostics.gainHackingExp(1e11);
      await game.simulation.diagnostics.gainCharismaExp(1e11);
      await game.simulation.diagnostics.employWithReputation("Carmichael Security", "Systems Administrator", 800_000);
      if (options.singularity) await withoutSimEffectors(game);
    },
  });
}

test("a promotion stays in the field (#155): a Systems Administrator qualified for Head of Engineering keeps the title", async () => {
  for (const singularity of [false, true]) {
    const fresh = await aSystemsAdministrator({ singularity });
    if (singularity) await fresh.game.runUntil(() => fresh.medium() !== null, 15_000);
    // The work's start checks, through each backend: at the top of IT, nothing is applied for.
    expect(await workedAt(fresh, itAtCarmichael(true))).toEqual({
      converged: true,
      problem: null,
      backend: singularity ? "singularity" : "sim",
    });
    expect(await savedCompanyWork(fresh)).toEqual({
      company: "Carmichael Security",
      job: "Systems Administrator",
      focus: true,
    });
  }
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
  // A name the game's servers have: nothing bought (the game would have named it n00dles-0), nothing paid.
  fresh.brain.channel.setDesiredState({ hackLoop: HACK_LOOP_OFF, intents: [server("n00dles")] });
  expect(await triedOnce(fresh, "buyServer(n00dles, 8)")).toMatchObject({
    done: false,
    problem: "n00dles is the name of a server that isn't one of the player's cloud servers",
    backend,
  });
  await fresh.game.run(2_500);
  expect(fresh.money()).toBe(moneyBefore - EIGHT_GB_PRICE);
  // Without the money, the price says why.
  await fresh.simulation.diagnostics.setMoney(EIGHT_GB_PRICE - 1);
  fresh.brain.channel.setDesiredState({ hackLoop: HACK_LOOP_OFF, intents: [server("pserv-1")] });
  expect(await triedOnce(fresh, "buyServer(pserv-1, 8)")).toMatchObject({
    done: false,
    problem: "not enough money: the 8 GB server costs $440000",
    backend,
  });
  // Neither bought, as a medium snapshot taken after both tries shows (one comes every 10 s).
  const mediumSnapshots = () =>
    fresh.brain.channelEvents.filter((event) => event.type === "snapshotReceived" && event.snapshot.tier === "medium")
      .length;
  const mediumsBefore = mediumSnapshots();
  await fresh.game.runUntil(() => mediumSnapshots() > mediumsBefore, 12_000);
  const servers = fresh.medium()?.servers.map((each) => each.hostname) ?? [];
  expect(servers.filter((hostname) => /^(n00dles-|pserv-1)/.test(hostname))).toEqual([]);
  expect(fresh.money()).toBe(EIGHT_GB_PRICE - 1);
}

test("buying a server (sim, #159): bought once; again, done with nothing paid; a game server's name and the money refused", async () => {
  await boughtOnceAndRefused(await forServers(1e10, { sim: true, singularity: false }), "sim");
});

test("buying a server (its worker, #159): on a fresh save's 8 GB home beside the Agent, through the NS API alone", async () => {
  await boughtOnceAndRefused(await forServers(1e10, { sim: false, singularity: false }), "ui");
});

test("buying a server (its worker, #159): with SF4.3 still the same worker, reported as ui; at the limit of 25, refused", async () => {
  // The owner has bought up to the limit (the BitNode's 25) before the Agent starts; the next is refused, saying so.
  const fresh = await forServers(1e10, { sim: false, singularity: true, atTheLimit: true });
  await fresh.game.runUntil(() => fresh.medium() !== null, 15_000);
  fresh.brain.channel.setDesiredState({ hackLoop: HACK_LOOP_OFF, intents: [server("pserv-1")] });
  expect(await triedOnce(fresh, "buyServer(pserv-1, 8)")).toMatchObject({
    done: false,
    problem: "the game's limit of 25 cloud servers is reached",
    backend: "ui",
  });
});

test("buying a server (sim, #159): a name only a server off the network has is bought renamed, done, as the worker says", async () => {
  // Core refuses w0r1d_d43m0n (#161's review), so the owner's script calls the effector itself: before The Red Pill
  // the daemon has no links, so the worker's `serverExists` doesn't see it, and the game names the purchase -0.
  const fresh = await forServers(1e10, { sim: true, singularity: false });
  await fresh.simulation.writeFile(
    "home",
    "owner-buys.js",
    'export async function main(ns) { ns.print(JSON.stringify(globalThis.__bitburnerAgentSim.buyCloudServer("w0r1d_d43m0n", 8))); }',
  );
  const { pid } = await fresh.simulation.run("home", "owner-buys.js");
  await fresh.game.run(1_000);
  // The script's own line, before the game's "Script finished running".
  const logged = (await fresh.simulation.logs(pid as number)).filter((line) => line.startsWith("{"));
  expect(logged.map((line) => JSON.parse(line))).toEqual([
    { done: true, problem: "bought as w0r1d_d43m0n-0: a server off the network held w0r1d_d43m0n" },
  ]);
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

/**
 * The player's crime, focus and progress on it (ms), and their karma, as the game saves them: `null` for no crime. A
 * crime started again loses its progress (`Work/CrimeWork.ts`, `unitCompleted`).
 */
async function savedCrime(fresh: { simulation: { save(): Promise<Uint8Array> } }) {
  const saveObject = JSON.parse(gunzipSync(await fresh.simulation.save()).toString("utf8"));
  const player = JSON.parse(saveObject.data.PlayerSave).data;
  const work = player.currentWork;
  if (work?.ctor !== "CrimeWork") return null;
  return { crime: work.data.crimeType, focus: player.focus, progressMs: work.data.unitCompleted, karma: player.karma };
}

const crime = (name: string, focus: boolean): Work => ({ kind: "crime", crime: name, focus });

/**
 * Larceny, 90 s a time, wanted at `first` focus, then the other, kept across rounds for 100 s, then a switch to `next`:
 * the focus changed without starting it again (its progress kept), and committed (karma lost) though the Agent
 * converges every 30 s, then committed again.
 */
async function larcenyKeptAcrossRounds(fresh: Awaited<ReturnType<typeof freshStart>>, first: boolean, next: string) {
  await workedAt(fresh, crime("Larceny", first));
  const started = await savedCrime(fresh);
  expect(started).toMatchObject({ crime: "Larceny", focus: first });
  await workedAt(fresh, crime("Larceny", !first));
  const toggled = await savedCrime(fresh);
  expect(toggled).toMatchObject({ crime: "Larceny", focus: !first });
  expect(toggled?.progressMs).toBeGreaterThan(started?.progressMs ?? Number.POSITIVE_INFINITY);
  await fresh.game.run(100_000);
  const committed = await savedCrime(fresh);
  expect(committed).toMatchObject({ crime: "Larceny", focus: !first });
  expect(committed?.karma).toBeLessThan(started?.karma ?? Number.NEGATIVE_INFINITY);
  await workedAt(fresh, crime(next, !first));
  expect(await savedCrime(fresh)).toMatchObject({ crime: next, focus: !first });
}

test("crime (sim, #156): larceny focused, then unfocused without starting it again, committed and again, then mugging", async () => {
  const fresh = await freshStart({ withDesiredState: false });
  expect(await workedAt(fresh, crime("Shoplift", true))).toEqual({ converged: true, problem: null, backend: "sim" });
  expect((await fresh.simulation.diagnostics.game()).page).toBe("Work");
  await larcenyKeptAcrossRounds(fresh, true, "Mug");
  expect((await fresh.simulation.diagnostics.game()).page).not.toBe("Work");
  expect(fresh.latest<FastSnapshotData>("fast")?.work).toEqual({ converged: true, problem: null, backend: "sim" });
});

test("crime (singularity, #156): with SF4.3, through its Singularity worker, larceny unfocused, then focused, then homicide", async () => {
  const fresh = await freshStart({
    withDesiredState: false,
    fixture: { kind: "bitnode", n: 1, sourceFiles: { 1: 1, 4: 3 } },
    beforeAgent: withoutSimEffectors,
  });
  await fresh.game.runUntil(() => fresh.medium() !== null, 15_000);
  expect(await workedAt(fresh, crime("Shoplift", false))).toMatchObject({ converged: true, backend: "singularity" });
  await larcenyKeptAcrossRounds(fresh, false, "Homicide");
});

/**
 * The player's class, where, its focus, the game cycles it's run (200 ms each) and the money, as the game saves them,
 * with the game time of the save: `null` for no class.
 */
async function savedClass(fresh: { simulation: { save(): Promise<Uint8Array> }; game: { clock: { now(): number } } }) {
  const saveObject = JSON.parse(gunzipSync(await fresh.simulation.save()).toString("utf8"));
  const player = JSON.parse(saveObject.data.PlayerSave).data;
  const work = player.currentWork;
  if (work?.ctor !== "ClassWork") return null;
  const { classType, location, cyclesWorked } = work.data;
  return { classType, location, focus: player.focus, cyclesWorked, money: player.money, atMs: fresh.game.clock.now() };
}

/**
 * Whether the class ran on from `before` to `after`, not started again: its cycles grew by the game time between the
 * two saves (a cycle is 200 ms, `Constants.ts`, `MilliPerCycle`), less a second's slack. One started again in between
 * would have lost the cycles before it.
 */
function ranOn(before: Awaited<ReturnType<typeof savedClass>>, after: Awaited<ReturnType<typeof savedClass>>) {
  if (before === null || after === null) throw new Error("no class saved");
  expect(after.cyclesWorked - before.cyclesWorked).toBeGreaterThanOrEqual((after.atMs - before.atMs) / 200 - 5);
}

/** The guard's problems, in core's words: the simulator's effector can't import them, so drift fails here. */
const crushFromSector12 = classStartProblem(
  { location: "Crush Fitness Gym", classType: "str" },
  { money: 0, city: "Sector-12" },
);

const aClass = (location: string, classType: string, focus = false): Work => ({
  kind: "class",
  location,
  classType,
  focus,
});

test("a class (sim, #158): Computer Science at Rothman, unfocused then focused; the guard; a course under way kept", async () => {
  const fresh = await freshStart({
    withDesiredState: false,
    beforeAgent: async ({ simulation }) => simulation.diagnostics.setMoney(1_000),
  });
  expect(await workedAt(fresh, aClass("Rothman University", "Computer Science"))).toEqual({
    converged: true,
    problem: null,
    backend: "sim",
  });
  const started = await savedClass(fresh);
  expect(started).toMatchObject({ classType: "Computer Science", location: "Rothman University", focus: false });
  expect((await fresh.simulation.diagnostics.game()).page).toBe("Location");
  await workedAt(fresh, aClass("Rothman University", "Computer Science", true));
  const focused = await savedClass(fresh);
  expect(focused).toMatchObject({ classType: "Computer Science", focus: true });
  ranOn(started, focused);
  expect((await fresh.simulation.diagnostics.game()).page).toBe("Work");
  // A gym in Aevum from Sector-12, and a paid course without 10 minutes of its cost: neither started.
  expect(await workedAt(fresh, aClass("Crush Fitness Gym", "str"), false)).toMatchObject({
    converged: false,
    problem: crushFromSector12,
  });
  const dataStructures = { location: "Rothman University", classType: "Data Structures" };
  expect(await workedAt(fresh, aClass("Rothman University", "Data Structures"), false)).toMatchObject({
    converged: false,
    problem: classStartProblem(dataStructures, { money: 1_000, city: "Sector-12" }),
  });
  expect(await savedClass(fresh)).toMatchObject({ classType: "Computer Science" });
  // With the money it's started at the activity's next look (the work wanted is unchanged, so within 30 s); once under
  // way, it's kept though the money runs out.
  await fresh.simulation.diagnostics.setMoney(72_000);
  await fresh.game.runUntil(() => fresh.latest<FastSnapshotData>("fast")?.work?.converged === true, 35_000);
  await fresh.simulation.diagnostics.setMoney(0);
  await fresh.game.run(31_000);
  expect(fresh.latest<FastSnapshotData>("fast")?.work).toEqual({ converged: true, problem: null, backend: "sim" });
  const kept = await savedClass(fresh);
  expect(kept).toMatchObject({ classType: "Data Structures", location: "Rothman University", focus: false });
  expect(kept?.money).toBeLessThan(0);
  // A gym told from another by its location, which the page can't do: Iron Gym's strength, then Powerhouse Gym's.
  await fresh.simulation.diagnostics.setMoney(2_000_000);
  await workedAt(fresh, aClass("Iron Gym", "str"));
  expect(await savedClass(fresh)).toMatchObject({ classType: "str", location: "Iron Gym" });
  await workedAt(fresh, aClass("Powerhouse Gym", "str"));
  expect(await savedClass(fresh)).toMatchObject({ classType: "str", location: "Powerhouse Gym" });
});

test("a class (singularity, #158): with SF4.3, through its Singularity worker, a gym told from another by its location", async () => {
  const fresh = await freshStart({
    withDesiredState: false,
    fixture: { kind: "bitnode", n: 1, sourceFiles: { 1: 1, 4: 3 } },
    beforeAgent: async (game) => {
      await game.simulation.diagnostics.setMoney(1_000_000);
      await withoutSimEffectors(game);
    },
  });
  await fresh.game.runUntil(() => fresh.medium() !== null, 15_000);
  expect(await workedAt(fresh, aClass("Rothman University", "Computer Science"))).toMatchObject({
    converged: true,
    backend: "singularity",
  });
  const unfocused = await savedClass(fresh);
  expect(unfocused).toMatchObject({ classType: "Computer Science", focus: false });
  // The focus set (`setFocus`), the class not started again.
  await workedAt(fresh, aClass("Rothman University", "Computer Science", true));
  const focused = await savedClass(fresh);
  expect(focused).toMatchObject({ classType: "Computer Science", focus: true });
  ranOn(unfocused, focused);
  expect(await workedAt(fresh, aClass("Iron Gym", "str"))).toMatchObject({ converged: true });
  expect(await savedClass(fresh)).toMatchObject({ classType: "str", location: "Iron Gym", focus: false });
  // Powerhouse Gym's strength training reads as Iron Gym's on the page, not to Singularity; $1m is under its guard.
  const powerhouseWithNothing = classStartProblem(
    { location: "Powerhouse Gym", classType: "str" },
    { money: 0, city: "Sector-12" },
  ) as string;
  expect(await workedAt(fresh, aClass("Powerhouse Gym", "str"), false)).toMatchObject({
    converged: false,
    problem: expect.stringContaining(powerhouseWithNothing.replace(/\$0$/, "")),
  });
  await fresh.simulation.diagnostics.setMoney(2_000_000);
  await fresh.game.runUntil(() => fresh.latest<FastSnapshotData>("fast")?.work?.converged === true, 35_000);
  expect(await savedClass(fresh)).toMatchObject({ classType: "str", location: "Powerhouse Gym" });
  // Under way, it's left alone by the guard: with the money gone, its focus is still set.
  const beforeFocus = await savedClass(fresh);
  await fresh.simulation.diagnostics.setMoney(0);
  expect(await workedAt(fresh, aClass("Powerhouse Gym", "str", true))).toMatchObject({ converged: true });
  const afterFocus = await savedClass(fresh);
  expect(afterFocus).toMatchObject({ classType: "str", location: "Powerhouse Gym", focus: true });
  ranOn(beforeFocus, afterFocus);
  expect(await workedAt(fresh, aClass("Crush Fitness Gym", "str"), false)).toMatchObject({
    converged: false,
    problem: crushFromSector12,
  });
});

const backdoorOn = (hostname: string) => intent({ action: "backdoor", args: { hostname } });
const TOR = intent({ action: "buyTor", args: { vendor: "Alpha Enterprises" } });
const BRUTE_SSH = intent({ action: "buyProgram", args: { program: "BruteSSH.exe" } });

/**
 * A fresh start where nectar-net (layer 2, required level 20, no ports: `Server/data/servers.ts`) can be backdoored:
 * hacking level 22 (500 exp, the harness's `gainHackingExp`), and the owner's NUKE.exe run on it and on hong-fang-tea
 * (level 30), and the owner's cloud server `pserv-0` bought. With money for the TOR router and BruteSSH.exe, and home
 * at `homeRam` GB if said.
 */
function readyToBackdoor(options: { singularity: boolean; homeRam?: number } = { singularity: false }) {
  return freshStart({
    withDesiredState: false,
    ...(options.singularity ? { fixture: { kind: "bitnode", n: 1, sourceFiles: { 1: 1, 4: 3 } } as const } : {}),
    beforeAgent: async (game) => {
      await game.simulation.diagnostics.setMoney(1e10);
      await game.simulation.diagnostics.gainHackingExp(500);
      await ownerRunsOnHome(
        game,
        'export async function main(ns) { ns.nuke("nectar-net"); ns.nuke("hong-fang-tea"); ns.cloud.purchaseServer("pserv-0", 8); }',
      );
      if (options.homeRam !== undefined) await game.simulation.diagnostics.setHomeRam(options.homeRam);
      if (options.singularity) await withoutSimEffectors(game);
    },
  });
}
type ReadyToBackdoor = Awaited<ReturnType<typeof readyToBackdoor>>;

/** The player as the game saves it. */
async function savedPlayer(fresh: ReadyToBackdoor) {
  const saveObject = JSON.parse(gunzipSync(await fresh.simulation.save()).toString("utf8"));
  return JSON.parse(saveObject.data.PlayerSave).data as { currentServer: string; terminalCommandHistory: string[] };
}

/** The server the terminal is connected to, as the game saves it. */
const terminalServer = async (fresh: ReadyToBackdoor) => (await savedPlayer(fresh)).currentServer;

/** Whether the medium snapshot shows `hostname` backdoored (`backdoorInstalled`, `snapshot-medium.ts`). */
const backdoorSeen = (fresh: ReadyToBackdoor, hostname: string) =>
  fresh.medium()?.servers.find((server) => server.hostname === hostname)?.backdoorInstalled === true;

test("a backdoor (sim, #162): typed through the terminal, which stays busy for its time; a purchase meanwhile waits, then both are done", async () => {
  const fresh = await readyToBackdoor();
  fresh.brain.channel.setDesiredState({ hackLoop: HACK_LOOP_OFF, intents: [backdoorOn("nectar-net"), TOR, BRUTE_SSH] });
  expect((await triedOnce(fresh, "backdoor(nectar-net)"))?.problem).toMatch(
    /^installing the backdoor on nectar-net: about 2\d s left$/,
  );
  // The TOR router needs no terminal; the program's `buy` does, and the terminal is busy.
  expect(await triedOnce(fresh, BRUTE_SSH.id)).toMatchObject({ done: false, problem: "terminal busy" });
  expect(await terminalServer(fresh)).toBe("nectar-net");
  // Hacking time / 4 at level 22 is about 26 s: not installed 15 s on.
  await fresh.game.run(15_000);
  expect(backdoorSeen(fresh, "nectar-net")).toBe(false);
  await fresh.game.runUntil(() => backdoorSeen(fresh, "nectar-net"), 30_000);
  const outcomes = () => fresh.latest<FastSnapshotData>("fast")?.intents ?? [];
  await fresh.game.runUntil(() => outcomes().every((each) => each.done), 40_000);
  expect(outcomes().map(({ id, done, tries }) => [id, done, tries])).toEqual([
    ["backdoor(nectar-net)", true, 2],
    [TOR.id, true, 1],
    [BRUTE_SSH.id, true, 2],
  ]);
  // The try that found it installed typed `home`.
  expect(await terminalServer(fresh)).toBe("home");
  // Sent again as a new intent: done at its first try, from the game alone, nothing typed.
  const historyBefore = (await savedPlayer(fresh)).terminalCommandHistory;
  fresh.brain.channel.setDesiredState({ hackLoop: HACK_LOOP_OFF, intents: [] });
  await fresh.game.run(2_000);
  fresh.brain.channel.setDesiredState({ hackLoop: HACK_LOOP_OFF, intents: [backdoorOn("nectar-net")] });
  expect(await triedOnce(fresh, "backdoor(nectar-net)")).toMatchObject({ done: true, tries: 1, problem: null });
  expect((await savedPlayer(fresh)).terminalCommandHistory).toEqual(historyBefore);
});

test("a backdoor (sim, #162): refused without root, below the required level, on home, a cloud server and no server, each saying why, nothing typed", async () => {
  const fresh = await readyToBackdoor();
  const historyBefore = (await savedPlayer(fresh)).terminalCommandHistory;
  const refused = ["foodnstuff", "hong-fang-tea", "home", "pserv-0", "nowhere"].map(backdoorOn);
  fresh.brain.channel.setDesiredState({ hackLoop: HACK_LOOP_OFF, intents: refused });
  const outcomes = () => fresh.latest<FastSnapshotData>("fast")?.intents ?? [];
  await fresh.game.runUntil(() => outcomes().length === 5 && outcomes().every((each) => each.tries >= 1), 10_000);
  expect(outcomes().map(({ done, problem }) => [done, problem])).toEqual([
    [false, "no root access on foodnstuff (NUKE.exe first)"],
    [false, "hacking level 22: hong-fang-tea needs 30"],
    [false, "home is the player's own: the game backdoors only others' servers"],
    [false, "pserv-0 is the player's own: the game backdoors only others' servers"],
    [false, "no server nowhere"],
  ]);
  // Not a command typed: the terminal's history is as it was.
  expect((await savedPlayer(fresh)).terminalCommandHistory).toEqual(historyBefore);
  expect(await terminalServer(fresh)).toBe("home");
});

test("a backdoor (singularity, #162): with SF4.3, connected along the way and installed, the terminal left home", async () => {
  const fresh = await readyToBackdoor({ singularity: true });
  await fresh.game.runUntil(() => fresh.medium() !== null, 15_000);
  fresh.brain.channel.setDesiredState({ hackLoop: HACK_LOOP_OFF, intents: [backdoorOn("nectar-net")] });
  const first = await triedOnce(fresh, "backdoor(nectar-net)");
  expect(first).toMatchObject({ done: false, backend: "singularity" });
  expect(first?.problem).toMatch(/^installing the backdoor on nectar-net: about \d+ s left$/);
  await fresh.game.runUntil(() => backdoorSeen(fresh, "nectar-net"), 60_000);
  const outcome = () => fresh.latest<FastSnapshotData>("fast")?.intents?.[0];
  await fresh.game.runUntil(() => outcome()?.done === true, 40_000);
  expect(outcome()).toMatchObject({ done: true, problem: null, backend: "singularity" });
  expect(await terminalServer(fresh)).toBe("home");
  // Its refusals are the `ui` worker's: the same checks, before any `connect`.
  fresh.brain.channel.setDesiredState({
    hackLoop: HACK_LOOP_OFF,
    intents: ["foodnstuff", "hong-fang-tea", "home"].map(backdoorOn),
  });
  const outcomes = () => fresh.latest<FastSnapshotData>("fast")?.intents ?? [];
  await fresh.game.runUntil(() => outcomes().length === 3 && outcomes().every((each) => each.tries >= 1), 10_000);
  expect(outcomes().map(({ problem }) => problem)).toEqual([
    "no root access on foodnstuff (NUKE.exe first)",
    expect.stringMatching(/^hacking level \d+: hong-fang-tea needs 30$/),
    "home is the player's own: the game backdoors only others' servers",
  ]);
  expect(await terminalServer(fresh)).toBe("home");
});

test("a backdoor (singularity, #162): its worker holds 8 GB of a 16 GB home meanwhile, so work uses the page, then Singularity again", async () => {
  // 16 GB: the Agent's 3 and the backdoor worker's 8 leave 5 free, short of the crime worker's 7.3 (#156).
  const fresh = await readyToBackdoor({ singularity: true, homeRam: 16 });
  await fresh.game.runUntil(() => fresh.medium() !== null, 15_000);
  const shoplift: Work = { kind: "crime", crime: "Shoplift", focus: false };
  fresh.brain.channel.setDesiredState({ hackLoop: HACK_LOOP_OFF, intents: [backdoorOn("nectar-net")], work: shoplift });
  expect((await triedOnce(fresh, "backdoor(nectar-net)"))?.problem).toMatch(/^installing the backdoor/);
  const work = () => fresh.latest<FastSnapshotData>("fast")?.work;
  await fresh.game.runUntil(() => work()?.backend != null, 10_000);
  // The page, which the simulator doesn't render: not a Singularity worker that couldn't start.
  expect(work()).toMatchObject({ converged: false, backend: "ui" });
  expect(work()?.problem).not.toMatch(/couldn't start/);
  await fresh.game.runUntil(() => backdoorSeen(fresh, "nectar-net"), 60_000);
  await fresh.game.runUntil(() => work()?.converged === true, 40_000);
  expect(work()).toMatchObject({ converged: true, backend: "singularity" });
});
