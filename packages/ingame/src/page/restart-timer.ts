// The restart after a reset through the page (#167, #177, architecture §5.7, Q5): a page timer that outlives the
// scripts the reset kills, and starts `agent/boot.js` again. An install's worker (./install-page.ts) and a destroy's
// (./destroy-page.ts) arm it before the action that kills them, with their own first steps; the rest is shared.
// Singularity's reset has the game do it (`NetscriptFunctions/Singularity.ts:210`, the same kind of timer).
// - Scripts run in the page's own realm, and killing one clears only its own delay
//   (`Netscript/killWorkerScript.ts:68-70`), so this timer keeps running once the worker is dead.
// - It never calls `ns`: after the kill every `ns` call throws (`Netscript/NetscriptHelpers.tsx:399-403`). Only the
//   page's DOM and React's props, as the `ui` workers drive them (./game-page.ts), and the page's own timers.
// - The steps, each with its own time limit, polled every 100 ms of the page's time:
//   1. The caller's (the install's alert; the BitVerse's portal). Each says what its time running out means: go on;
//      the fallback; stop, the reset never having happened; or give up, the reset done but no way to reload from that
//      page (the BitVerse and BitNode 6's cinematic have no sidebar: `ui/GameRoot.tsx:314-327`), leaving it to the
//      brain's supervisor (§10.2) or the owner. A throw in such a step ends it the same way: never a fallback that could
//      kill a live Agent.
//   2. The terminal, there, enabled and empty (`Terminal/ui/TerminalInput.tsx:438-468`): `run /agent/boot.js` typed
//      (`onChange`), absolute because a reset leaves the terminal's directory as the owner's `cd` left it (an install,
//      `Prestige.ts:108-113`; a destroy, `:214-219`); then, once the input has rendered it (React's `value` prop),
//      Enter (`onKeyDown`, which runs the line its last render saw).
//   3. A new echo of the line, and the line after it: "Running script with 1 thread, pid N and args: []."
//      (`Terminal/commands/runScript.ts:79-83`). `boot.js` starts the Agent, which connects to the brain afresh.
//   4. Otherwise the fallback: the sidebar's Options, then "Force kill all active scripts"
//      (`GameOptions/ui/GameOptionsSidebar.tsx:243-245`), the game's own save-then-reload
//      (`ui/GameRoot.tsx:220-232`), so autoexec starts `boot.js` on the load. The unload prompt (`index.tsx:53-58`,
//      never on Steam's `file://`) is cleared first, or the reload could be stopped. A page loaded with `?noScripts`
//      (Steam's "Reload && Kill All Scripts") keeps it, and autoexec skips (`NetscriptWorker.ts:233-236`): then, as
//      when nothing here works, the brain's supervisor relaunches the silent game (§10.2).
//   Anything else that throws on the way goes to the fallback; anything that throws there ends it.
import { findOnPage, playerEvent, reactPropsOf, sidebarItemXpath } from "./game-page.ts";

/** How often the timer looks at the page. */
const POLL_MS = 100;
/** The longest each shared step waits: for the terminal, the run's line, and the fallback's button. */
export const SHARED_STEP_LIMITS_MS = { terminal: 10_000, started: 5_000, fallback: 10_000 } as const;
/** What `run` prints once the script has started (`Terminal/commands/runScript.ts:79-83`). */
const RUN_STARTED = /^Running script with 1 thread, pid \d+ and args: \[\]\.$/;
const FORCE_KILL_XPATH = "//button[normalize-space()='Force kill all active scripts']";

/**
 * What a caller's step running out of time means: go on to the next step anyway; the fallback (the reset happened, so
 * the scripts are dead); stop (it never happened: the scripts live, so there's nothing to restart); or give up (it
 * happened, but this page has no way to the fallback). With the reason.
 */
export type StepEnd = { action: "next" } | { action: "fallback" | "stop" | "giveUp"; reason: string };

/** One of the caller's steps before the terminal. */
export interface StepBeforeTheTerminal {
  limitMs: number;
  /** One look at the page: whether to go on to the next step. */
  look(): boolean;
  /** Its time up, or a throw in it: what then, read from the page at that moment if it's a function. */
  late: StepEnd | (() => StepEnd);
}

/**
 * How the restart went: still going, disarmed or stopped (nothing reset), the script started, the fallback's reload, or
 * neither (given up).
 */
type RestartOutcome = "waiting" | "disarmed" | "stopped" | "started" | "reloading" | "gaveUp";

/** Calls `element`'s React handler `name` with `event`; false if it has none. Its promise, if any, is left to run. */
export function callHandler(element: Element, name: string, event: unknown): boolean {
  const handler = reactPropsOf(element)?.[name];
  if (typeof handler !== "function") return false;
  void Promise.resolve(handler(event)).catch(() => {});
  return true;
}

/**
 * Arms the restart on `page`: from now, the timer takes `before`'s steps in turn, then starts `bootScript` from the
 * terminal, or reloads. `disarm` stops it: the worker that armed it calls it when it's still alive after the action
 * that would have killed it, or when that action was never set off (the destroy's, #177).
 */
