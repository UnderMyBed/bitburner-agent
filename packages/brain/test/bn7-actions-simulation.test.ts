// Bladeburner B8 (#411): B2's hour of actions (bn6-actions-simulation.test.ts, #375) in BN7.1, so BN7's multipliers run
// end to end: each rank gained ×0.6 (`BladeburnerRank`, `BitNode/BitNode.tsx:756`; `Bladeburner/Formulas.ts:13`,
// `:22`), the skill points' costs ×2 (`:757`). The campaign's Source-Files (SF1.3, SF2.3, SF4.3 and SF5.1,
// docs/synthesis.md §3), its rules as on Steam (all on), the simulator's own effectors taken away. One seed: a thin
// slice, no sweep. Bounded by virtual time, under a minute of CI. BN6's harness edits: the four combat stats to 100, the
// division joined by the owner's own script, home at 128 GB, CyberSec joined. Then as BN6's: the plan's work and rest
// by the worker, A5's faction work held for them; the stamina under ½ max rested back to the max; under the faction's
// 25 all 60 minutes, each minute's plan the least expected time to it of every plan the rule weighs, from an input at
// BN7's `BladeburnerRank`; the rank from the actions within its forecast's bound (the forecast at 0.6: one at BN6's 1
// would overforecast by 1/0.6); the steady part's within its own; #408's hindcast at BN7's multipliers; the report.
import {
  BLADEBURNER_CONTRACTS,
  type BladeburnerActionPlan,
  bladeburnerPlansToTarget,
  type MediumSnapshotData,
  skillExpFor,
} from "@bitburner-agent/core";
import { expect, test } from "vitest";
import { BLADEBURNER_ACTIONS_HOLD } from "../src/bladeburner.ts";
import { BLADEBURNER_RANK_ALPHA, bernsteinMargin } from "../src/bladeburner-actions-report.ts";
import { runReport } from "../src/run-report.ts";
import { EPOCH_MS } from "./helpers/agent-in-simulation.ts";
import { ownerRunsOnHome, useFreshStarts, withoutSimEffectors } from "./helpers/fresh-start.ts";
import { attemptsIn, expectGrownHindcast, grownHindcast } from "./helpers/grown-hindcast.ts";

const freshStartOf = useFreshStarts();
const SOURCE_FILES = { 1: 3, 2: 3, 4: 3, 5: 1 };
/** BN7's `BladeburnerRank` (`BitNode/BitNode.tsx:756`). */
const RANK_MULTIPLIER = 0.6;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** "Raid level 1 with Hyperbolic Regeneration Chamber": a plan's work and rest. */
const planName = (plan: BladeburnerActionPlan) =>
  `${plan.work === null ? "resting alone" : `${plan.work.name} level ${plan.work.level}`} with ${plan.rest.name}`;

test("BN7.1, an hour from a harness join at BN7's multipliers: each plan the least time to 25, within its bound; the report passes", async () => {
  const fresh = await freshStartOf({
    withDesiredState: true,
    fixture: { kind: "bitnode", n: 7, sourceFiles: SOURCE_FILES },
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
  const first = fresh.controller().bladeburnerView();
  // #408's hindcast's start: the reading the hour begins at.
  const startMedium = medium();
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
      expect(sent.input.rankMultiplier, `the input's BladeburnerRank at minute ${minute}`).toBe(RANK_MULTIPLIER);
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
  const hindcast = grownHindcast(
    "B2's hour from a harness join, BN7",
    startMedium,
    fresh.game.clock.now() - startedAtMs,
    medium()?.bladeburner?.rank ?? 0,
    await attemptsIn(fresh.simulation, startedAtMs, fresh.game.clock.now()),
    7,
  );
  console.log(hindcast.line);
  expectGrownHindcast(hindcast);
  console.log(fresh.controller().bladeburnerView().line);
  console.log(`under way: ${[...seen].join(", ")}; the stamina's lowest ${(100 * lowest).toFixed(0)}% of the max`);
  console.log(
    `under the target at ${underTarget} of 60 minutes, each the least time of every plan; chosen: ` +
      [...chosen].map(([name, minutes]) => `${name} ${minutes}`).join(", "),
  );
  // Under the faction's 25 the whole hour (#390's review): the check ran at every minute.
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
  const measured =
    /rank from the actions run: (-?[\d.]+) measured against (-?[\d.]+) forecast \(σ ([\d.]+)\), its bound (-?[\d.]+)/.exec(
      section,
    );
  expect(measured).not.toBeNull();
  const [rank, forecast, sigma, bound] = (measured ?? []).slice(1).map(Number) as [number, number, number, number];
  console.log(`rank ${rank} against the forecast ${forecast} (σ ${sigma}), its bound ${bound}`);
  expect(rank).toBeGreaterThanOrEqual(bound);
  // The steady part on its own (#386, as #381's review): Field Analysis and the contracts, their rank against their
  // forecast's Bernstein bound at the same α, from section 8's lines by action.
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
  expect(sum(0)).toBeGreaterThanOrEqual(steadyBound);
  expect(section).toContain("  an action stopped at stamina 0 at any reading:\n    none\n");
  expect(section).toContain("  the rank from the actions run below its forecast's bound:\n    none");
  expect(failures).toEqual([]);
}, 240_000);
