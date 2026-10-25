// The game's Router without React. GameRoot (src/ui/GameRoot.tsx) builds the real one when it renders; headless it
// never renders, so the game would keep its pre-mount stub: always on the loading screen, hiding messages, queueing
// every navigation unused. Game logic reads the page (Singularity's isBusy, ns.spawn, Bladeburner, message delivery),
// and navigating has side effects, so this reproduces GameRoot's routing: the same page state, history and side
// effects, plus the one page component that navigates by itself (the Work page).
//
// React 17's ReactDOM.render (index.tsx) re-renders synchronously when state is set outside React's batching (event
// handlers, unstable_batchedUpdates, render and effects), and that's how game logic and scripts navigate. So the real
// Router.page() has changed by the time toPage returns, and a plain synchronous router matches it.
//
// Mirrors GameRoot.tsx at v3.0.1: MAX_PAGES_IN_HISTORY (:99), determineStartPage (:152-173), hiddenPages and the
// Router itself (:238-291). test/router.test.ts checks the copied constants against the game's source, so a version
// bump that changes them fails loudly; docs/sim/parity.md §2 lists every behaviour and its test. Bundled with the game
// (entry.ts), so the repo's tsc doesn't check this file: keep it small.
import { calculateAchievements } from "../../../../../vendor/bitburner-src/src/Achievements/Achievements";
import { isBitNodeFinished } from "../../../../../vendor/bitburner-src/src/BitNode/BitNodeUtils";
import { LocationName } from "../../../../../vendor/bitburner-src/src/Enums";
import { GameCycleEvents } from "../../../../../vendor/bitburner-src/src/engine";
import { prestigeWorkerScripts } from "../../../../../vendor/bitburner-src/src/NetscriptWorker";
import { Player } from "../../../../../vendor/bitburner-src/src/Player";
import { Router } from "../../../../../vendor/bitburner-src/src/ui/GameRoot";
import { ActivateRecoveryMode, RecoveryMode } from "../../../../../vendor/bitburner-src/src/ui/React/RecoveryRoot";
import {
  type ComplexPage,
  Page,
  type PageContext,
  type PageWithContext,
} from "../../../../../vendor/bitburner-src/src/ui/Router";
import type { BitVerseReached } from "../../protocol.ts";

const MAX_PAGES_IN_HISTORY = 10;
const hiddenPages = new Set<Page>([
  Page.Recovery,
  Page.ImportSave,
  Page.BitVerse,
  Page.Infiltration,
  Page.BladeburnerCinematic,
]);

/** GameRoot's determineStartPage. */
function startPage(): PageWithContext {
  if (RecoveryMode) return { page: Page.Recovery };
  try {
    if (isBitNodeFinished()) return { page: Page.BitVerse, flume: false, quick: true };
  } catch (error) {
    ActivateRecoveryMode(error);
    return { page: Page.Recovery };
  }
  if (Player.currentWork !== null) return { page: Page.Work };
  return { page: Page.Terminal };
}

let pages: PageWithContext[] = [];

/** The page history, newest first, as page names. Not saved by the game, so the state hash adds it. */
export function routerPages(): string[] {
  return pages.map(({ page }) => page);
}

/**
 * The Work page (WorkInProgressRoot.tsx:184-207) re-renders after every game cycle. Whenever it renders with no work in
 * progress, it goes back to the Terminal on the next tick: after `ns.singularity.stopAction()`, finished work, and so on.
 */
function renderWorkPage(): void {
  if (Player.currentWork !== null) return;
  setTimeout(() => {
    if (Player.currentWork === null) Router.toPage(Page.Terminal);
  });
}
let unsubscribeWorkPage: (() => void) | null = null;

/** Mounts or unmounts the Work page as the current page changes; mounting renders it. */
function showPage(page: Page): void {
  if (page === Page.Work) {
    unsubscribeWorkPage ??= GameCycleEvents.subscribe(renderWorkPage);
    renderWorkPage();
  } else if (unsubscribeWorkPage) {
    unsubscribeWorkPage();
    unsubscribeWorkPage = null;
  }
}

/**
 * What GameRoot does when it first renders: choose the start page and take over from the pre-mount stub. The stub's
 * methods are replaced in place: only GameRoot's own module can reassign its exported `Router`. `onBitVerse` hears
 * every arrival at the BitVerse page, including a game that starts there.
 */
export function mountRouter(onBitVerse: (reached: BitVerseReached) => void): void {
  pages = [startPage()];
  let allowRoutingCalls = true;
  const current = () => pages[0];
  const arrived = (page: PageWithContext) => {
    showPage(page.page);
    if (page.page === Page.BitVerse) onBitVerse({ flume: page.flume, destroyedBitNode: Player.bitNodeN });
  };

  Object.assign(Router, {
    page: () => current().page,
    allowRouting: (value: boolean) => {
      allowRoutingCalls = value;
    },
    hidingMessages: () => hiddenPages.has(current().page),
    toPage: (page: Page, context?: PageContext<ComplexPage>) => {
      if (!allowRoutingCalls) return console.error("Routing is currently disabled - Attempted router.toPage()");
      // GameRoot also tells an open Options page to switch tabs; only that page listens, and it never renders here.
      switch (page) {
        case Page.Travel:
          Player.gotoLocation(LocationName.TravelAgency);
          break;
        case Page.BitVerse:
          prestigeWorkerScripts();
          calculateAchievements();
          break;
      }
      // Leaving the Work page ends focus; GameRoot does this centrally rather than at every toPage call.
      if (current().page === Page.Work && page !== Page.Work && Player.currentWork && Player.focus) {
        Player.stopFocusing();
      }
      const next = { page, ...context } as PageWithContext;
      pages = [next, ...pages].slice(0, MAX_PAGES_IN_HISTORY);
      arrived(next);
    },
    back: () => {
      if (!allowRoutingCalls) return console.error("Routing is currently disabled - Attempted router.back()");
      if (pages.length > 1) {
        pages = pages.slice(1);
        showPage(current().page);
      }
    },
  });
  arrived(current());
}
