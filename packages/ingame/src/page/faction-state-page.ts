// The faction state on the game's page (#197), for `faction-state.js` (../entries/): each joined faction's reputation
// and favour, the invitations, and the queued augmentations, which no NS call has without Singularity. A module of its
// own so its jsdom tests can import it: an entry's bundle exports only `main`.
// - No always-mounted component holds them: every one reads the `Player` singleton itself. The sidebar has counts only:
//   the Augmentations item's `count` prop is the queue's length (`Sidebar/ui/SidebarRoot.tsx:152`, `:380-384`, passed
//   on by `SidebarAccordion.tsx:82-96`, refreshed every game cycle, `SidebarRoot.tsx:127`).
// - The Factions page (`Faction/ui/FactionsRoot.tsx`): a row per faction, a `Paper` whose component's `faction` prop is
//   the game's own `Faction` (`:71-75`), with `playerReputation` and `favor` unrounded (the text rounds them,
//   `:207-210`). The invitations are under `span.factions-invites` (`:229`, `:265-278`), the joined factions, a gang's
//   first, under `span.factions-joined` (`:227`, `:280-304`). Opening it marks the invitations seen (`:220-224`), so the
//   sidebar's badge for them goes, as it does for a player who looks.
// - The Augmentations page (`Augmentation/ui/AugmentationsRoot.tsx:185-193`, `PurchasedAugmentations.tsx`): a row per
//   queued augmentation by name, beside "Install Augmentations", NeuroFlux Governor once, as "NeuroFlux Governor -
//   Level N", the level the last one queued gives (`:13-31`; `PlayerObjectGeneralMethods.ts:472-498`). Its copies are
//   N less the level installed. Opened only while the sidebar's count says something is queued.
// - Each page only if the sidebar shows it: Factions with anything joined, invited or rumoured, Augmentations with
//   anything installed or queued (`SidebarRoot.tsx:156-168`), both beside Stats in the Character section
//   (`:364-389`). With Stats shown and the item absent, there's nothing there to read (as ./install-page.ts reads it).
// - Checks that fail loudly: the joined rows are the game's `getPlayer().factions`, and the queue read is as long as the
//   sidebar's count.
import { type FactionState, type JoinedFaction, NEUROFLUX_GOVERNOR } from "@bitburner-agent/core";
import { type GamePage, hasClass, reactPropsAbove, sidebarItemXpath } from "./game-page.ts";

const NEUROFLUX_ROW_START = `${NEUROFLUX_GOVERNOR} - Level `;
/** Each faction's row in a section of the Factions page: the section's `Box`, then its `Paper`s. */
const factionRowsXpath = (section: string) => `//span[${hasClass(section)}]/div/div[${hasClass("MuiPaper-root")}]`;
const JOINED_SECTION_XPATH = `//span[${hasClass("factions-joined")}]`;
const INSTALL_XPATH = "//button[normalize-space()='Install Augmentations']";
/** The queued augmentations' rows: the first `Paper` of the box after the one holding Install. */
const QUEUED_ROWS_XPATH =
  `${INSTALL_XPATH}/ancestor::div[${hasClass("MuiPaper-root")}][1]/following-sibling::div[1]/div[1]` +
  `//div[${hasClass("MuiListItemText-root")}]`;

/** The problems the page reader reports, worded once for its tests. */
export const factionStatePageProblems = {
  noRowProps: (section: string) => `a row on the Factions page (${section}) has no faction in its React props`,
  joinedMismatch: (page: string[], game: string[]) =>
    `the Factions page shows ${listOrNone(page)} joined, the game ${listOrNone(game)}`,
  noQueueCount: "the sidebar's Augmentations item has no count of the queued augmentations in its React props",
  queueMismatch: (read: number, count: number) =>
    `${read} queued augmentations read from the Augmentations page, but the sidebar counts ${count}`,
  oddNeuroFluxRow: (text: string, installedLevel: number) =>
    `the Augmentations page's "${text}" isn't a NeuroFlux Governor level above the installed ${installedLevel}`,
  sectionCollapsed: (pageName: string) => `"${pageName}" in the sidebar (is its section collapsed?)`,
};

const listOrNone = (names: string[]) => (names.length === 0 ? "none" : names.join(", "));

/** The game's `Faction` behind a row, as far as this reads it. */
interface FactionProp {
  name: string;
  playerReputation: number;
  favor: number;
}

function factionOfRow(row: Element): FactionProp | null {
  const faction = reactPropsAbove(row, "faction")?.faction as Partial<FactionProp> | undefined;
  if (typeof faction !== "object" || faction === null) return null;
  const { name, playerReputation, favor } = faction;
  if (typeof name !== "string" || typeof playerReputation !== "number" || typeof favor !== "number") return null;
  return { name, playerReputation, favor };
}

/** Every row's faction in a section of the Factions page open now, or the problem. */
function factionsIn(gamePage: GamePage, section: string): FactionProp[] | string {
  const factions: FactionProp[] = [];
  for (const row of gamePage.findAllNow(factionRowsXpath(section))) {
    const faction = factionOfRow(row);
    if (faction === null) return factionStatePageProblems.noRowProps(section);
    factions.push(faction);
  }
  return factions;
}

