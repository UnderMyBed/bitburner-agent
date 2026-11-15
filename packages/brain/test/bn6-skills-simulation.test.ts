// Bladeburner B3 (#379): the brain's skills for an hour from a harness join, in BN6.1 with the campaign's Source-Files
// (SF1.3, SF2.3, SF4.3 and SF5.1, docs/synthesis.md §3), its rules as on Steam (all on), the simulator's own effectors
// taken away so the Agent uses its workers as in a browser. One seed: a thin slice, no sweep. Bounded by virtual time,
// under a minute of CI. Harness edits stand in for B1's half hour and B2's hours of rank, as B2's suite does
// (bn6-actions-simulation.test.ts): the four combat stats to 100, the division joined by the owner's own script, home
// at 128 GB, CyberSec joined; and the rank set to `RANK` through the game's own change, which gives its points (one for
// each 3, `Bladeburner.ts:1284-1293`).
// Then: the points spent by the reading after the one that shows them, through the `upgradeBladeburnerSkill` intents'
// worker; the rule's forecast with the skills over B2's without them (both under the target and the drift); the
// forecast of the actions run against every attempt's expected rank given the attempts made, within its error (#418's
// ruling 2: rank a second over the hour printed beside it, labelled, not a bar); the rank measured within its bound of
// that forecast (section 8's own check); the whole report passing.
import {
  BLADEBURNER_CONTRACTS,
  BLADEBURNER_LEVELLED_ACTIONS,
  BLADEBURNER_READING_SECONDS,
  bladeburnerPersonOf,
  bladeburnerPlansToTarget,
  bladeburnerRankMultiplierOf,
  bladeburnerReplaySeedOf,
  chooseBladeburnerCity,
  type MediumSnapshotData,
  skillExpFor,
} from "@bitburner-agent/core";
import { expect, test } from "vitest";
import {
  bladeburnerMeasuredCitiesOf,
  bladeburnerRuleInputOf,
  bladeburnerSnapshotOf,
  bladeburnerUnderWayOf,
} from "../src/bladeburner.ts";
import { BLADEBURNER_RANK_ALPHA, bernsteinMargin } from "../src/bladeburner-actions-report.ts";
import { runReport } from "../src/run-report.ts";
import { EPOCH_MS } from "./helpers/agent-in-simulation.ts";
import { expectCitiesAsPredicted } from "./helpers/drift-prediction.ts";
import { ownerRunsOnHome, useFreshStarts, withoutSimEffectors } from "./helpers/fresh-start.ts";
import { attemptsIn, attemptsSummary, expectGrownHindcast, grownHindcastIn } from "./helpers/grown-hindcast.ts";

const freshStartOf = useFreshStarts();
/** What the levels' check reads of a reading's actions (#425's review, row 4). */
type BladeburnerActionReadingLike = { name: string; level: number };
/** Core's label on the attempt under way's time left after a mid-attempt level change (`underWay`): 4.5% at most. */
const UNDER_WAY_LEVEL_BOUND = 0.045;
const SOURCE_FILES = { 1: 3, 2: 3, 4: 3, 5: 1 };
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** The rank set: 50 points. */
const RANK = 150;

