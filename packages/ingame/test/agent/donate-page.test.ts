// @vitest-environment jsdom
// Donating through the page (#225): the donation's steps, on a stand-in page with React's props and fibers on its
// elements, as the game renders `Faction/ui/FactionRoot.tsx` and `DonateOption.tsx`. E2 drives the real page
// (packages/e2/test/effectors.e2.test.ts).
import { afterEach, expect, test } from "vitest";
import type { NS } from "../../src/ns.ts";
import { donateOnPage, donatePageProblems } from "../../src/page/donate-page.ts";
import { openGamePage } from "../../src/page/game-page.ts";
import { clicks, element, withProps } from "./stand-in-page.ts";

afterEach(() => {
  clicks.length = 0;
  document.body.replaceChildren();
});

const ns = { asleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)) } as unknown as NS;
/** How long the stand-in takes to render a typed amount: the button's handler reads the amount of its render. */
const RENDER_MS = 20;

/** `node` with fibers above it, nearest first, each with its props: what `reactPropsAbove` walks. */
function withFibers<T extends Element>(node: T, ...propsUpward: Record<string, unknown>[]): T {
  let fiber: unknown = null;
  for (const props of [...propsUpward].reverse()) fiber = { memoizedProps: props, memoizedState: null, return: fiber };
  return Object.assign(node, { __reactFiber$test: { memoizedProps: {}, memoizedState: null, return: fiber } });
}

/** A sidebar item, as the game renders one, recording its click and doing `then`. */
function sidebarItem(name: string, then: () => void) {
  const item = withProps(element("div"), {
    onClick: () => {
      clicks.push(name);
      then();
    },
  });
  item.setAttribute("role", "button");
  item.append(element("p", { textContent: name }));
  document.body.append(item);
}

/**
 * The game's `Faction` and money, and its page: "Details" on its row of the Factions page opens it, with its
 * `DonateOption` (`unlocked`), or the text that says what favour unlocks it.
 */
function gameWithFaction({
  name = "CyberSec",
  reputation = 5_000,
  money = 1e12,
  unlocked = true,
  withAlert = true,
}: {
  name?: string;
  reputation?: number;
  money?: number;
  unlocked?: boolean;
  withAlert?: boolean;
} = {}) {
  const faction = { name, playerReputation: reputation, favor: unlocked ? 150 : 12 };
  const game = { faction, money, donated: [] as number[] };
  const donateOption = () => {
    const paper = element("div", { className: "MuiPaper-root" });
    const props = { faction, favorToDonate: 150, disabled: !unlocked, rerender: () => {} };
    if (!unlocked) {
      paper.append(withFibers(element("p", { textContent: `Unlock donations at 150 favor with ${name}` }), props));
      return paper;
    }
    const box = element("div", { className: "MuiInputBase-root" });
    const input = withFibers(
      element("input", { placeholder: "Donation amount" }),
      {},
      props,
    ) as unknown as HTMLInputElement;
    /** The button as rendered with `amount` typed: its handler donates that (`DonateOption.tsx:31-42`). */
    const render = (amount: number) => {
      box.querySelector("button")?.remove();
      const canDonate = !Number.isNaN(amount) && amount > 0 && game.money >= amount;
      const button = withProps(element("button", { textContent: "donate", disabled: !canDonate }), {
        onClick: () => {
          clicks.push(`donate ${amount}`);
          if (!canDonate) return;
          game.money -= amount;
          faction.playerReputation += amount / 1e6;
          game.donated.push(amount);
          if (!withAlert) return;
          const dialog = element("div", { className: "MuiModal-root" });
          const alert = element("div");
          alert.append(
            withProps(element("button"), {
              onClick: () => {
                clicks.push("the alert's close");
                dialog.remove();
              },
            }),
            element("span", { textContent: `You just donated $${amount} to ${name} to gain reputation.` }),
          );
          dialog.append(alert);
          document.body.append(dialog);
        },
      });
      box.append(button);
    };
    withProps(input, {
      onChange: (event: { target: { value: string } }) => {
        const amount = Number(event.target.value);
        setTimeout(() => render(amount), RENDER_MS);
      },
    });
    render(Number.NaN);
    box.prepend(input);
    paper.append(box);
    return paper;
  };
  sidebarItem("Factions", () => {
    const joined = element("span", { className: "factions-joined" });
    const row = element("div", { className: "MuiPaper-root" });
    row.append(
      element("span", { textContent: name }),
      withProps(element("button", { textContent: "Details" }), {
        onClick: () => {
          clicks.push(`Details on ${name}`);
          joined.remove();
          const back = element("button", { textContent: "Back" });
          document.body.append(back, element("h4", { textContent: name }), donateOption());
        },
      }),
    );
    joined.append(row);
    document.body.append(joined);
  });
  return game;
}

