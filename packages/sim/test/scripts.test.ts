import { afterEach, describe, expect, test } from "vitest";
import { NODE_GLOBALS } from "../src/host/parity/node-globals.ts";
import { Simulation, type SimulationOptions } from "../src/simulation.ts";

const EPOCH = Date.UTC(2026, 0, 1);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Every script import takes 20-50 real ms longer: the kind of variation the import barrier must absorb. */
const SLOW_IMPORTS: Partial<SimulationOptions> = { testHooks: { importDelayMs: [20, 50] } };

const open: Simulation[] = [];
async function newGame(seed: number, extra: Partial<SimulationOptions> = {}): Promise<Simulation> {
  const sim = await Simulation.start({ seed, epochMs: EPOCH, fixture: { kind: "new", tutorial: "skipped" }, ...extra });
  open.push(sim);
  return sim;
}
// Each test's simulations close when it ends: a file's worth at once would crowd a CI runner's memory.
afterEach(async () => {
  await Promise.all(open.splice(0).map((sim) => sim.close()));
});

// The reference workloads from spike S1.
const HACK_LOOP = `
export async function main(ns) {
  const t = "n00dles";
  ns.nuke(t);
  while (true) {
    if (ns.getServerSecurityLevel(t) > ns.getServerMinSecurityLevel(t) + 1) await ns.weaken(t);
    else if (ns.getServerMoneyAvailable(t) < ns.getServerMaxMoney(t) * 0.75) await ns.grow(t);
    else await ns.hack(t);
  }
}`;
const CONTROLLER = `
export async function main(ns) {
  const t = "n00dles";
  ns.nuke(t);
  while (true) {
    const free = ns.getServerMaxRam("home") - ns.getServerUsedRam("home");
    const sec = ns.getServerSecurityLevel(t) - ns.getServerMinSecurityLevel(t);
    const m = ns.getServerMoneyAvailable(t) / ns.getServerMaxMoney(t);
    const s = sec > 1 ? "w.js" : m < 0.75 ? "g.js" : "h.js";
    const threads = Math.min(Math.floor(free / 1.75), 2);
    if (threads > 0) ns.exec(s, "home", { threads }, t, Math.random());
    await ns.sleep(200);
  }
}`;
const worker = (op: string) => `export async function main(ns) { await ns.${op}(ns.args[0]); }`;
const IDLE = "export async function main(ns) { await ns.sleep(1e9); }";

async function startController(sim: Simulation): Promise<void> {
  await sim.writeFile("home", "w.js", worker("weaken"));
  await sim.writeFile("home", "g.js", worker("grow"));
  await sim.writeFile("home", "h.js", worker("hack"));
  await sim.writeFile("home", "ctl.js", CONTROLLER);
  expect((await sim.run("home", "ctl.js")).pid).toBeGreaterThan(0);
}

