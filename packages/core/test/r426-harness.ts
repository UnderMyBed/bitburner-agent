// #426's research, WIP (never to merge as is): each replay's climb steps re-chosen by the route's own step solver at
// the replay's drawn cities, against #427's held mix. Runs with R426=1 (locally, and on Linux by the WIP branch's workflow, .github/workflows/r426-research.yml),
// so both machines' figures are read. Knobs: R426_REPLAYS (200), R426_SERIES (10), R426_ROUTES (the list below),
// R426_VARIANTS ("held,mean,rechosen": the held mix in this harness's clock; re-chosen with #427's rebuilds; re-chosen
// rebuilds too), R426_OUT (a JSONL file for the rows).
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { augmentationsSoldBy } from "../src/augmentations.ts";
import { COMBAT_STATS, type CombatPerson, skillExpFor, skillLevelOf } from "../src/bladeburner.ts";
import {
  actionRankGain,
  actionRankLoss,
  actionSuccessChance,
  BLADEBURNER_LEVELLED_ACTIONS,
  type BladeburnerActionReading,
  type BladeburnerPerson,
  bladeburnerRankMultiplierOf,
  maxStaminaOf,
} from "../src/bladeburner-actions.ts";
import { BLADEBURNER_BLACK_OPS, type BladeburnerBlackOp, blackOpSuccessChance } from "../src/bladeburner-black-ops.ts";
import { type BladeburnerDriftState, bladeburnerMostFactorCity, driftedChance } from "../src/bladeburner-drift.ts";
import {
  type BlackOpsGrownTime,
  type BladeburnerGrowthState,
  blackOpsRouteGrownEstimate,
  blackOpsRouteResearchOf,
  blackOpsRouteTimelineOf,
} from "../src/bladeburner-growth.ts";
import { bladeburnerInstallGain, bladeburnerPersonAfterInstall } from "../src/bladeburner-installs.ts";
import {
  BLADEBURNER_REPLAY_LEAST_RATIO,
  BLADEBURNER_REPLAY_MOST_RATIO,
  BLADEBURNER_REPLAY_SAMPLED_ACTIONS,
  type BladeburnerRoutePart,
  bladeburnerReplayDeclined,
  bladeburnerReplayRoute,
  bladeburnerReplaySeedOf,
  bladeburnerReplayStepper,
  bladeburnerSeeded,
} from "../src/bladeburner-replays.ts";
import { bladeburnerSkillCostMultiplierOf } from "../src/bladeburner-skills.ts";

const RUN = process.env.R426 === "1";
const REPLAYS = Number(process.env.R426_REPLAYS ?? 200);
const SERIES = Number(process.env.R426_SERIES ?? 10);
const ROUTES =
  process.env.R426_ROUTES === undefined || process.env.R426_ROUTES === "" ? null : process.env.R426_ROUTES.split(",");
/**
 * held: the mean path's mix (this harness's clock); mean: climbs re-chosen at B4's city (no Raid), #427's rebuilds;
 * rechosen: rebuilds re-chosen too; mean2 and rechosen2: as mean and rechosen, each solve at B4's city and at B4's Raid city (the most
 * factor with a community), the better.
 */
