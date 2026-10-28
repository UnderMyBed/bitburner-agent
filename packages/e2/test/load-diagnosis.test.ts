// What a load that never showed the terminal looks like (#120), read from the page's visible text, without a browser:
// these run in CI with the other unit tests.
import { expect, test } from "vitest";
import { diagnoseLoad } from "../src/load-diagnosis.ts";

const LOADING = "Loading Bitburner v3.0.1 (1da7316ff)";

test.each([
  [LOADING, /^stuck on the loading screen, before its 2 s hint: .*timer.*pending request/],
  [
    `${LOADING}\nIf the game fails to load, consider killing all scripts`,
    /^stuck on the loading screen, after its 2 s/,
  ],
  ["RECOVERY MODE ACTIVATED\nThere was an error with your save file", /^recovery mode: the load threw/],
  ["(unreadable: Target page, context or browser has been closed)", /^the page couldn't be read: it crashed or closed/],
  ["", /^an empty page: the game's bundle never rendered/],
  ["not the game", /^neither the loading screen nor recovery mode/],
])("%j is diagnosed", (visibleText, diagnosis) => {
  expect(diagnoseLoad(visibleText)).toMatch(diagnosis);
});
