// What every `ui` effector's worker does around its own steps (#136, #138, #141, #147, #149, #151): the game first,
// then the page, never over a dialog the dialog watcher leaves for the owner (#143), and the game again, reported to
// the Agent. The page is left as it was found: back to the Terminal, or, if the player was focused on work, focused
// again (owner decision 37). The Work page hides the sidebar (`ui/GameRoot.tsx:330-332`), so a focused player is
// unfocused first ("Do something else simultaneously"), and refocused after with the overview's "Focus".
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
    ending = "restore",
  }: {
    /** Whether the game shows it done: checked first, and again after the steps. */
    isDone: () => boolean;
    /** What it does, for "no game page to …": "buy it through". */
    doing: string;
    /**
     * The worker's own steps on the page: their problem, or null. `wasFocused`: the player was focused on work, and
     * has been unfocused for the steps (the Work page hides the sidebar).
     */
    steps: (gamePage: GamePage, focus: { wasFocused: boolean }) => Promise<string | null>;
    /** The problem when the steps went through but the game doesn't show it done. */
    notDoneAfter: string;
    /**
     * Where the page is left: as found (`"restore"`: the Terminal, or focused again), or where the steps left it
     * (`"steps"`: the work worker, which sets the focus itself).
     */
    ending?: "restore" | "steps";
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
      const unfocused = await gamePage.unfocusWork();
      const problem = unfocused.problem ?? (await steps(gamePage, { wasFocused: unfocused.clicked }));
      // As found, however it went, in the time kept for it: the page was moved. Focused again if it was; if that can't
      // be (the work ended meanwhile), the Terminal.
      let backProblem: string | null = null;
      if (ending === "restore") {
        backProblem = unfocused.clicked ? await gamePage.refocusWork() : await gamePage.returnToTerminal();
        if (unfocused.clicked && backProblem !== null) backProblem = (await gamePage.returnToTerminal()) ?? backProblem;
      }
      report.problem = problem ?? backProblem;
      report.done = isDone();
      if (!report.done) report.problem ??= notDoneAfter;
    }
  }
  reportToAgent(ns, report);
}
