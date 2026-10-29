// @vitest-environment jsdom
// The faction state on the page (#197): which pages are opened, and only for what may have changed; the Factions
// page's rows, read from their React props (the game's own `Faction`, unrounded), a gang's box too; the Augmentations
// page's queue; the worked faction's reputation from its always-mounted prop; each check that fails loudly; and around
// it, `reportPageEffect` putting the page back as found. A stand-in page with React's props and fibers on its
// elements, as the game renders them. E2 reads the real page (packages/e2/test/effectors.e2.test.ts).
import type { FactionState } from "@bitburner-agent/core";
import { afterEach, describe, expect, test } from "vitest";
import type { NS } from "../../src/ns.ts";
import {
  FACTIONS_PAGE_REFRESH_MS,
  type FactionGameFacts,
  type FactionPageMemory,
  type FactionReadContext,
  factionStatePageProblems,
  pagesToOpen,
  queueFromRows,
  readFactionStateOnPage,
  type SidebarFacts,
  sidebarFacts,
  workedFactionReputation,
} from "../../src/page/faction-state-page.ts";
import { openGamePage } from "../../src/page/game-page.ts";
import { reportPageEffect } from "../../src/page/page-effect.ts";

const clicks: string[] = [];
const reports: unknown[] = [];
const ns = {
  asleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  pid: 7,
  writePort: (_port: number, report: { data: unknown }) => reports.push(report.data),
} as unknown as NS;

afterEach(() => {
  clicks.length = 0;
  reports.length = 0;
  document.body.replaceChildren();
});

const element = (tag: string, fields: Record<string, unknown> = {}) =>
  Object.assign(document.createElement(tag), fields);

/** React's fiber on `node`: its own props, then each component's above it, innermost first. */
function withFibers<T extends Element>(node: T, ...propsUpward: Record<string, unknown>[]): T {
  let fiber: unknown = null;
  for (const props of [...propsUpward].reverse()) fiber = { memoizedProps: props, memoizedState: null, return: fiber };
  return Object.assign(node, { __reactFiber$test: { memoizedProps: {}, memoizedState: null, return: fiber } });
}

/** A clickable element, its React `onClick` recording the click. */
const clickable = <T extends HTMLElement>(node: T, label: string, onClick: () => void = () => {}): T =>
  Object.assign(node, {
    __reactProps$test: {
      onClick: () => {
        clicks.push(label);
        onClick();
      },
    },
  });

/** The game's `Faction`, as far as the page shows it: `favor` a getter, as in `Faction/Faction.ts:38-40`. */
class StandInFaction {
  readonly name: string;
  readonly playerReputation: number;
  readonly #favor: number;
  constructor(name: string, playerReputation: number, favor: number) {
    this.name = name;
    this.playerReputation = playerReputation;
    this.#favor = favor;
  }
  get favor() {
    return this.#favor;
  }
}

/** A faction's row: a `Paper` whose `FactionElement` holds the faction (`Faction/ui/FactionsRoot.tsx:71-75`). */
function factionRow(faction: unknown, onDetails: () => void = () => {}): HTMLElement {
  const name = (faction as { name?: string } | null)?.name ?? "?";
  const paper = withFibers(element("div", { className: "MuiPaper-root css-1" }), { elevation: 1 }, { faction });
  // A component inside the row with the same prop (`WorkTypesOffered`): never the one read.
  paper.append(
    withFibers(element("span", { textContent: name }), { faction: { name: "not this one" } }),
    clickable(element("button", { textContent: "Details" }), `Details on ${name}`, onDetails),
  );
  return paper;
}

/** A section of the Factions page: `span.<section>`, a heading and a `Box` of rows for each group (a gang's first). */
function factionSection(section: string, ...groups: HTMLElement[][]): HTMLElement {
  const span = element("span", { className: section });
  for (const rows of groups) {
    const box = element("div", { className: "MuiBox-root" });
    box.append(...rows);
    span.append(element("h5", { textContent: section }), box);
  }
  return span;
}

