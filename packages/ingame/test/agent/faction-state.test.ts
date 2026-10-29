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
import { createSnapshotter, noTimeToRead } from "../../src/agent/snapshotter.ts";
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
  {
    singularity = false,
    homeRam = 8,
    invitationsAnswered = () => 0,
    augmentationsBought = () => 0,
  }: {
    singularity?: boolean;
    homeRam?: number;
    invitationsAnswered?: () => number;
    augmentationsBought?: () => number;
  } = {},
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
    invitationsAnswered,
    augmentationsBought,
  });
  /** The context each page worker was given. */
  const contexts = () =>
    runWorker.mock.calls
      .filter(([workerFile]) => workerFile.endsWith("/faction-state.js"))
      .map(([, workerArguments]) => JSON.parse(String(workerArguments[0])));
  return { reader, happened, lines, contexts };
}

const FIRST_CONTEXT = JSON.stringify({ memory: null, invitationAnswered: false, augmentationBought: false });

describe("the reader", () => {
  test("the routine dialogs first, then the page's worker, with the deadline less the margin: its state", async () => {
    const { reader, happened } = readerWith(() => ({ done: true, problem: null, state: STATE }));
    expect(await reader.read(10_000)).toEqual({ backend: "ui", state: STATE, problem: null });
    expect(happened).toEqual(["dialogs by 10000", `run faction-state.js ${JSON.stringify([FIRST_CONTEXT, 9800])}`]);
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

describe("the page reader's memory, and the Agent's news since", () => {
  const memory = { state: STATE, lastAugReset: 5, factionsReadAtMs: 1_000 };

  test("each page read's memory goes to the next, with an invitation answered or a purchase done since", async () => {
    let invitations = 0;
    // Counted, all told: the brain stops sending a done intent long before the next read (#197).
    let bought = 1;
    const { reader, contexts } = readerWith(() => ({ done: true, problem: null, state: STATE, opened: [], memory }), {
      invitationsAnswered: () => invitations,
      augmentationsBought: () => bought,
    });
    await reader.read(10_000);
    await reader.read(10_000);
    invitations = 1;
    bought = 2;
    await reader.read(10_000);
    await reader.read(10_000);
    expect(contexts()).toEqual([
      { memory: null, invitationAnswered: false, augmentationBought: false },
      { memory, invitationAnswered: false, augmentationBought: false },
      { memory, invitationAnswered: true, augmentationBought: true },
      { memory, invitationAnswered: false, augmentationBought: false },
    ]);
  });

  test("a read that failed keeps the last memory and the news, for the next try", async () => {
    const answers: unknown[] = [
      { done: true, problem: null, state: STATE, memory },
      { done: false, problem: "a dialog the Agent leaves for the owner is open", state: null },
      { done: true, problem: null, state: STATE, memory },
    ];
    let invitations = 0;
    const { reader, contexts } = readerWith(() => answers.shift(), { invitationsAnswered: () => invitations });
    await reader.read(10_000);
    invitations = 1;
    await reader.read(10_000);
    await reader.read(10_000);
    expect(contexts().map((context) => [context.memory !== null, context.invitationAnswered])).toEqual([
      [false, false],
      [true, true],
      [true, true],
    ]);
  });

  test("skipped (no sidebar): not a problem, the last state with it; logged as skipped, never as read again", async () => {
    const answers: unknown[] = [
      { done: false, problem: "a dialog the Agent leaves for the owner is open", state: null },
      { done: false, problem: null, skipped: "no sidebar on the page (the BitVerse, an infiltration?)", state: STATE },
    ];
    const { reader, lines } = readerWith(() => answers.shift());
    await reader.read(10_000);
    expect(await reader.read(10_000)).toEqual({
      backend: "ui",
      state: STATE,
      problem: null,
      skipped: "no sidebar on the page (the BitVerse, an infiltration?)",
    });
    expect(lines).toEqual([
      "agent: the faction state (ui): a dialog the Agent leaves for the owner is open",
      "agent: the faction state's read is skipped: no sidebar on the page (the BitVerse, an infiltration?)",
    ]);
  });

  test("a slow snapshot with no time for the read: unread with the last backend, and logged", async () => {
    const { reader, lines } = readerWith(() => ({ done: true, problem: null, state: STATE }), {
      singularity: true,
      homeRam: 32,
    });
    await reader.read(10_000);
    expect(reader.unread("no time")).toEqual({ backend: "singularity", state: null, problem: "no time" });
    expect(lines).toEqual(["agent: the faction state (singularity): no time"]);
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
    // Welcomed, so the first round sends every tier.
    snapshotter.welcomed();
    const sent: SnapshotMessage[] = [];
    return { snapshotter, order, sent, send: (message: SnapshotMessage) => sent.push(message) };
  }

  test("read after the slow worker and static (the welcome round's), within the round, and sent with its data", async () => {
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
      "snapshot-static.js",
      "readFactions",
    ]);
    expect(sent.map((message) => message.tier)).toEqual(["fast", "medium", "static", "slow"]);
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

  test("under a second of the round left after the slow worker: no read, and the slow snapshot waits for the next round", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { snapshotter, order, sent, send } = snapshotterWith(async () => ({
        backend: "ui",
        state: STATE,
        problem: null,
      }));
      // The workers take most of the round: 1.1 s by the time static has run.
      const startedAtMs = Date.now();
      const advance = (toMs: number) => vi.setSystemTime(startedAtMs + toMs);
      const runOrder = order as string[];
      const push = runOrder.push.bind(runOrder);
      runOrder.push = (...items: string[]) => {
        if (items.includes("snapshot-static.js")) advance(1_100);
        return push(...items);
      };
      await snapshotter.takeRound(send);
      expect(order).not.toContain("readFactions");
      expect(sent.map((message) => message.tier)).toEqual(["fast", "medium", "static"]);
      // The next round: the slow tier is still due, read and sent.
      advance(2_000);
      await snapshotter.takeRound(send);
      expect(order.filter((each) => each === "readFactions")).toHaveLength(1);
      expect(sent.map((message) => message.tier)).toEqual(["fast", "medium", "static", "fast", "slow"]);
      // The first round's slow report, kept: its worker isn't run again (a hung worker's RAM may not leave room).
      expect(order.filter((each) => each === "snapshot-slow.js")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("never waiting for ever: after 3 rounds with no time for the read, the slow snapshot goes, unread, saying why", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { snapshotter, order, sent, send } = snapshotterWith(async () => ({
        backend: "ui",
        state: STATE,
        problem: null,
      }));
      // Every worker takes 1.1 s, so no round has a second left for the read.
      let nowMs = Date.now();
      const runOrder = order as string[];
      const push = runOrder.push.bind(runOrder);
      runOrder.push = (...items: string[]) => {
        nowMs += 1_100;
        vi.setSystemTime(nowMs);
        return push(...items);
      };
      for (let round = 0; round < 3; round += 1) await snapshotter.takeRound(send);
      expect(order).not.toContain("readFactions");
      const slows = sent.filter((message) => message.tier === "slow");
      expect(slows).toHaveLength(1);
      expect((slows[0]?.data as SlowSnapshotData | undefined)?.factions).toEqual({
        backend: "ui",
        state: null,
        problem: noTimeToRead(3),
      });
      expect(noTimeToRead(3)).toBe("no time left for the faction state's read in 3 rounds running (under 1 s each)");
    } finally {
      vi.useRealTimers();
    }
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

test("a restart's note (#212) goes in the first fast snapshot only", async () => {
  const runWorker = vi.fn(
    async (): Promise<WorkerRun> => ({ outcome: "reported", report: { workerPid: 1, gameTimeMs: 5, data: {} } }),
  );
  const note = { outcome: "reloading" as const, reason: "no terminal", atMs: 7 };
  const snapshotter = createSnapshotter({ print: () => {} } as unknown as NS, {
    deploymentId: "abcdef123456",
    agentSessionId: "session",
    workerRunner: { runWorker } as unknown as WorkerRunner,
    intentOutcomes: () => [],
    workOutcome: () => null,
    dialogReport: () => ({ handled: [], blocking: null }),
    restartNote: note,
    readFactions: async () => ({ backend: "ui", state: STATE, problem: null }),
  });
  const sent: SnapshotMessage[] = [];
  await snapshotter.takeRound((message) => sent.push(message));
  await snapshotter.takeRound((message) => sent.push(message));
  const fasts = sent
    .filter((message) => message.tier === "fast")
    .map((message) => message.data as { restart?: unknown });
  expect(fasts.map((data) => data.restart)).toEqual([note, undefined]);
});
