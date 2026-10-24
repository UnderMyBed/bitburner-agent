// Spike S1 runner: boot the real engine headless under a virtual clock and seeded RNG, run an NS hack script,
// advance virtual time, report speed and a state hash.
//   node run.mjs [--seed N] [--hours H] [--step MS] [--threads T]
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { parseArgs } from "node:util";
import { JSDOM } from "jsdom";
import FakeTimers from "@sinonjs/fake-timers";

const { values: opts } = parseArgs({
  options: {
    seed: { type: "string", default: "1" },
    hours: { type: "string", default: "1" },
    step: { type: "string", default: "1000" },
    threads: { type: "string", default: "3" },
    copies: { type: "string", default: "1" },
    scenario: { type: "string", default: "loop" },
    ram: { type: "string", default: "1024" },
    "max-threads": { type: "string", default: "20" },
    "per-tick": { type: "string", default: "1" },
    "no-log": { type: "boolean", default: false },
    load: { type: "string" }, // boot from a .json.gz save instead of a new game; no scenario script is started
    "save-out": { type: "string" }, // write the game's own save at the end
    start: { type: "string" }, // virtual epoch (ms); default 2026-01-01
    quiet: { type: "boolean", default: false },
  },
});
const seed = Number(opts.seed);
const virtualMs = Number(opts.hours) * 3600_000;
const stepMs = Number(opts.step);
const START = opts.start ? Number(opts.start) : Date.UTC(2026, 0, 1); // fixed virtual epoch

// --- 1. DOM globals (the engine touches window/document at import time) ---
const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
  url: "https://bitburner.local/",
  pretendToBeVisual: true,
});
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (key in globalThis || key.startsWith("_")) continue;
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: dom.window[key] });
}
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
// jsdom gaps, patched the same way as the game's FixJSDOMEnvironment.ts.
dom.window.document.adoptedStyleSheets = [];
dom.window.CSSStyleSheet.prototype.replaceSync = () => {};

// --- 2. Seeded RNG (sfc32) replacing Math.random everywhere ---
function sfc32(a, b, c, d) {
  return () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}
const rng = sfc32(0x9e3779b9, 0x243f6a88, 0xb7e15162, seed);
for (let i = 0; i < 20; i++) rng();
Math.random = rng;
dom.window.Math.random = rng;

// --- 3. Virtual clock. Real microtasks, setImmediate and nextTick are left alone. ---
const clock = FakeTimers.install({
  now: START,
  toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"],
  loopLimit: 1e9,
});
for (const k of ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"]) dom.window[k] = globalThis[k];
dom.window.performance.now = () => globalThis.performance.now();

// --- 4. Script modules: the engine imports player scripts from Blob URLs, which Node can't import.
// Serve short in-memory "blob:" URLs through a synchronous module hook instead, as the browser does.
// (data: URLs, as in the game's Jest setup, nest the full encoded child inside every importing module.)
const NativeBlob = globalThis.Blob;
globalThis.Blob = class ScriptBlob extends NativeBlob {
  constructor(parts, options) {
    super(parts, options);
    this.code = String((parts ?? [])[0]);
  }
};
const blobModules = new Map();
let nextBlob = 0;
URL.createObjectURL = (blob) => {
  const url = `blob:sim/${++nextBlob}`;
  blobModules.set(url, blob.code);
  return url;
};
URL.revokeObjectURL = (url) => blobModules.delete(url);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("blob:sim/")) return { url: specifier, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("blob:sim/")) return { format: "module", source: blobModules.get(url), shortCircuit: true };
    return nextLoad(url, context);
  },
});

process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));

// --- 5. Load and boot the engine ---
const hr = () => Number(process.hrtime.bigint()) / 1e6; // real time
const hashOf = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);
let t0 = hr();
const require = createRequire(import.meta.url);
const engine = require("./dist/engine.cjs");
const loadMs = hr() - t0;
// Browser parity: window === globalThis there, so globals that libraries put on window while loading
// (sprintf-js sets window.sprintf/vsprintf) are visible to player scripts. Mirror them, plus lodash's `_`.
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (!(key in globalThis)) globalThis[key] = dom.window[key];
}
globalThis._ = engine.lodash;

t0 = hr();
if (opts.load) {
  await engine.boot((url) => import(url), new Uint8Array(readFileSync(opts.load)));
} else {
  await engine.boot((url) => import(url));
  engine.skipTutorial();
}
const bootMs = hr() - t0;
const bootHash = hashOf(engine.stateDump());
const bootSummary = engine.summary();

