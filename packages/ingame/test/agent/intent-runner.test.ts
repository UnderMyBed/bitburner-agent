// The intent runner's schedule (#141): when it runs each intent's worker, in what order, and what it logs and reports;
// The workers themselves are stand-ins here; E2 drives the real ones on the real page (packages/e2/test/*.e2.test.ts).
import { type EffectorReport, INTENT_ACTIONS, type Intent, type IntentRequest, intentId } from "@bitburner-agent/core";
import fc from "fast-check";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createEffectorRunner } from "../../src/agent/effector-runner.ts";
import { createIntentRunner } from "../../src/agent/intent-runner.ts";
import type { WorkerRun, WorkerRunner } from "../../src/agent/run-worker.ts";
import type { NS } from "../../src/ns.ts";

const ROUND_MS = 2_000;
const intent = (request: IntentRequest): Intent => ({ ...request, id: intentId(request.action, request.args) });
const TOR = intent({ action: "buyTor", args: { vendor: "Alpha Enterprises" } });
const AEVUM = intent({ action: "travel", args: { city: "Aevum" } });
const RAM_FROM_8 = intent({ action: "upgradeHomeRam", args: { fromRam: 8, vendor: "Alpha Enterprises" } });
const JOIN_SECTOR_12 = intent({ action: "joinFaction", args: { faction: "Sector-12" } });
const NEUROFLUX_3 = intent({
  action: "purchaseAugmentation",
  args: { faction: "Sector-12", augmentation: "NeuroFlux Governor", level: 3 },
});
const DONATE_SECTOR_12 = intent({
  action: "donateToFaction",
  args: { faction: "Sector-12", amount: 1_000_000, reputation: 1 },
});
const PSERV_0 = intent({ action: "buyServer", args: { hostname: "pserv-0", ram: 8 } });
const PSERV_0_TO_64 = intent({ action: "upgradeServer", args: { hostname: "pserv-0", ram: 64 } });
const BACKDOOR_CSEC = intent({ action: "backdoor", args: { hostname: "CSEC" } });
const INSTALL = intent({ action: "installAugmentations", args: {} });
const DESTROY_INTO_2 = intent({ action: "destroyBitNode", args: { nextBitNode: 2 } });
const CLOSE_GAME = intent({ action: "closeGame", args: {} });
const notDone = (problem: string): EffectorReport => ({ done: false, problem });
const DONE: EffectorReport = { done: true, problem: null };

/**
 * A runner whose stand-in workers report what `answer` gives for each run, and its log. `singularity` says whether the
 * game has Singularity; a stand-in for a worker that "can't start" is `"no report"`, one that "didn't report" is
 * `"silent"`, and one whose last copy is still running (#162) is `"busy"`. Home has `home.maxRam` GB, `home.usedRam`
 * of it in use (the Agent's 3 unless said); the Agent takes 3 and each worker 4.65.
 */
function runnerWith(
  answer: (workerFile: string, workerArguments: unknown[]) => EffectorReport | "no report" | "silent" | "busy",
  singularity = { available: false },
  home: { maxRam: number; usedRam?: number } = { maxRam: 8 },
) {
  const lines: string[] = [];
  const ns = {
    print: (line: string) => lines.push(line),
    getScriptName: () => "agent/abcdef123456/agent.js",
    getScriptRam: (script: string) => (script.endsWith("/agent.js") ? 3 : 4.65),
    getServerMaxRam: () => home.maxRam,
    getServerUsedRam: () => home.usedRam ?? 3,
  } as unknown as NS;
  const runWorker = vi.fn(async (workerFile: string, workerArguments: unknown[]): Promise<WorkerRun> => {
    const report = answer(workerFile, workerArguments);
    if (report === "no report") return { outcome: "couldNotStart" };
    if (report === "silent") return { outcome: "noReport" };
    if (report === "busy") return { outcome: "stillRunning" };
    return { outcome: "reported", report: { workerPid: 1, data: report } as never };
  });
  const effectorRunner = createEffectorRunner(ns, {
    deploymentId: "abcdef123456",
    workerRunner: { runWorker } as unknown as WorkerRunner,
    singularityAvailable: () => singularity.available,
  });
  const runner = createIntentRunner(ns, { effectorRunner });
  /** One round, with `leftMs` of it left when the runner's turn comes. */
  const round = (leftMs = ROUND_MS) => runner.runDue(performance.now() + leftMs);
  const workerFiles = () => runWorker.mock.calls.map(([workerFile]) => workerFile);
  return { runner, lines, runWorker, round, workerFiles };
}
const reportsInTurn =
  (...reports: EffectorReport[]) =>
  () => {
    const report = reports.shift();
    if (!report) throw new Error("no report left for the stand-in worker");
    return report;
  };

