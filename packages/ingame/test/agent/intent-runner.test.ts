// The intent runner's schedule (#141): when it runs each intent's worker, in what order, and what it logs and reports;
// The workers themselves are stand-ins here; E2 drives the real ones on the real page (packages/e2/test/*.e2.test.ts).
import { type EffectorReport, type Intent, type IntentRequest, intentId } from "@bitburner-agent/core";
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
const PSERV_0 = intent({ action: "buyServer", args: { hostname: "pserv-0", ram: 8 } });
const PSERV_0_TO_64 = intent({ action: "upgradeServer", args: { hostname: "pserv-0", ram: 64 } });
const BACKDOOR_CSEC = intent({ action: "backdoor", args: { hostname: "CSEC" } });
const INSTALL = intent({ action: "installAugmentations", args: {} });
const DESTROY_INTO_2 = intent({ action: "destroyBitNode", args: { nextBitNode: 2 } });
const notDone = (problem: string): EffectorReport => ({ done: false, problem });
const DONE: EffectorReport = { done: true, problem: null };

/**
 * A runner whose stand-in workers report what `answer` gives for each run, and its log. `singularity` says whether the
 * game has Singularity; a stand-in for a worker that "can't start" is `"no report"`, and one that "didn't report" is
 * `"silent"`. Home has `home.maxRam` GB, `home.usedRam` of it in use (the Agent's 3 unless said); the Agent takes 3
 * and each worker 4.65.
 */