/** The Augmentations page: Install's `Paper`, then the box of the queue's `Paper` (a row per queued) and the mults. */
function augmentationsPage(rows: string[]): HTMLElement {
  const container = element("div");
  const top = element("div", { className: "MuiPaper-root" });
  const buttons = element("div", { className: "MuiBox-root" });
  const wrapper = element("span");
  wrapper.append(element("button", { textContent: "Install Augmentations", disabled: rows.length === 0 }));
  buttons.append(wrapper, element("button", { textContent: "Backup Save" }));
  top.append(element("h5", { textContent: "Purchased Augmentations" }), buttons);
  const box = element("div", { className: "MuiBox-root" });
  const queue = element("div", { className: "MuiPaper-root" });
  const list = element("ul", { className: "MuiList-root" });
  for (const row of rows) {
    const text = element("div", { className: "MuiListItemText-root" });
    text.append(element("span", { textContent: `  ${row} ` }));
    list.append(text);
  }
  queue.append(list);
  // The multipliers' paper, which isn't read.
  const multipliers = element("div", { className: "MuiPaper-root" });
  multipliers.append(element("div", { className: "MuiListItemText-root", textContent: "Hacking Chance" }));
  box.append(queue, multipliers);
  container.append(top, box);
  return container;
}

/** The `Reputation` component's span, its prop the number (`ui/React/Reputation.tsx`). */
const reputationSpan = (reputation: number | string) =>
  withFibers(element("span", { textContent: String(reputation) }), { reputation });

/** The overview's work, unfocused (`CharacterOverview.tsx:252-269`, `:332-346`): two rows, the rate's span after. */
function overviewWork(faction: string, reputation: number): HTMLElement {
  const table = element("table");
  const header = element("tr");
  const headerCell = element("th");
  const title = element("p", { textContent: "Working for " });
  title.append(element("strong", { textContent: faction }));
  headerCell.append(title);
  header.append(headerCell);
  const values = element("tr");
  const valuesCell = element("th");
  const text = element("p");
  text.append(reputationSpan(reputation), " rep", element("br"), "(", reputationSpan("1.234 / sec"), ")");
  valuesCell.append(text);
  values.append(valuesCell);
  table.append(header, values);
  return table;
}

interface StandInGame {
  joined?: StandInFaction[];
  /** A gang's faction: its own box, first, under `span.factions-joined` (`FactionsRoot.tsx:281-290`). */
  gang?: StandInFaction;
  invited?: StandInFaction[];
  queueRows?: string[];
  /** The sidebar Augmentations item's `count` prop: the queue's length unless said. */
  queueCount?: number | undefined;
  /** The Factions item's badge: the invitations not yet seen; all of them unless said. */
  invitationsBadge?: number;
  factionsShown?: boolean;
  augmentationsShown?: boolean;
  statsShown?: boolean;
  joinedRows?: () => HTMLElement[];
  /** The page shown at the start, by its sidebar item. */
  startOn?: string;
  /** The overview's faction work: the faction and its reputation. */
  working?: { faction: string; reputation: number };
}

/** The stand-in game: the sidebar (its items' `key_`, `count` and `active` props), and the page each opens. */
function standInGame(options: StandInGame = {}) {
  const { joined = [], gang, invited = [], queueRows = [], statsShown = true } = options;
  const queueCount = "queueCount" in options ? options.queueCount : queueRows.length;
  let invitationsBadge = options.invitationsBadge ?? invited.length;
  const factionsShown = options.factionsShown ?? joined.length + invited.length + (gang ? 1 : 0) > 0;
  const augmentationsShown = options.augmentationsShown ?? queueRows.length > 0;
  const main = element("main");
  const pages: Record<string, () => HTMLElement[]> = {
    Stats: () => [element("h4", { textContent: "Stats" })],
    Terminal: () => [element("input", { id: "terminal-input" })],
    Factions: () => {
      // Opening it marks the invitations seen (`FactionsRoot.tsx:220-224`).
      invitationsBadge = 0;
      const factionPage = (faction: StandInFaction) => () => {
        main.replaceChildren(
          element("button", { textContent: "Back" }),
          element("h4", { textContent: faction.name }),
          element("p", { textContent: `${faction.name}'s page` }),
        );
      };
      const rows = options.joinedRows?.() ?? joined.map((faction) => factionRow(faction, factionPage(faction)));
      return [
        element("h4", { textContent: "Factions" }),
        factionSection(
          "factions-invites",
          invited.map((faction) => factionRow(faction)),
        ),
        gang
          ? factionSection("factions-joined", [factionRow(gang, factionPage(gang))], rows)
          : factionSection("factions-joined", rows),
      ];
    },
    Augmentations: () => [augmentationsPage(queueRows)],
  };
  let active = options.startOn ?? "Terminal";
  const sidebar = element("div", { className: "MuiDrawer-root MuiDrawer-docked" });
  const renderSidebar = () => {
    const items: HTMLElement[] = [];
    const item = (label: string, props: Record<string, unknown> = {}) => {
      const node = withFibers(
        element("div"),
        { className: "MuiListItem-root" },
        { key_: label, active: active === label, ...props },
      );
      node.setAttribute("role", "button");
      node.append(element("p", { textContent: label }));
      items.push(
        clickable(node, label, () => {
          active = label;
          main.replaceChildren(...(pages[label]?.() ?? []));
          renderSidebar();
        }),
      );
    };
    if (statsShown) item("Stats");
    if (factionsShown) item("Factions", { count: invitationsBadge });
    if (augmentationsShown) item("Augmentations", { count: queueCount });
    item("Terminal");
    sidebar.replaceChildren(...items);
  };
  renderSidebar();
  main.replaceChildren(...(pages[active]?.() ?? []));
  const overview = element("div");
  if (options.working) overview.append(overviewWork(options.working.faction, options.working.reputation));
  document.body.replaceChildren(sidebar, main, overview);
  return { main };
}

