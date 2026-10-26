import { describe, expect, test } from "vitest";
import { type ExistingIssue, fillTitle, hasNews, planIssue } from "../src/issue.ts";

const PREFIX = "Upcoming game changes (upstream dev)";
const issue = (number: number, state: "OPEN" | "CLOSED", title = PREFIX): ExistingIssue => ({ number, state, title });

describe("planIssue", () => {
  test("with changes: updates the open tracking issue", () => {
    const existing = [issue(7, "CLOSED"), issue(9, "OPEN"), issue(12, "OPEN", "Upstream stable moved: v3.0.2")];
    expect(planIssue(existing, PREFIX, { news: true, whenEmpty: "close" })).toEqual({ kind: "update", number: 9 });
  });

  test("with changes and none open: reopens the latest closed one, so there's one thread", () => {
    const existing = [issue(7, "CLOSED"), issue(11, "CLOSED"), issue(3, "CLOSED")];
    expect(planIssue(existing, PREFIX, { news: true, whenEmpty: "close" })).toEqual({ kind: "reopen", number: 11 });
  });

  test("with changes and no tracking issue at all: creates one", () => {
    const other = [issue(12, "OPEN", "Upstream stable moved: v3.0.2")];
    expect(planIssue(other, PREFIX, { news: true, whenEmpty: "close" })).toEqual({ kind: "create" });
  });

  test("without changes: closes the open one, or does nothing, as asked", () => {
    const existing = [issue(9, "OPEN")];
    expect(planIssue(existing, PREFIX, { news: false, whenEmpty: "close" })).toEqual({ kind: "close", number: 9 });
    expect(planIssue(existing, PREFIX, { news: false, whenEmpty: "leave" })).toEqual({ kind: "none" });
    expect(planIssue([issue(7, "CLOSED")], PREFIX, { news: false, whenEmpty: "close" })).toEqual({ kind: "none" });
  });

  test("matches on the title prefix, not on similar titles", () => {
    const existing = [issue(5, "OPEN", "Re: Upcoming game changes (upstream dev)")];
    expect(planIssue(existing, PREFIX, { news: true, whenEmpty: "close" })).toEqual({ kind: "create" });
  });
});

describe("fillTitle", () => {
  test("fills {version} and {sha} (short) from the upstream commit", () => {
    const upstream = { version: "3.0.2", sha: "b1b3376b50fdeef45e26696f23db870cd89d7582" };
    expect(fillTitle("Upstream stable moved: v{version} ({sha})", upstream)).toBe(
      "Upstream stable moved: v3.0.2 (b1b3376b50)",
    );
    expect(fillTitle("Upcoming game changes (upstream dev)", upstream)).toBe("Upcoming game changes (upstream dev)");
    // Upstream text is inserted as is: no replacement patterns.
    expect(fillTitle("v{version}", { version: "$&-$'", sha: "0" })).toBe("v$&-$'");
  });
});

describe("hasNews", () => {
  const ran = { contractTypecheckRan: true };

  test("the forward check reports listed changes; the stable watcher reports any move", () => {
    expect(hasNews({ changes: 3, moved: true, ...ran }, "changes")).toBe(true);
    expect(hasNews({ changes: 0, moved: true, ...ran }, "changes")).toBe(false);
    expect(hasNews({ changes: 0, moved: true, ...ran }, "moved")).toBe(true);
    expect(hasNews({ changes: 0, moved: false, ...ran }, "moved")).toBe(false);
  });

  test("a contract typecheck that couldn't run is news for the forward check, never for the stable watcher", () => {
    const broken = { changes: 0, moved: false, contractTypecheckRan: false };
    expect(hasNews(broken, "changes")).toBe(true);
    expect(hasNews(broken, "moved")).toBe(false);
  });
});

describe("the stable watcher's issue", () => {
  const STABLE = "Upstream stable moved";
  const stable = (number: number, state: "OPEN" | "CLOSED", version: string) =>
    issue(number, state, `${STABLE}: v${version} (abcdef0123)`);

  test("a second move before the bump updates the same issue, whatever version its title names", () => {
    expect(planIssue([stable(70, "OPEN", "3.0.2")], STABLE, { news: true, whenEmpty: "leave" })).toEqual({
      kind: "update",
      number: 70,
    });
  });

  test("a move after an earlier bump reopens the latest closed issue", () => {
    const history = [stable(70, "CLOSED", "3.0.2"), stable(81, "CLOSED", "3.0.3")];
    expect(planIssue(history, STABLE, { news: true, whenEmpty: "leave" })).toEqual({ kind: "reopen", number: 81 });
  });

  test("no move leaves an open issue for the bump PR to close", () => {
    expect(planIssue([stable(70, "OPEN", "3.0.2")], STABLE, { news: false, whenEmpty: "leave" })).toEqual({
      kind: "none",
    });
  });

  test("the two watchers never touch each other's issue", () => {
    const both = [issue(66, "OPEN"), stable(70, "OPEN", "3.0.2")];
    expect(planIssue(both, STABLE, { news: true, whenEmpty: "leave" })).toEqual({ kind: "update", number: 70 });
    expect(planIssue(both, PREFIX, { news: false, whenEmpty: "close" })).toEqual({ kind: "close", number: 66 });
  });
});
