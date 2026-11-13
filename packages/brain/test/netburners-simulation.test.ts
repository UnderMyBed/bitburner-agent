// Netburners as a source of countables (#387), in the simulator: a BN4.1 save with SF1.3 (as the campaign enters BN4)
// at hacking 80, the brain's rules all on as on Steam, the simulator's own effectors taken away (Singularity at ×1 RAM,
// the Hacknet worker the page's backend, NS calls alone).
// - Netburners' five join the planner's countables (#343's τ: the setup's money at the income, the game's check, the
//   reputation at A5's rate), the planner waits for them, the Hacknet setup goes out (core's cheapest: 6 nodes, about
//   $132k at SF1.3's multipliers), Netburners invites (the game's check, every 2 s) and A5 joins it, then works there.
// - A harness edit stands in for the work's hours (BN4's 0.75 on reputation: about 2 h for the first at hacking 80) and
//   the money: Netburners at 12,500 reputation, $400m. A6 counts the five, the planner installs, and buys them first.
// - Then the install: Hacknet and the join lost (`PlayerObjectGeneralMethods.ts:130`), and the five installed: the
//   setup isn't wanted again.
// About 15 s locally. CI runs seed 1; `NETBURNERS_SEEDS` (`1,2,3`, say) runs others.
import { augmentationsSoldBy, hackingExpOfLevel, hacknetSetupPlan, type SlowSnapshotData } from "@bitburner-agent/core";
import { expect, test } from "vitest";
import { AUGMENTATION_BOUGHT_EVENT_KIND } from "../src/augmentations.ts";
import { HACKNET_SETUP_EVENT_KIND } from "../src/hacknet.ts";
import { runReport } from "../src/run-report.ts";
import { EPOCH_MS } from "./helpers/agent-in-simulation.ts";
import { useFreshStarts, withoutSimEffectors } from "./helpers/fresh-start.ts";

/** `NETBURNERS_SEEDS`: seeds 1 or more, comma separated; unset, seed 1 alone (CI). Anything else fails loudly. */
function netburnersSeeds(text: string | undefined): number[] {
  if (text === undefined) return [1];
  const seeds = text.split(",").map((each) => each.trim());
  if (!seeds.every((each) => /^[1-9]\d*$/.test(each))) {
    throw new Error(`NETBURNERS_SEEDS is ${JSON.stringify(text)}: give seeds 1 or more, comma separated`);
  }
  return seeds.map(Number);
}

const freshStartOf = useFreshStarts();
const SEEDS = netburnersSeeds(process.env.NETBURNERS_SEEDS);
const MINUTE = 60_000;
/** SF1.3's ×1.28 on the hacking level (`SourceFile/applySourceFile.ts:14-34`): the exp for level 80. */
const SF1_3 = 1.28;
/** And its ÷1.28 on each Hacknet cost: core's plan from no node, $132,547 (×1: $169,660). */
const AT_SF1_3 = { purchaseCost: 1 / SF1_3, levelCost: 1 / SF1_3, ramCost: 1 / SF1_3, coreCost: 1 / SF1_3 };
const NETBURNERS_FIVE = augmentationsSoldBy("Netburners", 4, null).filter((name) => name !== "NeuroFlux Governor");
/** Each stage's bound: the setup and the invitation; the install with its purchases, through the gate. */
const STAGE_MS = 30 * MINUTE;

test("NETBURNERS_SEEDS: seeds 1 or more, or unset for seed 1; an empty or odd entry fails loudly", () => {
  expect(netburnersSeeds(undefined)).toEqual([1]);
  expect(netburnersSeeds("1, 4")).toEqual([1, 4]);
  for (const odd of ["", "1,", "0", "2.5", "x"]) expect(() => netburnersSeeds(odd)).toThrow(/NETBURNERS_SEEDS/);
});