const page = () => {
  const gamePage = openGamePage(ns, Date.now() + 1_000);
  if (gamePage === null) throw new Error("no page");
  return gamePage;
};

test("short of the reputation: the amount typed, the rendered button clicked, the alert closed, the reputation read", async () => {
  const game = gameWithFaction({ reputation: 5_000 });
  const reached = { reputation: null as number | null };
  const donation = { faction: "CyberSec", amount: 13_750_000_000, reputation: 18_750 };
  expect(await donateOnPage(page(), donation, reached)).toBeNull();
  expect(game.donated).toEqual([13_750_000_000]);
  expect(reached.reputation).toBe(18_750);
  // The button of the render with the amount, never the first render's (which would donate nothing).
  expect(clicks).toEqual(["Factions", "Details on CyberSec", "donate 13750000000", "the alert's close"]);
});

test("the reputation already there (a donation made before, its report lost): done, nothing donated", async () => {
  const game = gameWithFaction({ reputation: 18_750 });
  const reached = { reputation: null as number | null };
  expect(await donateOnPage(page(), { faction: "CyberSec", amount: 1e9, reputation: 18_750 }, reached)).toBeNull();
  expect(game.donated).toEqual([]);
  expect(reached.reputation).toBe(18_750);
  expect(clicks).toEqual(["Factions", "Details on CyberSec"]);
});

test("without the money: the button is disabled, never clicked, and that's the problem", async () => {
  const game = gameWithFaction({ money: 1e6 });
  const reached = { reputation: null as number | null };
  expect(await donateOnPage(page(), { faction: "CyberSec", amount: 1e9, reputation: 6_000 }, reached)).toBe(
    donatePageProblems.cantDonate(1e9, "CyberSec"),
  );
  expect(game.donated).toEqual([]);
  expect(reached.reputation).toBe(5_000);
  expect(clicks).toEqual(["Factions", "Details on CyberSec"]);
});

test("donations not unlocked: no input, the page's 'Unlock donations at …' says why", async () => {
  gameWithFaction({ unlocked: false });
  const reached = { reputation: null as number | null };
  expect(await donateOnPage(page(), { faction: "CyberSec", amount: 1e9, reputation: 6_000 }, reached)).toBe(
    donatePageProblems.locked("CyberSec"),
  );
  expect(reached.reputation).toBeNull();
});

test("a faction not joined: no row to open its page by", async () => {
  gameWithFaction({ name: "NiteSec" });
  const reached = { reputation: null as number | null };
  expect(await donateOnPage(page(), { faction: "CyberSec", amount: 1e9, reputation: 6_000 }, reached)).toBe(
    "no CyberSec among the factions joined (is it joined?)",
  );
});

test("with the alert turned off nothing is left to close: done all the same", async () => {
  const game = gameWithFaction({ withAlert: false });
  const reached = { reputation: null as number | null };
  expect(await donateOnPage(page(), { faction: "CyberSec", amount: 1e9, reputation: 6_000 }, reached)).toBeNull();
  expect(game.donated).toEqual([1e9]);
  expect(reached.reputation).toBe(6_000);
});
