// The game's own page, driven from in-game code (#136): the `ui` effector's means (architecture §5.6), for what has no
// API before Singularity. The rules of engagement allow the page's DOM and React state from in-game scripts.
// - The page is reached with `eval("document")`. The game charges 25 GB for the identifiers `document` and `window`,
//   so neither appears anywhere in this code.
// - A click calls the element's React `onClick` with `{ isTrusted: true }`, and the terminal takes React's own
//   `onChange` and `onKeyDown`, as the legacy fork does. So a hidden element (a collapsed menu) still works, as long as
//   it's in the page.
// - Every wait is `ns.asleep`, which doesn't mark the script busy (packages/ingame/README.md, "The Agent"), and none
//   goes past the caller's deadline: a worker that drives the page ends within its Agent's round, like any other.
import type { NS } from "../ns.ts";

/** How often a wait for an element looks again, and how long a click is given to render. */
const POLL_MS = 50;

/** React's props on a rendered element: the key React gives it starts with `__reactProps`. */
function reactPropsOf(element: Element): Record<string, unknown> | null {
  const key = Object.keys(element).find((each) => each.startsWith("__reactProps"));
  return key ? ((element as unknown as Record<string, Record<string, unknown>>)[key] ?? null) : null;
}

/**
 * The game's page, for one worker's work until `deadlineMs` (the game's `Date.now()`), or null where there's no page.
 * Each step returns its problem, or null once it's done; an element that never appears is a problem at the deadline.
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

  /** The element, once it's in the page, or null at the deadline. */
  async function waitForElement(xpath: string): Promise<Element | null> {
    for (;;) {
      const element = findElement(xpath);
      if (element) return element;
      if (Date.now() + POLL_MS >= deadlineMs) return null;
      await ns.asleep(POLL_MS);
    }
  }

  /** Waits for the element and clicks it as a player would, then lets the page render. */
  async function clickWhenThere(xpath: string, what: string): Promise<string | null> {
    const element = await waitForElement(xpath);
    if (!element) return `no ${what} on the page`;
    const onClick = reactPropsOf(element)?.onClick;
    if (typeof onClick !== "function") return `the ${what} can't be clicked`;
    await onClick({ isTrusted: true, preventDefault: () => {}, stopPropagation: () => {} });
    await ns.asleep(POLL_MS);
    return null;
  }

  return {
    clickWhenThere,

    /**
     * Opens one of the sidebar's pages ("Terminal", "City"). The sidebar's items are list buttons labelled with the
     * page's name (`Sidebar/ui/SidebarItem.tsx`).
     */
    openSidebarPage(pageName: string): Promise<string | null> {
      return clickWhenThere(
        `//div[@role='button' and .//p[normalize-space()='${pageName}']]`,
        `"${pageName}" in the sidebar (is its section collapsed?)`,
      );
    },

    /** Types `command` into the terminal and runs it, as a player would. The Terminal page must be open. */
    async runTerminalCommand(command: string): Promise<string | null> {
      const terminalInput = (await waitForElement("//*[@id='terminal-input']")) as HTMLInputElement | null;
      if (!terminalInput) return "no terminal on the page";
      const props = reactPropsOf(terminalInput);
      const onChange = props?.onChange;
      const onKeyDown = props?.onKeyDown;
      if (typeof onChange !== "function" || typeof onKeyDown !== "function") return "the terminal can't be typed into";
      terminalInput.value = command;
      onChange({ target: terminalInput });
      await onKeyDown({ key: "Enter", preventDefault: () => {}, stopPropagation: () => {} });
      await ns.asleep(POLL_MS);
      return null;
    },
  };
}

export type GamePage = NonNullable<ReturnType<typeof openGamePage>>;
