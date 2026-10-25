import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { type SimEvent, Simulation, type SimulationOptions } from "../src/simulation.ts";
import { editSave } from "./helpers/save-edit.ts";

// What the browser page gives the game besides the Router: globals, the UI's popups, toasts, error popup and
// prompts, and how uncaught errors are handled (src/engine/bundle/page.ts, src/host/parity/). docs/sim/parity.md §3-§5.

const EPOCH = Date.UTC(2026, 0, 1);
const HOUR = 3_600_000;
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const open: Simulation[] = [];
async function start(options: SimulationOptions): Promise<Simulation> {
  const sim = await Simulation.start(options);
  open.push(sim);
  return sim;
}
afterAll(async () => {
  await Promise.all(open.map((sim) => sim.close()));
});

const newGame = (extra: Partial<SimulationOptions> = {}) =>
  start({ seed: 9, epochMs: EPOCH, fixture: { kind: "new", tutorial: "skipped" }, ...extra });

let scripts = 0;
/** Runs a script for `ms` of virtual time; returns its name, pid and what it passed to `out(…)`. */
async function runScript(
  sim: Simulation,
  body: string,
  ms = 1_000,
): Promise<{ name: string; pid: number; out: unknown[] }> {
  const name = `script${++scripts}.js`;
  await sim.writeFile(
    "home",
    name,
    `export async function main(ns) {\nns.disableLog("ALL");\nconst out = (v) => ns.print("out:" + JSON.stringify(v));\n${body}\n}`,
  );
  const { pid, error } = await sim.run("home", name);
  expect(error).toBeUndefined();
  await sim.advance(ms);
  const log = await sim.logs(pid);
  return { name, pid, out: log.filter((line) => line.startsWith("out:")).map((line) => JSON.parse(line.slice(4))) };
}

const eventsOf = async (sim: Simulation, type: SimEvent["type"]) =>
  (await sim.events()).events.filter((event) => event.type === type);

describe("page globals", () => {
  test("scripts see what the page puts on window as globals: sprintf, vsprintf, _, React, ReactDOM", async () => {
    const sim = await newGame();
    // Naming `window` in a script costs RAM the starting home server doesn't have; reach it by name instead.
    const { out } = await runScript(
      sim,
      `const win = globalThis["win" + "dow"];
       out(sprintf("%05.1f", 3.14159));
       out(vsprintf("%s-%s", ["a", "b"]));
       out(_.chunk([1, 2, 3], 2));
       out(typeof React.createElement("b", null, "x") === "object" && typeof ReactDOM.render === "function");
       out([win._ === _, win.sprintf === sprintf, win.React === React]);`,
    );
    expect(out).toEqual(["003.1", "a-b", [[1, 2], [3]], true, [true, true, true]]);
  });

  test("window.print and window.prompt throw, as the game makes them", async () => {
    const sim = await newGame();
    const { out } = await runScript(
      sim,
      `const win = globalThis["win" + "dow"];
       for (const f of [() => win.print(), () => win.prompt("x"), () => prompt("x")]) {
         try { f(); out("no error"); } catch (e) { out(e.message); }
       }`,
    );
    expect(out).toEqual([
      "You accidentally called window.print instead of ns.print",
      "You accidentally called window.prompt instead of ns.prompt",
      "You accidentally called window.prompt instead of ns.prompt",
    ]);
  });

  test("the game doesn't think it's in a test environment, whatever the environment", async () => {
    process.env.JEST_WORKER_ID = "1";
    try {
      const sim = await newGame();
      expect((await sim.diagnostics.game()).testEnvironment).toBe(false);
    } finally {
      delete process.env.JEST_WORKER_ID;
    }
  });
});

