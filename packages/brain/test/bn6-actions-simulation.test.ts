// Bladeburner B2 (#375): the brain's actions for an hour from a harness join, in BN6.1 with the campaign's Source-Files
// (SF1.3, SF2.3, SF4.3 and SF5.1, docs/synthesis.md §3), its rules as on Steam (all on), the simulator's own effectors
// taken away so the Agent uses its workers as in a browser. One seed: a thin slice, no sweep. Bounded by virtual time,
// under a minute of CI. Harness edits stand in for B1's half hour (bn6-start-simulation.test.ts):
// - the four combat stats to 100 (5,417 experience each at SF1.3's ×1.28), and the division joined by the owner's own
//   script (`joinBladeburnerDivision`, as B1's worker does);
// - home at 128 GB, B1's hours of home RAM purchases: the reading worker's 50.6 GB beyond the 65.9 GB home keeps;
// - CyberSec joined (#377's review), so A5 has faction work to hold for the actions.
// Then: the plan's work and rest by the worker, A5's faction work held for them; home's batches leaving the worker's
// RAM (#377's review); the stamina under ½ max rested back to the max; no stop at stamina 0; and (#386) under the
// current-rank target all 60 minutes (the faction's 25, then Typhoon's 2,500), each minute's plan the least expected
// time to it of every plan the rule weighs (core's
// `bladeburnerPlansToTarget`, none ruled out). That runs the same chain on the same plans, so it guards the pruning and
// the brain's inputs, not the chain: the independent evidence is core's simulated walks
// (packages/core/test/bladeburner-targets.test.ts). The steady part (Field Analysis and the contracts) on the expected
// measure given the attempts made, over 0 (#415's ruling: since #415 the rule works Raid at its true chance most of the
// hour, so a Bernstein bound on the steady part's one realised draw can't bite; it's printed, not asserted); the
// whole's within its bound; the report.
// The hour isn't asked to reach 25 (#386's amendment): at rank 0 a failure loses nothing, so the least expected time
// can be Raid's lottery, whose hour can end anywhere.
import {
  actionHpLoss,
  BLADEBURNER_CONTRACTS,
  type BladeburnerActionPlan,
  bladeburnerLevelledAction,
  bladeburnerPlansToTarget,
  type MediumSnapshotData,
  skillExpFor,
} from "@bitburner-agent/core";
import { expect, test } from "vitest";
import { BLADEBURNER_ACTIONS_HOLD } from "../src/bladeburner.ts";
import { BLADEBURNER_RANK_ALPHA, bernsteinMargin } from "../src/bladeburner-actions-report.ts";
import { runReport } from "../src/run-report.ts";
import { EPOCH_MS } from "./helpers/agent-in-simulation.ts";
import { expectCitiesAsPredicted } from "./helpers/drift-prediction.ts";
import { ownerRunsOnHome, useFreshStarts, withoutSimEffectors } from "./helpers/fresh-start.ts";
import { attemptsIn, expectGrownHindcast, grownHindcastIn, steadyExpected } from "./helpers/grown-hindcast.ts";

const freshStartOf = useFreshStarts();
const SOURCE_FILES = { 1: 3, 2: 3, 4: 3, 5: 1 };
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** "Raid level 1 with Hyperbolic Regeneration Chamber": a plan's work and rest. */
const planName = (plan: BladeburnerActionPlan) =>
  `${plan.work === null ? "resting alone" : `${plan.work.name} level ${plan.work.level}`} with ${plan.rest.name}`;

