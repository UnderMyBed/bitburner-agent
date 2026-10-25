// Uncaught errors, as a browser handles them. A browser reports an error nobody caught (a rejected promise, an
// exception in a timer callback) as an event on `window`, logs it if no listener handled it, and carries on. Node would
// end the process instead. The game relies on the browser's way: its `unhandledrejection` listener ignores the
// ScriptDeath a killed script's pending promises reject with (UncaughtPromiseHandler.ts, utils/ErrorHandler.ts).
import { withoutMachinePaths } from "../events.ts";

/** Raises a promise rejection nobody handled as the browser does. Call once, before the engine loads. */
export function installUnhandledRejections(): void {
  process.on("unhandledRejection", (reason, promise) => {
    // jsdom has no PromiseRejectionEvent; the game's listener reads only `reason`.
    const event = new window.Event("unhandledrejection", { cancelable: true });
    Object.defineProperties(event, { reason: { value: reason }, promise: { value: promise } });
    window.dispatchEvent(event);
    if (!event.defaultPrevented) console.error("Uncaught (in promise)", reason);
  });
}

/** Reports an exception a timer callback threw, as the browser does (the virtual clock calls this). */
export function reportUncaughtException(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const event = new window.ErrorEvent("error", { cancelable: true, error, message });
  window.dispatchEvent(event);
  if (!event.defaultPrevented) console.error("Uncaught", error);
}

/**
 * Stack traces name this machine's files, and the game saves some (its crash reports, exceptionAlert.tsx). So every
 * stack names repository files relative to `<repo>`, the same on every machine. The format is V8's own.
 */
export function installMachineIndependentStacks(): void {
  Error.prepareStackTrace = (error, frames) => {
    let header: string;
    try {
      header = Error.prototype.toString.call(error);
    } catch {
      header = "Error";
    }
    return withoutMachinePaths(header + frames.map((frame) => `\n    at ${frame}`).join(""));
  };
}