type Variant = "held" | "mean" | "mean2" | "rechosen" | "rechosen2";
const VARIANTS = (process.env.R426_VARIANTS ?? "held,mean,mean2,rechosen,rechosen2").split(",") as Variant[];
const OUT = process.env.R426_OUT;
/** The engine instrument's samples (R426_SAMPLES, a JSON file): replay-steps by category and ratio band, at most 100 each. */
const SAMPLES = process.env.R426_SAMPLES;
const BANDS = [0.5, 0.7, 0.8, 0.9, 0.93, 1, 1.2, BLADEBURNER_REPLAY_MOST_RATIO, Number.POSITIVE_INFINITY];
const SAMPLE_CAP = Number(process.env.R426_SAMPLE_CAP ?? 100);
/** Ruling 2: only the rebuild-held steps under ×0.5 (R426_SAMPLE_UNDER, a ratio), drawn uniformly across the routes. */
const SAMPLE_UNDER = process.env.R426_SAMPLE_UNDER === undefined ? null : Number(process.env.R426_SAMPLE_UNDER);
interface Sample {
  category: string;
  route: string;
  bitNode: number;
  replay: number;
  segment: number;
  ratio: number;
  start: { name: string; population: number; communities: number; chaos: number }[];
  worked: number;
  ceiling: number;
  reference: BladeburnerDriftState["cities"][number];
  rate: number;
  dt: number;
  parts: {
    name: string;
    type: string;
    level: number;
    chance: number;
    perSecond: number;
    competence: number;
    plus: number;
  }[];
}
const sampled = new Map<string, { seen: number; kept: Sample[] }>();
const sampleRandom = bladeburnerSeeded(4260001);
/** Offer a replay-step to the samples: a reservoir a category and band. */
function offerSample(sample: Sample): void {
  // The held climbs only past the most ratio (ruling 9 measured them under it).
  if (sample.category === "climb-held" && !(sample.ratio > BLADEBURNER_REPLAY_MOST_RATIO)) return;
  if (SAMPLE_UNDER !== null && !(sample.category === "rebuild-held" && sample.ratio < SAMPLE_UNDER)) return;
  const band = BANDS.findIndex((top) => sample.ratio < top);
  const key = `${sample.category} ${band}`;
  const each = sampled.get(key) ?? { seen: 0, kept: [] };
  each.seen++;
  if (each.kept.length < SAMPLE_CAP) each.kept.push(sample);
  else {
    const j = Math.floor(sampleRandom() * each.seen);
    if (j < SAMPLE_CAP) each.kept[j] = sample;
  }
  sampled.set(key, each);
}
/** The samples kept, written (R426_SAMPLES), and each reservoir's count seen. */
export function r426WriteSamples(): string {
  if (SAMPLES === undefined || SAMPLES === "") return "";
  const all = [...sampled.values()].flatMap((each) => each.kept);
  writeFileSync(SAMPLES, JSON.stringify(all));
  return [...sampled.entries()].map(([key, each]) => `${key}: ${each.kept.length} of ${each.seen}`).join("; ");
}
const HOUR = 3600;
const SF1_3 = 1.28;
const CITY = { population: 1e9, communities: 50, chaos: 0 };
const TYPHOON = BLADEBURNER_BLACK_OPS[0] as BladeburnerBlackOp;
const SIX = ["Aevum", "Chongqing", "Sector-12", "New Tokyo", "Ishima", "Volhaven"].map((name) => ({ name, ...CITY }));
const EPOCH = Date.UTC(2026, 0, 1);
const REFRESH_MS = 10 * 60_000;

function combatOf(combat: number): CombatPerson {
  const each = (value: number) => Object.fromEntries(COMBAT_STATS.map((stat) => [stat, value]));
  return {
    skills: each(combat),
    exp: each(skillExpFor(combat, SF1_3)),
    mults: Object.fromEntries(
      COMBAT_STATS.flatMap((stat) => [
        [stat, SF1_3],
        [`${stat}_exp`, SF1_3],
      ]),
    ),
  } as CombatPerson;
}
function combatAfter(combat: CombatPerson, gain: ReturnType<typeof bladeburnerInstallGain>): CombatPerson {
  const mults = { ...combat.mults };
  const exp = { ...combat.exp };
  for (const stat of COMBAT_STATS) {
    mults[stat] = combat.mults[stat] * gain.levels[stat];
    mults[`${stat}_exp`] = combat.mults[`${stat}_exp`] * gain.exp[stat];
    exp[stat] = skillExpFor(combat.skills[stat], mults[stat]);
  }
  return { skills: { ...combat.skills }, exp, mults };
}
function personAt(exp: Readonly<Record<string, number>>): BladeburnerPerson {
  const skills = { hacking: 100, charisma: 1, intelligence: 0 } as BladeburnerPerson["skills"];
  for (const stat of COMBAT_STATS) skills[stat] = skillLevelOf(exp[stat] as number, SF1_3);
  return { skills, mults: { bladeburner_success_chance: 1, bladeburner_max_stamina: 1, bladeburner_stamina_gain: 1 } };
}
function inputAt(who: BladeburnerPerson) {
  const readings: BladeburnerActionReading[] = BLADEBURNER_LEVELLED_ACTIONS.map((action) => {
    const chance = actionSuccessChance(action, 1, who, { city: CITY, penalty: 1 });
    return { type: action.type, name: action.name, level: 1, maxLevel: 1, count: 20, chance: [chance, chance] };
  });
  const maxStamina = maxStaminaOf(who, 0);
  return { readings, person: who, stamina: maxStamina, maxStamina, rankMultiplier: 1, speed: 1, skills: { read: {} } };
}

