// @vitest-environment jsdom
// Keeping the player's focus around a page effector's steps (#151), and company work's steps (#153), on a stand-in
// page: the Work page's unfocus button, the overview's "Focus", the sidebar, the City's companies and a company's
// buttons, each a React `onClick` that records its click. E2 drives the real page.
import { afterEach, expect, test } from "vitest";
import type { NS } from "../../src/ns.ts";
import { openGamePage } from "../../src/page/game-page.ts";
import { reportPageEffect } from "../../src/page/page-effect.ts";
import { convergeWorkOnPage } from "../../src/page/work-page.ts";

const clicks: string[] = [];
const reports: unknown[] = [];
const ns = {
  asleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  pid: 7,
  writePort: (_port: number, report: { data: unknown }) => reports.push(report.data),
} as unknown as NS;

/** A clickable element: a sidebar item (`div[role=button]` with a `p`) or a button, recording its click. */
function clickable(label: string, kind: "sidebar" | "button", onClick: () => void = () => {}): HTMLElement {
  const element = document.createElement(kind === "sidebar" ? "div" : "button");
  if (kind === "sidebar") {
    element.setAttribute("role", "button");
    element.append(Object.assign(document.createElement("p"), { textContent: label }));
  } else {
    element.textContent = label;
  }
  Object.assign(element, {
    __reactProps$test: {
      onClick: () => {
        clicks.push(label);
        onClick();
      },
    },
  });
  return element;
}

afterEach(() => {
  clicks.length = 0;
  reports.length = 0;
  document.body.replaceChildren();
});

test("focused, then the work ends during the steps: no Focus to click, so the page goes back to the Terminal", async () => {
  // The Work page's unfocus button; once clicked, the sidebar shows, and the overview has no work (it ended).
  const unfocus = clickable("Do something else simultaneously", "button", () =>
    document.body.replaceChildren(clickable("Terminal", "sidebar"), clickable("City", "sidebar")),
  );
  document.body.replaceChildren(unfocus);
  await reportPageEffect(ns, Date.now() + 1_500, {
    isDone: () => clicks.includes("City"),
    doing: "test through",
    steps: async (gamePage) => gamePage.openSidebarPage("City"),
    notDoneAfter: "not done",
  });
  expect(clicks).toEqual(["Do something else simultaneously", "City", "Terminal"]);
  expect(reports).toEqual([{ done: true, problem: 'no "Focus" on the overview\'s work' }]);
});

test("faction work that can't start, for a player focused on their own work: focused on it again, not left unfocused", async () => {
  // Unfocused already (as `reportPageEffect` leaves them), on a page with the sidebar, CyberSec's row, and the
  // overview's Focus; CyberSec's page has no "Field Work".
  const factionRow = document.createElement("span");
  factionRow.className = "factions-joined";
  const paper = document.createElement("div");
  paper.className = "MuiPaper-root";
  paper.append(
    Object.assign(document.createElement("span"), { textContent: "CyberSec" }),
    clickable("Details", "button"),
  );
  factionRow.append(paper);
  document.body.replaceChildren(clickable("Factions", "sidebar"), factionRow, clickable("Focus", "button"));
  const gamePage = openGamePage(ns, Date.now() + 1_500);
  if (!gamePage) throw new Error("no page");
  const problem = await convergeWorkOnPage(
    gamePage,
    { kind: "faction", faction: "CyberSec", workType: "field", focus: true },
    { wasFocused: true },
  );
  expect(problem).toBe('no "Field Work" on CyberSec\'s page (does it offer field work?)');
  expect(clicks).toEqual(["Factions", "Details", "Focus"]);
});

/** The City page with ASCII art off, as the stand-in shows it: the sidebar's City and Terminal, and `company`'s button. */
function inTheCity(company: string, ...companyPage: HTMLElement[]) {
  const companyButton = clickable(company, "button", () =>
    document.body.replaceChildren(clickable("Terminal", "sidebar"), ...companyPage),
  );
  document.body.replaceChildren(clickable("City", "sidebar"), clickable("Terminal", "sidebar"), companyButton);
  const gamePage = openGamePage(ns, Date.now() + 1_500);
  if (!gamePage) throw new Error("no page");
  return gamePage;
}

test("company work the player doesn't qualify for (#153): the disabled Apply isn't clicked, and the page goes back", async () => {
  const apply = clickable("Apply for Software Engineering Intern Job", "button");
  (apply as HTMLButtonElement).disabled = true;
  const gamePage = inTheCity("MegaCorp", apply);
  const problem = await convergeWorkOnPage(
    gamePage,
    { kind: "company", company: "MegaCorp", field: "Software", focus: true },
    { wasFocused: false },
  );
  expect(problem).toBe("not qualified for a Software job at MegaCorp yet");
  expect(clicks).toEqual(["City", "MegaCorp", "Terminal"]);
});

test("company work, hired (#153): Apply, the hiring's alert closed, Work, then unfocused; a name with an apostrophe", async () => {
  // The Work page: its unfocus button, which leaves the sidebar showing.
  const work = clickable("Work", "button", () =>
    document.body.replaceChildren(
      clickable("Do something else simultaneously", "button", () =>
        document.body.replaceChildren(clickable("Terminal", "sidebar")),
      ),
    ),
  );
  // Applying opens the game's alert (a consultant's wording: any "Congratulations, you …"), closed by its button.
  const alert = document.createElement("div");
  alert.append(
    "Congratulations, you got a contract as a Employee at Joe's Guns!",
    clickable("Close", "button", () => alert.remove()),
  );
  const apply = clickable("Apply to be an Employee", "button", () => document.body.append(alert));
  const gamePage = inTheCity("Joe's Guns", apply, work);
  const problem = await convergeWorkOnPage(
    gamePage,
    { kind: "company", company: "Joe's Guns", field: "Employee", focus: false },
    { wasFocused: false },
  );
  expect(problem).toBeNull();
  expect(clicks).toEqual([
    "City",
    "Joe's Guns",
    "Apply to be an Employee",
    "Close",
    "Work",
    "Do something else simultaneously",
    "Terminal",
  ]);
});

test("company work with a job in the field already (#153): that job's Work on the Job page, from any city", async () => {
  // The Job page lists each job held, in `getPlayer().jobs`' order, each with its own Work.
  const jobPage = () =>
    document.body.replaceChildren(
      clickable("Work", "button", () => clicks.push("Noodle Bar's")),
      clickable("Work", "button", () => clicks.push("Joe's Guns'")),
    );
  document.body.replaceChildren(clickable("Job", "sidebar", jobPage), clickable("City", "sidebar"));
  const gamePage = openGamePage(ns, Date.now() + 1_500);
  if (!gamePage) throw new Error("no page");
  const problem = await convergeWorkOnPage(
    gamePage,
    { kind: "company", company: "Joe's Guns", field: "Employee", focus: true },
    { wasFocused: false, jobs: { "Noodle Bar": "Waiter", "Joe's Guns": "Employee" } },
  );
  expect(problem).toBeNull();
  expect(clicks).toEqual(["Job", "Work", "Joe's Guns'"]);
});