test("each action's worker, with its arguments and a deadline 200 ms before the round's end", async () => {
  const { runner, runWorker, round } = runnerWith(() => DONE);
  runner.desire([
    TOR,
    intent({ action: "buyProgram", args: { program: "BruteSSH.exe" } }),
    RAM_FROM_8,
    AEVUM,
    JOIN_SECTOR_12,
    NEUROFLUX_3,
    DONATE_SECTOR_12,
    PSERV_0,
    PSERV_0_TO_64,
    BACKDOOR_CSEC,
    INSTALL,
    DESTROY_INTO_2,
    CLOSE_GAME,
  ]);
  await round(13 * ROUND_MS);
  const calls = runWorker.mock.calls as unknown as [string, unknown[], number][];
  expect(calls.map(([workerFile, workerArguments]) => [workerFile, workerArguments.slice(0, -1)])).toEqual([
    ["agent/abcdef123456/buy-program.js", ["TOR router", "Alpha Enterprises"]],
    ["agent/abcdef123456/buy-program.js", ["BruteSSH.exe", ""]],
    ["agent/abcdef123456/upgrade-home-ram.js", [8, "Alpha Enterprises"]],
    ["agent/abcdef123456/travel.js", ["Aevum"]],
    ["agent/abcdef123456/join-faction.js", ["Sector-12"]],
    ["agent/abcdef123456/buy-augmentation.js", ["Sector-12", "NeuroFlux Governor", 3]],
    ["agent/abcdef123456/donate-to-faction.js", ["Sector-12", 1_000_000, 1]],
    ["agent/abcdef123456/buy-server.js", ["pserv-0", 8]],
    ["agent/abcdef123456/upgrade-server.js", ["pserv-0", 64]],
    ["agent/abcdef123456/backdoor.js", ["CSEC"]],
    ["agent/abcdef123456/install-augmentations.js", ["agent/boot.js"]],
    ["agent/abcdef123456/destroy-bitnode.js", [2, "agent/boot.js"]],
    ["agent/abcdef123456/close-game.js", []],
  ]);
  for (const [, workerArguments, deadlineMs] of calls)
    expect(deadlineMs - (workerArguments.at(-1) as number)).toBe(200);
});

test("with less than a second of the round left, an intent waits for the next round rather than start the page", async () => {
  const { runner, runWorker, round } = runnerWith(() => DONE);
  runner.desire([TOR]);
  await round(900);
  expect(runWorker).not.toHaveBeenCalled();
  await round();
  expect(runWorker).toHaveBeenCalledTimes(1);
});

test("not done: each try logs why, the next is 15 rounds (30 s) later, and the outcome counts the tries", async () => {
  const problem = "no TOR router to buy (is the money there?)";
  const { runner, lines, runWorker, round } = runnerWith(reportsInTurn(notDone(problem), notDone(problem)));
  runner.desire([TOR]);
  for (let each = 0; each < 16; each += 1) await round();
  expect(runWorker).toHaveBeenCalledTimes(2);
  expect(lines).toEqual([
    `agent: buy the TOR router (ui): not done: ${problem}; trying again in 30 s`,
    `agent: buy the TOR router (ui): not done: ${problem}; trying again in 30 s`,
  ]);
  expect(runner.outcomes()).toEqual([{ id: TOR.id, done: false, tries: 2, problem, backend: "ui" }]);
});

test("short rounds count toward the 30 s between tries: only the try itself waits for a round with time", async () => {
  const { runner, runWorker, round } = runnerWith(() => notDone("no City"));
  runner.desire([TOR]);
  await round();
  for (let each = 0; each < 14; each += 1) await round(500);
  expect(runWorker).toHaveBeenCalledTimes(1);
  // Due now, but short: it waits for the next round with time, not 15 more.
  await round(500);
  await round();
  expect(runWorker).toHaveBeenCalledTimes(2);
});

