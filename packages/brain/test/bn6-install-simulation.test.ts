// Bladeburner B7 (#404): an install mid-route, in BN6.1 with the campaign's Source-Files (SF1.3, SF2.3, SF4.3 and
// SF5.1, docs/synthesis.md §3), its rules as on Steam (all on), the simulator's own effectors taken away so the Agent
// uses its workers as in a browser. One seed: a thin slice, no sweep. Bounded by virtual time, under a minute of CI.
// Harness edits stand in for the route so far: home at 128 GB, CyberSec joined, the four combat stats at 100 (SF1.3's
// ×1.28), the division joined by the owner's own script, the rank at 1,000 through the game's own change (its 333
// points), Blade's Intuition at 10 bought by the owner's script, Tracking's max level 5, and EsperTech Bladeburner
// Eyewear queued (the Bladeburners faction's, ×1.03 on the success chance and ×1.05 on dexterity). Then the brain's own:
// the planner installs it (the route's estimate at combat 100 is millions of hours, its rebuild about an hour), through
// the gate; the install keeps the rank, the skills, the max levels and the Black Ops done
// (`Bladeburner.ts:259-263`), and the player's multipliers are the old ones times core's gain; the Bladeburner rule is
// back within one reading of the first after it, Training the combat stats back to 100, 15 minutes of it with no stall
// and no stuck resting; the run report passes, its rebuild shown.
import {
  BLADEBURNER_READING_SECONDS,
  BLADEBURNER_TRAINING,
  bladeburnerInstallGain,
  type MediumSnapshotData,
  type SlowSnapshotData,
  skillExpFor,
} from "@bitburner-agent/core";
import { expect, test } from "vitest";
import { AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND, BLACK_OPS_ROUTE } from "../src/augmentations.ts";
import { runReport } from "../src/run-report.ts";
import { EPOCH_MS } from "./helpers/agent-in-simulation.ts";
import { ownerRunsOnHome, useFreshStarts, withoutSimEffectors } from "./helpers/fresh-start.ts";

const freshStartOf = useFreshStarts();
const SOURCE_FILES = { 1: 3, 2: 3, 4: 3, 5: 1 };
const MINUTE = 60_000;
const READING_MS = BLADEBURNER_READING_SECONDS * 1000;
const ESPERTECH = "EsperTech Bladeburner Eyewear";

interface Reading {
  rank: number;
  skillLevels?: Record<string, number>;
  actions?: { name: string; maxLevel: number }[];
  blackOp?: { name: string } | null;
  current?: { type: string; name: string } | null;
}
type Mults = Record<string, number>;