const HACK_SCRIPT = `
export async function main(ns) {
  const t = "n00dles";
  ns.nuke(t);
  while (true) {
    if (ns.getServerSecurityLevel(t) > ns.getServerMinSecurityLevel(t) + 1) await ns.weaken(t);
    else if (ns.getServerMoneyAvailable(t) < ns.getServerMaxMoney(t) * 0.75) await ns.grow(t);
    else await ns.hack(t);
  }
}`;
// --scenario batch: a controller that exec()s single-op worker scripts every 200 ms on a large home server.
// Exercises mid-run module imports, process churn and many concurrent timers, like a real batcher.
const CONTROLLER = `
export async function main(ns) {
  const t = "n00dles";
  ns.nuke(t);
  if (ns.args[2]) ns.disableLog("ALL");
  const maxPer = Number(ns.args[0]);
  const perTick = Number(ns.args[1]);
  while (true) {
    for (let i = 0; i < perTick; i++) {
      const free = ns.getServerMaxRam("home") - ns.getServerUsedRam("home");
      const sec = ns.getServerSecurityLevel(t) - ns.getServerMinSecurityLevel(t);
      const m = ns.getServerMoneyAvailable(t) / ns.getServerMaxMoney(t);
      const s = sec > 1 ? "w.js" : m < 0.75 ? "g.js" : "h.js";
      const th = Math.min(Math.floor(free / 1.75), maxPer);
      if (th <= 0) break;
      ns.exec(s, "home", { threads: th }, t, Math.random());
    }
    await ns.sleep(200);
  }
}`;
const worker = (op) => `export async function main(ns) { ${opts["no-log"] ? "ns.disableLog(\"ALL\"); " : ""}await ns.${op}(ns.args[0]); }`;
if (opts.scenario === "batch") {
  engine.setHomeRam(Number(opts.ram));
  engine.writeScript("home", "w.js", worker("weaken"));
  engine.writeScript("home", "g.js", worker("grow"));
  engine.writeScript("home", "h.js", worker("hack"));
}

// --copies N: load test. Gives home enough RAM and runs N copies (distinct files, so N separate modules).
const copies = Number(opts.copies);
if (copies > 1) engine.setHomeRam(2 ** 20);
let pid = 0;
if (opts.load) {
  // the save's own scripts were restarted by Engine.load
} else if (opts.scenario === "batch") {
  engine.writeScript("home", "ctl.js", CONTROLLER);
  pid = engine.runScriptWithArgs("home", "ctl.js", 1, [Number(opts["max-threads"]), Number(opts["per-tick"]), Boolean(opts["no-log"])]);
}
else for (let i = 0; i < copies; i++) {
  pid = engine.runScript("home", i === 0 ? "hack.js" : `hack${i}.js`, HACK_SCRIPT, Number(opts.threads));
  if (!(pid > 0)) throw new Error(`script ${i} failed to start: pid ${pid}`);
}

// --- 6. Drive virtual time ---
t0 = hr();
const report = [];
let nextReport = 3600_000;
while (clock.now - START < virtualMs) {
  await clock.tickAsync(stepMs);
  if (clock.now - START >= nextReport) {
    report.push({ vh: nextReport / 3600_000, wallMs: Math.round(hr() - t0), ...engine.summary() });
    nextReport += 3600_000;
  }
}
const runMs = hr() - t0;

const hash = hashOf(engine.stateDump());
const logs = engine.scriptLogs(pid);
if (opts["save-out"]) writeFileSync(opts["save-out"], await engine.saveBytes());

if (!opts.quiet) {
  for (const r of report) console.log(JSON.stringify(r));
  console.log("last script log lines:", logs.slice(-3));
  console.log(JSON.stringify(engine.listScripts().slice(0, 6), null, 1));
}
console.log(
  JSON.stringify({
    seed,
    virtualHours: virtualMs / 3600_000,
    stepMs,
    loadMs: Math.round(loadMs),
    bootMs: Math.round(bootMs),
    runMs: Math.round(runMs),
    speedup: Math.round(virtualMs / runMs),
    final: engine.summary(),
    peakScripts: Math.max(...report.map((r) => r.scripts), 0),
    heapMB: Math.round(process.memoryUsage().heapUsed / 1e6),
    bootSummary: opts.load ? bootSummary : undefined,
    bootHash,
    stateHash: hash,
  }),
);
clock.uninstall();
process.exit(0);
