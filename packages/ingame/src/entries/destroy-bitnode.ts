// agent/<deploymentId>/destroy-bitnode.js: a home worker that destroys the BitNode through the game's page (#177), the
// `ui` backend's destroy, and arms the restart after it (architecture §5.7). Arguments: the BitNode to enter, the
// script to start after it (`agent/boot.js`), and when to give up (the game's `Date.now()`).
// - w0r1d_d43m0n's preconditions first, in core's words (`worldDaemonProblem`), before the page is touched.
// - Then the steps in ../page/destroy-page.ts (`destroyOnPage`): at the BitVerse already (a load there), only the
//   timer, armed at the portal; otherwise the Terminal page, the timer armed, then `home`, a `connect` per hop and
//   `backdoor` (../page/terminal-backdoor.ts, #162's). The backdoor (about 3 s at the required level) outlives the
//   worker's round: it reports the backdoor under way and leaves the timer armed. Its end reaches the BitVerse, which
//   kills every script, this one and the Agent too; the timer does the rest. A problem before `backdoor` is entered
//   disarms the timer; one after it leaves the timer armed, and it stops if the BitVerse never shows.
// - Never done by the game's state: another destroy can always follow (#175). The brain sees it by the reset.
// - Around those steps, `reportPageEffect` (../page/page-effect.ts): never over an owner's dialog. The page is left
//   where the steps left it: the BitVerse has no sidebar to go back by.
// RAM: `getServer` 2.0 + `scan` 0.2 + `serverExists`, `getServerRequiredHackingLevel` 0.1 each + `hasRootAccess`,
// `getHackingLevel`, `getHackTime` 0.05 each (ram-budget.json); the page costs nothing.
import { worldDaemonProblem } from "@bitburner-agent/core";
import type { NS } from "../ns.ts";
import { destroyOnPage } from "../page/destroy-page.ts";
import { reportPageEffect } from "../page/page-effect.ts";
import { reportToAgent } from "../workers/report-to-agent.ts";
import { worldDaemonStanding } from "../workers/world-daemon-standing.ts";
export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const nextBitNode = Number(ns.args[0] ?? 0);
  const bootScript = String(ns.args[1] ?? "");
  const deadlineMs = Number(ns.args[2] ?? 0);
  const problem = worldDaemonProblem(worldDaemonStanding(ns));
  if (problem !== null) {
    reportToAgent(ns, { done: false, problem });
    return;
  }
  await reportPageEffect(ns, deadlineMs, {
    isDone: () => false,
    doing: "destroy the BitNode through",
    steps: (gamePage) => destroyOnPage(ns, gamePage, nextBitNode, bootScript),
    // Never reported: the steps always say what happened.
    notDoneAfter: "the destroy's steps went through, yet the game isn't in the next BitNode",
    ending: "steps",
  });
}