function runnerWith(
  answer: (workerFile: string, workerArguments: unknown[]) => EffectorReport | "no report" | "silent",
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
    return { outcome: "reported", report: { workerPid: 1, data: report } as never };
  });
  const effectorRunner = createEffectorRunner(ns, {
    deploymentId: "abcdef123456",
    workerRunner: { runWorker } as unknown as WorkerRunner,
    singularityAvailable: () => singularity.available,
  });
  const runner = createIntentRunner(ns, { effectorRunner });
  /** One round, with `leftMs` of it left when the runner's turn comes. */
  const round = (leftMs = ROUND_MS) => runner.runDue(Date.now() + leftMs);
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
    PSERV_0,
    PSERV_0_TO_64,
    BACKDOOR_CSEC,
    INSTALL,
    DESTROY_INTO_2,
  ]);
  await round(10 * ROUND_MS);
  const calls = runWorker.mock.calls as unknown as [string, unknown[], number][];
  expect(calls.map(([workerFile, workerArguments]) => [workerFile, workerArguments.slice(0, -1)])).toEqual([
    ["agent/abcdef123456/buy-program.js", ["TOR router", "Alpha Enterprises"]],
    ["agent/abcdef123456/buy-program.js", ["BruteSSH.exe", ""]],
    ["agent/abcdef123456/upgrade-home-ram.js", [8, "Alpha Enterprises"]],
    ["agent/abcdef123456/travel.js", ["Aevum"]],
    ["agent/abcdef123456/join-faction.js", ["Sector-12"]],
    ["agent/abcdef123456/buy-augmentation.js", ["Sector-12", "NeuroFlux Governor", 3]],
    ["agent/abcdef123456/buy-server.js", ["pserv-0", 8]],
    ["agent/abcdef123456/upgrade-server.js", ["pserv-0", 64]],
    ["agent/abcdef123456/backdoor.js", ["CSEC"]],
    ["agent/abcdef123456/install-augmentations.js", ["agent/boot.js"]],
    ["agent/abcdef123456/destroy-bitnode.js", [2, "agent/boot.js"]],
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
      BACKDOOR_CSEC,
      INSTALL,
      DESTROY_INTO_2,
    ]);
    await round(10 * ROUND_MS);
    const calls = runWorker.mock.calls as unknown as [string, unknown[]][];
    expect(calls.map(([workerFile, workerArguments]) => [workerFile, workerArguments.slice(0, -1)])).toEqual([
      ["agent/abcdef123456/singularity-buy-tor.js", []],
      ["agent/abcdef123456/singularity-buy-program.js", ["BruteSSH.exe"]],
      ["agent/abcdef123456/singularity-upgrade-home-ram.js", [8]],
      ["agent/abcdef123456/singularity-travel.js", ["Aevum"]],
      ["agent/abcdef123456/singularity-join-faction.js", ["Sector-12"]],
      ["agent/abcdef123456/singularity-buy-augmentation.js", ["Sector-12", "NeuroFlux Governor", 3]],
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

describe("properties (§9.3)", () => {
  const anyIntent = fc.constantFrom(
    TOR,
    AEVUM,
    RAM_FROM_8,
    intent({ action: "travel", args: { city: "Volhaven" } }),
    intent({ action: "buyProgram", args: { program: "FTPCrack.exe" } }),
  );
  const anyIntents = fc.uniqueArray(anyIntent, { selector: (each) => each.id, maxLength: 4 });
  /** What happens in a round: the brain sends intents, the Agent disconnects, or a round runs (with its worker's word). */
  const anyStep = fc.oneof(
    fc.record({ kind: fc.constant("desire" as const), intents: anyIntents }),
    fc.record({ kind: fc.constant("forget" as const) }),
    fc.record({ kind: fc.constant("round" as const), done: fc.boolean(), reports: fc.boolean() }),
  );

  /** Which intent a worker run is for: its worker and arguments, without the deadline. */
  const intentOfRun = new Map(
    [
      [TOR, ["buy-program.js", "TOR router", "Alpha Enterprises"]],
      [AEVUM, ["travel.js", "Aevum"]],
      [RAM_FROM_8, ["upgrade-home-ram.js", 8, "Alpha Enterprises"]],
      [intent({ action: "travel", args: { city: "Volhaven" } }), ["travel.js", "Volhaven"]],
      [intent({ action: "buyProgram", args: { program: "FTPCrack.exe" } }), ["buy-program.js", "FTPCrack.exe", ""]],
    ].map(([each, run]) => [JSON.stringify(run), (each as Intent).id]),
  );
  const runKey = (workerFile: string, workerArguments: unknown[]) =>
    JSON.stringify([workerFile.split("/").at(-1), ...workerArguments.slice(0, -1)]);

  test("idempotent: an intent reported done is never run again while it stays sent", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(anyStep, { maxLength: 40 }), async (steps) => {
        let next = { done: false, reports: true };
        const doneIds = new Set<string>();
        const runsOfDone: string[] = [];
        const { runner } = runnerWith((workerFile, workerArguments) => {
          const id = intentOfRun.get(runKey(workerFile, workerArguments));
          if (id === undefined) throw new Error(`a run for no intent: ${runKey(workerFile, workerArguments)}`);
          if (doneIds.has(id)) runsOfDone.push(id);
          if (!next.reports) return "no report";
          return next.done ? DONE : notDone("not yet");
        });
        for (const step of steps) {
          if (step.kind === "desire") {
            runner.desire(step.intents);
            // One that left may come back later as new, and may run again then.
            const sent = new Set(step.intents.map((each) => each.id));
            for (const id of [...doneIds]) if (!sent.has(id)) doneIds.delete(id);
          } else if (step.kind === "forget") {
            runner.forget();
            doneIds.clear();
          } else {
            next = step;
            await runner.runDue(Date.now() + 100 * ROUND_MS);
            for (const outcome of runner.outcomes()) if (outcome.done) doneIds.add(outcome.id);
          }
        }
        expect(runsOfDone).toEqual([]);
      }),
      { numRuns: 200 },
    );
  });

  test("converges: every intent sent long enough, whose worker reports done, ends done, whatever came before", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(anyStep, { maxLength: 30 }), anyIntents, async (before, finalIntents) => {
        let next = { done: false, reports: true };
        const { runner } = runnerWith(() => (next.reports ? (next.done ? DONE : notDone("not yet")) : "no report"));
        for (const step of before) {
          if (step.kind === "desire") runner.desire(step.intents);
          else if (step.kind === "forget") runner.forget();
          else {
            next = step;
            await runner.runDue(Date.now() + 100 * ROUND_MS);
          }
        }
        // From here the brain keeps sending the same intents and the game lets each be done: within the retry period
        // (15 rounds) and one more, every one is.
        runner.desire(finalIntents);
        next = { done: true, reports: true };
        for (let each = 0; each < 16; each += 1) await runner.runDue(Date.now() + 100 * ROUND_MS);
        expect(runner.outcomes().map((outcome) => [outcome.id, outcome.done])).toEqual(
          finalIntents.map((each) => [each.id, true]),
        );
      }),
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
});
