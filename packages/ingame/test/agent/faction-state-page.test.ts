// @vitest-environment jsdom
// The faction state on the page (#197): the Factions page's rows, read from their React props (the game's own
// `Faction`, unrounded), the Augmentations page's queue, each page only when the sidebar shows something there, and
// each check that fails loudly; around it, `reportPageEffect` keeps the focus. A stand-in page with React's props and
// fibers on its elements, as the game renders them. E2 reads the real page (packages/e2/test/effectors.e2.test.ts).
import type { FactionState } from "@bitburner-agent/core";
import { afterEach, describe, expect, test } from "vitest";
import type { NS } from "../../src/ns.ts";
import { factionStatePageProblems, queueFromRows, readFactionStateOnPage } from "../../src/page/faction-state-page.ts";
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
function factionRow(faction: unknown, label = (faction as { name?: string } | null)?.name ?? "?"): HTMLElement {
  const paper = withFibers(
    element("div", { className: "MuiPaper-root css-1" }),
    { elevation: 1 },
    {
      faction,
      rerender: () => {},
    },
  );
  // A component inside the row with the same prop (`WorkTypesOffered`): never the one read.
  paper.append(element("span", { textContent: label }));
  return paper;
}

/** A section of the Factions page: `span.<section>`, its heading, then a `Box` of rows. */
function factionSection(section: string, rows: HTMLElement[]): HTMLElement {
  const span = element("span", { className: section });
  const box = element("div", { className: "MuiBox-root" });
  box.append(...rows);
  span.append(element("h5", { textContent: section }), box);
  return span;
}

/** The Augmentations page: Install's `Paper`, then the box of the queue's `Paper` (a row per queued) and the mults. */
function augmentationsPage(rows: string[]): HTMLElement {
  const container = element("div");
  const top = element("div", { className: "MuiPaper-root" });
  const buttons = element("div", { className: "MuiBox-root" });
  const install = element("button", { textContent: "Install Augmentations", disabled: rows.length === 0 });
  const wrapper = element("span");
  wrapper.append(install);
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
  const other = element("div", { className: "MuiListItemText-root", textContent: "Hacking Chance" });
  multipliers.append(other);
  box.append(queue, multipliers);
  container.append(top, box);
  return container;
}

/** The stand-in game: the sidebar's items (with the Augmentations count), and the page each opens in `main`. */
interface StandInGame {
  joined?: StandInFaction[];
  invited?: StandInFaction[];
  queueRows?: string[];
  /** The sidebar Augmentations item's `count` prop: the queue's length unless said. */
  queueCount?: number | undefined;
  factionsShown?: boolean;
  augmentationsShown?: boolean;
  statsShown?: boolean;
  joinedRows?: () => HTMLElement[];
}

function standInGame(options: StandInGame = {}) {
  const { joined = [], invited = [], queueRows = [], statsShown = true } = options;
  const queueCount = "queueCount" in options ? options.queueCount : queueRows.length;
  const factionsShown = options.factionsShown ?? joined.length + invited.length > 0;
  const augmentationsShown = options.augmentationsShown ?? queueRows.length > 0;
  const joinedRows = options.joinedRows ?? (() => joined.map((faction) => factionRow(faction)));
  const main = element("main");
  const sidebarItem = (label: string, page: () => HTMLElement[], props: Record<string, unknown> = {}) => {
    const item = withFibers(element("div"), { className: "MuiListItem-root" }, { key_: label, ...props });
    item.setAttribute("role", "button");
    item.append(element("p", { textContent: label }));
    Object.assign(item, {
      __reactProps$test: {
        onClick: () => {
          clicks.push(label);
          main.replaceChildren(...page());
        },
      },
    });
    return item;
  };
  const sidebar = element("nav");
  if (statsShown) sidebar.append(sidebarItem("Stats", () => []));
  if (factionsShown) {
    sidebar.append(
      sidebarItem("Factions", () => [
        factionSection(
          "factions-invites",
          invited.map((faction) => factionRow(faction)),
        ),
        factionSection("factions-joined", joinedRows()),
      ]),
    );
  }
  if (augmentationsShown) {
    sidebar.append(sidebarItem("Augmentations", () => [augmentationsPage(queueRows)], { count: queueCount }));
  }
  sidebar.append(sidebarItem("Terminal", () => [element("input", { id: "terminal-input" })]));
  document.body.replaceChildren(sidebar, main);
}

async function read(gameFactions: string[], installedNeuroFluxLevel = 0) {
  const gamePage = openGamePage(ns, Date.now() + 1_500);
  if (!gamePage) throw new Error("no page");
  const state: { state: FactionState | null } = { state: null };
  const problem = await readFactionStateOnPage(gamePage, { gameFactions, installedNeuroFluxLevel }, state);
  return { problem, state: state.state };
}

const CYBERSEC = new StandInFaction("CyberSec", 1234.5678, 2.5);
const NITESEC = new StandInFaction("NiteSec", 0.25, 0);
const SECTOR_12 = new StandInFaction("Sector-12", 0, 0);