export function armRestart(page: Document, bootScript: string, before: StepBeforeTheTerminal[]) {
  const command = `run /${bootScript}`;
  /** The index in `before` while there, then the shared steps. */
  let step: number | "terminal" | "enter" | "started" | "fallback" = before.length > 0 ? 0 : "terminal";
  let outcome: RestartOutcome = "waiting";
  /** Why the fallback was taken, or why it stopped, or null. */
  let reason: string | null = null;
  let stepEndsMs = Date.now() + (before[0]?.limitMs ?? SHARED_STEP_LIMITS_MS.terminal);
  let optionsOpened = false;
  /** The echoes of the line already in the terminal when Enter was sent: only a new one is this run's. */
  let echoesBefore = 0;

  const find = (xpath: string) => findOnPage(page, xpath);
  const terminalInput = () => page.querySelector("#terminal-input") as HTMLInputElement | null;
  const terminalLines = () =>
    [...page.querySelectorAll("#terminal > li")].map((line) => (line.textContent ?? "").trim());
  const isEcho = (line: string) => line.endsWith(`> ${command}`);
  const startStep = (next: typeof step, limitMs: number) => {
    step = next;
    stepEndsMs = Date.now() + limitMs;
  };
  const fallBack = (why: string) => {
    reason = why;
    startStep("fallback", SHARED_STEP_LIMITS_MS.fallback);
  };
  /** What the caller's step at `index` running out (or throwing) means now. */
  const endOf = (index: number): StepEnd => {
    const { late } = before[index] as StepBeforeTheTerminal;
    return typeof late === "function" ? late() : late;
  };
  /** After the caller's step at `index`: its next, or the terminal. */
  const afterStep = (index: number) => {
    const next = before[index + 1];
    if (next) startStep(index + 1, next.limitMs);
    else startStep("terminal", SHARED_STEP_LIMITS_MS.terminal);
  };

  /** One look at the page; whether to look again. */
  function look(): boolean {
    const late = Date.now() >= stepEndsMs;
    if (typeof step === "number") {
      const index = step;
      const caller = before[index] as StepBeforeTheTerminal;
      if (caller.look()) {
        afterStep(index);
      } else if (late) {
        const end = endOf(index);
        if (end.action === "next") {
          afterStep(index);
        } else if (end.action === "fallback") {
          fallBack(end.reason);
        } else {
          reason = end.reason;
          outcome = end.action === "stop" ? "stopped" : "gaveUp";
          return false;
        }
      }
      return true;
    }
    switch (step) {
      case "terminal": {
        const input = terminalInput();
        // A line in it is the owner's: never typed over.
        if (input !== null && !input.disabled && input.value === "") {
          input.value = command;
          if (callHandler(input, "onChange", { target: input })) startStep("enter", SHARED_STEP_LIMITS_MS.terminal);
        } else if (late) {
          fallBack(input === null ? "no terminal" : "the terminal didn't take the line");
        }
        return true;
      }
      case "enter": {
        // Enter runs the line the input's last render saw: only once React has rendered it (its `value` prop).
        const input = terminalInput();
        if (input !== null && reactPropsOf(input)?.value === command) {
          echoesBefore = terminalLines().filter(isEcho).length;
          if (callHandler(input, "onKeyDown", playerEvent({ key: "Enter" }))) {
            startStep("started", SHARED_STEP_LIMITS_MS.started);
          }
        } else if (late) {
          fallBack("the terminal didn't take the line");
        }
        return true;
      }
      case "started": {
        const lines = terminalLines();
        const echoes = lines.flatMap((line, index) => (isEcho(line) ? [index] : []));
        const echoAt = echoes.length > echoesBefore ? (echoes.at(-1) as number) : -1;
        const result = echoAt === -1 ? undefined : lines[echoAt + 1];
        if (result !== undefined && RUN_STARTED.test(result)) {
          outcome = "started";
          return false;
        }
        if (result !== undefined) fallBack(`the terminal said: ${result}`);
        else if (late) fallBack("the terminal didn't say it ran");
        return true;
      }
      case "fallback": {
        const forceKill = find(FORCE_KILL_XPATH);
        if (forceKill !== null) {
          // The production build asks before unloading, except on `file://` (Steam): asked, the reload could stop.
          const view = page.defaultView as { onbeforeunload: unknown } | null;
          if (view !== null) view.onbeforeunload = null;
          outcome = callHandler(forceKill, "onClick", playerEvent()) ? "reloading" : "gaveUp";
          return false;
        }
        if (!optionsOpened) {
          const options = find(sidebarItemXpath("Options"));
          if (options !== null) optionsOpened = callHandler(options, "onClick", playerEvent());
        }
        if (late) {
          outcome = "gaveUp";
          return false;
        }
        return true;
      }
    }
  }

  const tick = () => {
    if (outcome !== "waiting") return;
    let again: boolean;
    try {
      again = look();
    } catch (error) {
      const threw = `the page threw: ${error instanceof Error ? error.message : String(error)}`;
      // A page that isn't as expected: the fallback, unless that's what threw, or the step says stop or give up.
      if (step === "fallback") {
        outcome = "gaveUp";
        return;
      }
      const end = typeof step === "number" ? endOf(step) : null;
      if (end !== null && (end.action === "stop" || end.action === "giveUp")) {
        reason = threw;
        outcome = end.action === "stop" ? "stopped" : "gaveUp";
        return;
      }
      fallBack(threw);
      again = true;
    }
    if (again) setTimeout(tick, POLL_MS);
  };
  setTimeout(tick, POLL_MS);

  return {
    /** Stops the timer: nothing was reset. */
    disarm(): void {
      if (outcome === "waiting") outcome = "disarmed";
    },
    /** How it went, and why it fell back or stopped, if it did. */
    state: () => ({ outcome, fallbackReason: reason }),
  };
}
