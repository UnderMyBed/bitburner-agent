// Uncaught errors, as a browser handles them. A browser reports an error nobody caught as an event on `window`:
// `unhandledrejection` for a rejected promise, `error` for an exception (in a timer callback, a microtask, an event
// listener). It logs the error if no listener handled it, and carries on. Node would end the process instead. The game
// relies on the browser's way: its `unhandledrejection` listener ignores the ScriptDeath that a killed script's
// pending promises reject with (UncaughtPromiseHandler.ts, utils/ErrorHandler.ts).
import { writeSync } from "node:fs";
import { format } from "node:util";
import { withoutMachinePaths } from "../paths.ts";

/**
 * Also written to stderr (it shows in the output tail if the process dies), unless it is a killed script's ScriptDeath,
 * which is routine. The game handles every rejection itself, so a host bug's rejection would otherwise look like a game
 * error.
 */
function toStderr(kind: string, error: unknown): void {
  if ((error as { constructor?: { name?: string } } | null)?.constructor?.name === "ScriptDeath") return;
  writeSync(2, `${kind}: ${withoutMachinePaths(format(error))}\n`);
}

/** Raises an unhandled rejection or an uncaught exception as the browser does. Call once, before the engine loads. */
export function installUncaughtErrors(): void {
  process.on("unhandledRejection", (reason, promise) => {
    toStderr("unhandled rejection", reason);
    // jsdom has no PromiseRejectionEvent; the game's listener reads only `reason`.
    const event = new window.Event("unhandledrejection", { cancelable: true });
    Object.defineProperties(event, { reason: { value: reason }, promise: { value: promise } });
    window.dispatchEvent(event);
    if (!event.defaultPrevented) console.error("Uncaught (in promise)", reason);
  });
  // Exceptions from microtasks and event listeners; the virtual clock reports timer callbacks' itself.
  process.on("uncaughtException", reportUncaughtException);
}

/** Reports an exception nobody caught, as the browser does. */
export function reportUncaughtException(error: unknown): void {
  toStderr("uncaught exception", error);
  const message = error instanceof Error ? error.message : String(error);
  const event = new window.ErrorEvent("error", { cancelable: true, error, message });
  window.dispatchEvent(event);
  if (!event.defaultPrevented) console.error("Uncaught", error);
}

/**
 * Stack traces name this machine's files, and the game saves some (its crash reports, exceptionAlert.tsx). So every
 * stack names repository files as `<repo>/…`, the same on every machine. The format is V8's own, with Node's error code
 * kept in the first line (`RangeError [ERR_OUT_OF_RANGE]: …`). V8 formats a stack when it's first read, so this covers
 * every stack read after it is installed.
 */
export function installMachineIndependentStacks(): void {
  Error.prepareStackTrace = (error, frames) => {
    let header: string;
    try {
      header = Error.prototype.toString.call(error);
      const { code, name } = error as { code?: unknown; name?: unknown };
      if (typeof code === "string" && typeof name === "string" && header.startsWith(name)) {
        header = `${name} [${code}]${header.slice(name.length)}`;
      }
    } catch {
      header = "Error";
    }
    return withoutMachinePaths(header + frames.map((frame) => `\n    at ${frame}`).join(""));
  };
}
