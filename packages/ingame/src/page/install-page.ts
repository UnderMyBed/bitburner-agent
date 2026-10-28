// Installing augmentations through the page (#167, architecture §5.7, Q5), for `install-augmentations.js`: the
// install's steps (`installOnPage`), and the restart after it (`armRestartAfterInstall`), a page timer that outlives
// the scripts the install kills, and starts `agent/boot.js` again. Singularity's install has the game do it
// (`NetscriptFunctions/Singularity.ts:210`, the same kind of timer); before Singularity, this does.
// - The install's steps: the game first, and only the page shows it without Singularity: nothing left to install is
//   done. The sidebar shows Augmentations whenever one is installed or queued (`Sidebar/ui/SidebarRoot.tsx:165-169`),
//   so with its section open (its Stats there) and no Augmentations, there's nothing; on its page, Install is
//   disabled with nothing queued (`Augmentation/ui/AugmentationsRoot.tsx:173`). Otherwise the timer is armed first,
//   then Install, and "Confirm" (unless Options turn the confirmation off: `:100-106`). The install kills every script
//   (`Augmentation/AugmentationHelpers.ts:69-115`), the worker too, at its next `ns` call: the timer does the rest.
//   Still alive after the click, nothing was installed: the timer is disarmed, and the worker says so.
// - The timer is armed before the click. Scripts run in the page's own realm, and killing one clears only its own
//   delay (`Netscript/killWorkerScript.ts:68-70`), so this timer keeps running once the worker is dead.
// - It never calls `ns`: after the kill every `ns` call throws (`Netscript/NetscriptHelpers.tsx:399-403`). Only the
//   page's DOM and React's props, as the `ui` workers drive them (./game-page.ts), and the page's own timers.
// - The steps, each with its own time limit, polled every 100 ms of the page's time:
//   1. The install: its alert, "You slowly drift to sleep…" (`Augmentation/AugmentationHelpers.ts:105-110`), closed
//      by its X. An earlier alert can hide it (the AlertManager shows one at a time), so with no alert in time, the
//      worker's death (it never disarmed the timer) is taken as the install, and the timer goes on.
//   2. The terminal, there, enabled and empty (`Terminal/ui/TerminalInput.tsx:438-468`): `run /agent/boot.js` typed
//      (`onChange`), absolute because an install leaves the terminal's directory as the owner's `cd` left it
//      (`Prestige.ts:108-113`); then, once the input has rendered it (React's `value` prop), Enter (`onKeyDown`, which
//      runs the line its last render saw).
//   3. A new echo of the line, and the line after it: "Running script with 1 thread, pid N and args: []."
//      (`Terminal/commands/runScript.ts:79-83`). `boot.js` starts the Agent, which connects to the brain afresh.
//   4. Otherwise the fallback: the sidebar's Options, then "Force kill all active scripts"
//      (`GameOptions/ui/GameOptionsSidebar.tsx:243-245`), the game's own save-then-reload
//      (`ui/GameRoot.tsx:220-232`), so autoexec starts `boot.js` on the load. The unload prompt (`index.tsx:53-58`,
//      never on Steam's `file://`) is cleared first, or the reload could be stopped. A page loaded with `?noScripts`
//      (Steam's "Reload && Kill All Scripts") keeps it, and autoexec skips (`NetscriptWorker.ts:233-236`): then, as
//      when nothing here works, the brain's supervisor relaunches the silent game (§10.2).
//   Anything that throws on the way goes to the fallback; anything that throws there ends it.
import {
  findOnPage,
  type GamePage,
  hasClass,
  pageDocument,
  playerEvent,
  reactPropsOf,
  sidebarItemXpath,
} from "./game-page.ts";

/** How often the timer looks at the page. */
const POLL_MS = 100;
/** The longest each step waits: for the install's alert, the terminal, the run's line, and the fallback's button. */
export const RESTART_STEP_LIMITS_MS = { install: 5_000, terminal: 10_000, started: 5_000, fallback: 10_000 } as const;
/** The install's alert begins so (`Augmentation/AugmentationHelpers.ts:105-110`). */
const INSTALL_ALERT_TEXT = "You slowly drift to sleep";
/** What `run` prints once the script has started (`Terminal/commands/runScript.ts:79-83`). */
const RUN_STARTED = /^Running script with 1 thread, pid \d+ and args: \[\]\.$/;
const FORCE_KILL_XPATH = "//button[normalize-space()='Force kill all active scripts']";

/**
 * How the restart went: still going, disarmed (nothing installed), the script started, the fallback's reload, or
 * neither.
 */
type RestartOutcome = "waiting" | "disarmed" | "started" | "reloading" | "gaveUp";

/** Calls `element`'s React handler `name` with `event`; false if it has none. Its promise, if any, is left to run. */
function callHandler(element: Element, name: string, event: unknown): boolean {
  const handler = reactPropsOf(element)?.[name];
  if (typeof handler !== "function") return false;
  void Promise.resolve(handler(event)).catch(() => {});
  return true;
}

/**
 * Arms the restart on `page`: from now, the timer waits for an install, then starts `bootScript` from the terminal,
 * or reloads. `disarm` stops it: the worker that armed it calls it when it's still alive after its click, since the
 * install would have killed it.
 */
