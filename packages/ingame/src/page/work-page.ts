// Work on the game's page (#151, #153, #155, #156, #158): what the page shows of the player's work, and the steps
// that converge it, a promotion included, for `faction-work.js`, `company-work.js`, `crime-work.js` and
// `class-work.js` (../entries/), which document them. A module of its own so its jsdom tests can import them: an
// entry's bundle exports only `main`.
// - Focused, the Work page's title (`ui/WorkInProgressRoot.tsx`): "You are currently carrying out hacking contracts for
//   CyberSec", "You are currently working as a Waiter at Noodle Bar", "You are attempting to shoplift", "You are
//   currently taking a Networks course".
// - Unfocused, the overview's header (`ui/React/CharacterOverview.tsx:300-365`): "Working for CyberSec", "Working at
//   Noodle Bar", "You are attempting to Shoplift", "You are taking a Networks course". What faction or company work it
//   is ("Doing hacking work", the job title) is the header's tooltip, rendered only on hover, so it's read from the
//   overview's React props. Neither text says where a class is: the page can't tell Iron Gym's strength training from
//   Powerhouse Gym's, so a class of the type wanted counts, wherever it is.
import {
  CLASS_TYPES,
  CRIMES,
  classStartProblem,
  type FactionWorkType,
  holdsJobInField,
  JOB_FIELDS,
  jobTitles,
  laterJobs,
  type Work,
} from "@bitburner-agent/core";
import { factionRowButtonXpath, type GamePage, reactPropsAbove, reactText, xpathString } from "./game-page.ts";

/** How the Work page words each faction work type, and the faction page's button that starts it. */
const FACTION_WORK_ON_PAGE: Record<FactionWorkType, { doing: string; button: string }> = {
  hacking: { doing: "carrying out hacking contracts", button: "Hacking Contracts" },
  field: { doing: "carrying out field missions", button: "Field Work" },
  security: { doing: "performing security detail", button: "Security Work" },
};

/** The overview's work, unfocused: its header, and its tooltip's text (from React props), or null. */
function overviewWork(gamePage: GamePage, header: string): string | null {
  const element = gamePage.findElementNow(`//p[normalize-space()=${xpathString(header)}]`);
  const overview = element === null ? null : reactPropsAbove(element, "tooltip");
  return overview === null ? null : reactText(overview.tooltip);
}

/** What the page shows of `work`: this work focused, this work unfocused, or neither. */
export function workShown(gamePage: GamePage, work: Work): "focused" | "unfocused" | null {
  const titleShown = (title: string) => gamePage.findElementNow(`//h6[normalize-space()=${xpathString(title)}]`);
  if (work.kind === "class") {
    const youAre = Object.hasOwn(CLASS_TYPES, work.classType)
      ? CLASS_TYPES[work.classType]?.youAreCurrently
      : undefined;
    if (youAre === undefined) return null;
    if (titleShown(`You are currently ${youAre}`)) return "focused";
    const header = gamePage.findElementNow(`//p[normalize-space()=${xpathString(`You are ${youAre}`)}]`);
    return header === null ? null : "unfocused";
  }
  if (work.kind === "crime") {
    const { crime } = work;
    const workName = Object.hasOwn(CRIMES, crime) ? CRIMES[crime]?.workName : undefined;
    if (workName !== undefined && titleShown(`You are attempting ${workName}`)) return "focused";
    const header = gamePage.findElementNow(`//p[normalize-space()=${xpathString(`You are attempting to ${crime}`)}]`);
    return header === null ? null : "unfocused";
  }
  if (work.kind === "faction") {
    const { faction, workType } = work;
    if (titleShown(`You are currently ${FACTION_WORK_ON_PAGE[workType].doing} for ${faction}`)) return "focused";
    return overviewWork(gamePage, `Working for ${faction}`) === `Doing ${workType} work` ? "unfocused" : null;
  }
  const { company, field } = work;
  if (jobTitles(field).some((job) => titleShown(`You are currently working as a ${job} at ${company}`))) {
    return "focused";
  }
  return jobTitles(field).includes(overviewWork(gamePage, `Working at ${company}`) ?? "") ? "unfocused" : null;
}

/**
 * The steps on the page, after `reportPageEffect` has unfocused a focused player (`wasFocused`): for company work with
 * `checkPromotion`, a promotion taken if the page offers one (#155, `promoteOnPage`); then the work started if it isn't
 * the work shown, and left at the focus wanted. `jobs`: for company work, the title held at each company
 * (`getPlayer().jobs`), in the game's order.
 */
