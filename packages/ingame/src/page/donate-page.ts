// Donating to a faction through the game's page (#225), for `donate-to-faction.js` (../entries/): a module of its own
// so its jsdom tests can import it (an entry's bundle exports only `main`). No NS call donates without Singularity.
// - The sidebar's Factions, then "Details" on the faction's row (`Faction/ui/FactionsRoot.tsx`), its own page
//   (`Faction/ui/FactionRoot.tsx`): its `DonateOption` (`Faction/ui/DonateOption.tsx`) shows for a faction that offers
//   work and isn't the player's gang (`FactionRoot.tsx:94-143`), a `NumberInput` with a "donate" button once the
//   favour unlocks donations (`:103-104`), else "Unlock donations at … favor".
// - The game first: `DonateOption`'s `faction` prop is the game's own `Faction`, so its `playerReputation` already at
//   the reputation the donation is for is done, with nothing donated.
// - The amount typed through the input's React `onChange`, as the terminal's line is (./game-page.ts), then, once
//   rendered, the button's `onClick` (its handler reads the amount from that render). A disabled button is never
//   clicked: `canDonate` disables it without the money (`donation.ts:20-22`).
// - The "You just donated" alert (`DonateOption.tsx:33-40`) closed with its own button, then the reputation read again
//   from the same `Faction`.
import {
  factionRowButtonXpath,
  type GamePage,
  hasClass,
  reactPropsAbove,
  reactPropsOf,
  xpathString,
} from "./game-page.ts";

/** The input's placeholder (`DonateOption.tsx:68`). */
const AMOUNT_XPATH = "//input[@placeholder='Donation amount']";
/** The faction's own page: its Back button, then its name (`Faction/ui/FactionRoot.tsx:108-111`). */
const factionPageXpath = (faction: string) =>
  `//button[normalize-space()='Back']/following-sibling::h4[1][normalize-space()=${xpathString(faction)}]`;
/** The text shown in place of the input before the favour unlocks donations (`DonateOption.tsx:60-63`). */
const LOCKED_XPATH = "//p[starts-with(normalize-space(), 'Unlock donations at')]";
/** The alert after a donation (`DonateOption.tsx:34-39`), closed by its own button. */
const ALERT_CLOSE_XPATH = "//div[button and contains(., 'You just donated')]/button";

/** The problems the page's donation reports, worded once for its tests. */
export const donatePageProblems = {
  locked: (faction: string) => `${faction}'s donations aren't unlocked (its favour is short)`,
  noDonations: (faction: string) => `${faction}'s page has no donations (no work, or the player's gang?)`,
  noFactionProp: "the donation's input has no faction in its React props",
  noButton: 'no "donate" button beside the donation\'s amount',
  cantDonate: (amount: number, faction: string) => `can't donate $${amount} to ${faction} (the money?)`,
  cantType: "the donation's amount can't be typed in",
};

/** The game's `Faction` behind the donation's input, as far as this reads it. */
function factionOf(input: Element): { playerReputation: number } | null {
  const faction = reactPropsAbove(input, "favorToDonate")?.faction as { playerReputation?: unknown } | undefined;
  return typeof faction?.playerReputation === "number" ? { playerReputation: faction.playerReputation } : null;
}

/**
 * The donation's steps (see above): their problem, or null. `reached.reputation` is set to the faction's reputation
 * as the page last showed it; the worker reports done once that's `reputation` or more.
 */
export async function donateOnPage(
  gamePage: GamePage,
  { faction, amount, reputation }: { faction: string; amount: number; reputation: number },
  reached: { reputation: number | null },
): Promise<string | null> {
  const opened =
    (await gamePage.openSidebarPage("Factions")) ??
    (await gamePage.clickWhenThere(
      factionRowButtonXpath("factions-joined", faction, "Details"),
      `${faction} among the factions joined (is it joined?)`,
    ));
  if (opened !== null) return opened;
  if ((await gamePage.findWhenThere(factionPageXpath(faction))) === null) return `no page of ${faction}'s`;
  const input = gamePage.findElementNow(AMOUNT_XPATH) as HTMLInputElement | null;
  if (input === null) {
    return gamePage.findElementNow(LOCKED_XPATH) !== null
      ? donatePageProblems.locked(faction)
      : donatePageProblems.noDonations(faction);
  }
  const before = factionOf(input);
  if (before === null) return donatePageProblems.noFactionProp;
  reached.reputation = before.playerReputation;
  if (before.playerReputation >= reputation) return null;
  const onChange = reactPropsOf(input)?.onChange;
  if (typeof onChange !== "function") return donatePageProblems.cantType;
  input.value = String(amount);
  onChange({ target: input });
  await gamePage.waitARender();
  // Read only now: the handler of the render before the amount was typed would donate nothing (`NaN`).
  const button = gamePage.findElementNow(
    `${AMOUNT_XPATH}/ancestor::div[${hasClass("MuiInputBase-root")}][1]//button[normalize-space()='donate']`,
  ) as HTMLButtonElement | null;
  if (button === null) return donatePageProblems.noButton;
  if (button.disabled) return donatePageProblems.cantDonate(amount, faction);
  const clicked = await gamePage.clickElement(button, '"donate"');
  if (clicked !== null) return clicked;
  // The alert saying so, closed by its own button (the dialog watcher would close it too, decision 35).
  const alert = await gamePage.clickIfThere(ALERT_CLOSE_XPATH, "the close button on the donation's alert");
  if (alert.problem !== null) return alert.problem;
  reached.reputation = factionOf(input)?.playerReputation ?? reached.reputation;
  return null;
}
