import { afterEach, expect } from "vitest";
import { Simulation, type SimulationOptions } from "../../src/simulation.ts";

/**
 * A `start` function for a test file: it starts simulations, and closes each test's when that test ends.
 * Call it at the top level of the file. Other packages' tests use it too (`@bitburner-agent/sim/test-helpers`).
 */
export function useSimulations(): (options: SimulationOptions) => Promise<Simulation> {
  const open: Simulation[] = [];
  // Each test's simulations close when it ends: a file's worth at once would crowd a CI runner's memory.
  afterEach(async () => {
    await Promise.all(open.splice(0).map((sim) => sim.close()));
  });
  return async (options) => {
    const sim = await Simulation.start(options);
    open.push(sim);
    return sim;
  };
}

export interface ScriptRun {
  name: string;
  pid: number;
  /** What the script passed to `out(…)`, in order. */
  out: unknown[];
  /** The script's whole log. */
  log: string[];
}

let scripts = 0;

/**
 * Writes `body` into a fresh script on home, runs it, and advances `ms` of virtual time. The script has logging off
 * (so its log holds only what it prints) and an `out(value)` helper that records a JSON value for the test.
 */
export async function runScript(sim: Simulation, body: string, ms = 1_000): Promise<ScriptRun> {
  const name = `script${++scripts}.js`;
  await sim.writeFile(
    "home",
    name,
    `export async function main(ns) {\nns.disableLog("ALL");\nconst out = (v) => ns.print("out:" + JSON.stringify(v));\n${body}\n}`,
  );
  const { pid, error } = await sim.run("home", name);
  expect(error).toBeUndefined();
  await sim.advance(ms);
  const log = await sim.logs(pid);
  const out = log.filter((line) => line.startsWith("out:")).map((line) => JSON.parse(line.slice(4)) as unknown);
  return { name, pid, out, log };
}
