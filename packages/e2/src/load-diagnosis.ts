// What a load that never showed the terminal looks like (#120), from the page's visible text, as the failure's report
// says it. vendor/bitburner-src/src/ui/LoadingScreen.tsx:29-47 loads through promises (initSwc(), then the save, then
// Engine.load) under "Loading Bitburner v…"; its "If the game fails to load" hint comes from a 2 s setTimeout, which a
// paused clock never fires. A load that throws shows RecoveryRoot.tsx:170's "RECOVERY MODE ACTIVATED".

/** The loading screen's title (LoadingScreen.tsx:58) and its 2 s hint (:63). */
const LOADING_TITLE = "Loading Bitburner";
const LOADING_HINT = "If the game fails to load";
const RECOVERY_TITLE = "RECOVERY MODE ACTIVATED";
/** What `waitForTerminal` reads when the page's text can't be read. */
export const UNREADABLE_PREFIX = "(unreadable";

/** One line saying what the page looks like, and what that points to. */
export function diagnoseLoad(visibleText: string): string {
  if (visibleText.startsWith(UNREADABLE_PREFIX)) return "the page couldn't be read: it crashed or closed";
  if (visibleText.includes(RECOVERY_TITLE)) return "recovery mode: the load threw (its error is in the console errors)";
  if (visibleText.includes(LOADING_TITLE)) {
    return visibleText.includes(LOADING_HINT)
      ? "stuck on the loading screen, after its 2 s hint: game time moved on, but the load didn't finish"
      : "stuck on the loading screen, before its 2 s hint: a load step waiting on a timer, requestAnimationFrame or " +
          "real-time work (the clock may be paused), or on a pending request";
  }
  if (visibleText.trim() === "") return "an empty page: the game's bundle never rendered (see the errors and requests)";
  return "neither the loading screen nor recovery mode: not the game, or the game on a page with no terminal";
}