test("done: never run again while it stays, and a problem on the way is still logged and reported", async () => {
  const backProblem = 'no "Terminal" in the sidebar (is its section collapsed?)';
  const { runner, lines, runWorker, round } = runnerWith(() => ({ done: true, problem: backProblem }));
  runner.desire([AEVUM]);
  for (let each = 0; each < 20; each += 1) await round();
  runner.desire([AEVUM]);
  await round();
  expect(runWorker).toHaveBeenCalledTimes(1);
  expect(lines).toEqual([`agent: travel to Aevum (ui): done: ${backProblem}`]);
  expect(runner.outcomes()).toEqual([{ id: AEVUM.id, done: true, tries: 1, problem: backProblem, backend: "ui" }]);
});

test("a worker whose last copy is still running (#162) is tried again 30 s later, as one not done, and counted", async () => {
  const { runner, lines, runWorker, round } = runnerWith(() => DONE);
  runWorker.mockImplementationOnce(async () => ({ outcome: "stillRunning" }));
  runner.desire([BACKDOOR_CSEC]);
  for (let each = 0; each < 15; each += 1) await round();
  expect(runWorker).toHaveBeenCalledTimes(1);
  expect(runner.outcomes()).toMatchObject([{ done: false, tries: 1, problem: "its last worker is still running" }]);
  expect(lines).toEqual(["agent: install a backdoor on CSEC: its last worker is still running; trying again in 30 s"]);
  await round();
  expect(runWorker).toHaveBeenCalledTimes(2);
  expect(runner.outcomes()).toMatchObject([{ done: true, tries: 2 }]);
});

test("still running after it reported (#162): the outcome keeps what the worker said, the countdown, and says so", async () => {
  const installing = notDone("installing the backdoor on CSEC: about 40 s left");
  const { runner, runWorker, round } = runnerWith(() => installing);
  runWorker.mockImplementationOnce(async () => ({
    outcome: "reported",
    report: { workerPid: 1, data: installing } as never,
  }));
  runWorker.mockImplementationOnce(async () => ({ outcome: "stillRunning" }));
  runner.desire([BACKDOOR_CSEC]);
  for (let each = 0; each < 16; each += 1) await round();
  expect(runner.outcomes()).toMatchObject([
    { done: false, tries: 2, problem: "installing the backdoor on CSEC: about 40 s left (its worker is still at it)" },
  ]);
});

test("a worker that doesn't run is tried again next round, logged on a change, and counted as a try", async () => {
  const { runner, lines, runWorker, round } = runnerWith(() => "no report");
  runner.desire([AEVUM]);
  await round();
  await round();
  expect(runWorker).toHaveBeenCalledTimes(2);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(/^agent: travel to Aevum: .*; trying again next round$/);
  expect(runner.outcomes()).toMatchObject([{ id: AEVUM.id, done: false, tries: 2 }]);
});

test("in order, each in turn: one that takes the round leaves the next for the round after", async () => {
  const { runner, runWorker, round, workerFiles } = runnerWith(() => DONE);
  runner.desire([TOR, AEVUM]);
  runWorker.mockImplementationOnce(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    return { outcome: "reported", report: { workerPid: 1, data: DONE } as never };
  });
  await round();
  expect(workerFiles()).toEqual(["agent/abcdef123456/buy-program.js"]);
  await round();
  expect(workerFiles()).toEqual(["agent/abcdef123456/buy-program.js", "agent/abcdef123456/travel.js"]);
});

test("an intent that leaves isn't tried again; one that comes back is new, and due at once", async () => {
  const { runner, runWorker, round } = runnerWith(() => notDone("no City"));
  runner.desire([AEVUM]);
  await round();
  runner.desire([]);
  expect(runner.outcomes()).toEqual([]);
  await round();
  runner.desire([AEVUM]);
  await round();
  expect(runWorker).toHaveBeenCalledTimes(2);
  expect(runner.outcomes()).toMatchObject([{ id: AEVUM.id, tries: 1 }]);
});

test("forgotten on a disconnect: nothing runs until the next brain sends intents", async () => {
  const { runner, runWorker, round } = runnerWith(() => DONE);
  runner.desire([AEVUM]);
  runner.forget();
  await round();
  expect(runWorker).not.toHaveBeenCalled();
  expect(runner.outcomes()).toEqual([]);
});

