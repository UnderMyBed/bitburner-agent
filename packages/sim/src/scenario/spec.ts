// Scenario specs: what to run in a simulation, as JSON. A scenario file says where a run starts, which scripts run,
// for how long, and what ends it; the runner (run.ts) runs it once per seed. docs/sim/scenarios.md is the reference.
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  type Fixture,
  MIN_HEAP_MB,
  maxHeapError,
  type OnBitVerse,
  type PromptRule,
  type ScriptArg,
  type StopCondition,
  validateBitNodeFixture,
  validateHomeRam,
  validatePrompts,
  validateRun,
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
   * scenario file, and inside its directory) whose files are all written, under their relative paths.
   */
  files?: Record<string, Record<string, string> | string>;
  /** Scripts to start, in order, after the files are written. */
  run?: ScriptToRun[];
  /** The most virtual time a run takes, in ms. */
  durationMs: number;
  /** The run ends early, and passes, after the first moment at which any of these holds. */
  stopWhen?: StopCondition[];
  /** The run ends early, and fails, after the first moment at which any of these holds. */
  failWhen?: StopCondition[];
  /** What happens when the game reaches the BitVerse. Without it, the game waits there. */
  onBitVerse?: OnBitVerse;
  /** How `ns.prompt` is answered (see `SimulationOptions.prompts`). */
  prompts?: PromptRule[];
  /** Take a summary every this many virtual ms (and at the end). */
  checkpointEveryMs?: number;
  /** Seeds to run, as a list or an inclusive range. Default `[1]`. */
  seeds?: number[] | { from: number; to: number };
  /**
   * Home's RAM, in GB: a harness edit for test and benchmark workloads. A run with it isn't a state a player can
   * reach, so its results don't compare with real play.
   */
  homeRamGb?: number;
}

const KEYS: Record<keyof Scenario, true> = {
  name: true,
  fixture: true,
  epochMs: true,
  files: true,
  run: true,
  durationMs: true,
  stopWhen: true,
  failWhen: true,
  onBitVerse: true,
  prompts: true,
  checkpointEveryMs: true,
  seeds: true,
  homeRamGb: true,
};

