// The faction state on the game's page (#197), for `faction-state.js` (../entries/): each joined faction's reputation
// and favour, the invitations, and the queued augmentations, which no NS call has without Singularity. A module of its
// own so its jsdom tests can import it: an entry's bundle exports only `main`.
// - No always-mounted component holds them all: every one reads the `Player` singleton itself. What is always there:
//   - the worked faction's reputation, the `Reputation` component's prop on the Work page focused
//     (`ui/WorkInProgressRoot.tsx:397`), or on the overview unfocused (`ui/React/CharacterOverview.tsx:342`);
//   - the sidebar's counts: the Augmentations item's `count` prop is the queue's length, the Factions item's the
//     invitations not yet seen (`Sidebar/ui/SidebarRoot.tsx:152-153`, `:374-384`, passed on by
//     `SidebarAccordion.tsx:82-96`, refreshed every game cycle, `SidebarRoot.tsx:127`).
// - So the pages are opened only for what changed (`pagesToOpen`); otherwise the last reading stands, with the worked
//   faction's reputation from its prop.
//   - **Factions** (`Faction/ui/FactionsRoot.tsx`): with no reading yet, the reset moved, the factions joined changed,
//     an invitation answered or one in the badge, or 10 minutes since it was last opened, and never with nothing
//     joined and no invitation. A row per faction, a `Paper` whose component's `faction` prop is the game's own
//     `Faction` (`:71-75`), with `playerReputation` and `favor` unrounded (the text rounds them, `:207-210`). The
//     invitations are under `span.factions-invites` (`:229`, `:265-278`), the joined factions under
//     `span.factions-joined` (`:227`, `:280-304`), a gang's in a box of its own first. Opening it marks the invitations
//     seen (`:220-224`), so the badge for them goes, as it does for a player who looks.
//   - **Augmentations** (`Augmentation/ui/AugmentationsRoot.tsx:185-193`, `PurchasedAugmentations.tsx`): with no
//     reading yet, the reset moved, or the sidebar's count other than the queue last read (an augmentation bought, where
//     the sidebar is hidden). A row per queued augmentation by name, beside "Install Augmentations", NeuroFlux Governor
//     once, as "NeuroFlux Governor - Level N", the level the last one queued gives (`:13-31`;
//     `PlayerObjectGeneralMethods.ts:472-498`). Its copies are N less the level installed, placed at its row.
// - Each item shows only with something there (Factions: anything joined, invited or rumoured, or any augmentation or
//   Source-File; Augmentations: any installed or queued: `SidebarRoot.tsx:157-169`), both beside Stats in the
//   Character section (`:364-389`). With Stats shown and the item absent, there's nothing there to read.
// - Checks that fail loudly: the joined rows are the game's `getPlayer().factions`, and the queue read is as long as the
//   sidebar's count.
import { type FactionState, type JoinedFaction, NEUROFLUX_GOVERNOR } from "@bitburner-agent/core";
import { type GamePage, hasClass, reactPropsAbove, sidebarItemXpath, UNFOCUS_XPATH } from "./game-page.ts";

/** The Factions page is opened again at least this often while anything is joined or invited (#197). */
export const FACTIONS_PAGE_REFRESH_MS = 10 * 60_000;

const NEUROFLUX_ROW_START = `${NEUROFLUX_GOVERNOR} - Level `;
/** Each faction's row in a section of the Factions page: the section's `Box`es, then their `Paper`s. */
const factionRowsXpath = (section: string) => `//span[${hasClass(section)}]/div/div[${hasClass("MuiPaper-root")}]`;
const JOINED_SECTION_XPATH = `//span[${hasClass("factions-joined")}]`;
const INSTALL_XPATH = "//button[normalize-space()='Install Augmentations']";
/** The queued augmentations' rows: the first `Paper` of the box after the one holding Install. */
const QUEUED_ROWS_XPATH =
  `${INSTALL_XPATH}/ancestor::div[${hasClass("MuiPaper-root")}][1]/following-sibling::div[1]/div[1]` +
  `//div[${hasClass("MuiListItemText-root")}]`;