describe("backends (#145)", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__bitburnerAgentSim;
  });

  test("the simulator's own effectors, where the page has them: called directly, with no worker", async () => {
    const calls: string[] = [];
    /** A stand-in effector: records its call, then reports `report`. */
    const effector = (report: EffectorReport) => (call: string) => {
      calls.push(call);
      return report;
    };
    (globalThis as Record<string, unknown>).__bitburnerAgentSim = {
      buyTorRouter: () => effector(DONE)("buyTorRouter"),
      buyDarkwebProgram: (program: string) => effector(DONE)(`buyDarkwebProgram ${program}`),
      buyHomeRam: (fromRam: number) => effector(notDone("the money?"))(`buyHomeRam ${fromRam}`),
      travelTo: (city: string) => effector(DONE)(`travelTo ${city}`),
      acceptFactionInvitation: (faction: string) => effector(DONE)(`acceptFactionInvitation ${faction}`),
      buyAugmentationFrom: (faction: string, augmentation: string, level: number) =>
        effector(DONE)(`buyAugmentationFrom ${faction} ${augmentation} ${level}`),
      buyCloudServer: (hostname: string, ram: number) => effector(DONE)(`buyCloudServer ${hostname} ${ram}`),
      upgradeCloudServer: (hostname: string, ram: number) => effector(DONE)(`upgradeCloudServer ${hostname} ${ram}`),
      backdoorServer: (hostname: string) => effector(DONE)(`backdoorServer ${hostname}`),
      installQueuedAugmentations: (callbackScript: string) =>
        effector(DONE)(`installQueuedAugmentations ${callbackScript}`),
      destroyWorldDaemon: (nextBitNode: number, callbackScript: string) =>
        effector(notDone("destroying"))(`destroyWorldDaemon ${nextBitNode} ${callbackScript}`),
    };
    const { runner, runWorker, round } = runnerWith(() => DONE, { available: true });
    runner.desire([
      TOR,
      intent({ action: "buyProgram", args: { program: "BruteSSH.exe" } }),
      RAM_FROM_8,
      AEVUM,
      JOIN_SECTOR_12,
      NEUROFLUX_3,
      PSERV_0,
      PSERV_0_TO_64,
      BACKDOOR_CSEC,
      INSTALL,
      DESTROY_INTO_2,
    ]);
    await round();
    expect(runWorker).not.toHaveBeenCalled();
    expect(calls).toEqual([
      "buyTorRouter",
      "buyDarkwebProgram BruteSSH.exe",
      "buyHomeRam 8",
      "travelTo Aevum",
      "acceptFactionInvitation Sector-12",
      "buyAugmentationFrom Sector-12 NeuroFlux Governor 3",
      "buyCloudServer pserv-0 8",
      "upgradeCloudServer pserv-0 64",
      "backdoorServer CSEC",
      "installQueuedAugmentations agent/boot.js",
      "destroyWorldDaemon 2 agent/boot.js",
    ]);
    expect(runner.outcomes().map(({ done, backend }) => [done, backend])).toEqual([
      [true, "sim"],
      [true, "sim"],
      [false, "sim"],
      [true, "sim"],
      [true, "sim"],
      [true, "sim"],
      [true, "sim"],
      [true, "sim"],
      [true, "sim"],
      [true, "sim"],
      [false, "sim"],
    ]);
  });

  test("Singularity, once the game has it: each action's Singularity worker, with its arguments", async () => {
    // Home big enough for each, beside the Agent.
    const { runner, runWorker, round } = runnerWith(() => DONE, { available: true }, { maxRam: 16 });
    runner.desire([
      TOR,
      intent({ action: "buyProgram", args: { program: "BruteSSH.exe" } }),
      RAM_FROM_8,
      AEVUM,
      JOIN_SECTOR_12,
      NEUROFLUX_3,
      DONATE_SECTOR_12,
      BACKDOOR_CSEC,
      INSTALL,
      DESTROY_INTO_2,
    ]);
    await round(12 * ROUND_MS);
    const calls = runWorker.mock.calls as unknown as [string, unknown[]][];
    expect(calls.map(([workerFile, workerArguments]) => [workerFile, workerArguments.slice(0, -1)])).toEqual([
      ["agent/abcdef123456/singularity-buy-tor.js", []],
      ["agent/abcdef123456/singularity-buy-program.js", ["BruteSSH.exe"]],
      ["agent/abcdef123456/singularity-upgrade-home-ram.js", [8]],
      ["agent/abcdef123456/singularity-travel.js", ["Aevum"]],
      ["agent/abcdef123456/singularity-join-faction.js", ["Sector-12"]],
      ["agent/abcdef123456/singularity-buy-augmentation.js", ["Sector-12", "NeuroFlux Governor", 3]],
      ["agent/abcdef123456/singularity-donate-to-faction.js", ["Sector-12", 1_000_000, 1]],
      ["agent/abcdef123456/singularity-backdoor.js", ["CSEC"]],
      // Installing, with the script the game starts after the reset (#164).
      ["agent/abcdef123456/singularity-install-augmentations.js", ["agent/boot.js"]],
      // Destroying, into the next BitNode, with the script the game starts after it (#175).
      ["agent/abcdef123456/singularity-destroy-bitnode.js", [2, "agent/boot.js"]],
    ]);
    expect(runner.outcomes().every((outcome) => outcome.backend === "singularity")).toBe(true);
  });

  test("an action with no Singularity worker (#159, #194): its NS worker, reported as ui, with Singularity or without", async () => {
    for (const available of [true, false]) {
      const { runner, workerFiles, round, lines } = runnerWith(() => DONE, { available }, { maxRam: 16 });
      runner.desire([PSERV_0, PSERV_0_TO_64]);
      await round();
      expect(workerFiles()).toEqual(["agent/abcdef123456/buy-server.js", "agent/abcdef123456/upgrade-server.js"]);
      expect(runner.outcomes()).toMatchObject([
        { done: true, backend: "ui" },
        { done: true, backend: "ui" },
      ]);
      expect(lines).toEqual([
        "agent: buy the 8 GB server pserv-0 (ui): done",
        "agent: upgrade the server pserv-0 to 64 GB (ui): done",
      ]);
    }
  });

  test("a Singularity worker that doesn't fit home beside the Agent: the page, logged once, until home grows", async () => {
    // 3 GB for the Agent and 4.65 for the worker don't fit in 7 GB, however empty home is.
    const home = { maxRam: 7 };
    const { runner, lines, workerFiles, round } = runnerWith(() => notDone("not yet"), { available: true }, home);
    runner.desire([AEVUM, intent({ action: "travel", args: { city: "Volhaven" } })]);
    await round(10 * ROUND_MS);
    expect(workerFiles()).toEqual(["agent/abcdef123456/travel.js", "agent/abcdef123456/travel.js"]);
    expect(runner.outcomes().map((outcome) => outcome.backend)).toEqual(["ui", "ui"]);
    expect(lines.filter((line) => line.includes("doesn't fit home"))).toEqual([
      "agent: travel to Aevum: singularity-travel.js doesn't fit home beside the Agent at this SF4 level; using the page",
    ]);
    home.maxRam = 16;
    for (let each = 0; each < 15; each += 1) await round(10 * ROUND_MS);
    expect(workerFiles().slice(2)).toEqual(Array(2).fill("agent/abcdef123456/singularity-travel.js"));
  });

  test("a Singularity worker that can't start but would fit an emptier home, or doesn't report: tried again, still Singularity", async () => {
    const answers: ("no report" | "silent" | EffectorReport)[] = ["no report", "silent", DONE];
    const { runner, lines, workerFiles, round } = runnerWith(() => answers.shift() ?? DONE, { available: true });
    runner.desire([AEVUM]);
    await round();
    await round();
    await round();
    expect(workerFiles()).toEqual(Array(3).fill("agent/abcdef123456/singularity-travel.js"));
    expect(runner.outcomes()).toMatchObject([{ done: true, tries: 3, backend: "singularity" }]);
    expect(lines.filter((line) => line.includes("doesn't fit home"))).toEqual([]);
  });

  test("a Singularity worker that fits home but not its free RAM now (#162: a backdoor's worker holds 8 GB): the page, this try", async () => {
    // 16 GB with 12 in use (the Agent's 3, a Singularity backdoor's 8, and the owner's 1): 4 free, short of the
    // stand-in worker's 4.65.
    const home = { maxRam: 16, usedRam: 3 + 8 + 1 };
    const { runner, lines, workerFiles, round } = runnerWith(() => notDone("not yet"), { available: true }, home);
    runner.desire([AEVUM]);
    await round();
    expect(workerFiles()).toEqual(["agent/abcdef123456/travel.js"]);
    expect(runner.outcomes()).toMatchObject([{ backend: "ui" }]);
    // Not the "can never fit" line: it fits once the backdoor's worker is gone.
    expect(lines.filter((line) => line.includes("doesn't fit home"))).toEqual([]);
    home.usedRam = 3;
    for (let each = 0; each < 15; each += 1) await round();
    expect(workerFiles().at(-1)).toBe("agent/abcdef123456/singularity-travel.js");
    expect(runner.outcomes()).toMatchObject([{ backend: "singularity" }]);
  });

  test("without Singularity, and without the simulator's effectors: the page", async () => {
    const { runner, workerFiles, round } = runnerWith(() => DONE);
    runner.desire([AEVUM]);
    await round();
    expect(workerFiles()).toEqual(["agent/abcdef123456/travel.js"]);
    expect(runner.outcomes()).toMatchObject([{ backend: "ui" }]);
  });
});

