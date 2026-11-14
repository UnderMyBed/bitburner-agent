// Bladeburner B3 (#379): the brain's skills for an hour from a harness join, in BN6.1 with the campaign's Source-Files
// (SF1.3, SF2.3, SF4.3 and SF5.1, docs/synthesis.md §3), its rules as on Steam (all on), the simulator's own effectors
// taken away so the Agent uses its workers as in a browser. One seed: a thin slice, no sweep. Bounded by virtual time,
// under a minute of CI. Harness edits stand in for B1's half hour and B2's hours of rank, as B2's suite does
// (bn6-actions-simulation.test.ts): the four combat stats to 100, the division joined by the owner's own script, home
// at 128 GB, CyberSec joined; and the rank set to `RANK` through the game's own change, which gives its points (one for
// each 3, `Bladeburner.ts:1284-1293`).
// Then: the points spent by the reading after the one that shows them, through the `upgradeBladeburnerSkill` intents'
// worker; the rule's forecast with the skills over B2's without them, and the forecast of the actions run over what
// B2's forecast without the skills gives the same game time; the rank measured within its bound of that forecast
// (section 8's own check); the whole report passing.
import {
  BLADEBURNER_CONTRACTS,
  BLADEBURNER_READING_SECONDS,
  type MediumSnapshotData,
  skillExpFor,
} from "@bitburner-agent/core";
import { expect, test } from "vitest";
import { BLADEBURNER_RANK_ALPHA, bernsteinMargin } from "../src/bladeburner-actions-report.ts";
import { runReport } from "../src/run-report.ts";
import { EPOCH_MS } from "./helpers/agent-in-simulation.ts";
import { ownerRunsOnHome, useFreshStarts, withoutSimEffectors } from "./helpers/fresh-start.ts";
import { expectGrownHindcast, grownHindcast } from "./helpers/grown-hindcast.ts";

const freshStartOf = useFreshStarts();
const SOURCE_FILES = { 1: 3, 2: 3, 4: 3, 5: 1 };
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** The rank set: 50 points. */
const RANK = 150;

