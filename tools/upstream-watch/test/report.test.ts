import { describe, expect, test } from "vitest";
import { BODY_LIMIT, changeCount, codeSpan, renderReport, reportFile, type WatchReport } from "../src/report.ts";

const empty: WatchReport = {
  pinned: { sha: "1da7316ff0000000000000000000000000000000", version: "3.0.1" },
  upstream: {
    ref: "dev",
    sha: "b1b3376b50fdeef45e26696f23db870cd89d7582",
    version: "3.0.2",
    date: "2026-10-18",
    ahead: true,
  },
  api: { added: [], removed: [], changed: [] },
  rawApiDiff: "",
  ram: [],
  commits: [],
  typecheck: { ran: true, errors: [] },
};

const full: WatchReport = {
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
    { path: "odd", before: "a || b", after: null },
  ],
  commits: [{ sha: "9aa05655aaaa", title: "DNET: remove TRP from darknet in BN12 (#3025) thanks @someone" }],
};

describe("changeCount", () => {
  test("counts changed declarations, RAM costs and watched commits", () => {
    expect(changeCount(empty)).toBe(0);
    expect(changeCount(full)).toBe(4 + 4 + 1);
  });
});

describe("codeSpan", () => {
  test("wraps text in a code span long enough for the backticks inside it", () => {
    expect(codeSpan("plain")).toBe("`plain`");
    expect(codeSpan("Fix `foo #12")).toBe("``Fix `foo #12``");
    expect(codeSpan("`edge`")).toBe("`` `edge` ``");
    expect(codeSpan("a ``b`` c")).toBe("```a ``b`` c```");
  });
});

describe("renderReport", () => {
  test("an empty report says there's nothing", () => {
    const text = renderReport(empty);
    expect(text).toContain("v3.0.1 (`1da7316ff0`)");
    expect(text).toContain("upstream `dev`, v3.0.2 (`b1b3376b50`, committed 2026-10-18)");
    expect(text).toContain("**No changes.**");
  });

  test("lists API changes by declaration, RAM costs in a table, and commits in code spans", () => {
    const text = renderReport(full);
    expect(text).toContain("**9 changes:** 4 API declarations, 4 RAM costs, 1 watched-source commit.");
    expect(text).toContain("- **Added:** `type GangTaskName`");
    expect(text).toContain("- **Removed:** `type SimpleOpponentStats`");
    expect(text).toContain("  - `interface NS`: added `isFullPort`, `isEmptyPort`; removed `old`; changed `spawn`");
    expect(text).toContain("  - `type CityName`\n");
    expect(text).toContain("```diff\n--- a\n+++ b\n+  isFullPort(port: number): boolean;\n```");
    expect(text).toContain("| `dnet.freezeServer` | – | `2` |");
    expect(text).toContain("| `removed.fn` | `1` | – |");
    expect(text).toContain("| `hack` | `0.1` | `0.15` |");
    // Pipes in a cell would end it: escaped, even in code.
    expect(text).toContain("| `odd` | `a \\|\\| b` | – |");
    // A whole title in code: its references, mentions and markup link to nothing and notify no one.
    expect(text).toContain("- `9aa05655aa` `DNET: remove TRP from darknet in BN12 (#3025) thanks @someone`");
    expect(text).toContain("## Contract typecheck");
  });

  test("caps long lists, saying how many more there are", () => {
    const many = {
      ...full,
      ram: Array.from({ length: 600 }, (_, i) => ({ path: `ns.fn${i}`, before: null, after: "1" })),
      commits: Array.from({ length: 900 }, (_, i) => ({
        sha: `${i}`.padStart(40, "0"),
        title: `CATEGORY: a fairly typical upstream commit title, about this long (#${3000 + i})`,
      })),
    };
    const text = renderReport(many);
    expect(text.length).toBeLessThanOrEqual(BODY_LIMIT);
    expect(text).toContain("**1504 changes:**");
    expect(text).toContain("…and 750 more commits.");
    expect(text).toContain("…and 450 more RAM costs.");
  });

  test("anything still too long is cut at the limit, with a note", () => {
    const names = Array.from({ length: 150 }, (_, i) => `interface ${"Long".repeat(100)}${i}`);
    const text = renderReport({ ...full, api: { added: names, removed: names, changed: [] } });
    expect(text.length).toBeLessThanOrEqual(BODY_LIMIT);
    expect(text.endsWith("Cut short to fit in an issue. Run the tool locally for the whole report.")).toBe(true);
  });

  test("stays under GitHub's issue body limit, cutting the raw diff first", () => {
    const huge = { ...full, rawApiDiff: `${"+ line\n".repeat(20_000)}` };
    const text = renderReport(huge);
    expect(text.length).toBeLessThanOrEqual(60_000);
    expect(text).toContain("The raw diff is cut short");
    expect(text).toContain("| `hack` | `0.1` | `0.15` |");
  });
});

