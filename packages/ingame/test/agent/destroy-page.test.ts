// @vitest-environment jsdom
// Destroying the BitNode through the page (#177): the restart timer through the BitVerse, on a stand-in page with
// React's props on its elements, as the game renders them. E2 drives the real page
// (packages/e2/test/effectors.e2.test.ts).
import { afterEach, expect, test, vi } from "vitest";
import { armRestartAfterDestroy, DESTROY_STEP_LIMITS_MS, portalXpath } from "../../src/page/destroy-page.ts";
import { findOnPage } from "../../src/page/game-page.ts";
import { clicks, element, optionsInSidebar, STARTED, terminal, withProps } from "./stand-in-page.ts";

const BOOT = "agent/boot.js";
const COMMAND = "run /agent/boot.js";
/** The backdoor's time and the cinematic, as the worker allows for them. */
const BITVERSE_WITHIN_MS = 5_000;
const NAMES: Record<number, string> = {
  1: "Source Genesis",
  2: "Rise of the Underworld",
  6: "Bladeburners",
  12: "The Recursion",
};
const nameOf = (n: number) => NAMES[n] ?? `BitNode ${n}`;

/**
 * The BitVerse's map once its cinematic is done (`BitNode/ui/BitverseRoot.tsx:92-107`): every portal, as an
 * `IconButton` "O" with its `aria-label`, or with ASCII art off a `Button` with its name. A portal opens its modal,
 * whose "Enter" (`aria-label="enter-bitnode-N"`) enters the BitNode: `entered(n)` puts up what the game shows next.
 * `withEnter` false: the modal has none.
 */
function bitVerse({
  asciiArt = true,
  entered = (_n: number) => terminal(),
  withEnter = true,
}: {
  asciiArt?: boolean;
  entered?: (n: number) => void;
  withEnter?: boolean;
} = {}) {
  const map = element("div", { id: "bitverse" });
  // BitNode 12 before 1 in the page, so a label that only starts "BitNode-1" would find 12's.
  for (const n of [12, ...Array.from({ length: 15 }, (_, index) => index + 1).filter((each) => each !== 12)]) {
    const label = `BitNode-${n}: ${nameOf(n)}`;
    const openModal = () => {
      clicks.push(`portal ${n}`);
      const modal = element("div", { className: "MuiModal-root" });
      modal.append(element("h4", { textContent: label }));
      if (withEnter) {
        const enter = withProps(element("button", { textContent: `Enter BN${n}.1` }), {
          onClick: () => {
            clicks.push(`enter ${n}`);
            document.body.replaceChildren();
            entered(n);
          },
        });
        enter.setAttribute("aria-label", `enter-bitnode-${n}`);
        modal.append(enter);
      }
      document.body.append(modal);
    };
    const portal = asciiArt
      ? withProps(element("button", { textContent: "O" }), { onClick: openModal })
      : withProps(element("button"), { onClick: openModal });
    if (asciiArt) portal.setAttribute("aria-label", label);
    else portal.append(element("p", { textContent: label }));
    map.append(portal);
  }
  document.body.append(map);
}

/** BitNode 6's cinematic once typed out: its "Continue ...", which goes to the Terminal. */
function bladeburnerCinematic() {
  document.body.append(
    withProps(element("button", { textContent: "Continue ..." }), {
      onClick: () => {
        clicks.push("Continue ...");
        document.body.replaceChildren();
        terminal();
      },
    }),
  );
}

afterEach(() => {
  vi.useRealTimers();
  clicks.length = 0;
  document.body.replaceChildren();
});

test("after the backdoor, the cinematic, then the map: the next BitNode's portal, its Enter, the Terminal, the run", async () => {
  vi.useFakeTimers();
  const restart = armRestartAfterDestroy(document, BOOT, 2, BITVERSE_WITHIN_MS);
  // The backdoor and the destroy's cinematic take a while: the map shows only then.
  await vi.advanceTimersByTimeAsync(3_000);
  expect(restart.state()).toEqual({ outcome: "waiting", fallbackReason: null });
  let ran: string[] = [];
  bitVerse({
    entered: () => {
      ran = terminal().ran;
    },
  });
  await vi.advanceTimersByTimeAsync(2_000);
  expect(restart.state()).toEqual({ outcome: "started", fallbackReason: null });
  expect(clicks).toEqual(["portal 2", "enter 2"]);
  // The line typed, absolute: the terminal's directory is the owner's last `cd`.
  expect(ran).toEqual([COMMAND]);
  expect([...document.querySelectorAll("#terminal > li")].map((line) => line.textContent)).toContain(STARTED);
});

