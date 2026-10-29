// The game's own page, driven from in-game code (#136): the `ui` effector's means (architecture §5.6), for what has no
// API before Singularity. The rules of engagement allow the page's DOM and React state from in-game scripts.
// - The page is reached with `globalThis.eval("document")`: an indirect eval, run in the global scope. The game charges
//   25 GB for the identifiers `document` and `window`, so neither appears anywhere in this code.
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
/** The longest a closed dialog stays in the page while it fades out: MUI's `Fade`, 195 ms, and a render. */
const DIALOG_FADE_MS = 400;
/**
 * Any dialog open: the game's alerts and prompts (`ui/React/Modal.tsx`, MUI's `Modal`). Not an open dropdown (a
 * select or a menu): MUI makes those of a `Popover`, whose root is a `Modal`'s too.
 */
const OPEN_DIALOG_XPATH =
  "//div[contains(concat(' ', @class, ' '), ' MuiModal-root ') and not(contains(concat(' ', @class, ' '), ' MuiPopover-root '))]";

/**
 * `text` as an XPath string literal, for matching it exactly: in single quotes, or double, or, with both in it, a
 * `concat` (#149: augmentation names have apostrophes, "The Shadow's Simulacrum").
 */
export function xpathString(text: string): string {
  if (!text.includes("'")) return `'${text}'`;
  if (!text.includes('"')) return `"${text}"`;
  return `concat('${text.split("'").join(`', "'", '`)}')`;
}

/** An XPath predicate: the element has the class `name` among its classes. */
export const hasClass = (name: string) => `contains(concat(' ', @class, ' '), ' ${name} ')`;

/**
 * The button labelled `label` on `faction`'s row of the Factions page (`Faction/ui/FactionsRoot.tsx`), in `section`:
 * `factions-invites` ("Join!", #147) or `factions-joined` ("Augments", #149). Each row is a `Paper` naming its faction.
 */
export const factionRowButtonXpath = (section: string, faction: string, label: string) =>
  `//span[${hasClass(section)}]//div[${hasClass("MuiPaper-root")} and .//span[normalize-space()=${xpathString(faction)}]]` +
  `//button[normalize-space()=${xpathString(label)}]`;

/** The terminal's input line (`Terminal/ui/TerminalInput.tsx`, its `id` "for players to hook in"). */
const TERMINAL_INPUT_XPATH = "//*[@id='terminal-input']";

/**
 * What a terminal effector reports while the terminal runs an action (a backdoor, a hack, #162): the game disables the
 * input until it ends (`Terminal/ui/TerminalInput.tsx:442`), and refuses any command meanwhile (`Terminal.ts:707`).
 */
const TERMINAL_BUSY = "terminal busy";

/** The Work page's button that unfocuses the player. */
const UNFOCUS_XPATH = "//button[normalize-space()='Do something else simultaneously']";

/** React's props on a rendered element: the key React gives it starts with `__reactProps`. */
export function reactPropsOf(element: Element): Record<string, unknown> | null {
  const key = Object.keys(element).find((each) => each.startsWith("__reactProps"));
  return key ? ((element as unknown as Record<string, Record<string, unknown>>)[key] ?? null) : null;
}

/** A React fiber, as far as this code reads one: its hooks' state, its props, and the fiber above it. */
export interface ReactFiber {
  memoizedState: unknown;
  memoizedProps?: unknown;
  return: ReactFiber | null;
}

/** React's fiber for a rendered element: the key React gives it starts with `__reactFiber`. */
export function reactFiberOf(element: Element): ReactFiber | null {
  const key = Object.keys(element).find((each) => each.startsWith("__reactFiber"));
  return key ? ((element as unknown as Record<string, ReactFiber>)[key] ?? null) : null;
}

/**
 * The props of the nearest component above `element` (itself included) that has a prop named `propName`, or null. For
 * what a component holds but doesn't render, such as a closed tooltip's title (#151).
 */
export function reactPropsAbove(element: Element, propName: string): Record<string, unknown> | null {
  for (let fiber = reactFiberOf(element); fiber !== null; fiber = fiber.return) {
    const props = fiber.memoizedProps;
    if (typeof props === "object" && props !== null && propName in props) return props as Record<string, unknown>;
  }
  return null;
}

