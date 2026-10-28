// @vitest-environment jsdom
// The dialog watcher (#143, owner decision 35), on a stand-in page: MUI modals as the game renders them, with React's
// fiber and props on them as the game's own components leave them. E2 drives the real page
// (packages/e2/test/effectors.e2.test.ts).
import { afterEach, expect, test } from "vitest";
import { createDialogWatcher } from "../../src/agent/dialog-watcher.ts";
import type { NS } from "../../src/ns.ts";

const ns = { asleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)) } as unknown as NS;
const ROUND_MS = 2_000;

afterEach(() => document.body.replaceChildren());

/** A hooks list, as React keeps a function component's state: `memoizedState`, then `next`. */
const hooks = (...states: unknown[]) =>
  states.reduceRight<unknown>((next, memoizedState) => ({ memoizedState, next }), null);

/**
 * A modal as `ui/React/Modal.tsx` renders it: the MUI root, a paper with the close button first, then the content.
 * `ownerState` is the state of the component that opened it (the AlertManager's list of alerts, say), up its fibers.
 * Clicking the close button, or a content button, removes it, as closing does once the fade is over.
 */
function modal(
  content: string,
  {
    ownerState,
    buttons = [],
    aboveState,
    fadeMs = 0,
  }: { ownerState?: unknown; buttons?: string[]; aboveState?: unknown; fadeMs?: number } = {},
) {
  const root = Object.assign(document.createElement("div"), { className: "MuiModal-root" });
  const paper = document.createElement("div");
  const clicked: string[] = [];
  const button = (label: string) => {
    const element = document.createElement("button");
    element.textContent = label;
    Object.assign(element, {
      __reactProps$test: {
        onClick: () => {
          clicked.push(label || "close");
          // Closing, it fades out first (`closeAfterTransition`), still in the page.
          if (fadeMs === 0) root.remove();
          else setTimeout(() => root.remove(), fadeMs);
        },
      },
    });
    return element;
  };
  const text = document.createElement("div");
  text.innerHTML = content;
  paper.append(button(""), text, ...buttons.map(button));
  root.append(paper);
  // The modal's own fiber, then its owners': the component that opened it holds its state in its hooks.
  // Above the owner, the rest of the game's tree: `aboveState` is some ancestor's state.
  const aboveFiber = { memoizedState: hooks(aboveState ?? null), return: null };
  const ownerFiber = { memoizedState: hooks(ownerState ?? null), return: aboveFiber };
  Object.assign(root, {
    __reactFiber$test: { memoizedState: null, return: { memoizedState: null, return: ownerFiber } },
  });
  document.body.append(root);
  return { root, clicked };
}
const alertState = (count = 1) =>
  Array.from({ length: count }, (_, index) => ({
    text: `alert ${index}`,
    hash: `h${index}`,
    canBeDismissedEasily: true,
  }));

test("a game alert is closed with its own close button, and reported with its text", async () => {
  const { clicked } = modal("<p>Offline for 5 minutes. While you were offline: …</p>", { ownerState: alertState() });
  const watcher = createDialogWatcher(ns);
  await watcher.handle(Date.now() + ROUND_MS);
  expect(clicked).toEqual(["close"]);
  expect(watcher.takeReport()).toEqual({
    handled: [{ kind: "alert", text: "Offline for 5 minutes. While you were offline: …" }],
    blocking: null,
  });
  // Taken: the next report starts afresh.
  expect(watcher.takeReport()).toEqual({ handled: [], blocking: null });
});

/**
 * A queue of alerts as the AlertManager shows them: one dialog, its content swapped for the next as each is closed
 * (`alerts.slice(1)`), gone after the last.
 */
function alertQueue(texts: string[]) {
  const shown = modal(`<p>${texts[0]}</p>`, { ownerState: alertState(texts.length) });
  const closeButton = shown.root.querySelector("button") as HTMLButtonElement;
  let index = 0;
  Object.assign(closeButton, {
    __reactProps$test: {
      onClick: () => {
        index += 1;
        if (index >= texts.length) shown.root.remove();
        else (shown.root.firstElementChild?.children[1] as HTMLElement).innerHTML = `<p>${texts[index]}</p>`;
      },
    },
  });
  return shown;
}

test("a queue of alerts is closed in turn, in the one dialog that shows them, without waiting out a fade each", async () => {
  alertQueue(["first", "second", "third"]);
  const watcher = createDialogWatcher(ns);
  const startedMs = Date.now();
  await watcher.handle(Date.now() + ROUND_MS);
  expect(watcher.takeReport().handled.map((dialog) => dialog.text)).toEqual(["first", "second", "third"]);
  expect(document.querySelector(".MuiModal-root")).toBeNull();
  // Each swap is seen at once: three 400 ms fades would take over a second.
  expect(Date.now() - startedMs).toBeLessThan(800);
});
test("a faction invitation gets 'Decide later': joining is the brain's call", async () => {
  const { clicked } = modal("<h4>You received a faction invitation.</h4><p>Would you like to join Sector-12?</p>", {
    ownerState: ["Sector-12"],
    buttons: ["Join", "Decide later"],
  });
  const watcher = createDialogWatcher(ns);
  await watcher.handle(Date.now() + ROUND_MS);
  expect(clicked).toEqual(["Decide later"]);
  expect(watcher.takeReport().handled).toEqual([
    { kind: "factionInvitation", text: "You received a faction invitation.Would you like to join Sector-12?" },
  ]);
});

