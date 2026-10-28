// The Agent's safe mode (#160, architecture §5.4): what it keeps of the last desired state, when it writes it to home,
// and when it converges on it with no brain, or drops it. The file is a stand-in; the simulator runs the real one.
import {
  DESIRED_STATE_FILE,
  type DesiredState,
  parseSafeModeState,
  type SafeModeState,
  type Work,
} from "@bitburner-agent/core";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { createSafeMode } from "../../src/agent/safe-mode.ts";
import type { NS } from "../../src/ns.ts";

const HOUR = 60 * 60_000;
const START = 1_767_225_600_000;
const RESET = 1_767_220_000_000;
const LOOP: DesiredState["hackLoop"] = { enabled: true, target: "n00dles", hosts: ["n00dles", "foodnstuff"] };
const HACKING: Work = { kind: "faction", faction: "CyberSec", workType: "hacking", focus: true };
const TRAVEL = { id: "travel(Aevum)", action: "travel" as const, args: { city: "Aevum" } };
const STATE: DesiredState = { hackLoop: LOOP, intents: [TRAVEL], work: HACKING, ttlMs: HOUR };

/** A home with files, and an Agent's log: `restart()` is a new Agent on the same home (a reload, a new deployment). */
function homeWith(files = new Map<string, string>()) {
  const lines: string[] = [];
  const ns = {
    read: (file: string) => files.get(file) ?? "",
    write: (file: string, data: string, mode: string) => {
      if (mode !== "w") throw new Error(`written with mode ${mode}`);
      files.set(file, data);
    },
    print: (line: string) => lines.push(line),
  } as unknown as NS;
  const kept = (): SafeModeState | null => {
    const text = files.get(DESIRED_STATE_FILE) ?? "";
    if (text === "") return null;
    const parsed = parseSafeModeState(text);
    if (!parsed.ok) throw new Error(`the file doesn't parse: ${parsed.reason}`);
    return parsed.message;
  };
  return { safeMode: createSafeMode(ns), files, lines, kept, restart: () => homeWith(files) };
}

test("nothing kept: nothing to converge on, and no rounds needed", () => {
  const { safeMode } = homeWith();
  expect(safeMode.holds()).toBe(false);
  expect(safeMode.toConverge(START, RESET)).toBeNull();
});

test("a state heard is kept and written at once: its activities, never its intents, with when and the last reset", () => {
  const { safeMode, kept } = homeWith();
  safeMode.heard(STATE, START, RESET);
  expect(kept()).toEqual({ hackLoop: LOOP, work: HACKING, ttlMs: HOUR, heardAtMs: START, lastAugReset: RESET });
  expect(safeMode.holds()).toBe(true);
  // Disconnected at once: converged on, the intents left out.
  safeMode.disconnected(START);
  expect(safeMode.toConverge(START, RESET)).toEqual({ hackLoop: LOOP, work: HACKING });
});

test("no work managed is kept as none: safe mode leaves the work alone too", () => {
  const { safeMode, kept } = homeWith();
  safeMode.heard({ hackLoop: LOOP, intents: [], ttlMs: HOUR }, START, RESET);
  expect(kept()?.work).toBeNull();
  safeMode.disconnected(START);
  expect(safeMode.toConverge(START, RESET)).toEqual({ hackLoop: LOOP, work: null });
});

test("a state with no ttlMs (an older brain) isn't kept, and the one kept before is dropped", () => {
  const { safeMode, files, lines } = homeWith();
  safeMode.heard(STATE, START, RESET);
  safeMode.heard({ hackLoop: LOOP, intents: [] }, START + 1_000, RESET);
  expect(files.get(DESIRED_STATE_FILE)).toBe("");
  expect(safeMode.holds()).toBe(false);
  safeMode.disconnected(START + 2_000);
  expect(safeMode.toConverge(START + 2_000, RESET)).toBeNull();
  expect(lines).toEqual(["agent: safe mode: dropped the last desired state: the brain's latest has no ttlMs"]);
});