test("BN6.1, an hour from a harness join at rank 150: the points spent within a reading, the forecast as the attempts made; the report passes", async () => {
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
  expect(reading()?.skillPoints).toBe(RANK / 3);
  expect(levelsBought()).toBe(0);
  const plan = fresh.controller().bladeburnerView().skills;
  if (plan == null) throw new Error("no skills' plan");
  console.log(fresh.controller().bladeburnerView().line);
  // #421's ruling 2, item 4: the rule's priced time to Typhoon's 2,500 at this first reading, each action's best plan
  // (core's `bladeburnerPlansToTarget` on the brain's own input, in the city read), printed: the objective's figures.
  {
    const data = fresh.medium() as MediumSnapshotData;
    const read = bladeburnerSnapshotOf(data).reading;
    const person = bladeburnerPersonOf(data.player);
    if (read.kind !== "read" || read.actions === null || person === null) throw new Error("no first reading");
    const rule = bladeburnerRuleInputOf(read.actions, person, bladeburnerRankMultiplierOf(6) as number, data.player);
    const plans = bladeburnerPlansToTarget({ ...rule.input, target: { rank: RANK, target: 2500 } });
    const best = new Map<string, (typeof plans)[number]>();
    for (const each of plans) {
      const name = each.work === null ? "resting alone" : `${each.work.name} ${each.work.level}`;
      if (!best.has(name)) best.set(name, each);
    }
    console.log(
      `the first reading's plans to rank 2500 (#421's ruling 2), each action's best: ` +
        [...best.entries()]
          .map(
            ([name, each]) => `${name} with ${each.rest.name} ${((each.toTarget?.seconds ?? 0) / 3600).toFixed(2)} h`,
          )
          .join("; "),
    );
  }
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
  // #418: the six cities' true figures at the hour's start, and the charisma Diplomacy cuts the chaos by.
  const startCities = await fresh.simulation.diagnostics.bladeburnerCities();
  const charisma =
    (fresh.medium() as { player?: { skills?: { charisma?: number } } } | null)?.player?.skills?.charisma ?? 1;
  await fresh.game.run(HOUR);
  // The hour's consistency (#418's rulings 3 and 5), action by action, the forecast counted by the attempts made, first
  // (so a judged chance off fails it before the figures it moves): each contract's and operation's attempt in the
  // simulator's log at the chance section 8 judges at the reading before it (the brain's own `bladeburnerRuleInputOf`:
  // the true population's, pop/popEst recovered from the next Black Op's range; where it isn't, the low end read),
  // p × gain − (1 − p) × loss, against the same attempts at the chance the game drew (p × gain − (1 − p) × the floored
  // loss, `attemptsSummary`). Its error from the inputs: the chance's own movement between the reading and the draw, at
  // most an attempt's (each attempt's gain and loss times its chance's change since its action's previous one), and,
  // where pop/popEst isn't recovered, the population's spread (gain and loss times the game's range, high less low).
  // Both sides are expectations: the successes' luck is in neither; and counted by the attempts, the cut attempts at the
  // switches (section 8's own forecast counts the time) are out.
  const judgedAt = fresh.data.store
    .snapshots({ environment: "E1" })
    .filter((each) => each.tier === "medium")
    .flatMap((each) => {
      const data = each.data as MediumSnapshotData;
      const read = bladeburnerSnapshotOf(data).reading;
      const person = bladeburnerPersonOf(data.player);
      const rankMultiplier = bladeburnerRankMultiplierOf(6);
      if (read.kind !== "read" || read.actions === null || person === null || rankMultiplier === null) return [];
      const rule = bladeburnerRuleInputOf(read.actions, person, rankMultiplier, data.player);
      const judged = rule.ratio === null ? read.actions.actions : rule.input.readings;
      return [{ atMs: each.receivedAtMs, judged, recovered: rule.ratio !== null }];
    })
    .sort((a, b) => a.atMs - b.atMs);
  const readingBefore = (atMs: number) => judgedAt.filter((each) => each.atMs <= atMs).at(-1);
  const levelled = (await attemptsIn(fresh.simulation, 0, fresh.game.clock.now())).filter(
    (attempt) => attempt.type === "Contracts" || attempt.type === "Operations",
  );
  const rows: string[] = [];
  for (const name of new Set(levelled.map((attempt) => attempt.name))) {
    const mine = levelled.filter((attempt) => attempt.name === name);
    let forecastOf = 0;
    let weight = 0;
    let moved = 0;
    let spread = 0;
    for (const [k, attempt] of mine.entries()) {
      const reading = readingBefore(attempt.atMs);
      const judged = reading?.judged.find((read) => read.name === attempt.name)?.chance[0];
      if (reading === undefined || judged === undefined) throw new Error(`no reading before ${attempt.name}'s attempt`);
      forecastOf += judged * attempt.gain - (1 - judged) * attempt.loss;
      weight += judged * (attempt.gain + attempt.loss);
      const previous = mine[k - 1];
      if (previous !== undefined) {
        // The bound's premise (#418's ruling 6): the reading judged is at or after the previous attempt, so the chance
        // moves from it to the draw by no more than an attempt's.
        expect(reading.atMs, `${attempt.name}'s reading before its attempt ${k}`).toBeGreaterThanOrEqual(previous.atMs);
        moved += (attempt.gain + attempt.loss) * Math.abs(attempt.chance - previous.chance);
      }
      if (!reading.recovered) spread += (attempt.gain + attempt.loss) * (attempt.range[1] - attempt.range[0]);
    }
    const expected = attemptsSummary(mine, null).expected;
    const bar = moved + spread;
    rows.push(
      `${name}: forecast ${forecastOf.toFixed(2)} by its ${mine.length} attempts against ${expected.toFixed(2)} ` +
        `expected (its error ${bar.toFixed(2)}: the chance's movement ${moved.toFixed(2)}, the range's ` +
        `${spread.toFixed(2)}; the least bias on its chance it catches ${((100 * bar) / weight).toFixed(1)}%)`,
    );
    expect(Math.abs(forecastOf - expected), name).toBeLessThanOrEqual(bar);
  }
  console.log(`the hour's consistency, action by action:\n  ${rows.join("\n  ")}`);
  expect(rows.length).toBeGreaterThan(0);
  // #408's hindcast: the grown estimate's time to the rank the hour reached, from the reading with the points.
  const hindcast = await grownHindcastIn(
    fresh,
    "B3's hour at rank 150",
    { fromMs: shownAtMs, untilMs: fresh.game.clock.now() },
    reading()?.rank ?? 0,
  );
  console.log(hindcast.line);
  expectGrownHindcast(hindcast);

  // #418: each city's chaos and true population after the hour against the drift's prediction (core's mean path from
  // the simulator's true figures at the hour's start, each attempt the rule made at its own chance, the decay and the
  // events' mean between; within 4 standard deviations of the draws' spread), and the attempts' own effects alone.
  // Incite Violence (#420's ruling 3): since #420 the rule sends it in this hour (Raid's count binding in the city it
  // measures best); why, by its own figures at the reading before the first under way (core's `chooseBladeburnerCity`
  // on the brain's input there, the cities measured by the round), its measure paying. (#421's ruling 1's regrown
  // counts turned it, Raid's count never binding; ruling 4 moved them to #424.)
  const mediums = fresh.data.store
    .snapshots({ environment: "E1" })
    .filter((each) => each.tier === "medium")
    .sort((a, b) => a.receivedAtMs - b.receivedAtMs);
  const reads = mediums.filter((each) => bladeburnerSnapshotOf(each.data).reading.kind === "read");
  {
    const raw = reads.map(
      (each) => (each.data as { bladeburner?: { progress?: unknown; current?: unknown } }).bladeburner,
    );
    const withProgress = raw.filter((each) => each?.progress !== undefined).length;
    const actionsOf = reads.map((each) => (bladeburnerSnapshotOf(each.data).reading as { actions?: unknown }).actions);
    const underWays = actionsOf.map((each) =>
      each == null ? null : bladeburnerUnderWayOf(each as Parameters<typeof bladeburnerUnderWayOf>[0]),
    );
    // #421's ruling 3: the progress read at nearly every reading, and each attempt the rule cut mid-way priced so: at the
    // reading before the cut, its plan's time to the target (its first attempt at its time left) against the plan the
    // rule went to, which must be the less, by the rule's own figures (core's `bladeburnerPlansToTarget` on its input).
    expect(withProgress).toBeGreaterThan(reads.length / 2);
    expect(underWays.some((each) => each !== null)).toBe(true);
    const cuts: { gap: number; done: number }[] = [];
    for (let i = 0; i + 1 < reads.length; i++) {
      const from = raw[i]?.current as { name?: string } | null | undefined;
      const to = raw[i + 1]?.current as { name?: string } | null | undefined;
      const done = (raw[i + 1]?.progress as { secondsDone?: number } | null | undefined)?.secondsDone ?? 0;
      const levelled = (name?: string) => BLADEBURNER_LEVELLED_ACTIONS.some((each) => each.name === name);
      if (!levelled(from?.name) || !levelled(to?.name) || from?.name === to?.name || !(done > 0)) continue;
      const data = reads[i]?.data as MediumSnapshotData;
      const read = bladeburnerSnapshotOf(data).reading;
      const person = bladeburnerPersonOf(data.player);
      if (read.kind !== "read" || read.actions === null || person === null) throw new Error("no reading before a cut");
      const rule = bladeburnerRuleInputOf(read.actions, person, bladeburnerRankMultiplierOf(6) as number, data.player);
      const plans = bladeburnerPlansToTarget({ ...rule.input, target: { rank: read.rank ?? 0, target: 2500 } });
      const timeOf = (name?: string) => plans.find((plan) => plan.work?.name === name)?.toTarget?.seconds as number;
      cuts.push({ gap: timeOf(from?.name) - timeOf(to?.name), done });
    }
    const least = cuts.reduce((a, b) => (b.gap < a.gap ? b : a), { gap: Number.POSITIVE_INFINITY, done: 0 });
    console.log(
      `the attempt under way (#421's ruling 3): ${withProgress} of ${reads.length} readings with its progress; ` +
        `${cuts.length} attempts cut mid-way, the plan cut to ahead of continuing (at its time left) by ` +
        `${least.gap.toFixed(1)} s at least (that attempt ${least.done} s done)`,
    );
    for (const cut of cuts) expect(cut.gap).toBeGreaterThan(0);
    // The time left is the level read's seconds less those done (#425's review, row 4): the game fixes an attempt's
    // time at its start (`Bladeburner.ts:186-188`) and no NS call returns it, so where the level changed mid-attempt
    // the time left is off by the two levels' times' ratio, difficultyFac^Δ (`Action.ts:105-122`, before its ⌈⌉): its
    // share of an attempt measured here, each reading within an attempt against that attempt's first reading (#425's
    // re-review: two changes in one attempt counted whole), and held to core's label (`underWay`: at most 4.5%).
    type Read = { current?: { name?: string } | null; actions?: BladeburnerActionReadingLike[] };
    const levelIn = (read: Read | undefined, name: string) => read?.actions?.find((each) => each.name === name)?.level;
    let within = 0;
    let changed = 0;
    let most = 0;
    let start = 0;
    for (let i = 0; i + 1 < reads.length; i++) {
      const before = actionsOf[i] as Read | undefined;
      const after = actionsOf[i + 1] as Read | undefined;
      const doneBefore = (raw[i]?.progress as { secondsDone?: number } | null | undefined)?.secondsDone;
      const doneAfter = (raw[i + 1]?.progress as { secondsDone?: number } | null | undefined)?.secondsDone;
      const name = after?.current?.name;
      const action = BLADEBURNER_LEVELLED_ACTIONS.find((each) => each.name === name);
      const same =
        action !== undefined &&
        before?.current?.name === name &&
        doneBefore !== undefined &&
        doneAfter !== undefined &&
        doneAfter > doneBefore;
      if (!same || action === undefined || name === undefined) {
        // A new attempt (or none) from the next reading on: that one is its first.
        start = i + 1;
        continue;
      }
      within += 1;
      const delta = (levelIn(after, name) ?? 0) - (levelIn(actionsOf[start] as Read | undefined, name) ?? 0);
      if (delta === 0) continue;
      changed += 1;
      most = Math.max(most, Math.abs(action.difficultyFac ** delta - 1));
    }
    console.log(
      `the time left's level (#425's review, row 4): ${changed} of ${within} readings within one attempt at another ` +
        `level than its first reading's, the time left off by at most ${(100 * most).toFixed(1)}% of an attempt there`,
    );
    expect(within).toBeGreaterThan(0);
    expect(most).toBeLessThanOrEqual(UNDER_WAY_LEVEL_BOUND);
  }
  const firstIncite = mediums.findIndex((each) => {
    const read = bladeburnerSnapshotOf(each.data).reading;
    return read.kind === "read" && read.actions?.current?.name === "Incite Violence";
  });
  // Sent on this seed's hour (#422's review: not passing silently where none is).
  expect(firstIncite).toBeGreaterThan(0);
  const inciteBefore = mediums[firstIncite - 1]?.data as MediumSnapshotData;
  const inciteRead = bladeburnerSnapshotOf(inciteBefore).reading;
  const incitePerson = bladeburnerPersonOf(inciteBefore.player);
  if (inciteRead.kind !== "read" || inciteRead.actions === null || incitePerson === null) {
    throw new Error("no reading before Incite");
  }
  const inciteChoice = chooseBladeburnerCity(
    bladeburnerRuleInputOf(
      inciteRead.actions,
      incitePerson,
      bladeburnerRankMultiplierOf(6) as number,
      inciteBefore.player,
    ).input,
    {
      city: inciteRead.actions.city as string,
      cities: bladeburnerMeasuredCitiesOf(inciteRead.actions, incitePerson)?.cities ?? [],
    },
  );
  const incite = inciteChoice?.incite;
  console.log(
    `Incite Violence sent at the reading before ${new Date(mediums[firstIncite]?.receivedAtMs ?? 0).toISOString()}: ` +
      `in ${inciteChoice?.city}, ${incite?.work}'s counts +${incite?.countGain.toFixed(2)} for ` +
      `${incite?.gain.toFixed(3)} rank against its cost ${incite?.cost.toFixed(3)} (its 60 s and the chaos it adds), ` +
      `the rate with every count unbounded ${((incite?.unbounded ?? 0) * 60).toFixed(3)} rank/min`,
  );
  expect(incite?.pays).toBe(true);
  const hourAttempts = await attemptsIn(fresh.simulation, startedAtMs, fresh.game.clock.now());
  const endCities = await fresh.simulation.diagnostics.bladeburnerCities();
  console.log(
    `the cities after the hour against the drift's prediction (#418):\n` +
      expectCitiesAsPredicted(
        startCities,
        endCities,
        hourAttempts,
        startedAtMs,
        fresh.game.clock.now(),
        charisma,
        await fresh.simulation.diagnostics.bladeburnerGeneralActions(0),
      ),
  );

  const window = { environment: "E1", sinceMs: EPOCH_MS, untilMs: fresh.game.clock.now() } as const;
  const { text, failures } = runReport(fresh.data.store, window, { verbose: true });
  const section = text.slice(text.indexOf("8. Bladeburner"), text.indexOf("Verdict"));
  console.log(section);
  console.log(`virtual: ${((fresh.game.clock.now() - startedAtMs) / MINUTE).toFixed(1)} min since the purchase`);
  const forecasts =
    /the rule's forecast there: ([\d.]+) rank\/min with the levels read \([^)]*\); ([\d.]+) rank\/min with none \(B2's\); ([\d.]+) rank\/min with none at rank a second \(an hour's\)/.exec(
      section,
    );
  const measured =
    /rank from the actions run: (-?[\d.]+) measured against (-?[\d.]+) forecast \(σ ([\d.]+)\), its bound (-?[\d.]+)/.exec(
      section,
    );
  expect(forecasts).not.toBeNull();
  expect(measured).not.toBeNull();
  const [withSkills, without, withoutNow] = (forecasts ?? []).slice(1).map(Number) as [number, number, number];
  const [rank, forecast, sigma, bound] = (measured ?? []).slice(1).map(Number) as [number, number, number, number];
  // The game time the actions ran over, as the report counts it (gap-report.ts's `formatDuration`).
  const duration = /over (?:(\d+) h )?(?:(\d+) min)? ?(?:(\d+) s)? of game time/.exec(section);
  expect(duration).not.toBeNull();
  const [hours, minutes, seconds] = (duration ?? []).slice(1).map((each) => Number(each ?? 0)) as number[];
  const gameMinutes = 60 * (hours ?? 0) + (minutes ?? 0) + (seconds ?? 0) / 60;
  // Rank a second with none at the chances read over the hour's game minutes: main's measure for an hour (#418's
  // ruling 2), printed beside the forecast, not a bar. The objective is #386's least expected time to the target, and
  // the drift prices Raid's chance down over its horizon (its city drained, Diplomacy's time on its chaos), so the plan
  // to the target is not the hour's most rank (core's walks of the game's draws order the two, check 3).
  const atRankASecond = withoutNow * gameMinutes;
  console.log(
    `forecast over a cycle: ${withSkills} rank/min with the skills, ${without} without (B2's, under the target and the ` +
      `drift), ${withoutNow} at rank a second; rank ${rank} against ${forecast} forecast of the actions run (σ ${sigma}), ` +
      `its bound ${bound}`,
  );
  // With the skills over without, both under the target and the drift.
  expect(withSkills).toBeGreaterThan(without);
  // The rank measured is judged against its bound only: once the skills lift Raid's chance the rule works it (55 rank a
  // success, its σ over the hour about 30), so an hour's rank can't show the rise apart from luck.
  expect(rank).toBeGreaterThanOrEqual(bound);
  // The low-variance part on its own (#381's review): Field Analysis and the contracts, from section 8's lines by
  // action, their rank and their forecast's Bernstein bound at the same α (printed). Raid's luck is left to the whole's
  // bound.
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
  // #417's review: the steady line printed, not asserted (the rule works Raid most of the hour since #415, so the steady
  // part is Field Analysis's alone). The whole's forecast of the actions run against every attempt's expected rank given
  // the attempts made (the simulator's log, Raid included: p × gain − (1 − p) × the floored loss, `attemptsSummary`) and
  // Field Analysis's rank as made (no draw in it), printed; asserted action by action below.
  const attempts = await attemptsIn(fresh.simulation, 0, fresh.game.clock.now());
  const fieldAnalysis = steady.find((each) => each.name === "Field Analysis")?.figures[0] ?? 0;
  const all = attemptsSummary(attempts, null);
  const expectedAll = all.expected + fieldAnalysis;
  console.log(
    `every attempt expected given the actions: ${expectedAll.toFixed(2)} (${attempts.length} attempts, ` +
      `${all.successes} successes, ${(all.realised + fieldAnalysis).toFixed(2)} realised, Field Analysis's ` +
      `${fieldAnalysis.toFixed(2)} in both) against the forecast of the actions run ${forecast} (σ ${sigma})`,
  );
  // Its parts at the last reading, over the same minutes: the skills' (with them over without, both under the target
  // and the drift), and the target's and the drift's (B2's without them under the target over rank a second's at the
  // chances read: the plan to the target priced over its horizon, Raid's chance falling as its city drains and
  // Diplomacy's time on its chaos, where it works Raid, against the hour's most rank at the chances read).
  const skillsPart = (withSkills - without) * gameMinutes;
  const driftPart = (without - withoutNow) * gameMinutes;
  console.log(
    `rank a second with none over the hour (main's measure, an hour's rank; not a bar since #418's ruling 2): ` +
      `${atRankASecond.toFixed(2)} against the forecast of the actions run ${forecast}; at the last reading, the skills' ` +
      `part ${skillsPart.toFixed(2)} and the target's and the drift's ${driftPart.toFixed(2)} over ${gameMinutes} min`,
  );
  expect(section).toContain("  skill points unspent with a level to buy, past 52 s:\n    none");
  expect(failures).toEqual([]);
  // #423: the planner's grown route replayed on the seed series from its refresh's game time.
  const blackOps = fresh.controller().worldDaemonView().path?.blackOps;
  expect(blackOps?.grownAtMs).toEqual(expect.any(Number));
  expect(blackOps?.grown?.replays?.seed).toBe(bladeburnerReplaySeedOf(blackOps?.grownAtMs as number));
  // A hang guard (#418's ruling 6): its fastest completed CI time, 78.5 s (PR #419's run 43684859936, db48800), × the
  // largest same-code swing over those runs, 3.743 (augmentations.test 58.8 s against 15.7 s).
}, 294_000);
