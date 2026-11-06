// The Agent's work activity (#151): when it converges the work the brain wants, through which effector, and what it
// reports. The workers are stand-ins; the simulator and E2 run the real ones. A property (#179) plays any history.
import type { EffectorReport, Work, WorkEffectorReport } from "@bitburner-agent/core";
import fc from "fast-check";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createEffectorRunner } from "../../src/agent/effector-runner.ts";
import type { WorkerRun, WorkerRunner } from "../../src/agent/run-worker.ts";
import { createWorkActivity } from "../../src/agent/work.ts";
import type { NS } from "../../src/ns.ts";

const ROUND_MS = 2_000;
const HACKING: Work = { kind: "faction", faction: "CyberSec", workType: "hacking", focus: true };
const CONVERGED: EffectorReport = { done: true, problem: null };

/**
 * The activity, with stand-in workers answering what `answer` gives for each run: a report, `"no report"` for one that
 * can't start, or `"busy"` for one whose last copy is still running.
 */
function activityWith(
  answer: (workerFile: string, workerArguments: unknown[]) => WorkEffectorReport | "no report" | "busy",
  singularity = { available: false },
) {
  const lines: string[] = [];
  const ns = {
    print: (line: string) => lines.push(line),
    getScriptName: () => "agent/abcdef123456/agent.js",
    getScriptRam: (script: string) => (script.endsWith("/agent.js") ? 3 : 4.65),
    getServerMaxRam: () => 32,
    getServerUsedRam: () => 3,
  } as unknown as NS;
  const runWorker = vi.fn(async (workerFile: string, workerArguments: unknown[]): Promise<WorkerRun> => {
    const report = answer(workerFile, workerArguments);
    if (report === "no report") return { outcome: "couldNotStart" };
    if (report === "busy") return { outcome: "stillRunning" };
    return { outcome: "reported", report: { workerPid: 1, data: report } as never };
  });
  const effectorRunner = createEffectorRunner(ns, {
    deploymentId: "abcdef123456",
    workerRunner: { runWorker } as unknown as WorkerRunner,
    singularityAvailable: () => singularity.available,
  });
  const work = createWorkActivity(ns, { effectorRunner });
  const round = (leftMs = ROUND_MS) => work.convergeIfDue(performance.now() + leftMs);
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

test("a promotion check whose worker doesn't run (#155): checked again next round, then every 10 minutes", async () => {
  const answers: (EffectorReport | "no report")[] = ["no report", CONVERGED];
  const { work, round, calls } = activityWith(() => answers.shift() ?? CONVERGED);
  work.desire(IT);
  await round();
  await round();
  expect(checks(calls())).toEqual(["true", "true"]);
  for (let each = 0; each < 299; each += 1) await round();
  expect(checks(calls()).filter((check) => check === "true")).toHaveLength(2);
  await round();
  expect(checks(calls()).at(-1)).toBe("true");
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

describe("properties (#179): the work converges, and isn't restarted once it has", () => {
  /**
   * A stand-in game: the work it's doing (a worker file and the work's arguments, without the focus), its focus, and
   * how often a work was started. A stand-in effector that converges does what each backend's does
   * (`convergeFactionWork` and the others in the simulator, ../../src/page/work-page.ts on the page, the Singularity
   * workers): already so, nothing touched; another work, started (focused, as the game starts one); then the focus.
   * That each real effector touches nothing when the game is already so is theirs to show, example-tested per backend
   * (packages/brain/test/effector-backends.test.ts for `sim` and `singularity`, the page's tests, E2): here, what the
   * Agent asks of them.
   */
  interface StandInGame {
    doing: string | null;
    focus: boolean;
    starts: number;
  }
  /** Each kind of work, two of faction work; the focus is the arbitrary's. */
  const WORKS: Work[] = [
    { kind: "faction", faction: "CyberSec", workType: "hacking", focus: false },
    { kind: "faction", faction: "CyberSec", workType: "field", focus: false },
    { kind: "company", company: "Carmichael Security", field: "IT", focus: false },
    { kind: "crime", crime: "Shoplift", focus: false },
    { kind: "class", location: "Powerhouse Gym", classType: "agi", focus: false },
  ];
  const anyWork = fc
    .record({ index: fc.nat({ max: WORKS.length - 1 }), focus: fc.boolean() })
    .map(({ index, focus }) => ({ ...(WORKS[index] as Work), focus }));
  /** A run's work and focus: company work's worker takes the promotion check after the focus. */
  const workOfRun = (workerFile: string, workerArguments: unknown[]) => {
    const name = workerFile.split("/").at(-1) as string;
    const args = workerArguments.slice(0, name === "company-work.js" ? -3 : -2);
    const focus = workerArguments.at(name === "company-work.js" ? -3 : -2) === "true";
    return { doing: JSON.stringify([name, ...args]), focus };
  };
  /** What the game does for `work`, written out here rather than taken from the effectors under test. */
  const doingOf = (work: Work): string => {
    if (work.kind === "faction") return JSON.stringify(["faction-work.js", work.faction, work.workType]);
    if (work.kind === "company") return JSON.stringify(["company-work.js", work.company, work.field]);
    if (work.kind === "crime") return JSON.stringify(["crime-work.js", work.crime]);
    return JSON.stringify(["class-work.js", work.location, work.classType]);
  };
  /** What a stand-in worker does on one run: converges the game, or not, or is still running, or can't start. */
  const ANSWERS = ["converges", "notConverged", "busy", "cantStart"] as const;
  type Answer = (typeof ANSWERS)[number];
  /** Looks in any 30 rounds, held: every 15 rounds (30 s) with a report; every round without one. */
  const LOOKS_IN_30: Record<Answer, number> = { converges: 2, notConverged: 2, busy: 30, cantStart: 30 };
  /**
   * What happens in a round: the brain sends work (or none), a disconnect, the owner (or a page effector) moves the
   * game's work, or a round runs with the worker's answer, with enough of the round left or not.
   */
  const anyStep = fc.oneof(
    fc.record({ kind: fc.constant("desire" as const), work: fc.option(anyWork) }),
    fc.record({ kind: fc.constant("forget" as const) }),
    fc.record({ kind: fc.constant("owner" as const), work: fc.option(anyWork) }),
    fc.record({ kind: fc.constant("round" as const), answer: fc.constantFrom(...ANSWERS), short: fc.boolean() }),
  );

  test("from anything, the work wanted, its answer held: settled within 16 rounds, kept, never restarted", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(anyStep, { maxLength: 30, size: "medium" }),
        fc.option(anyWork, { freq: 5 }),
        fc.constantFrom(...ANSWERS),
        async (before, wanted, heldAnswer) => {
          const standInGame: StandInGame = { doing: null, focus: false, starts: 0 };
          let answer: Answer = "notConverged";
          /** Each run the stand-in worker was asked for: the work and its focus. */
          const asked: { doing: string; focus: boolean }[] = [];
          const { work, round } = activityWith((workerFile, workerArguments) => {
            const run = workOfRun(workerFile, workerArguments);
            asked.push(run);
            if (answer === "busy") return "busy";
            if (answer === "cantStart") return "no report";
            if (answer === "notConverged") return { done: false, problem: "not yet" };
            if (standInGame.doing !== run.doing) {
              standInGame.doing = run.doing;
              standInGame.focus = true;
              standInGame.starts += 1;
            }
            standInGame.focus = run.focus;
            return CONVERGED;
          });
          for (const step of before) {
            if (step.kind === "desire") work.desire(step.work === null ? null : structuredClone(step.work));
            else if (step.kind === "forget") work.forget();
            else if (step.kind === "owner") {
              standInGame.doing = step.work === null ? null : doingOf(step.work);
              standInGame.focus = step.work?.focus ?? false;
            } else {
              answer = step.answer;
              await round(step.short ? 500 : ROUND_MS);
            }
          }
          // From here the brain keeps sending the same work, or none (afresh, as off the wire), and each worker
          // answers the same: within the 30 s between looks and one more round, the outcome is that answer's.
          answer = heldAnswer;
          const askedBefore = asked.length;
          for (let each = 0; each < 16; each += 1) {
            work.desire(wanted === null ? null : structuredClone(wanted));
            await round();
          }
          // Every run asked for from here is for the work wanted, at its focus; none at all with none wanted.
          const askedSince = asked.slice(askedBefore);
          const wantedRun = wanted === null ? null : { doing: doingOf(wanted), focus: wanted.focus };
          expect(askedSince.filter((run) => JSON.stringify(run) !== JSON.stringify(wantedRun))).toEqual([]);
          if (wanted === null) {
            // None wanted: the game's work left alone, nothing reported.
            expect(askedSince).toEqual([]);
            expect(work.outcome()).toBeNull();
          } else if (heldAnswer === "converges") {
            expect([standInGame.doing, standInGame.focus]).toEqual([doingOf(wanted), wanted.focus]);
            expect(work.outcome()).toEqual({ converged: true, problem: null, backend: "ui" });
          } else {
            // Not converged, by the worker's word or for want of one: looked at, and said so.
            expect(askedSince.length).toBeGreaterThanOrEqual(1);
            expect(work.outcome()).toMatchObject({ converged: false, problem: expect.any(String), backend: "ui" });
          }
          // And kept: the outcome doesn't change, nothing is started again, and it's looked at as its answer says.
          const settled = work.outcome();
          const startsBefore = standInGame.starts;
          const askedBeforeKept = asked.length;
          for (let each = 0; each < 30; each += 1) {
            work.desire(wanted === null ? null : structuredClone(wanted));
            await round();
          }
          expect(work.outcome()).toEqual(settled);
          expect(standInGame.starts).toBe(startsBefore);
          expect(asked.length - askedBeforeKept).toBe(wanted === null ? 0 : LOOKS_IN_30[heldAnswer]);
        },
      ),
      { numRuns: 200 },
    );
  });
});
