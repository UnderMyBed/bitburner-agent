import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { enginePaths } from "../src/engine/paths.ts";
import type { SimEvent, Simulation, SimulationOptions } from "../src/simulation.ts";
import { editSave } from "./helpers/save-edit.ts";
import { runScript, useSimulations } from "./helpers/sim.ts";

// What the browser page gives the game besides the Router: globals, the UI's popups, toasts, error popup and
// prompts, and how uncaught errors are handled (src/engine/bundle/page.ts, src/host/). docs/sim/parity.md §3-§5.

const EPOCH = Date.UTC(2026, 0, 1);
const HOUR = 3_600_000;
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const start = useSimulations();
const newGame = (extra: Partial<SimulationOptions> = {}) =>
  start({ seed: 9, epochMs: EPOCH, fixture: { kind: "new", tutorial: "skipped" }, ...extra });

const eventsOf = async (sim: Simulation, type: SimEvent["type"]) =>
  (await sim.events()).events.filter((event) => event.type === type);
const withoutTime = ({ at, ...event }: SimEvent) => event;
/** Uncaught errors, as the console events a browser would log for them. */
const uncaught = async (sim: Simulation) =>
  (await eventsOf(sim, "console")).filter((event) => event.type === "console" && event.message.startsWith("Uncaught"));
/** Scripts name `window` only through this: naming it costs RAM the starting home server doesn't have. */
const WINDOW = `globalThis["win" + "dow"]`;

