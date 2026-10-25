import { describe, expect, test } from "vitest";
import { type ExistingIssue, planIssue } from "../src/issue.ts";

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
