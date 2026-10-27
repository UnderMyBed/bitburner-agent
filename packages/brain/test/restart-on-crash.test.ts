// The brain's runner (#122), with stand-in scripts for the brain: none of these start a brain.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { restartDelayMs, restartOnCrash } from "../src/restart-on-crash.ts";

const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "restart-on-crash-"));
afterAll(() => rmSync(temporaryDirectory, { recursive: true, force: true }));

/** A stand-in brain: appends a line to `runs.txt` each time it starts, then does `body`. */
function standIn(name: string, body: string): { script: string; runs: () => number } {
  const script = path.join(temporaryDirectory, `${name}.mjs`);
  const runsFile = path.join(temporaryDirectory, `${name}-runs.txt`);
  writeFileSync(
    script,
    `import fs from "node:fs";\nfs.appendFileSync(${JSON.stringify(runsFile)}, "run\\n");\n${body}\n`,
  );
  return {
    script,
    runs: () => {
      try {
        return readFileSync(runsFile, "utf8").split("\n").filter(Boolean).length;
      } catch {
        return 0;
      }
    },
  };
}

function runner(script: string, options: { restartDelaysMs?: number[]; steadyRunMs?: number; maxRuns?: number }) {
  const lines: string[] = [];
  const handle = restartOnCrash({
    command: process.execPath,
    args: [script],
    restartDelaysMs: options.restartDelaysMs ?? [10],
    steadyRunMs: options.steadyRunMs ?? 60_000,
    log: (line) => lines.push(line),
    maxRuns: options.maxRuns,
  });
  return { handle, lines };
}

describe("restartOnCrash", () => {
  test("a brain that crashes is started again, each restart said, until it stops crashing", async () => {
    const crashing = standIn("crashing", "process.exit(3);");
    const { handle, lines } = runner(crashing.script, { maxRuns: 3 });
    await handle.finished;
    expect(crashing.runs()).toBe(3);
    expect(lines).toEqual([
      "the brain exited (code 3); restarting in 0.01 s",
      "the brain exited (code 3); restarting in 0.01 s",
    ]);
  });

  test("a brain that exits 0 (it was told to stop) isn't started again", async () => {
    const stopping = standIn("stopping", "process.exit(0);");
    const { handle, lines } = runner(stopping.script, {});
    await handle.finished;
    expect(stopping.runs()).toBe(1);
    expect(lines).toEqual(["the brain stopped"]);
  });

  test("crashes in a row wait longer each time, up to the last delay; a steady run starts the row over", async () => {
    const crashing = standIn("backing-off", "process.exit(3);");
    const crashLoop = runner(crashing.script, { restartDelaysMs: [10, 20, 30], maxRuns: 5 });
    await crashLoop.handle.finished;
    expect(crashLoop.lines.map((line) => /in ([\d.]+) s/.exec(line)?.[1])).toEqual(["0.01", "0.02", "0.03", "0.03"]);
    // Every run counts as steady (at least 0 ms long): each restart waits the first delay.
    const steady = runner(crashing.script, { restartDelaysMs: [10, 20, 30], steadyRunMs: 0, maxRuns: 3 });
    await steady.handle.finished;
    expect(steady.lines.map((line) => /in ([\d.]+) s/.exec(line)?.[1])).toEqual(["0.01", "0.01"]);
  });

  test("stop() during a run gives the brain its grace, then ends it, and starts nothing again", async () => {
    const running = standIn("running", "setInterval(() => {}, 1_000);");
    const { handle, lines } = runner(running.script, {});
    while (running.runs() === 0) await new Promise((resolve) => setTimeout(resolve, 20));
    await handle.stop({ graceMs: 100 });
    expect(running.runs()).toBe(1);
    expect(lines).toEqual([]);
  });

  test("stop() while waiting to restart cancels the restart", async () => {
    const crashing = standIn("cancelled", "process.exit(3);");
    const { handle, lines } = runner(crashing.script, { restartDelaysMs: [60_000] });
    while (lines.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
    await handle.stop();
    expect(crashing.runs()).toBe(1);
  });

  test("restartDelayMs: the nth crash in a row waits the nth delay, the last one repeating", () => {
    expect([1, 2, 3, 4, 9].map((crashes) => restartDelayMs(crashes, [5, 10, 30]))).toEqual([5, 10, 30, 30, 30]);
  });
});