describe("running scripts", () => {
  test("the reference hack loop earns money", async () => {
    const sim = await newGame(1);
    await sim.writeFile("home", "hack.js", HACK_LOOP);
    const { pid } = await sim.run("home", "hack.js", { threads: 3 });
    const before = (await sim.summary()).money;
    const started = performance.now();
    await sim.advance(HOUR);
    const speed = Math.round(HOUR / (performance.now() - started));
    console.log(`lean hack loop: ${speed}x real time`);
    expect((await sim.summary()).money).toBeGreaterThan(before);
    expect((await sim.logs(pid)).some((line) => line.includes("hack: Executing on 'n00dles'"))).toBe(true);
  });

  test("relative imports and any characters in the source load correctly", async () => {
    const sim = await newGame(1);
    const tricky = 'it\'s "quoted", `ticked`, back\\slashed, ünïcödé, %20 and </script>';
    await sim.writeFile("home", "lib/text.js", `export const text = ${JSON.stringify(tricky)};`);
    await sim.writeFile(
      "home",
      "main.js",
      `import { text } from "./lib/text.js";\nexport async function main(ns) { ns.print(text); }`,
    );
    const { pid } = await sim.run("home", "main.js");
    await sim.advance(1000);
    expect(await sim.logs(pid)).toContain(tricky);
  });

  test("a controller that execs workers is deterministic and step-invariant", async () => {
    const [a, b, stepped] = await Promise.all([newGame(5), newGame(5), newGame(5)]);
    await Promise.all([a, b, stepped].map(startController));
    await Promise.all([a.advance(HOUR), b.advance(HOUR)]);
    for (let i = 0; i < 60; i++) await stepped.advance(MINUTE);
    const [ha, hb, hs] = await Promise.all([a, b, stepped].map((sim) => sim.stateHash()));
    expect(ha).toBe(hb);
    expect(hs).toBe(ha);
    expect((await a.summary()).hackingExp).toBeGreaterThan(0);
  });

  test("only script Blobs become simulated modules; other Blobs keep Node's own object URLs", async () => {
    const sim = await newGame(1);
    const probe = `export async function main(ns) {
      ns.print(URL.createObjectURL(new Blob(["save data"], { type: "application/gzip" })).slice(0, 9));
    }`;
    await sim.writeFile("home", "blob.js", probe);
    const { pid } = await sim.run("home", "blob.js");
    await sim.advance(1000);
    const [prefix] = await sim.logs(pid);
    expect(prefix).toMatch(/^blob:/);
    expect(prefix).not.toBe("blob:sim/");
  });

  test("an error is attributed to the module it came from, however many modules are loaded", async () => {
    // The game names the script in an error's stack by finding a module URL, then a file name, inside each stack line
    // (Netscript/ErrorMessages.ts). Frames carry the game's `//# sourceURL=<server>/<file>`, as in a browser, so they
    // match by file name. Twelve modules give two-digit module numbers too, so this would also catch a URL scheme
    // where one URL contains another, should frames ever show the URLs.
    const sim = await newGame(1);
    const libs = Array.from({ length: 12 }, (_, i) => `lib${String(i + 1).padStart(2, "0")}.js`);
    // Each source differs: the game shares one module between scripts with identical code (its moduleCache).
    for (const lib of libs) await sim.writeFile("home", lib, `export function fail(ns) { ns.hack(42); } // ${lib}`);
    const attributed: string[] = [];
    for (const k of libs.keys()) {
      const imports = libs.map((name, i) => `import * as l${i} from "./${name}";`).join("\n");
      await sim.writeFile("home", `root${k}.js`, `${imports}\nexport async function main(ns) { l${k}.fail(ns); }`);
      const { pid } = await sim.run("home", `root${k}.js`);
      await sim.advance(1000);
      const error = (await sim.events()).events.find((e) => e.type === "error" && e.pid === pid);
      // The stack lines name each frame's script: "lib07.js:L1@Module.fail".
      const message = error?.type === "error" ? error.message : "";
      attributed.push(/(lib\d\d\.js):L\d+@Module\.fail/.exec(message)?.[1] ?? message);
    }
    expect(attributed).toEqual(libs);
  });

  test("a module URL in an error message becomes its own script's name, however many modules are loaded", async () => {
    // The game swaps module URLs in an error message for file names by plain replacement, in dependency order
    // (Netscript/ErrorMessages.ts, parseBlobUrlInMessage), and a link error quotes the URL. A browser's blob URLs are
    // UUIDs; ours must not contain one another either, or blob:sim/1 would turn blob:sim/12 into "lib12.js2".
    const sim = await newGame(1);
    const libs = Array.from({ length: 12 }, (_, i) => `lib${String(i + 1).padStart(2, "0")}.js`);
    for (const lib of libs) await sim.writeFile("home", lib, `export const name = "${lib}";`);
    // Loading all twelve numbers them in reverse import order: lib12 first, lib01 twelfth.
    const imports = libs.map((name, i) => `import * as l${i} from "./${name}";`).join("\n");
    await sim.writeFile("home", "all.js", `${imports}\nexport async function main(ns) {}`);
    await sim.run("home", "all.js");
    await sim.advance(1000);
    // The importer depends on lib12 (the first URL) and lib01 (one it's a prefix of), and asks lib01 for a missing export.
    const bad =
      'import { nope } from "./lib01.js";\nimport * as z from "./lib12.js";\nexport async function main(ns) {}';
    await sim.writeFile("home", "bad.js", bad);
    const { pid } = await sim.run("home", "bad.js");
    await sim.advance(1000);
    const error = (await sim.events()).events.find((e) => e.type === "error" && e.pid === pid);
    expect(error?.type === "error" ? error.message : "").toContain(
      "The requested module 'lib01.js' does not provide an export named 'nope'",
    );
  });

  test("timers are delayed and nested as in Chromium 146: delays as WebIDL reads them, short ones clamped past level 6", async () => {
    // fake-timers alone gave `setInterval(fn)` a NaN interval, which broke its timer order (runUntil threw), repeated
    // a 0 ms interval forever at one moment, and read "1e3" as 1 ms (#80).
    const sim = await newGame(1);
    const script = `export async function main(ns) {
      const start = Date.now();
      const at = () => Date.now() - start;
      const intervals = { none: [], text: [], negative: [], zero: [] };
      const ids = [
        setInterval(() => intervals.none.push(at())),
        setInterval(() => intervals.text.push(at()), "x"),
        setInterval(() => intervals.negative.push(at()), -5),
        setInterval(() => intervals.zero.push(at()), 0),
      ];
      const chain = [];
      const step = () => { chain.push(at()); if (chain.length < 10) setTimeout(step, 0); };
      setTimeout(step, 0);
      let exponent = -1;
      setTimeout(() => { exponent = at(); }, "1e3");
      await ns.sleep(1100);
      for (const id of ids) clearInterval(id);
      // End inside a deep chain, so the last timer task was past level 6.
      await new Promise((resolve) => { let n = 0; const go = () => (++n < 12 ? setTimeout(go, 0) : resolve()); setTimeout(go, 0); });
      const first = Object.fromEntries(Object.entries(intervals).map(([name, times]) => [name, times.slice(0, 9)]));
      ns.print(JSON.stringify({ first, chain, exponent }));
    }`;
    await sim.writeFile("home", "timers.js", script);
    const { pid } = await sim.run("home", "timers.js");
    const { stoppedBy } = await sim.runUntil(5000, { stopWhen: [{ scriptExited: "timers.js" }] });
    expect(stoppedBy).toBe(0);
    const line = (await sim.logs(pid)).find((entry) => entry.startsWith("{"));
    const { first, chain, exponent } = JSON.parse(line ?? "{}") as {
      first: Record<string, number[]>;
      chain: number[];
      exponent: number;
    };
    // A 0 ms interval set by the script (level 1) fires at once six times (levels 1-6), then every 4 ms, as Chromium's.
    for (const times of Object.values(first)) expect(times).toEqual([0, 0, 0, 0, 0, 0, 4, 8, 12]);
    // A chain of 0 ms timeouts: Chromium runs levels 1-6 at once, then 4 ms apart (0,0,0,0,0,0,4,8,12,16). Here each
    // one set during a tick waits fake-timers' 1 ms, then 4 ms apart from level 7.
    expect(chain).toEqual([0, 1, 2, 3, 4, 5, 9, 13, 17, 21]);
    expect(exponent).toBe(1000); // "1e3" is 1000 ms, as WebIDL reads it; fake-timers' parseInt read 1

    // A request is a fresh task: a script it starts sets its timers at level 1 again, however deep the last ones were.
    const fresh = `export async function main(ns) {
      const start = Date.now();
      const times = [];
      const id = setInterval(() => times.push(Date.now() - start), 0);
      await ns.sleep(10);
      clearInterval(id);
      ns.print(JSON.stringify(times.slice(0, 7)));
    }`;
    await sim.writeFile("home", "fresh.js", fresh);
    const second = await sim.run("home", "fresh.js");
    await sim.runUntil(5000, { stopWhen: [{ scriptExited: "fresh.js" }] });
    expect((await sim.logs(second.pid)).find((entry) => entry.startsWith("["))).toBe("[0,0,0,0,0,0,4]");
  });
  test("tasks that aren't timers start at nesting level 0: a new script's main(), a message, an animation frame", async () => {
    // Each runs after a chain deep past level 6. A 0 ms timer set from a fresh task waits only fake-timers' 1 ms; one
    // nested past level 6 would wait 4.
    const sim = await newGame(1);
    const deep =
      "await new Promise((done) => { let n = 0; const go = () => (++n < 10 ? setTimeout(go, 0) : done()); setTimeout(go, 0); });";
    const child = `export async function main(ns) {
      const start = Date.now();
      const times = [];
      await new Promise((done) => { const step = () => { times.push(Date.now() - start); times.length < 8 ? setTimeout(step, 0) : done(); }; setTimeout(step, 0); });
      ns.print("child " + JSON.stringify(times));
    }`;
    const parent = `export async function main(ns) {
      ${deep}
      ns.run("child.js");
      ${deep}
      const fromMessage = await new Promise((done) => setImmediate(() => { const s = Date.now(); setTimeout(() => done(Date.now() - s), 0); }));
      ${deep}
      const fromFrame = await new Promise((done) => requestAnimationFrame(() => { const s = Date.now(); setTimeout(() => done(Date.now() - s), 0); }));
      ns.print("tasks " + JSON.stringify({ fromMessage, fromFrame }));
      await ns.sleep(1000);
    }`;
    await sim.writeFile("home", "child.js", child);
    await sim.writeFile("home", "parent.js", parent);
    const { pid } = await sim.run("home", "parent.js");
    await sim.runUntil(5000, { stopWhen: [{ scriptExited: "parent.js" }] });
    const lines = [...(await sim.logs(pid)), ...(await sim.logs(pid + 1))];
    // The child's chain starts at level 1, as a request's would: six links of fake-timers' 1 ms, then 4 ms.
    expect(lines).toContain("child [1,2,3,4,5,6,10,14]");
    // The message runs outside fake-timers' tick, so its 0 ms timer waits 0 ms, as in Chromium; the frame, a timer to
    // fake-timers, takes its 1 ms. Nested past level 6, either would wait 4.
    expect(lines).toContain('tasks {"fromMessage":0,"fromFrame":1}');
  });

  test.each([
    ["imports at full speed", {}],
    ["slow imports", SLOW_IMPORTS],
  ])(
    "starting a new script doesn't reset the importer's level (%s); a message during the import is a task of its own",
    async (_, extra) => {
      // In Chromium the parent's microtasks all run at its level, and the child's module loads in a later task. Node can
      // settle the import inside the parent's microtasks, so the host waits for a real task before resetting (#80).
      const sim = await newGame(1, extra);
      const deep =
        "await new Promise((done) => { let n = 0; const go = () => (++n < 10 ? setTimeout(go, 0) : done()); setTimeout(go, 0); });";
      const parent = `export async function main(ns) {
      ${deep}
      ns.run("child-a.js");
      for (let i = 0; i < 20; i++) await null;
      const afterRun = await new Promise((done) => { const s = Date.now(); setTimeout(() => done(Date.now() - s), 0); });
      ${deep}
      ns.run("child-b.js");
      const fromMessage = await new Promise((done) => setImmediate(() => { const s = Date.now(); setTimeout(() => done(Date.now() - s), 0); }));
      ns.print(JSON.stringify({ afterRun, fromMessage }));
      await ns.sleep(100);
    }`;
      for (const name of ["child-a.js", "child-b.js"]) {
        await sim.writeFile("home", name, `export async function main(ns) { await ns.sleep(10); } // ${name}`);
      }
      await sim.writeFile("home", "parent.js", parent);
      const { pid } = await sim.run("home", "parent.js");
      await sim.runUntil(5000, { stopWhen: [{ scriptExited: "parent.js" }] });
      const line = (await sim.logs(pid)).find((entry) => entry.startsWith("{"));
      // The parent is still past level 6 after ns.run, so its 0 ms timer waits 4 ms, however long the import takes. A
      // message is a task of its own: its 0 ms timer isn't clamped. It waits fake-timers' 1 ms, since the import holds
      // the clock mid-advance, at either import speed.
      expect(JSON.parse(line ?? "{}")).toEqual({ afterRun: 4, fromMessage: 1 });
    },
  );

  test("intervals: callbacks run at their own level, a long one keeps its period, a moved one clears however it's named", async () => {
    const sim = await newGame(1);
    const script = `export async function main(ns) {
      const start = Date.now();
      // A 0 ms interval set by a request is at level 1: its 5th callback runs at level 5, so a 0 ms timer it sets is at
      // level 6 and isn't clamped.
      let fifth = -1, fired = 0;
      const short = setInterval(() => { if (++fired === 5) { const s = Date.now(); setTimeout(() => { fifth = Date.now() - s; }, 0); } }, 0);
      const long = [];
      const five = setInterval(() => long.push(Date.now() - start), 5);
      let a = 0, b = 0;
      const byNumber = setInterval(() => a++, 0);
      const byTimeout = setInterval(() => b++, 0);
      await ns.sleep(50);
      clearInterval(short); clearInterval(five);
      clearInterval(Number(byNumber)); // as a browser's numeric id would be
      clearTimeout(byTimeout); // either clear clears either kind
      const [a0, b0] = [a, b];
      await ns.sleep(50);
      ns.print(JSON.stringify({ fifth, long: long.slice(0, 8), stopped: a === a0 && b === b0 }));
    }`;
    await sim.writeFile("home", "intervals.js", script);
    const { pid } = await sim.run("home", "intervals.js");
    await sim.runUntil(5000, { stopWhen: [{ scriptExited: "intervals.js" }] });
    const line = (await sim.logs(pid)).find((entry) => entry.startsWith("{"));
    expect(JSON.parse(line ?? "{}")).toEqual({ fifth: 1, long: [5, 10, 15, 20, 25, 30, 35, 40], stopped: true });
  });

  test("garbage collection doesn't change results: compiled modules are held, as upstream dev holds them", async () => {
    // The game caches each compiled module by its source, through a WeakRef (NetscriptJSEvaluator.ts:41-47, :223-224).
    // A module the collector frees comes back fresh, its module-level state reset, so a script that keeps state at
    // module level (as the legacy fork does) would behave differently depending on when the collector ran (#73). Here a
    // file changes and changes back, which leaves its first module only in the cache; one game then collects garbage
    // before the second run. The count also goes to a file, so it reaches the save and the state hash.
    const counter = (note = "") =>
      `let runs = 0;\nexport async function main(ns) { runs++; ns.print("run " + runs); ns.write("runs.txt", String(runs), "w"); }${note}`;
    const [kept, collected] = await Promise.all([newGame(1), newGame(1)]);
    const counts: string[][] = [];
    for (const sim of [kept, collected]) {
      await sim.writeFile("home", "counter.js", counter());
      const first = await sim.run("home", "counter.js");
      await sim.advance(1000);
      await sim.writeFile("home", "counter.js", counter("\n// changed"));
      await sim.writeFile("home", "counter.js", counter());
      if (sim === collected) await sim.diagnostics.heap(); // a full collection
      const second = await sim.run("home", "counter.js");
      await sim.advance(1000);
      const lines = [...(await sim.logs(first.pid)), ...(await sim.logs(second.pid))];
      counts.push(lines.filter((line) => line.startsWith("run ")));
    }
    expect(counts).toEqual([
      ["run 1", "run 2"],
      ["run 1", "run 2"],
    ]);
    expect(await collected.stateHash()).toBe(await kept.stateHash());
  });
});

