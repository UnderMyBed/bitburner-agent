// Bladeburner B4 (#383): the brain's cities and chaos for an hour from a harness join, in BN6.1 with the campaign's
// Source-Files (SF1.3, SF2.3, SF4.3 and SF5.1, docs/synthesis.md §3), its rules as on Steam (all on), the simulator's
// own effectors taken away so the Agent uses its workers as in a browser. One seed: a thin slice, no sweep. Bounded by
// virtual time, under a minute of CI. Harness edits stand in for B1's half hour and the chaos a run would raise, as B2's
// suite does (bn6-actions-simulation.test.ts): the four combat stats to 100, the division joined by the owner's own
// script, home at 128 GB, CyberSec joined; then:
// - **Sector-12's chaos at 80** before the Agent starts: the division's first city (`Bladeburner.ts:116`). The rule
//   moves to another city by its forecast, the chaos where it works under 50 within a reading or two of the cities.
// - **Every city's chaos at 52,** ten minutes on: no city to move to, so Diplomacy by its own measure (#390's review,
//   B4's intent): each run the rule sends with the measure paying (its gain at least its 60 s forgone), none once it no
//   longer pays, and the chaos under 50 within section 8's own bound (twice the rule's Diplomacy estimate and 10 min)
//   and the decay from where the measure stopped. In this run (#386) Diplomacy was sent at chaos 52.000, 51.472, 50.951
//   and 50.435, the last taking it to 49.924, under 50 after 4.3 min. On main the last run stopped at 50.115, and the
//   decay took it under 50: #386's choice plays the hour differently (Raid at the floor, under the faction's 25), so
//   the runs' phase against 50 differs; where the last paying run lands is the path's, not the rule's.
// The whole report passing, its chaos check among it.
import { BLADEBURNER_CITIES, diplomaciesTo50, type MediumSnapshotData, skillExpFor } from "@bitburner-agent/core";
import { expect, test } from "vitest";
import { BLADEBURNER_ACTIONS_HOLD } from "../src/bladeburner.ts";
import { BLADEBURNER_CHAOS_SLACK_MS } from "../src/bladeburner-cities-report.ts";
import { runReport } from "../src/run-report.ts";
import { EPOCH_MS } from "./helpers/agent-in-simulation.ts";
import { ownerRunsOnHome, useFreshStarts, withoutSimEffectors } from "./helpers/fresh-start.ts";

const freshStartOf = useFreshStarts();
const SOURCE_FILES = { 1: 3, 2: 3, 4: 3, 5: 1 };
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

