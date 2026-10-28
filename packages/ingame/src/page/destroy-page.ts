// Destroying the BitNode through the page (#177, architecture §5.7), for `destroy-bitnode.js`: the restart after it
// (`armRestartAfterDestroy`), ./restart-timer.ts's page timer with the destroy's own first steps. The worker arms it
// before typing the backdoor on w0r1d_d43m0n, whose end reaches the BitVerse (`Terminal/Terminal.ts:373-388`), which
// kills every script, the worker and the Agent too (`ui/GameRoot.tsx:256-258`).
// - The BitVerse (`BitNode/ui/BitverseRoot.tsx`) first types out the destroy's cinematic by itself (`:209-255`), then
//   shows its map: each portal an `IconButton` with `aria-label="BitNode-N: <name>"`, or with ASCII art off a `Button`
//   reading "BitNode-N: <name>" (`:92-107`). The next BitNode's, clicked once there, opens its modal. None in time
//   means the backdoor never reached the BitVerse: nothing was destroyed and no script died, so the timer stops, with
//   no reload. A load while w0r1d_d43m0n is backdoored starts at the map (`ui/GameRoot.tsx:160-164`): the worker then
//   arms it there.
// - The modal's "Enter BN{n}.{level}" (`aria-label="enter-bitnode-N"`, `BitNode/ui/PortalModal.tsx:117-131`) enters
//   the BitNode with the default options (`RedPill.tsx:53-93`): the Terminal, or for BitNode 6 the Bladeburner
//   cinematic, left by its "Continue ..." once typed out (`Bladeburner/ui/BladeburnerCinematic.tsx`,
//   `ui/React/CinematicText.tsx:34`).
// - Then the shared steps: `run /agent/boot.js`, or the fallback. The dialogs the new BitNode raises (the
//   Source-File's, and the first BitNode's congratulations 200 ms later: `RedPill.tsx:29-49`, `Prestige.ts:39-41`) are
//   left to the next Agent's dialog watcher, which closes each with its X and tells the brain what it said (owner
//   decision 35): the terminal is typed into through React's props, which a dialog doesn't stop.
import { findOnPage, playerEvent } from "./game-page.ts";
import { armRestart, callHandler, SHARED_STEP_LIMITS_MS } from "./restart-timer.ts";

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
 * worker calls it when the backdoor didn't start. One armed before it is disarmed.
 */
export function armRestartAfterDestroy(
  page: Document,
  bootScript: string,
  nextBitNode: number,
  bitVerseWithinMs: number,
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
      late: { action: "stop", reason: "the BitVerse never showed: nothing was destroyed" },
    },
    {
      limitMs: DESTROY_STEP_LIMITS_MS.enter,
      look: () => clickIfThere(enterXpath(nextBitNode)),
      late: { action: "fallback", reason: `no "Enter" in BitNode-${nextBitNode}'s portal` },
    },
    {
      limitMs: DESTROY_STEP_LIMITS_MS.arrive,
      look: () => {
        if (page.querySelector("#terminal-input") !== null) return true;
        if (!continued) continued = clickIfThere(CONTINUE_XPATH);
        return false;
      },
      late: { action: "fallback", reason: "neither the Terminal nor the cinematic's Continue" },
    },
  ]);
  holder[ARMED_TIMER] = restart;
  return restart;
}
