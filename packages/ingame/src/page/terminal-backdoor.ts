// Typing a backdoor into the terminal (#162), for the backdoor's worker and the destroy's (#177), on the Terminal page:
// `home` unless the terminal is there, `connect` along the way from home (each hop checked), then `backdoor`. Its
// action takes hacking time / 4 (`Terminal/Terminal.ts:233-243`) and disables the input until it ends.
// RAM: `getServer` 2.0 + `getHackTime` 0.05, with the caller's.
import type { NS } from "../ns.ts";
import type { GamePage } from "./game-page.ts";

/** Renders the page is given to show the backdoor's action started (its input disabled), before it's called refused. */
const STARTED_WITHIN_RENDERS = 5;

/**
 * Types the backdoor on `hostname` along `route` (its hops from home): its problem, or when its action ends (the
 * game's `Date.now()`), once it has started. One already ended by the time it's looked at (a short one) counts too.
 */
export async function typeBackdoor(
  ns: NS,
  gamePage: GamePage,
  hostname: string,
  route: string[],
): Promise<{ problem: string } | { endsAtMs: number }> {
  if (!ns.getServer("home").isConnectedTo) {
    const home = await gamePage.runTerminalCommand("home");
    if (home !== null) return { problem: home };
  }
  for (const hop of route) {
    const connected = await gamePage.runTerminalCommand(`connect ${hop}`);
    if (connected !== null) return { problem: connected };
    if (!ns.getServer(hop).isConnectedTo) return { problem: `couldn't connect to ${hop} on the way to ${hostname}` };
  }
  const endsAtMs = Date.now() + ns.getHackTime(hostname) / 4;
  const typed = await gamePage.runTerminalCommand("backdoor");
  if (typed !== null) return { problem: typed };
  // The game disables the input while the action runs: given a few renders to show, as a page under load is slow.
  const installed = () => ns.getServer(hostname).backdoorInstalled === true;
  for (let render = 0; render < STARTED_WITHIN_RENDERS && gamePage.terminalBusy() !== true && !installed(); render++) {
    await gamePage.waitARender();
  }
  if (gamePage.terminalBusy() !== true && !installed()) {
    return { problem: `the terminal didn't start the backdoor on ${hostname}` };
  }
  return { endsAtMs };
}
