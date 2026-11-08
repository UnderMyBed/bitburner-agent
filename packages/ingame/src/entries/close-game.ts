// agent/<deploymentId>/close-game.js: a home worker that saves the game with its own Save Game, then closes its window
// (#303, the stop at the BitNode's end), the `ui` backend's and the only one: Singularity has no call for either.
// Arguments: when to give up (the page's monotonic clock).
// - The steps are in ../page/close-game-page.ts: Options, "Save Game", its "Game Saved!" toast, then `window.close()`.
//   Never done by the game's word: on Steam the close ends the game and this worker; alive after it, the window
//   stayed open, and that's the problem.
// - Around those steps, `reportPageEffect` (../page/page-effect.ts): never over an owner's dialog, back to the
//   Terminal.
// RAM: nothing beyond the base (ram-budget.json); the page costs nothing.
import type { NS } from "../ns.ts";
import { closeGameOnPage, closeGameWindow, WINDOW_STAYED_OPEN } from "../page/close-game-page.ts";
import { reportPageEffect } from "../page/page-effect.ts";

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const deadlineMs = Number(ns.args[0] ?? 0);
  await reportPageEffect(ns, deadlineMs, {
    isDone: () => false,
    doing: "save and close the game through",
    steps: (gamePage) => closeGameOnPage(gamePage, () => closeGameWindow()),
    notDoneAfter: WINDOW_STAYED_OPEN,
  });
}
