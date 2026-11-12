// Bladeburner B2 (#375): the brain's actions for an hour from a harness join, in BN6.1 with the campaign's Source-Files
// (SF1.3, SF2.3, SF4.3 and SF5.1, docs/synthesis.md §3), its rules as on Steam (all on), the simulator's own effectors
// taken away so the Agent uses its workers as in a browser. One seed: a thin slice, no sweep. Bounded by virtual time,
// under a minute of CI. Harness edits stand in for B1's half hour (bn6-start-simulation.test.ts):
// - the four combat stats to 100 (5,417 experience each at SF1.3's ×1.28), and the division joined by the owner's own
//   script (`joinBladeburnerDivision`, as B1's worker does);
// - home at 128 GB, B1's hours of home RAM purchases: the reading worker's 42.6 GB beyond the 65.9 GB home keeps.
// Then: the plan's work and rest by the worker, A5's faction work held for them; the stamina under ½ max rested back to
// the max; no stop at stamina 0; the rank within the bound of the forecast of the actions run (section 8's own check);
// and the whole report passing.
import { type MediumSnapshotData, skillExpFor } from "@bitburner-agent/core";
import { expect, test } from "vitest";
import { runReport } from "../src/run-report.ts";
import { EPOCH_MS } from "./helpers/agent-in-simulation.ts";
import { ownerRunsOnHome, useFreshStarts, withoutSimEffectors } from "./helpers/fresh-start.ts";

const freshStartOf = useFreshStarts();
const SOURCE_FILES = { 1: 3, 2: 3, 4: 3, 5: 1 };
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

test("BN6.1, an hour from a harness join: work and rest by stamina, no stop at 0, the rank within its bound; the report passes", async () => {
  const fresh = await freshStartOf({
    withDesiredState: true,
    fixture: { kind: "bitnode", n: 6, sourceFiles: SOURCE_FILES },
    beforeAgent: async (game) => {
      await game.simulation.diagnostics.setHomeRam(128);
      await game.simulation.diagnostics.gainCombatExp(skillExpFor(100, 1.28) + 1);
      await ownerRunsOnHome(
        game,
        "export async function main(ns) { if (!ns.bladeburner.joinBladeburnerDivision()) throw new Error('no join'); }",
      );
      await withoutSimEffectors(game);
    },
  });
  const medium = () => fresh.medium() as MediumSnapshotData | null;
  // The first action sent, once the reading has B2's figures.
  await fresh.game.runUntil(() => fresh.controller().bladeburnerView().actions != null, 2 * MINUTE);
  const startedAtMs = fresh.game.clock.now();
  const first = fresh.controller().bladeburnerView();
  console.log(first.line);
  expect(first.actions?.order).toMatchObject({ type: "Contracts" });
  // No brain's work, which would stop the action (A5's is held for it, bladeburner-actions.test.ts).
  expect(fresh.controller().workView().desired).toBeNull();
  // The hour: the action under way each minute, and the stamina's lowest.
  const seen = new Set<string>();
  let lowest = 1;
  let rested = false;
  for (let minute = 0; minute < 60; minute++) {
    await fresh.game.run(MINUTE);
    const reading = medium()?.bladeburner;
    if (reading?.current) seen.add(reading.current.name);
    if (reading?.stamina !== undefined && reading.maxStamina !== undefined) {
      lowest = Math.min(lowest, reading.stamina / reading.maxStamina);
    }
    if (fresh.controller().bladeburnerView().actions?.resting) rested = true;
    expect(fresh.controller().workView().desired, `the brain's work at minute ${minute}`).toBeNull();
  }
  console.log(fresh.controller().bladeburnerView().line);
  console.log(`under way: ${[...seen].join(", ")}; the stamina's lowest ${(100 * lowest).toFixed(0)}% of the max`);
  // Worked to under ½ max, then rested: both a contract or operation and a rest seen.
  expect(rested).toBe(true);
  expect(lowest).toBeLessThan(0.5);
  expect(lowest).toBeGreaterThan(0.4);
  expect(
    [...seen].some((name) => ["Field Analysis", "Hyperbolic Regeneration Chamber", "Training"].includes(name)),
  ).toBe(true);

  const window = { environment: "E1", sinceMs: EPOCH_MS, untilMs: fresh.game.clock.now() } as const;
  const { text, failures } = runReport(fresh.data.store, window, { verbose: true });
  const section = text.slice(text.indexOf("8. Bladeburner"), text.indexOf("Verdict"));
  console.log(section);
  console.log(`virtual: ${((fresh.game.clock.now() - startedAtMs) / MINUTE).toFixed(1)} min of actions`);
  expect(fresh.game.clock.now() - startedAtMs).toBeGreaterThanOrEqual(HOUR);
  const measured =
    /rank from the actions run: (-?[\d.]+) measured against (-?[\d.]+) forecast \(σ ([\d.]+)\), its bound (-?[\d.]+)/.exec(
      section,
    );
  expect(measured).not.toBeNull();
  const [rank, forecast, sigma, bound] = (measured ?? []).slice(1).map(Number) as [number, number, number, number];
  console.log(`rank ${rank} against the forecast ${forecast} (σ ${sigma}), its bound ${bound}`);
  expect(forecast).toBeGreaterThan(0);
  expect(rank).toBeGreaterThanOrEqual(bound);
  expect(section).toContain("  an action stopped at stamina 0 at any reading:\n    none\n");
  expect(section).toContain("  the rank from the actions run below its forecast's bound:\n    none");
  expect(failures).toEqual([]);
}, 240_000);
