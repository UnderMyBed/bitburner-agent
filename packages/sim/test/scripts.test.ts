import { afterAll, describe, expect, test } from "vitest";
import { Simulation, type SimulationOptions } from "../src/simulation.ts";

const EPOCH = Date.UTC(2026, 0, 1);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const open: Simulation[] = [];
async function newGame(seed: number, extra: Partial<SimulationOptions> = {}): Promise<Simulation> {
  const sim = await Simulation.start({ seed, epochMs: EPOCH, fixture: { kind: "new", tutorial: "skipped" }, ...extra });
  open.push(sim);
  return sim;
}
afterAll(async () => {
  await Promise.all(open.map((sim) => sim.close()));
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

  test("slow imports don't change the result (the import barrier)", async () => {
    // Each first import of a script file is delayed by 20-50 real ms. Without the barrier, virtual time would run on
    // while a worker is still compiling, so it would start late.
    const [plain, delayed] = await Promise.all([newGame(5), newGame(5, { testHooks: { importDelayMs: [20, 50] } })]);
    await Promise.all([plain, delayed].map(startController));
    await Promise.all([plain, delayed].map((sim) => sim.advance(30 * MINUTE)));
    expect(await delayed.stateHash()).toBe(await plain.stateHash());
  });
});

test("a script started in the middle of an advance begins at the same virtual time, however slow its import", async () => {
  // Only the clock's between-timer barrier can help here: the import starts inside a timer, mid-advance.
  const launcher = `export async function main(ns) {
    ns.disableLog("ALL");
    await ns.sleep(60000);
    ns.print(\`pid \${ns.run("late.js")}\`);
  }`;
  const late = 'export async function main(ns) { ns.print("started at " + Date.now()); await ns.sleep(1000); }';
  const [plain, delayed] = await Promise.all([newGame(5), newGame(5, { testHooks: { importDelayMs: [20, 50] } })]);
  const started: string[] = [];
  for (const sim of [plain, delayed]) {
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
  const sim = await newGame(5, { testHooks: { importDelayMs: [20, 50] } });
  await sim.writeFile("home", "hello.js", 'export async function main(ns) { ns.print("hello"); await ns.sleep(1e9); }');
  const { pid } = await sim.run("home", "hello.js");
  expect((await sim.logs(pid))[0]).toBe("hello");
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

describe("script API", () => {
  test("run reports the game's own failure, and returns pid 0", async () => {
    const sim = await newGame(1);
    await sim.writeFile("home", "big.js", "export async function main(ns) { await ns.sleep(1e9); }");
    const result = await sim.run("home", "big.js", { threads: 1000 });
    expect(result.pid).toBe(0);
    expect(result.error).toMatch(/This script requires .* of RAM/);
    expect(await sim.run("home", "missing.js")).toMatchObject({
      pid: 0,
      error: expect.stringMatching(/does not exist/),
    });
  });

  test("pids increase; ps lists args and threads; kill frees the RAM", async () => {
    const sim = await newGame(1);
    await sim.writeFile("home", "idle.js", "export async function main(ns) { await ns.sleep(1e9); }");
    const first = await sim.run("home", "idle.js", { args: ["a", 1, true] });
    const second = await sim.run("home", "idle.js", { threads: 2, args: ["b"] });
    expect(second.pid).toBeGreaterThan(first.pid);
    expect(await sim.ps("home")).toEqual([
      { pid: first.pid, filename: "idle.js", threads: 1, args: ["a", 1, true] },
      { pid: second.pid, filename: "idle.js", threads: 2, args: ["b"] },
    ]);
    const used = (await sim.summary()).homeRamUsed;
    expect(await sim.kill(second.pid)).toBe(true);
    expect((await sim.summary()).homeRamUsed).toBeLessThan(used);
    expect(await sim.kill(second.pid)).toBe(false);
    expect((await sim.ps("home")).map((p) => p.pid)).toEqual([first.pid]);
  });

  test("logs stay readable after a script finishes", async () => {
    const sim = await newGame(1);
    await sim.writeFile("home", "hello.js", 'export async function main(ns) { ns.print("hello"); }');
    const { pid } = await sim.run("home", "hello.js");
    await sim.advance(1000);
    expect(await sim.ps("home")).toEqual([]);
    expect(await sim.logs(pid)).toEqual(["hello", "Script finished running"]);
  });

  test("a running tutorial keeps finished scripts and their RAM (v3.0.1 behaviour); skipping it doesn't", async () => {
    const [running, skipped] = await Promise.all([
      Simulation.start({ seed: 1, epochMs: EPOCH, fixture: { kind: "new", tutorial: "running" } }),
      newGame(1),
    ]);
    open.push(running);
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
