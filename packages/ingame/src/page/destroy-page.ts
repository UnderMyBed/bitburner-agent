// Destroying the BitNode through the page (#177, architecture §5.7), for `destroy-bitnode.js`: the worker's steps
// (`destroyOnPage`), and the restart after them (`armRestartAfterDestroy`), ./restart-timer.ts's page timer with the
// destroy's own first steps. The worker arms it before typing the backdoor on w0r1d_d43m0n, whose end reaches the
// BitVerse (`Terminal/Terminal.ts:373-388`), which kills every script, the worker and the Agent too
// (`ui/GameRoot.tsx:256-258`).
// - The worker's steps: at the BitVerse already (the next BitNode's portal on the page: a load while w0r1d_d43m0n is
//   backdoored, `ui/GameRoot.tsx:160-164`), only the timer, armed at the portal, and nothing typed. Otherwise the
//   Terminal page, the timer armed, then `home`, a `connect` per hop and `backdoor` (./terminal-backdoor.ts, #162's).
//   The backdoor (about 3 s at the required level) outlives the worker's round: it reports the backdoor under way and
//   leaves the timer armed. A problem before `backdoor` is entered (nothing set off) disarms it; one after (its action
//   not seen started in time) leaves it armed, as the backdoor may yet reach the BitVerse, and the timer stops if it
//   doesn't. A backdoor already under way (the terminal busy) arms nothing: its own timer waits for it.
// - The BitVerse (`BitNode/ui/BitverseRoot.tsx`) first types out the destroy's cinematic by itself (`:209-255`), then
//   shows its map: each portal an `IconButton` with `aria-label="BitNode-N: <name>"`, or with ASCII art off a `Button`
//   reading "BitNode-N: <name>" (`:92-107`). The next BitNode's, clicked once there, opens its modal. None in time
//   means the backdoor never reached the BitVerse: nothing was destroyed and no script died, so the timer stops, with
//   no reload, while the Terminal is still on the page. With no Terminal (a BitVerse that never got to its map, say)
//   it gives up instead, saying so.
// - The modal's "Enter BN{n}.{level}" (`aria-label="enter-bitnode-N"`, `BitNode/ui/PortalModal.tsx:117-131`) enters
//   the BitNode with the default options (`RedPill.tsx:53-93`): the Terminal, or for BitNode 6 the Bladeburner
//   cinematic, left by its "Continue ..." once typed out (`Bladeburner/ui/BladeburnerCinematic.tsx`,
//   `ui/React/CinematicText.tsx:34`).
// - No Enter, or neither the Terminal nor a Continue, in time: the timer gives up. The BitVerse and the cinematic have
//   no sidebar (`ui/GameRoot.tsx:314-327`), so no Options and its Force kill to save and reload by. A bare reload
//   would load the last save, from before the destroy or at the BitVerse: safe (a destroy only in memory is lost, not
//   doubled), but it would bring no progress and could repeat. So the brain's supervisor relaunches the silent game
//   (§10.2), or the owner steps in; either way the save loaded decides, and the brain's reset check counts a destroy
//   only once a slow snapshot shows it.
// - The Black Ops' route (#398, `destroyByBlackOpsOnPage`): with all 21 done the Black Ops page shows "Destroy
//   w0r1d_d43m0n" (`Bladeburner/ui/BlackOpPage.tsx:39-52`), whose click backdoors w0r1d_d43m0n (`finishBitNode`,
//   `BitNode/BitNodeUtils.ts:89-95`) and goes to the BitVerse, a cinematic first (`flume: false, quick: false`), which
//   kills every script (`ui/GameRoot.tsx:256-258`). So the sidebar's "Bladeburner", its "BlackOps" tab
//   (`Bladeburner/ui/AllPages.tsx:29`), the timer armed, then the button. Its text is scrambled letter by letter as it
//   renders (`ui/React/CorruptibleText.tsx`), so it's found by its React child's `content`. No button: not all 21 are
//   done, said with the Red Pill route's problem. The BitVerse never showing with the Bladeburner page still there:
//   nothing was destroyed, the timer stops.
// - Then the shared steps: `run /agent/boot.js`, or the fallback. The dialogs the new BitNode raises (the
//   Source-File's, and the first BitNode's congratulations 200 ms later: `RedPill.tsx:29-49`, `Prestige.ts:39-41`,
//   `:373-376`) are
//   left to the next Agent's dialog watcher, which closes each with its X and tells the brain what it said (owner
//   decision 35): the terminal is typed into through React's props, which a dialog doesn't stop.
import { BLACK_OPS_COUNT, WORLD_DAEMON } from "@bitburner-agent/core";
import { monotonicMs } from "../clock.ts";
import type { NS } from "../ns.ts";
import { backdoorStanding } from "../workers/backdoor-standing.ts";
import { findOnPage, type GamePage, pageDocument, playerEvent, reactPropsOf, sidebarItemXpath } from "./game-page.ts";
import { armRestart, callHandler, SHARED_STEP_LIMITS_MS } from "./restart-timer.ts";
import { typeBackdoor } from "./terminal-backdoor.ts";