export async function convergeWorkOnPage(
  gamePage: GamePage,
  work: Work,
  {
    wasFocused,
    jobs = {},
    checkPromotion = false,
  }: { wasFocused: boolean; jobs?: Record<string, string>; checkPromotion?: boolean },
): Promise<string | null> {
  /** Stopped on the way: the problem, and the player left as found, focused again on their work, or the Terminal. */
  const stopped = async (problem: string) => {
    if (wasFocused && (await gamePage.refocusWork()) === null) return problem;
    await gamePage.returnToTerminal();
    return problem;
  };
  if (work.kind === "company" && checkPromotion) {
    const promoted = await promoteOnPage(gamePage, work, jobs);
    if (promoted !== null) return stopped(promoted);
  }
  // A focused player has been unfocused already, so the right work shows on the overview now: left as the focus
  // wants it, the Work page or the Terminal. The work isn't started again.
  if (workShown(gamePage, work) === "unfocused") {
    return work.focus ? gamePage.refocusWork() : gamePage.returnToTerminal();
  }
  const started = await startWork(gamePage, work, jobs);
  if (started !== null) return stopped(started);
  // Started focused, on the Work page: done, or unfocused and back to the Terminal.
  if (work.focus) return null;
  const unfocused = await gamePage.unfocusWork();
  return unfocused.problem ?? (await gamePage.returnToTerminal());
}

/** The steps that start `work`, focused on the Work page: their problem, or null. */
function startWork(gamePage: GamePage, work: Work, jobs: Record<string, string>): Promise<string | null> {
  switch (work.kind) {
    case "faction":
      return startFactionWork(gamePage, work);
    case "company":
      return startCompanyWork(gamePage, work, jobs);
    case "crime":
      return startCrimeWork(gamePage, work);
    case "class":
      return startClassWork(gamePage, work);
  }
}

/**
 * Why a class (#158) isn't started for `player`, or null: core's `classStartProblem` (another city, or under 10 minutes
 * of its cost), asked only while the page shows no class of its type under way, so one under way is left alone. With
 * no page, null: the worker's page effect says so.
 */
export function classHeldBack(
  gamePage: GamePage | null,
  work: Extract<Work, { kind: "class" }>,
  player: { money: number; city: string },
): string | null {
  if (gamePage === null || workShown(gamePage, work) !== null) return null;
  return classStartProblem(work, player);
}