test("BN6.1, an hour from a harness join at rank 150: the points spent within a reading, the forecast over B2's; the report passes", async () => {
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
      await game.simulation.diagnostics.setBladeburnerRank(RANK);
      await withoutSimEffectors(game);
    },
  });
  const reading = () => (fresh.medium() as MediumSnapshotData | null)?.bladeburner;
  const levelsBought = () => Object.values(reading()?.skillLevels ?? {}).reduce((sum, level) => sum + level, 0);
  // The first reading with the points: the rule's plan there.
  await fresh.game.runUntil(() => reading()?.skillPoints !== undefined, 2 * MINUTE);
  const shownAtMs = fresh.game.clock.now();
  // #408's hindcast's start: the reading with the points, unspent.
  const startMedium = fresh.medium() as MediumSnapshotData | null;
  expect(reading()?.skillPoints).toBe(RANK / 3);
  expect(levelsBought()).toBe(0);
  const plan = fresh.controller().bladeburnerView().skills;
  if (plan == null) throw new Error("no skills' plan");
  console.log(fresh.controller().bladeburnerView().line);
  expect(plan.buys.length).toBeGreaterThan(0);
  expect(plan.spent).toBeGreaterThan(RANK / 3 - 5);
  // Spent by the next reading.
  await fresh.game.runUntil(() => levelsBought() > 0, 2 * BLADEBURNER_READING_SECONDS * 1000);
  const spentAfterMs = fresh.game.clock.now() - shownAtMs;
  console.log(`the points shown, then spent ${spentAfterMs / 1000} s on: ${JSON.stringify(reading()?.skillLevels)}`);
  expect(spentAfterMs).toBeLessThanOrEqual(BLADEBURNER_READING_SECONDS * 1000 + 2_000);
  for (const buy of plan.buys) expect(reading()?.skillLevels?.[buy.skill], buy.skill).toBe(buy.to);
  expect(reading()?.skillPoints).toBe(RANK / 3 - plan.spent);
  const startedAtMs = fresh.game.clock.now();
  await fresh.game.run(HOUR);
  // #408's hindcast: the grown estimate's time to the rank the hour reached, from the reading with the points.
  const hindcast = grownHindcast(
    "B3's hour at rank 150",
    startMedium,
    fresh.game.clock.now() - shownAtMs,
    reading()?.rank ?? 0,
  );
  console.log(hindcast.line);
  expectGrownHindcast(hindcast);

  const window = { environment: "E1", sinceMs: EPOCH_MS, untilMs: fresh.game.clock.now() } as const;
  const { text, failures } = runReport(fresh.data.store, window, { verbose: true });
  const section = text.slice(text.indexOf("8. Bladeburner"), text.indexOf("Verdict"));
  console.log(section);
  console.log(`virtual: ${((fresh.game.clock.now() - startedAtMs) / MINUTE).toFixed(1)} min since the purchase`);
  const forecasts =
    /the rule's forecast there: ([\d.]+) rank\/min with the levels read \([^)]*\); ([\d.]+) rank\/min with none \(B2's\)/.exec(
      section,
    );
  const measured =
    /rank from the actions run: (-?[\d.]+) measured against (-?[\d.]+) forecast \(σ ([\d.]+)\), its bound (-?[\d.]+)/.exec(
      section,
    );
  expect(forecasts).not.toBeNull();
  expect(measured).not.toBeNull();
  const [withSkills, without] = (forecasts ?? []).slice(1).map(Number) as [number, number];
  const [rank, forecast, sigma, bound] = (measured ?? []).slice(1).map(Number) as [number, number, number, number];
  // The game time the actions ran over, as the report counts it (gap-report.ts's `formatDuration`).
  const duration = /over (?:(\d+) h )?(?:(\d+) min)? ?(?:(\d+) s)? of game time/.exec(section);
  expect(duration).not.toBeNull();
  const [hours, minutes, seconds] = (duration ?? []).slice(1).map((each) => Number(each ?? 0)) as number[];
  const gameMinutes = 60 * (hours ?? 0) + (minutes ?? 0) + (seconds ?? 0) / 60;
  const b2 = without * gameMinutes;
  console.log(
    `forecast over a cycle: ${withSkills} rank/min with the skills, ${without} without (B2's); rank ${rank} against ` +
      `${forecast} forecast of the actions run (σ ${sigma}), its bound ${bound}; B2's forecast over ${gameMinutes} min: ` +
      `${b2.toFixed(2)}`,
  );
  expect(withSkills).toBeGreaterThan(without);
  // The rank rate up on B2's forecast without the skills, by the forecast of the actions the skills let it run (the
  // game's estimate at the levels bought). The rank measured is judged against its bound only: once the skills lift
  // Raid's chance the rule works it (55 rank a success, its σ over the hour about 30), so an hour's rank can't show
  // the rise apart from luck.
  expect(forecast).toBeGreaterThan(b2);
  expect(rank).toBeGreaterThanOrEqual(bound);
  // The low-variance part judged on its own (#381's review): Field Analysis and the contracts, their rank against their
  // forecast's Bernstein bound at the same α, from section 8's lines by action. Raid's luck (0 of 5 at its 5.5% low end
  // is chance 0.75) is left to the whole's bound.
  const byAction = [
    ...section.matchAll(
      /\n {6}([^:\n]+): about \d+ attempts, \d+ successes; (-?[\d.]+) measured against (-?[\d.]+) forecast \(σ ([\d.]+), at most ([\d.]+) under an attempt's mean, cuts ([\d.]+)\)/g,
    ),
  ].map((match) => ({ name: match[1] as string, figures: match.slice(2).map(Number) as number[] }));
  const steady = byAction.filter((each) =>
    ["Field Analysis", ...BLADEBURNER_CONTRACTS.map((contract) => contract.name)].includes(each.name),
  );
  expect(steady.map((each) => each.name)).toContain("Field Analysis");
  const sum = (index: number) => steady.reduce((total, each) => total + (each.figures[index] ?? 0), 0);
  const steadyVariance = steady.reduce((total, each) => total + (each.figures[2] ?? 0) ** 2, 0);
  const steadyBelow = Math.max(...steady.map((each) => each.figures[3] ?? 0));
  const steadyBound = sum(1) - bernsteinMargin(steadyVariance, steadyBelow, BLADEBURNER_RANK_ALPHA) - sum(4);
  console.log(
    `Field Analysis and the contracts (${steady.map((each) => each.name).join(", ")}): ${sum(0).toFixed(2)} measured ` +
      `against ${sum(1).toFixed(2)} forecast (σ ${Math.sqrt(steadyVariance).toFixed(2)}), their bound ${steadyBound.toFixed(2)}`,
  );
  expect(steadyBound).toBeGreaterThan(0);
  expect(sum(0)).toBeGreaterThanOrEqual(steadyBound);
  expect(section).toContain("  skill points unspent with a level to buy, past 52 s:\n    none");
  expect(failures).toEqual([]);
}, 240_000);
