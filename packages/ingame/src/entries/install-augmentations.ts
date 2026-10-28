// agent/<deploymentId>/install-augmentations.js: a home worker that installs the queued augmentations through the
// game's page (#167), the `ui` backend's install, and arms the restart after it (architecture §5.7). Arguments: the
// script to start after the reset (`agent/boot.js`), and when to give up (the game's `Date.now()`).
// - The steps and the restart timer are in ../page/install-page.ts: the game first (nothing left to install is done),
//   the timer armed, then Install and its confirmation. The install kills this script; the timer starts `boot.js`.
// - Around those steps, `reportPageEffect` (../page/page-effect.ts): never over an owner's dialog, back to the
//   Terminal.
// RAM: nothing beyond the base (ram-budget.json); the page costs nothing.
import type { NS } from "../ns.ts";
import { installOnPage } from "../page/install-page.ts";
import { reportPageEffect } from "../page/page-effect.ts";

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const bootScript = String(ns.args[0] ?? "");
  const deadlineMs = Number(ns.args[1] ?? 0);
  const nothingToInstall = { seen: false };
  await reportPageEffect(ns, deadlineMs, {
    isDone: () => nothingToInstall.seen,
    doing: "install through",
    steps: (gamePage) => installOnPage(gamePage, bootScript, nothingToInstall),
    notDoneAfter: "augmentations are still queued after installing them",
  });
}
