import { describe, expect, test } from "vitest";
import { type ExistingIssue, fillTitle, hasNews, planIssue } from "../src/issue.ts";

const PREFIX = "Upcoming game changes (upstream dev)";
const issue = (number: number, state: "OPEN" | "CLOSED", title = PREFIX): ExistingIssue => ({ number, state, title });

describe("planIssue", () => {
  test("with changes: updates the open tracking issue", () => {
    const existing = [issue(7, "CLOSED"), issue(9, "OPEN"), issue(12, "OPEN", "Upstream stable moved: v3.0.2")];
    expect(planIssue(existing, PREFIX, { changes: true, whenEmpty: "close" })).toEqual({ kind: "update", number: 9 });
  });

  test("with changes and none open: reopens the latest closed one, so there's one thread", () => {
    const existing = [issue(7, "CLOSED"), issue(11, "CLOSED"), issue(3, "CLOSED")];
    expect(planIssue(existing, PREFIX, { changes: true, whenEmpty: "close" })).toEqual({ kind: "reopen", number: 11 });
  });

  test("with changes and no tracking issue at all: creates one", () => {
    const other = [issue(12, "OPEN", "Upstream stable moved: v3.0.2")];
    expect(planIssue(other, PREFIX, { changes: true, whenEmpty: "close" })).toEqual({ kind: "create" });
  });

  test("without changes: closes the open one, or does nothing, as asked", () => {
    const existing = [issue(9, "OPEN")];
    expect(planIssue(existing, PREFIX, { changes: false, whenEmpty: "close" })).toEqual({ kind: "close", number: 9 });
    expect(planIssue(existing, PREFIX, { changes: false, whenEmpty: "leave" })).toEqual({ kind: "none" });
    expect(planIssue([issue(7, "CLOSED")], PREFIX, { changes: false, whenEmpty: "close" })).toEqual({ kind: "none" });
  });

  test("matches on the title prefix, not on similar titles", () => {
    const existing = [issue(5, "OPEN", "Re: Upcoming game changes (upstream dev)")];
    expect(planIssue(existing, PREFIX, { changes: true, whenEmpty: "close" })).toEqual({ kind: "create" });
  });
});

describe("fillTitle", () => {
  test("fills {version} and {sha} (short) from the upstream commit", () => {
    const upstream = { version: "3.0.2", sha: "b1b3376b50fdeef45e26696f23db870cd89d7582" };
    expect(fillTitle("Upstream stable moved: v{version} ({sha})", upstream)).toBe(
      "Upstream stable moved: v3.0.2 (b1b3376b50)",
    );
    expect(fillTitle("Upcoming game changes (upstream dev)", upstream)).toBe("Upcoming game changes (upstream dev)");
  });
});

describe("hasNews", () => {
  test("the forward check reports listed changes; the stable watcher reports any move", () => {
    expect(hasNews({ changes: 3, moved: true }, "changes")).toBe(true);
    expect(hasNews({ changes: 0, moved: true }, "changes")).toBe(false);
    expect(hasNews({ changes: 0, moved: true }, "moved")).toBe(true);
    expect(hasNews({ changes: 0, moved: false }, "moved")).toBe(false);
  });

  test("stable at the pinned commit: nothing to report, so with --when-empty leave the watcher does nothing", () => {
    const existing = [{ number: 70, state: "OPEN" as const, title: "Upstream stable moved: v3.0.2 (b1b3376b50)" }];
    const changes = hasNews({ changes: 0, moved: false }, "moved");
    expect(planIssue([], "Upstream stable moved", { changes, whenEmpty: "leave" })).toEqual({ kind: "none" });
    expect(planIssue(existing, "Upstream stable moved", { changes, whenEmpty: "leave" })).toEqual({ kind: "none" });
  });
});