test("a ttlMs of 0 is none: the state isn't kept", () => {
  const { safeMode, lines } = homeWith();
  safeMode.heard(STATE, START, RESET);
  safeMode.heard({ ...STATE, ttlMs: 0 }, START + 1_000, RESET);
  expect(safeMode.holds()).toBe(false);
  expect(lines).toEqual(["agent: safe mode: dropped the last desired state: the brain's latest has no ttlMs"]);
});

test("a state heard before the last reset is known empties the file: a new Agent finds none, never the older one", () => {
  const first = homeWith();
  first.safeMode.heard(STATE, START, RESET);
  // Restarted, and sent a new state before its first slow snapshot.
  const second = first.restart();
  second.safeMode.heard({ ...STATE, hackLoop: { ...LOOP, target: "joesguns" } }, START + 10_000, null);
  expect(second.files.get(DESIRED_STATE_FILE)).toBe("");
  const third = second.restart();
  expect(third.safeMode.holds()).toBe(false);
});

test("before the Agent knows the last reset, it's kept but not written; written once the slow snapshot says", () => {
  const { safeMode, kept } = homeWith();
  safeMode.heard(STATE, START, null);
  expect(kept()).toBeNull();
  safeMode.connectedRound(START + 2_000, null);
  expect(kept()).toBeNull();
  safeMode.connectedRound(START + 4_000, RESET);
  expect(kept()).toMatchObject({ heardAtMs: START + 4_000, lastAugReset: RESET });
});

test("connected to the brain that sent it: written again every 30 rounds (60 s), and at the disconnect, with its time", () => {
  const { safeMode, kept } = homeWith();
  safeMode.heard(STATE, START, RESET);
  for (let round = 1; round < 30; round += 1) safeMode.connectedRound(START + round * 2_000, RESET);
  expect(kept()?.heardAtMs).toBe(START);
  safeMode.connectedRound(START + 60_000, RESET);
  expect(kept()?.heardAtMs).toBe(START + 60_000);
  safeMode.connectedRound(START + 62_000, RESET);
  safeMode.disconnected(START + 63_000);
  expect(kept()?.heardAtMs).toBe(START + 63_000);
});

test("with no brain: converged on until ttlMs after the disconnect, then dropped, logged, and the file emptied", () => {
  const { safeMode, files, lines } = homeWith();
  safeMode.heard(STATE, START, RESET);
  safeMode.disconnected(START + 10_000);
  expect(safeMode.toConverge(START + 10_000 + HOUR - 1, RESET)).not.toBeNull();
  expect(lines).toEqual([
    `agent: safe mode: no brain: converging on its last desired state, without intents, until ${new Date(START + 10_000 + HOUR).toISOString()}`,
  ]);
  expect(safeMode.toConverge(START + 10_000 + HOUR, RESET)).toBeNull();
  expect(safeMode.holds()).toBe(false);
  expect(files.get(DESIRED_STATE_FILE)).toBe("");
  expect(lines.at(-1)).toBe("agent: safe mode: dropped the last desired state: no brain for 1 h, its ttlMs");
});

test("a brain connected that sends nothing doesn't move the clock on: it runs from the last brain that sent it", () => {
  const { safeMode, kept } = homeWith();
  safeMode.heard(STATE, START, RESET);
  safeMode.disconnected(START);
  // Reconnected to a brain that holds, for a while: it sent nothing, so it vouches for nothing.
  for (let round = 1; round <= 100; round += 1) safeMode.connectedRound(START + round * 2_000, RESET);
  safeMode.disconnected(START + 201_000);
  expect(kept()?.heardAtMs).toBe(START);
  expect(safeMode.toConverge(START + HOUR - 1, RESET)).not.toBeNull();
  expect(safeMode.toConverge(START + HOUR, RESET)).toBeNull();
});