const CYBERSEC = new StandInFaction("CyberSec", 1234.5678, 2.5);
const NITESEC = new StandInFaction("NiteSec", 0.25, 0);
const SECTOR_12 = new StandInFaction("Sector-12", 0, 0);
const SLUM_SNAKES = new StandInFaction("Slum Snakes", 7, 1);
const NOW_MS = 1_000_000_000;
const FIRST: FactionReadContext = { memory: null, invitationAnswered: false, augmentationBought: false };
const game = (joined: string[], changes: Partial<FactionGameFacts> = {}): FactionGameFacts => ({
  joined,
  lastAugReset: 5,
  installedNeuroFluxLevel: 0,
  nowMs: NOW_MS,
  ...changes,
});
/** The memory of a read a minute ago: CyberSec joined, Sector-12 invited, a queue of `queue`. */
const memoryOf = (state: Partial<FactionState> = {}, changes: Partial<FactionPageMemory> = {}): FactionPageMemory => ({
  state: {
    joined: [{ name: "CyberSec", reputation: 1000, favor: 2.5 }],
    invitations: ["Sector-12"],
    queuedAugmentations: [],
    ...state,
  },
  lastAugReset: 5,
  factionsReadAtMs: NOW_MS - 60_000,
  ...changes,
});
const since = (memory: FactionPageMemory, news: Partial<FactionReadContext> = {}): FactionReadContext => ({
  memory,
  invitationAnswered: false,
  augmentationBought: false,
  ...news,
});

async function read(context: FactionReadContext, facts: FactionGameFacts) {
  const gamePage = openGamePage(ns, Date.now() + 1_500);
  if (!gamePage) throw new Error("no page");
  const result: { state: FactionState | null; opened: string[]; memory: FactionPageMemory | null } = {
    state: null,
    opened: [],
    memory: null,
  };
  const worked = workedFactionReputation(gamePage);
  const problem = await readFactionStateOnPage(gamePage, context, facts, worked, result);
  return { problem, ...result };
}