/** The sidebar, a permanent MUI `Drawer` (`SidebarRoot.tsx:321`), absent from the pages that hide it. */
const SIDEBAR_XPATH = `//div[${hasClass("MuiDrawer-root")}]`;
/** The Work page's "Current Faction Reputation: …" (`ui/WorkInProgressRoot.tsx:395-399`, `:489-490`). */
const WORK_PAGE_REPUTATION = "//p[starts-with(normalize-space(), 'Current Faction Reputation:')]";
/** The overview's work, unfocused: "Working for <faction>", its reputation in the next row (`CharacterOverview.tsx:252-269`). */
const OVERVIEW_WORK_HEADER = "//p[starts-with(normalize-space(), 'Working for ')]";

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
  noSidebar: "no sidebar on the page (the BitVerse, an infiltration?)",
};

const listOrNone = (names: string[]) => (names.length === 0 ? "none" : names.join(", "));
const sameNames = (one: string[], other: string[]) => [...one].sort().join("\n") === [...other].sort().join("\n");

/** What the page's reader keeps between reads: the last state read, the reset it was read in, and when Factions was. */
export interface FactionPageMemory {
  state: FactionState;
  lastAugReset: number;
  /** When the Factions page was last read (or found to have nothing), by the game's `Date.now()`. */
  factionsReadAtMs: number;
}

/** What the Agent tells its worker: the memory, and what it saw happen since (#197). */
export interface FactionReadContext {
  memory: FactionPageMemory | null;
  /** The dialog watcher answered a faction invitation since the last read. */
  invitationAnswered: boolean;
  /** An augmentation purchase was reported done since the last read. */
  augmentationBought: boolean;
}

/** What the worker knows of the game without the page. */
export interface FactionGameFacts {
  /** `getPlayer().factions`. */
  joined: string[];
  /** `getResetInfo().lastAugReset`. */
  lastAugReset: number;
  /** NeuroFlux Governor's installed level (`getResetInfo().ownedAugs`). */
  installedNeuroFluxLevel: number;
  nowMs: number;
}

/** What the sidebar shows now, without opening anything: null where it can't tell (hidden, or the section collapsed). */
export interface SidebarFacts {
  sidebar: boolean;
  factionsShown: boolean | null;
  /** The Factions item's badge: invitations not yet seen. */
  invitationsBadge: number | null;
  augmentationsShown: boolean | null;
  /** The Augmentations item's count: the queue's length. */
  queueCount: number | null;
}

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

/** A sidebar item's `count` prop (`SidebarItem.tsx:11-17`), or null. */
function itemCount(item: Element): number | null {
  const count = reactPropsAbove(item, "key_")?.count;
  return typeof count === "number" ? count : null;
}

/** What the sidebar shows now (see `SidebarFacts`). */
export function sidebarFacts(gamePage: GamePage): SidebarFacts {
  const sidebar = gamePage.findElementNow(SIDEBAR_XPATH) !== null;
  const statsShown = gamePage.findElementNow(sidebarItemXpath("Stats")) !== null;
  const factions = gamePage.findElementNow(sidebarItemXpath("Factions"));
  const augmentations = gamePage.findElementNow(sidebarItemXpath("Augmentations"));
  const shown = (item: Element | null) => (item !== null ? true : statsShown ? false : null);
  const factionsShown = shown(factions);
  const augmentationsShown = shown(augmentations);
  return {
    sidebar,
    factionsShown,
    invitationsBadge: factions !== null ? itemCount(factions) : factionsShown === false ? 0 : null,
    augmentationsShown,
    queueCount: augmentations !== null ? itemCount(augmentations) : augmentationsShown === false ? 0 : null,
  };
}

/**
 * The faction worked and its reputation, from the `Reputation` component's prop: the Work page's, focused, or the
 * overview's, unfocused. Null with no faction work shown (or the overview collapsed).
 */
