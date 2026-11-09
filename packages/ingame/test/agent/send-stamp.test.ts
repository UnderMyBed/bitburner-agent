// The fast snapshot's send stamp (#309): the page's `Date.now()` as the Agent sends it, beside its worker's report
// stamp (`gameTimeMs`), so the run report tells whose a delivery lag was: the page's (between the two), or the
// socket's and the brain's (after the send).
import type { FastSnapshotData, SnapshotMessage } from "@bitburner-agent/core";
import { afterEach, expect, test, vi } from "vitest";
import type { WorkerRun, WorkerRunner } from "../../src/agent/run-worker.ts";
import { createSnapshotter } from "../../src/agent/snapshotter.ts";
import type { NS } from "../../src/ns.ts";

afterEach(() => {
  vi.useRealTimers();
});

const T0 = Date.parse("2026-11-08T19:36:19.802Z");

test("stamped as it's sent, after its worker's report: the Agent's own share of the wait between them", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  // Each worker reports at the clock's time, then the Agent is held 37 ms before it carries on.
  const runWorker = vi.fn(async (): Promise<WorkerRun> => {
    const report = { workerPid: 1, gameTimeMs: Date.now(), data: {} };
    vi.setSystemTime(Date.now() + 37);
    return { outcome: "reported", report };
  });
  const snapshotter = createSnapshotter({ print: () => {} } as unknown as NS, {
    deploymentId: "abcdef123456",
    agentSessionId: "session",
    workerRunner: { runWorker } as unknown as WorkerRunner,
    intentOutcomes: () => [],
    workOutcome: () => null,
    dialogReport: () => ({ handled: [], blocking: null }),
    readFactions: async () => ({
      backend: "ui",
      state: { joined: [], invitations: [], queuedAugmentations: [] },
      problem: null,
    }),
  });
  const sent: SnapshotMessage[] = [];
  await snapshotter.takeRound((message) => sent.push(message));
  const [fast, ...others] = sent;
  expect(fast?.tier).toBe("fast");
  expect(fast?.gameTimeMs).toBe(T0);
  expect((fast?.data as FastSnapshotData | undefined)?.sentAtMs).toBe(T0 + 37);
  // The other tiers' data is their workers', with no stamp of the Agent's (static goes after a welcome only).
  expect(others.map((message) => message.tier)).toEqual(["medium", "slow"]);
  for (const message of others) expect(message.data).not.toHaveProperty("sentAtMs");
});