export function armRestartAfterInstall(page: Document, bootScript: string) {
  const command = `run /${bootScript}`;
  let step: "install" | "terminal" | "enter" | "started" | "fallback" = "install";
  let outcome: RestartOutcome = "waiting";
  /** Why the fallback was taken, or null. */
  let fallbackReason: string | null = null;
  /** Whether the install's alert was seen: without it, the worker's death is the install's only sign. */
  let alertSeen = false;
  let stepEndsMs = Date.now() + RESTART_STEP_LIMITS_MS.install;
  let optionsOpened = false;
  /** The echoes of the line already in the terminal when Enter was sent: only a new one is this run's. */
  let echoesBefore = 0;

  const find = (xpath: string) => findOnPage(page, xpath);
  const terminalInput = () => page.querySelector("#terminal-input") as HTMLInputElement | null;
  const terminalLines = () =>
    [...page.querySelectorAll("#terminal > li")].map((line) => (line.textContent ?? "").trim());
  const isEcho = (line: string) => line.endsWith(`> ${command}`);
  const startStep = (next: typeof step, limitMs: number) => {
    step = next;
    stepEndsMs = Date.now() + limitMs;
  };
  const fallBack = (reason: string) => {
    fallbackReason = reason;
    startStep("fallback", RESTART_STEP_LIMITS_MS.fallback);
  };

  /** One look at the page; whether to look again. */
  function look(): boolean {
    const late = Date.now() >= stepEndsMs;
    switch (step) {
      case "install": {
        const close = find(`//div[button and contains(., '${INSTALL_ALERT_TEXT}')]/button`);
        if (close !== null) {
          alertSeen = true;
          callHandler(close, "onClick", playerEvent());
          startStep("terminal", RESTART_STEP_LIMITS_MS.terminal);
        } else if (late) {
          // Not disarmed, so the worker is dead: the install happened, its alert hidden behind another.
          startStep("terminal", RESTART_STEP_LIMITS_MS.terminal);
        }
        return true;
      }
      case "terminal": {
        const input = terminalInput();
        // A line in it is the owner's: never typed over.
        if (input !== null && !input.disabled && input.value === "") {
          input.value = command;
          if (callHandler(input, "onChange", { target: input })) startStep("enter", RESTART_STEP_LIMITS_MS.terminal);
        } else if (late) {
          fallBack(input === null ? "no terminal" : "the terminal didn't take the line");
        }
        return true;
      }
      case "enter": {
        // Enter runs the line the input's last render saw: only once React has rendered it (its `value` prop).
        const input = terminalInput();
        if (input !== null && reactPropsOf(input)?.value === command) {
          echoesBefore = terminalLines().filter(isEcho).length;
          if (callHandler(input, "onKeyDown", playerEvent({ key: "Enter" }))) {
            startStep("started", RESTART_STEP_LIMITS_MS.started);
          }
        } else if (late) {
          fallBack("the terminal didn't take the line");
        }
        return true;
      }
      case "started": {
        const lines = terminalLines();
        const echoes = lines.flatMap((line, index) => (isEcho(line) ? [index] : []));
        const echoAt = echoes.length > echoesBefore ? (echoes.at(-1) as number) : -1;
        const result = echoAt === -1 ? undefined : lines[echoAt + 1];
        if (result !== undefined && RUN_STARTED.test(result)) {
          outcome = "started";
          return false;
        }
        if (result !== undefined) fallBack(`the terminal said: ${result}`);
        else if (late) fallBack("the terminal didn't say it ran");
        return true;
      }
      case "fallback": {
        const forceKill = find(FORCE_KILL_XPATH);
        if (forceKill !== null) {
          // The production build asks before unloading, except on `file://` (Steam): asked, the reload could stop.
          const view = page.defaultView as { onbeforeunload: unknown } | null;
          if (view !== null) view.onbeforeunload = null;
          outcome = callHandler(forceKill, "onClick", playerEvent()) ? "reloading" : "gaveUp";
          return false;
        }
        if (!optionsOpened) {
          const options = find(sidebarItemXpath("Options"));
          if (options !== null) optionsOpened = callHandler(options, "onClick", playerEvent());
        }
        if (late) {
          outcome = "gaveUp";
          return false;
        }
        return true;
      }
    }
  }

  const tick = () => {
    if (outcome !== "waiting") return;
    let again: boolean;
    try {
      again = look();
    } catch (error) {
      // A page that isn't as expected: the fallback, unless that's what threw.
      if (step === "fallback") {
        outcome = "gaveUp";
        return;
      }
      fallBack(`the page threw: ${error instanceof Error ? error.message : String(error)}`);
      again = true;
    }
    if (again) setTimeout(tick, POLL_MS);
  };
  setTimeout(tick, POLL_MS);

  return {
    /** Stops the timer: nothing was installed. */
    disarm(): void {
      if (outcome === "waiting") outcome = "disarmed";
    },
    /** How it went, why it fell back if it did, and whether the install's alert was seen. */
    state: () => ({ outcome, fallbackReason, alertSeen }),
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