/**
 * The longest each step waits: the BitVerse's map past the backdoor's end (its cinematic is several seconds), the
 * portal's Enter, and the Terminal (BitNode 6's cinematic, typed out first, is longer); then the shared steps.
 */
export const DESTROY_STEP_LIMITS_MS = { bitVerse: 30_000, enter: 10_000, arrive: 30_000, ...SHARED_STEP_LIMITS_MS };

/** The BitVerse's portal for BitNode `n`: its `aria-label`, or its text with ASCII art off. */
export const portalXpath = (n: number) =>
  `//button[starts-with(@aria-label, 'BitNode-${n}: ') or starts-with(normalize-space(), 'BitNode-${n}: ')]`;
const enterXpath = (n: number) => `//button[@aria-label='enter-bitnode-${n}']`;
const CONTINUE_XPATH = "//button[normalize-space()='Continue ...']";
/**
 * Where the page keeps the destroy's timer armed last: one at a time, as two at the BitVerse would each click "Enter",
 * and the second would destroy the BitNode just entered.
 */
const ARMED_TIMER = "__bitburnerAgentDestroyTimer";

/**
 * Arms the restart on `page`: from now, the timer waits up to `bitVerseWithinMs` for the BitVerse's map, enters
 * `nextBitNode` through its portal, then starts `bootScript` from the terminal, or reloads. `disarm` stops it: the
 * worker calls it when the backdoor was never entered. One armed before it is disarmed. `startedFrom`: the page the
 * destroy started from, and whether it's still up when the BitVerse is late (nothing destroyed: the timer stops): the
 * Terminal by default; the Bladeburner page for the Black Ops' button (#398).
 */
export function armRestartAfterDestroy(
  page: Document,
  bootScript: string,
  nextBitNode: number,
  bitVerseWithinMs: number,
  startedFrom: { name: string; there: () => boolean } = {
    name: "the Terminal",
    there: () => page.querySelector("#terminal-input") !== null,
  },
) {
  const holder = page as unknown as Record<string, { disarm(): void } | undefined>;
  holder[ARMED_TIMER]?.disarm();
  /** Clicks the element `xpath` finds, if it's there: whether it was. */
  const clickIfThere = (xpath: string) => {
    const element = findOnPage(page, xpath);
    if (element === null) return false;
    callHandler(element, "onClick", playerEvent());
    return true;
  };
  let continued = false;
  const restart = armRestart(page, bootScript, [
    {
      limitMs: bitVerseWithinMs,
      look: () => clickIfThere(portalXpath(nextBitNode)),
      // Still on the page it started from: the destroy never reached the BitVerse, and every script lives.
      late: () =>
        startedFrom.there()
          ? { action: "stop", reason: "the BitVerse never showed: nothing was destroyed" }
          : { action: "giveUp", reason: `the BitVerse's map never showed, and ${startedFrom.name} is gone` },
    },
    {
      limitMs: DESTROY_STEP_LIMITS_MS.enter,
      look: () => clickIfThere(enterXpath(nextBitNode)),
      late: { action: "giveUp", reason: `no "Enter" in BitNode-${nextBitNode}'s portal (no sidebar to reload by)` },
    },
    {
      limitMs: DESTROY_STEP_LIMITS_MS.arrive,
      look: () => {
        if (page.querySelector("#terminal-input") !== null) return true;
        if (!continued) continued = clickIfThere(CONTINUE_XPATH);
        return false;
      },
      late: { action: "giveUp", reason: "neither the Terminal nor the cinematic's Continue (no sidebar to reload by)" },
    },
  ]);
  holder[ARMED_TIMER] = restart;
  return restart;
}

/**
 * The worker's steps on the page (see above), from the Terminal page or the BitVerse: what it reports, never done (the
 * brain sees a destroy by the reset). Once the BitVerse is reached, nothing returns: the worker is dead.
 */
