import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { topSelfTime } from "../src/bench/profile.ts";
import {
  type BenchRow,
  formatHeader,
  formatRow,
  growthPerDay,
  parseRows,
  regressions,
  rigId,
  rowText,
  WORKLOADS,
} from "../src/bench/report.ts";
import type { CpuProfile } from "../src/protocol.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

const row = (overrides: Partial<BenchRow> = {}): BenchRow => ({
  date: "2026-10-24",
  commit: "abc1234",
  rig: "rig-a",
  node: "v24.11.0",
  speeds: { lean: 26000, batch: 9000, churn: 4000, copies: 7000 },
  heap: { startMb: 120.4, endMb: 131.6, perDayMb: 1.6 },
  ...overrides,
});

describe("rigId", () => {
  const cpu = (model: string) => ({ model, speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } });

  test("is BENCH_RIG when that's set", () => {
    expect(rigId("ci-runner", [cpu("x")], 2 ** 30)).toBe("ci-runner");
  });

  test("refuses a BENCH_RIG that would break the table", () => {
    expect(() => rigId("a|b", [cpu("x")], 2 ** 30)).toThrow(/BENCH_RIG/);
    expect(() => rigId("a\nb", [cpu("x")], 2 ** 30)).toThrow(/BENCH_RIG/);
  });

  test("otherwise names the CPU model, logical CPU count and memory, without trademarks or clock speed", () => {
    const cpus = Array.from({ length: 16 }, () => cpu("AMD Ryzen 9 7950X 16-Core Processor"));
    expect(rigId(undefined, cpus, 64 * 2 ** 30)).toBe("amd-ryzen-9-7950x-16c-64g");
    expect(rigId("", [cpu("Intel(R) Core(TM) i7-9700K CPU @ 3.60GHz")], 15.6 * 2 ** 30)).toBe(
      "intel-core-i7-9700k-1c-16g",
    );
  });
});

describe("benchmark rows", () => {
  test("a row is a table row under the header, one cell per column", () => {
    const columns = (line: string) => line.split("|").length;
    const [header, rule] = formatHeader().split("\n") as [string, string];
    expect(columns(rule)).toBe(columns(header));
    expect(columns(formatRow(row()))).toBe(columns(header));
    expect(formatRow(row())).toBe(
      "| 2026-10-24 | abc1234 | rig-a | v24.11.0 | 26000x | 9000x | 4000x | 7000x | 120.4 MB | 131.6 MB | +1.6 MB |",
    );
    expect(header).toContain(WORKLOADS.join(" | "));
  });

  test("heap shrinking shows as a negative growth", () => {
    expect(formatRow(row({ heap: { startMb: 10, endMb: 9, perDayMb: -0.5 } }))).toContain("| -0.5 MB |");
  });

  test("parsing reads back what formatting wrote, in file order, skipping everything else", () => {
    const second = row({ date: "2026-10-25", commit: "def5678-dirty", heap: { startMb: 1, endMb: 2, perDayMb: -0.3 } });
    const markdown = [
      "# Benchmarks",
      "",
      "| Workload | What it runs |",
      "|---|---|",
      "| lean | one script |",
      "",
      formatHeader(),
      formatRow(row()),
      formatRow(second),
      "",
    ].join("\r\n");
    expect(parseRows(markdown)).toEqual([row(), second]);
  });

  test("columns are read by their header, so a table from before a workload was added still parses", () => {
    const older = [
      "| Date | Commit | Rig | Node | lean | batch | Heap start | Heap end | Heap growth per day |",
      "|---|---|---|---|---|---|---|---|---|",
      "| 2026-01-02 | aaa | rig-a | v24 | 100x | 50x | 10.0 MB | 11.0 MB | +0.1 MB |",
    ].join("\n");
    expect(parseRows(`${older}\n\n${formatHeader()}\n${formatRow(row())}\n`)).toEqual([
      {
        date: "2026-01-02",
        commit: "aaa",
        rig: "rig-a",
        node: "v24",
        speeds: { lean: 100, batch: 50 },
        heap: { startMb: 10, endMb: 11, perDayMb: 0.1 },
      },
      row(),
    ]);
  });

  test("a row with a value that isn't a number is skipped, not read as some other number", () => {
    for (const bad of ["n/a", "1,000x", "", "12 MBx"]) {
      const line = formatRow(row()).replace("| 9000x |", `| ${bad} |`);
      expect(parseRows(`${formatHeader()}\n${line}\n`), bad).toEqual([]);
    }
  });

  test("the text to append starts a new table when the file's last header isn't the current one", () => {
    const current = `# Results\n\n${formatHeader()}\n${formatRow(row())}\n`;
    expect(rowText(current, row())).toBe(`${formatRow(row())}\n`);
    expect(rowText(current.trimEnd(), row())).toBe(`\n${formatRow(row())}\n`);
    const older =
      "| Date | Commit | Rig | Node | lean | Heap start | Heap end | Heap growth per day |\n|---|---|---|---|---|---|---|---|\n";
    expect(rowText(older, row())).toBe(`\n${formatHeader()}\n${formatRow(row())}\n`);
    expect(rowText("# Results\n", row())).toBe(`\n${formatHeader()}\n${formatRow(row())}\n`);
  });

  test("the real results file ends with the current header's table, and its rows parse", () => {
    const markdown = readFileSync(path.join(REPO_ROOT, "docs/sim/benchmarks.md"), "utf8");
    expect(rowText(markdown, row())).toBe(`${formatRow(row())}\n`);
    expect(parseRows(markdown).length).toBeGreaterThan(0);
  });
});