describe("import barrier", () => {
  test("slow imports don't change the result", async () => {
    const [plain, slow] = await Promise.all([newGame(5), newGame(5, SLOW_IMPORTS)]);
    await Promise.all([plain, slow].map(startController));
    await Promise.all([plain, slow].map((sim) => sim.advance(30 * MINUTE)));
    expect(await slow.stateHash()).toBe(await plain.stateHash());
  });

  test("a script started in the middle of an advance begins at the same virtual time, however slow its import", async () => {
    // Only the clock's between-timer barrier can help here: the import starts inside a timer, mid-advance.
    const launcher = `export async function main(ns) {
      ns.disableLog("ALL");
      await ns.sleep(60000);
      ns.print(\`pid \${ns.run("late.js")}\`);
    }`;
    const late = 'export async function main(ns) { ns.print("started at " + Date.now()); await ns.sleep(1000); }';
    const [plain, slow] = await Promise.all([newGame(5), newGame(5, SLOW_IMPORTS)]);
    const started: string[] = [];
    for (const sim of [plain, slow]) {
      await sim.writeFile("home", "launcher.js", launcher);
      await sim.writeFile("home", "late.js", late);
      const { pid: launcherPid } = await sim.run("home", "launcher.js");
      await sim.advance(5 * MINUTE); // one call: no request boundary falls between the launch and late.js starting
      const latePid = Number((await sim.logs(launcherPid))[0]?.replace("pid ", ""));
      started.push((await sim.logs(latePid))[0] ?? "");
    }
    expect(started[0]).toBe(`started at ${EPOCH + MINUTE}`);
    expect(started[1]).toBe(started[0]);
  });

  test("the next request after run sees the script already started, however slow its import", async () => {
    // Only the request-level barrier can help here: no virtual time passes between run and logs.
    const sim = await newGame(5, SLOW_IMPORTS);
    await sim.writeFile(
      "home",
      "hello.js",
      'export async function main(ns) { ns.print("hello"); await ns.sleep(1e9); }',
    );
    const { pid } = await sim.run("home", "hello.js");
    expect((await sim.logs(pid))[0]).toBe("hello");
  });

  test("scripts started in the same instant start in the order they were asked for, however slow their imports", async () => {
    // With the test delays, the second import finishes first in real time; it must not get to run first.
    const launcher = 'export async function main(ns) { ns.run("a.js"); ns.run("b.js"); }';
    const named = (name: string) => `export async function main(ns) { ns.print("${name}:" + Math.random()); }`;
    const [plain, slow] = await Promise.all([newGame(5), newGame(5, SLOW_IMPORTS)]);
    const outputs: string[][] = [];
    for (const sim of [plain, slow]) {
      await sim.writeFile("home", "launcher.js", launcher);
      await sim.writeFile("home", "a.js", named("a"));
      await sim.writeFile("home", "b.js", named("b"));
      await sim.run("home", "launcher.js");
      await sim.advance(1000);
      outputs.push([(await sim.logs(2))[0] ?? "", (await sim.logs(3))[0] ?? ""]);
    }
    expect(outputs[0]?.[0]).toMatch(/^a:/);
    expect(outputs[1]).toEqual(outputs[0]);
  });

  test("a module that can never finish loading fails loudly instead of hanging", async () => {
    // Its top-level code awaits a virtual timer, which can't fire while the barrier holds virtual time for it.
    const sim = await newGame(1, { testHooks: { importTimeoutMs: 300 } });
    const stuck = "await new Promise((resolve) => setTimeout(resolve, 1000));\nexport async function main(ns) {}";
    await sim.writeFile("home", "stuck.js", stuck);
    await sim.run("home", "stuck.js");
    await expect(sim.advance(MINUTE)).rejects.toThrow(/exited with code 70[\s\S]*has not loaded after 300 ms/);
  });
});

