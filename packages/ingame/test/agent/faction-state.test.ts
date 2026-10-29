// The Agent's faction state reader (#197) and the slow snapshot that carries it: the routine dialogs first, the backend
// the effectors would use, a reading that always says what happened, and the slow worker's data with it. The workers
// are stand-ins here; the simulator suite runs the real ones (packages/brain/test/faction-state.test.ts), E2 the page's.
import {
  AGENT_SIM_EFFECTORS_GLOBAL,
  type FactionState,
  type FactionStateReading,
  type SlowSnapshotData,
  type SnapshotMessage,
} from "@bitburner-agent/core";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createEffectorRunner } from "../../src/agent/effector-runner.ts";
import { createFactionStateReader, readingOfRun } from "../../src/agent/faction-state.ts";
import type { WorkerRun, WorkerRunner } from "../../src/agent/run-worker.ts";
import { createSnapshotter } from "../../src/agent/snapshotter.ts";
import type { NS } from "../../src/ns.ts";

const STATE: FactionState = {
  joined: [{ name: "CyberSec", reputation: 1234.5, favor: 1 }],
  invitations: ["Sector-12"],
  queuedAugmentations: ["NeuroFlux Governor"],
};

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[AGENT_SIM_EFFECTORS_GLOBAL];
});

/**
 * A reader whose stand-in worker answers with `answer`, and what happened in order: the dialogs handled, each worker
 * run, the Agent's log. Home has `homeRam` GB; the Agent takes 3, the page's worker 3.1, Singularity's 12.1.
 */
function readerWith(
  answer: () => unknown,
  { singularity = false, homeRam = 8 }: { singularity?: boolean; homeRam?: number } = {},
) {
  const happened: string[] = [];
  const lines: string[] = [];
  const ns = {
    print: (line: string) => lines.push(line),
    getScriptName: () => "agent/abcdef123456/agent.js",
    getScriptRam: (script: string) => (script.endsWith("/agent.js") ? 3 : script.includes("singularity-") ? 12.1 : 3.1),
    getServerMaxRam: () => homeRam,
    getServerUsedRam: () => 3,
  } as unknown as NS;
  const runWorker = vi.fn(async (workerFile: string, workerArguments: unknown[]): Promise<WorkerRun> => {
    happened.push(`run ${workerFile.replace("agent/abcdef123456/", "")} ${JSON.stringify(workerArguments)}`);
    const report = answer();
    if (report === "silent") return { outcome: "noReport" };
    return { outcome: "reported", report: { workerPid: 1, gameTimeMs: 0, data: report } };
  });
  const effectorRunner = createEffectorRunner(ns, {
    deploymentId: "abcdef123456",
    workerRunner: { runWorker } as unknown as WorkerRunner,
    singularityAvailable: () => singularity,
  });
  const reader = createFactionStateReader(ns, {
    effectorRunner,
    handleDialogs: async (deadlineMs) => {
      happened.push(`dialogs by ${deadlineMs}`);
    },
  });
  return { reader, happened, lines };
}

describe("the reader", () => {
  test("the routine dialogs first, then the page's worker, with the deadline less the margin: its state", async () => {
    const { reader, happened } = readerWith(() => ({ done: true, problem: null, state: STATE }));
    expect(await reader.read(10_000)).toEqual({ backend: "ui", state: STATE, problem: null });
    expect(happened).toEqual(["dialogs by 10000", "run faction-state.js [9800]"]);
  });

  test("with Singularity and room beside the Agent, Singularity's worker; without the room, the page's", async () => {
    const roomy = readerWith(() => ({ done: true, problem: null, state: STATE }), { singularity: true, homeRam: 32 });
    expect((await roomy.reader.read(10_000)).backend).toBe("singularity");
    expect(roomy.happened.at(-1)).toBe("run singularity-faction-state.js [9800]");
    const small = readerWith(() => ({ done: true, problem: null, state: STATE }), { singularity: true, homeRam: 8 });
    expect((await small.reader.read(10_000)).backend).toBe("ui");
  });

  test("the simulator's own effector where the page has it", async () => {
    (globalThis as Record<string, unknown>)[AGENT_SIM_EFFECTORS_GLOBAL] = {
      readFactionState: () => ({ done: true, problem: null, state: STATE }),
    };
    const { reader, happened } = readerWith(() => {
      throw new Error("no worker in the simulator");
    });
    expect(await reader.read(10_000)).toEqual({ backend: "sim", state: STATE, problem: null });
    expect(happened).toEqual(["dialogs by 10000"]);
  });

  test("never an empty state for an unread one: the worker's problem, or why it didn't report; logged once a change", async () => {
    const answers: unknown[] = [
      { done: false, problem: "a dialog the Agent leaves for the owner is open", state: null },
      { done: false, problem: "a dialog the Agent leaves for the owner is open", state: null },
      "silent",
      { done: true, problem: null, state: STATE },
      { done: true, problem: null, state: STATE },
    ];
    const { reader, lines } = readerWith(() => answers.shift());
    const problems: (string | null)[] = [];
    for (let round = 0; round < 5; round += 1) {
      const reading = await reader.read(10_000);
      expect(reading.state === null).toBe(reading.problem !== null);
      problems.push(reading.problem);
    }
    expect(problems).toEqual([
      "a dialog the Agent leaves for the owner is open",
      "a dialog the Agent leaves for the owner is open",
      "agent/abcdef123456/faction-state.js didn't report in time",
      null,
      null,
    ]);
    expect(lines).toEqual([
      "agent: the faction state (ui): a dialog the Agent leaves for the owner is open",
      "agent: the faction state (ui): agent/abcdef123456/faction-state.js didn't report in time",
      "agent: the faction state is read again",
    ]);
  });
});

