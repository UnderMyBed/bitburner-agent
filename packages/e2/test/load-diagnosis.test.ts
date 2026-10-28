// What a load that never showed the terminal looks like (#120), read from the page's visible text, and a run's count of
// retried loads, without a browser: these run in CI with the other unit tests.
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { diagnoseLoad, RETRIED_LOAD_STATES, unreadableText } from "../src/load-diagnosis.ts";
import { readRetriedLoads, recordRetriedLoad, retriedLoadsVerdict } from "../src/retried-loads.ts";

const LOADING = "Loading Bitburner v3.0.1 (1da7316ff)";

test.each([
  [LOADING, "loadingScreen", /^stuck on the loading screen, before its 2 s hint: .*timer.*pending request/],
  [
    `${LOADING}\nIf the game fails to load, consider killing all scripts`,
    "loadingScreenAfterHint",
    /^stuck on the loading screen, after its 2 s/,
  ],
  ["RECOVERY MODE ACTIVATED\nThere was an error with your save file", "recoveryMode", /^recovery mode: the load threw/],
  [
    unreadableText(new Error("Target page, context or browser has been closed\nCall log: …")),
    "crashedOrClosed",
    /^the page couldn't be read: it crashed or closed/,
  ],
  [
    unreadableText(new Error("locator.innerText: Timeout 1000ms exceeded.\nCall log: …")),
    "hung",
    /^the page is hung: its text couldn't be read within 1 s/,
  ],
  ["", "empty", /^an empty page: the game's bundle never rendered/],
  ["not the game", "other", /^neither the loading screen nor recovery mode/],
])("%j is diagnosed as %s", (visibleText, state, text) => {
  expect(diagnoseLoad(visibleText)).toEqual({ state, text: expect.stringMatching(text) });
});

test("an unreadable page's text keeps only the first line of why", () => {
  expect(unreadableText(new Error("Timeout 1000ms exceeded.\nCall log:\n  - waiting"))).toBe(
    "(unreadable: Timeout 1000ms exceeded.)",
  );
});

test("only a load still under way, or a page never rendered, is retried; faults fail at once (#120)", () => {
  expect([...RETRIED_LOAD_STATES].sort()).toEqual(["empty", "loadingScreen", "loadingScreenAfterHint"]);
});

test("a run's retried loads are counted across files, and more than one fails the run (#120)", () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "retried-loads-")), "retried.jsonl");
  expect(readRetriedLoads(file)).toEqual([]);
  expect(retriedLoadsVerdict([])).toEqual({ failed: false, summary: null });
  recordRetriedLoad("E2: the game didn't load within 20000 ms\nLooks like: stuck\nmore\nand more", file);
  const once = retriedLoadsVerdict(readRetriedLoads(file));
  expect(once.failed).toBe(false);
  expect(once.summary).toBe(
    "E2: 1 fixture load needed a retry this run (#120). Report it on #120:\n" +
      "1. E2: the game didn't load within 20000 ms | Looks like: stuck | more",
  );
  recordRetriedLoad("E2: again", file);
  const twice = retriedLoadsVerdict(readRetriedLoads(file));
  expect(twice.failed).toBe(true);
  expect(twice.summary).toMatch(/^E2: 2 fixture loads needed a retry this run \(#120\): more than 1, so the run fails/);
  expect(twice.summary).toContain("\n2. E2: again");
  // Outside a run's setup, nothing names a file: nothing is counted, and nothing fails.
  expect(() => recordRetriedLoad("ignored", "")).not.toThrow();
});