export function workedFactionReputation(gamePage: GamePage): { faction: string; reputation: number } | null {
  const shownOn = [
    {
      faction: `${WORK_PAGE_REPUTATION}/preceding-sibling::h6[1]//b`,
      reputation: `(${WORK_PAGE_REPUTATION}//span)[1]`,
    },
    {
      faction: `${OVERVIEW_WORK_HEADER}//strong`,
      reputation: `(${OVERVIEW_WORK_HEADER}/ancestor::tr[1]/following-sibling::tr[1]//span)[1]`,
    },
  ];
  for (const xpaths of shownOn) {
    const faction = gamePage.findElementNow(xpaths.faction);
    const shown = gamePage.findElementNow(xpaths.reputation);
    const reputation = shown === null ? undefined : reactPropsAbove(shown, "reputation")?.reputation;
    if (faction !== null && typeof reputation === "number") {
      return { faction: (faction.textContent ?? "").trim(), reputation };
    }
  }
  return null;
}

/**
 * Which pages to open (#197), from the memory, the game's facts and the sidebar's: Factions only for what may have
 * changed there or every 10 minutes, never with nothing joined and no invitation; Augmentations only for a queue that
 * may have changed. A sidebar that can't be seen (the Work page hides it) counts as no news from it.
 */
export function pagesToOpen(
  { memory, invitationAnswered, augmentationBought }: FactionReadContext,
  game: FactionGameFacts,
  facts: SidebarFacts,
): { factions: boolean; augmentations: boolean } {
  const resetMoved = memory !== null && memory.lastAugReset !== game.lastAugReset;
  let factions = false;
  if (facts.factionsShown !== false) {
    if (
      memory === null ||
      resetMoved ||
      !sameNames(
        memory.state.joined.map(({ name }) => name),
        game.joined,
      ) ||
      invitationAnswered ||
      (facts.invitationsBadge ?? 0) > 0
    ) {
      factions = true;
    } else if (game.joined.length > 0 || memory.state.invitations.length > 0) {
      factions = game.nowMs - memory.factionsReadAtMs >= FACTIONS_PAGE_REFRESH_MS;
    }
  }
  let augmentations = false;
  if (facts.augmentationsShown !== false && facts.queueCount !== 0) {
    augmentations =
      memory === null ||
      resetMoved ||
      (facts.queueCount === null ? augmentationBought : facts.queueCount !== memory.state.queuedAugmentations.length);
  }
  return { factions, augmentations };
}

/**
 * The queue in the game's form from the Augmentations page's rows: NeuroFlux's one row becomes a copy per level queued
 * above `installedNeuroFluxLevel`, in its row's place. Exported for its tests.
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

/** The joined factions and the invitations from the Factions page, opened now. */
async function readFactionsPage(gamePage: GamePage): Promise<Pick<FactionState, "joined" | "invitations"> | string> {
  const opened = await gamePage.openSidebarPage("Factions");
  if (opened !== null) return opened;
  if ((await gamePage.findWhenThere(JOINED_SECTION_XPATH)) === null) return "no joined factions' section on the page";
  const joinedRows = factionsIn(gamePage, "factions-joined");
  if (typeof joinedRows === "string") return joinedRows;
  const invitedRows = factionsIn(gamePage, "factions-invites");
  if (typeof invitedRows === "string") return invitedRows;
  return {
    joined: joinedRows.map(({ name, playerReputation, favor }) => ({ name, reputation: playerReputation, favor })),
    invitations: invitedRows.map(({ name }) => name),
  };
}

