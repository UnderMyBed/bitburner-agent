// @vitest-environment jsdom
// Closing the game through the page (#303): Options, the game's own "Save Game", its "Game Saved!" toast, then the
// window's close, on a stand-in page with React's props on its elements, as the game renders them. E2 drives the real
// page (packages/e2/test/effectors.e2.test.ts).
import { afterEach, expect, test, vi } from "vitest";
import type { NS } from "../../src/ns.ts";
import {
  closeGameOnPage,
  closeGameWindow,
  SAVE_NOT_CONFIRMED,
  WINDOW_STAYED_OPEN,
} from "../../src/page/close-game-page.ts";
import { openGamePage } from "../../src/page/game-page.ts";
import { clicks, element, withProps } from "./stand-in-page.ts";

const ns = { asleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)) } as unknown as NS;

afterEach(() => {
  clicks.length = 0;
  document.body.replaceChildren();
});

/** The save's toast, as notistack renders the game's Alert. */
function toast(text = "Game Saved!") {
  const message = element("div", { className: "MuiAlert-message", textContent: text });
  document.body.append(message);
  return message;
}

/** The sidebar's Options, opening the Options page with its Save Game, which shows its toast `toastAfterMs` on. */
function optionsPage({ toastAfterMs = 100 }: { toastAfterMs?: number | null } = {}) {
  const options = withProps(element("div"), {
    onClick: () => {
      clicks.push("Options");
      document.body.append(
        withProps(element("button", { textContent: "Save Game" }), {
          onClick: () => {
            clicks.push("Save Game");
            if (toastAfterMs !== null) setTimeout(() => toast(), toastAfterMs);
          },
        }),
      );
    },
  });
  options.setAttribute("role", "button");
  options.append(element("p", { textContent: "Options" }));
  document.body.append(options);
}

const gamePageFor = (ms: number) => {
  const gamePage = openGamePage(ns, performance.now() + ms);
  if (gamePage === null) throw new Error("no page");
  return gamePage;
};

test("saved, the toast seen, then closed; alive after, the window stayed open (a browser's), and it says so", async () => {
  optionsPage();
  const closeWindow = vi.fn(() => clicks.push("window.close()"));
  expect(await closeGameOnPage(gamePageFor(1_500), closeWindow)).toBe(WINDOW_STAYED_OPEN);
  expect(clicks).toEqual(["Options", "Save Game", "window.close()"]);
});

test("no toast in time: the save isn't confirmed, so the window isn't closed", async () => {
  optionsPage({ toastAfterMs: null });
  const closeWindow = vi.fn();
  expect(await closeGameOnPage(gamePageFor(800), closeWindow)).toBe(SAVE_NOT_CONFIRMED);
  expect(closeWindow).not.toHaveBeenCalled();
});

test("a toast already showing (an autosave's) isn't this save's: it waits for its own", async () => {
  optionsPage({ toastAfterMs: null });
  toast();
  const closeWindow = vi.fn();
  expect(await closeGameOnPage(gamePageFor(800), closeWindow)).toBe(SAVE_NOT_CONFIRMED);
  expect(closeWindow).not.toHaveBeenCalled();
});

test("another toast isn't the save's", async () => {
  optionsPage({ toastAfterMs: null });
  const closeWindow = vi.fn();
  const gamePage = gamePageFor(800);
  const steps = closeGameOnPage(gamePage, closeWindow);
  setTimeout(() => toast("Game Saved! (not really)"), 100);
  expect(await steps).toBe(SAVE_NOT_CONFIRMED);
  expect(closeWindow).not.toHaveBeenCalled();
});

test("no Options in the sidebar: said, and nothing saved or closed", async () => {
  const closeWindow = vi.fn();
  expect(await closeGameOnPage(gamePageFor(700), closeWindow)).toMatch(/no "Options" in the sidebar/);
  expect(closeWindow).not.toHaveBeenCalled();
});

test("the close is the page's own window.close()", () => {
  const close = vi.fn();
  closeGameWindow({ defaultView: { close } } as unknown as Document);
  expect(close).toHaveBeenCalledTimes(1);
  expect(() => closeGameWindow(null)).not.toThrow();
});