describe("the UI's popups, toasts and errors become events", () => {
  test("alerts and toasts, in the order the game raised them, as text", async () => {
    const sim = await newGame();
    await runScript(sim, `ns.alert("first"); ns.toast("second", "success"); ns.alert("third");`);
    // (Running a script this fast also earns an achievement, whose toast follows.)
    const shown = (await sim.events()).events
      .filter((event) => (event.type === "alert" || event.type === "toast") && !event.text.startsWith("Unlocked"))
      .map(({ at, ...event }) => event);
    expect(shown).toEqual([
      { type: "alert", text: "first" },
      { type: "toast", text: "second", variant: "success" },
      { type: "alert", text: "third" },
    ]);
  });

  test("React content is reduced to its text: a message arriving", async () => {
    const save = editSave(await (await newGame()).save(), ({ PlayerSave }) => {
      PlayerSave.data.exp.hacking = 1_000; // hacking level 25: the first message arrives at the next check
    });
    const sim = await start({ seed: 9, fixture: { kind: "save", bytes: save } });
    await sim.advance(60_000);
    const alerts = await eventsOf(sim, "alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ text: expect.stringContaining("j0.msg") });
    expect(alerts[0]).not.toMatchObject({ text: expect.stringContaining("<") });
  });

  test("every script error is reported, as if each error popup were dismissed", async () => {
    const sim = await newGame();
    const { name, pid } = await runScript(sim, `throw new Error("first failure");`);
    await runScript(sim, `throw new Error("second failure");`);
    const errors = (await eventsOf(sim, "error")).map(({ at, ...event }) => event);
    expect(errors).toEqual([
      expect.objectContaining({ host: "home", script: name, pid, message: expect.stringContaining("first failure") }),
      expect.objectContaining({ message: expect.stringContaining("second failure") }),
    ]);
  });
});

describe("the event log", () => {
  test("is the same for the same seed, in emission order", async () => {
    const run = async () => {
      const sim = await newGame({ prompts: [{ match: "Roll", answer: true }] });
      await sim.writeFile(
        "home",
        "roll.js",
        `export async function main(ns) {
           for (let i = 0; i < 3; i++) {
             ns.toast("roll " + Math.floor(Math.random() * 100), "info");
             if (await ns.prompt("Roll again?")) await ns.sleep(Math.random() * 1000);
           }
           ns.alert("done");
           throw new Error("and fail");
         }`,
      );
      await sim.run("home", "roll.js");
      await sim.advance(5_000);
      return (await sim.events()).events;
    };
    const [a, b] = await Promise.all([run(), run()]);
    expect(a.map((event) => event.type)).toEqual(expect.arrayContaining(["toast", "prompt", "alert", "error"]));
    expect(b).toEqual(a);
  });
});

describe("prompts", () => {
  test("with no rule, a prompt is answered as dismissing it would be", async () => {
    const sim = await newGame();
    const { out } = await runScript(
      sim,
      `out(await ns.prompt("Continue?"));
       out(await ns.prompt("Name?", { type: "text" }));
       out(await ns.prompt("Pick", { type: "select", choices: ["a", "b"] }));`,
    );
    expect(out).toEqual([false, "", ""]);
    expect((await eventsOf(sim, "prompt")).map(({ at, ...event }) => event)).toEqual([
      { type: "prompt", text: "Continue?", kind: "boolean", choices: [], answer: false, answeredBy: "default" },
      { type: "prompt", text: "Name?", kind: "text", choices: [], answer: "", answeredBy: "default" },
      { type: "prompt", text: "Pick", kind: "select", choices: ["a", "b"], answer: "", answeredBy: "default" },
    ]);
  });

  test("rules answer prompts whose text they match; the first match wins", async () => {
    const sim = await newGame({
      prompts: [
        { match: "Continue", answer: true },
        { match: "Name", answer: "Ada" },
        { match: "Name", answer: "never used" },
      ],
    });
    const { out } = await runScript(
      sim,
      `out(await ns.prompt("Continue?"));
       out(await ns.prompt("Name?", { type: "text" }));
       out(await ns.prompt("Unmatched?"));`,
    );
    expect(out).toEqual([true, "Ada", false]);
    expect((await eventsOf(sim, "prompt")).map((event) => event.type === "prompt" && event.answeredBy)).toEqual([
      "rule",
      "rule",
      "default",
    ]);
  });

  test("bad rules are refused before the simulation starts", async () => {
    await expect(newGame({ prompts: [{ match: "", answer: true }] })).rejects.toThrow(/prompts must be rules/);
    await expect(newGame({ prompts: [{ match: "x", answer: 3 as unknown as boolean }] })).rejects.toThrow(
      /prompts must be rules/,
    );
  });
});

describe("uncaught errors are handled as a browser does", () => {
  test("a killed script's un-awaited sleep doesn't end the simulation (the game ignores ScriptDeath)", async () => {
    const sim = await newGame();
    await sim.writeFile("home", "lazy.js", "export async function main(ns) { ns.sleep(10000); await ns.sleep(1e9); }");
    const { pid } = await sim.run("home", "lazy.js");
    await sim.advance(1_000);
    await sim.kill(pid);
    await sim.advance(20_000);
    expect(await sim.now()).toBe(EPOCH + 21_000);
    const consoleErrors = (await eventsOf(sim, "console")).filter((event) =>
      JSON.stringify(event).includes("Uncaught"),
    );
    expect(consoleErrors).toEqual([]);
  });

  test("any other rejection nobody handled reaches the game's error popup", async () => {
    const sim = await newGame();
    await runScript(sim, `Promise.reject(new Error("nobody caught this"));`);
    expect(await eventsOf(sim, "error")).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/UNCAUGHT PROMISE ERROR[\s\S]*nobody caught this/) }),
    ]);
  });

  test("an exception in a timer callback is logged, and time goes on", async () => {
    const sim = await newGame();
    await runScript(sim, `setTimeout(() => { throw new Error("thrown in a timer"); }, 10);`);
    await sim.advance(5_000);
    expect(await sim.now()).toBe(EPOCH + 6_000);
    expect(await eventsOf(sim, "console")).toEqual([
      expect.objectContaining({
        level: "error",
        message: expect.stringContaining("Uncaught Error: thrown in a timer"),
      }),
    ]);
  });

  test("stack traces name repository files relative to <repo>, the same on every machine", async () => {
    const sim = await newGame();
    // sprintf calls toString from inside the engine bundle, so this stack has frames in the bundle.
    const { out } = await runScript(sim, `out(ns.sprintf("%s", { toString: () => new Error("here").stack }));`);
    const stack = String(out[0]);
    expect(stack).toContain("<repo>/packages/sim/dist/engine.cjs:");
    expect(stack).not.toContain(REPO_ROOT.replaceAll("\\", "/"));
    expect(stack).not.toContain(REPO_ROOT);
  });
});

