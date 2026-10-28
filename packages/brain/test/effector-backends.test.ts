// The Effectors' `sim` and `singularity` backends in the simulator (#145): the brain sends intents, and the Agent does
// them through the simulator's own effectors, or, in a game with SF4.3, through its Singularity workers. The `ui`
// backend is E2's (packages/e2/test/effectors.e2.test.ts): the simulator renders no page.
import {
  type DesiredState,
  type FastSnapshotData,
  type Intent,
  type IntentRequest,
  intentId,
  type MediumSnapshotData,
} from "@bitburner-agent/core";
import { expect, test } from "vitest";
import { ownerRunsOnHome, useFreshStarts } from "./helpers/fresh-start.ts";

const freshStart = useFreshStarts();
const intent = (request: IntentRequest): Intent => ({ ...request, id: intentId(request.action, request.args) });
const HACK_LOOP_OFF: DesiredState["hackLoop"] = { enabled: false, target: null, hosts: [] };
const homeRamOf = (medium: MediumSnapshotData | null) =>
  medium?.servers.find((server) => server.hostname === "home")?.maxRam;

/** The four actions so far, home's RAM upgraded from `homeRam`. In order: the TOR router before a program. */
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

test("sim backend: with money, each action is done through the simulator's own effectors, with no worker", async () => {
  const fresh = await freshStart({
    withDesiredState: false,
    beforeAgent: async ({ simulation }) => simulation.diagnostics.setMoney(1e10),
  });
  fresh.brain.channel.setDesiredState({ hackLoop: HACK_LOOP_OFF, intents: fourActions(8) });
  await fresh.game.runUntil(() => allFourDone(fresh.medium(), 8), 30_000);
  const outcomes = fresh.latest<FastSnapshotData>("fast")?.intents ?? [];
  expect(outcomes.map(({ done, backend }) => [done, backend])).toEqual(Array(4).fill([true, "sim"]));
});

test("sim backend: without the money, each is not done, with the game's reason, and tried again in 30 s", async () => {
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
    "the game didn't sell BruteSSH.exe (is the TOR router there, and the money?)",
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
      await ownerRunsOnHome(game, "export async function main(ns) { delete globalThis.__bitburnerAgentSim; }");
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