describe("a new Agent (a reload, an install's restart, a new deployment) reads the file", () => {
  function keptThenRestarted() {
    const before = homeWith();
    before.safeMode.heard(STATE, START, RESET);
    before.safeMode.disconnected(START + 5_000);
    return before.restart();
  }

  test("with the game's last reset unchanged, it converges on it, until the same time as before", () => {
    const { safeMode } = keptThenRestarted();
    expect(safeMode.holds()).toBe(true);
    expect(safeMode.toConverge(START + 30 * 60_000, RESET)).toEqual({ hackLoop: LOOP, work: HACKING });
    expect(safeMode.toConverge(START + 5_000 + HOUR, RESET)).toBeNull();
  });

  test("before it knows the game's last reset, it waits: kept, not converged on", () => {
    const { safeMode } = keptThenRestarted();
    expect(safeMode.toConverge(START + 10_000, null)).toBeNull();
    expect(safeMode.holds()).toBe(true);
    expect(safeMode.toConverge(START + 12_000, RESET)).not.toBeNull();
  });

  test("after a reset (an install, a new BitNode), it's dropped: its target may be unhackable", () => {
    const { safeMode, files, lines } = keptThenRestarted();
    expect(safeMode.toConverge(START + 10_000, RESET + 1)).toBeNull();
    expect(safeMode.holds()).toBe(false);
    expect(files.get(DESIRED_STATE_FILE)).toBe("");
    expect(lines).toEqual(["agent: safe mode: dropped the last desired state: it's from before the game's last reset"]);
    // Never back, whatever it's told of the reset afterwards.
    expect(safeMode.toConverge(START + 12_000, RESET)).toBeNull();
  });

  test("checked while connected, too: the slow snapshot's reset drops a stale one before any disconnect", () => {
    const { safeMode } = keptThenRestarted();
    safeMode.connectedRound(START + 10_000, RESET + 1);
    expect(safeMode.holds()).toBe(false);
  });

  test("a brain's state replaces it, without the check: this Agent heard it itself", () => {
    const { safeMode, kept } = keptThenRestarted();
    const other = { ...STATE, hackLoop: { ...LOOP, target: "joesguns" } };
    safeMode.heard(other, START + 10_000, null);
    safeMode.disconnected(START + 12_000);
    expect(safeMode.toConverge(START + 12_000, null)).toEqual({ hackLoop: other.hackLoop, work: HACKING });
    // Written once the reset is known.
    safeMode.connectedRound(START + 14_000, RESET);
    expect(kept()?.hackLoop.target).toBe("joesguns");
  });

  test("a file that doesn't parse is ignored, and the log says why", () => {
    const { safeMode, lines } = homeWith(new Map([[DESIRED_STATE_FILE, '{"hackLoop":true}']]));
    expect(safeMode.holds()).toBe(false);
    expect(lines).toEqual([`agent: safe mode: ignored ${DESIRED_STATE_FILE}: hackLoop isn't an object`]);
  });
});