/** The queue from the Augmentations page, opened now, checked against the sidebar's count. */
async function readQueuePage(gamePage: GamePage, installedNeuroFluxLevel: number): Promise<string[] | string> {
  const opened = await gamePage.openSidebarPage("Augmentations");
  if (opened !== null) return opened;
  if ((await gamePage.findWhenThere(INSTALL_XPATH)) === null) return 'no "Install Augmentations" on the page';
  const rows = gamePage.findAllNow(QUEUED_ROWS_XPATH).map((row) => (row.textContent ?? "").replace(/\s+/g, " ").trim());
  const queue = queueFromRows(rows, installedNeuroFluxLevel);
  if (typeof queue === "string") return queue;
  // Read again now: the page and the sidebar render from the same game state.
  const count = sidebarFacts(gamePage).queueCount;
  if (count === null) return factionStatePageProblems.noQueueCount;
  return queue.length === count ? queue : factionStatePageProblems.queueMismatch(queue.length, count);
}

/** `joined` with the worked faction's reputation, where it's among them and the page didn't just read it. */
function withWorkedReputation(
  joined: JoinedFaction[],
  worked: { faction: string; reputation: number } | null,
): JoinedFaction[] {
  return joined.map((each) => (worked?.faction === each.name ? { ...each, reputation: worked.reputation } : each));
}

/**
 * The read (#197): the pages `pagesToOpen` says, opened now (the sidebar must be showing: the caller has unfocused a
 * focused player), the rest from the memory, the worked faction's reputation from its prop (`worked`, read before
 * anything moved). Sets `read.state`, `read.opened` and `read.memory`, or returns the problem. With nothing to open,
 * it opens nothing, so it also serves where the page mustn't move.
 */
export async function readFactionStateOnPage(
  gamePage: GamePage,
  context: FactionReadContext,
  game: FactionGameFacts,
  worked: { faction: string; reputation: number } | null,
  read: { state: FactionState | null; opened: string[]; memory: FactionPageMemory | null },
): Promise<string | null> {
  const facts = sidebarFacts(gamePage);
  const plan = pagesToOpen(context, game, facts);
  const { memory } = context;
  let factionsReadAtMs = memory?.factionsReadAtMs ?? game.nowMs;
  let joined: JoinedFaction[];
  let invitations: string[];
  if (facts.factionsShown === null && plan.factions) return factionStatePageProblems.sectionCollapsed("Factions");
  if (plan.factions) {
    const page = await readFactionsPage(gamePage);
    if (typeof page === "string") return page;
    read.opened.push("Factions");
    ({ joined, invitations } = page);
    factionsReadAtMs = game.nowMs;
  } else if (facts.factionsShown === false || memory === null) {
    // Nothing there to read: none joined or invited.
    joined = [];
    invitations = [];
    factionsReadAtMs = game.nowMs;
  } else {
    joined = withWorkedReputation(memory.state.joined, worked);
    invitations = memory.state.invitations;
  }
  const names = joined.map(({ name }) => name);
  if (!sameNames(names, game.joined)) return factionStatePageProblems.joinedMismatch(names, game.joined);
  let queuedAugmentations: string[];
  if (facts.augmentationsShown === null && plan.augmentations) {
    return factionStatePageProblems.sectionCollapsed("Augmentations");
  }
  if (plan.augmentations) {
    const page = await readQueuePage(gamePage, game.installedNeuroFluxLevel);
    if (typeof page === "string") return page;
    read.opened.push("Augmentations");
    queuedAugmentations = page;
  } else if (facts.queueCount === 0 || memory === null) {
    queuedAugmentations = [];
  } else {
    queuedAugmentations = memory.state.queuedAugmentations;
  }
  read.state = { joined, invitations, queuedAugmentations };
  read.memory = { state: read.state, lastAugReset: game.lastAugReset, factionsReadAtMs };
  return null;
}

/**
 * Whether the read must move the page (#197): a page to open, as far as can be told now. The Work page hides the
 * sidebar, so for a focused player only the memory and the Agent's news count.
 */
export function readMovesThePage(context: FactionReadContext, game: FactionGameFacts, facts: SidebarFacts): boolean {
  const plan = pagesToOpen(context, game, facts);
  return plan.factions || plan.augmentations;
}

/** Whether the page shows the Work page focused: its "Do something else simultaneously". */
export const focusedOnWork = (gamePage: GamePage) => gamePage.findElementNow(UNFOCUS_XPATH) !== null;