describe("renderReport's contract typecheck", () => {
  const section = (text: string) => text.slice(text.indexOf("## Contract typecheck"));

  test("no errors: says none, and adds nothing to the summary", () => {
    const text = renderReport(empty);
    expect(section(text)).toContain(
      "`packages/ingame` typechecked against `dev`'s `src/ScriptEditor/NetscriptDefinitions.d.ts` instead of the pinned one",
    );
    expect(section(text)).toContain("**None:** no type errors.");
    expect(text).not.toContain("**Contract typecheck:**");
  });

  test("errors: listed with file, line and message, and counted in the summary", () => {
    const text = renderReport({
      ...empty,
      typecheck: {
        ran: true,
        errors: [
          { file: "packages/ingame/src/agent.ts", line: 4, message: "TS2345: 'number' | 'bigint' isn't 'string'." },
          { file: "packages/ingame/src/boot.ts", line: 12, message: "TS2339: Property 'foo' does not exist." },
        ],
      },
    });
    expect(text).toContain("**Contract typecheck:** 2 type errors in the in-game code (below).");
    expect(section(text)).toContain("**2 type errors:**");
    expect(section(text)).toContain(
      "| `packages/ingame/src/agent.ts` | 4 | `TS2345: 'number' \\| 'bigint' isn't 'string'.` |",
    );
    expect(section(text)).toContain(
      "| `packages/ingame/src/boot.ts` | 12 | `TS2339: Property 'foo' does not exist.` |",
    );
  });

  test("couldn't run: says so, with the compiler's output, never 'none'", () => {
    const text = renderReport({
      ...empty,
      typecheck: { ran: false, reason: "error TS5083: Cannot read file ```x```." },
    });
    expect(text).toContain("**Contract typecheck:** couldn't run (below).");
    expect(section(text)).toContain("**It couldn't run**, so this report says nothing about whether");
    // Fenced with more backticks than the output holds, so the output can't close the block.
    expect(section(text)).toContain("````text\nerror TS5083: Cannot read file ```x```.\n````");
    expect(section(text)).not.toContain("**None:**");
  });

  test("a long compiler output is cut, on a line break when there is one", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i} of the compiler's output`).join("\n");
    const withLines = section(renderReport({ ...empty, typecheck: { ran: false, reason: lines } }));
    expect(withLines).toContain("line 0 of the compiler's output");
    expect(withLines).not.toContain("line 399");
    expect(withLines).toMatch(/output\n…\n```/);
    const oneLine = section(renderReport({ ...empty, typecheck: { ran: false, reason: "x".repeat(10_000) } }));
    expect(oneLine).toContain(`\`\`\`text\n${"x".repeat(3_000)}\n…\n\`\`\``);
  });
});

describe("renderReport for the stable watcher", () => {
  const stable = { ...full, upstream: { ...full.upstream, ref: "stable" } };

  test("when stable has moved ahead: says a Steam update is coming, and lists the bump steps first", () => {
    const text = renderReport(stable, "stable");
    expect(text).toMatch(
      /^Upstream `stable` has moved ahead of the pinned game, v3\.0\.1 \(`1da7316ff0`\), to v3\.0\.2 \(`b1b3376b50`, committed 2026-10-18\)/,
    );
    expect(text).toContain("Steam ships from `stable`, so a Steam update is coming.");
    expect(text).toContain("0010-stable-watcher-opens-an-issue.md");
    const steps = text.indexOf("## Bump steps");
    expect(steps).toBeGreaterThan(0);
    expect(steps).toBeLessThan(text.indexOf("## API surface"));
    // A shallow fetch of exactly that commit: a plain `fetch origin stable` in the shallow submodule pulls years of history.
    expect(text).toContain(
      "`git -C vendor/bitburner-src fetch --depth 1 origin b1b3376b50fdeef45e26696f23db870cd89d7582`, then `git -C vendor/bitburner-src checkout FETCH_HEAD`",
    );
    expect(text).toContain("`PINNED_GAME`");
    expect(text).toContain("docs/sim/parity.md#re-auditing-after-a-version-bump");
    // The pinned version is written in docs too: the steps say what to search for.
    expect(text).toContain("search the repository for `3.0.1` and `1da7316ff`");
    expect(text).not.toContain("0005-forward-compat-dev-branch.md");
  });

  test("a move with no listed changes still gets the bump steps", () => {
    const quiet = { ...empty, upstream: { ...stable.upstream } };
    const text = renderReport(quiet, "stable");
    expect(text).toContain("## Bump steps");
    expect(text).toContain("**No changes.**");
  });

  test("when stable differs but isn't ahead (rewound, or a test ref): says so, with no bump steps", () => {
    const behind = { ...stable, upstream: { ...stable.upstream, ahead: false } };
    const text = renderReport(behind, "stable");
    expect(text).toMatch(
      /^Upstream `stable` differs from the pinned game, v3\.0\.1 \(`1da7316ff0`\), but isn't ahead of it/,
    );
    expect(text).not.toContain("## Bump steps");
  });

  test("when stable is the pinned commit: says there's nothing to do, with no bump steps", () => {
    const same = { ...empty, upstream: { ...empty.upstream, ref: "stable", sha: empty.pinned.sha, ahead: false } };
    const text = renderReport(same, "stable");
    expect(text).toMatch(/^Upstream `stable` is the pinned commit/);
    expect(text).not.toContain("## Bump steps");
  });

  test("the dev watcher's report is the default", () => {
    expect(renderReport(full)).toBe(renderReport(full, "dev"));
    expect(renderReport(full)).not.toContain("## Bump steps");
  });
});

describe("reportFile", () => {
  test("carries the counts, whether the ref moved and is ahead, both commits and the Markdown", () => {
    expect(reportFile(full, "stable")).toEqual({
      changes: 9,
      moved: true,
      ahead: true,
      pinned: full.pinned,
      upstream: { ref: "dev", sha: full.upstream.sha, version: "3.0.2" },
      markdown: renderReport(full, "stable"),
    });
    const same = { ...empty, upstream: { ...empty.upstream, sha: empty.pinned.sha, ahead: false } };
    expect(reportFile(same)).toMatchObject({ changes: 0, moved: false, ahead: false });
  });
});
