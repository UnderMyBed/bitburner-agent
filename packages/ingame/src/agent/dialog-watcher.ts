// The Agent's dialog watcher (#143, owner decision 35): the game's routine dialogs are handled, so unattended play
// doesn't stall on them, and what they said goes to the brain.
// - A game alert (`ui/React/AlertManager.tsx`: "Offline for…", purchase, travel and install notices, the
//   congratulations): closed with its own close button, the first button in the dialog (`ui/React/Modal.tsx`). It's
//   recognized by the AlertManager's own React state, a list of `{ text, hash, canBeDismissedEasily }`, never by a
//   component's name: a production build minifies those.
// - A faction invitation (`Faction/ui/FactionInvitationManager.tsx`): "Decide later". The invitation stays on the
//   Factions page; joining is the brain's call.
// - Anything else is left alone, and reported: a dialog a script made (its `ns.prompt`, or its `ns.alert`, the one
//   alert the game makes from HTML: `dialogBoxCreate(…, { html: true })`, NetscriptFunctions.ts:1327), one the owner
//   opened, one it doesn't know.
// The game shows queued alerts (and invitations) one at a time in the same dialog, its content swapped as each is
// closed; a dialog that's closed fades out first. So after each it waits until the dialog is gone or says something
// else. It reaches the page as the `ui` effectors do (../page/game-page.ts), so it costs no RAM.
import { type HandledDialog, MAX_DIALOG_TEXT_LENGTH } from "@bitburner-agent/core";
import type { NS } from "../ns.ts";
import { type GamePage, openGamePage, type ReactFiber, reactFiberOf } from "../page/game-page.ts";

/** The most dialogs handled in one round, so a flood of alerts can't take every round. */
const MOST_DIALOGS_A_ROUND = 10;
/** How far up the fibers the component that opened a dialog is looked for: MUI's layers are about 7. */
const MOST_FIBERS_UP = 40;
/** How many of a component's hooks are looked at: the AlertManager keeps its alerts in its first. */
const MOST_HOOKS = 5;
const INVITATION_HEADING = "You received a faction invitation.";

type AlertState = { text?: { props?: Record<string, unknown> }; hash: unknown; canBeDismissedEasily: unknown }[];

/** The AlertManager's list of alerts, if `dialog` is the AlertManager's: some component above it holds it. */
function alertsOf(dialog: Element): AlertState | null {
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
      if (isAlertList) return state as AlertState;
      hook = hook.next as typeof hook;
    }
  }
  return null;
}

/** What a dialog says, without its buttons' labels, cut short for the brain. */
function textOf(dialog: Element): string {
  const copy = dialog.cloneNode(true) as Element;
  for (const button of copy.querySelectorAll("button")) button.remove();
  return (copy.textContent ?? "").trim().slice(0, MAX_DIALOG_TEXT_LENGTH);
}

/** Closing: MUI's `Modal` makes the content inert while it fades out (`ui/React/Modal.tsx`). */
const isClosing = (dialog: Element) => dialog.querySelector("[inert]") !== null;

/** What the watcher does with a dialog, or null to leave it alone, with the button to click. */
function actionFor(dialog: Element): { kind: HandledDialog["kind"]; button: Element } | null {
  const alerts = alertsOf(dialog);
  if (alerts !== null) {
    // The alert shown is the first; a script's comes from HTML.
    if (alerts[0]?.text?.props?.dangerouslySetInnerHTML !== undefined) return null;
    const close = dialog.querySelector("button");
    return close ? { kind: "alert", button: close } : null;
  }
  if (!textOf(dialog).startsWith(INVITATION_HEADING)) return null;
  const decideLater = [...dialog.querySelectorAll("button")].find(
    (each) => each.textContent?.trim() === "Decide later",
  );
  return decideLater ? { kind: "factionInvitation", button: decideLater } : null;
}

/** The text of the first dialog open and staying that the watcher leaves alone, or null. */
function blockingIn(gamePage: GamePage): string | null {
  const left = gamePage.openDialogs().find((dialog) => !isClosing(dialog) && actionFor(dialog) === null);
  return left ? textOf(left) : null;
}

export function createDialogWatcher(ns: NS) {
  let handled: HandledDialog[] = [];
  let blocking: string | null = null;

  return {
    /** Handles the dialogs open now, in the page's order, within `deadlineMs`; then notes any left open. */
    async handle(deadlineMs: number): Promise<void> {
      const gamePage = openGamePage(ns, deadlineMs);
      if (gamePage === null) return;
      /** One it meant to handle but couldn't click: it stays open, so it's reported. */
      let unclickable: string | null = null;
      for (let count = 0; count < MOST_DIALOGS_A_ROUND && !gamePage.timeUp(); count += 1) {
        const dialog = gamePage.openDialogs().find((each) => !isClosing(each) && actionFor(each) !== null);
        const action = dialog ? actionFor(dialog) : null;
        if (!dialog || !action) break;
        const text = textOf(dialog);
        const what = action.kind === "alert" ? "the alert's close button" : "Decide later";
        if ((await gamePage.clickElement(action.button, what)) !== null) {
          unclickable = text;
          break;
        }
        handled.push({ kind: action.kind, text });
        // The next in the game's queue takes its place, or it fades out: either way, it isn't seen again.
        await gamePage.waitUntilGoneOrChanged(dialog, () => (isClosing(dialog) ? "" : textOf(dialog)), text);
      }
      // Looked at afresh, after what was handled: a dialog left open now, if any.
      blocking = unclickable ?? blockingIn(gamePage);
    },

    /** What's been handled since the last report, and what's left open: for the fast snapshot. */
    takeReport(): { handled: HandledDialog[]; blocking: string | null } {
      const report = { handled, blocking };
      handled = [];
      return report;
    },
  };
}