test("BN6.1, an hour from a harness join: Sector-12's chaos at 80, moved; every city at 52, Diplomacy, then under 50; the report passes", async () => {
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
      await game.simulation.diagnostics.setBladeburnerFigures({ city: "Sector-12", chaos: 80 });
      await withoutSimEffectors(game);
    },
  });
  const reading = () => (fresh.medium() as MediumSnapshotData | null)?.bladeburner;
  const chaosOf = (city: string | null | undefined) =>
    reading()?.cities?.find((each) => each.name === city)?.chaos ?? Number.NaN;
  const startedAtMs = fresh.game.clock.now();
  // The first reading with the cities: Sector-12 at 80.
  await fresh.game.runUntil(() => reading()?.cities != null, 2 * MINUTE);
  expect(reading()?.city).toBe("Sector-12");
  expect(chaosOf("Sector-12")).toBeGreaterThan(79.9);
  const seenAtMs = fresh.game.clock.now();
  console.log(fresh.controller().bladeburnerView().line);
  // Moved: the next reading shows another city, its chaos under 50.
  await fresh.game.runUntil(() => reading()?.city !== "Sector-12", MINUTE);
  const movedAfterMs = fresh.game.clock.now() - seenAtMs;
  const movedTo = reading()?.city;
  console.log(
    `moved to ${movedTo} ${movedAfterMs / 1000} s after the cities were read; its chaos ${chaosOf(movedTo)}, ` +
      `Sector-12's ${chaosOf("Sector-12")}`,
  );
  expect(movedAfterMs).toBeLessThanOrEqual(20_000);
  expect(chaosOf(movedTo)).toBeLessThan(50);
  expect(chaosOf("Sector-12")).toBeGreaterThan(79.9);
  expect(fresh.controller().factionsView()).toMatchObject({ sent: false, waitingFor: BLADEBURNER_ACTIONS_HOLD });

  // Every city at 52, ten minutes on.
  await fresh.game.run(10 * MINUTE - (fresh.game.clock.now() - startedAtMs));
  for (const city of BLADEBURNER_CITIES) await fresh.simulation.diagnostics.setBladeburnerFigures({ city, chaos: 52 });
  const raisedAtMs = fresh.game.clock.now();
  const attempts = diplomaciesTo50(52, 1);
  const boundMs = 2 * attempts * 60_000 + BLADEBURNER_CHAOS_SLACK_MS;
  let diplomacySeen = false;
  // The first reading with the 52s.
  await fresh.game.runUntil(() => chaosOf(reading()?.city) > 51.9, 2 * MINUTE);
  // Diplomacy by its own measure (#390's review: B4's intent, not one path's figures): each decision of the rule's that
  // sends Diplomacy (not a run kept to its end) with the measure paying, its gain at least its 60 s forgone; none once
  // the measure no longer pays; then the chaos under 50 within section 8's bound, and the decay from where it stopped.
  const sends: { chaos: number; gain: number; cost: number }[] = [];
  let stopped: { chaos: number; atMs: number } | null = null;
  let sentAfterStop = 0;
  let startedAfterStop = 0;
  let lastView: unknown = null;
  let wasUnderWay = false;
  await fresh.game.runUntil(() => {
    const view = fresh.controller().bladeburnerView();
    const underWay = reading()?.current?.name === "Diplomacy";
    if (underWay) diplomacySeen = true;
    if (underWay && !wasUnderWay && stopped !== null) startedAfterStop += 1;
    wasUnderWay = underWay;
    if (view !== lastView) {
      lastView = view;
      const actions = view.actions;
      const diplomacy = actions?.cities?.diplomacy ?? null;
      const sent = actions?.order.name === "Diplomacy" && actions.kept == null;
      if (sent && diplomacy !== null) {
        sends.push({ chaos: diplomacy.chaos, gain: diplomacy.gain, cost: diplomacy.cost });
        if (stopped !== null) sentAfterStop += 1;
      }
      if (diplomacySeen && stopped === null && diplomacy?.pays !== true) {
        stopped = { chaos: chaosOf(reading()?.city), atMs: fresh.game.clock.now() };
      }
    }
    return stopped !== null && chaosOf(reading()?.city) < 50;
  }, HOUR / 2);
  const worked = reading()?.city;
  const underAfterMs = fresh.game.clock.now() - raisedAtMs;
  const stop = stopped as { chaos: number; atMs: number } | null;
  console.log(fresh.controller().bladeburnerView().line);
  console.log(
    `every city at 52: Diplomacy seen ${diplomacySeen}; sent at chaos ${sends.map((each) => each.chaos.toFixed(3)).join(", ")}; ` +
      `the measure stopped paying at ${stop?.chaos.toFixed(3)} after ${(((stop?.atMs ?? 0) - raisedAtMs) / MINUTE).toFixed(1)} ` +
      `min; under 50 after ${(underAfterMs / MINUTE).toFixed(1)} min (the rule's estimate to 50 ${attempts} × 60 s, the ` +
      `report's bound ${boundMs / MINUTE} min); the others: ` +
      BLADEBURNER_CITIES.map((city) => `${city} ${chaosOf(city).toFixed(2)}`).join(", "),
  );
  expect(diplomacySeen).toBe(true);
  expect(sends.length).toBeGreaterThan(0);
  for (const each of sends)
    expect(each.gain, `Diplomacy sent at chaos ${each.chaos}`).toBeGreaterThanOrEqual(each.cost);
  expect(stop).not.toBeNull();
  expect(sentAfterStop).toBe(0);
  expect(startedAfterStop).toBe(0);
  // Under 50 within the report's bound, and the decay (0.0001 a second) from the chaos where the measure stopped.
  const decayMs = (Math.max(0, (stop?.chaos ?? 0) - 50) / 0.0001) * 1000;
  expect(chaosOf(worked)).toBeLessThan(50);
  expect(underAfterMs).toBeLessThanOrEqual(boundMs + decayMs);
  // Then the hour, the division where the chaos is under 50.
  await fresh.game.run(HOUR - (fresh.game.clock.now() - startedAtMs));
  expect(chaosOf(reading()?.city)).toBeLessThan(50);

  const window = { environment: "E1", sinceMs: EPOCH_MS, untilMs: fresh.game.clock.now() } as const;
  const { text, failures } = runReport(fresh.data.store, window, { verbose: true });
  const section = text.slice(text.indexOf("8. Bladeburner"), text.indexOf("Verdict"));
  console.log(section);
  expect(section).toContain("  the cities and the chaos (#383): ");
  expect(section).toMatch(/\n {4}Diplomacy under way \d+ (min|s)[^,]*, Incite Violence /);
  expect(section).not.toContain("    Diplomacy under way 0 s,");
  expect(section).toContain(
    "  the chaos over 50 where the division works, the rule's measure wanting it off, past twice its Diplomacy " +
      "estimate and 10 min, or a move's 22 s:\n    none",
  );
  expect(failures).toEqual([]);
}, 240_000);