describe("regressions", () => {
  test("none without an earlier row from the same rig", () => {
    expect(regressions(row({ speeds: { lean: 1, batch: 1, churn: 1, copies: 1 } }), [])).toEqual([]);
    expect(regressions(row(), [row({ rig: "rig-b", speeds: { lean: 1e9, batch: 1, churn: 1, copies: 1 } })])).toEqual(
      [],
    );
  });

  test("a workload more than 20% slower than the last row from this rig is one", () => {
    const earlier = [
      row({ commit: "old" }),
      row({ commit: "last", speeds: { lean: 10000, batch: 9000, churn: 4000, copies: 7000 } }),
      row({ rig: "rig-b", commit: "other-rig" }),
    ];
    // lean: 7999 is just over 20% slower than 10000; churn: 3200 is exactly 20%, which is allowed.
    const now = row({ speeds: { lean: 7999, batch: 9000, churn: 3200, copies: 7000 } });
    expect(regressions(now, earlier)).toEqual(["lean: 7999x is 20.0% slower than 2026-10-24 (last), at 10000x"]);
  });

  test("a workload the last row doesn't have isn't compared", () => {
    const earlier = [row({ speeds: { lean: 26000 } })];
    expect(regressions(row({ speeds: { lean: 26000, batch: 1, churn: 1, copies: 1 } }), earlier)).toEqual([]);
  });

  test("heap growth per day more than 20% above the last row's is one, unless it's under 1 MB a day", () => {
    const earlier = [row({ heap: { startMb: 100, endMb: 110, perDayMb: 2 } })];
    const growth = (perDayMb: number) => regressions(row({ heap: { startMb: 100, endMb: 110, perDayMb } }), earlier);
    expect(growth(2.4)).toEqual([]);
    expect(growth(2.5)).toEqual(["heap: grows 2.5 MB a day, more than 2026-10-24 (abc1234) (2.0 MB a day)"]);
    // Compared as recorded, to 0.1 MB: 2.44 is 2.4, not over the line.
    expect(growth(2.44)).toEqual([]);
    // From shrinking before, any real growth counts; tiny growth never does.
    const shrinking = [row({ heap: { startMb: 100, endMb: 99, perDayMb: -1 } })];
    const from = (perDayMb: number) => regressions(row({ heap: { startMb: 0, endMb: 0, perDayMb } }), shrinking);
    expect(from(0.9)).toEqual([]);
    expect(from(1.1)).toHaveLength(1);
  });
});

describe("growthPerDay", () => {
  test("is the median day-to-day change, leaving out the first day's warm-up", () => {
    // Day 0 to 1 is warm-up (100 to 150); from then on it grows about 2 a day.
    expect(growthPerDay([100, 150, 152.5, 153.5, 156.5, 158.5, 160.5])).toBe(2);
    expect(growthPerDay([100, 150, 149, 148])).toBe(-1);
    expect(growthPerDay([100, 150, 151, 154])).toBe(2);
  });

  test("isn't moved by a one-off step: a cache filling or emptying once isn't a trend", () => {
    expect(growthPerDay([103, 104.2, 104.2, 92.8, 92.8, 93, 92.9, 93])).toBe(0);
    expect(growthPerDay([100, 104, 104, 110, 110, 110, 110, 110])).toBe(0);
  });

  test("needs a day after the warm-up", () => {
    expect(() => growthPerDay([100, 150])).toThrow(RangeError);
  });
});

describe("topSelfTime", () => {
  const frame = (functionName: string, url: string, lineNumber: number, columnNumber = 0) => ({
    functionName,
    url,
    lineNumber,
    columnNumber,
  });
  const game = path.join(REPO_ROOT, "game.js");
  // Samples at t = 1000, 2000, 4500, 6500, 8500; the profile ends at 9000. Each sample's time runs to the next
  // sample, as DevTools counts it, and the last one's to the end.
  const profile: CpuProfile = {
    nodes: [
      { id: 1, callFrame: frame("(root)", "", -1), children: [2, 4] },
      { id: 2, callFrame: frame("tick", game, 9), children: [3] },
      { id: 3, callFrame: frame("", game, 41, 7) },
      // The same function as node 2, reached another way: it adds up with it.
      { id: 4, callFrame: frame("tick", game, 9) },
      // Another function on the same line: kept apart by its column.
      { id: 5, callFrame: frame("", game, 41, 30) },
    ],
    startTime: 0,
    endTime: 9000,
    // The third sample is of no known node: it doesn't count.
    samples: [2, 3, 99, 4, 5],
    timeDeltas: [1000, 1000, 2500, 2000, 2000],
  };

  test("adds each sample's time to the function running, keyed by name and position, biggest first", () => {
    expect(topSelfTime(profile)).toEqual([
      { function: "tick (<repo>/game.js:10:1)", ms: 3, share: 3 / 6 },
      { function: "(anonymous) (<repo>/game.js:42:8)", ms: 2.5, share: 2.5 / 6 },
      { function: "(anonymous) (<repo>/game.js:42:31)", ms: 0.5, share: 0.5 / 6 },
    ]);
  });

  test("keeps only the top count, and names native code without a location", () => {
    const native = {
      ...profile,
      nodes: [{ id: 1, callFrame: frame("(idle)", "", -1) }],
      samples: [1],
      timeDeltas: [5],
      endTime: 10,
    };
    expect(topSelfTime(native)).toEqual([{ function: "(idle)", ms: 0.005, share: 1 }]);
    expect(topSelfTime(profile, 1)).toHaveLength(1);
  });
});