describe("script API", () => {
  test("run reports the game's own refusal, with pid 0", async () => {
    const sim = await newGame(1);
    await sim.writeFile("home", "idle.js", IDLE);
    await sim.writeFile("home", "old.script", "print('hi');");
    expect(await sim.run("home", "idle.js", { threads: 1000 })).toMatchObject({
      pid: 0,
      error: expect.stringMatching(/This script requires .* of RAM/),
    });
    expect(await sim.run("home", "missing.js")).toMatchObject({
      pid: 0,
      error: expect.stringMatching(/does not exist/),
    });
    expect(await sim.run("home", "idle.js", { threads: 1.5 })).toMatchObject({
      pid: 0,
      error: expect.stringMatching(/Invalid number of threads/),
    });
    expect(await sim.run("home", "old.script")).toMatchObject({
      pid: 0,
      error: expect.stringMatching(/\.script files/),
    });
  });

  test("pids increase; ps lists args and threads; kill frees the RAM", async () => {
    const sim = await newGame(1);
    await sim.writeFile("home", "idle.js", IDLE);
    const first = await sim.run("home", "idle.js", { args: ["a", 1, true] });
    const second = await sim.run("home", "idle.js", { threads: 2, args: ["b"] });
    // Same file and args as the first: the game groups it with the first, so its own order would be 1, 3, 2.
    const third = await sim.run("home", "idle.js", { args: ["a", 1, true] });
    expect(second.pid).toBeGreaterThan(first.pid);
    expect(third.pid).toBeGreaterThan(second.pid);
    expect(await sim.ps("home")).toEqual([
      { pid: first.pid, filename: "idle.js", threads: 1, args: ["a", 1, true] },
      { pid: second.pid, filename: "idle.js", threads: 2, args: ["b"] },
      { pid: third.pid, filename: "idle.js", threads: 1, args: ["a", 1, true] },
    ]);
    const used = (await sim.summary()).homeRamUsed;
    expect(await sim.kill(second.pid)).toBe(true);
    expect((await sim.summary()).homeRamUsed).toBeLessThan(used);
    expect(await sim.kill(second.pid)).toBe(false);
    expect((await sim.ps("home")).map((p) => p.pid)).toEqual([first.pid, third.pid]);
  });

  test("homePeak counts a script that starts and exits between two timers, which no check after a timer sees", async () => {
    const sim = await newGame(1);
    expect(await sim.diagnostics.homePeak()).toEqual({ ramUsed: 0, scripts: 0 });
    // The parent (2.6 GB) runs a 1.6 GB child that exits at once, within the parent's own timer, every 100 ms.
    await sim.writeFile("home", "quick.js", "export function main(ns) {}");
    await sim.writeFile(
      "home",
      "parent.js",
      `export async function main(ns) { for (let i = 0; i < 5; i++) { ns.run("quick.js"); await ns.sleep(100); } }`,
    );
    expect((await sim.run("home", "parent.js")).error).toBeUndefined();
    const { stoppedBy } = await sim.runUntil(1_000, {
      stopWhen: [{ summary: { field: "homeRamUsed", op: ">", value: 2.6 } }],
    });
    expect(stoppedBy).toBeNull();
    expect(await sim.diagnostics.homePeak()).toEqual({ ramUsed: 4.2, scripts: 2 });
  });

  test("player scripts see a browser's globals, not Node's: no process, Buffer or global, and the game's setImmediate", async () => {
    const sim = await newGame(1);
    const names = NODE_GLOBALS;
    const probe = names
      .map((name) => `typeof ${name} + "/" + typeof globalThis.${name} + "/" + typeof eval("window").${name}`)
      .join(' + " " + ');
    // A browser has no setImmediate, so the game's jszip installs a polyfill on the window, and a browser's window is
    // the global object. Node's returns an Immediate object; the polyfill returns a number.
    const immediate = 'setImmediate === eval("window").setImmediate) + " " + typeof setImmediate(() => {})';
    await sim.writeFile(
      "home",
      "node.js",
      // The callback runs on a later task, while the script sleeps.
      `export async function main(ns) { ns.print(${probe}); ns.print((${immediate}); let ran = false; setImmediate(() => { ran = true; }); await ns.sleep(100); ns.print(ran ? "ran" : "didn't run"); }`,
    );
    const { pid } = await sim.run("home", "node.js");
    await sim.advance(1000);
    const node = "undefined/undefined/undefined";
    const browser = "function/function/function";
    expect(names).toEqual(["process", "Buffer", "global", "setImmediate", "clearImmediate"]);
    expect(await sim.logs(pid)).toEqual([
      [node, node, node, browser, browser].join(" "),
      "true number",
      "sleep: Sleeping for 0.100 seconds.",
      "ran",
      "Script finished running",
    ]);
  });

  test("no route leads a script to Node's process, Buffer or global", async () => {
    const sim = await newGame(1);
    const routes = [
      // Not on the global object at all, as in a browser: no property, no accessor to call from elsewhere.
      `["process", "Buffer", "global"].map((name) => (name in globalThis) + "/" + Object.getOwnPropertyDescriptor(globalThis, name)).join(" ")`,
      // Code that names itself like Node's own.
      `new Function("return typeof process\\n//# sourceURL=node:evil")()`,
      `(() => { const k = "x (node:y"; return typeof ({ [k]() { return globalThis.process; } })[k](); })()`,
      `(() => { Error.prepareStackTrace = () => "a\\nb\\nc\\nat node:x"; const t = typeof globalThis.process; delete Error.prepareStackTrace; return t; })()`,
    ];
    const lines = routes.map((route) => `ns.print(String(${route}));`).join(" ");
    await sim.writeFile("home", "escape.js", `export async function main(ns) { ${lines} }`);
    const { pid } = await sim.run("home", "escape.js");
    await sim.advance(1000);
    expect((await sim.logs(pid)).slice(0, routes.length)).toEqual([
      "false/undefined false/undefined false/undefined",
      "undefined",
      "undefined",
      "undefined",
    ]);
  });

  test("saves still work after a script changes how stack traces are made", async () => {
    const sim = await newGame(1);
    const script = `export async function main(ns) { Error.stackTraceLimit = 2; Error.prepareStackTrace = () => "x"; }`;
    await sim.writeFile("home", "stacks.js", script);
    await sim.run("home", "stacks.js");
    await sim.advance(1000);
    expect((await sim.save()).length).toBeGreaterThan(1000);
  });

  test("postMessage reaches the page as in a browser: bare or on window, with source and origin, filtered by target", async () => {
    const sim = await newGame(1);
    const script = `export async function main(ns) {
      const seen = [];
      const sent = { n: 1 };
      let copied = "no object";
      window.addEventListener("message", (e) => {
        // The message is a structured clone: an equal copy, not the object sent.
        if (typeof e.data === "object") copied = String(e.data !== sent && e.data.n === 1);
        else seen.push([e.data, e.source === window, e.origin].join("/"));
      });
      window.postMessage(sent, "*");
      ns.print(String(globalThis.postMessage === window.postMessage));
      postMessage("star", "*");
      window.postMessage("self", { targetOrigin: "/" });
      window.postMessage("default");
      window.postMessage("elsewhere", "https://example.com");
      let bad = "none";
      try { window.postMessage("bad", "not a url"); } catch (e) { bad = e.name; }
      await ns.sleep(100);
      ns.print(seen.join(" ") + " " + bad + " " + copied);
    }`;
    await sim.writeFile("home", "pm.js", script.replaceAll("window", 'eval("window")'));
    const { pid } = await sim.run("home", "pm.js");
    await sim.advance(1000);
    const logs = await sim.logs(pid);
    expect(logs[0]).toBe("true");
    expect(logs.at(-2)).toBe(
      "star/true/https://bitburner.local self/true/https://bitburner.local default/true/https://bitburner.local SyntaxError true",
    );
  });

  test("measuring the heap doesn't expose gc to player scripts", async () => {
    const sim = await newGame(1);
    expect(await sim.diagnostics.heap()).toBeGreaterThan(0);
    await sim.writeFile(
      "home",
      "gc.js",
      'export async function main(ns) { ns.print([typeof gc, typeof globalThis.gc, typeof eval("window").gc].join(" ")); }',
    );
    const { pid } = await sim.run("home", "gc.js");
    await sim.advance(1000);
    expect((await sim.logs(pid))[0]).toBe("undefined undefined undefined");
  });

  test("logs stay readable after a script finishes; unknown pids are an error", async () => {
    const sim = await newGame(1);
    await sim.writeFile("home", "hello.js", 'export async function main(ns) { ns.print("hello"); }');
    const { pid } = await sim.run("home", "hello.js");
    await sim.advance(1000);
    expect(await sim.ps("home")).toEqual([]);
    expect(await sim.logs(pid)).toEqual(["hello", "Script finished running"]);
    await expect(sim.logs(999)).rejects.toThrow(/No running or recent script with pid 999/);
  });

  test("a running tutorial keeps finished scripts and their RAM (v3.0.1 behaviour); skipping it doesn't", async () => {
    const [running, skipped] = await Promise.all([
      newGame(1, { fixture: { kind: "new", tutorial: "running" } }),
      newGame(1),
    ]);
    for (const sim of [running, skipped]) {
      await sim.writeFile("home", "quick.js", "export async function main(ns) {}");
      await sim.run("home", "quick.js");
      await sim.advance(1000);
    }
    expect((await running.ps("home")).map((p) => p.filename)).toEqual(["quick.js"]);
    expect((await running.summary()).homeRamUsed).toBeGreaterThan(0);
    expect(await skipped.ps("home")).toEqual([]);
    expect((await skipped.summary()).homeRamUsed).toBe(0);
  });
});