/** The routes: B7's combat-100 starts in BN6 and BN7 (keep and the shop's), and bn6-skills' refreshes (captured). */
function routes(names: readonly string[]): { name: string; route: BlackOpsGrownTime; seedOf: (k: number) => number }[] {
  const out: { name: string; route: BlackOpsGrownTime; seedOf: (k: number) => number }[] = [];
  const epochSeed = (k: number) => bladeburnerReplaySeedOf(EPOCH + k * REFRESH_MS);
  for (const bitNode of [6, 7]) {
    const wanted = names.filter((name) => name.startsWith(`bn${bitNode}-`));
    if (wanted.length === 0) continue;
    const rankMultiplier = bladeburnerRankMultiplierOf(bitNode) as number;
    const costMultiplier = bladeburnerSkillCostMultiplierOf(bitNode) as number;
    const combat = combatOf(100);
    const who = personAt(combat.exp);
    const chance = blackOpSuccessChance(TYPHOON, who, { penalty: 1 });
    const at = { rank: 0, next: TYPHOON, chanceRead: [chance, chance] as [number, number] };
    const gain = bladeburnerInstallGain(0, augmentationsSoldBy("Bladeburners", bitNode, null));
    const input = { ...inputAt(who), rankMultiplier, drift: { cities: SIX, city: "Sector-12" } };
    if (wanted.includes(`bn${bitNode}-keep`)) {
      const route = blackOpsRouteGrownEstimate(input, at, { combat, costMultiplier, replays: 0 });
      out.push({ name: `bn${bitNode}-keep`, route, seedOf: epochSeed });
    }
    if (wanted.includes(`bn${bitNode}-best`)) {
      const forecast = { ...input, forecast: bladeburnerPersonAfterInstall(who, gain) };
      const route = blackOpsRouteGrownEstimate(forecast, at, {
        combat: combatAfter(combat, gain),
        costMultiplier,
        replays: 0,
      });
      out.push({ name: `bn${bitNode}-best`, route, seedOf: epochSeed });
    }
  }
  if (names.some((name) => name.startsWith("skills"))) {
    const lines = readFileSync(new URL("./r426-bn6-skills.jsonl", import.meta.url), "utf8")
      .trim()
      .split("\n");
    for (const [i, line] of lines.entries()) {
      const call = JSON.parse(line, (_key, value) =>
        typeof value === "string" && value.startsWith("__num:") ? Number(value.slice(6)) : value,
      );
      if (call.nowMs === null || !(names.includes("skills") || names.includes(`skills-${i}`))) continue;
      const next = BLADEBURNER_BLACK_OPS.find((op) => op.name === call.at.next) as BladeburnerBlackOp;
      const route = blackOpsRouteGrownEstimate(call.input, { ...call.at, next }, { ...call.options, replays: 0 });
      const nowMs = call.nowMs as number;
      out.push({ name: `skills-${i}`, route, seedOf: (k) => bladeburnerReplaySeedOf(nowMs + k * REFRESH_MS) });
    }
  }
  return out;
}

interface Rechosen {
  times: number[];
  replaysWithFallback: number;
  fallbackSteps: number;
  /** Each fallback's reason, counted. */
  reasons: Record<string, number>;
  steps: number;
  /** Steps whose re-chosen mix differs from the held one (an action or level in or out, or a share off by over 1%). */
  differs: number;
  /** Each climb step's re-chosen solver rate over the mean path's, and its re-priced rate over the solver's. */
  solverOverMean: number[];
  repricedOverSolver: number[];
  rebuildRepricedOverSolver: number[];
  /** Held only (R426_COUNTERFACTUAL=1): the solver's rate at the step's drawn cities over the held mix's re-priced. */
  counterfactual: number[];
  /** The same at a horizon of 0 (each chance at the step's start, no drift ahead). */
  counterfactual0: number[];
  /** Each replay's six at its end: the mean chaos, population (×10⁹) and communities. */
  ends: { chaos: number; population: number; communities: number }[];
  solves: number;
  solveMs: number;
}

