// Faction work on the game's page (#151): what the page shows of the player's work, and the steps that converge it, for
// `faction-work.js` (../entries/faction-work.ts), which documents them. A module of its own so its jsdom test can import
// them: an entry's bundle exports only `main`.
import type { FactionWorkType } from "@bitburner-agent/core";
import { factionRowButtonXpath, type GamePage, reactPropsAbove, reactText, xpathString } from "./game-page.ts";

/** How the Work page words each type, and the faction page's button that starts it. */
const WORK_TYPES: Record<FactionWorkType, { doing: string; button: string }> = {
  hacking: { doing: "carrying out hacking contracts", button: "Hacking Contracts" },
  field: { doing: "carrying out field missions", button: "Field Work" },
  security: { doing: "performing security detail", button: "Security Work" },
};

/** What the page shows of the work: this work focused, this work unfocused, or neither. */
export function workShown(
  gamePage: GamePage,
  faction: string,
  workType: FactionWorkType,
): "focused" | "unfocused" | null {
  const title = `You are currently ${WORK_TYPES[workType].doing} for ${faction}`;
  if (gamePage.findElementNow(`//h6[normalize-space()=${xpathString(title)}]`)) return "focused";
  const header = gamePage.findElementNow(`//p[normalize-space()=${xpathString(`Working for ${faction}`)}]`);
  const overview = header === null ? null : reactPropsAbove(header, "tooltip");
  return overview !== null && reactText(overview.tooltip) === `Doing ${workType} work` ? "unfocused" : null;
}

/** The steps on the page, after eportPageEffect has unfocused a focused player. */
export async function convergeOnPage(
  gamePage: GamePage,
  { faction, workType, focus }: { faction: string; workType: FactionWorkType; focus: boolean },
  { wasFocused }: { wasFocused: boolean },
): Promise<string | null> {
  /** Stopped on the way: the problem, and the player left as found, focused again on their work, or the Terminal. */
  const stopped = async (problem: string) => {
    if (wasFocused && (await gamePage.refocusWork()) === null) return problem;
    await gamePage.returnToTerminal();
    return problem;
  };
  // A focused player has been unfocused already, so the right work shows on the overview now: left as the focus
  // wants it, the Work page or the Terminal.
  if (workShown(gamePage, faction, workType) === "unfocused") {
    return focus ? gamePage.refocusWork() : gamePage.returnToTerminal();
  }
  const opened =
    (await gamePage.openSidebarPage("Factions")) ??
    (await gamePage.clickWhenThere(
      factionRowButtonXpath("factions-joined", faction, "Details"),
      `${faction} among the factions joined (is it joined?)`,
    ));
  if (opened !== null) return stopped(opened);
  const button = WORK_TYPES[workType].button;
  const started = await gamePage.clickWhenThere(
    `//button[normalize-space()=${xpathString(button)}]`,
    `"${button}" on ${faction}'s page (does it offer ${workType} work?)`,
  );
  if (started !== null) return stopped(started);
  // Started focused, on the Work page: done, or unfocused and back to the Terminal.
  if (focus) return null;
  const unfocused = await gamePage.unfocusWork();
  return unfocused.problem ?? (await gamePage.returnToTerminal());
}