describe("which pages are opened (`pagesToOpen`)", () => {
  const seen: SidebarFacts = {
    sidebar: true,
    factionsShown: true,
    invitationsBadge: 0,
    augmentationsShown: true,
    queueCount: 0,
  };
  const hidden: SidebarFacts = {
    sidebar: false,
    factionsShown: null,
    invitationsBadge: null,
    augmentationsShown: null,
    queueCount: null,
  };
  const memory = memoryOf();

  test("nothing changed, read a minute ago: neither, the sidebar seen or hidden (the Work page)", () => {
    expect(pagesToOpen(since(memory), game(["CyberSec"]), seen)).toEqual({ factions: false, augmentations: false });
    expect(pagesToOpen(since(memory), game(["CyberSec"]), hidden)).toEqual({ factions: false, augmentations: false });
  });

  test.each([
    ["no reading yet", FIRST, game(["CyberSec"]), seen],
    ["the reset moved", since(memory), game(["CyberSec"], { lastAugReset: 6 }), seen],
    ["a faction joined", since(memory), game(["CyberSec", "NiteSec"]), seen],
    ["an invitation answered", since(memory, { invitationAnswered: true }), game(["CyberSec"]), hidden],
    ["an invitation in the badge", since(memory), game(["CyberSec"]), { ...seen, invitationsBadge: 1 }],
    [
      "10 minutes since it was read",
      since(memoryOf({}, { factionsReadAtMs: NOW_MS - FACTIONS_PAGE_REFRESH_MS })),
      game(["CyberSec"]),
      seen,
    ],
  ])("Factions: %s", (_description, context, facts, sidebar) => {
    expect(pagesToOpen(context, facts, sidebar).factions).toBe(true);
  });

  test("never Factions with nothing joined and no invitation, even after 10 minutes; nor where the sidebar shows none", () => {
    const empty = memoryOf(
      { joined: [], invitations: [] },
      { factionsReadAtMs: NOW_MS - 2 * FACTIONS_PAGE_REFRESH_MS },
    );
    expect(pagesToOpen(since(empty), game([]), seen).factions).toBe(false);
    expect(pagesToOpen(FIRST, game([]), { ...seen, factionsShown: false }).factions).toBe(false);
    // Just under 10 minutes: not yet.
    const recent = memoryOf({}, { factionsReadAtMs: NOW_MS - FACTIONS_PAGE_REFRESH_MS + 1 });
    expect(pagesToOpen(since(recent), game(["CyberSec"]), seen).factions).toBe(false);
  });

  test("Augmentations: the count other than the queue read, or bought while the sidebar is hidden; never with none", () => {
    const two = memoryOf({ queuedAugmentations: ["BitWire", "Neurotrainer I"] });
    expect(pagesToOpen(since(two), game(["CyberSec"]), { ...seen, queueCount: 2 }).augmentations).toBe(false);
    expect(pagesToOpen(since(two), game(["CyberSec"]), { ...seen, queueCount: 3 }).augmentations).toBe(true);
    expect(pagesToOpen(since(two), game(["CyberSec"]), { ...seen, queueCount: 0 }).augmentations).toBe(false);
    expect(pagesToOpen(since(two, { augmentationBought: true }), game(["CyberSec"]), hidden).augmentations).toBe(true);
    expect(pagesToOpen(since(two), game(["CyberSec"]), hidden).augmentations).toBe(false);
    expect(pagesToOpen(FIRST, game(["CyberSec"]), { ...seen, queueCount: 1 }).augmentations).toBe(true);
    expect(
      pagesToOpen(since(two), game(["CyberSec"], { lastAugReset: 9 }), { ...seen, queueCount: 2 }).augmentations,
    ).toBe(true);
  });
});

