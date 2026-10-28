// agent/<deploymentId>/buy-augmentation.js: a home worker that buys an augmentation from a faction through the game's
// page (#149), a `ui` effector: there's no API for it before Singularity. Arguments: the faction, the augmentation, the
// level (1, or NeuroFlux Governor's level to buy), and when to give up (the game's `Date.now()`).
// - The game first: an augmentation installed (or NeuroFlux installed at that level) is done, without the page.
//   Queued ones aren't in any NS call without Singularity, so the page tells: the row's "Owned".
// - The sidebar's Factions, "Augments" on the faction's row, then the augmentation's row
//   (`Augmentation/ui/PurchasableAugmentations.tsx`): "Owned" is done; NeuroFlux's title names the next level to buy.
// - A disabled "Buy" is never clicked: its handler would still run. The page disables it without the money, the
//   reputation or the prerequisites, and the worker says so.
// - "Buy", then "Purchase" if the confirmation is shown, then the "You purchased" alert closed with its own button: each
//   only if shown, since Options can turn both off (`SuppressBuyAugmentationConfirmation`).
// - The page's handlers do the rest, through `reportPageEffect`: never over an owner's dialog, back to the Terminal.
// RAM: `getResetInfo` 1.0 (ram-budget.json); the page costs nothing.
import { NEUROFLUX_GOVERNOR } from "@bitburner-agent/core";
import type { NS } from "../ns.ts";
import { type GamePage, xpathString } from "../page/game-page.ts";
import { reportPageEffect } from "../page/page-effect.ts";

const PAPER = "contains(concat(' ', @class, ' '), ' MuiPaper-root ')";
const NEUROFLUX_TITLE_START = `${NEUROFLUX_GOVERNOR} - Level `;

/** "Augments" on `faction`'s row among the factions joined (`Faction/ui/FactionsRoot.tsx`, `span.factions-joined`). */
const augmentsButtonXpath = (faction: string) =>
  "//span[contains(concat(' ', @class, ' '), ' factions-joined ')]" +
  `//div[${PAPER} and .//span[normalize-space()=${xpathString(faction)}]]//button[normalize-space()='Augments']`;

/** The augmentation's row: a `Paper` whose title is its name, or for NeuroFlux, its name and next level. */
const rowXpath = (augmentation: string) =>
  augmentation === NEUROFLUX_GOVERNOR
    ? `//div[${PAPER} and .//p[starts-with(normalize-space(), ${xpathString(NEUROFLUX_TITLE_START)})]]`
    : `//div[${PAPER} and .//p[normalize-space()=${xpathString(augmentation)}]]`;

/** What the row shows: owned, or buyable (enabled or not), and NeuroFlux's next level to buy. */
function readRow(row: Element): { owned: boolean; button: Element | null; enabled: boolean; nextLevel: number | null } {
  const button = row.querySelector("button");
  const title = [...row.querySelectorAll("p")].find((each) =>
    (each.textContent ?? "").trim().startsWith(NEUROFLUX_TITLE_START),
  );
  const nextLevel = title ? Number((title.textContent ?? "").trim().slice(NEUROFLUX_TITLE_START.length)) : null;
  return {
    owned: (button?.textContent ?? "").trim() === "Owned",
    button,
    enabled: button !== null && !(button as HTMLButtonElement).disabled,
    nextLevel,
  };
}

async function buyOnPage(
  gamePage: GamePage,
  { faction, augmentation, level }: { faction: string; augmentation: string; level: number },
  seen: { owned: boolean },
): Promise<string | null> {
  const isNeuroFlux = augmentation === NEUROFLUX_GOVERNOR;
  /** Whether the row shows it bought: "Owned", or NeuroFlux's next level past this one. */
  const bought = (row: Element) => {
    const state = readRow(row);
    return isNeuroFlux ? (state.nextLevel ?? 0) > level : state.owned;
  };
  const opened =
    (await gamePage.openSidebarPage("Factions")) ??
    (await gamePage.clickWhenThere(
      augmentsButtonXpath(faction),
      `${faction} among the factions joined (is it joined?)`,
    ));
  if (opened !== null) return opened;
  const row = await gamePage.findWhenThere(rowXpath(augmentation));
  if (row === null) return `no ${augmentation} on ${faction}'s augmentations (does it sell it?)`;
  if (bought(row)) {
    seen.owned = true;
    return null;
  }
  const state = readRow(row);
  if (isNeuroFlux && state.nextLevel !== level) {
    return `${NEUROFLUX_GOVERNOR}'s next level is ${state.nextLevel}, not ${level}: the levels before it come first`;
  }
  if (state.button === null || !state.enabled) {
    return `can't buy ${augmentation} from ${faction} yet (the money, the reputation or a prerequisite?)`;
  }
  const clicked = await gamePage.clickElement(state.button, `"Buy" on ${augmentation}`);
  if (clicked !== null) return clicked;
  // The confirmation, unless Options turn it off: its title is the augmentation's name.
  const confirmation = await gamePage.clickIfThere(
    `//div[contains(concat(' ', @class, ' '), ' MuiModal-root ') and .//h4[normalize-space()=${xpathString(augmentation)}]]` +
      "//button[normalize-space()='Purchase']",
    "the purchase's confirmation",
  );
  if (confirmation.problem !== null) return confirmation.problem;
  if (confirmation.clicked) await gamePage.waitARender();
  // The alert saying so, unless Options turn it off: closed by its own button.
  const alert = await gamePage.clickIfThere(
    `//div[button and contains(., ${xpathString(`You purchased ${augmentation}.`)})]/button`,
    "the close button on the purchase's alert",
  );
  if (alert.problem !== null) return alert.problem;
  // The page shows it once it renders again.
  while (!gamePage.stepsTimeUp()) {
    const after = gamePage.find(rowXpath(augmentation));
    if (after !== null && bought(after)) {
      seen.owned = true;
      return null;
    }
    await gamePage.waitARender();
  }
  return null;
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const faction = String(ns.args[0] ?? "");
  const augmentation = String(ns.args[1] ?? "");
  const level = Number(ns.args[2] ?? 1);
  const deadlineMs = Number(ns.args[3] ?? 0);
  const seen = { owned: false };
  const installed = () => {
    const owned = ns.getResetInfo().ownedAugs;
    return augmentation === NEUROFLUX_GOVERNOR ? (owned.get(augmentation) ?? 0) >= level : owned.has(augmentation);
  };
  await reportPageEffect(ns, deadlineMs, {
    isDone: () => installed() || seen.owned,
    doing: "buy it through",
    steps: (gamePage) => buyOnPage(gamePage, { faction, augmentation, level }, seen),
    notDoneAfter: `${augmentation} isn't owned after buying it`,
  });
}