/**
 * The route's replays with each climb step's mix re-chosen at the replay's drawn cities (the route's own solver, its
 * `tailAt`, at the mean path's state there but the replay's six and city worked), its attempts drawn over the solver's
 * own time for the step, and re-priced first-order at their draws (#423's), the gate's bounds and actions applied to
 * the re-priced over the solver's rate. `held`: the mean path's mix and rate instead (the harness's check: it must give
 * #427's replays exactly). Rebuilds: "mean" #427's (the mean path's rate, its parts' attempts drawn); "rechosen" each
 * rebuild re-chosen at the drawn cities and re-priced the same way.
 */
function rechosenReplays(
  route: BlackOpsGrownTime,
  {
    seed,
    replays,
    variant,
    timeline = blackOpsRouteTimelineOf(route),
    sampling,
  }: {
    seed: number;
    replays: number;
    variant: Variant;
    timeline?: ReturnType<typeof blackOpsRouteTimelineOf>;
    /** The engine instrument's samples from these replays (R426_SAMPLES). */
    sampling?: { route: string; bitNode: number };
  },
): Rechosen {
  const held = variant === "held";
  const rebuilds = variant === "rechosen" || variant === "rechosen2" ? "rechosen" : "mean";
  const research = blackOpsRouteResearchOf(route);
  if (timeline === null || research === null) throw new Error("no timeline");
  const { reference, segments } = timeline;
  const plusOf = (part: BladeburnerRoutePart) =>
    actionRankGain(part.action, part.level, timeline.rankMultiplier) + actionRankLoss(part.action, part.level);
  const lossOf = (part: BladeburnerRoutePart) => actionRankLoss(part.action, part.level);
  const competenceOf = (part: BladeburnerRoutePart, state: BladeburnerDriftState) => {
    const city = state.cities[state.worked];
    if (city === undefined) return 0;
    const factor = driftedChance({ action: part.action, chance: 1e-6 }, reference, city, state.ceiling) / 1e-6;
    return factor > 0 ? part.chance / factor : 0;
  };
  const out: Rechosen = {
    times: [],
    replaysWithFallback: 0,
    fallbackSteps: 0,
    reasons: {},
    steps: 0,
    differs: 0,
    solverOverMean: [],
    repricedOverSolver: [],
    rebuildRepricedOverSolver: [],
    counterfactual: [],
    counterfactual0: [],
    ends: [],
    solves: 0,
    solveMs: 0,
  };
  const fall = (why: string) => {
    out.reasons[why] = (out.reasons[why] ?? 0) + 1;
  };
  const sameMix = (a: readonly BladeburnerRoutePart[], b: readonly BladeburnerRoutePart[]) => {
    if (a.length !== b.length) return false;
    const key = (p: BladeburnerRoutePart) => `${p.action.name} ${p.level}`;
    const byKey = new Map(b.map((p) => [key(p), p]));
    return a.every((p) => {
      const q = byKey.get(key(p));
      return q !== undefined && Math.abs(p.perSecond / q.perSecond - 1) <= 0.01;
    });
  };
  let debugged = 0;
  let currentSegment = 0;
  let lastDrawn: string[] = [];
  for (let replay = 0; replay < replays; replay++) {
    const stepper = bladeburnerReplayStepper(timeline.start, reference, { seed: seed + 7919 * replay });
    let clock = 0;
    let total = 0;
    let fell = 0;
    // The replay's six as the brain would solve at them (R426_SEEN=raw: as they stand): B4's pick by the true figures
    // and Diplomacy taking it to its ceiling (the replay's own first attempt does both; the mean path holds the city
    // worked there).
    const drawnState = (ceiling: number): BladeburnerDriftState => {
      const cities = stepper.cities.map((city) => ({ ...city }));
      if (process.env.R426_SEEN === "raw") return { cities, worked: stepper.worked, ceiling };
      const worked = bladeburnerMostFactorCity(cities, stepper.worked, false, ceiling);
      const city = cities[worked] as (typeof cities)[number];
      city.chaos = Math.min(city.chaos, ceiling);
      return { cities, worked, ceiling };
    };
    // The solver at the replay's six: at B4's city; for rechosen2 also at B4's Raid city, the better of the two.
    const chooseAt = (at: BladeburnerGrowthState, horizon: number, ceiling: number) => {
      const reference = (at.drift as NonNullable<typeof at.drift>).reference;
      const state = drawnState(ceiling);
      const started = performance.now();
      let best = { mix: research.solve({ ...at, drift: { state, reference } }, horizon), state };
      out.solves++;
      if (variant === "rechosen2" || variant === "mean2") {
        const cities = stepper.cities.map((city) => ({ ...city }));
        const worked = bladeburnerMostFactorCity(cities, stepper.worked, true, ceiling);
        if (worked !== state.worked) {
          const city = cities[worked] as (typeof cities)[number];
          city.chaos = Math.min(city.chaos, ceiling);
          const raidState = { cities, worked, ceiling };
          const mix = research.solve({ ...at, drift: { state: raidState, reference } }, horizon);
          out.solves++;
          if (mix.rate > best.mix.rate) best = { mix, state: raidState };
        }
      }
      out.solveMs += performance.now() - started;
      return best;
    };
    // A mix's attempts evenly over [clock, clock + dt], drawn, and its rate re-priced first-order at the draws.
    const draw = (
      parts: readonly BladeburnerRoutePart[],
      rate: number,
      dt: number,
      state: BladeburnerDriftState,
      category?: string,
    ) => {
      const snapshot =
        category !== undefined && sampling !== undefined
          ? { start: stepper.cities.map((city) => ({ ...city })), worked: stepper.worked }
          : null;
      const attempts: { at: number; part: number; competence: number }[] = [];
      for (const [i, part] of parts.entries()) {
        const n = Math.round(part.perSecond * dt);
        const competence = competenceOf(part, state);
        for (let j = 0; j < n; j++) attempts.push({ at: clock + ((j + 0.5) * dt) / n, part: i, competence });
      }
      attempts.sort((a, b) => a.at - b.at);
      const sums = parts.map(() => 0);
      const counts = parts.map(() => 0);
      for (const each of attempts) {
        const part = parts[each.part] as BladeburnerRoutePart;
        const drawn = stepper.attempt({ at: each.at, action: part.action, competence: each.competence, state });
        const plus = plusOf(part);
        const p = drawn.skipped ? (plus > 0 ? lossOf(part) / plus : 0) : drawn.chance;
        sums[each.part] = (sums[each.part] as number) + p;
        counts[each.part] = (counts[each.part] as number) + 1;
      }
      clock += dt;
      stepper.pass(clock);
      let next = rate;
      lastDrawn = [];
      for (const [i, part] of parts.entries()) {
        const n = counts[i] as number;
        const mean = n > 0 ? (sums[i] as number) / n : part.chance;
        next += part.perSecond * (mean - part.chance) * plusOf(part);
        lastDrawn.push(
          `${part.action.name} L${part.level} x${part.perSecond.toFixed(5)} p ${part.chance.toFixed(3)} drawn ${mean.toFixed(3)} n ${n} plus ${plusOf(part).toFixed(1)}`,
        );
      }
      if (snapshot !== null && sampling !== undefined && category !== undefined && rate > 0) {
        offerSample({
          category,
          route: sampling.route,
          bitNode: sampling.bitNode,
          replay,
          segment: currentSegment,
          ratio: next / rate,
          ...snapshot,
          ceiling: state.ceiling,
          reference,
          rate,
          dt,
          parts: parts.map((part) => ({
            name: part.action.name,
            type: part.action.type,
            level: part.level,
            chance: part.chance,
            perSecond: part.perSecond,
            competence: competenceOf(part, state),
            plus: plusOf(part),
          })),
        });
      }
      return next;
    };
    const gated = (repriced: number, rate: number, parts: readonly BladeburnerRoutePart[]) => {
      if (!parts.every((part) => BLADEBURNER_REPLAY_SAMPLED_ACTIONS.has(part.action.name))) return "unsampled";
      if (!(repriced > 0)) return "rate ≤ 0";
      if (repriced < BLADEBURNER_REPLAY_LEAST_RATIO * rate) return "under the least";
      if (repriced > BLADEBURNER_REPLAY_MOST_RATIO * rate) return "over the most";
      return null;
    };
    for (const [s, segment] of segments.entries()) {
      currentSegment = s;
      if (segment.kind === "fixed") {
        clock += segment.span;
        stepper.pass(clock);
        total += segment.span;
        continue;
      }
      if (segment.kind === "climb") {
        out.steps++;
        let parts: readonly BladeburnerRoutePart[] = segment.parts;
        let rate = segment.rate;
        let dt = segment.dt;
        let state = segment.state;
        if (!held) {
          const climb = research.climbs.get(s);
          if (climb === undefined || climb.at.drift === undefined) throw new Error("no climb state");
          const chosen = chooseAt(climb.at, climb.horizon, segment.state.ceiling);
          const { mix } = chosen;
          state = chosen.state;
          if (!(mix.rate > 0)) {
            // No mix at the drawn cities: the step at the mean path's (counted).
            fell++;
            fall("no mix");
            clock += segment.dt;
            stepper.pass(clock);
            total += segment.dt;
            continue;
          }
          parts = research.partsOf(mix);
          rate = mix.rate;
          dt = segment.by / rate;
          if (!sameMix(parts, segment.parts)) out.differs++;
          out.solverOverMean.push(rate / segment.rate);
        }
        const before = held && process.env.R426_COUNTERFACTUAL === "1" ? drawnState(segment.state.ceiling) : null;
        const repriced = draw(parts, rate, dt, state, held ? "climb-held" : `climb-${variant}`);
        if (before !== null) {
          const climb = research.climbs.get(s);
          if (climb?.at.drift !== undefined) {
            const mix = research.solve(
              { ...climb.at, drift: { state: before, reference: climb.at.drift.reference } },
              climb.horizon,
            );
            out.counterfactual.push(mix.rate / repriced);
            if (mix.rate / repriced < 0.5 && debugged < 4 && process.env.R426_DEBUG === "1") {
              debugged++;
              const city = before.cities[before.worked];
              console.log(
                `R426DBG replay ${replay} segment ${s}: held rate ${rate.toFixed(4)} repriced ${repriced.toFixed(4)}; solver ${mix.rate.toFixed(4)} ` +
                  `[${mix.work.map((w) => `${w.name} L${w.level} x${w.attemptsPerSecond.toFixed(5)} p ${w.chance.toFixed(3)}`).join("; ")}]; ` +
                  `held [${lastDrawn.join("; ")}]; worked ${city?.name} chaos ${city?.chaos.toFixed(1)} pop ${((city?.population ?? 0) / 1e9).toFixed(3)} comm ${city?.communities}; ` +
                  `six ${before.cities.map((c) => `${c.name} ${c.chaos.toFixed(0)}/${(c.population / 1e9).toFixed(2)}/${c.communities}`).join(", ")}`,
              );
            }
            const flat = research.solve(
              { ...climb.at, drift: { state: before, reference: climb.at.drift.reference } },
              0,
            );
            out.counterfactual0.push(flat.rate / repriced);
          }
        }
        out.repricedOverSolver.push(repriced / rate);
        const why = gated(repriced, rate, parts);
        if (why !== null) {
          fell++;
          fall(why);
          total += segment.by / rate;
        } else total += segment.by / repriced;
        continue;
      }
      // A Black Op: its attempts' span the mean path's; its rebuilds back to back from its start.
      const start = clock;
      let extra = 0;
      const ats = research.works.get(s) ?? [];
      for (const [k, work] of segment.works.entries()) {
        if (rebuilds === "mean" || held) {
          draw(work.parts, work.rate, work.dt, work.state, held ? "rebuild-held" : undefined);
          continue;
        }
        const at = ats[k];
        if (at === undefined || at.drift === undefined) throw new Error("no rebuild state");
        const { mix, state } = chooseAt(at, 0, work.state.ceiling);
        const loss = work.dt * work.rate;
        if (!(mix.rate > 0)) {
          fell++;
          fall("no rebuild mix");
          draw(work.parts, work.rate, work.dt, work.state);
          continue;
        }
        const parts = research.partsOf(mix);
        const dt = loss / mix.rate;
        const repriced = draw(parts, mix.rate, dt, state, `rebuild-${variant}`);
        out.rebuildRepricedOverSolver.push(repriced / mix.rate);
        const why = gated(repriced, mix.rate, parts);
        if (why !== null) {
          fell++;
          fall(`rebuild ${why}`);
          extra += dt - work.dt;
        } else extra += loss / repriced - work.dt;
      }
      // The next step after both its span (and the rebuilds' extra) and its rebuilds' attempts, which can run past
      // its span (#427 overlaps them with the next climb's; a replay here can't).
      clock = Math.max(
        clock,
        start + segment.span + (clock - start - segment.works.reduce((sum, work) => sum + work.dt, 0)),
      );
      stepper.pass(clock);
      total += segment.span + extra;
    }
    out.times.push(total);
    const six = stepper.cities;
    out.ends.push({
      chaos: six.reduce((sum, city) => sum + city.chaos, 0) / six.length,
      population: six.reduce((sum, city) => sum + city.population, 0) / six.length / 1e9,
      communities: six.reduce((sum, city) => sum + city.communities, 0) / six.length,
    });
    out.fallbackSteps += fell;
    if (fell > 0) out.replaysWithFallback++;
  }
  return out;
}