describe("properties (§9.3, #179): every action, its effector done, not done, busy, not started or silent", () => {
  /** An intent of each action (two travels, the TOR router and a port program, both resets), each its own run. */
  const POOL: Intent[] = [
    TOR,
    intent({ action: "buyProgram", args: { program: "FTPCrack.exe" } }),
    RAM_FROM_8,
    AEVUM,
    intent({ action: "travel", args: { city: "Volhaven" } }),
    JOIN_SECTOR_12,
    NEUROFLUX_3,
    DONATE_SECTOR_12,
    PSERV_0,
    PSERV_0_TO_64,
    BACKDOOR_CSEC,
    INSTALL,
    DESTROY_INTO_2,
    CLOSE_GAME,
  ];
  /**
   * Each pool intent's `ui` worker run, its worker and arguments without the deadline, written out here rather than
   * taken from the effectors under test (the first test of this file checks them against the runner).
   */
  const RUN_OF: [workerName: string, ...workerArguments: unknown[]][] = [
    ["buy-program.js", "TOR router", "Alpha Enterprises"],
    ["buy-program.js", "FTPCrack.exe", ""],
    ["upgrade-home-ram.js", 8, "Alpha Enterprises"],
    ["travel.js", "Aevum"],
    ["travel.js", "Volhaven"],
    ["join-faction.js", "Sector-12"],
    ["buy-augmentation.js", "Sector-12", "NeuroFlux Governor", 3],
    ["donate-to-faction.js", "Sector-12", 1_000_000, 1],
    ["buy-server.js", "pserv-0", 8],
    ["upgrade-server.js", "pserv-0", 64],
    ["backdoor.js", "CSEC"],
    ["install-augmentations.js", "agent/boot.js"],
    ["destroy-bitnode.js", 2, "agent/boot.js"],
    ["close-game.js"],
  ];
  /** What a stand-in worker does on one run: reports done or not done, is still running, can't start, or is silent. */
  const ANSWERS = ["done", "notDone", "busy", "cantStart", "silent"] as const;
  type Answer = (typeof ANSWERS)[number];
  const reportOf = (answer: Answer): EffectorReport | "no report" | "silent" | "busy" =>
    answer === "done"
      ? DONE
      : answer === "notDone"
        ? notDone("not yet")
        : answer === "cantStart"
          ? "no report"
          : answer;
  /** Each pool intent's answer, by its index in `POOL`. */
  const anyAnswers = fc.array(fc.constantFrom(...ANSWERS), { minLength: POOL.length, maxLength: POOL.length });
  const anyIntents = fc.uniqueArray(fc.constantFrom(...POOL), { selector: (each) => each.id, maxLength: 6 });
  /**
   * What happens in a round: the brain sends intents (a list built afresh, as off the wire), the Agent disconnects, or
   * a round runs, with each worker's answer, and enough of the round left or not.
   */
  const anyStep = fc.oneof(
    fc.record({ kind: fc.constant("desire" as const), intents: anyIntents }),
    fc.record({ kind: fc.constant("forget" as const) }),
    fc.record({ kind: fc.constant("round" as const), answers: anyAnswers, short: fc.boolean() }),
  );
  type Step = typeof anyStep extends fc.Arbitrary<infer Each> ? Each : never;

  /** Which pool intent a worker run is for: its worker's file and arguments, without the deadline. */
  const runKey = (workerFile: string, workerArguments: unknown[]) =>
    JSON.stringify([workerFile.split("/").at(-1), ...workerArguments.slice(0, -1)]);
  const poolIndexOfRun = new Map(RUN_OF.map((run, index) => [JSON.stringify(run), index] as const));
  const poolIndex = (workerFile: string, workerArguments: unknown[]) => {
    const index = poolIndexOfRun.get(runKey(workerFile, workerArguments));
    if (index === undefined) throw new Error(`a run for no intent: ${runKey(workerFile, workerArguments)}`);
    return index;
  };

  /**
   * The runner with workers answering as `answersNow` says, each run noted; the steps, played; and which intents the
   * stand-in workers themselves reported done while the runner held them (the model, not the runner's word).
   */
  function steppedRunner() {
    let answersNow: Answer[] = Array(POOL.length).fill("notDone");
    const workerRuns: string[] = [];
    const reportedDone = new Set<string>();
    const runner = runnerWith((workerFile, workerArguments) => {
      const index = poolIndex(workerFile, workerArguments);
      const { id } = POOL[index] as Intent;
      workerRuns.push(id);
      if (answersNow[index] === "done") reportedDone.add(id);
      return reportOf(answersNow[index] as Answer);
    }).runner;
    const fullRound = () => runner.runDue(performance.now() + 100 * ROUND_MS);
    const desire = (intents: Intent[]) => {
      runner.desire(structuredClone(intents));
      // One that left is new if it comes back: done no longer.
      const sent = new Set(intents.map((each) => each.id));
      for (const id of [...reportedDone]) if (!sent.has(id)) reportedDone.delete(id);
    };
    const play = async (step: Step, onRound: () => void = () => {}) => {
      if (step.kind === "desire") desire(step.intents);
      else if (step.kind === "forget") {
        runner.forget();
        reportedDone.clear();
      } else {
        answersNow = step.answers;
        await runner.runDue(performance.now() + (step.short ? 500 : 100 * ROUND_MS));
        onRound();
      }
    };
    const answerWith = (answers: Answer[]) => {
      answersNow = answers;
    };
    return { runner, workerRuns, reportedDone, fullRound, desire, play, answerWith };
  }

  test("the pool has every action an intent can name (a new one needs a place here), each its own run", async () => {
    expect(new Set(POOL.map((each) => each.action))).toEqual(new Set(INTENT_ACTIONS));
    expect(poolIndexOfRun.size).toBe(POOL.length);
    // The table is the runner's: each pool intent's worker and arguments, as the runner runs them.
    const { runner, workerFiles, runWorker } = runnerWith(() => DONE);
    runner.desire(POOL);
    await runner.runDue(performance.now() + 100 * ROUND_MS);
    expect(workerFiles()).toHaveLength(POOL.length);
    expect(runWorker.mock.calls.map(([file, args]) => poolIndex(file, args as unknown[]))).toEqual(
      POOL.map((_, index) => index),
    );
  });

  test("idempotent: one reported done never runs again while it stays sent, and only what's sent runs", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(anyStep, { maxLength: 40, size: "medium" }), async (steps) => {
        const { workerRuns, reportedDone, play } = steppedRunner();
        let sent = new Set<string>();
        const wrongRuns: string[] = [];
        let runsSeen = 0;
        for (const step of steps) {
          // Done before this round, by the stand-in's own report.
          const doneBefore = new Set(reportedDone);
          if (step.kind === "desire") sent = new Set(step.intents.map((each) => each.id));
          else if (step.kind === "forget") sent = new Set();
          await play(step, () => {
            for (const id of workerRuns.slice(runsSeen)) {
              if (doneBefore.has(id) && sent.has(id)) wrongRuns.push(`${id}, done, ran again`);
              if (!sent.has(id)) wrongRuns.push(`${id}, not sent, ran`);
            }
            runsSeen = workerRuns.length;
          });
        }
        expect(wrongRuns).toEqual([]);
      }),
      { numRuns: 200 },
    );
  });

  test("converges: each effector stable from some round, every outcome settles on its answer, and stays", async () => {
    // Stable: any answer, held: the game lets it be done, or keeps it not done; its worker stays busy (a Singularity
    // backdoor's, #162), can't start (home full), or never reports.
    const anyStableAnswers = fc.array(fc.constantFrom(...ANSWERS), { minLength: POOL.length, maxLength: POOL.length });
    /** Runs in any 30 rounds: none once done; every 15 rounds (30 s) not done or busy; every round with no report. */
    const RUNS_IN_30: Record<Answer, number> = { done: 0, notDone: 2, busy: 2, cantStart: 30, silent: 30 };
    await fc.assert(
      fc.asyncProperty(
        fc.array(anyStep, { maxLength: 30, size: "medium" }),
        anyIntents,
        anyStableAnswers,
        async (before, finalIntents, stableAnswers) => {
          const { runner, workerRuns, reportedDone, fullRound, desire, play, answerWith } = steppedRunner();
          for (const step of before) await play(step);
          // From here the brain keeps sending the same intents, and each worker answers the same: within the retry
          // period (15 rounds) and one more, each outcome is the worker's. One the stand-in already reported done, and
          // still sent, stays so: never run again. The model's word, not the runner's.
          answerWith(stableAnswers);
          const stableOf = (id: string) => stableAnswers[POOL.findIndex((each) => each.id === id)] as Answer;
          desire(finalIntents);
          const endsDone = (id: string) => reportedDone.has(id) || stableOf(id) === "done";
          const alreadyDone = new Set(finalIntents.filter(({ id }) => reportedDone.has(id)).map(({ id }) => id));
          for (let each = 0; each < 16; each += 1) await fullRound();
          expect(runner.outcomes().map(({ id, done }) => [id, done])).toEqual(
            finalIntents.map(({ id }) => [id, endsDone(id)]),
          );
          // And stays: no outcome changes but for the tries, sent afresh each round or not.
          const settled = runner.outcomes().map(({ tries: _tries, ...rest }) => rest);
          const runsBefore = workerRuns.length;
          for (let each = 0; each < 30; each += 1) {
            if (each % 2 === 0) desire(finalIntents);
            await fullRound();
          }
          expect(runner.outcomes().map(({ tries: _tries, ...rest }) => rest)).toEqual(settled);
          const runsAfter = workerRuns.slice(runsBefore);
          for (const { id } of finalIntents) {
            const expected = alreadyDone.has(id) ? 0 : RUNS_IN_30[stableOf(id)];
            expect([id, runsAfter.filter((run) => run === id).length]).toEqual([id, expected]);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

test("augmentation purchases done are counted, all told, past the brain dropping the done intent (#197)", async () => {
  const NEUROTRAINER = intent({
    action: "purchaseAugmentation",
    args: { faction: "CyberSec", augmentation: "Neurotrainer I", level: 1 },
  });
  const { runner, round } = runnerWith(() => DONE);
  expect(runner.augmentationsBought()).toBe(0);
  runner.desire([NEUROTRAINER, AEVUM]);
  await round();
  expect(runner.augmentationsBought()).toBe(1);
  // The brain stops sending it once done; the count stays, for the faction state's next read.
  runner.desire([]);
  await round();
  expect(runner.augmentationsBought()).toBe(1);
  // Sent again and done again (another level, say): counted again; the travel never counts.
  runner.desire([NEUROFLUX_3]);
  await round();
  expect(runner.augmentationsBought()).toBe(2);
  expect(runner.donationsMade()).toBe(0);
});

test("donations done are counted, all told, past the brain dropping the done intent (#225)", async () => {
  const DONATION = intent({
    action: "donateToFaction",
    args: { faction: "CyberSec", amount: 6_750_000_000, reputation: 18_750 },
  });
  const { runner, round } = runnerWith(() => DONE);
  expect(runner.donationsMade()).toBe(0);
  runner.desire([DONATION, AEVUM]);
  await round();
  expect(runner.donationsMade()).toBe(1);
  runner.desire([]);
  await round();
  expect(runner.donationsMade()).toBe(1);
  expect(runner.augmentationsBought()).toBe(0);
});