/** The text a React node would render: strings and numbers, through elements' children, whitespace collapsed. */
export function reactText(node: unknown): string {
  const collect = (each: unknown): string => {
    if (typeof each === "string" || typeof each === "number") return String(each);
    if (Array.isArray(each)) return each.map(collect).join("");
    if (typeof each === "object" && each !== null && "props" in each) {
      return collect((each as { props: { children?: unknown } }).props.children);
    }
    return "";
  };
  return collect(node).replace(/\s+/g, " ").trim();
}

/**
 * The game's page document, or null where there's none (the simulator's page has no `evaluate`). It needs no `ns`, so
 * the install's page timer can use it after its script has died (./install-page.ts, #167).
 */
export function pageDocument(): Document | null {
  let page: Document | undefined;
  try {
    // Indirect, not a bare `eval`: the bundler then keeps its freedom to rename. A direct `eval` could see every name in
    // reach, so esbuild keeps those and renames other modules' instead (`main(ns)` became `main(ns2)`).
    // biome-ignore lint/security/noGlobalEval: the only way to the page that the game doesn't charge 25 GB for (see above).
    page = globalThis.eval("document") as Document | undefined;
  } catch {
    return null;
  }
  return page?.evaluate ? page : null;
}

/** The first element `xpath` finds in `page`, or null. */
export const findOnPage = (page: Document, xpath: string): Element | null =>
  page.evaluate(xpath, page, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as Element | null;

/** Every element `xpath` finds in `page`, in the page's order. */
function findAllOnPage(page: Document, xpath: string): Element[] {
  const found = page.evaluate(xpath, page, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
  return Array.from({ length: found.snapshotLength }, (_, index) => found.snapshotItem(index) as Element);
}

/** The sidebar's item for one of the game's pages: a list button with its name (`Sidebar/ui/SidebarItem.tsx`). */
export const sidebarItemXpath = (pageName: string) => `//div[@role='button' and .//p[normalize-space()='${pageName}']]`;

/** A React handler's event, as a player's would be: trusted, with the methods handlers call, and any `fields`. */
export const playerEvent = (fields: Record<string, unknown> = {}) => ({
  isTrusted: true,
  preventDefault: () => {},
  stopPropagation: () => {},
  ...fields,
});

/**
 * The game's page, for one worker's work until `deadlineMs` (the game's `Date.now()`), or null where there's no page.
 * Each step returns its problem, or null once it's done.
 */
export function openGamePage(ns: NS, deadlineMs: number) {
  const gamePage = pageDocument();
  if (gamePage === null) return null;

  const findElement = (xpath: string): Element | null => findOnPage(gamePage, xpath);
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

  /** Clicks `element`, `what`, as a player would, then lets it render. */
  async function click(element: Element, what: string): Promise<string | null> {
    const onClick = reactPropsOf(element)?.onClick;
    if (typeof onClick !== "function") return `can't click ${what}`;
    await onClick(playerEvent());
    await letRender();
    return null;
  }

  /** Clicks the element, `what`, if it's in the page now; `problem` is null unless it was there and couldn't be. */
  async function clickIfThereNow(xpath: string, what: string): Promise<{ clicked: boolean; problem: string | null }> {
    const element = findElement(xpath);
    if (!element) return { clicked: false, problem: null };
    const problem = await click(element, what);
    return { clicked: problem === null, problem };
  }

  /** Waits for the element, `what` (named for the problem), and clicks it. */
  async function clickWhenThere(xpath: string, what: string, untilMs = stepsEndMs): Promise<string | null> {
    const element = await waitForElement(xpath, untilMs);
    return element ? click(element, what) : `no ${what}`;
  }

  /**
   * Opens one of the sidebar's pages ("Terminal", "City"). The sidebar's items are list buttons labelled with the
   * page's name (`Sidebar/ui/SidebarItem.tsx`), in sections that unmount their items when collapsed.
   */
  function openSidebarPage(pageName: string, untilMs: number): Promise<string | null> {
    return clickWhenThere(
      sidebarItemXpath(pageName),
      `"${pageName}" in the sidebar (is its section collapsed?)`,
      untilMs,
    );
  }

  return {
    clickWhenThere,

    /** The element, once it's in the page, or null by the steps' end: for reading it before acting on it. */
    findWhenThere: (xpath: string) => waitForElement(xpath, stepsEndMs),

    /** The element if it's in the page now, without waiting, or null. */
    findElementNow: findElement,

    /** Every element `xpath` finds in the page now, in the page's order (#197). */
    findAllNow: (xpath: string): Element[] => findAllOnPage(gamePage, xpath),

    /** Every dialog open now, in the page's order (MUI's `Modal` roots, `ui/React/Modal.tsx`). */
    openDialogs: (): Element[] => findAllOnPage(gamePage, OPEN_DIALOG_XPATH),

    /** Clicks `element`, `what`, as a player would. */
    clickElement: click,

    /**
     * Waits until `element` has left the page, or what `currentText` reads of it is no longer `textBefore`, up to the
     * time a dialog's fade takes: true once either happens. A dialog closed stays in the page while it fades out; one
     * with more queued shows the next in place.
     */
    async waitUntilGoneOrChanged(element: Element, currentText: () => string, textBefore: string): Promise<boolean> {
      const fadeEndsMs = Math.min(Date.now() + DIALOG_FADE_MS, deadlineMs);
      while (element.isConnected && currentText() === textBefore) {
        if (timeLeftMs(fadeEndsMs) <= 0) return false;
        await ns.asleep(Math.min(POLL_MS, timeLeftMs(fadeEndsMs)));
      }
      return true;
    },

    /** Whether the caller's time is up. */
    timeUp: () => timeLeftMs(deadlineMs) <= 0,

    /**
     * Clicks the element, `what`, if it's in the page now: for a step the game may skip, such as a confirmation the
     * player's Options turn off. `problem` is null unless it was there and couldn't be clicked.
     */
    clickIfThere: (xpath: string, what: string) => clickIfThereNow(xpath, what),

    /** Lets the page render, without passing the steps' end: for a step that waits on the game. */
    waitARender: () => ns.asleep(Math.max(0, Math.min(POLL_MS, timeLeftMs(stepsEndMs)))),

    /** Whether the steps' time is up (the way back to the Terminal has its own). */
    stepsTimeUp: () => timeLeftMs(stepsEndMs) <= 0,

    /**
     * Whether a dialog is open, and stays open: the owner's to read and close, so nothing is done over it. One that's
     * just been closed stays in the page while it fades out (`ui/React/Modal.tsx`, `closeAfterTransition`), so it's
     * given that long to go.
     */
    async dialogStaysOpen(): Promise<boolean> {
      const fadeEndsMs = Math.min(Date.now() + DIALOG_FADE_MS, stepsEndMs);
      while (findElement(OPEN_DIALOG_XPATH) !== null) {
        if (timeLeftMs(fadeEndsMs) <= 0) return true;
        await ns.asleep(Math.min(POLL_MS, timeLeftMs(fadeEndsMs)));
      }
      return false;
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
          `//span[@aria-label=${xpathString(location)}] | //button[normalize-space()=${xpathString(location)}]`,
          `${location} in the city`,
        ))
      );
    },

    /** Unfocuses the player from the Work page (`ui/WorkInProgressRoot.tsx:533-534`): clicked only if it's there. */
    unfocusWork: () => clickIfThereNow(UNFOCUS_XPATH, 'the Work page\'s "Do something else simultaneously"'),

    /** Back to the Terminal, with the time kept for it: the last step of anything that moved the page. */
    returnToTerminal: () => openSidebarPage("Terminal", deadlineMs),

    /**
     * Focused on the current work again, with the time kept for it: the overview's "Focus"
     * (`ui/React/CharacterOverview.tsx:248-281`), which opens the Work page.
     */
    refocusWork: () =>
      clickWhenThere("//button[normalize-space()='Focus']", '"Focus" on the overview\'s work', deadlineMs),

    /**
     * Whether the terminal runs an action now (its input disabled), or null with no terminal on the page: the Terminal
     * page must be open.
     */
    terminalBusy(): boolean | null {
      const terminalInput = findElement(TERMINAL_INPUT_XPATH) as HTMLInputElement | null;
      return terminalInput === null ? null : terminalInput.disabled;
    },

    /**
     * Types `command` into the terminal and runs it, as a player would. The Terminal page must be open. A line the
     * owner has started typing is theirs: then nothing is typed. Nor while the terminal is busy with an action (#162),
     * which the game would refuse: `TERMINAL_BUSY`, for the next try.
     */
    async runTerminalCommand(command: string): Promise<string | null> {
      const terminalInput = (await waitForElement(TERMINAL_INPUT_XPATH, stepsEndMs)) as HTMLInputElement | null;
      if (!terminalInput) return "no terminal on the page";
      if (terminalInput.disabled) return TERMINAL_BUSY;
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
      await onKeyDown(playerEvent({ key: "Enter" }));
      await letRender();
      return null;
    },
  };
}

export type GamePage = NonNullable<ReturnType<typeof openGamePage>>;