test.each(SEEDS)(
  "seed %i: BN4.1 at hacking 80: the planner waits for Netburners' five, the setup bought, invited and joined, the five bought and installed",
  { timeout: 300_000 },
  async (seed) => {
    expect(NETBURNERS_FIVE).toHaveLength(5);
    const fresh = await freshStartOf({
      withDesiredState: true,
      seed,
      fixture: { kind: "bitnode", n: 4, sourceFiles: { 1: 3 } },
      beforeAgent: async (game) => {
        await game.simulation.diagnostics.gainHackingExp(hackingExpOfLevel(80.5, SF1_3));
        await withoutSimEffectors(game);
      },
    });
    const { game, simulation } = fresh;
    const slow = () => fresh.latest<SlowSnapshotData>("slow");
    const joined = () => slow()?.factions?.state?.joined.map((faction) => faction.name) ?? [];
    const events = (kind: string) =>
      fresh.data.store
        .eventsInWindow({ environment: "E1", sinceMs: EPOCH_MS, untilMs: game.clock.now() })
        .filter((event) => event.kind === kind);
    const phases = () => events(HACKNET_SETUP_EVENT_KIND).map((event) => (event.detail as { phase: string }).phase);
    await game.runUntil(() => fresh.medium() !== null, 15_000);
    const hacking = (fresh.medium()?.player.skills as { hacking: number } | undefined)?.hacking ?? 0;
    expect(hacking).toBeGreaterThanOrEqual(80);
    expect(hacking).toBeLessThan(85);

    // The setup wanted, bought, and the invitation; A5 joins Netburners, and works there for the count.
    await game.runUntil(() => joined().includes("Netburners"), STAGE_MS);
    expect(phases()).toEqual(["wanted", "bought", "invited"]);
    const [wanted] = events(HACKNET_SETUP_EVENT_KIND);
    const { cost, estimateMs } = (wanted?.detail ?? {}) as { cost: number; estimateMs: number };
    // Core's plan at SF1.3's multipliers on Hacknet's costs (1 / 1.28 each, `SourceFile/applySourceFile.ts:43-46`).
    expect(cost).toBeCloseTo(hacknetSetupPlan([], AT_SF1_3).cost, 2);
    const invited = events(HACKNET_SETUP_EVENT_KIND).find(
      (event) => (event.detail as { phase: string }).phase === "invited",
    );
    const { sinceWantedMs } = (invited?.detail ?? {}) as { sinceWantedMs: number };
    // Within the estimate and 10 minutes: no NOT INVITED.
    expect(sinceWantedMs).toBeLessThan(estimateMs + 10 * MINUTE);
    await game.runUntil(() => fresh.controller().factionsView().choice?.faction === "Netburners", STAGE_MS);
    expect(fresh.controller().factionsView().choice).toMatchObject({
      augmentation: "Hacknet Node NIC Architecture Neural-Upload",
      count: { installed: 0, required: 30 },
    });

    // The work's hours and the money: A6 counts the five, the planner installs, buying them first.
    await simulation.diagnostics.joinFactionWithReputation("Netburners", 12_500);
    await simulation.diagnostics.setMoney(400e6);
    const startedAt = slow()?.resetInfo.lastAugReset as number;
    await game.runUntil(() => (slow()?.resetInfo.lastAugReset ?? startedAt) !== startedAt, STAGE_MS);
    const bought = events(AUGMENTATION_BOUGHT_EVENT_KIND).map(
      (event) => (event.detail as { augmentation: string; faction: string }).augmentation,
    );
    for (const name of NETBURNERS_FIVE) expect(bought).toContain(name);
    const installed = Object.keys(slow()?.resetInfo.ownedAugs ?? {});
    for (const name of NETBURNERS_FIVE) expect(installed).toContain(name);
    // After the install, the five installed: the setup isn't wanted again, whatever the hacking level.
    await game.run(15 * MINUTE);
    expect(phases()).toEqual(["wanted", "bought", "invited"]);
    expect(fresh.controller().hacknetView().waitingFor).toBe("nothing: Netburners' augmentations installed or queued");

    // The run report: the setup's phases, the intent done through the page's worker, the join; it passes.
    const { text, failures } = runReport(
      fresh.data.store,
      { environment: "E1", sinceMs: EPOCH_MS, untilMs: game.clock.now() },
      { verbose: true },
    );
    expect(text).toContain("    Netburners' Hacknet setup (#387: its invitation's totals, the cheapest way):\n");
    expect(text).toMatch(/ {6}\S+ {2}the setup wanted \(\$1\d{2},\d{3}\), the invitation estimated in /);
    expect(text).toMatch(/ {6}\S+ {2}the setup bought, /);
    expect(text).toMatch(/ {6}\S+ {2}Netburners invited, .* after the setup was wanted \(estimate /);
    expect(text).toMatch(/ {4}buyHacknetSetup\(\): done after 1 try \(ui\)/);
    expect(text).toMatch(/ {4}joinFaction\(Netburners\): done after 1 try \(singularity\)/);
    expect(text).toContain("  Netburners not invited (its Hacknet setup's estimate and 10 min, #387):\n    none\n");
    expect(failures).toEqual([]);
    console.log(
      `seed ${seed}: the setup $${Math.round(cost).toLocaleString("en-US")}, invited ${Math.round(
        sinceWantedMs / 1000,
      )} s after it was wanted (estimate ${Math.round(estimateMs / 1000)} s); installed ${installed.length}`,
    );
  },
);
