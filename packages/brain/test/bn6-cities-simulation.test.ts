// Bladeburner B4 (#383): the brain's cities and chaos for an hour from a harness join, in BN6.1 with the campaign's
// Source-Files (SF1.3, SF2.3, SF4.3 and SF5.1, docs/synthesis.md §3), its rules as on Steam (all on), the simulator's
// own effectors taken away so the Agent uses its workers as in a browser. One seed: a thin slice, no sweep. Bounded by
// virtual time, under a minute of CI. Harness edits stand in for B1's half hour and the chaos a run would raise, as B2's
// suite does (bn6-actions-simulation.test.ts): the four combat stats to 100, the division joined by the owner's own
// script, home at 128 GB, CyberSec joined; then:
// - **Sector-12's chaos at 80** before the Agent starts: the division's first city (`Bladeburner.ts:116`). The rule
//   moves to another city by its forecast, the chaos where it works under 50 within a reading or two of the cities.
// - **Every city's chaos at 52,** ten minutes on: no city to move to, so Diplomacy by its own measure (#390's review,
//   B4's intent): each run the rule sends with the measure paying; for three minutes past its stop, none on the
//   stopped measure (each run then started by a new decision's paying measure, over 50); and the chaos under 50 within
//   section 8's own bound (twice the rule's Diplomacy estimate and 10 min) and the decay from where it stopped. In this
//   run (#386) Diplomacy was sent at chaos 52.000, 51.472, 50.951 and 50.435, the last taking it to 49.924, under 50
//   after 4.3 min: the measure never stopped above 50 on this path. Raid's own chaos (+1–5% an attempt,
//   `Bladeburner.ts:846`) then took it to 51.9, and Diplomacy paid again (51.913, 51.387). On main the last run stopped
//   at 50.115, and the decay took it under 50: #386's choice plays the hour differently (Raid at the floor, under the
//   faction's 25), so the runs' phase against 50 differs; where the last paying run lands is the path's, not the rule's.
// - **B4's break-even** (#390's review; #415's ruling): every city then at 50.2, Diplomacy weighed and taken exactly
//   where its own gain beats its cost. At the low end it didn't pay there (gain 0.107 against its 60 s's 0.200); since
//   #415, at the true population's chances, it pays (0.257 against 0.200 at 50.184). Then the break-even solved from
//   the rule's own figures at the reading (core's `chooseBladeburnerCity`'s gain = cost, bisected), and every city
//   set halfway between 50 and it: weighed and not paying. A run only on a decision's paying measure (the measure
//   follows each reading's stamina and figures).
// The whole report passing, its chaos check among it.
import {
  BLADEBURNER_CHAOS_ACTION_SECONDS,
  BLADEBURNER_CITIES,
  BLADEBURNER_CONSTANTS,
  type BladeburnerActionInput,
  chaosActionForgone,
  chaosAfterDiplomacy,
  chaosRankLoss,
  chooseBladeburnerAction,
  cityCompetenceRatio,
  diplomaciesTo50,
  type MediumSnapshotData,
  skillExpFor,
} from "@bitburner-agent/core";
import { expect, test } from "vitest";
import { BLADEBURNER_ACTIONS_HOLD, type BladeburnerView } from "../src/bladeburner.ts";
import { BLADEBURNER_CHAOS_SLACK_MS } from "../src/bladeburner-cities-report.ts";
import { runReport } from "../src/run-report.ts";
import { EPOCH_MS } from "./helpers/agent-in-simulation.ts";
import { ownerRunsOnHome, useFreshStarts, withoutSimEffectors } from "./helpers/fresh-start.ts";
import { expectGrownHindcast, grownHindcastIn } from "./helpers/grown-hindcast.ts";

const freshStartOf = useFreshStarts();

/** A city's figures as the reading has them: its population estimate, communities and chaos. */
type CityFigures = { name: string; population: number; communities: number; chaos: number };

/**
 * Diplomacy's gain less its cost at `chaos` in the city `there` (#415's ruling, #417's review), as core's
 * `chooseBladeburnerCity` weighs it: the forecast at each chaos x the rule's input (the reading priced, #415) scaled by
 * `cityCompetenceRatio` from the city read, `here`, the gain `chaosRankLoss` from one Diplomacy's fall against the
 * rate at 50, the cost its 60 s of that rate's cycle (`chaosActionForgone`).
 */
