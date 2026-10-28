// The Agent's work activity (#151): when it converges the work the brain wants, through which effector, and what it
// reports. The workers are stand-ins; the simulator and E2 run the real ones.
import type { EffectorReport, Work, WorkEffectorReport } from "@bitburner-agent/core";
import { afterEach, expect, test, vi } from "vitest";
import { createEffectorRunner } from "../../src/agent/effector-runner.ts";
import type { WorkerRun, WorkerRunner } from "../../src/agent/run-worker.ts";
import { createWorkActivity } from "../../src/agent/work.ts";
import type { NS } from "../../src/ns.ts";

const ROUND_MS = 2_000;
const HACKING: Work = { kind: "faction", faction: "CyberSec", workType: "hacking", focus: true };
const CONVERGED: EffectorReport = { done: true, problem: null };

function activityWith(answer: () => WorkEffectorReport | "no report", singularity = { available: false }) {
  const lines: string[] = [];
  const ns = {
    print: (line: string) => lines.push(line),
    getScriptName: () => "agent/abcdef123456/agent.js",
    getScriptRam: (script: string) => (script.endsWith("/agent.js") ? 3 : 4.65),
    getServerMaxRam: () => 32,
    getServerUsedRam: () => 3,
  } as unknown as NS;
  const runWorker = vi.fn(async (): Promise<WorkerRun> => {
    const report = answer();
    if (report === "no report") return { outcome: "couldNotStart" };
    return { outcome: "reported", report: { workerPid: 1, data: report } as never };
  });
  const effectorRunner = createEffectorRunner(ns, {
    deploymentId: "abcdef123456",
    workerRunner: { runWorker } as unknown as WorkerRunner,
    singularityAvailable: () => singularity.available,
  });
  const work = createWorkActivity(ns, { effectorRunner });
  const round = (leftMs = ROUND_MS) => work.convergeIfDue(Date.now() + leftMs);
  const calls = () =>
    (runWorker.mock.calls as unknown as [string, unknown[]][]).map(([file, args]) => [file, args.slice(0, -1)]);
  return { work, lines, runWorker, round, calls };
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__bitburnerAgentSim;
});

test("no work wanted: nothing is touched, and nothing reported", async () => {
  const { work, runWorker, round } = activityWith(() => CONVERGED);
  work.desire(null);
  await round();
  expect(runWorker).not.toHaveBeenCalled();
  expect(work.outcome()).toBeNull();
});

test("wanted: converged at once through the page's worker, then every 15 rounds (30 s), reported", async () => {
  const { work, round, calls } = activityWith(() => CONVERGED);
  work.desire(HACKING);
  expect(work.outcome()).toEqual({ converged: false, problem: null, backend: null });
  await round();
  expect(calls()).toEqual([["agent/abcdef123456/faction-work.js", ["CyberSec", "hacking", "true"]]]);
  expect(work.outcome()).toEqual({ converged: true, problem: null, backend: "ui" });
  for (let each = 0; each < 14; each += 1) await round();
  expect(calls()).toHaveLength(1);
  await round();
  expect(calls()).toHaveLength(2);
});

test("a change is due at once; the same again changes nothing", async () => {
  const { work, round, calls } = activityWith(() => CONVERGED);
  work.desire(HACKING);
  await round();
  work.desire({ ...HACKING });
  await round();
  expect(calls()).toHaveLength(1);
  work.desire({ ...HACKING, focus: false });
  await round();
  expect(calls().at(-1)).toEqual(["agent/abcdef123456/faction-work.js", ["CyberSec", "hacking", "false"]]);
});

test("not converged: the problem is reported and logged, and it's tried again in 30 s", async () => {
  const problem = "CyberSec doesn't offer field work";
  const { work, lines, round, calls } = activityWith(() => ({ done: false, problem }));
  work.desire({ ...HACKING, workType: "field" });
  await round();
  expect(work.outcome()).toEqual({ converged: false, problem, backend: "ui" });
  expect(lines).toEqual([`agent: work: not converged: ${problem}; trying again in 30 s`]);
  for (let each = 0; each < 15; each += 1) await round();
  expect(calls()).toHaveLength(2);
});

