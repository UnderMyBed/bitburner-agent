// What every `ui` effector's worker does around its own steps (#136, #138, #141, #147, #149): the game first, then the
// page, never over a dialog the dialog watcher leaves for the owner (#143), back to the Terminal however the steps
// went, and the game again, reported to the Agent.
import type { EffectorReport } from "@bitburner-agent/core";
import type { NS } from "../ns.ts";
import { reportToAgent } from "../workers/report-to-agent.ts";
import { type GamePage, openGamePage } from "./game-page.ts";

export async function reportPageEffect(
  ns: NS,
  deadlineMs: number,
  {
    isDone,
    doing,
    steps,
    notDoneAfter,
  }: {
    /** Whether the game shows it done: checked first, and again after the steps. */
    isDone: () => boolean;
    /** What it does, for "no game page to …": "buy it through". */
    doing: string;
    /** The worker's own steps on the page: their problem, or null. */
    steps: (gamePage: GamePage) => Promise<string | null>;
    /** The problem when the steps went through but the game doesn't show it done. */
    notDoneAfter: string;
  },
): Promise<void> {
  const report: EffectorReport = { done: isDone(), problem: null };
  if (!report.done) {
    const gamePage = openGamePage(ns, deadlineMs);
    if (gamePage === null) {
      report.problem = `no game page to ${doing}`;
    } else if (await gamePage.dialogStaysOpen()) {
      report.problem = "a dialog the Agent leaves for the owner is open";
    } else {
      const problem = await steps(gamePage);
      // Back to the Terminal, however it went, in the time kept for it: the page was moved.
      const backProblem = await gamePage.returnToTerminal();
      report.problem = problem ?? backProblem;
      report.done = isDone();
      if (!report.done) report.problem ??= notDoneAfter;
    }
  }
  reportToAgent(ns, report);
}