/** Faction work (#151): the sidebar's Factions, "Details" on the faction's row, then the work's button. */
async function startFactionWork(gamePage: GamePage, { faction, workType }: Extract<Work, { kind: "faction" }>) {
  const button = FACTION_WORK_ON_PAGE[workType].button;
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
 * Company work (#153). With a job in the field there already: the sidebar's Job page, from any city, which shows each
 * job held, in `jobs`' order, with its own "Work" (`Locations/ui/JobRoot.tsx`, `CompanyLocation.tsx`). Otherwise the
 * company in the City, only in its city (`Locations/ui/City.tsx`), and its field's "Apply" (`Company/ui/JobListings.tsx`:
 * the highest job the player qualifies for, or else the field's first, disabled; none where the company offers neither),
 * then the hiring's alert closed ("Congratulations, you are now employed as a Waiter", "… you got a contract as a …",
 * `CompanyPositionsMetadata.ts`), then "Work".
 */
async function startCompanyWork(
  gamePage: GamePage,
  { company, field }: Extract<Work, { kind: "company" }>,
  jobs: Record<string, string>,
): Promise<string | null> {
  if (holdsJobInField(jobs, company, field)) {
    return (
      (await gamePage.openSidebarPage("Job")) ??
      (await gamePage.clickWhenThere(jobPageWorkXpath(company, jobs), jobPageWorkName(company)))
    );
  }
  const opened = await gamePage.openCityLocation(company);
  if (opened !== null) return `${opened} (is the player in its city?)`;
  const applyTexts = (JOB_FIELDS[field] ?? []).map((job) => job.applyText);
  const apply = await gamePage.findWhenThere(
    `//button[${applyTexts.map((text) => `normalize-space()=${xpathString(text)}`).join(" or ")}]`,
  );
  if (apply === null) return `no ${field} job open to the player at ${company} (none offered, or not qualified yet)`;
  if ((apply as HTMLButtonElement).disabled) return `not qualified for a ${field} job at ${company} yet`;
  const applied = await gamePage.clickElement(apply, `${field}'s "Apply" at ${company}`);
  if (applied !== null) return applied;
  const hired = await gamePage.clickIfThere(
    "//div[button and contains(., 'Congratulations, you ')]/button",
    "the close button on the hiring's alert",
  );
  if (hired.problem !== null) return hired.problem;
  return gamePage.clickWhenThere(
    "//button[normalize-space()='Work']",
    `"Work" at ${company} (is the player employed?)`,
  );
}

/**
 * The sidebar's Job page's "Work" for the job held at `company`: one per job held, in `jobs`' order (`JobRoot.tsx`).
 */
const jobPageWorkXpath = (company: string, jobs: Record<string, string>) =>
  `(//button[normalize-space()='Work'])[${Object.keys(jobs).indexOf(company) + 1}]`;

/**
 * The Job page's "Work" for `company`, as the steps name it: what's clicked to work the job held, and what's missing
 * ("no …") when a promotion check or that click finds no block for the company.
 */
const jobPageWorkName = (company: string) => `"Work" for ${company} on the Job page`;

/**
 * A promotion check (#155, owner decision 44), with a job in the field held at the company: the sidebar's Job page,
 * from any city, and that company's own block there. The page shows each job held's whole company page, in `jobs`'
 * order (`Locations/ui/JobRoot.tsx`, `GenericLocation.tsx:47-51`, `CompanyLocation.tsx:146`): a `div` with the
 * company's name as its `h4`, which a backdoor's corruptible text can scramble, so it's found from its "Work". Its job
 * listing (`Company/ui/JobListings.tsx`) shows the next title, disabled until the player qualifies, or a later one
 * they qualify for. Only a later title of the field counts (`laterJobs`: the consultants' two share one text, and the
 * one held is never shown); none, or disabled: nothing to do. Enabled: clicked, which climbs no further than it
 * (`applyForJob`: the job shown is one whose next the player doesn't qualify for), and the "Congratulations, you …"
 * alert closed (`pos.hiredText`). The work under way isn't touched: the game reads the title each cycle
 * (`Work/CompanyWork.tsx:44`).
 */
async function promoteOnPage(
  gamePage: GamePage,
  { company, field }: Extract<Work, { kind: "company" }>,
  jobs: Record<string, string>,
): Promise<string | null> {
  const later = laterJobs(field, Object.hasOwn(jobs, company) ? jobs[company] : undefined);
  if (!holdsJobInField(jobs, company, field) || later.length === 0) return null;
  const opened = await gamePage.openSidebarPage("Job");
  if (opened !== null) return opened;
  const work = jobPageWorkXpath(company, jobs);
  if ((await gamePage.findWhenThere(work)) === null) return `no ${jobPageWorkName(company)}`;
  const texts = [...new Set(later.map((job) => job.applyText))];
  const apply = gamePage.findElementNow(
    `${work}/ancestor::div[h4][1]//button[${texts.map((text) => `normalize-space()=${xpathString(text)}`).join(" or ")}]`,
  );
  if (apply === null || (apply as HTMLButtonElement).disabled) return null;
  return (
    (await gamePage.clickElement(apply, `${field}'s promotion at ${company}`)) ??
    (
      await gamePage.clickIfThere(
        "//div[button and contains(., 'Congratulations, you ')]/button",
        "the close button on the promotion's alert",
      )
    ).problem
  );
}

/**
 * A crime (#156): The Slums, in every city (`Locations/data/LocationsMetadata.ts:431-435`), then the crime's button,
 * "Shoplift (45.20% chance of success)" (`Locations/ui/SlumsLocation.tsx`), never disabled, which starts it focused.
 */
async function startCrimeWork(gamePage: GamePage, { crime }: Extract<Work, { kind: "crime" }>): Promise<string | null> {
  return (
    (await gamePage.openCityLocation("The Slums")) ??
    (await gamePage.clickWhenThere(
      `//button[starts-with(normalize-space(), ${xpathString(`${crime} (`)})]`,
      `"${crime}" at the Slums`,
    ))
  );
}

/**
 * A class (#158): the university or gym in the City, only in its city (`Locations/ui/City.tsx`), then the class's
 * button, "Take Networks course (… / sec)" (`Locations/ui/UniversityLocation.tsx:51-82`) or "Train Strength (… / sec)"
 * (`GymLocation.tsx:42-53`), never disabled and never checking the money, which starts it focused.
 */
async function startClassWork(
  gamePage: GamePage,
  { location, classType }: Extract<Work, { kind: "class" }>,
): Promise<string | null> {
  const button = (Object.hasOwn(CLASS_TYPES, classType) ? CLASS_TYPES[classType]?.button : undefined) ?? classType;
  const opened = await gamePage.openCityLocation(location);
  if (opened !== null) return `${opened} (is the player in its city?)`;
  return gamePage.clickWhenThere(
    `//button[starts-with(normalize-space(), ${xpathString(button)})]`,
    `"${button}…" at ${location}`,
  );
}
