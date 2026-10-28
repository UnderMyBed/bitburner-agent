// Installing augmentations through the page (#167, architecture §5.7, Q5), for `install-augmentations.js`: the
// install's steps (`installOnPage`), and the restart after it (`armRestartAfterInstall`), ./restart-timer.ts's page
// timer with the install's own first step.
// - The install's steps: the game first, and only the page shows it without Singularity: nothing left to install is
//   done. The sidebar shows Augmentations whenever one is installed or queued (`Sidebar/ui/SidebarRoot.tsx:165-169`),
//   so with its section open (its Stats there) and no Augmentations, there's nothing; on its page, Install is
//   disabled with nothing queued (`Augmentation/ui/AugmentationsRoot.tsx:173`). Otherwise the timer is armed first,
//   then Install, and "Confirm" (unless Options turn the confirmation off: `:100-106`). The install kills every script
//   (`Augmentation/AugmentationHelpers.ts:69-115`), the worker too, at its next `ns` call: the timer does the rest.
//   Still alive after the click, nothing was installed: the timer is disarmed, and the worker says so.
// - The timer's first step: the install's alert, "You slowly drift to sleep…"
//   (`Augmentation/AugmentationHelpers.ts:105-110`), closed by its X. An earlier alert can hide it (the AlertManager
//   shows one at a time), so with no alert in time, the worker's death (it never disarmed the timer) is taken as the
//   install, and the timer goes on to the terminal.
import { findOnPage, type GamePage, hasClass, pageDocument, playerEvent, sidebarItemXpath } from "./game-page.ts";
import { armRestart, callHandler, SHARED_STEP_LIMITS_MS } from "./restart-timer.ts";

/** The longest each step waits: for the install's alert, the terminal, the run's line, and the fallback's button. */
export const RESTART_STEP_LIMITS_MS = { install: 5_000, ...SHARED_STEP_LIMITS_MS } as const;
/** The install's alert begins so (`Augmentation/AugmentationHelpers.ts:105-110`). */
const INSTALL_ALERT_TEXT = "You slowly drift to sleep";

/**
 * Arms the restart on `page`: from now, the timer waits for an install, then starts `bootScript` from the terminal,
 * or reloads. `disarm` stops it: the worker that armed it calls it when it's still alive after its click, since the
 * install would have killed it.
 */
export function armRestartAfterInstall(page: Document, bootScript: string) {
  /** Whether the install's alert was seen: without it, the worker's death is the install's only sign. */
  let alertSeen = false;
  const restart = armRestart(page, bootScript, [
    {
      limitMs: RESTART_STEP_LIMITS_MS.install,
      look: () => {
        const close = findOnPage(page, `//div[button and contains(., '${INSTALL_ALERT_TEXT}')]/button`);
        if (close === null) return false;
        alertSeen = true;
        callHandler(close, "onClick", playerEvent());
        return true;
      },
      // Not disarmed, so the worker is dead: the install happened, its alert hidden behind another.
      late: { action: "next" },
    },
  ]);
  return {
    disarm: restart.disarm,
    /** How it went, why it fell back if it did, and whether the install's alert was seen. */
    state: () => ({ ...restart.state(), alertSeen }),
  };
}
const INSTALL_XPATH = "//button[normalize-space()='Install Augmentations']";
/** The install's confirmation (`Augmentation/ui/AugmentationsRoot.tsx:145-169`): its one button. */
const CONFIRM_XPATH =
  `//div[${hasClass("MuiModal-root")} and contains(., 'Installing will reset')]` +
  "//button[normalize-space()='Confirm']";

/**
 * The install's steps on the page (see above): their problem, or null. `nothingToInstall.seen` is set when the page
 * shows nothing left to install. Once the install has happened, nothing returns: the worker is dead.
 */
export async function installOnPage(
  gamePage: GamePage,
  bootScript: string,
  nothingToInstall: { seen: boolean },
): Promise<string | null> {
  const opened = await gamePage.openSidebarPage("Augmentations");
  if (opened !== null) {
    // No Augmentations beside the Character section's Stats: nothing installed or queued.
    if (gamePage.findElementNow(sidebarItemXpath("Stats")) === null) return opened;
    nothingToInstall.seen = true;
    return null;
  }
  const install = await gamePage.findWhenThere(INSTALL_XPATH);
  if (install === null) return 'no "Install Augmentations" on the Augmentations page';
  if ((install as HTMLButtonElement).disabled) {
    nothingToInstall.seen = true;
    return null;
  }
  const page = pageDocument();
  if (page === null) return "no game page to restart from after the install";
  // Before the click: with the confirmation turned off, Install itself installs, and the worker dies with it.
  const restart = armRestartAfterInstall(page, bootScript);
  // Alive after Install: the confirmation is shown, and Confirm installs. Alive after that, nothing was installed.
  const problem =
    (await gamePage.clickElement(install, '"Install Augmentations"')) ??
    (await gamePage.clickWhenThere(CONFIRM_XPATH, "confirmation of the install"));
  restart.disarm();
  return problem ?? "the game didn't install after its confirmation";
}
