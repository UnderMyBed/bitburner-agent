// The Agent's worker runner (#89) against its deadline, on the page's monotonic clock (#251): a step in the wall clock
// neither ends a worker's time nor stretches it.
import { WORKER_REPORT_PORT } from "@bitburner-agent/core";
import { afterEach, expect, test, vi } from "vitest";
import { createWorkerRunner } from "../../src/agent/run-worker.ts";
import type { NS } from "../../src/ns.ts";

afterEach(() => {
  vi.useRealTimers();
});

/** A home with one worker that reports `reportAfterMs` after it starts, then exits: the ns, and the runs started. */
function homeWithWorker(reportAfterMs: number) {
  const queue: unknown[] = [];
  const waiting: (() => void)[] = [];
  const started: number[] = [];
  let running = false;
  const ns = {
    run: () => {
      const pid = started.length + 1;
      started.push(pid);
      running = true;
      setTimeout(() => {
        queue.push({ workerPid: pid, gameTimeMs: Date.now(), data: "done" });
        running = false;
        for (const wake of waiting.splice(0)) wake();
      }, reportAfterMs);
      return pid;
    },
    isRunning: () => running,
    asleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    getPortHandle: (port: number) => {
      expect(port).toBe(WORKER_REPORT_PORT);
      return {
        empty: () => queue.length === 0,
        read: () => queue.shift(),
        nextWrite: () => new Promise<void>((resolve) => waiting.push(resolve)),
      };
    },
  } as unknown as NS;
  return { ns, started };
}

test("the wall clock stepped an hour on (#251): the worker still starts, and its report is waited for", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const { ns, started } = homeWithWorker(50);
  const deadlineMs = performance.now() + 1_000;
  vi.setSystemTime(Date.now() + 3_600_000);
  const run = await createWorkerRunner(ns).runWorker("worker.js", [], deadlineMs);
  expect(run).toMatchObject({ outcome: "reported", report: { data: "done" } });
  expect(started).toEqual([1]);
});

test("past its deadline on the monotonic clock, nothing starts, though the wall clock reads it still to come", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const { ns, started } = homeWithWorker(50);
  // The wall clock at 0, behind the page's monotonic one: by it, the deadline is still ahead.
  vi.setSystemTime(0);
  expect(await createWorkerRunner(ns).runWorker("worker.js", [], performance.now() - 1)).toEqual({
    outcome: "noTimeLeft",
  });
  expect(started).toEqual([]);
});
