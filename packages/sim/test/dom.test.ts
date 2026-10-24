import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, test } from "vitest";

// installDom mutates globals, so it runs in a child process (helpers/dom-probe.ts).
const probe = JSON.parse(
  execFileSync(process.execPath, [path.join(import.meta.dirname, "helpers", "dom-probe.ts")], {
    encoding: "utf8",
    timeout: 60_000,
  }),
) as Record<string, unknown>;

test("window and globalThis share one set of timers, Date and performance, even after they're replaced", () => {
  // A virtual clock replaces the globals after installDom; the game also calls window.setTimeout directly.
  expect(probe.windowTimersFollowGlobals).toBe(true);
  expect(probe.windowDateFollowsGlobal).toBe(true);
  expect(probe.windowPerformanceFollowsGlobal).toBe(true);
});

test("requestAnimationFrame runs on the global timers, not on real time", () => {
  expect(probe.rafUsesGlobalSetTimeout).toBe(true);
});

test("document and storage come from jsdom", () => {
  expect(probe.hasRootElement).toBe(true);
  expect(probe.localStorageIsJsdom).toBe(true);
});

test("applies the FixJSDOMEnvironment patches", () => {
  expect(probe.adoptedStyleSheets).toBe(true);
  expect(probe.replaceSyncIsNoop).toBe(true);
});
