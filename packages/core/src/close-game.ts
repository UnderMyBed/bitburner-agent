/**
 * Closing the game (#303, the stop at the BitNode's end): the game's own Save Game, then its window closed from the
 * page, as the player's X does. Shared by the in-game code and the brain. The constants are plain literals, as in
 * deploy-layout.ts.
 */

/** Home worker: saves the game, then closes its window, through the game's page. */
export const CLOSE_GAME_WORKER_NAME = "close-game.js";

/** The close worker's problem when it's still alive after `window.close()`: the window stayed open. */
export const CLOSE_GAME_WINDOW_STAYED_OPEN =
  "window.close() left the game's window open (a browser closes only the windows its scripts opened)";
