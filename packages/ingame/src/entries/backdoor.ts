// agent/<deploymentId>/backdoor.js: a home worker that installs a backdoor through the game's terminal (#162), a `ui`
// effector: there's no API for it before Singularity. Arguments: the server, and when to give up (the game's
// `Date.now()`), so it ends within its Agent's round.
// - The game first: installed, with the terminal not left on the server, is done without touching the page. Refused
//   as the terminal's `backdoor` would refuse it (the player's own, no root, the skill short) or with no way there:
//   not done, with why, and nothing typed.
// - The Terminal page; nothing typed while the terminal is busy (its input disabled) or holds the owner's line.
// - `home` unless the terminal is there, `connect` along the way from home (each hop checked), then `backdoor`
//   (../page/terminal-backdoor.ts, shared with the destroy's worker, #177). Its action takes hacking time / 4
//   (`Terminal/Terminal.ts:233-243`) and disables the input until it ends: within the round, the worker waits and
//   types `home`; longer, the backdoor goes on alone ("installing … s left", reported at once), and the try that finds
//   it installed with the terminal still on the server types `home`. So the terminal ends home.
// RAM: `getServer` 2.0 + `scan` 0.2 + `serverExists` 0.1 + `getHackingLevel` and `getHackTime` 0.05 each
// (ram-budget.json); the page costs nothing.
import type { NS } from "../ns.ts";
import type { GamePage } from "../page/game-page.ts";
import { reportPageEffect } from "../page/page-effect.ts";
import { typeBackdoor } from "../page/terminal-backdoor.ts";
import { backdoorStanding, installingProblem } from "../workers/backdoor-standing.ts";
import { reportToAgent } from "../workers/report-to-agent.ts";

async function backdoorThroughTerminal(
  ns: NS,
  gamePage: GamePage,
  hostname: string,
  deadlineMs: number,
): Promise<string | null> {
  const opened = await gamePage.openSidebarPage("Terminal");
  if (opened !== null) return opened;
  const standing = backdoorStanding(ns, hostname);
  // Installed on an earlier try, the terminal still on the server: home.
  if (standing.installed) return gamePage.runTerminalCommand("home");
  if (standing.route === null) return standing.problem;
  const typed = await typeBackdoor(ns, gamePage, hostname, standing.route);
  if ("problem" in typed) return typed.problem;
  const { endsAtMs } = typed;
  const installed = () => ns.getServer(hostname).backdoorInstalled === true;
  // One that won't end within the round goes on alone: the round's time is the other intents'.
  if (endsAtMs >= deadlineMs) return installingProblem(hostname, endsAtMs - Date.now());
  while (gamePage.terminalBusy() === true && !gamePage.stepsTimeUp()) await gamePage.waitARender();
  if (gamePage.terminalBusy() === true) return installingProblem(hostname, endsAtMs - Date.now());
  if (!installed()) return `the terminal didn't install the backdoor on ${hostname}`;
  return gamePage.runTerminalCommand("home");
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const hostname = String(ns.args[0] ?? "");
  const deadlineMs = Number(ns.args[1] ?? 0);
  const standing = backdoorStanding(ns, hostname);
  if (!standing.installed && standing.route === null) {
    reportToAgent(ns, { done: false, problem: standing.problem });
    return;
  }
  await reportPageEffect(ns, deadlineMs, {
    isDone: () => {
      const now = backdoorStanding(ns, hostname);
      return now.installed && !now.terminalThere;
    },
    doing: "type the backdoor into",
    steps: (gamePage) => backdoorThroughTerminal(ns, gamePage, hostname, deadlineMs),
    notDoneAfter: `no backdoor on ${hostname}, or the terminal still on it`,
  });
}
