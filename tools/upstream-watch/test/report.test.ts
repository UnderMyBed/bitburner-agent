import { describe, expect, test } from "vitest";
import { changeCount, type ForwardReport, inert, renderReport } from "../src/report.ts";

const empty: ForwardReport = {
  pinned: { sha: "1da7316ff0000000000000000000000000000000", version: "3.0.1" },
  upstream: { ref: "dev", sha: "b1b3376b50fdeef45e26696f23db870cd89d7582", version: "3.0.2", date: "2026-10-18" },
  api: { added: [], removed: [], changed: [] },
  rawApiDiff: "",
  ram: [],
  commits: [],
};

const full: ForwardReport = {
  ...empty,
  api: {
    added: ["type GangTaskName"],
    removed: ["type SimpleOpponentStats"],
    changed: [
      { key: "interface NS", added: ["isFullPort", "isEmptyPort"], removed: ["old"], changed: ["spawn"] },
      { key: "type CityName", added: [], removed: [], changed: [] },
    ],
  },
  rawApiDiff: "--- a\n+++ b\n+  isFullPort(port: number): boolean;\n",
  ram: [
    { path: "dnet.freezeServer", before: null, after: "2" },
    { path: "removed.fn", before: "1", after: null },
    { path: "hack", before: "0.1", after: "0.15" },
  ],
  commits: [{ sha: "9aa05655aaaa", title: "DNET: remove TRP from darknet in BN12 (#3025) thanks @someone" }],
};

describe("changeCount", () => {
  test("counts changed declarations, RAM costs and watched commits", () => {
    expect(changeCount(empty)).toBe(0);
    expect(changeCount(full)).toBe(4 + 3 + 1);
  });
});

describe("inert", () => {
  test("puts issue references and mentions in code, so they link nowhere and notify no one", () => {
    expect(inert("Fix (#3025), thanks @someone and @other-dev; a@b.c stays")).toBe(
      "Fix (`#3025`), thanks `@someone` and `@other-dev`; a@b.c stays",
    );
  });
});

describe("renderReport", () => {
  test("an empty report says there's nothing", () => {
    const text = renderReport(empty);
    expect(text).toContain("v3.0.1 (`1da7316ff0`)");
    expect(text).toContain("upstream `dev`, v3.0.2 (`b1b3376b50`, committed 2026-10-18)");
    expect(text).toContain("**No changes.**");
  });

  test("lists API changes by declaration, RAM costs in a table, and commits with their references made inert", () => {
    const text = renderReport(full);
    expect(text).toContain("**8 changes:** 4 API declarations, 3 RAM costs, 1 watched-source commit.");
    expect(text).toContain("- **Added:** `type GangTaskName`");
    expect(text).toContain("- **Removed:** `type SimpleOpponentStats`");
    expect(text).toContain("  - `interface NS`: added `isFullPort`, `isEmptyPort`; removed `old`; changed `spawn`");
    expect(text).toContain("  - `type CityName`\n");
    expect(text).toContain("```diff\n--- a\n+++ b\n+  isFullPort(port: number): boolean;\n```");
    expect(text).toContain("| `dnet.freezeServer` | – | 2 |");
    expect(text).toContain("| `removed.fn` | 1 | – |");
    expect(text).toContain("| `hack` | 0.1 | 0.15 |");
    expect(text).toContain("- `9aa05655aa` DNET: remove TRP from darknet in BN12 (`#3025`) thanks `@someone`");
    expect(text).toContain("## Contract typecheck");
  });

  test("stays under GitHub's issue body limit, cutting the raw diff first", () => {
    const huge = { ...full, rawApiDiff: `${"+ line\n".repeat(20_000)}` };
    const text = renderReport(huge);
    expect(text.length).toBeLessThanOrEqual(60_000);
    expect(text).toContain("The raw diff is cut short");
    expect(text).toContain("| `hack` | 0.1 | 0.15 |");
  });
});