test("a script's prompt, or any other dialog, is left open and reported as blocking, until it goes", async () => {
  const prompt = modal("<pre><p>Buy the server?</p></pre>", {
    ownerState: { txt: "Buy the server?", resolve: () => {} },
    buttons: ["Yes", "No"],
  });
  const watcher = createDialogWatcher(ns);
  await watcher.handle(Date.now() + ROUND_MS);
  expect(prompt.clicked).toEqual([]);
  expect(watcher.takeReport()).toEqual({ handled: [], blocking: "Buy the server?" });
  prompt.root.remove();
  await watcher.handle(Date.now() + ROUND_MS);
  expect(watcher.takeReport()).toEqual({ handled: [], blocking: null });
});

test("an ancestor with an empty list in its state doesn't make a prompt an alert", async () => {
  const prompt = modal("<pre><p>Buy the server?</p></pre>", {
    ownerState: { txt: "Buy the server?", resolve: () => {} },
    aboveState: [],
    buttons: ["Yes", "No"],
  });
  const watcher = createDialogWatcher(ns);
  await watcher.handle(Date.now() + ROUND_MS);
  expect(prompt.clicked).toEqual([]);
});

test("an alert fading out after its close isn't seen again: closed and reported once", async () => {
  const alert = modal("<p>You are now in Aevum!</p>", { ownerState: alertState(), fadeMs: 195 });
  const watcher = createDialogWatcher(ns);
  await watcher.handle(Date.now() + ROUND_MS);
  expect(alert.clicked).toEqual(["close"]);
  expect(watcher.takeReport().handled).toEqual([{ kind: "alert", text: "You are now in Aevum!" }]);
});

test("a dialog's text is cut to 1,000 characters for the brain", async () => {
  modal(`<p>${"x".repeat(5_000)}</p>`, { ownerState: alertState() });
  const watcher = createDialogWatcher(ns);
  await watcher.handle(Date.now() + ROUND_MS);
  expect(watcher.takeReport().handled[0]?.text).toHaveLength(1_000);
});

test("at most 10 a round: the rest wait for the next", async () => {
  alertQueue(Array.from({ length: 15 }, (_, index) => `alert ${index}`));
  const watcher = createDialogWatcher(ns);
  await watcher.handle(Date.now() + ROUND_MS);
  expect(watcher.takeReport().handled).toHaveLength(10);
});

test("with no fast snapshot for a while (safe mode, #160), the latest 100 are kept for the next", async () => {
  alertQueue(Array.from({ length: 105 }, (_, index) => `alert ${index}`));
  const watcher = createDialogWatcher(ns);
  for (let round = 0; round < 11; round += 1) await watcher.handle(Date.now() + ROUND_MS);
  const handled = watcher.takeReport().handled.map((dialog) => dialog.text);
  expect(handled).toHaveLength(100);
  expect([handled[0], handled.at(-1)]).toEqual(["alert 5", "alert 104"]);
});

test("a script's ns.alert (the one alert made from HTML) is the owner's: left open, and reported as blocking", async () => {
  const scriptAlert = modal("<div>Your script says hello</div>", {
    ownerState: [
      {
        text: { props: { dangerouslySetInnerHTML: { __html: "Your script says hello" } } },
        hash: "h",
        canBeDismissedEasily: true,
      },
    ],
  });
  const watcher = createDialogWatcher(ns);
  await watcher.handle(Date.now() + ROUND_MS);
  expect(scriptAlert.clicked).toEqual([]);
  expect(watcher.takeReport()).toEqual({ handled: [], blocking: "Your script says hello" });
});

test("a dialog left alone first in the page doesn't stop the watcher from handling an alert after it", async () => {
  modal("<pre><p>Buy the server?</p></pre>", { ownerState: { txt: "Buy the server?", resolve: () => {} } });
  const alert = modal("<p>Offline for 5 minutes.</p>", { ownerState: alertState() });
  const watcher = createDialogWatcher(ns);
  await watcher.handle(Date.now() + ROUND_MS);
  expect(alert.clicked).toEqual(["close"]);
  expect(watcher.takeReport()).toEqual({
    handled: [{ kind: "alert", text: "Offline for 5 minutes." }],
    blocking: "Buy the server?",
  });
});

test("an invitation with no 'Decide later', or a close button that can't be clicked, is left and reported", async () => {
  modal("<h4>You received a faction invitation.</h4>", { ownerState: ["Sector-12"], buttons: ["Join"] });
  const watcher = createDialogWatcher(ns);
  await watcher.handle(Date.now() + ROUND_MS);
  expect(watcher.takeReport()).toEqual({ handled: [], blocking: "You received a faction invitation." });
  document.body.replaceChildren();
  const alert = modal("<p>Saved.</p>", { ownerState: alertState() });
  Object.assign(alert.root.querySelector("button") as HTMLButtonElement, { __reactProps$test: {} });
  await watcher.handle(Date.now() + ROUND_MS);
  expect(watcher.takeReport()).toEqual({ handled: [], blocking: "Saved." });
});

test("a dialog fading out (inert) and an open dropdown (a Popover) are neither handled nor blocking", async () => {
  const closing = modal("<p>closing</p>", { ownerState: alertState() });
  closing.root.querySelector("div")?.setAttribute("inert", "");
  const dropdown = Object.assign(document.createElement("div"), { className: "MuiPopover-root MuiModal-root" });
  dropdown.textContent = "Sector-12 Aevum";
  document.body.append(dropdown);
  const watcher = createDialogWatcher(ns);
  await watcher.handle(Date.now() + ROUND_MS);
  expect(closing.clicked).toEqual([]);
  expect(watcher.takeReport()).toEqual({ handled: [], blocking: null });
});
test("with nothing open, it does nothing", async () => {
  const watcher = createDialogWatcher(ns);
  await watcher.handle(Date.now() + ROUND_MS);
  expect(watcher.takeReport()).toEqual({ handled: [], blocking: null });
});
