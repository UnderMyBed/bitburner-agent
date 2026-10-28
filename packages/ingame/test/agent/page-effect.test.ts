// @vitest-environment jsdom
// Keeping the player's focus around a page effector's steps (#151), and company work's, crime's and classes' steps
// (#153, #156, #158), on a stand-in page: the Work page's unfocus button, the overview's "Focus", the sidebar, the
// City's locations and their buttons (a company's, the Slums' crimes, a university's courses), each a React `onClick`
// that records its click. E2 drives the real page.
import { afterEach, expect, test } from "vitest";
import type { NS } from "../../src/ns.ts";
import { openGamePage } from "../../src/page/game-page.ts";
import { reportPageEffect } from "../../src/page/page-effect.ts";
import { classHeldBack, convergeWorkOnPage, workShown } from "../../src/page/work-page.ts";

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

/**
 * The City page with ASCII art off, as the stand-in shows it: the sidebar's City and Terminal, and the button of
 * `location`, which opens `locationPage`.
 */
function inTheCity(location: string, ...locationPage: HTMLElement[]) {
  const locationButton = clickable(location, "button", () =>
    document.body.replaceChildren(clickable("Terminal", "sidebar"), ...locationPage),
  );
  document.body.replaceChildren(clickable("City", "sidebar"), clickable("Terminal", "sidebar"), locationButton);
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

test("a crime (#156): The Slums, then the crime's button, which starts it focused; then unfocused if wanted", async () => {
  const workPage = () =>
    document.body.replaceChildren(
      clickable("Do something else simultaneously", "button", () =>
        document.body.replaceChildren(clickable("Terminal", "sidebar")),
      ),
    );
  // Not the first button: the crime's is picked by its name.
  const slums = [
    clickable("Heist (0.10% chance of success)", "button"),
    clickable("Shoplift (45.20% chance of success)", "button", workPage),
    clickable("Rob Store (12.00% chance of success)", "button"),
  ];
  const gamePage = inTheCity("The Slums", ...slums);
  const problem = await convergeWorkOnPage(
    gamePage,
    { kind: "crime", crime: "Shoplift", focus: false },
    { wasFocused: false },
  );
  expect(problem).toBeNull();
  expect(clicks).toEqual([
    "City",
    "The Slums",
    "Shoplift (45.20% chance of success)",
    "Do something else simultaneously",
    "Terminal",
  ]);
});

test("a crime as the page shows it (#156): the Work page's wording focused, the overview's unfocused", () => {
  const gamePage = openGamePage(ns, Date.now() + 1_500);
  if (!gamePage) throw new Error("no page");
  const heist = { kind: "crime", crime: "Heist", focus: true } as const;
  document.body.replaceChildren(
    Object.assign(document.createElement("h6"), { textContent: "You are attempting a heist" }),
  );
  expect(workShown(gamePage, heist)).toBe("focused");
  document.body.replaceChildren(
    Object.assign(document.createElement("p"), { textContent: "You are attempting to Heist" }),
  );
  expect(workShown(gamePage, heist)).toBe("unfocused");
  expect(workShown(gamePage, { ...heist, crime: "Mug" })).toBeNull();
});

test("a class (#158): the university in the City, then the course's button, which starts it focused; then unfocused", async () => {
  const workPage = () =>
    document.body.replaceChildren(
      clickable("Do something else simultaneously", "button", () =>
        document.body.replaceChildren(clickable("Terminal", "sidebar")),
      ),
    );
  // Not the first button: the course's is picked by its text, "Networks", not "Network".
  const university = [
    clickable("Study Computer Science (free)", "button"),
    clickable("Take Networks course ($240.000 / sec)", "button", workPage),
    clickable("Take Algorithms course ($960.000 / sec)", "button"),
  ];
  const gamePage = inTheCity("Rothman University", ...university);
  const networks = { kind: "class", location: "Rothman University", classType: "Networks", focus: false } as const;
  expect(await convergeWorkOnPage(gamePage, networks, { wasFocused: false })).toBeNull();
  expect(clicks).toEqual([
    "City",
    "Rothman University",
    "Take Networks course ($240.000 / sec)",
    "Do something else simultaneously",
    "Terminal",
  ]);
});

test('a gym\'s stat (#158): its button, "Train Dexterity (…)"', async () => {
  const gym = [
    clickable("Train Strength ($120.000 / sec)", "button"),
    clickable("Train Dexterity ($120.000 / sec)", "button"),
  ];
  const gamePage = inTheCity("Iron Gym", ...gym);
  const dexterity = { kind: "class", location: "Iron Gym", classType: "dex", focus: true } as const;
  expect(await convergeWorkOnPage(gamePage, dexterity, { wasFocused: false })).toBeNull();
  expect(clicks).toEqual(["City", "Iron Gym", "Train Dexterity ($120.000 / sec)"]);
});

test("a class as the page shows it (#158): the Work page's title focused, the overview's unfocused, by type only", () => {
  const gamePage = openGamePage(ns, Date.now() + 1_500);
  if (!gamePage) throw new Error("no page");
  const strength = { kind: "class", location: "Iron Gym", classType: "str", focus: false } as const;
  const title = document.createElement("h6");
  title.append(
    "You are currently ",
    Object.assign(document.createElement("b"), { textContent: "training your strength at a gym" }),
  );
  document.body.replaceChildren(title);
  expect(workShown(gamePage, strength)).toBe("focused");
  document.body.replaceChildren(
    Object.assign(document.createElement("p"), { textContent: "You are training your strength at a gym" }),
  );
  expect(workShown(gamePage, strength)).toBe("unfocused");
  // The page names no gym: Powerhouse Gym's strength training reads the same.
  expect(workShown(gamePage, { ...strength, location: "Powerhouse Gym" })).toBe("unfocused");
  expect(workShown(gamePage, { ...strength, classType: "def" })).toBeNull();
  expect(workShown(gamePage, { ...strength, classType: "toString" })).toBeNull();
});

test("a class held back (#158): another city or too little money, unless a class of its type is under way", () => {
  const gamePage = openGamePage(ns, Date.now() + 1_500);
  if (!gamePage) throw new Error("no page");
  const algorithms = { kind: "class", location: "Rothman University", classType: "Algorithms", focus: false } as const;
  const sector12 = { money: 1_000, city: "Sector-12" };
  expect(classHeldBack(gamePage, algorithms, { money: 1e9, city: "Aevum" })).toBe(
    "Rothman University is in Sector-12, and the player is in Aevum (travel there first)",
  );
  expect(classHeldBack(gamePage, algorithms, sector12)).toMatch(
    /^Algorithms at Rothman University costs \$960 a second/,
  );
  expect(classHeldBack(gamePage, algorithms, { money: 576_000, city: "Sector-12" })).toBeNull();
  // Under way already (unfocused, on the overview): left alone, whatever the money.
  document.body.replaceChildren(
    Object.assign(document.createElement("p"), { textContent: "You are taking an Algorithms course" }),
  );
  expect(classHeldBack(gamePage, algorithms, sector12)).toBeNull();
  expect(classHeldBack(null, algorithms, sector12)).toBeNull();
});