describe("readingOfRun", () => {
  test("a state not well formed is unread, with the worker's problem or a word for it", () => {
    const run = (data: unknown) => ({ backend: "ui" as const, report: data as never, noReportReason: null });
    expect(readingOfRun(run({ done: true, problem: null, state: { joined: "CyberSec" } }))).toEqual({
      backend: "ui",
      state: null,
      problem: "the reader reported no faction state",
    });
    expect(readingOfRun(run({ done: false, problem: "no game page to read it through" }))).toEqual({
      backend: "ui",
      state: null,
      problem: "no game page to read it through",
    });
  });

  test("a state with a problem after it (the page not left as found): both", () => {
    const report = { done: true, problem: 'no "Terminal" in the sidebar', state: STATE };
    expect(readingOfRun({ backend: "ui", report: report as never, noReportReason: null })).toEqual({
      backend: "ui",
      state: STATE,
      problem: 'no "Terminal" in the sidebar',
    });
  });
});

describe("the slow snapshot", () => {
  const SLOW_WORKER_DATA = { resetInfo: { lastAugReset: 1 }, purchasedServers: [] };

  /** A snapshotter whose tier workers report at once, and `slowWorks` says whether the slow one does. */
  function snapshotterWith(
    readFactions: (deadlineMs: number) => Promise<FactionStateReading>,
    slowWorks = true,
    slowData: unknown = SLOW_WORKER_DATA,
  ) {
    const order: string[] = [];
    const runWorker = vi.fn(async (workerFile: string): Promise<WorkerRun> => {
      order.push(workerFile.replace("agent/abcdef123456/", ""));
      if (workerFile.endsWith("snapshot-slow.js")) {
        return slowWorks
          ? { outcome: "reported", report: { workerPid: 1, gameTimeMs: 5, data: slowData } }
          : { outcome: "noReport" };
      }
      return { outcome: "reported", report: { workerPid: 1, gameTimeMs: 5, data: {} } };
    });
    const snapshotter = createSnapshotter({ print: () => {} } as unknown as NS, {
      deploymentId: "abcdef123456",
      agentSessionId: "session",
      workerRunner: { runWorker } as unknown as WorkerRunner,
      intentOutcomes: () => [],
      workOutcome: () => null,
      dialogReport: () => ({ handled: [], blocking: null }),
      readFactions: async (deadlineMs) => {
        order.push("readFactions");
        return readFactions(deadlineMs);
      },
    });
    const sent: SnapshotMessage[] = [];
    return { snapshotter, order, sent, send: (message: SnapshotMessage) => sent.push(message) };
  }

  test("read just after the slow worker, within the round, and sent with its data", async () => {
    const deadlines: number[] = [];
    const reading: FactionStateReading = { backend: "ui", state: STATE, problem: null };
    const { snapshotter, order, sent, send } = snapshotterWith(async (deadlineMs) => {
      deadlines.push(deadlineMs);
      return reading;
    });
    const before = Date.now();
    await snapshotter.takeRound(send);
    expect(order).toEqual([
      "snapshot-fast.js",
      "snapshot-medium.js",
      "snapshot-slow.js",
      "readFactions",
      "snapshot-static.js",
    ]);
    expect(deadlines[0]).toBeGreaterThanOrEqual(before + 2_000);
    expect(deadlines[0]).toBeLessThanOrEqual(Date.now() + 2_000);
    const slow = sent.find((message) => message.tier === "slow");
    expect(slow?.data).toEqual({ ...SLOW_WORKER_DATA, factions: reading });
    // The next round: no slow snapshot, so no read.
    await snapshotter.takeRound(send);
    expect(order.filter((each) => each === "readFactions")).toHaveLength(1);
  });

  test("the slow worker's data is kept before the read: its backend knows Singularity from the first", async () => {
    const seen: boolean[] = [];
    const holder: { snapshotter?: ReturnType<typeof createSnapshotter> } = {};
    const withSF4 = { resetInfo: { lastAugReset: 1, currentNode: 1, ownedSF: { 4: 3 } }, purchasedServers: [] };
    const made = snapshotterWith(
      async () => {
        seen.push(holder.snapshotter?.singularityAvailable() ?? false);
        return { backend: "singularity", state: STATE, problem: null };
      },
      true,
      withSF4,
    );
    holder.snapshotter = made.snapshotter;
    await made.snapshotter.takeRound(made.send);
    expect(seen).toEqual([true]);
  });

  test("unread, it still goes, saying why", async () => {
    const reading: FactionStateReading = { backend: "ui", state: null, problem: "no game page" };
    const { snapshotter, sent, send } = snapshotterWith(async () => reading);
    await snapshotter.takeRound(send);
    const slow = sent.find((message) => message.tier === "slow")?.data as SlowSnapshotData | undefined;
    expect(slow?.factions).toEqual(reading);
  });

  test("no slow worker report: no read, and the slow tier stays due; nor in safe mode's unsent read", async () => {
    const { snapshotter, order, send } = snapshotterWith(async () => {
      throw new Error("not read");
    }, false);
    await snapshotter.takeRound(send);
    await snapshotter.readSlowTierIfNone(Date.now() + 2_000);
    expect(order).not.toContain("readFactions");
  });
});
