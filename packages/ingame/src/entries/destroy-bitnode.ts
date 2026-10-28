// agent/<deploymentId>/destroy-bitnode.js: a home worker that destroys the BitNode through the game's page (#177), the
// `ui` backend's destroy, and arms the restart after it (architecture §5.7). Arguments: the BitNode to enter, the
// script to start after it (`agent/boot.js`), and when to give up (the game's `Date.now()`).
// - w0r1d_d43m0n's preconditions first, in core's words (`worldDaemonProblem`), before the page is touched.
// - At the BitVerse already (the next BitNode's portal on the page: a load while w0r1d_d43m0n is backdoored, the
//   fallback's reload say), only the timer, armed at the portal (../page/destroy-page.ts): nothing typed.
// - Otherwise the Terminal page, the timer armed, then `home`, a `connect` per hop and `backdoor`
//   (../page/terminal-backdoor.ts, #162's). The backdoor (about 3 s at the required level) outlives the worker's round:
//   it reports the backdoor under way and leaves the timer armed. Its end reaches the BitVerse, which kills every
//   script, this one and the Agent too; the timer does the rest. Nothing typed, or the backdoor not started: the timer
//   is disarmed, and the worker says why.
// - Never done by the game's state: another destroy can always follow (#175). The brain sees it by the reset.
// - Around those steps, `reportPageEffect` (../page/page-effect.ts): never over an owner's dialog. The page is left
//   where the steps left it: the BitVerse has no sidebar to go back by.
// RAM: `getServer` 2.0 + `scan` 0.2 + `serverExists`, `getServerRequiredHackingLevel` 0.1 each + `hasRootAccess`,
// `getHackingLevel`, `getHackTime` 0.05 each (ram-budget.json); the page costs nothing.
import { WORLD_DAEMON, worldDaemonProblem } from "@bitburner-agent/core";
import type { NS } from "../ns.ts";
import { armRestartAfterDestroy, DESTROY_STEP_LIMITS_MS, portalXpath } from "../page/destroy-page.ts";
import { type GamePage, pageDocument } from "../page/game-page.ts";
import { reportPageEffect } from "../page/page-effect.ts";
import { typeBackdoor } from "../page/terminal-backdoor.ts";
import { backdoorStanding } from "../workers/backdoor-standing.ts";
import { reportToAgent } from "../workers/report-to-agent.ts";
import { worldDaemonStanding } from "../workers/world-daemon-standing.ts";

async function destroyThroughThePage(
  ns: NS,
  gamePage: GamePage,
  nextBitNode: number,
  bootScript: string,
): Promise<string> {
  const page = pageDocument();
  if (page === null) return "no game page to restart from after the destroy";
  const entering = `entering BitNode ${nextBitNode} from the BitVerse`;
  if (gamePage.findElementNow(portalXpath(nextBitNode)) !== null) {
    // The timer's click enters the BitNode, which kills this worker and the Agent.
    armRestartAfterDestroy(page, bootScript, nextBitNode, DESTROY_STEP_LIMITS_MS.enter);
    return entering;
  }
  const opened = await gamePage.openSidebarPage("Terminal");
  if (opened !== null) return opened;
  const standing = backdoorStanding(ns, WORLD_DAEMON);
  if (standing.installed) return `${WORLD_DAEMON} is backdoored, but the game isn't at the BitVerse`;
  if (standing.route === null) return standing.problem;
  // A backdoor under way (an earlier try's): its own timer waits for it.
  if (gamePage.terminalBusy() === true) return "terminal busy";
  const backdoorMs = ns.getHackTime(WORLD_DAEMON) / 4;
  // Armed before the backdoor is typed: its end kills this worker.
  const restart = armRestartAfterDestroy(page, bootScript, nextBitNode, backdoorMs + DESTROY_STEP_LIMITS_MS.bitVerse);
  const typed = await typeBackdoor(ns, gamePage, WORLD_DAEMON, standing.route);
  if ("problem" in typed) {
    restart.disarm();
    return typed.problem;
  }
  const secondsLeft = Math.max(1, Math.ceil((typed.endsAtMs - Date.now()) / 1000));
  return `backdooring ${WORLD_DAEMON}: about ${secondsLeft} s left, then ${entering}`;
}

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
    steps: (gamePage) => destroyThroughThePage(ns, gamePage, nextBitNode, bootScript),
    // Never reported: the steps always say what happened.
    notDoneAfter: "the destroy's steps went through, yet the game isn't in the next BitNode",
    ending: "steps",
  });
}
