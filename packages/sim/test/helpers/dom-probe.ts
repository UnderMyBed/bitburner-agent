// Runs in a child process: installs the DOM, then reports how window relates to the globals.
import { installDom } from "../../src/host/dom.ts";

const dom = installDom();
const g = globalThis as unknown as Record<string, unknown>;
const w = dom.window as unknown as Record<string, unknown>;

// Replace the globals, as a virtual clock does after installDom.
const fakeSetTimeout = (() => 0) as unknown as typeof setTimeout;
let rafScheduled = false;
g.setTimeout = ((fn: () => void) => {
  rafScheduled = typeof fn === "function";
  return 0;
}) as unknown as typeof setTimeout;
(w.requestAnimationFrame as (cb: () => void) => void)(() => {});
const rafUsesGlobalSetTimeout = rafScheduled;
g.setTimeout = fakeSetTimeout;
g.Date = class FakeDate {};
g.performance = { now: () => 42 };

const storage = w.localStorage as { constructor: { name: string } } | undefined;
const sheet = w.CSSStyleSheet as { prototype: { replaceSync: (s: string) => unknown } };

process.stdout.write(
  JSON.stringify({
    windowTimersFollowGlobals: w.setTimeout === fakeSetTimeout,
    windowDateFollowsGlobal: w.Date === g.Date,
    windowPerformanceFollowsGlobal: w.performance === g.performance,
    rafUsesGlobalSetTimeout,
    hasRootElement: dom.window.document.getElementById("root") !== null,
    userAgent: navigator.userAgent,
    localStorageIsJsdom: g.localStorage === w.localStorage && storage?.constructor.name === "Storage",
    adoptedStyleSheets: Array.isArray((dom.window.document as unknown as Record<string, unknown>).adoptedStyleSheets),
    replaceSyncIsNoop: sheet.prototype.replaceSync.call({}, "") === undefined,
  }),
);
process.exit(0);