describe("isolation", () => {
  test("scripts can't reach the network: ns.wget fails as it does offline", async () => {
    const sim = await newGame();
    const { out } = await runScript(
      sim,
      `out(await ns.wget("https://example.com/x.txt", "x.txt"));
       try { await fetch("https://example.com"); } catch (e) { out(e.message); }
       try { new XMLHttpRequest(); } catch (e) { out(e.message); }
       try { new WebSocket("wss://example.com"); } catch (e) { out(e.message); }`,
    );
    expect(out).toEqual([
      false,
      "Failed to fetch",
      "XMLHttpRequest: the simulator has no network",
      "WebSocket: the simulator has no network",
    ]);
  });

  test("scripts can import other scripts, and nothing else", async () => {
    const sim = await newGame();
    await sim.writeFile("home", "lib.js", "export const answer = 42;");
    await sim.writeFile(
      "home",
      "uses-lib.js",
      `import { answer } from "./lib.js";\nexport async function main(ns) { ns.print("out:" + answer); }`,
    );
    const { pid } = await sim.run("home", "uses-lib.js");
    await sim.advance(1_000);
    expect(await sim.logs(pid)).toContain("out:42");

    // The game refuses other static imports itself (its RAM check). Dynamic imports reach the module loader, which
    // refuses them as a browser does: nothing resolves from a blob: module.
    const { out } = await runScript(
      sim,
      `for (const specifier of ["node:fs", "fs", "https://example.com/x.js", "./lib.js"]) {
         try { await import(specifier); out("imported " + specifier); } catch (e) { out(e.message); }
       }`,
    );
    expect(out).toEqual([
      'Failed to resolve module specifier "node:fs"',
      'Failed to resolve module specifier "fs"',
      'Failed to resolve module specifier "https://example.com/x.js"',
      'Failed to resolve module specifier "./lib.js"',
    ]);
  });
});
describe("no exploits", () => {
  test("a day of play earns no exploits (the anti-cheat timers see consistent time)", async () => {
    const sim = await newGame();
    await runScript(
      sim,
      `ns.nuke("n00dles");
       while (true) { await ns.hack("n00dles"); await ns.grow("n00dles"); await ns.weaken("n00dles"); }`,
      24 * HOUR,
    );
    expect((await sim.diagnostics.game()).exploits).toEqual([]);
    expect((await sim.summary()).playtimeMs).toBe(24 * HOUR);
  });
});