describe("page globals", () => {
  test("scripts see what the page puts on window as globals: sprintf, vsprintf, _, React, ReactDOM", async () => {
    const sim = await newGame();
    const { out } = await runScript(
      sim,
      `const win = ${WINDOW};
       out(sprintf("%05.1f", 3.14159));
       out(vsprintf("%s-%s", ["a", "b"]));
       out(_.chunk([1, 2, 3], 2));
       out(typeof React.createElement("b", null, "x") === "object" && typeof ReactDOM.render === "function");
       out([win._ === _, win.sprintf === sprintf, win.React === React]);`,
    );
    expect(out).toEqual(["003.1", "a-b", [[1, 2], [3]], true, [true, true, true]]);
  });

  test("a page global is one binding, whether a script reaches it through window or as a global", async () => {
    const sim = await newGame();
    const { out } = await runScript(
      sim,
      `const win = ${WINDOW};
       const original = _;
       win._ = "set through window";
       out(_);
       _ = original;
       out(win._ === original);`,
    );
    expect(out).toEqual(["set through window", true]);
  });

  test("window.print and window.prompt throw, with the game's own messages", async () => {
    const sim = await newGame();
    const { out } = await runScript(
      sim,
      `const win = ${WINDOW};
       for (const f of [() => win.print(), () => win.prompt("x"), () => prompt("x")]) {
         try { f(); out("no error"); } catch (e) { out(e.message); }
       }`,
    );
    expect(out).toEqual([
      "You accidentally called window.print instead of ns.print",
      "You accidentally called window.prompt instead of ns.prompt",
      "You accidentally called window.prompt instead of ns.prompt",
    ]);
    // The messages are copied from index.tsx; they must still be the game's.
    const indexTsx = readFileSync(path.join(enginePaths.gameRoot, "src/index.tsx"), "utf8");
    for (const message of new Set(out as string[])) expect(indexTsx).toContain(`new Error("${message}")`);
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
    await runScript(sim, `ns.alert("first <b>bold</b> & 5 > 3"); ns.toast("second", "success"); ns.alert("third");`);
    // (Running a script also earns the "write an ns2 script" achievement, whose toast follows.)
    const shown = (await sim.events()).events
      .filter((event) => (event.type === "alert" || event.type === "toast") && !event.text.startsWith("Unlocked"))
      .map(withoutTime);
    expect(shown).toEqual([
      { type: "alert", text: "first bold & 5 > 3" },
      { type: "toast", text: "second", variant: "success" },
      { type: "alert", text: "third" },
    ]);
  });

  test("React content, the game's own components included, is rendered to its text", async () => {
    const played = await newGame();
    await runScript(played, `ns.nuke("n00dles"); while (true) await ns.hack("n00dles");`, 0);
    await played.advance(HOUR);
    const save = editSave(await played.save(), ({ PlayerSave }) => {
      PlayerSave.data.exp.hacking = 1_000; // hacking level 25: the first message arrives at the next check
    });
    const sim = await start({ seed: 9, fixture: { kind: "save", bytes: save, offlineMs: HOUR } });
    await sim.advance(60_000);
    const alerts = (await eventsOf(sim, "alert")).map((event) => (event.type === "alert" ? event.text : ""));
    // The offline summary (engine.tsx) uses the game's Money and Reputation components, which need its theme.
    expect(alerts).toEqual([
      expect.stringMatching(
        /^Offline for 1 hour 0 seconds\. While you were offline:\nYour scripts generated \$\d[\s\S]*reputation divided amongst your factions$/,
      ),
      expect.stringContaining(
        "Message received from unknown sender:\n\nI know you can sense it. I know you're searching for it.",
      ),
    ]);
    expect(alerts[1]).toContain("-jump3R");
    expect(await uncaught(sim)).toEqual([]);
  });

  test("every script error is reported, as if each error popup were closed at once", async () => {
    const sim = await newGame();
    const { name, pid } = await runScript(sim, `throw new Error("first failure");`);
    await runScript(sim, `throw new Error("second failure");`);
    expect((await eventsOf(sim, "error")).map(withoutTime)).toEqual([
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
  test("with no rule, a prompt stays open, as with nobody at the screen, until a newer one replaces it", async () => {
    const sim = await newGame();
    const first = await runScript(sim, `out("asking"); out(await ns.prompt("Continue?"));`, 60_000);
    expect(first.out).toEqual(["asking"]); // still waiting after a minute
    expect((await sim.ps("home")).map((p) => p.pid)).toEqual([first.pid]);

    // A newer prompt closes the open one as dismissing does: false for yes/no, "" for text.
    const second = await runScript(sim, `out(await ns.prompt("Name?", { type: "text" }));`);
    expect((await sim.logs(first.pid)).at(-1)).toBe("out:false");
    expect(second.out).toEqual([]);
    await runScript(sim, `ns.prompt("Third?");`);
    expect((await sim.logs(second.pid)).at(-1)).toBe('out:""');
    expect((await eventsOf(sim, "prompt")).map(withoutTime)).toEqual([
      { type: "prompt", text: "Continue?", kind: "boolean", choices: [], answer: null, answeredBy: "nobody" },
      { type: "prompt", text: "Name?", kind: "text", choices: [], answer: null, answeredBy: "nobody" },
      { type: "prompt", text: "Third?", kind: "boolean", choices: [], answer: null, answeredBy: "nobody" },
    ]);
  });

  test("rules answer prompts whose text they match; the first match wins", async () => {
    const sim = await newGame({
      prompts: [
        { match: "Continue", answer: true },
        { match: "Name", answer: "Ada" },
        { match: "Name", answer: "never used" },
        { match: "Pick", answer: "b" },
      ],
    });
    const { out } = await runScript(
      sim,
      `out(await ns.prompt("Continue?"));
       out(await ns.prompt("Name?", { type: "text" }));
       out(await ns.prompt("Pick one", { type: "select", choices: ["a", "b"] }));`,
    );
    expect(out).toEqual([true, "Ada", "b"]);
    expect((await eventsOf(sim, "prompt")).map((event) => event.type === "prompt" && event.answeredBy)).toEqual([
      "rule",
      "rule",
      "rule",
    ]);
  });

  test.each([
    ["a word for a yes/no prompt", "yes", `ns.prompt("Q?")`],
    ["true for a text prompt", true, `ns.prompt("Q?", { type: "text" })`],
    ["an option that isn't offered", "zzz", `ns.prompt("Q?", { type: "select", choices: ["a", "b"] })`],
  ])("a rule giving %s fails the script's ns.prompt call", async (_case, answer, call) => {
    const sim = await newGame({ prompts: [{ match: "Q", answer }] });
    const { out } = await runScript(sim, `try { out(await ${call}); } catch (e) { out(String(e)); }`);
    expect(out).toEqual([expect.stringContaining("which a player couldn't give")]);
  });

  test("bad rules are refused before the simulation starts", async () => {
    await expect(newGame({ prompts: [{ match: "", answer: true }] })).rejects.toThrow(/prompts must be rules/);
    await expect(newGame({ prompts: [{ match: "x", answer: 3 as unknown as boolean }] })).rejects.toThrow(
      /prompts must be rules/,
    );
  });
});

describe("uncaught errors are handled as a browser does", () => {
  test("killing a script with an un-awaited sleep doesn't end the simulation (the game ignores ScriptDeath)", async () => {
    const sim = await newGame();
    await sim.writeFile(
      "home",
      "lazy.js",
      "export async function main(ns) { ns.sleep(10000); while (true) await new Promise((r) => setTimeout(r, 100)); }",
    );
    const { pid } = await sim.run("home", "lazy.js");
    await sim.advance(1_000);
    expect((await sim.ps("home")).map((p) => p.pid)).toEqual([pid]);
    expect(await sim.kill(pid)).toBe(true);
    await sim.advance(20_000);
    expect(await sim.now()).toBe(EPOCH + 21_000);
    expect(await uncaught(sim)).toEqual([]);
    expect(await eventsOf(sim, "error")).toEqual([]);
  });

  test("any other rejection nobody handled reaches the game's error popup", async () => {
    const sim = await newGame();
    await runScript(sim, `Promise.reject(new Error("nobody caught this"));`);
    expect(await eventsOf(sim, "error")).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/UNCAUGHT PROMISE ERROR[\s\S]*nobody caught this/) }),
    ]);
  });

  test.each([
    ["a timer callback", `setTimeout(() => { throw new Error("thrown"); }, 10);`],
    ["a string timer handler", `setTimeout("throw new Error('thrown')", 10);`],
    ["a microtask", `queueMicrotask(() => { throw new Error("thrown"); });`],
    [
      "an event listener",
      `const target = new EventTarget();
       target.addEventListener("x", () => { throw new Error("thrown"); });
       target.dispatchEvent(new Event("x"));`,
    ],
  ])("an exception in %s is logged as uncaught, and time goes on", async (_case, body) => {
    const sim = await newGame();
    await runScript(sim, body);
    await sim.advance(5_000);
    expect(await sim.now()).toBe(EPOCH + 6_000);
    expect(await uncaught(sim)).toEqual([
      expect.objectContaining({ message: expect.stringContaining("Error: thrown") }),
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
  test("scripts can't reach the network, through the global object or window", async () => {
    const sim = await newGame();
    // Sockets reach only URLs the parent listens on (network.test.ts); this simulation listens on none.
    const { out } = await runScript(
      sim,
      `const win = ${WINDOW};
       out(await ns.wget("https://example.com/x.txt", "x.txt"));
       out(globalThis.WebSocket === win.WebSocket);
       for (const scope of [globalThis, win]) {
         try { await scope.fetch("https://example.com"); } catch (e) { out(e.message); }
         try { new scope.XMLHttpRequest(); } catch (e) { out(e.message); }
         try { new scope.EventSource("https://example.com"); } catch (e) { out(e.message); }
         const socket = new scope.WebSocket("wss://example.com");
         const closed = new Promise((resolve) => { socket.onclose = (event) => resolve(event.code); });
         out(await closed);
       }`,
    );
    const refusals = [
      "Failed to fetch",
      "XMLHttpRequest: the simulator has no network",
      "EventSource: the simulator has no network",
      1006,
    ];
    expect(out).toEqual([false, true, ...refusals, ...refusals]);
  });

  test("scripts import other scripts and data: URLs, as from a browser's blob: modules, and nothing else", async () => {
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

    // The game refuses other static imports itself (its RAM check). Dynamic imports reach the module loader.
    const { out } = await runScript(
      sim,
      `const specifiers = ["data:text/javascript,export default 7", "node:fs", "fs", "./lib.js", "https://example.com/x.js"];
       for (const specifier of specifiers) {
         try { out((await import(specifier)).default); } catch (e) { out(e.message); }
       }`,
    );
    expect(out).toEqual([
      7,
      'Failed to resolve module specifier "node:fs"',
      'Failed to resolve module specifier "fs"',
      'Failed to resolve module specifier "./lib.js"',
      "Failed to fetch dynamically imported module: https://example.com/x.js (the simulator is offline)",
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