describe("reading the page", () => {
  test("the first read: each joined faction's reputation and favour, unrounded, from its props, a gang's too; the invitations; the queue", async () => {
    standInGame({
      gang: SLUM_SNAKES,
      joined: [CYBERSEC, NITESEC],
      invited: [SECTOR_12],
      queueRows: ["Neurotrainer I", "NeuroFlux Governor - Level 4", "BitWire"],
      queueCount: 4,
    });
    const result = await read(FIRST, game(["NiteSec", "CyberSec", "Slum Snakes"], { installedNeuroFluxLevel: 2 }));
    expect(result).toMatchObject({
      problem: null,
      opened: ["Factions", "Augmentations"],
      state: {
        joined: [
          { name: "Slum Snakes", reputation: 7, favor: 1 },
          { name: "CyberSec", reputation: 1234.5678, favor: 2.5 },
          { name: "NiteSec", reputation: 0.25, favor: 0 },
        ],
        invitations: ["Sector-12"],
        queuedAugmentations: ["Neurotrainer I", "NeuroFlux Governor", "NeuroFlux Governor", "BitWire"],
      },
    });
    expect(result.memory).toEqual({ state: result.state, lastAugReset: 5, factionsReadAtMs: NOW_MS });
    expect(clicks).toEqual(["Factions", "Augmentations"]);
  });

  test("nothing changed: no page opened, the last reading, the worked faction's reputation from the overview's prop", async () => {
    standInGame({ joined: [CYBERSEC], working: { faction: "CyberSec", reputation: 1500.25 } });
    const memory = memoryOf({ queuedAugmentations: ["BitWire"] });
    const result = await read(since(memory), game(["CyberSec"]));
    expect(clicks).toEqual([]);
    expect(result).toMatchObject({
      problem: null,
      opened: [],
      state: { joined: [{ name: "CyberSec", reputation: 1500.25, favor: 2.5 }], invitations: ["Sector-12"] },
    });
    // The sidebar's count (0 here) says the queue is empty: what it says goes, without the page.
    expect(result.state?.queuedAugmentations).toEqual([]);
    // When Factions was read is kept, so its refresh comes 10 minutes after it.
    expect(result.memory?.factionsReadAtMs).toBe(memory.factionsReadAtMs);
  });

  test("an invitation in the badge: Factions alone; the badge is then gone", async () => {
    standInGame({ joined: [CYBERSEC], invited: [SECTOR_12], invitationsBadge: 1, queueRows: ["BitWire"] });
    const result = await read(
      since(memoryOf({ invitations: [], queuedAugmentations: ["BitWire"] })),
      game(["CyberSec"]),
    );
    expect(result.opened).toEqual(["Factions"]);
    expect(result.state?.invitations).toEqual(["Sector-12"]);
    // Read now: its 10-minute refresh counts from here.
    expect(result.memory?.factionsReadAtMs).toBe(NOW_MS);
    expect(result.state?.queuedAugmentations).toEqual(["BitWire"]);
    const gamePage = openGamePage(ns, Date.now() + 1_500);
    expect(gamePage && sidebarFacts(gamePage).invitationsBadge).toBe(0);
  });

  test("the sidebar's queue count other than the last read: Augmentations alone", async () => {
    standInGame({ joined: [CYBERSEC], queueRows: ["BitWire", "Neurotrainer I"] });
    const result = await read(since(memoryOf({ queuedAugmentations: ["BitWire"] })), game(["CyberSec"]));
    expect(clicks).toEqual(["Augmentations"]);
    expect(result.state?.queuedAugmentations).toEqual(["BitWire", "Neurotrainer I"]);
  });

  test("nothing joined, invited or queued: nothing in the sidebar to read, so no page is opened", async () => {
    standInGame();
    expect(await read(FIRST, game([]))).toMatchObject({
      problem: null,
      opened: [],
      state: { joined: [], invitations: [], queuedAugmentations: [] },
    });
    expect(clicks).toEqual([]);
  });
});

describe("the worked faction's reputation, from its always-mounted prop", () => {
  test("the overview's, unfocused: its first span's `reputation`, not the rate's", () => {
    standInGame({ working: { faction: "CyberSec", reputation: 42.5 } });
    const gamePage = openGamePage(ns, Date.now() + 1_500);
    expect(gamePage && workedFactionReputation(gamePage)).toEqual({ faction: "CyberSec", reputation: 42.5 });
  });

  test("the Work page's, focused: 'Current Faction Reputation:' under the title naming the faction", () => {
    const title = element("h6", { textContent: "You are currently carrying out hacking contracts for " });
    title.append(element("b", { textContent: "NiteSec" }));
    const description = element("p", { textContent: "Current Faction Reputation: " });
    description.append(reputationSpan(7.75), " (", reputationSpan("0.5 / sec"), ")");
    document.body.replaceChildren(title, description);
    const gamePage = openGamePage(ns, Date.now() + 1_500);
    expect(gamePage && workedFactionReputation(gamePage)).toEqual({ faction: "NiteSec", reputation: 7.75 });
  });

  test("no faction work shown: none", () => {
    standInGame();
    const gamePage = openGamePage(ns, Date.now() + 1_500);
    expect(gamePage && workedFactionReputation(gamePage)).toBeNull();
  });
});

describe("checks that fail loudly: a problem, never an empty state", () => {
  test("a joined faction the page doesn't show, or one the game doesn't have", async () => {
    standInGame({ joined: [CYBERSEC] });
    expect(await read(FIRST, game(["CyberSec", "NiteSec"]))).toMatchObject({
      problem: factionStatePageProblems.joinedMismatch(["CyberSec"], ["CyberSec", "NiteSec"]),
      state: null,
    });
    standInGame();
    expect((await read(FIRST, game(["CyberSec"]))).problem).toBe(
      "the Factions page shows none joined, the game CyberSec",
    );
  });

  test("a row without its faction in React props (a game version that renders it otherwise)", async () => {
    standInGame({ joined: [CYBERSEC], joinedRows: () => [factionRow({ name: "CyberSec" })] });
    expect(await read(FIRST, game(["CyberSec"]))).toMatchObject({
      problem: "a row on the Factions page (factions-joined) has no faction in its React props",
      state: null,
    });
  });

  test("the queue read shorter than the sidebar's count", async () => {
    standInGame({ joined: [CYBERSEC], queueRows: ["Neurotrainer I"], queueCount: 2 });
    expect(await read(FIRST, game(["CyberSec"]))).toMatchObject({
      problem: "1 queued augmentations read from the Augmentations page, but the sidebar counts 2",
      state: null,
    });
  });

  test("no count in the Augmentations item's props", async () => {
    standInGame({ joined: [CYBERSEC], queueRows: ["Neurotrainer I"], queueCount: undefined });
    expect((await read(FIRST, game(["CyberSec"]))).problem).toBe(factionStatePageProblems.noQueueCount);
  });

  test("the Character section collapsed (no Stats, no Factions): it can't tell, so it says so", async () => {
    standInGame({ joined: [CYBERSEC], statsShown: false, factionsShown: false });
    expect(await read(FIRST, game(["CyberSec"]))).toMatchObject({
      problem: '"Factions" in the sidebar (is its section collapsed?)',
      state: null,
    });
  });
});

