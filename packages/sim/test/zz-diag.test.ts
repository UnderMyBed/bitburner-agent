import { execSync } from "node:child_process";
import { writeSync } from "node:fs";
import { afterAll, expect, test } from "vitest";
import { Simulation } from "../src/simulation.ts";

// Temporary diagnostic for PR #70 (removed before merge).
let sim: Simulation;
afterAll(() => sim?.close());
test("diag: the stack-settings scenario on Linux", async () => {
  const say = (m: string) => writeSync(2, `DIAG ${m}\n`);
  sim = await Simulation.start({
    seed: 1,
    epochMs: Date.UTC(2026, 0, 1),
    fixture: { kind: "new", tutorial: "skipped" },
  });
  say("started");
  const script = `export async function main(ns) { Error.stackTraceLimit = 2; Error.prepareStackTrace = () => "x"; }`;
  await sim.writeFile("home", "stacks.js", script);
  await sim.run("home", "stacks.js");
  say("ran");
  await sim.advance(1000);
  say("advanced");
  const save = await sim.save();
  say(`saved ${save.length}`);
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    say(execSync("ps -eo pid,rss,pcpu,args --sort=-rss | head -4", { encoding: "utf8" }).replaceAll("\n", " | "));
  }
  expect(save.length).toBeGreaterThan(1000);
}, 60_000);
