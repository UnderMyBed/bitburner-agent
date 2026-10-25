import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { aggregate, type ScenarioRun, type SeedResult } from "@bitburner-agent/sim";
import { describe, expect, test, vi } from "vitest";
import { baselineCli, type CliDeps } from "../src/cli.ts";

const HOUR = 60 * 60 * 1000;

function seed(n: number, passed: boolean): SeedResult {
  return {
    seed: n,
    ok: true,
    stoppedBy: passed ? { list: "stopWhen", index: 0 } : null,
    passed,
    uncaught: 0,
    virtualMs: 30 * HOUR,
    wallMs: 20 * 60_000,
    speed: 90,
    checkpoints: [],
    events: [],
  };
}

function deps(results: SeedResult[], overrides: Partial<CliDeps> = {}) {
  const output: string[] = [];
  const errors: string[] = [];
  const runScenario = vi.fn(
    async (): Promise<ScenarioRun> => ({ scenario: "legacy-bn1", results, aggregate: aggregate(results) }),
  );
  const all: CliDeps = {
    buildEngine: async () => undefined,
    runScenario,
    commit: () => "abc1234-dirty",
    rig: () => "test-rig",
    now: () => new Date(Date.UTC(2026, 9, 25, 23, 30)),
    node: "v24.0.0",
    cwd: mkdtempSync(path.join(tmpdir(), "baseline-cli-")),
    log: (text) => output.push(text),
    error: (text) => errors.push(text),
    ...overrides,
  };
  return { all, runScenario, output, errors };
}

describe("the baseline CLI", () => {
  test("exits 0 when every seed destroyed the BitNode, and prints the row with the run's details", async () => {
    const { all, runScenario, output } = deps([seed(1, true), seed(2, true)]);
    expect(await baselineCli(["--seeds", "1..2"], all)).toBe(0);
    expect(runScenario).toHaveBeenCalledWith(expect.objectContaining({ name: expect.stringMatching(/^legacy-bn1/) }), {
      workers: 1,
      seeds: [1, 2],
      measureHeap: true,
    });
    expect(output.at(-1)).toContain("| 2026-10-25 | abc1234-dirty | test-rig | v24.0.0 | 1..2 | 2/2 |");
  });

  test("exits 1 when any seed didn't", async () => {
    const { all } = deps([seed(1, true), seed(2, false)]);
    expect(await baselineCli([], all)).toBe(1);
  });

  test("runs one seed at a time unless --workers says otherwise", async () => {
    const { all, runScenario } = deps([seed(1, true)]);
    await baselineCli(["--workers", "3"], all);
    expect(runScenario).toHaveBeenCalledWith(expect.anything(), { workers: 3, measureHeap: true });
  });

  test("writes --json relative to where npm ran, before printing anything", async () => {
    const { all, output } = deps([seed(1, true)], {
      log: () => {
        throw new Error("printing failed");
      },
    });
    await expect(baselineCli(["--json", "run.json"], all)).rejects.toThrow("printing failed");
    expect(output).toEqual([]);
    const written = JSON.parse(readFileSync(path.join(all.cwd, "run.json"), "utf8")) as ScenarioRun;
    expect(written.results.map((r) => r.seed)).toEqual([1]);
  });

  test.each([
    ["a positional argument", ["extra"], {}, /usage: npm run baseline/],
    ["a --json folder that doesn't exist", ["--json", "missing/run.json"], {}, /--json: no folder/],
    [
      "a rig name it can't use",
      [],
      {
        rig: () => {
          throw new RangeError('BENCH_RIG can\'t contain "|"');
        },
      },
      /BENCH_RIG/,
    ],
    [
      "no commit to name",
      [],
      {
        commit: () => {
          throw new Error("not a git repository");
        },
      },
      /not a git repository/,
    ],
  ])("refuses %s with exit 2, before running anything", async (_, argv, overrides, message) => {
    const { all, runScenario, errors } = deps([seed(1, true)], overrides as Partial<CliDeps>);
    expect(await baselineCli(argv, all)).toBe(2);
    expect(runScenario).not.toHaveBeenCalled();
    expect(errors.join("\n")).toMatch(message);
  });

  test("exits 2 if the run as a whole couldn't happen", async () => {
    const { all, errors } = deps([], {
      runScenario: async () => {
        throw new Error("engine failed to load");
      },
    });
    expect(await baselineCli([], all)).toBe(2);
    expect(errors).toEqual(["engine failed to load"]);
  });
});