test("BN6.1 mid-route: the planner installs EsperTech; the rank, skills and levels kept; Training within a reading; the report passes", async () => {
  const fresh = await freshStartOf({
    withDesiredState: true,
    fixture: { kind: "bitnode", n: 6, sourceFiles: SOURCE_FILES },
    beforeAgent: async (game) => {
      await game.simulation.diagnostics.setHomeRam(128);
      await game.simulation.diagnostics.joinFactionWithReputation("CyberSec", 0);
      await game.simulation.diagnostics.gainCombatExp(skillExpFor(100, 1.28) + 1);
      await ownerRunsOnHome(
        game,
        "export async function main(ns) { if (!ns.bladeburner.joinBladeburnerDivision()) throw new Error('no join'); }",
      );
      await game.simulation.diagnostics.setBladeburnerRank(1000);
      await ownerRunsOnHome(
        game,
        `export async function main(ns) { if (!ns.bladeburner.upgradeSkill("Blade's Intuition", 10)) throw new Error("no skill"); }`,
      );
      await game.simulation.diagnostics.setBladeburnerFigures({ maxLevels: { Tracking: 5 } });
      await game.simulation.diagnostics.queueAugmentation(ESPERTECH);
      await withoutSimEffectors(game);
    },
  });
  const { game } = fresh;
  const controller = fresh.controller();
  const medium = () => fresh.medium() as MediumSnapshotData | null;
  const reading = () => (medium() as { bladeburner?: Reading } | null)?.bladeburner;
  const slow = () => fresh.latest<SlowSnapshotData>("slow");
  await game.runUntil(() => reading()?.blackOp !== undefined && slow() !== null, 2 * MINUTE);
  const resetBefore = slow()?.resetInfo.lastAugReset as number;
  const before = reading() as Reading;
  const multsBefore = (medium() as MediumSnapshotData).player.mults as unknown as Mults;
  expect(before.skillLevels?.["Blade's Intuition"]).toBe(10);
  const startedAtMs = game.clock.now();
  const note = (what: string) => console.log(`${((game.clock.now() - startedAtMs) / MINUTE).toFixed(1)} min: ${what}`);
  note(controller.bladeburnerView().line);

  // The planner's choice and the install, through the gate: until the game resets.
  let last: Reading = before;
  await game.runUntil(() => {
    const now = slow()?.resetInfo.lastAugReset;
    const read = reading();
    if (now === resetBefore && read != null && Array.isArray(read.actions)) last = read;
    return now !== undefined && now !== resetBefore;
  }, 10 * MINUTE);
  expect(slow()?.resetInfo.lastAugReset).not.toBe(resetBefore);
  expect(Object.keys(slow()?.resetInfo.ownedAugs ?? {})).toContain(ESPERTECH);
  note(`installed: ${JSON.stringify(slow()?.resetInfo.ownedAugs)}`);
  const window = { environment: "E1", sinceMs: EPOCH_MS, untilMs: game.clock.now() } as const;
  const chosen = fresh.data.store
    .eventsInWindow(window)
    .filter((event) => event.kind === AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND)
    .map((event) => event.detail as { reason: string; timing?: { route?: string; words?: string } });
  expect(chosen).toEqual([
    expect.objectContaining({
      reason: "the Black Ops' route",
      timing: expect.objectContaining({ route: BLACK_OPS_ROUTE }),
    }),
  ]);
  note(`the planner: ${chosen[0]?.timing?.words}`);

  // The first reading after it: the rank, the skills, the levels and the Black Ops done kept; the stats at 1.
  await game.runUntil(() => {
    const read = reading();
    const strength = (medium()?.player as { skills?: { strength?: number } } | undefined)?.skills?.strength;
    return read != null && Array.isArray(read.actions) && strength !== undefined && strength < 100;
  }, 3 * MINUTE);
  const after = reading() as Reading;
  const afterAtMs = game.clock.now();
  note(`after: rank ${after.rank.toFixed(1)} (${last.rank.toFixed(1)} at the last reading before)`);
  // Training and Field Analysis's rank aside, the rank is as it was (no action ran between, the install stopped it).
  expect(Math.abs(after.rank - last.rank)).toBeLessThan(5);
  expect(after.skillLevels).toEqual(last.skillLevels);
  expect(after.blackOp?.name).toBe(last.blackOp?.name);
  expect(after.actions?.find((action) => action.name === "Tracking")?.maxLevel).toBe(5);
  // The engine's multipliers after it: the old ones times core's gain (`applyAugmentation`, by product).
  const gain = bladeburnerInstallGain(0, [ESPERTECH]);
  const multsAfter = (medium() as MediumSnapshotData).player.mults as unknown as Mults;
  expect(multsAfter.bladeburner_success_chance).toBeCloseTo(
    (multsBefore.bladeburner_success_chance as number) * gain.successChance,
    12,
  );
  expect(multsAfter.dexterity).toBeCloseTo((multsBefore.dexterity as number) * gain.levels.dexterity, 12);
  expect(multsAfter.strength).toBeCloseTo(multsBefore.strength as number, 12);

  // The rule back within one reading: Training, the rebuild's targets the levels before.
  await game.run(READING_MS);
  const view = controller.bladeburnerView();
  note(view.line);
  expect(view.actions?.order).toEqual({ type: "General", name: BLADEBURNER_TRAINING, level: null });
  expect(view.rebuild?.targets).toEqual({ strength: 100, defense: 100, dexterity: 100, agility: 100 });
  // The worker set it: the game's action under way.
  await game.run(READING_MS);
  expect(reading()?.current).toEqual({ type: "General", name: BLADEBURNER_TRAINING });
  expect(game.clock.now() - afterAtMs).toBeLessThanOrEqual(3 * READING_MS);

  // 15 minutes of it, past B2's stuck-resting bound (twice the time to the max stamina, and 10 min): the stats rising,
  // Training still the order, the route's stalls waiting for it.
  await game.run(15 * MINUTE);
  const strength = ((medium() as MediumSnapshotData).player.skills as { strength: number }).strength;
  note(`after 15 min of it: ${controller.bladeburnerView().line.slice(0, 220)}`);
  expect(strength).toBeGreaterThan(1);
  expect(strength).toBeLessThan(100);
  expect(controller.bladeburnerView().actions?.order.name).toBe(BLADEBURNER_TRAINING);
  expect(controller.worldDaemonView().stall).toBeNull();

  // The run report passes, its rebuild shown.
  const report = runReport(fresh.data.store, { environment: "E1", sinceMs: EPOCH_MS, untilMs: game.clock.now() });
  const lines = report.text.split("\n");
  const at = lines.findIndex((line) => line.includes("the rebuilds after an install (#404)"));
  console.log(lines.slice(at, at + 2).join("\n"));
  expect(lines[at + 1]).toMatch(
    /^ {4}from .* to strength 100, defense 100, dexterity 100, agility 100: estimated .*; under way at the window's end$/,
  );
  expect(report.failures).toEqual([]);
});
