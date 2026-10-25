// The game's Router without React. GameRoot (src/ui/GameRoot.tsx) builds the real one when it renders; headless it
// never renders, so the game would keep its pre-mount stub: always on the loading screen, hiding messages, refusing
// every navigation. Game logic reads the page (Singularity's isBusy, ns.spawn, Bladeburner, message delivery), and
// navigating has side effects, so this reproduces GameRoot's routing: the same page state, history and side effects.
//
// React 17 (ReactDOM.render, index.tsx) re-renders synchronously when state is set outside a React event handler,
// which is how game logic and scripts navigate. So the real Router.page() changes as soon as toPage returns, and a
// plain synchronous router matches it. Bundled with the game (see entry.ts); keep it in step with GameRoot.tsx.
// docs/sim/parity.md lists what it covers.
import { calculateAchievements } from "../../../../../vendor/bitburner-src/src/Achievements/Achievements";
import { isBitNodeFinished } from "../../../../../vendor/bitburner-src/src/BitNode/BitNodeUtils";
import { LocationName } from "../../../../../vendor/bitburner-src/src/Enums";
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

export interface BitVerseReached {
  flume: boolean;
  /** The BitNode the player is leaving: the one the BitVerse page shows as destroyed (`Player.bitNodeN`). */
  destroyedBitNode: number;
}

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

/**
 * What GameRoot does when it first renders: choose the start page and take over from the pre-mount stub. The stub's
 * methods are replaced in place, because game modules hold the stub object itself. `onBitVerse` hears every arrival
 * at the BitVerse page, including a game that starts there.
 */
export function mountRouter(onBitVerse: (reached: BitVerseReached) => void): void {
  let pages: PageWithContext[] = [startPage()];
  let allowRoutingCalls = true;
  const current = () => pages[0];
  const arrived = (page: PageWithContext) => {
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
      if (pages.length > 1) pages = pages.slice(1);
    },
  });
  arrived(current());
}