/**
 * Whether the sidebar shows `pageName`'s item now: true, false (Stats shows beside it, so the game shows none), or the
 * problem (the Character section is collapsed, so neither shows).
 */
function sidebarShows(gamePage: GamePage, pageName: string): boolean | string {
  if (gamePage.findElementNow(sidebarItemXpath(pageName)) !== null) return true;
  return gamePage.findElementNow(sidebarItemXpath("Stats")) !== null
    ? false
    : factionStatePageProblems.sectionCollapsed(pageName);
}

/** The sidebar's count of queued augmentations (the Augmentations item's `count` prop), or the problem. */
function queuedCount(gamePage: GamePage): number | string {
  const item = gamePage.findElementNow(sidebarItemXpath("Augmentations"));
  const count = item === null ? undefined : reactPropsAbove(item, "key_")?.count;
  return typeof count === "number" ? count : factionStatePageProblems.noQueueCount;
}

/** The joined factions and the invitations, from the Factions page if the sidebar shows it. */
async function readFactionsPage(
  gamePage: GamePage,
  gameFactions: string[],
): Promise<Pick<FactionState, "joined" | "invitations"> | string> {
  const shown = sidebarShows(gamePage, "Factions");
  if (typeof shown === "string") return shown;
  let joined: JoinedFaction[] = [];
  let invitations: string[] = [];
  if (shown) {
    const opened = await gamePage.openSidebarPage("Factions");
    if (opened !== null) return opened;
    if ((await gamePage.findWhenThere(JOINED_SECTION_XPATH)) === null) return "no joined factions' section on the page";
    const joinedRows = factionsIn(gamePage, "factions-joined");
    if (typeof joinedRows === "string") return joinedRows;
    const invitedRows = factionsIn(gamePage, "factions-invites");
    if (typeof invitedRows === "string") return invitedRows;
    joined = joinedRows.map(({ name, playerReputation, favor }) => ({ name, reputation: playerReputation, favor }));
    invitations = invitedRows.map(({ name }) => name);
  }
  const pageNames = joined.map(({ name }) => name);
  if ([...pageNames].sort().join("\n") !== [...gameFactions].sort().join("\n")) {
    return factionStatePageProblems.joinedMismatch(pageNames, gameFactions);
  }
  return { joined, invitations };
}

/**
 * The queue in the game's form from the Augmentations page's rows: NeuroFlux's one row becomes a copy per level queued
 * above `installedNeuroFluxLevel`. Exported for its tests.
 */
export function queueFromRows(rows: string[], installedNeuroFluxLevel: number): string[] | string {
  const queue: string[] = [];
  for (const row of rows) {
    if (!row.startsWith(NEUROFLUX_ROW_START)) {
      queue.push(row);
      continue;
    }
    const level = Number(row.slice(NEUROFLUX_ROW_START.length));
    if (!Number.isInteger(level) || level <= installedNeuroFluxLevel) {
      return factionStatePageProblems.oddNeuroFluxRow(row, installedNeuroFluxLevel);
    }
    for (let copy = installedNeuroFluxLevel; copy < level; copy += 1) queue.push(NEUROFLUX_GOVERNOR);
  }
  return queue;
}

/** The queued augmentations: none without the page if the sidebar says so, else from the Augmentations page. */
async function readQueue(gamePage: GamePage, installedNeuroFluxLevel: number): Promise<string[] | string> {
  const shown = sidebarShows(gamePage, "Augmentations");
  if (typeof shown === "string") return shown;
  if (!shown) return [];
  const countBefore = queuedCount(gamePage);
  if (typeof countBefore === "string") return countBefore;
  if (countBefore === 0) return [];
  const opened = await gamePage.openSidebarPage("Augmentations");
  if (opened !== null) return opened;
  if ((await gamePage.findWhenThere(INSTALL_XPATH)) === null) return 'no "Install Augmentations" on the page';
  const rows = gamePage.findAllNow(QUEUED_ROWS_XPATH).map((row) => (row.textContent ?? "").replace(/\s+/g, " ").trim());
  const queue = queueFromRows(rows, installedNeuroFluxLevel);
  if (typeof queue === "string") return queue;
  // Read again now: the page and the sidebar render from the same game state.
  const count = queuedCount(gamePage);
  if (typeof count === "string") return count;
  return queue.length === count ? queue : factionStatePageProblems.queueMismatch(queue.length, count);
}

/**
 * Reads the faction state from the page: the Factions page, then the Augmentations page, each only if there's
 * something on it. `gameFactions` is `getPlayer().factions`; `installedNeuroFluxLevel` NeuroFlux Governor's installed
 * level (`getResetInfo().ownedAugs`). Sets `read.state`, or returns the problem.
 */
export async function readFactionStateOnPage(
  gamePage: GamePage,
  { gameFactions, installedNeuroFluxLevel }: { gameFactions: string[]; installedNeuroFluxLevel: number },
  read: { state: FactionState | null },
): Promise<string | null> {
  const factions = await readFactionsPage(gamePage, gameFactions);
  if (typeof factions === "string") return factions;
  const queuedAugmentations = await readQueue(gamePage, installedNeuroFluxLevel);
  if (typeof queuedAugmentations === "string") return queuedAugmentations;
  read.state = { ...factions, queuedAugmentations };
  return null;
}
