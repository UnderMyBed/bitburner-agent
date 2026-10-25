// Scenario specs: what to run in a simulation, as JSON. A scenario file says where a run starts, which scripts run,
// for how long, and what ends it; the runner (run.ts) runs it once per seed.
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  type Fixture,
  type OnBitVerse,
  type PromptRule,
  type ScriptArg,
  type StopCondition,
  validateHomeRam,
  validateRunUntil,
} from "../protocol.ts";

export interface ScriptToRun {
  script: string;
  /** Default "home". */
  host?: string;
  /** Default 1. */
  threads?: number;
  args?: ScriptArg[];
}

export interface Scenario {
  name: string;
  /** Where each run starts. A save fixture's `path` is relative to the scenario file. */
  fixture: Fixture;
  /** The virtual epoch. Required, except with a save fixture, which takes its epoch from the save. */
  epochMs?: number;
  /**
   * Files to write before the scripts start, per host: either `{ path: content }`, or a directory (relative to the
   * scenario file) whose files are all written, under their relative paths.
   */
  files?: Record<string, Record<string, string> | string>;
  /** Scripts to start, in order, after the files are written. */
  run?: ScriptToRun[];
  /** The most virtual time a run takes, in ms. */
  durationMs: number;
  /** A run ends early after the first timer at which any of these holds. */
  stopWhen?: StopCondition[];
  /** What happens when the game reaches the BitVerse. Without it, the game waits there. */
  onBitVerse?: OnBitVerse;
  /** How `ns.prompt` is answered (see `SimulationOptions.prompts`). */
  prompts?: PromptRule[];
  /** Take a summary every this many virtual ms (and at the end). */
  checkpointEveryMs?: number;
  /** Seeds to run, as a list or an inclusive range. Default `[1]`. */
  seeds?: number[] | { from: number; to: number };
  /** Home's RAM, in GB: a harness edit for test and benchmark workloads. */
  homeRamGb?: number;
}

const KEYS = new Set([
  "name",
  "fixture",
  "epochMs",
  "files",
  "run",
  "durationMs",
  "stopWhen",
  "onBitVerse",
  "prompts",
  "checkpointEveryMs",
  "seeds",
  "homeRamGb",
]);

/** The seeds a scenario runs, in order. */
export function scenarioSeeds(seeds: Scenario["seeds"] = [1]): number[] {
  if (Array.isArray(seeds)) return seeds;
  return Array.from({ length: seeds.to - seeds.from + 1 }, (_, i) => seeds.from + i);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isSeed = (value: unknown) => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0xffffffff;

/**
 * Checks a scenario's shape and values; throws a RangeError naming what's wrong. The fixture, epoch and prompt rules
 * are checked in full when a simulation starts.
 */
export function validateScenario(value: unknown): asserts value is Scenario {
  const fail = (message: string): never => {
    throw new RangeError(`invalid scenario: ${message}`);
  };
  if (!isRecord(value)) return fail("a scenario is a JSON object");
  for (const key of Object.keys(value)) if (!KEYS.has(key)) fail(`unknown field "${key}"`);
  const s = value as Partial<Scenario>;
  if (typeof s.name !== "string" || s.name === "") fail("name: a non-empty string");
  if (!isRecord(s.fixture) || typeof s.fixture.kind !== "string") fail("fixture: { kind: … }, as Simulation takes it");
  if (!Number.isSafeInteger(s.durationMs) || (s.durationMs as number) <= 0) fail("durationMs: a positive integer");
  if (s.checkpointEveryMs !== undefined && !(Number.isSafeInteger(s.checkpointEveryMs) && s.checkpointEveryMs > 0)) {
    fail("checkpointEveryMs: a positive integer");
  }
  if (s.files !== undefined) {
    if (!isRecord(s.files)) fail("files: { host: { path: content } or a directory }");
    for (const [host, files] of Object.entries(s.files as Record<string, unknown>)) {
      const ok =
        typeof files === "string" || (isRecord(files) && Object.values(files).every((c) => typeof c === "string"));
      if (!ok) fail(`files.${host}: { path: content } or a directory`);
    }
  }
  if (s.run !== undefined) {
    if (!Array.isArray(s.run)) fail("run: a list of { script, host?, threads?, args? }");
    for (const [i, run] of (s.run as unknown[]).entries()) {
      if (!isRecord(run) || typeof run.script !== "string") fail(`run[${i}]: { script, host?, threads?, args? }`);
    }
  }
  if (s.seeds !== undefined) {
    const range = s.seeds as { from?: unknown; to?: unknown };
    const ok = Array.isArray(s.seeds)
      ? s.seeds.length > 0 && s.seeds.every(isSeed)
      : isSeed(range.from) && isSeed(range.to) && (range.from as number) <= (range.to as number);
    if (!ok) fail("seeds: a non-empty list of seeds, or { from, to }");
  }
  if (s.homeRamGb !== undefined) {
    try {
      validateHomeRam(s.homeRamGb);
    } catch (error) {
      fail(`homeRamGb: ${(error as Error).message}`);
    }
  }
  try {
    validateRunUntil({
      ms: 0,
      ...(s.stopWhen ? { stopWhen: s.stopWhen } : {}),
      ...(s.onBitVerse ? { onBitVerse: s.onBitVerse } : {}),
    });
  } catch (error) {
    fail((error as Error).message);
  }
}

/** Reads and validates a scenario file. Relative paths in it (a save fixture, file directories) are resolved later. */
export function loadScenario(file: string): { scenario: Scenario; baseDir: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new RangeError(`can't read scenario ${file}: ${(error as Error).message}`);
  }
  validateScenario(parsed);
  return { scenario: parsed, baseDir: path.dirname(path.resolve(file)) };
}