test("BN6.1, an hour from a harness join: each plan the least time to its target, the steady part's expectation over 0; the report passes", async () => {
  const fresh = await freshStartOf({
    withDesiredState: true,
    fixture: { kind: "bitnode", n: 6, sourceFiles: SOURCE_FILES },
    // The Agent at `FIXED_AGENT_START_MS`, the seeded draws from its first connection (#341's second item, as #369
    // pinned cloud-servers-income): a bundle added (#387's Hacknet worker) no longer moves Raid's lottery.
    fixedAgentStart: true,
    beforeAgent: async (game) => {
      await game.simulation.diagnostics.setHomeRam(128);
      await game.simulation.diagnostics.joinFactionWithReputation("CyberSec", 0);
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
  // #418: the six cities' true figures at the hour's start, and the charisma Diplomacy cuts the chaos by.
  const startCities = await fresh.simulation.diagnostics.bladeburnerCities();
  const charisma = (medium()?.player as { skills?: { charisma?: number } } | undefined)?.skills?.charisma ?? 1;
  const first = fresh.controller().bladeburnerView();
  console.log(first.line);
  // No brain's work, which would stop the action: A5's, with a faction to work for, held for it.
  expect(fresh.controller().workView().desired).toBeNull();
  const factions = fresh.controller().factionsView();
  expect(factions.choice).not.toBeNull();
  expect(factions).toMatchObject({ sent: false, waitingFor: BLADEBURNER_ACTIONS_HOLD });
  // The hour: the action under way each minute, the stamina's lowest, and each minute's plan against every plan.
  const seen = new Set<string>();
  const chosen = new Map<string, number>();
  let lowest = 1;
  let rested = false;
  let underTarget = 0;
  const batcherRuns = new Set<string>();
  let lastReading = "";
  for (let minute = 0; minute < 60; minute++) {
    await fresh.game.run(MINUTE);
    const reading = medium()?.bladeburner;
    if (reading?.current) seen.add(reading.current.name);
    if (reading?.stamina !== undefined && reading.maxStamina !== undefined) {
      lowest = Math.min(lowest, reading.stamina / reading.maxStamina);
    }
    const sent = fresh.controller().bladeburnerView().actions;
    if (sent?.resting) rested = true;
    // Under the target (#386): the plan sent is the first of every plan by its time to the target, each solved.
    if (sent?.input !== undefined && sent.plan.toTarget !== undefined) {
      underTarget += 1;
      const every = bladeburnerPlansToTarget(sent.input);
      expect(every.length, `the plans at minute ${minute}`).toBeGreaterThan(1);
      expect(sent.plan, `the plan at minute ${minute}`).toEqual(every[0]);
      const name = planName(sent.plan);
      chosen.set(name, (chosen.get(name) ?? 0) + 1);
    }
    expect(fresh.controller().workView().desired, `the brain's work at minute ${minute}`).toBeNull();
    // Beside home's batches (#377's review): the worker reads afresh each minute (its counts grow every second).
    const batch = fresh.controller().batcherView().sent;
    if (batch !== null) batcherRuns.add(`${batch.runOn}, ${batch.hosts} hosts`);
    const now = JSON.stringify(reading);
    expect(now, `the reading at minute ${minute}`).not.toBe(lastReading);
    lastReading = now;
  }
  console.log(`the batcher: ${[...batcherRuns].join("; ") || "not sent"}`);
  // #408's hindcast: the grown estimate's time to the rank the hour reached, from its first reading.
  const hindcast = await grownHindcastIn(
    fresh,
    "B2's hour from a harness join",
    { fromMs: startedAtMs, untilMs: fresh.game.clock.now() },
    medium()?.bladeburner?.rank ?? 0,
  );
  console.log(hindcast.line);
  expectGrownHindcast(hindcast);
  // #418: each city's chaos and true population after the hour against the drift's prediction (core's mean path from
  // the simulator's true figures at the hour's start, each attempt the rule made at its own chance, the decay and the
  // events' mean between; within 4 standard deviations of the draws' spread), and the attempts' own effects alone.
  const hourAttempts = await attemptsIn(fresh.simulation, startedAtMs, fresh.game.clock.now());
  const endCities = await fresh.simulation.diagnostics.bladeburnerCities();
  console.log(
    `the cities after the hour against the drift's prediction (#418):
` + expectCitiesAsPredicted(startCities, endCities, hourAttempts, startedAtMs, fresh.game.clock.now(), charisma),
  );
  console.log(fresh.controller().bladeburnerView().line);
  console.log(`under way: ${[...seen].join(", ")}; the stamina's lowest ${(100 * lowest).toFixed(0)}% of the max`);
  console.log(
    `under the target at ${underTarget} of 60 minutes, each the least time of every plan; chosen: ` +
      [...chosen].map(([name, minutes]) => `${name} ${minutes}`).join(", "),
  );
  // Under a current-rank target the whole hour (#390's review): the check ran at every minute.
  expect(underTarget).toBe(60);
  // Worked to under ½ max, then rested.
  expect(rested).toBe(true);
  expect(lowest).toBeLessThan(0.5);
  expect(lowest).toBeGreaterThan(0.4);

  const window = { environment: "E1", sinceMs: EPOCH_MS, untilMs: fresh.game.clock.now() } as const;
  const { text, failures } = runReport(fresh.data.store, window, { verbose: true });
  const section = text.slice(text.indexOf("8. Bladeburner"), text.indexOf("Verdict"));
  console.log(section);
  console.log(`virtual: ${((fresh.game.clock.now() - startedAtMs) / MINUTE).toFixed(1)} min of actions`);
  expect(fresh.game.clock.now() - startedAtMs).toBeGreaterThanOrEqual(HOUR);
  // The hospital (#417's review): each Raid failure (its damage about 386 against 21 HP) a visit at once, refilled
  // before any reading, so the money is the game's own. Against the simulator's Raid failures over the same span: each
  // bill min(10% of the money then, the damage × $100k) (`Hospital/Hospital.ts:4-17`), so at least the least money's
  // 10% or 90% of the mean damage's, and at most the most money's 10% a failure of any action.
  const hospital =
    /the hospital \([^)]*\): \$([\d,]+) by the game's money sources from (\S+) to (\S+); at least (\d+) visits/.exec(
      section,
    );
  expect(hospital, "the hospital's money").not.toBeNull();
  const [money, fromIso, toIso, visits] = (hospital ?? []).slice(1) as [string, string, string, string];
  const spent = Number(money.replaceAll(",", ""));
  const span = await attemptsIn(fresh.simulation, Date.parse(fromIso), Date.parse(toIso));
  const failed = span.filter((each) => !each.success);
  const raids = failed.filter((each) => each.name === "Raid");
  const monies = fresh.data.store
    .snapshots({ environment: "E1" })
    .filter((each) => each.tier === "medium" && each.receivedAtMs >= Date.parse(fromIso) - 10_000)
    .filter((each) => each.receivedAtMs <= Date.parse(toIso))
    .map((each) => (each.data as MediumSnapshotData).player?.money)
    .filter((each): each is number => typeof each === "number");
  const raid = bladeburnerLevelledAction("Operations", "Raid");
  if (raid === null) throw new Error("no Raid");
  const leastBill = Math.min(0.1 * Math.min(...monies), 0.9 * actionHpLoss(raid, 1) * 100e3);
  console.log(
    `the hospital: $${spent.toLocaleString("en-US")} from ${fromIso} to ${toIso}, at least ${visits} visits by the ` +
      `report; the simulator's failures there: ${raids.length} Raid, ${failed.length} in all; the money ` +
      `$${Math.round(Math.min(...monies)).toLocaleString("en-US")} to $${Math.round(Math.max(...monies)).toLocaleString("en-US")}`,
  );
  expect(raids.length).toBeGreaterThan(0);
  expect(spent).toBeGreaterThanOrEqual(raids.length * leastBill);
  expect(spent).toBeLessThanOrEqual(failed.length * 0.1 * Math.max(...monies));
  expect(Number(visits)).toBeGreaterThan(0);
  const measured =
    /rank from the actions run: (-?[\d.]+) measured against (-?[\d.]+) forecast \(σ ([\d.]+)\), its bound (-?[\d.]+)/.exec(
      section,
    );
  expect(measured).not.toBeNull();
  const [rank, forecast, sigma, bound] = (measured ?? []).slice(1).map(Number) as [number, number, number, number];
  console.log(`rank ${rank} against the forecast ${forecast} (σ ${sigma}), its bound ${bound}`);
  expect(rank).toBeGreaterThanOrEqual(bound);
  // The steady part on its own (#386, as #381's review): Field Analysis and the contracts, from section 8's lines by
  // action, their rank and their forecast's Bernstein bound at the same α (printed).
  const byAction = [
    ...section.matchAll(
      /\n {6}([^:\n]+): about \d+ attempts, \d+ successes; (-?[\d.]+) measured against (-?[\d.]+) forecast \(σ ([\d.]+), at most ([\d.]+) under an attempt's mean, cuts ([\d.]+)\)/g,
    ),
  ].map((match) => ({ name: match[1] as string, figures: match.slice(2).map(Number) as number[] }));
  const steady = byAction.filter((each) =>
    ["Field Analysis", ...BLADEBURNER_CONTRACTS.map((contract) => contract.name)].includes(each.name),
  );
  expect(steady.length).toBeGreaterThan(0);
  const sum = (index: number) => steady.reduce((total, each) => total + (each.figures[index] ?? 0), 0);
  const steadyVariance = steady.reduce((total, each) => total + (each.figures[2] ?? 0) ** 2, 0);
  const steadyBelow = Math.max(...steady.map((each) => each.figures[3] ?? 0));
  const steadyBound = sum(1) - bernsteinMargin(steadyVariance, steadyBelow, BLADEBURNER_RANK_ALPHA) - sum(4);
  console.log(
    `Field Analysis and the contracts (${steady.map((each) => each.name).join(", ")}): ${sum(0).toFixed(2)} measured ` +
      `against ${sum(1).toFixed(2)} forecast (σ ${Math.sqrt(steadyVariance).toFixed(2)}), their bound ` +
      `${steadyBound.toFixed(2)} at α ${BLADEBURNER_RANK_ALPHA}`,
  );
  // #415's ruling: the steady part asserted on the expected measure given the attempts made (`steadyExpected`), over 0;
  // the realised and its Bernstein bound printed beside it, not asserted.
  const steadyMeasure = await steadyExpected(
    fresh.simulation,
    steady.find((each) => each.name === "Field Analysis")?.figures[0] ?? 0,
  );
  console.log(
    `the steady part, expected given the actions: ${steadyMeasure.expected.toFixed(2)} (${steadyMeasure.attempts} ` +
      `contract attempts; ${steadyMeasure.realised.toFixed(2)} realised)`,
  );
  expect(steadyMeasure.expected).toBeGreaterThan(0);
  expect(section).toContain("  an action stopped at stamina 0 at any reading:\n    none\n");
  expect(section).toContain("  the rank from the actions run below its forecast's bound:\n    none");
  expect(failures).toEqual([]);
  // #418's ruling 5: 1.5 × the worst CI time seen, 72 s (PR #419's run 43679925021).
}, 108_000);