const meanAndError = (xs: readonly number[]) => {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, xs.length - 1);
  return { mean, error: Math.sqrt(variance / xs.length) };
};
const quantiles = (xs: readonly number[]) => {
  if (xs.length === 0) return "none";
  const sorted = [...xs].sort((a, b) => a - b);
  const at = (q: number) => (sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number).toFixed(3);
  return `min ${(sorted[0] as number).toFixed(4)} p10 ${at(0.1)} p50 ${at(0.5)} p90 ${at(0.9)} max ${(sorted.at(-1) as number).toFixed(3)}`;
};

/** The research on `names` (R426_ROUTES overrides), one test file a group so CI spreads them over its shards. */
export function r426Suite(names: readonly string[]): void {
  const chosen = ROUTES ?? names;
  describe.runIf(RUN)(`#426's research (${chosen.join(", ")}): the climb steps re-chosen at the drawn cities`, () => {
    test.runIf(chosen.includes("bn6-best"))(
      "the harness, held: #427's replays exactly (BN6's best, the first series, 20 replays)",
      () => {
        const all = routes(["bn6-best"]);
        const first = all.find((each) => each.name === "bn6-best") ?? all[0];
        if (first === undefined) return;
        const seed = first.seedOf(0);
        // On its timeline with the rebuilds' attempts left out (#427 overlaps them with the next climb's; this harness runs
        // them in turn): the climbs' draws and re-pricing, the events and the clock checked.
        const full = blackOpsRouteTimelineOf(first.route) as NonNullable<ReturnType<typeof blackOpsRouteTimelineOf>>;
        const timeline = {
          ...full,
          segments: full.segments.map((segment) => (segment.kind === "blackOp" ? { ...segment, works: [] } : segment)),
        };
        const held = rechosenReplays(first.route, { seed, replays: 20, variant: "held", timeline });
        const ours = bladeburnerReplayRoute(timeline, { seed, replays: 20 });
        // To the clock's rounding (the harness sums the steps' times; #427 reads each segment's start).
        for (const [i, time] of held.times.entries())
          expect(Math.abs(time / (ours.times[i] as number) - 1)).toBeLessThan(1e-9);
        expect(held.fallbackSteps).toBe(ours.fallbackSteps);
      },
      600_000,
    );

    test("each route on its series: the re-chosen figure, its gate, against the mean path's and #427's", () => {
      const rows: string[] = [];
      for (const { name, route, seedOf } of routes(chosen)) {
        const timeline = blackOpsRouteTimelineOf(route);
        if (timeline === null) continue;
        const meanPath = route.meanPathSeconds ?? route.seconds;
        rows.push(`${name}: the mean path ${(meanPath / HOUR).toFixed(2)} h, ${timeline.segments.length} segments`);
        for (let k = 0; k < SERIES; k++) {
          const seed = seedOf(k);
          const heldReplays = bladeburnerReplayRoute(timeline, {
            seed,
            replays: REPLAYS,
            ...(process.env.R426_REBUILD_LEAST === undefined ? {} : { rebuildLeastRatio: Number(process.env.R426_REBUILD_LEAST) }),
            ...(process.env.R426_REBUILD_MOST === undefined ? {} : { rebuildMostRatio: Number(process.env.R426_REBUILD_MOST) }),
          });
          const heldDeclined = bladeburnerReplayDeclined(heldReplays);
          const parts = [
            `  series ${k + 1}: #427 ${(heldReplays.seconds / HOUR).toFixed(2)}±${(heldReplays.error / HOUR).toFixed(2)} h ` +
              `(${heldReplays.replaysWithFallback} at the fallback: ${heldDeclined === null ? "used" : "declined"})`,
          ];
          for (const variant of VARIANTS) {
            const started = performance.now();
            const r = rechosenReplays(route, {
              seed,
              replays: REPLAYS,
              variant,
              ...(SAMPLES !== undefined && SAMPLES !== "" && k === 0
                ? { sampling: { route: name, bitNode: name.startsWith("bn7") ? 7 : 6 } }
                : {}),
            });
            const ms = performance.now() - started;
            const { mean, error } = meanAndError(r.times);
            const declined = bladeburnerReplayDeclined({
              replays: REPLAYS,
              replaysWithFallback: r.replaysWithFallback,
              seconds: mean,
              error,
            });
            parts.push(
              `${variant}: ${(mean / HOUR).toFixed(2)}±${(error / HOUR).toFixed(2)} h ` +
                `(${r.replaysWithFallback} at the fallback, ${JSON.stringify(r.reasons)}: ${declined === null ? "used" : "declined"}; ` +
                `${r.differs} of ${r.steps} steps' mixes differ; ${r.solves} solves ${(r.solveMs / Math.max(1, r.solves)).toFixed(2)} ms each; ` +
                `${(ms / 1000).toFixed(1)} s)`,
            );
            if (OUT !== undefined && OUT !== "") {
              appendFileSync(
                OUT,
                `${JSON.stringify({
                  name,
                  series: k + 1,
                  variant,
                  meanPath,
                  held: {
                    seconds: heldReplays.seconds,
                    error: heldReplays.error,
                    fallback: heldReplays.replaysWithFallback,
                    used: heldDeclined === null,
                  },
                  rechosen: {
                    seconds: mean,
                    error,
                    fallback: r.replaysWithFallback,
                    used: declined === null,
                    reasons: r.reasons,
                    differs: r.differs,
                    steps: r.steps,
                  },
                  solverOverMean: quantiles(r.solverOverMean),
                  repricedOverSolver: quantiles(r.repricedOverSolver),
                  rebuildRepricedOverSolver: quantiles(r.rebuildRepricedOverSolver),
                  counterfactual: quantiles(r.counterfactual),
                  counterfactual0: quantiles(r.counterfactual0),
                  ends: {
                    chaos: meanAndError(r.ends.map((e) => e.chaos)).mean,
                    population: meanAndError(r.ends.map((e) => e.population)).mean,
                    communities: meanAndError(r.ends.map((e) => e.communities)).mean,
                  },
                  solves: r.solves,
                  solveMs: r.solveMs,
                  ms,
                })}\n`,
              );
            }
          }
          rows.push(parts.join("; "));
        }
      }
      const kept = r426WriteSamples();
      console.log(`R426\n${rows.join("\n")}${kept === "" ? "" : `\nsamples: ${kept}`}`);
      expect(rows.length).toBeGreaterThan(0);
    }, 7_200_000);
  });
}
