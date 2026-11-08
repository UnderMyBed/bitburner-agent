// Closing the game through its page (#303, the stop at the BitNode's end), for `close-game.js`: the game's own Save
// Game first, then its window closed, as the player's X does.
// - The save: the Options page's "Save Game" (`GameOptions/ui/GameOptionsSidebar.tsx:147-149`), whose handler is
//   `saveObject.saveGame()` (`ui/GameRoot.tsx:440-446`). That writes the save, hands it to Steam's side
//   (`pushGameSaved`), and only then shows "Game Saved!" (`SaveObject.ts:235-262`): that toast, one not showing before
//   the click, confirms it. A save that fails shows a dialog instead, and no toast. With no toast in time, the window
//   is left open: a close never goes without its save.
// - The close: `window.close()`. On Steam, Electron's window `close` handler flushes its pending disk and Steam Cloud
//   saves, loads exit.html and destroys the window within 200 ms, and the last window closed quits the app
//   (`electron/main.js:43-78`, `:16-20`), as the X does. The page's "Your work will be lost" prompt is off on
//   `file://` (`index.tsx:53-57`), Steam's case. A browser closes only a window its scripts opened, so in one (E2) the
//   window stays, and the worker says so: alive after the close, it wasn't closed.
import { CLOSE_GAME_WINDOW_STAYED_OPEN } from "@bitburner-agent/core";
import { type GamePage, hasClass, pageDocument } from "./game-page.ts";

/** The Options page's own save (`GameOptions/ui/GameOptionsSidebar.tsx:147-149`). */
export const SAVE_GAME_XPATH = "//button[normalize-space()='Save Game']";
/** The save's toast (`SaveObject.ts:261`), its text in an Alert's message (`ui/React/Snackbar.tsx:47`). */
export const GAME_SAVED_XPATH = `//div[${hasClass("MuiAlert-message")} and normalize-space()='Game Saved!']`;
/** The worker alive after the close: the window stayed open (core's, as the brain reads it). */
export const WINDOW_STAYED_OPEN = CLOSE_GAME_WINDOW_STAYED_OPEN;
export const SAVE_NOT_CONFIRMED = 'the game\'s save not confirmed ("Game Saved!" not shown in time), so not closed';

/** Closes the game's window: the page's own `window.close()`. */
export function closeGameWindow(page: Document | null = pageDocument()): void {
  page?.defaultView?.close();
}

/**
 * The steps on the page (see above): the save, confirmed, then `closeWindow`. Their problem; once the window closes,
 * nothing returns (the worker dies with the page).
 */
export async function closeGameOnPage(gamePage: GamePage, closeWindow: () => void): Promise<string | null> {
  const opened = await gamePage.openSidebarPage("Options");
  if (opened !== null) return opened;
  // A toast showing before the click is an earlier save's (an autosave's): not this one's.
  const before = new Set(gamePage.findAllNow(GAME_SAVED_XPATH));
  const clicked = await gamePage.clickWhenThere(SAVE_GAME_XPATH, '"Save Game" on the Options page');
  if (clicked !== null) return clicked;
  while (!gamePage.findAllNow(GAME_SAVED_XPATH).some((toast) => !before.has(toast))) {
    if (gamePage.stepsTimeUp()) return SAVE_NOT_CONFIRMED;
    await gamePage.waitARender();
  }
  closeWindow();
  // Steam's window is gone within 200 ms (`electron/main.js:69-77`), and the worker with it.
  while (!gamePage.stepsTimeUp()) await gamePage.waitARender();
  return WINDOW_STAYED_OPEN;
}