test("a worker that doesn't run is tried again next round; with under a second left, it waits a round", async () => {
  const answers: (EffectorReport | "no report")[] = ["no report", CONVERGED];
  const { work, round, calls } = activityWith(() => answers.shift() ?? CONVERGED);
  work.desire(HACKING);
  await round(900);
  expect(calls()).toHaveLength(0);
  await round();
  expect(work.outcome()).toMatchObject({ converged: false, problem: expect.stringMatching(/couldn't start/) });
  await round();
  expect(work.outcome()).toMatchObject({ converged: true });
});

test("forgotten on a disconnect: nothing until the next brain sends work", async () => {
  const { work, runWorker, round } = activityWith(() => CONVERGED);
  work.desire(HACKING);
  work.forget();
  await round();
  expect(runWorker).not.toHaveBeenCalled();
  expect(work.outcome()).toBeNull();
});

test("each backend: the simulator's effector, or the Singularity worker once the game has it", async () => {
  const simCalls: unknown[][] = [];
  (globalThis as Record<string, unknown>).__bitburnerAgentSim = {
    convergeFactionWork: (...args: unknown[]) => {
      simCalls.push(args);
      return CONVERGED;
    },
  };
  const viaSim = activityWith(() => CONVERGED);
  viaSim.work.desire(HACKING);
  await viaSim.round();
  expect(simCalls).toEqual([["CyberSec", "hacking", true]]);
  expect(viaSim.work.outcome()).toMatchObject({ converged: true, backend: "sim" });
  delete (globalThis as Record<string, unknown>).__bitburnerAgentSim;
  const viaSingularity = activityWith(() => CONVERGED, { available: true });
  viaSingularity.work.desire(HACKING);
  await viaSingularity.round();
  expect(viaSingularity.calls()).toEqual([
    ["agent/abcdef123456/singularity-faction-work.js", ["CyberSec", "hacking", "true"]],
  ]);
});

test("company work (#153, #155): each backend's worker and arguments, a promotion check first, and the simulator's", async () => {
  const waiter: Work = { kind: "company", company: "Noodle Bar", field: "Waiter", focus: false };
  const viaPage = activityWith(() => CONVERGED);
  viaPage.work.desire(waiter);
  await viaPage.round();
  expect(viaPage.calls()).toEqual([["agent/abcdef123456/company-work.js", ["Noodle Bar", "Waiter", "false", "true"]]]);
  const viaSingularity = activityWith(() => CONVERGED, { available: true });
  viaSingularity.work.desire(waiter);
  await viaSingularity.round();
  expect(viaSingularity.calls()).toEqual([
    ["agent/abcdef123456/singularity-company-work.js", ["Noodle Bar", "Waiter", "false", "true"]],
  ]);
  const simCalls: unknown[][] = [];
  (globalThis as Record<string, unknown>).__bitburnerAgentSim = {
    convergeCompanyWork: (...args: unknown[]) => {
      simCalls.push(args);
      return CONVERGED;
    },
  };
  const viaSim = activityWith(() => CONVERGED);
  viaSim.work.desire(waiter);
  await viaSim.round();
  expect(simCalls).toEqual([["Noodle Bar", "Waiter", false, true]]);
});

test("crime (#156): each backend's worker and arguments, and the simulator's effector", async () => {
  const shoplift: Work = { kind: "crime", crime: "Shoplift", focus: true };
  const viaPage = activityWith(() => CONVERGED);
  viaPage.work.desire(shoplift);
  await viaPage.round();
  expect(viaPage.calls()).toEqual([["agent/abcdef123456/crime-work.js", ["Shoplift", "true"]]]);
  const viaSingularity = activityWith(() => CONVERGED, { available: true });
  viaSingularity.work.desire(shoplift);
  await viaSingularity.round();
  expect(viaSingularity.calls()).toEqual([["agent/abcdef123456/singularity-crime-work.js", ["Shoplift", "true"]]]);
  const simCalls: unknown[][] = [];
  (globalThis as Record<string, unknown>).__bitburnerAgentSim = {
    convergeCrimeWork: (...args: unknown[]) => {
      simCalls.push(args);
      return CONVERGED;
    },
  };
  const viaSim = activityWith(() => CONVERGED);
  viaSim.work.desire(shoplift);
  await viaSim.round();
  expect(simCalls).toEqual([["Shoplift", true]]);
});

test("a class (#158): each backend's worker and arguments, and the simulator's effector", async () => {
  const agility: Work = { kind: "class", location: "Powerhouse Gym", classType: "agi", focus: false };
  const viaPage = activityWith(() => CONVERGED);
  viaPage.work.desire(agility);
  await viaPage.round();
  expect(viaPage.calls()).toEqual([["agent/abcdef123456/class-work.js", ["Powerhouse Gym", "agi", "false"]]]);
  const viaSingularity = activityWith(() => CONVERGED, { available: true });
  viaSingularity.work.desire(agility);
  await viaSingularity.round();
  expect(viaSingularity.calls()).toEqual([
    ["agent/abcdef123456/singularity-class-work.js", ["Powerhouse Gym", "agi", "false"]],
  ]);
  const simCalls: unknown[][] = [];
  (globalThis as Record<string, unknown>).__bitburnerAgentSim = {
    convergeClassWork: (...args: unknown[]) => {
      simCalls.push(args);
      return CONVERGED;
    },
  };
  const viaSim = activityWith(() => CONVERGED);
  viaSim.work.desire(agility);
  await viaSim.round();
  expect(simCalls).toEqual([["Powerhouse Gym", "agi", false]]);
});

const IT: Work = { kind: "company", company: "Carmichael Security", field: "IT", focus: true };
/** Whether each worker call so far checked for a promotion (its fourth argument). */
const checks = (calls: unknown[][]) => calls.map(([, args]) => (args as string[])[3]);

test("a promotion check (#155): with the work's first convergence, then every 10 minutes (300 rounds), no more often", async () => {
  const { work, round, calls } = activityWith(() => CONVERGED);
  work.desire(IT);
  await round();
  expect(checks(calls())).toEqual(["true"]);
  // 299 rounds: a convergence every 15, none of them a check.
  for (let each = 0; each < 299; each += 1) await round();
  expect(checks(calls())).toEqual(["true", ...Array(19).fill("false")]);
  await round();
  expect(checks(calls()).at(-1)).toBe("true");
  // A change of the work is a start: checked at once.
  work.desire({ ...IT, focus: false });
  await round();
  expect(checks(calls()).at(-1)).toBe("true");
  // Not company work: never a check.
  const faction = activityWith(() => CONVERGED);
  faction.work.desire(HACKING);
  await faction.round();
  expect(checks(faction.calls())).toEqual([undefined]);
});

test("a promotion check not converged (#155): checked again with the next convergence, 30 s on", async () => {
  const answers: EffectorReport[] = [{ done: false, problem: "no Job in the sidebar" }, CONVERGED];
  const { work, round, calls } = activityWith(() => answers.shift() ?? CONVERGED);
  work.desire(IT);
  await round();
  for (let each = 0; each < 15; each += 1) await round();
  expect(checks(calls())).toEqual(["true", "true"]);
  // Converged with it: the next is 10 minutes on.
  for (let each = 0; each < 15; each += 1) await round();
  expect(checks(calls())).toEqual(["true", "true", "false"]);
});

test("a promotion taken (#155): in the outcome, with the company and when, and logged; kept until the work changes", async () => {
  const answers: WorkEffectorReport[] = [{ ...CONVERGED, promoted: { from: "IT Intern", to: "IT Analyst" } }];
  const { work, lines, round } = activityWith(() => answers.shift() ?? { ...CONVERGED, promoted: null });
  work.desire(IT);
  const before = Date.now();
  await round();
  expect(work.outcome()).toEqual({
    converged: true,
    problem: null,
    backend: "ui",
    promotion: { company: "Carmichael Security", from: "IT Intern", to: "IT Analyst", gameTimeMs: expect.any(Number) },
  });
  expect(work.outcome()?.promotion?.gameTimeMs).toBeGreaterThanOrEqual(before);
  expect(lines).toContain("agent: work: promoted at Carmichael Security, from IT Intern to IT Analyst");
  for (let each = 0; each < 15; each += 1) await round();
  expect(work.outcome()?.promotion?.to).toBe("IT Analyst");
  work.desire({ ...IT, field: "Software" });
  expect(work.outcome()).toEqual({ converged: false, problem: null, backend: null });
});