/** The seeds a scenario runs, in order. */
export function scenarioSeeds(seeds: Scenario["seeds"] = [1]): number[] {
  if (Array.isArray(seeds)) return seeds;
  return Array.from({ length: seeds.to - seeds.from + 1 }, (_, i) => seeds.from + i);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const isSeed = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0xffffffff;

/** A file directory must stay inside the scenario's directory, and not be it (that would copy the scenario too). */
function isContainedDirectory(dir: string): boolean {
  const normal = path.normalize(dir);
  return !path.isAbsolute(dir) && normal !== "." && normal !== ".." && !normal.startsWith(`..${path.sep}`);
}

function validateFixtureShape(fixture: unknown, epochMs: unknown): void {
  if (!isRecord(fixture)) throw new RangeError("fixture: { kind: … }, as Simulation takes it");
  switch (fixture.kind) {
    case "new":
      if (fixture.tutorial !== "running" && fixture.tutorial !== "skipped") {
        throw new RangeError('fixture: a new game needs tutorial: "running" or "skipped"');
      }
      break;
    case "bitnode":
      validateBitNodeFixture(fixture as never);
      break;
    case "save": {
      if (typeof fixture.path !== "string" || fixture.bytes !== undefined) {
        throw new RangeError("fixture: a save fixture in a scenario needs a path (relative to the scenario file)");
      }
      const offline = fixture.offlineMs;
      if (offline !== undefined && !(Number.isSafeInteger(offline) && (offline as number) >= 0)) {
        throw new RangeError("fixture.offlineMs: a non-negative integer");
      }
      if (epochMs !== undefined) throw new RangeError("epochMs: a save fixture takes its epoch from the save");
      return;
    }
    default:
      throw new RangeError(`fixture: kind "new", "bitnode" or "save", got ${JSON.stringify(fixture.kind)}`);
  }
  if (!(Number.isSafeInteger(epochMs) && (epochMs as number) >= 0)) {
    throw new RangeError("epochMs: required (a non-negative integer) unless the fixture is a save");
  }
}

function validateRunEntry(run: unknown, i: number): void {
  if (!isRecord(run) || typeof run.script !== "string" || run.script === "") {
    throw new RangeError(`run[${i}]: { script, host?, threads?, args? }`);
  }
  if (run.host !== undefined && (typeof run.host !== "string" || run.host === "")) {
    throw new RangeError(`run[${i}].host: a server name`);
  }
  const threads = run.threads ?? 1;
  if (!Number.isSafeInteger(threads) || (threads as number) < 1) {
    throw new RangeError(`run[${i}].threads: a positive integer`);
  }
  if (run.args !== undefined && !Array.isArray(run.args)) throw new RangeError(`run[${i}].args: a list`);
  validateRun({ threads: threads as number, args: (run.args ?? []) as ScriptArg[] });
}

/**
 * Checks a scenario completely, short of reading the files it names: throws a RangeError naming what's wrong. So a bad
 * scenario is refused once, rather than failing every seed the same way.
 */
export function validateScenario(value: unknown): asserts value is Scenario {
  const field = (name: string, check: () => void) => {
    try {
      check();
    } catch (error) {
      const message = (error as Error).message;
      throw new RangeError(`invalid scenario: ${message.startsWith(name) ? "" : `${name}: `}${message}`);
    }
  };
  if (!isRecord(value)) throw new RangeError("invalid scenario: a scenario is a JSON object");
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(KEYS, key)) throw new RangeError(`invalid scenario: unknown field "${key}"`);
  }
  const s = value as Record<string, unknown>;
  field("name", () => {
    if (typeof s.name !== "string" || s.name === "") throw new RangeError("a non-empty string");
  });
  field("fixture", () => validateFixtureShape(s.fixture, s.epochMs));
  field("durationMs", () => {
    if (!Number.isSafeInteger(s.durationMs) || (s.durationMs as number) <= 0)
      throw new RangeError("a positive integer");
  });
  if (s.checkpointEveryMs !== undefined) {
    field("checkpointEveryMs", () => {
      if (!Number.isSafeInteger(s.checkpointEveryMs) || (s.checkpointEveryMs as number) <= 0) {
        throw new RangeError("a positive integer");
      }
    });
  }
  if (s.files !== undefined) {
    field("files", () => {
      if (!isRecord(s.files)) throw new RangeError("{ host: { path: content } or a directory }");
      for (const [host, files] of Object.entries(s.files)) {
        if (typeof files === "string") {
          if (!isContainedDirectory(files)) {
            throw new RangeError(`files.${host}: a directory inside the scenario's own directory, got "${files}"`);
          }
        } else if (!isRecord(files) || !Object.values(files).every((c) => typeof c === "string")) {
          throw new RangeError(`files.${host}: { path: content } or a directory`);
        }
      }
    });
  }
  if (s.run !== undefined) {
    field("run", () => {
      if (!Array.isArray(s.run)) throw new RangeError("a list of { script, host?, threads?, args? }");
      s.run.forEach(validateRunEntry);
    });
  }
  if (s.seeds !== undefined) {
    field("seeds", () => {
      const range = s.seeds as { from?: unknown; to?: unknown };
      const ok = Array.isArray(s.seeds)
        ? s.seeds.length > 0 && s.seeds.every(isSeed) && new Set(s.seeds).size === s.seeds.length
        : isRecord(s.seeds) && isSeed(range.from) && isSeed(range.to) && range.from <= range.to;
      if (!ok) throw new RangeError("a non-empty list of distinct seeds, or { from, to }");
    });
  }
  if (s.homeRamGb !== undefined) field("homeRamGb", () => validateHomeRam(s.homeRamGb as number));
  if (s.prompts !== undefined) field("prompts", () => validatePrompts(s.prompts as PromptRule[]));
  for (const name of ["stopWhen", "failWhen"] as const) {
    if (s[name] !== undefined) {
      field(name, () => {
        if (!Array.isArray(s[name])) throw new RangeError("a list of stop conditions");
        validateRunUntil({ ms: 0, stopWhen: s[name] as StopCondition[] });
      });
    }
  }
  if (s.onBitVerse !== undefined) {
    field("onBitVerse", () => validateRunUntil({ ms: 0, onBitVerse: s.onBitVerse as OnBitVerse }));
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

/** A `--seeds` value: a range "3..7" or a list "1,2,5"; every part a plain integer, no duplicates. */
export function parseSeeds(text: string): number[] {
  const range = /^(\d+)\.\.(\d+)$/.exec(text);
  const seeds = range
    ? Array.from({ length: Number(range[2]) - Number(range[1]) + 1 }, (_, i) => Number(range[1]) + i)
    : text.split(",").map((part) => (/^\d+$/.test(part) ? Number(part) : Number.NaN));
  if (seeds.length === 0 || !seeds.every(isSeed) || new Set(seeds).size !== seeds.length) {
    throw new RangeError(`--seeds: a range a..b (a <= b) or a list a,b,c of distinct seeds, got "${text}"`);
  }
  return seeds;
}

/** A `--workers` value: a positive integer. */
export function parseWorkers(text: string): number {
  if (!/^\d+$/.test(text) || Number(text) < 1) throw new RangeError(`--workers: a positive integer, got "${text}"`);
  return Number(text);
}

/** The longest wall limit, in ms: the most a timer can wait (2^31 − 1 ms, about 24.8 days). */
export const MAX_WALL_LIMIT_MS = 2 ** 31 - 1;

/** A `--wall-limit` value: whole minutes of real time per seed, from 1 to 35,791 (`MAX_WALL_LIMIT_MS`). Returns ms. */
export function parseWallLimit(text: string): number {
  const most = Math.floor(MAX_WALL_LIMIT_MS / 60_000);
  if (!/^\d+$/.test(text) || Number(text) < 1 || Number(text) > most) {
    throw new RangeError(`--wall-limit: whole minutes of real time per seed, 1 to ${most}, got "${text}"`);
  }
  return Number(text) * 60_000;
}

/** A `--max-heap` value: whole MB per simulation, at least `MIN_HEAP_MB` (`SimulationOptions.maxHeapMb`). */
export function parseMaxHeap(text: string): number {
  if (!/^\d+$/.test(text) || maxHeapError(Number(text))) {
    throw new RangeError(`--max-heap: whole MB per simulation, at least ${MIN_HEAP_MB}, got "${text}"`);
  }
  return Number(text);
}
