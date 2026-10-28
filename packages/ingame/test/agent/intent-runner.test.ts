// The intent runner's schedule (#141): when it runs each intent's worker, in what order, and what it logs and reports.
// The workers themselves are stand-ins here; E2 drives the real ones on the real page (packages/e2/test/*.e2.test.ts).
import { type EffectorReport, type Intent, type IntentRequest, intentId } from "@bitburner-agent/core";
import fc from "fast-check";
import { describe, expect, test, vi } from "vitest";
import { createIntentRunner } from "../../src/agent/intent-runner.ts";
import type { WorkerRun, WorkerRunner } from "../../src/agent/run-worker.ts";
import type { NS } from "../../src/ns.ts";

const ROUND_MS = 2_000;
const intent = (request: IntentRequest): Intent => ({ ...request, id: intentId(request.action, request.args) });
const TOR = intent({ action: "buyTor", args: { vendor: "Alpha Enterprises" } });
const AEVUM = intent({ action: "travel", args: { city: "Aevum" } });
const RAM_FROM_8 = intent({ action: "upgradeHomeRam", args: { fromRam: 8, vendor: "Alpha Enterprises" } });
const notDone = (problem: string): EffectorReport => ({ done: false, problem });
const DONE: EffectorReport = { done: true, problem: null };

/** A runner whose stand-in workers report what `answer` gives for each run, and its log. */
function runnerWith(answer: (workerFile: string, workerArguments: unknown[]) => EffectorReport | "no report") {
  const lines: string[] = [];
  const ns = { print: (line: string) => lines.push(line) } as unknown as NS;
  const runWorker = vi.fn(async (workerFile: string, workerArguments: unknown[]): Promise<WorkerRun> => {
    const report = answer(workerFile, workerArguments);
    if (report === "no report") return { outcome: "couldNotStart" };
    return { outcome: "reported", report: { workerPid: 1, data: report } as never };
  });
  const runner = createIntentRunner(ns, {
    deploymentId: "abcdef123456",
    workerRunner: { runWorker } as unknown as WorkerRunner,
  });
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
  runner.desire([TOR, intent({ action: "buyProgram", args: { program: "BruteSSH.exe" } }), RAM_FROM_8, AEVUM]);
  await round(10 * ROUND_MS);
  const calls = runWorker.mock.calls as unknown as [string, unknown[], number][];
  expect(calls.map(([workerFile, workerArguments]) => [workerFile, workerArguments.slice(0, -1)])).toEqual([
    ["agent/abcdef123456/buy-program.js", ["TOR router", "Alpha Enterprises"]],
    ["agent/abcdef123456/buy-program.js", ["BruteSSH.exe", ""]],
    ["agent/abcdef123456/upgrade-home-ram.js", [8, "Alpha Enterprises"]],
    ["agent/abcdef123456/travel.js", ["Aevum"]],
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
    `agent: buy the TOR router: not done: ${problem}; trying again in 30 s`,
    `agent: buy the TOR router: not done: ${problem}; trying again in 30 s`,
  ]);
  expect(runner.outcomes()).toEqual([{ id: TOR.id, done: false, tries: 2, problem }]);
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
  expect(lines).toEqual([`agent: travel to Aevum: done: ${backProblem}`]);
  expect(runner.outcomes()).toEqual([{ id: AEVUM.id, done: true, tries: 1, problem: backProblem }]);
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