describe("queueFromRows", () => {
  test("NeuroFlux's copies are its level less the installed, in its row's place", () => {
    expect(queueFromRows(["NeuroFlux Governor - Level 2", "Neurotrainer I"], 0)).toEqual([
      "NeuroFlux Governor",
      "NeuroFlux Governor",
      "Neurotrainer I",
    ]);
    expect(queueFromRows(["NeuroFlux Governor - Level 6"], 5)).toEqual(["NeuroFlux Governor"]);
  });

  test.each([
    ["no level above the installed", "NeuroFlux Governor - Level 3", 3],
    ["a level that isn't a number", "NeuroFlux Governor - Level x", 0],
  ])("%s: the problem", (_description, row, installed) => {
    expect(queueFromRows([row], installed)).toBe(factionStatePageProblems.oddNeuroFluxRow(row, installed));
  });
});

describe("around it, the page put back as found", () => {
  /** The read through `reportPageEffect`, as the worker runs it, the page put back as found. */
  async function readAround(context: FactionReadContext, facts: FactionGameFacts) {
    const result: { state: FactionState | null; opened: string[]; memory: FactionPageMemory | null } = {
      state: null,
      opened: [],
      memory: null,
    };
    await reportPageEffect(ns, Date.now() + 1_500, {
      isDone: () => result.state !== null,
      doing: "read the faction state through",
      steps: (gamePage) => readFactionStateOnPage(gamePage, context, facts, null, result),
      notDoneAfter: "the faction state wasn't read",
      reportAlso: () => ({ state: result.state }),
      restoreFoundPage: true,
    });
    return result;
  }

  test("from Stats: read, then Stats again, not the Terminal", async () => {
    standInGame({ joined: [CYBERSEC], startOn: "Stats" });
    await readAround(FIRST, game(["CyberSec"]));
    expect(clicks).toEqual(["Factions", "Stats"]);
    expect(reports).toEqual([{ done: true, problem: null, state: expect.objectContaining({ invitations: [] }) }]);
  });

  test("from a faction's own page: Factions, then 'Details' on its row", async () => {
    const { main } = standInGame({ joined: [CYBERSEC, NITESEC], startOn: "Factions" });
    // The owner opened NiteSec's page from the list.
    const details = [...main.querySelectorAll("button")].find(
      (button) => button.parentElement?.textContent?.startsWith("NiteSec") && button.textContent === "Details",
    );
    (details as unknown as { __reactProps$test: { onClick: () => void } }).__reactProps$test.onClick();
    clicks.length = 0;
    expect(main.textContent).toContain("NiteSec's page");
    await readAround(FIRST, game(["CyberSec", "NiteSec"]));
    expect(clicks).toEqual(["Factions", "Factions", "Details on NiteSec"]);
    expect(main.textContent).toContain("NiteSec's page");
  });

  test("focused work: unfocused for the read, then focused again", async () => {
    standInGame({ joined: [CYBERSEC] });
    const game_ = [...document.body.children];
    const focus = clickable(element("button", { textContent: "Focus" }), "Focus");
    const unfocus = clickable(element("button", { textContent: "Do something else simultaneously" }), "unfocus", () =>
      document.body.replaceChildren(...game_, focus),
    );
    document.body.replaceChildren(unfocus);
    await readAround(FIRST, game(["CyberSec"]));
    expect(clicks).toEqual(["unfocus", "Factions", "Focus"]);
  });
});