describe("reading the page", () => {
  test("the Factions page: each joined faction's reputation and favour, unrounded, from its props; the invitations", async () => {
    standInGame({ joined: [CYBERSEC, NITESEC], invited: [SECTOR_12], queueRows: [] });
    expect(await read(["NiteSec", "CyberSec"])).toEqual({
      problem: null,
      state: {
        joined: [
          { name: "CyberSec", reputation: 1234.5678, favor: 2.5 },
          { name: "NiteSec", reputation: 0.25, favor: 0 },
        ],
        invitations: ["Sector-12"],
        queuedAugmentations: [],
      },
    });
    // Nothing queued nor installed: no Augmentations in the sidebar, so its page isn't opened.
    expect(clicks).toEqual(["Factions"]);
  });

  test("the queue: each row by name, NeuroFlux Governor's one row a copy per level above the installed", async () => {
    standInGame({
      joined: [CYBERSEC],
      queueRows: ["Neurotrainer I", "NeuroFlux Governor - Level 4", "BitWire"],
      queueCount: 4,
    });
    expect(await read(["CyberSec"], 2)).toEqual({
      problem: null,
      state: {
        joined: [{ name: "CyberSec", reputation: 1234.5678, favor: 2.5 }],
        invitations: [],
        queuedAugmentations: ["Neurotrainer I", "NeuroFlux Governor", "NeuroFlux Governor", "BitWire"],
      },
    });
    expect(clicks).toEqual(["Factions", "Augmentations"]);
  });

  test("nothing joined, invited or queued: nothing in the sidebar to read, so no page is opened", async () => {
    standInGame();
    expect(await read([])).toEqual({ problem: null, state: { joined: [], invitations: [], queuedAugmentations: [] } });
    expect(clicks).toEqual([]);
  });

  test("augmentations installed, none queued: the sidebar's count is 0, so the Augmentations page isn't opened", async () => {
    standInGame({ joined: [CYBERSEC], augmentationsShown: true, queueRows: [], queueCount: 0 });
    expect((await read(["CyberSec"])).state?.queuedAugmentations).toEqual([]);
    expect(clicks).toEqual(["Factions"]);
  });
});

describe("checks that fail loudly: a problem, never an empty state", () => {
  test("a joined faction the page doesn't show, or one the game doesn't have", async () => {
    standInGame({ joined: [CYBERSEC] });
    expect(await read(["CyberSec", "NiteSec"])).toEqual({
      problem: factionStatePageProblems.joinedMismatch(["CyberSec"], ["CyberSec", "NiteSec"]),
      state: null,
    });
    standInGame();
    expect((await read(["CyberSec"])).problem).toBe("the Factions page shows none joined, the game CyberSec");
  });

  test("a row without its faction in React props (a game version that renders it otherwise)", async () => {
    standInGame({ joined: [CYBERSEC], joinedRows: () => [factionRow({ name: "CyberSec" })] });
    expect(await read(["CyberSec"])).toEqual({
      problem: "a row on the Factions page (factions-joined) has no faction in its React props",
      state: null,
    });
  });

  test("the queue read shorter than the sidebar's count", async () => {
    standInGame({ joined: [CYBERSEC], queueRows: ["Neurotrainer I"], queueCount: 2 });
    expect(await read(["CyberSec"])).toEqual({
      problem: "1 queued augmentations read from the Augmentations page, but the sidebar counts 2",
      state: null,
    });
  });

  test("no count in the Augmentations item's props", async () => {
    standInGame({ joined: [CYBERSEC], queueRows: ["Neurotrainer I"], queueCount: undefined });
    expect((await read(["CyberSec"])).problem).toBe(factionStatePageProblems.noQueueCount);
  });

  test("the Character section collapsed (no Stats, no Factions): it can't tell, so it says so", async () => {
    standInGame({ joined: [CYBERSEC], statsShown: false, factionsShown: false });
    expect(await read(["CyberSec"])).toEqual({
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

test("around it, the page left as found: focused work unfocused for the read, then focused again; the state reported", async () => {
  standInGame({ joined: [CYBERSEC] });
  const game = [...document.body.children];
  // The Work page: its unfocus button; once clicked, the game's page with the sidebar, and the overview's Focus.
  const focus = element("button", { textContent: "Focus" });
  Object.assign(focus, { __reactProps$test: { onClick: () => clicks.push("Focus") } });
  const unfocus = element("button", { textContent: "Do something else simultaneously" });
  Object.assign(unfocus, {
    __reactProps$test: {
      onClick: () => {
        clicks.push("Do something else simultaneously");
        document.body.replaceChildren(...game, focus);
      },
    },
  });
  document.body.replaceChildren(unfocus);
  const state: { state: FactionState | null } = { state: null };
  await reportPageEffect(ns, Date.now() + 1_500, {
    isDone: () => state.state !== null,
    doing: "read the faction state through",
    steps: (gamePage) =>
      readFactionStateOnPage(gamePage, { gameFactions: ["CyberSec"], installedNeuroFluxLevel: 0 }, state),
    notDoneAfter: "the faction state wasn't read",
    reportAlso: () => ({ state: state.state }),
  });
  expect(clicks).toEqual(["Do something else simultaneously", "Factions", "Focus"]);
  expect(reports).toEqual([
    {
      done: true,
      problem: null,
      state: {
        joined: [{ name: "CyberSec", reputation: 1234.5678, favor: 2.5 }],
        invitations: [],
        queuedAugmentations: [],
      },
    },
  ]);
});
