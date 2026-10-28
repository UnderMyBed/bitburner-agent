// Work on the game's page (#151, #153): what the page shows of the player's work, and the steps that converge it, for
// `faction-work.js` and `company-work.js` (../entries/), which document them. A module of its own so its jsdom tests
// can import them: an entry's bundle exports only `main`.
// - Focused, the Work page's title (`ui/WorkInProgressRoot.tsx`): "You are currently carrying out hacking contracts for
//   CyberSec", "You are currently working as a Waiter at Noodle Bar".
// - Unfocused, the overview's header (`ui/React/CharacterOverview.tsx:332-365`): "Working for CyberSec", "Working at
//   Noodle Bar". What work it is ("Doing hacking work", the job title) is the header's tooltip, rendered only on hover,
//   so it's read from the overview's React props.
import { type FactionWorkType, JOB_FIELDS, type Work } from "@bitburner-agent/core";
import { factionRowButtonXpath, type GamePage, reactPropsAbove, reactText, xpathString } from "./game-page.ts";

/** How the Work page words each faction work type, and the faction page's button that starts it. */
const FACTION_WORK_TYPES: Record<FactionWorkType, { doing: string; button: string }> = {
  hacking: { doing: "carrying out hacking contracts", button: "Hacking Contracts" },
  field: { doing: "carrying out field missions", button: "Field Work" },
  security: { doing: "performing security detail", button: "Security Work" },
};

/** The job titles of a company work's field. */
const jobTitles = (field: string) => (JOB_FIELDS[field] ?? []).map((job) => job.title);

/** The overview's work, unfocused: its header, and its tooltip's text (from React props), or null. */
function overviewWork(gamePage: GamePage, header: string): string | null {
  const element = gamePage.findElementNow(`//p[normalize-space()=${xpathString(header)}]`);
  const overview = element === null ? null : reactPropsAbove(element, "tooltip");
  return overview === null ? null : reactText(overview.tooltip);
}

/** What the page shows of `work`: this work focused, this work unfocused, or neither. */
export function workShown(gamePage: GamePage, work: Work): "focused" | "unfocused" | null {
  const titleShown = (title: string) => gamePage.findElementNow(`//h6[normalize-space()=${xpathString(title)}]`);
  if (work.kind === "faction") {
    const { faction, workType } = work;
    if (titleShown(`You are currently ${FACTION_WORK_TYPES[workType].doing} for ${faction}`)) return "focused";
    return overviewWork(gamePage, `Working for ${faction}`) === `Doing ${workType} work` ? "unfocused" : null;
  }
  const { company, field } = work;
  if (jobTitles(field).some((job) => titleShown(`You are currently working as a ${job} at ${company}`))) {
    return "focused";
  }
  return jobTitles(field).includes(overviewWork(gamePage, `Working at ${company}`) ?? "") ? "unfocused" : null;
}

/**
 * The steps on the page, after `reportPageEffect` has unfocused a focused player (`wasFocused`): the work started if it
 * isn't the work shown, then left at the focus wanted. `hasJobInField`: company work, the player has a job in the field
 * there already (`getPlayer().jobs`), so there's nothing to apply for.
 */
export async function convergeWorkOnPage(
  gamePage: GamePage,
  work: Work,
  { wasFocused, hasJobInField = false }: { wasFocused: boolean; hasJobInField?: boolean },
): Promise<string | null> {
  /** Stopped on the way: the problem, and the player left as found, focused again on their work, or the Terminal. */
  const stopped = async (problem: string) => {
    if (wasFocused && (await gamePage.refocusWork()) === null) return problem;
    await gamePage.returnToTerminal();
    return problem;
  };
  // A focused player has been unfocused already, so the right work shows on the overview now: left as the focus
  // wants it, the Work page or the Terminal. The work isn't started again.
  if (workShown(gamePage, work) === "unfocused") {
    return work.focus ? gamePage.refocusWork() : gamePage.returnToTerminal();
  }
  const started =
    work.kind === "faction"
      ? await startFactionWork(gamePage, work)
      : await startCompanyWork(gamePage, work, hasJobInField);
  if (started !== null) return stopped(started);
  // Started focused, on the Work page: done, or unfocused and back to the Terminal.
  if (work.focus) return null;
  const unfocused = await gamePage.unfocusWork();
  return unfocused.problem ?? (await gamePage.returnToTerminal());
}

/** Faction work (#151): the sidebar's Factions, "Details" on the faction's row, then the work's button. */
async function startFactionWork(gamePage: GamePage, { faction, workType }: Extract<Work, { kind: "faction" }>) {
  const button = FACTION_WORK_TYPES[workType].button;
  return (
    (await gamePage.openSidebarPage("Factions")) ??
    (await gamePage.clickWhenThere(
      factionRowButtonXpath("factions-joined", faction, "Details"),
      `${faction} among the factions joined (is it joined?)`,
    )) ??
    (await gamePage.clickWhenThere(
      `//button[normalize-space()=${xpathString(button)}]`,
      `"${button}" on ${faction}'s page (does it offer ${workType} work?)`,
    ))
  );
}

/**
 * Company work (#153): the company in the City (only in its city), the field's offered job applied for if there's none
 * yet (its "Apply" button, disabled where the player doesn't qualify; the "Congratulations" alert closed), then "Work".
 */
async function startCompanyWork(
  gamePage: GamePage,
  { company, field }: Extract<Work, { kind: "company" }>,
  hasJobInField: boolean,
): Promise<string | null> {
  const opened = await gamePage.openCityLocation(company);
  if (opened !== null) return `${opened} (is the player in its city?)`;
  if (!hasJobInField) {
    const applyTexts = [...new Set((JOB_FIELDS[field] ?? []).map((job) => job.applyText))];
    const apply = await gamePage.findWhenThere(
      `//button[${applyTexts.map((text) => `normalize-space()=${xpathString(text)}`).join(" or ")}]`,
    );
    if (apply === null) return `no ${field} job offered at ${company}`;
    if ((apply as HTMLButtonElement).disabled) return `not qualified for a ${field} job at ${company} yet`;
    const applied = await gamePage.clickElement(apply, `${field}'s "Apply" at ${company}`);
    if (applied !== null) return applied;
    const hired = await gamePage.clickIfThere(
      "//div[button and contains(., 'Congratulations, you are now employed')]/button",
      "the close button on the hiring's alert",
    );
    if (hired.problem !== null) return hired.problem;
  }
  return gamePage.clickWhenThere(
    "//button[normalize-space()='Work']",
    `"Work" at ${company} (is the player employed?)`,
  );
}
