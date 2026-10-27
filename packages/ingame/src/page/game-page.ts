// The game's own page, driven from in-game code (#136): the `ui` effector's means (architecture §5.6), for what has no
// API before Singularity. The rules of engagement allow the page's DOM and React state from in-game scripts.
// - The page is reached with `eval("document")`. The game charges 25 GB for the identifiers `document` and `window`,
//   so neither appears anywhere in this code.
// - A click calls the element's React `onClick` with `{ isTrusted: true }`, and the terminal takes React's own
//   `onChange` and `onKeyDown`, as the legacy fork does. So a hidden element (a collapsed menu) still works, as long as
//   it's in the page.
// - Every wait ends by the caller's deadline: a worker that drives the page ends within its Agent's round, like any
//   other. The steps end a little before it, so the way back to the Terminal always has its own time, however long a
//   step waited for what never came. Waits are `ns.asleep`, which doesn't mark the script busy.
import type { NS } from "../ns.ts";

/** How often a wait for an element looks again, and how long a click is given to render. */
const POLL_MS = 50;
/** The end of the caller's time kept for the way back to the Terminal: a few renders. */
const RETURN_RESERVE_MS = 300;
/** Any modal open: the game's alerts and prompts (`ui/React/Modal.tsx`, MUI's `Modal`). */
const OPEN_DIALOG_XPATH = "//div[contains(concat(' ', @class, ' '), ' MuiModal-root ')]";

/** React's props on a rendered element: the key React gives it starts with `__reactProps`. */
function reactPropsOf(element: Element): Record<string, unknown> | null {
  const key = Object.keys(element).find((each) => each.startsWith("__reactProps"));
  return key ? ((element as unknown as Record<string, Record<string, unknown>>)[key] ?? null) : null;
}

/**
 * The game's page, for one worker's work until `deadlineMs` (the game's `Date.now()`), or null where there's no page.
 * Each step returns its problem, or null once it's done.
 */
export function openGamePage(ns: NS, deadlineMs: number) {
  let page: Document | undefined;
  try {
    // biome-ignore lint/security/noGlobalEval: the only way to the page that the game doesn't charge 25 GB for (see above).
    page = eval("document") as Document | undefined;
  } catch {
    return null;
  }
  if (!page?.evaluate) return null;
  const gamePage = page;

  const findElement = (xpath: string): Element | null =>
    gamePage.evaluate(xpath, gamePage, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null)
      .singleNodeValue as Element | null;
  /** When the steps end; the way back to the Terminal has until `deadlineMs`. */
  const stepsEndMs = deadlineMs - RETURN_RESERVE_MS;
  const timeLeftMs = (untilMs: number) => untilMs - Date.now();
  /** Lets the page render after an action, without passing the deadline. */
  const letRender = () => ns.asleep(Math.max(0, Math.min(POLL_MS, timeLeftMs(deadlineMs))));

  /** The element, once it's in the page, or null if it isn't by `untilMs`. It always looks at least once. */
  async function waitForElement(xpath: string, untilMs: number): Promise<Element | null> {
    for (;;) {
      const element = findElement(xpath);
      if (element) return element;
      if (timeLeftMs(untilMs) <= 0) return null;
      await ns.asleep(Math.min(POLL_MS, timeLeftMs(untilMs)));
    }
  }

  /** Waits for the element, `what` (named for the problem), and clicks it as a player would, then lets it render. */
  async function clickWhenThere(xpath: string, what: string, untilMs = stepsEndMs): Promise<string | null> {
    const element = await waitForElement(xpath, untilMs);
    if (!element) return `no ${what}`;
    const onClick = reactPropsOf(element)?.onClick;
    if (typeof onClick !== "function") return `can't click ${what}`;
    await onClick({ isTrusted: true, preventDefault: () => {}, stopPropagation: () => {} });
    await letRender();
    return null;
  }

  /**
   * Opens one of the sidebar's pages ("Terminal", "City"). The sidebar's items are list buttons labelled with the
   * page's name (`Sidebar/ui/SidebarItem.tsx`), in sections that unmount their items when collapsed.
   */
  function openSidebarPage(pageName: string, untilMs: number): Promise<string | null> {
    return clickWhenThere(
      `//div[@role='button' and .//p[normalize-space()='${pageName}']]`,
      `"${pageName}" in the sidebar (is its section collapsed?)`,
      untilMs,
    );
  }

  return {
    clickWhenThere,

    /** Whether a dialog is open: the owner's to read and close, so nothing is done over it. */
    dialogOpen(): boolean {
      return findElement(OPEN_DIALOG_XPATH) !== null;
    },

    openSidebarPage: (pageName: string) => openSidebarPage(pageName, stepsEndMs),

    /**
     * Opens one of the city's locations (a tech vendor, say): the City page, then the location, as the ASCII map's
     * labelled letter or, with ASCII art off, a button (`Locations/ui/City.tsx`).
     */
    async openCityLocation(location: string): Promise<string | null> {
      return (
        (await openSidebarPage("City", stepsEndMs)) ??
        (await clickWhenThere(
          `//span[@aria-label='${location}'] | //button[normalize-space()='${location}']`,
          `${location} in the city`,
        ))
      );
    },

    /** Back to the Terminal, with the time kept for it: the last step of anything that moved the page. */
    returnToTerminal: () => openSidebarPage("Terminal", deadlineMs),

    /**
     * Types `command` into the terminal and runs it, as a player would. The Terminal page must be open. A line the
     * owner has started typing is theirs: then nothing is typed.
     */
    async runTerminalCommand(command: string): Promise<string | null> {
      const terminalInput = (await waitForElement("//*[@id='terminal-input']", stepsEndMs)) as HTMLInputElement | null;
      if (!terminalInput) return "no terminal on the page";
      if (terminalInput.value !== "") return "the terminal has a line typed in it";
      const onChange = reactPropsOf(terminalInput)?.onChange;
      if (typeof onChange !== "function") return "the terminal can't be typed into";
      terminalInput.value = command;
      onChange({ target: terminalInput });
      await letRender();
      // Read only now: the game's Enter handler runs the line its last render saw (`Terminal/ui/TerminalInput.tsx`),
      // so the one from before the line was typed would run an empty line.
      const onKeyDown = reactPropsOf(terminalInput)?.onKeyDown;
      if (typeof onKeyDown !== "function") return "the terminal can't be typed into";
      await onKeyDown({ key: "Enter", preventDefault: () => {}, stopPropagation: () => {} });
      await letRender();
      return null;
    },
  };
}

export type GamePage = NonNullable<ReturnType<typeof openGamePage>>;
