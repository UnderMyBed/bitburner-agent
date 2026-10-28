// What a load that never showed the terminal looks like (#120), from the page's visible text, as the failure's report
// says it. vendor/bitburner-src/src/ui/LoadingScreen.tsx:29-47 loads through promises (initSwc(), then the save, then
// Engine.load) under "Loading Bitburner v…"; its "If the game fails to load" hint comes from a 2 s setTimeout, which a
// paused clock never fires. A load that throws shows vendor/bitburner-src/src/ui/React/RecoveryRoot.tsx:170's
// "RECOVERY MODE ACTIVATED".

/** The loading screen's title (LoadingScreen.tsx:58) and its 2 s hint (:63). */
const LOADING_TITLE = "Loading Bitburner";
const LOADING_HINT = "If the game fails to load";
const RECOVERY_TITLE = "RECOVERY MODE ACTIVATED";
/** What stands for the page's text when it can't be read. */
const UNREADABLE_PREFIX = "(unreadable";

export type LoadState =
  | "loadingScreen"
  | "loadingScreenAfterHint"
  | "recoveryMode"
  | "hung"
  | "crashedOrClosed"
  | "empty"
  | "other";

export interface LoadDiagnosis {
  state: LoadState;
  /** One line saying what the page looks like, and what that points to. */
  text: string;
}

/**
 * The states a fixture's load is tried again from (#120): a load still under way, or a page the game never rendered.
 * Recovery mode, a hung page and a crashed or closed one are faults to see at once, not to retry past.
 */
export const RETRIED_LOAD_STATES: ReadonlySet<LoadState> = new Set([
  "loadingScreen",
  "loadingScreenAfterHint",
  "empty",
]);

/** What stands for the page's text when reading it failed with `error`: why tells a hung page from a closed one. */
export function unreadableText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${UNREADABLE_PREFIX}: ${message.split("\n")[0]})`;
}

export function diagnoseLoad(visibleText: string): LoadDiagnosis {
  if (visibleText.startsWith(UNREADABLE_PREFIX)) {
    // Playwright's "Timeout 1000ms exceeded": the page is there, but its main thread never answered.
    return visibleText.includes("Timeout")
      ? {
          state: "hung",
          text: "the page is hung: its text couldn't be read within 1 s (its main thread never answered)",
        }
      : { state: "crashedOrClosed", text: "the page couldn't be read: it crashed or closed" };
  }
  if (visibleText.includes(RECOVERY_TITLE)) {
    return { state: "recoveryMode", text: "recovery mode: the load threw (its error is in the console errors)" };
  }
  if (visibleText.includes(LOADING_TITLE)) {
    return visibleText.includes(LOADING_HINT)
      ? {
          state: "loadingScreenAfterHint",
          text: "stuck on the loading screen, after its 2 s hint: game time moved on, but the load didn't finish",
        }
      : {
          state: "loadingScreen",
          text:
            "stuck on the loading screen, before its 2 s hint: a load step waiting on a timer, requestAnimationFrame " +
            "or real-time work (the clock may be paused), or on a pending request",
        };
  }
  if (visibleText.trim() === "") {
    return { state: "empty", text: "an empty page: the game's bundle never rendered (see the errors and requests)" };
  }
  return {
    state: "other",
    text: "neither the loading screen nor recovery mode: not the game, or the game on a page with no terminal",
  };
}
