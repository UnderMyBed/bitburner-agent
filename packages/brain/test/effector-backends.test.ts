// The Effectors' `sim` and `singularity` backends in the simulator (#145): the brain sends intents, and the Agent does
// them through the simulator's own effectors, or, in a game with SF4.3, through its Singularity workers. The `ui`
// backend is E2's (packages/e2/test/effectors.e2.test.ts): the simulator renders no page. Joining a faction (#147) goes
// through the brain's gate for irreversible intents: two medium snapshots with its guard holding, then a save backup.
import {
  type DesiredState,
  type FastSnapshotData,
  type Intent,
  type IntentRequest,
  intentId,
  type MediumSnapshotData,
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