test.each([
  ["with ASCII art", true],
  ["with ASCII art off", false],
])("BitNode 1's portal %s, not BitNode 12's before it", async (_description, asciiArt) => {
  vi.useFakeTimers();
  bitVerse({ asciiArt });
  expect(
    findOnPage(document, portalXpath(1))?.getAttribute("aria-label") ??
      findOnPage(document, portalXpath(1))?.textContent,
  ).toBe("BitNode-1: Source Genesis");
  const restart = armRestartAfterDestroy(document, BOOT, 1, BITVERSE_WITHIN_MS);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(restart.state().outcome).toBe("started");
  expect(clicks).toEqual(["portal 1", "enter 1"]);
});

test("into BitNode 6: its cinematic's Continue first, then the Terminal and the run", async () => {
  vi.useFakeTimers();
  optionsInSidebar();
  const restart = armRestartAfterDestroy(document, BOOT, 6, BITVERSE_WITHIN_MS);
  bitVerse({
    entered: () => {
      // Typed out a while before its Continue shows (`ui/React/CinematicText.tsx:34`).
      setTimeout(bladeburnerCinematic, 10_000);
    },
  });
  await vi.advanceTimersByTimeAsync(12_000);
  expect(restart.state().outcome).toBe("started");
  expect(clicks).toEqual(["portal 6", "enter 6", "Continue ..."]);
});

test("no BitVerse in time (the backdoor never ended there): it stops, nothing clicked, and no reload", async () => {
  vi.useFakeTimers();
  optionsInSidebar();
  const { ran } = terminal();
  const restart = armRestartAfterDestroy(document, BOOT, 2, BITVERSE_WITHIN_MS);
  await vi.advanceTimersByTimeAsync(BITVERSE_WITHIN_MS + 30_000);
  expect(restart.state()).toEqual({
    outcome: "stopped",
    fallbackReason: "the BitVerse never showed: nothing was destroyed",
  });
  expect(clicks).toEqual([]);
  expect(ran).toEqual([]);
});

test("a portal with no Enter: the scripts are dead, so the fallback's reload", async () => {
  vi.useFakeTimers();
  optionsInSidebar();
  const restart = armRestartAfterDestroy(document, BOOT, 2, BITVERSE_WITHIN_MS);
  bitVerse({ withEnter: false });
  await vi.advanceTimersByTimeAsync(DESTROY_STEP_LIMITS_MS.enter + 2_000);
  expect(restart.state()).toEqual({ outcome: "reloading", fallbackReason: `no "Enter" in BitNode-2's portal` });
  expect(clicks).toEqual(["portal 2", "Options", "Force kill all active scripts"]);
});

test("entered, but neither the Terminal nor a Continue: the fallback once its time is up", async () => {
  vi.useFakeTimers();
  const restart = armRestartAfterDestroy(document, BOOT, 2, BITVERSE_WITHIN_MS);
  bitVerse({ entered: () => optionsInSidebar() });
  await vi.advanceTimersByTimeAsync(DESTROY_STEP_LIMITS_MS.arrive - 1_000);
  expect(restart.state().outcome).toBe("waiting");
  await vi.advanceTimersByTimeAsync(3_000);
  expect(restart.state()).toEqual({
    outcome: "reloading",
    fallbackReason: "neither the Terminal nor the cinematic's Continue",
  });
});

test("the run refused in the new BitNode: the shared fallback, as after an install", async () => {
  vi.useFakeTimers();
  const restart = armRestartAfterDestroy(document, BOOT, 2, BITVERSE_WITHIN_MS);
  bitVerse({
    entered: () => {
      optionsInSidebar();
      terminal({ answer: () => "Script agent/boot.js does not exist on home." });
    },
  });
  await vi.advanceTimersByTimeAsync(3_000);
  expect(restart.state()).toEqual({
    outcome: "reloading",
    fallbackReason: "the terminal said: Script agent/boot.js does not exist on home.",
  });
});

test("one timer at a time: a second armed disarms the first, so the BitVerse's Enter is clicked once", async () => {
  vi.useFakeTimers();
  const first = armRestartAfterDestroy(document, BOOT, 2, BITVERSE_WITHIN_MS);
  const second = armRestartAfterDestroy(document, BOOT, 2, BITVERSE_WITHIN_MS);
  expect(first.state().outcome).toBe("disarmed");
  bitVerse();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(second.state().outcome).toBe("started");
  expect(clicks).toEqual(["portal 2", "enter 2"]);
});

test("disarmed (the backdoor didn't start): it stops, and the map, were it to show, isn't touched", async () => {
  vi.useFakeTimers();
  const restart = armRestartAfterDestroy(document, BOOT, 2, BITVERSE_WITHIN_MS);
  restart.disarm();
  bitVerse();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(restart.state().outcome).toBe("disarmed");
  expect(clicks).toEqual([]);
});
