// A script's static RAM, measured by the game's own calculator: what in-game bundles' RAM budgets are checked with.
import { describe, expect, test } from "vitest";
import { useSimulations } from "./helpers/sim.ts";

const start = useSimulations();
const newGame = () => start({ seed: 1, epochMs: Date.UTC(2026, 0, 1), fixture: { kind: "new", tutorial: "skipped" } });

describe("staticRamUsage", () => {
  test("is the game's own figure: the base cost plus each NS function referenced, by name", async () => {
    const sim = await newGame();
    await sim.writeFile("home", "runs.js", "export async function main(ns) { ns.run('x.js'); }");
    // The same script twice, but for a local's name: one spelled like an NS function is charged as one (`ps`, 0.2 GB).
    await sim.writeFile("home", "named-ps.js", "export async function main(ns) { const ps = 1; ns.print(ps); }");
    await sim.writeFile(
      "home",
      "named-processes.js",
      "export async function main(ns) { const processes = 1; ns.print(processes); }",
    );
    expect(await sim.staticRamUsage("home", "runs.js")).toBe(2.6);
    expect(await sim.staticRamUsage("home", "named-processes.js")).toBe(1.6);
    expect(await sim.staticRamUsage("home", "named-ps.js")).toBe(1.8);
  });

  test("a file that isn't there, or isn't a script, gets the game's own calculateRam error", async () => {
    const sim = await newGame();
    await sim.writeFile("home", "notes.txt", "hello");
    await expect(sim.staticRamUsage("home", "missing.js")).rejects.toThrow("File does not exist. Filename: missing.js");
    await expect(sim.staticRamUsage("home", "notes.txt")).rejects.toThrow("File is not a script. Filename: notes.txt");
    await expect(sim.staticRamUsage("nowhere", "x.js")).rejects.toThrow(/No server named nowhere/);
  });

  test("a script the calculator can't parse gets its reason", async () => {
    const sim = await newGame();
    await sim.writeFile("home", "broken.js", "export async function main(ns) {");
    await expect(sim.staticRamUsage("home", "broken.js")).rejects.toThrow(
      /invalid script\. Filename: broken\.js\. Reason: .*Unexpected token/,
    );
  });
});