function diplomacyMarginOf(
  input: Omit<BladeburnerActionInput, "target" | "city">,
  here: CityFigures,
  there: CityFigures,
  chaos: number,
): number {
  const rate = (at: number) =>
    chooseBladeburnerAction({
      ...input,
      city: {
        ratio: cityCompetenceRatio(here, { population: there.population, chaos: at }) ?? 0,
        raid: there.communities > 0,
      },
    });
  const atFifty = rate(BLADEBURNER_CONSTANTS.chaosThreshold);
  const after = chaosAfterDiplomacy(chaos, input.person.skills.charisma);
  const gain = chaosRankLoss((at) => rate(at).rankPerSecond, atFifty.rankPerSecond, after, chaos);
  return gain - BLADEBURNER_CHAOS_ACTION_SECONDS * chaosActionForgone(atFifty);
}
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
  // #408's hindcast's start: the reading in the city moved to.
  const movedAtMs = fresh.game.clock.now();
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
  // The first reading with the 52s.
  await fresh.game.runUntil(() => chaosOf(reading()?.city) > 51.9, 2 * MINUTE);
  // Diplomacy by its own measure (#390's review: B4's intent, not one path's figures). Each decision of the rule's that
  // sends Diplomacy (not a run kept to its end), with its measure there; each run seen starting; and each decision that
  // weighs it (the chaos over 50) without paying.
  const sends: { atMs: number; chaos: number; gain: number; cost: number; pays: boolean }[] = [];
  const starts: number[] = [];
  const unpaid: { atMs: number; chaos: number; gain: number; cost: number }[] = [];
  // Every decision weighing it (#415's ruling): its figures, whether it sent a run (not one kept), and its reading.
  const weighed: {
    atMs: number;
    chaos: number;
    gain: number;
    cost: number;
    pays: boolean;
    sent: boolean;
    kept: boolean;
    /** The decision's own input and the city it read (the view's), for core's margin there. */
    input: Omit<BladeburnerActionInput, "target" | "city">;
    here: CityFigures;
    there: CityFigures;
  }[] = [];
  let lastView: unknown = null;
  let wasUnderWay = false;
  // The decision's own figures (#417's review): its input (the reading priced, the rule's) and the city read. The store's
  // latest medium can be a reading ahead of the view at a tick, so the view's own are taken.
  const decisionOf = (actions: NonNullable<BladeburnerView["actions"]>) => {
    const { target: _target, city, ...input } = actions.input as BladeburnerActionInput;
    const byCity = actions.cities?.byCity ?? [];
    const there = byCity.find((each) => each.name === actions.cities?.city);
    // The city read: the one whose ratio to the city chosen is the input's (1 where they're one).
    const here = byCity.find((each) => there !== undefined && cityCompetenceRatio(each, there) === (city?.ratio ?? 1));
    if (here === undefined || there === undefined) throw new Error("no city read or chosen");
    return { input, here, there };
  };
  const observe = () => {
    const underWay = reading()?.current?.name === "Diplomacy";
    if (underWay && !wasUnderWay) starts.push(fresh.game.clock.now());
    wasUnderWay = underWay;
    const view = fresh.controller().bladeburnerView();
    if (view === lastView) return;
    lastView = view;
    const actions = view.actions;
    const diplomacy = actions?.cities?.diplomacy ?? null;
    if (diplomacy === null) return;
    const figures = {
      atMs: fresh.game.clock.now(),
      chaos: diplomacy.chaos,
      gain: diplomacy.gain,
      cost: diplomacy.cost,
    };
    if (actions?.order.name === "Diplomacy" && actions.kept == null) sends.push({ ...figures, pays: diplomacy.pays });
    if (!diplomacy.pays) unpaid.push(figures);
    weighed.push({
      ...figures,
      pays: diplomacy.pays,
      sent: actions?.order.name === "Diplomacy" && actions.kept == null,
      kept: actions?.kept != null,
      ...decisionOf(actions as NonNullable<BladeburnerView["actions"]>),
    });
  };
  /**
   * The decisions weighing Diplomacy from `fromMs`, each taken exactly where its gain beats its cost, and its figures
   * core's at its own input (`diplomacyMarginOf`, #417's review); said. (Its `pays` is gain > cost by construction, so
   * it's not asserted: what is, is the order sent.)
   */
  const judged = (label: string, fromMs: number) => {
    const these = weighed.filter((each) => each.atMs > fromMs);
    console.log(
      `${label}: Diplomacy weighed ${these.length} times: ` +
        (these
          .map(
            (each) =>
              `${each.chaos.toFixed(3)} gain ${each.gain.toFixed(3)} against cost ${each.cost.toFixed(3)}, ` +
              `${each.kept ? "a run kept" : each.sent ? "sent" : "not sent"} (core's margin there ${diplomacyMarginOf(each.input, each.here, each.there, each.chaos).toFixed(3)})`,
          )
          .join("; ") || "none"),
    );
    for (const each of these) {
      expect(diplomacyMarginOf(each.input, each.here, each.there, each.chaos), `${label} at ${each.chaos}`).toBeCloseTo(
        each.gain - each.cost,
        9,
      );
      if (!each.kept) expect(each.sent, `${label} at ${each.chaos}`).toBe(each.gain > each.cost);
    }
    return these;
  };
  // The measure's stop: the first decision, after a Diplomacy, that no longer sends one (it no longer pays, or the
  // chaos is at 50 or under and it isn't weighed).
  let stopped: { chaos: number; atMs: number } | null = null;
  await fresh.game.runUntil(() => {
    observe();
    const actions = fresh.controller().bladeburnerView().actions;
    if (stopped === null && starts.length > 0 && actions?.cities?.diplomacy?.pays !== true) {
      stopped = { chaos: chaosOf(reading()?.city), atMs: fresh.game.clock.now() };
    }
    return stopped !== null && chaosOf(reading()?.city) < 50;
  }, HOUR / 2);
  const worked = reading()?.city;
  const chaosWhenUnder = chaosOf(worked);
  const underAfterMs = fresh.game.clock.now() - raisedAtMs;
  const stop = stopped as { chaos: number; atMs: number } | null;
  // On past the stop, three minutes: no Diplomacy sent or started.
  const pastStopMs = fresh.game.clock.now() + 3 * MINUTE;
  await fresh.game.runUntil(() => {
    observe();
    return fresh.game.clock.now() >= pastStopMs;
  }, 4 * MINUTE);
  console.log(fresh.controller().bladeburnerView().line);
  console.log(
    `every city at 52: Diplomacy sent at chaos ${sends.map((each) => `${each.chaos.toFixed(3)} (gain ${each.gain.toFixed(2)}, cost ${each.cost.toFixed(2)})`).join(", ")}; ` +
      `the measure stopped at ${stop?.chaos.toFixed(3)} after ${(((stop?.atMs ?? 0) - raisedAtMs) / MINUTE).toFixed(1)} ` +
      `min; under 50 after ${(underAfterMs / MINUTE).toFixed(1)} min (the rule's estimate to 50 ${attempts} × 60 s, the ` +
      `report's bound ${boundMs / MINUTE} min); the others: ` +
      BLADEBURNER_CITIES.map((city) => `${city} ${chaosOf(city).toFixed(2)}`).join(", "),
  );
  expect(starts.length).toBeGreaterThan(0);
  expect(sends.length).toBeGreaterThan(0);
  // The order follows the measure (the brain's wiring of core's `chaosAction`).
  for (const each of sends) expect(each.pays, `Diplomacy sent at chaos ${each.chaos}`).toBe(true);
  expect(stop).not.toBeNull();
  const stopAtMs = stop?.atMs ?? Number.POSITIVE_INFINITY;
  // Past it, none on the stopped measure: a run starts only after a decision sends it, its measure paying above 50.
  // Raid's own chaos (+1–5% an attempt, `Bladeburner.ts:846`) can take the chaos back over 50, and the measure pays
  // again: a new decision, not the stopped one's.
  const sentAfter = (fromMs: number, toMs = Number.POSITIVE_INFINITY) =>
    sends.filter((each) => each.atMs > fromMs && each.atMs <= toMs);
  for (const each of sentAfter(stopAtMs)) expect(each.chaos).toBeGreaterThan(50);
  for (const atMs of starts.filter((each) => each > stopAtMs)) {
    expect(sentAfter(stopAtMs, atMs).length, `a Diplomacy started at ${atMs}`).toBeGreaterThan(0);
  }
  // Under 50 within the report's bound, and the decay (0.0001 a second) from the chaos where the measure stopped. On
  // this path it never stopped above 50: the last paying run took it under.
  const decayMs = (Math.max(0, (stop?.chaos ?? 0) - 50) / 0.0001) * 1000;
  expect(chaosWhenUnder).toBeLessThan(50);
  expect(underAfterMs).toBeLessThanOrEqual(boundMs + decayMs);

  // B4's break-even (#390's review; #415's ruling): every city at 50.2, where one more Diplomacy (to 49.70) costs its
  // 60 s against the chaos it takes off (0.2 over 50). Weighed, and taken exactly where its own gain beats its cost.
  const setEvery = async (chaos: number) => {
    for (const city of BLADEBURNER_CITIES) await fresh.simulation.diagnostics.setBladeburnerFigures({ city, chaos });
  };
  const watch = async (fromMs: number) =>
    fresh.game.runUntil(() => {
      observe();
      return fresh.game.clock.now() >= fromMs + 3 * MINUTE;
    }, 4 * MINUTE);
  await setEvery(50.2);
  const nearAtMs = fresh.game.clock.now();
  await watch(nearAtMs);
  const near = judged("every city at 50.2", nearAtMs);
  expect(near.length).toBeGreaterThan(0);
  expect(near[0]?.chaos).toBeGreaterThan(50.1);
  expect(near[0]?.chaos).toBeLessThan(50.21);
  // A run only on a decision's paying measure: its cost is the forecast's 60 s at that reading's stamina and figures.
  for (const atMs of starts.filter((each) => each > nearAtMs)) {
    expect(sentAfter(nearAtMs, atMs).length, `a Diplomacy started at ${atMs}`).toBeGreaterThan(0);
  }
  // Then the hour, the division where the chaos is under 50.
  await fresh.game.run(HOUR - (fresh.game.clock.now() - startedAtMs));
  expect(chaosOf(reading()?.city)).toBeLessThan(50);
  // #408's hindcast: the grown estimate's time to the rank the hour reached, from the reading in the city moved to.
  const hindcast = await grownHindcastIn(
    fresh,
    "B4's hour, its chaos edited",
    { fromMs: movedAtMs, untilMs: fresh.game.clock.now() },
    reading()?.rank ?? 0,
  );
  console.log(hindcast.line);
  // Within ×2 since #415 (the table's).
  expectGrownHindcast(hindcast);

  // The break-even bracketed, after the hour (#415's ruling, #417's review: its chaos left over 50 by the measure,
  // Raid's own chaos then moves it): at the reading now, gain = cost solved by bisection over (50, 52] (the margin rises
  // with the chaos: the more over 50, the more one Diplomacy's fall saves), and every city set 10% of the way past it
  // (be + 0.1(be − 50)): sent; then, solved again at the reading then, 10% short of it: not sent. Each judged at the
  // first decision at the chaos set (the decay only lowers it; one on an earlier reading can show the chaos before).
  const breakEvenNow = () => {
    // The rule's last decision's own input and cities (its view's), as each judged decision's.
    const now = decisionOf(fresh.controller().bladeburnerView().actions as NonNullable<BladeburnerView["actions"]>);
    const diplomacyMargin = (_: unknown, chaos: number) => diplomacyMarginOf(now.input, now.here, now.there, chaos);
    let low: number = BLADEBURNER_CONSTANTS.chaosThreshold;
    let high = 52;
    expect(diplomacyMargin(now, high)).toBeGreaterThan(0);
    for (let step = 0; step < 40; step++) {
      const middle = (low + high) / 2;
      if (diplomacyMargin(now, middle) > 0) high = middle;
      else low = middle;
    }
    return high;
  };
  const bracket = async (share: number) => {
    // A decision at the chaos set, not a run kept to its end: with no Diplomacy under way, set; where the first decision
    // at it keeps a run (sent on a reading from before the set, the chaos Raid had raised), the run is let end and the
    // chaos set again from the break-even then (at most 3 times).
    let chaos = Number.NaN;
    let atMs = Number.NaN;
    for (let tries = 0; tries < 3; tries++) {
      await fresh.game.runUntil(() => {
        observe();
        return reading()?.current?.name !== "Diplomacy";
      }, 2 * MINUTE);
      const breakEven = breakEvenNow();
      chaos = BLADEBURNER_CONSTANTS.chaosThreshold + share * (breakEven - BLADEBURNER_CONSTANTS.chaosThreshold);
      console.log(
        `the break-even at the reading: chaos ${breakEven.toFixed(4)}; every city set to ${chaos.toFixed(4)}`,
      );
      await setEvery(chaos);
      atMs = fresh.game.clock.now();
      // The first decision weighing it at the chaos set: one not keeping a run is the bracket's.
      const at = (each: (typeof weighed)[number]) => each.atMs > atMs && each.chaos <= chaos;
      await fresh.game.runUntil(() => {
        observe();
        return weighed.some(at);
      }, 2 * MINUTE);
      if (weighed.find(at)?.kept === false) break;
    }
    await watch(atMs);
    const decided = judged(`every city at ${chaos.toFixed(4)}`, atMs).filter(
      (each) => each.chaos <= chaos && !each.kept,
    );
    expect(decided.length, `at ${chaos}`).toBeGreaterThan(0);
    for (const startedAt of starts.filter((each) => each > atMs)) {
      expect(sentAfter(atMs, startedAt).length, `a Diplomacy started at ${startedAt}`).toBeGreaterThan(0);
    }
    return decided[0] as (typeof decided)[number];
  };
  expect((await bracket(1.1)).sent).toBe(true);
  expect((await bracket(0.9)).sent).toBe(false);

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
