// @vitest-environment jsdom
// The game's page, driven as `buy-program.js` drives it (#136), on a stand-in page: the sidebar's items as the game
// renders them, with React's props on them. E2 drives the real page (packages/e2/test/effectors.e2.test.ts).
import { afterEach, expect, test } from "vitest";
import type { NS } from "../../src/ns.ts";
import { openGamePage } from "../../src/page/game-page.ts";

const clicks: string[] = [];
const ns = { asleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)) } as unknown as NS;

/** A sidebar with these items, each recording its click, as React's `onClick` prop. */
function sidebarWith(...items: string[]): void {
  document.body.replaceChildren(
    ...items.map((item) => {
      const button = document.createElement("div");
      button.setAttribute("role", "button");
      button.append(Object.assign(document.createElement("p"), { textContent: item }));
      Object.assign(button, { __reactProps$test: { onClick: () => clicks.push(item) } });
      return button;
    }),
  );
}

afterEach(() => {
  clicks.length = 0;
  document.body.replaceChildren();
});

test("a step that waits in vain leaves the way back to the Terminal its own time", async () => {
  sidebarWith("Terminal", "City");
  const deadlineMs = Date.now() + 1_000;
  const gamePage = openGamePage(ns, deadlineMs);
  if (!gamePage) throw new Error("no page");
  expect(await gamePage.openSidebarPage("City")).toBeNull();
  expect(await gamePage.clickWhenThere("//button[normalize-space()='Purchase TOR router']", "TOR router to buy")).toBe(
    "no TOR router to buy",
  );
  expect(await gamePage.returnToTerminal()).toBeNull();
  expect(clicks).toEqual(["City", "Terminal"]);
  expect(Date.now()).toBeLessThanOrEqual(deadlineMs + 100);
});

test("after a step waited in vain, the Terminal is still waited for in the time kept for it", async () => {
  sidebarWith("City");
  const deadlineMs = Date.now() + 1_000;
  // The sidebar's Terminal comes back only after the steps' time is up (300 ms before the deadline).
  setTimeout(() => sidebarWith("City", "Terminal"), 850);
  const gamePage = openGamePage(ns, deadlineMs);
  expect(await gamePage?.clickWhenThere("//button[normalize-space()='Purchase TOR router']", "TOR router to buy")).toBe(
    "no TOR router to buy",
  );
  expect(await gamePage?.returnToTerminal()).toBeNull();
  expect(clicks).toEqual(["Terminal"]);
});

test("a missing sidebar item is named as missing, with the likely reason", async () => {
  sidebarWith("Terminal");
  const gamePage = openGamePage(ns, Date.now() + 500);
  expect(await gamePage?.openSidebarPage("City")).toBe('no "City" in the sidebar (is its section collapsed?)');
});

test("a city location: the City, then the location; one that isn't there is named (#138)", async () => {
  sidebarWith("Terminal", "City");
  const gamePage = openGamePage(ns, Date.now() + 700);
  expect(await gamePage?.openCityLocation("Alpha Enterprises")).toBe("no Alpha Enterprises in the city");
  expect(clicks).toEqual(["City"]);
});

/** A dialog, as MUI's `Modal` renders its root. */
const dialog = () => Object.assign(document.createElement("div"), { className: "MuiModal-root" });

test("a dialog that's fading out after a close isn't one that stays open (#141)", async () => {
  const fading = dialog();
  document.body.append(fading);
  setTimeout(() => fading.remove(), 200);
  const gamePage = openGamePage(ns, Date.now() + 2_000);
  expect(await gamePage?.dialogStaysOpen()).toBe(false);
});

test("a dialog that stays is open, after the time a fade takes", async () => {
  document.body.append(dialog());
  const gamePage = openGamePage(ns, Date.now() + 2_000);
  const startedMs = Date.now();
  expect(await gamePage?.dialogStaysOpen()).toBe(true);
  expect(Date.now() - startedMs).toBeGreaterThanOrEqual(350);
});

test("past the deadline, a step still looks once: what's there is clicked", async () => {
  sidebarWith("Terminal");
  const gamePage = openGamePage(ns, Date.now() - 1);
  expect(await gamePage?.returnToTerminal()).toBeNull();
  expect(clicks).toEqual(["Terminal"]);
});

test("a step the game may skip (#141): clicked if it's there now, and no problem if it isn't", async () => {
  sidebarWith("Terminal", "City");
  const gamePage = openGamePage(ns, Date.now() + 1_000);
  if (!gamePage) throw new Error("no page");
  expect(await gamePage.clickIfThere("//div[@role='button' and .//p[normalize-space()='Travel']]", "Travel")).toEqual({
    clicked: false,
    problem: null,
  });
  expect(await gamePage.clickIfThere("//div[@role='button' and .//p[normalize-space()='City']]", "City")).toEqual({
    clicked: true,
    problem: null,
  });
  expect(clicks).toEqual(["City"]);
  expect(gamePage.stepsTimeUp()).toBe(false);
});

test("the steps' time is up 300 ms before the deadline, kept for the way back", () => {
  const gamePage = openGamePage(ns, Date.now() + 200);
  expect(gamePage?.stepsTimeUp()).toBe(true);
});