describe("properties (§9.3)", () => {
  const anyHackLoop = fc.record({
    enabled: fc.boolean(),
    target: fc.constantFrom(null, "n00dles", "joesguns"),
    hosts: fc.subarray(["n00dles", "foodnstuff", "sigma-cosmetics"]),
  });
  const anyWork = fc.constantFrom<Work | undefined>(undefined, HACKING, {
    kind: "crime",
    crime: "Shoplift",
    focus: false,
  });
  const anyState = fc.record({
    hackLoop: anyHackLoop,
    work: anyWork,
    ttlMs: fc.constantFrom(undefined, 0, 60_000, HOUR),
  });
  /**
   * What can happen: the brain sends a state (when connected), a round (connected or not), the connection goes or comes
   * back (to a brain that sends nothing yet), time passes, the Agent restarts (a reload), or a reset (always with a new
   * Agent). `slowKnown` is whether the Agent has had a slow snapshot this run.
   */
  const anyStep = fc.oneof(
    fc.record({ kind: fc.constant("heard" as const), state: anyState }),
    fc.record({ kind: fc.constant("round" as const), slowKnown: fc.boolean() }),
    fc.record({ kind: fc.constant("disconnect" as const) }),
    fc.record({ kind: fc.constant("connect" as const) }),
    fc.record({
      kind: fc.constant("wait" as const),
      ms: fc.oneof(fc.integer({ min: 0, max: 10 * 60_000 }), fc.integer({ min: 0, max: 2 * HOUR })),
    }),
    fc.record({ kind: fc.constant("restart" as const) }),
    fc.record({ kind: fc.constant("reset" as const) }),
  );

  test("never past ttlMs, from before a reset, other than the last state a brain sent, or with intents; and it converges", () => {
    fc.assert(
      fc.property(fc.array(anyStep, { maxLength: 60 }), (steps) => {
        let home = homeWith();
        let nowMs = START;
        let lastAugReset = RESET;
        let connected = true;
        /** The Agent has had a slow snapshot (the game's last reset) since it started. */
        let slowKnown = true;
        // The reference: the last state a brain sent, and since then.
        let last: { hackLoop: DesiredState["hackLoop"]; work?: Work | undefined; ttlMs?: number | undefined } | null =
          null;
        let lastConnectedToSenderAtMs = START;
        let connectedToSender = false;
        let resetSinceLast = false;
        let restartedSinceLast = false;
        /** The file's clock is exact: last written at a disconnect from the sender, with nothing heard since. */
        let fileClockExact = false;
        for (const step of steps) {
          if (step.kind === "heard") {
            if (!connected) continue;
            const state = { ...step.state, intents: [TRAVEL] } as DesiredState;
            home.safeMode.heard(state, nowMs, slowKnown ? lastAugReset : null);
            last = step.state;
            lastConnectedToSenderAtMs = nowMs;
            connectedToSender = true;
            resetSinceLast = false;
            restartedSinceLast = false;
            fileClockExact = false;
          } else if (step.kind === "round") {
            slowKnown ||= step.slowKnown;
            const known = slowKnown ? lastAugReset : null;
            if (connected) {
              home.safeMode.connectedRound(nowMs, known);
              if (connectedToSender) lastConnectedToSenderAtMs = nowMs;
              continue;
            }
            const ttlMs = last?.ttlMs ?? 0;
            const converging = home.safeMode.toConverge(nowMs, known);
            if (converging !== null) {
              // The last state a brain sent, its activities only (no intents), within its ttlMs, from this reset.
              expect(converging).toEqual({ hackLoop: last?.hackLoop, work: last?.work ?? null });
              expect(nowMs).toBeLessThan(lastConnectedToSenderAtMs + ttlMs);
              expect(resetSinceLast).toBe(false);
            } else {
              const live =
                last !== null &&
                ttlMs > 0 &&
                !resetSinceLast &&
                nowMs < lastConnectedToSenderAtMs + ttlMs &&
                (!restartedSinceLast || (fileClockExact && slowKnown));
              expect(live, "a state within its ttlMs, from this reset, wasn't converged on").toBe(false);
            }
          } else if (step.kind === "disconnect") {
            if (!connected) continue;
            home.safeMode.disconnected(nowMs);
            if (connectedToSender) {
              lastConnectedToSenderAtMs = nowMs;
              // Written with the disconnect's time, when the Agent knows the reset to stamp it with.
              fileClockExact = slowKnown;
            }
            connected = false;
            connectedToSender = false;
          } else if (step.kind === "connect") {
            connected = true;
          } else if (step.kind === "wait") {
            nowMs += step.ms;
          } else {
            // A new Agent: not connected, no slow snapshot yet. A reset always comes with one.
            if (step.kind === "reset") {
              lastAugReset += 1;
              resetSinceLast = true;
            }
            // Its sender connected until now: the file's clock may be up to 30 rounds behind.
            if (connectedToSender) fileClockExact = false;
            restartedSinceLast = true;
            home = home.restart();
            connected = false;
            connectedToSender = false;
            slowKnown = false;
          }
        }
      }),
      { numRuns: 300 },
    );
  });
});
