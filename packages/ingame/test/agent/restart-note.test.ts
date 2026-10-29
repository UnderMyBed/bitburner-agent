// @vitest-environment jsdom
// A restart that couldn't type `run /agent/boot.js` fails loudly (#212): the page timer's note in the page's storage,
// taken only as the fast snapshot that carries it is built, so an Agent handed over before its welcome leaves it for
// the next; one that can't be read is still reported; a restart that never happened leaves none. The timer's own
// paths are in ./install-page.test.ts; E2 covers the fallback end to end.
import { RESTART_NOTE_STORAGE_KEY, type SnapshotMessage } from "@bitburner-agent/core";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { WorkerRun, WorkerRunner } from "../../src/agent/run-worker.ts";
import { createSnapshotter } from "../../src/agent/snapshotter.ts";
import type { NS } from "../../src/ns.ts";
import { armRestart, parseRestartNote, takeRestartNote } from "../../src/page/restart-timer.ts";

afterEach(() => {
  localStorage.clear();
  vi.useRealTimers();
  document.body.replaceChildren();
});

const NOTE = { outcome: "reloading" as const, reason: "no terminal", atMs: 7 };

/** An Agent's snapshotter, taking the note from the page as the real Agent does. */
function agentSnapshotter() {
  const runWorker = vi.fn(
    async (): Promise<WorkerRun> => ({ outcome: "reported", report: { workerPid: 1, gameTimeMs: 5, data: {} } }),
  );
  const snapshotter = createSnapshotter({ print: () => {} } as unknown as NS, {
    deploymentId: "abcdef123456",
    agentSessionId: "session",
    workerRunner: { runWorker } as unknown as WorkerRunner,
    intentOutcomes: () => [],
    workOutcome: () => null,
    dialogReport: () => ({ handled: [], blocking: null }),
    takeRestartNote,
    readFactions: async () => ({
      backend: "ui",
      state: { joined: [], invitations: [], queuedAugmentations: [] },
      problem: null,
    }),
  });
  const sent: SnapshotMessage[] = [];
  const restarts = () =>
    sent.filter((message) => message.tier === "fast").map((message) => (message.data as { restart?: unknown }).restart);
  return { snapshotter, send: (message: SnapshotMessage) => sent.push(message), restarts };
}

describe("the note goes to the brain once, never lost", () => {
  test("an Agent handed over before its welcome (told to restart) leaves it; the next Agent's first fast snapshot has it", async () => {
    localStorage.setItem(RESTART_NOTE_STORAGE_KEY, JSON.stringify(NOTE));
    // The first Agent starts, is told to restart onto the deployment (no welcome, so no round), and hands over.
    agentSnapshotter();
    expect(localStorage.getItem(RESTART_NOTE_STORAGE_KEY)).not.toBeNull();
    // The next is welcomed: its first fast snapshot carries the note, the next one none.
    const next = agentSnapshotter();
    await next.snapshotter.takeRound(next.send);
    await next.snapshotter.takeRound(next.send);
    expect(next.restarts()).toEqual([NOTE, undefined]);
    expect(localStorage.getItem(RESTART_NOTE_STORAGE_KEY)).toBeNull();
  });

  test("a note that can't be read is reported as given up, never dropped", () => {
    localStorage.setItem(RESTART_NOTE_STORAGE_KEY, "{not json");
    expect(takeRestartNote()).toEqual({ outcome: "gaveUp", reason: "unreadable restart note", atMs: 0 });
    expect(takeRestartNote()).toBeNull();
    for (const text of ["null", "3", JSON.stringify({ outcome: "sideways", reason: "x", atMs: 1 })]) {
      expect(parseRestartNote(text)).toEqual({ outcome: "gaveUp", reason: "unreadable restart note", atMs: 0 });
    }
  });

  test("a restart that stops (nothing was reset) leaves no note", async () => {
    vi.useFakeTimers();
    const restart = armRestart(document, "agent/boot.js", [
      { limitMs: 1_000, look: () => false, late: { action: "stop", reason: "the BitVerse never came" } },
    ]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(restart.state()).toEqual({ outcome: "stopped", fallbackReason: "the BitVerse never came" });
    expect(takeRestartNote()).toBeNull();
  });
});