export async function destroyOnPage(
  ns: NS,
  gamePage: GamePage,
  nextBitNode: number,
  bootScript: string,
): Promise<string> {
  const page = pageDocument();
  if (page === null) return "no game page to restart from after the destroy";
  const entering = `entering BitNode ${nextBitNode} from the BitVerse`;
  if (gamePage.findElementNow(portalXpath(nextBitNode)) !== null) {
    // The timer's click enters the BitNode, which kills this worker and the Agent.
    armRestartAfterDestroy(page, bootScript, nextBitNode, DESTROY_STEP_LIMITS_MS.enter);
    return entering;
  }
  const opened = await gamePage.openSidebarPage("Terminal");
  if (opened !== null) return opened;
  const standing = backdoorStanding(ns, WORLD_DAEMON);
  if (standing.installed) return `${WORLD_DAEMON} is backdoored, but the game isn't at the BitVerse`;
  if (standing.route === null) return standing.problem;
  // A backdoor under way (an earlier try's): its own timer waits for it.
  if (gamePage.terminalBusy() === true) return "terminal busy";
  const backdoorMs = ns.getHackTime(WORLD_DAEMON) / 4;
  // Armed before the backdoor is typed: its end kills this worker.
  const restart = armRestartAfterDestroy(page, bootScript, nextBitNode, backdoorMs + DESTROY_STEP_LIMITS_MS.bitVerse);
  const typed = await typeBackdoor(ns, gamePage, WORLD_DAEMON, standing.route);
  if ("problem" in typed) {
    // Never entered, nothing can reach the BitVerse. Entered, it may yet: the timer stays, and stops if it doesn't.
    if (!typed.backdoorEntered) restart.disarm();
    return typed.problem;
  }
  const secondsLeft = Math.max(1, Math.ceil((typed.endsAtMs - monotonicMs()) / 1000));
  return `backdooring ${WORLD_DAEMON}: about ${secondsLeft} s left, then ${entering}`;
}

/** The Bladeburner page's Black Ops tab (`Bladeburner/ui/AllPages.tsx:29`): an MUI `Tab`, a button with role "tab". */
export const BLACK_OPS_TAB_XPATH = "//button[@role='tab' and normalize-space()='BlackOps']";
/** The Black Ops page's destroy button's text (`Bladeburner/ui/BlackOpPage.tsx:50`), its `CorruptibleText`'s content. */
export const BLACK_OPS_DESTROY_CONTENT = "Destroy w0r1d_d43m0n";

/** Whether a React node (an element, an array, text) carries a `content` prop of `content`, through its children. */
function carriesContent(node: unknown, content: string): boolean {
  if (Array.isArray(node)) return node.some((each) => carriesContent(each, content));
  if (typeof node !== "object" || node === null || !("props" in node)) return false;
  const props = (node as { props: { content?: unknown; children?: unknown } }).props;
  return props.content === content || carriesContent(props.children, content);
}

/**
 * The Black Ops page's "Destroy w0r1d_d43m0n" button, or null (#398): the button whose React children carry the
 * `CorruptibleText` with that content, as its rendered letters are scrambled.
 */
export function blackOpsDestroyButton(gamePage: GamePage): Element | null {
  return (
    gamePage
      .findAllNow("//button")
      .find((button) => carriesContent(reactPropsOf(button)?.children, BLACK_OPS_DESTROY_CONTENT)) ?? null
  );
}

/**
 * The Black Ops' route's steps on the page (#398, see above), for the `ui` worker in the division: from the BitVerse
 * already, the timer at the portal; else the sidebar's "Bladeburner", its "BlackOps" tab, the timer armed, then the
 * button, whose BitVerse kills this worker. `problem`: the Red Pill route's, said when there's no button. What it
 * reports, never done (the brain sees a destroy by the reset).
 */
export async function destroyByBlackOpsOnPage(
  gamePage: GamePage,
  nextBitNode: number,
  bootScript: string,
  problem: string,
): Promise<string> {
  const page = pageDocument();
  if (page === null) return "no game page to restart from after the destroy";
  const entering = `entering BitNode ${nextBitNode} from the BitVerse`;
  if (gamePage.findElementNow(portalXpath(nextBitNode)) !== null) {
    armRestartAfterDestroy(page, bootScript, nextBitNode, DESTROY_STEP_LIMITS_MS.enter);
    return entering;
  }
  const opened = await gamePage.openSidebarPage("Bladeburner");
  if (opened !== null) return opened;
  const tab = await gamePage.clickWhenThere(BLACK_OPS_TAB_XPATH, `the Bladeburner page's "BlackOps" tab`);
  if (tab !== null) return tab;
  const button = blackOpsDestroyButton(gamePage);
  if (button === null) {
    return `no "${BLACK_OPS_DESTROY_CONTENT}" on the Black Ops page (it shows with all ${BLACK_OPS_COUNT} done): ${problem}`;
  }
  // Armed before the click: the BitVerse it goes to kills this worker.
  const restart = armRestartAfterDestroy(page, bootScript, nextBitNode, DESTROY_STEP_LIMITS_MS.bitVerse, {
    name: "the Bladeburner page",
    there: () => findOnPage(page, sidebarItemXpath("Bladeburner")) !== null,
  });
  const clicked = await gamePage.clickElement(button, `"${BLACK_OPS_DESTROY_CONTENT}"`);
  if (clicked !== null) {
    restart.disarm();
    return clicked;
  }
  return `${BLACK_OPS_DESTROY_CONTENT} clicked: ${entering}`;
}
