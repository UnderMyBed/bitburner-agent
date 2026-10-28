// The Agent's dialog watcher (#143, owner decision 35): the game's routine dialogs are handled, so unattended play
// doesn't stall on them, and what they said goes to the brain.
// - A game alert (`ui/React/AlertManager.tsx`: "Offline for…", purchase and install notices, a script's `ns.alert`):
//   closed with its own close button, the first button in the dialog (`ui/React/Modal.tsx`). It's recognized by the
//   AlertManager's own React state, a list of `{ text, hash, canBeDismissedEasily }`, never by a component's name: a
//   production build minifies those.
// - A faction invitation (`Faction/ui/FactionInvitationManager.tsx`): "Decide later". The invitation stays on the
//   Factions page; joining is the brain's call.
// - Anything else (a script's prompt, a modal the player opened, one it doesn't know) is left alone, and reported.
// It reaches the page with `eval("document")`, as the `ui` effectors do (../page/game-page.ts), so it costs no RAM.
import { type HandledDialog, MAX_DIALOG_TEXT_LENGTH } from "@bitburner-agent/core";
import type { NS } from "../ns.ts";
import { openGamePage, type ReactFiber, reactFiberOf } from "../page/game-page.ts";

/** The most dialogs handled in one round: alerts come in a queue, one shown at a time. */
const MOST_DIALOGS_A_ROUND = 10;
/** How far up the fibers the component that opened a dialog is looked for: a few MUI layers sit between. */
const MOST_FIBERS_UP = 40;
/** How many of a component's hooks are looked at: the AlertManager keeps its alerts in its first. */
const MOST_HOOKS = 5;
const INVITATION_HEADING = "You received a faction invitation.";

/** Whether some component above `dialog` holds the AlertManager's state: a list of alerts, each with its hash. */
function isGameAlert(dialog: Element): boolean {
  let fiber: ReactFiber | null = reactFiberOf(dialog);
  for (let up = 0; fiber !== null && up < MOST_FIBERS_UP; up += 1, fiber = fiber.return) {
    let hook = fiber.memoizedState as { memoizedState?: unknown; next?: unknown } | null;
    for (let index = 0; hook && typeof hook === "object" && index < MOST_HOOKS; index += 1) {
      const state = hook.memoizedState;
      const isAlertList =
        Array.isArray(state) &&
        state.length > 0 &&
        state.every(
          (each) => typeof each === "object" && each !== null && "hash" in each && "canBeDismissedEasily" in each,
        );
      if (isAlertList) return true;
      hook = hook.next as typeof hook;
    }
  }
  return false;
}

/** What a dialog says, without its buttons' labels, cut short for the brain. */
function textOf(dialog: Element): string {
  const copy = dialog.cloneNode(true) as Element;
  for (const button of copy.querySelectorAll("button")) button.remove();
  return (copy.textContent ?? "").trim().slice(0, MAX_DIALOG_TEXT_LENGTH);
}

export function createDialogWatcher(ns: NS) {
  let handled: HandledDialog[] = [];
  let blocking: string | null = null;

  return {
    /** Handles the dialogs open now, in the page's order, within `deadlineMs`. */
    async handle(deadlineMs: number): Promise<void> {
      blocking = null;
      const gamePage = openGamePage(ns, deadlineMs);
      if (gamePage === null) return;
      for (let count = 0; count < MOST_DIALOGS_A_ROUND && !gamePage.timeUp(); count += 1) {
        // The first one this watcher can handle: those it leaves alone stay first, so they're skipped.
        const dialogs = gamePage.openDialogs();
        let acted = false;
        for (const dialog of dialogs) {
          const text = textOf(dialog);
          const kind = text.startsWith(INVITATION_HEADING) ? "factionInvitation" : isGameAlert(dialog) ? "alert" : null;
          if (kind === null) {
            blocking ??= text;
            continue;
          }
          const button =
            kind === "factionInvitation"
              ? [...dialog.querySelectorAll("button")].find((each) => each.textContent?.trim() === "Decide later")
              : dialog.querySelector("button");
          if (!button) {
            blocking ??= text;
            continue;
          }
          const problem = await gamePage.clickElement(
            button,
            kind === "alert" ? "the alert's close button" : "Decide later",
          );
          if (problem !== null) {
            blocking ??= text;
            continue;
          }
          handled.push({ kind, text });
          // Closed, it fades before it leaves: wait, so it isn't seen again, and the next in the queue can show.
          await gamePage.waitUntilGone(dialog);
          acted = true;
          break;
        }
        if (!acted) return;
        // Looked at afresh: what's open now, after the next one shows.
        blocking = null;
      }
    },

    /** What's been handled since the last report, and what's left open: for the fast snapshot. */
    takeReport(): { handled: HandledDialog[]; blocking: string | null } {
      const report = { handled, blocking };
      handled = [];
      return report;
    },
  };
}
