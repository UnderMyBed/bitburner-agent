// Bladeburner B7 (#404): augmentations and installs on the Black Ops' route. The gain an install gives the route
// against core's augmentation data, the person after it, the rebuild by Training, the planner's choice (keep or
// install now) on both sides, the route's estimate with an install against a seeded walk, and BN6's playability by
// the estimate with installs against the campaign's bar.
import { describe, expect, test } from "vitest";
import { AUGMENTATIONS } from "../src/augmentation-data.ts";
import { augmentationsSoldBy } from "../src/augmentations.ts";
import { COMBAT_STATS, type CombatPerson, skillExpFor } from "../src/bladeburner.ts";
import {
  actionSuccessChance,
  BLADEBURNER_LEVELLED_ACTIONS,
  type BladeburnerActionReading,
  type BladeburnerPerson,
  bladeburnerTailRate,
  chooseBladeburnerAction,
  maxStaminaOf,
} from "../src/bladeburner-actions.ts";
import { BLADEBURNER_BLACK_OPS, type BladeburnerBlackOp, blackOpSuccessChance } from "../src/bladeburner-black-ops.ts";
import {
  blackOpsInstallTiming,
  bladeburnerAugmentationValues,
  bladeburnerInstallGain,
  bladeburnerPersonAfterInstall,
  bladeburnerRebuildSeconds,
  NO_INSTALL_GAIN,
  trainingExpPerSecond,
} from "../src/bladeburner-installs.ts";
import { blackOpsRouteEstimate } from "../src/bladeburner-route.ts";
import { bladeburnerSkillMultsOf } from "../src/bladeburner-skills.ts";

/** A seeded uniform on [0, 1) (mulberry32): the walk's, the same each run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ESPERTECH = "EsperTech Bladeburner Eyewear";
const GOLEM = "GOLEM Serum";
const INTERLINKED = "I.N.T.E.R.L.I.N.K.E.D";
/** SF1.3's ×1.28 on the combat stats' levels and experience (`SourceFile/applySourceFile.ts:14-48`), as B1's suite. */
const SF1_3 = 1.28;

/** A player as BN6's division takes one: the four combat stats at `combat`, hacking and charisma at 100 and 10. */
function person(combat: number, success = 1): BladeburnerPerson {
  return {
    skills: {
      hacking: 100,
      strength: combat,
      defense: combat,
      dexterity: combat,
      agility: combat,
      charisma: 10,
      intelligence: 0,
    },
    mults: { bladeburner_success_chance: success, bladeburner_max_stamina: 1, bladeburner_stamina_gain: 1 },
  };
}

/** The combat figures of that player: each stat at `combat` from its experience at SF1.3's multipliers. */
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

const CITY = { population: 1e9, communities: 50, chaos: 0 };

/** A reading at `who`: every contract and operation at level 1 of `maxLevel`, the chance the formula's, rested. */
function inputAt(who: BladeburnerPerson, levels: Record<string, number> = {}, maxLevel = 1) {
  const mults = bladeburnerSkillMultsOf(levels);
  const readings: BladeburnerActionReading[] = BLADEBURNER_LEVELLED_ACTIONS.map((action) => {
    const chance = actionSuccessChance(action, 1, who, { city: CITY, penalty: 1, skills: mults });
    return { type: action.type, name: action.name, level: 1, maxLevel, count: 20, chance: [chance, chance] };
  });
  const maxStamina = maxStaminaOf(who, 0, mults);
  return {
    readings,
    person: who,
    stamina: maxStamina,
    maxStamina,
    rankMultiplier: 1,
    speed: 1,
    skills: { read: levels },
  };
}

/** The route at the next Black Op `next` from `rank`, its chance read the formula's at `who`. */
function routeAt(who: BladeburnerPerson, next: BladeburnerBlackOp, rank: number, levels: Record<string, number> = {}) {
  const chance = blackOpSuccessChance(next, who, { penalty: 1, skills: bladeburnerSkillMultsOf(levels) });
  return { rank, next, chanceRead: [chance, chance] as [number, number] };
}

describe("the gain an install gives the route (#404): each multiplier's product, core's augmentation data", () => {
  test("one augmentation's own multipliers; NeuroFlux Governor's levels to their power; a set by product", () => {
    const esper = bladeburnerInstallGain(0, [ESPERTECH]);
    expect(esper.successChance).toBe(1.03);
    expect(esper.levels).toEqual({ strength: 1, defense: 1, dexterity: 1.05, agility: 1 });
    expect(esper.exp).toEqual({ strength: 1, defense: 1, dexterity: 1, agility: 1 });
    expect(esper).toMatchObject({ maxStamina: 1, staminaGain: 1 });
    const neuroFlux = bladeburnerInstallGain(3);
    const level = (AUGMENTATIONS["NeuroFlux Governor"] as { multipliers: Record<string, number> }).multipliers
      .strength as number;
    expect(level).toBe(1.01000262);
    expect(neuroFlux.levels.agility).toBeCloseTo(level ** 3, 12);
    expect(neuroFlux.exp.defense).toBeCloseTo(level ** 3, 12);
    expect(neuroFlux.successChance).toBe(1);
    const set = bladeburnerInstallGain(1, [ESPERTECH, GOLEM, INTERLINKED]);
    expect(set.levels.dexterity).toBeCloseTo(1.05 * 1.07 * level, 12);
    expect(set.levels.strength).toBeCloseTo(1.07 * level, 12);
    expect(set.exp.strength).toBeCloseTo(1.05 * level, 12);
    expect(set.successChance).toBeCloseTo(1.03, 12);
    expect(set.staminaGain).toBeCloseTo(1.05, 12);
    expect(set.maxStamina).toBeCloseTo(1.1, 12);
    expect(() => bladeburnerInstallGain(0, ["No Such Augmentation"])).toThrow(RangeError);
  });

  test("the Bladeburners faction's shop, all 18 at once: ×1.92 on the success chance, its combat levels ×1.17 to ×1.23", () => {
    const shop = augmentationsSoldBy("Bladeburners", 6, null);
    expect(shop).toHaveLength(18);
    expect(shop).toContain("The Blade's Simulacrum");
    const gain = bladeburnerInstallGain(0, shop);
    expect(gain.successChance).toBeCloseTo(1.916, 3);
    expect(gain.levels).toMatchObject({ strength: expect.closeTo(1.168, 3), defense: expect.closeTo(1.227, 3) });
    expect(gain.maxStamina).toBeCloseTo(1.213, 3);
    expect(gain.staminaGain).toBeCloseTo(1.17, 3);
    // The Blade's Simulacrum moves none of the route's (`Augmentations.ts:284-297`: no multipliers).
    expect(bladeburnerInstallGain(0, ["The Blade's Simulacrum"])).toEqual(NO_INSTALL_GAIN);
  });
});

describe("the person after an install, and the rebuild by Training (#404)", () => {
  test("the combat stats at their levels now, hacking and charisma at 1, intelligence kept, Bladeburner's × the gain", () => {
    const who = { ...person(300, 1.1), skills: { ...person(300).skills, intelligence: 50 } };
    const after = bladeburnerPersonAfterInstall(who, bladeburnerInstallGain(0, [ESPERTECH, INTERLINKED]));
    expect(after.skills).toEqual({ ...who.skills, hacking: 1, charisma: 1 });
    expect(after.mults.bladeburner_success_chance).toBeCloseTo(1.1 * 1.03, 12);
    expect(after.mults.bladeburner_max_stamina).toBeCloseTo(1.1, 12);
    expect(after.mults.bladeburner_stamina_gain).toBe(1);
  });

  test("Training: 30 × mult² a stat each 30 s (the upstream quirk); the slowest stat's experience to its level", () => {
    expect(trainingExpPerSecond(SF1_3)).toBeCloseTo(SF1_3 * SF1_3, 12);
    const combat = combatOf(100);
    // From 0 at no gain: level 100's experience at ×1.28 over 1.28² a second, about 55 min.
    const plain = bladeburnerRebuildSeconds(combat, { fromZero: true });
    expect(plain.seconds).toBeCloseTo(skillExpFor(100, SF1_3) / SF1_3 ** 2, 6);
    expect(plain.seconds / 60).toBeCloseTo(55.1, 0);
    // GOLEM's ×1.07 on the levels: less experience to each level; INTERLINKED's ×1.05 on the experience: a faster rate.
    const gain = bladeburnerInstallGain(0, [GOLEM, INTERLINKED]);
    const faster = bladeburnerRebuildSeconds(combat, { gain, fromZero: true });
    expect(faster.seconds).toBeCloseTo(skillExpFor(100, SF1_3 * 1.07) / (SF1_3 * 1.05) ** 2, 6);
    // EsperTech's dexterity alone: the others are the slowest, so the rebuild is theirs.
    const esper = bladeburnerRebuildSeconds(combat, { gain: bladeburnerInstallGain(0, [ESPERTECH]), fromZero: true });
    expect(esper.byStat.dexterity).toBeLessThan(esper.byStat.strength);
    expect(esper.seconds).toBeCloseTo(plain.seconds, 6);
    // Under way (not from 0): what's left of each; at the levels already, 0; a target of 1, none.
    expect(bladeburnerRebuildSeconds(combat, {}).seconds).toBe(0);
    const halfway = { ...combat, exp: { ...combat.exp, agility: combat.exp.agility / 2 } };
    expect(bladeburnerRebuildSeconds(halfway, {}).seconds).toBeCloseTo(plain.seconds / 2, 6);
    expect(
      bladeburnerRebuildSeconds(combat, {
        targets: { strength: 1, defense: 1, dexterity: 1, agility: 1 },
        fromZero: true,
      }).seconds,
    ).toBe(0);
  });
});

describe("the forecast at an install's person (#404): the actions' and Black Ops' chances, times, ρ and stamina there", () => {
  const who = person(300);
  const input = inputAt(who, { "Blade's Intuition": 10 }, 3);

  test("at the person read, the forecast changes nothing", () => {
    const plain = chooseBladeburnerAction(input);
    expect(chooseBladeburnerAction({ ...input, forecast: who })).toEqual(plain);
    expect(bladeburnerTailRate({ ...input, forecast: who })).toBe(bladeburnerTailRate(input));
  });

  test("a success chance ×1.5: the chance ×1.5, the time unchanged; hacking and charisma at 1: by the competence", () => {
    // Tracking alone (charisma's weight 0.1, hacking's 0) at level 1, at combat 100 (unclamped): one work to compare.
    const weak = inputAt(person(100));
    const who = weak.person;
    const tracking = { ...weak, readings: weak.readings.filter((read) => read.name === "Tracking") };
    const reset = bladeburnerPersonAfterInstall(who, NO_INSTALL_GAIN);
    const raised = bladeburnerPersonAfterInstall(who, { ...NO_INSTALL_GAIN, successChance: 1.5 });
    const read = chooseBladeburnerAction(tracking).work;
    const plain = chooseBladeburnerAction({ ...tracking, forecast: reset }).work;
    const more = chooseBladeburnerAction({ ...tracking, forecast: raised }).work;
    expect([read?.name, plain?.name, more?.name]).toEqual(["Tracking", "Tracking", "Tracking"]);
    expect(more?.level).toBe(plain?.level);
    expect(more?.chance as number).toBeLessThan(1);
    expect(more?.chance).toBeCloseTo(1.5 * (plain?.chance as number), 12);
    expect(more?.seconds).toBe(plain?.seconds);
    // Charisma 10 to 1 (its weight 0.1 at its decay): the chance falls by Tracking's competence there.
    const tr = BLADEBURNER_LEVELLED_ACTIONS.find((action) => action.name === "Tracking");
    const competence = (who2: BladeburnerPerson) =>
      Object.entries(tr?.weights ?? {}).reduce(
        (sum, [stat, weight]) =>
          sum + weight * who2.skills[stat as keyof BladeburnerPerson["skills"]] ** (tr?.decays[stat as never] ?? 1),
        0,
      );
    expect(plain?.chance).toBeCloseTo(((read?.chance as number) * competence(reset)) / competence(who), 9);
    // More max stamina: more regain.
    const stamina = bladeburnerPersonAfterInstall(who, { ...NO_INSTALL_GAIN, maxStamina: 2 });
    expect(chooseBladeburnerAction({ ...tracking, forecast: stamina }).regain).toBeGreaterThan(
      chooseBladeburnerAction({ ...tracking, forecast: reset }).regain,
    );
  });

  test("at a stronger person: the times there (agility and dexterity), the actions' and the Black Ops'", () => {
    const stronger = person(600);
    const tracking = BLADEBURNER_LEVELLED_ACTIONS.find((action) => action.name === "Tracking");
    // Tracking alone at level 1 of 1: one work and level to compare, at combat 100 (Tracking at 1 a second's time).
    const weak = inputAt(person(100));
    const only = { ...weak, readings: weak.readings.filter((read) => read.name === "Tracking") };
    const here = chooseBladeburnerAction(only).work;
    const there = chooseBladeburnerAction({ ...only, forecast: stronger }).work;
    expect(tracking).toBeDefined();
    expect([here?.level, there?.level]).toEqual([1, 1]);
    expect(there?.seconds).toBeLessThan(here?.seconds as number);
    const ultron = BLADEBURNER_BLACK_OPS[17] as BladeburnerBlackOp;
    const at = routeAt(who, ultron, 240_000);
    const plain = blackOpsRouteEstimate(input, { ...at, firstToRankSeconds: null });
    const strong = blackOpsRouteEstimate({ ...input, forecast: stronger }, { ...at, firstToRankSeconds: null });
    expect(strong.steps[0]?.seconds).toBeLessThan(plain.steps[0]?.seconds as number);
  });

  test("the Black Ops: the next one's low end read × its formula there over its formula read; the later at the formula", () => {
    const ultron = BLADEBURNER_BLACK_OPS[17] as BladeburnerBlackOp;
    const strong = person(5000);
    const levels = { "Blade's Intuition": 40, Overclock: 50 };
    const mults = bladeburnerSkillMultsOf(levels);
    const at = routeAt(strong, ultron, 240_000, levels);
    const low = 0.8 * (at.chanceRead[0] as number);
    const base = inputAt(strong, levels, 5);
    const after = bladeburnerPersonAfterInstall(strong, { ...NO_INSTALL_GAIN, successChance: 1.1 });
    const route = blackOpsRouteEstimate(
      { ...base, forecast: after },
      { ...at, chanceRead: [low, at.chanceRead[1]], firstToRankSeconds: null },
    );
    const formula = (op: BladeburnerBlackOp, who: BladeburnerPerson) =>
      blackOpSuccessChance(op, who, { penalty: 1, skills: mults });
    expect(route.steps[0]?.chance).toBeCloseTo(
      Math.min(1, (low * formula(ultron, after)) / formula(ultron, strong)),
      12,
    );
    const share = low / formula(ultron, strong);
    route.steps.slice(1).forEach((step, index) => {
      const op = BLADEBURNER_BLACK_OPS[18 + index] as BladeburnerBlackOp;
      expect(step.chance, op.name).toBeCloseTo(Math.min(1, share * formula(op, after)), 12);
    });
    expect(route.rate).toBe(bladeburnerTailRate({ ...base, forecast: after }));
  });
});

describe("the planner's install timing on the route (#404): keep, or install now, by the time to the destroy", () => {
  const who = person(100);
  const combat = combatOf(100);
  const input = inputAt(who);
  const at = routeAt(who, BLADEBURNER_BLACK_OPS[0] as BladeburnerBlackOp, 0);

  test("install now: the rebuild and the route after it, below keeping's: chosen", () => {
    const gain = bladeburnerInstallGain(0, augmentationsSoldBy("Bladeburners", 6, null));
    const timing = blackOpsInstallTiming({ input, at, combat, gain, installable: true });
    expect(timing.rebuildSeconds).toBeCloseTo(bladeburnerRebuildSeconds(combat, { gain, fromZero: true }).seconds, 6);
    expect(timing.installNowSeconds).toBeCloseTo(timing.rebuildSeconds + timing.afterSeconds, 6);
    expect(timing.afterSeconds).toBeLessThan(timing.keepSeconds);
    expect(timing.choice).toBe("install");
    console.log(
      `combat 100, the shop installed: keep ${(timing.keepSeconds / 3600).toFixed(0)} h; install now ` +
        `${(timing.rebuildSeconds / 3600).toFixed(2)} h + ${(timing.afterSeconds / 3600).toFixed(0)} h`,
    );
  });

  test("keep: nothing to install; one that moves none of the route's (its rebuild, hacking and charisma lost); a tie", () => {
    const gain = bladeburnerInstallGain(0, [ESPERTECH]);
    expect(blackOpsInstallTiming({ input, at, combat, gain, installable: false })).toMatchObject({
      installNowSeconds: null,
      choice: "keep",
    });
    const none = blackOpsInstallTiming({ input, at, combat, gain: NO_INSTALL_GAIN, installable: true });
    expect(none.afterSeconds).toBeGreaterThanOrEqual(none.keepSeconds);
    expect(none.choice).toBe("keep");
    // Never either way (a chance of 0 now and after): a tie, kept.
    const hopeless = { ...at, chanceRead: [0, 0] as [number, number] };
    const weak = {
      ...input,
      readings: input.readings.map((read) => ({ ...read, chance: [0, 0] as [number, number] })),
    };
    const tie = blackOpsInstallTiming({ input: weak, at: hopeless, combat, gain, installable: true });
    expect(tie.keepSeconds).toBe(Number.POSITIVE_INFINITY);
    expect(tie.choice).toBe("keep");
  });

  test("the rebuild's cost decides at high levels: at combat 1,000, Training back to it takes longer than the route saves", () => {
    const strong = person(1000);
    const timing = blackOpsInstallTiming({
      input: inputAt(strong),
      at: routeAt(strong, BLADEBURNER_BLACK_OPS[0] as BladeburnerBlackOp, 0),
      combat: combatOf(1000),
      gain: bladeburnerInstallGain(0, augmentationsSoldBy("Bladeburners", 6, null)),
      installable: true,
    });
    expect(timing.afterSeconds).toBeLessThan(timing.keepSeconds);
    expect(timing.rebuildSeconds).toBeGreaterThan(timing.keepSeconds);
    expect(timing.choice).toBe("keep");
  });

  test("each augmentation's value: the route's time saved by it alone, after an install of nothing; 0 for none", () => {
    const values = bladeburnerAugmentationValues({
      input,
      at,
      augmentations: [ESPERTECH, "The Blade's Simulacrum", "Hyperion Plasma Cannon V1"],
    });
    expect(values.map((each) => each.augmentation)).toEqual([
      ESPERTECH,
      "The Blade's Simulacrum",
      "Hyperion Plasma Cannon V1",
    ]);
    expect(values[1]?.savedSeconds).toBe(0);
    expect(values[0]?.savedSeconds).toBeGreaterThan(0);
    // Hyperion's 1.06 on the success chance saves more than EsperTech's 1.03 and 1.05 on dexterity, at the same levels.
    expect(values[2]?.savedSeconds).toBeGreaterThan(values[0]?.savedSeconds as number);
  });
});

describe("the route's estimate with an install, against a seeded walk (#404)", () => {
  test("the rebuild, then the Black Ops left at the install's person: within four standard errors and 1%", () => {
    const strong = person(5000);
    const levels = { "Blade's Intuition": 40, Overclock: 50 };
    const ultron = BLADEBURNER_BLACK_OPS[17] as BladeburnerBlackOp;
    const input = inputAt(strong, levels, 5);
    const at = routeAt(strong, ultron, 240_000, levels);
    const gain = bladeburnerInstallGain(0, ["Hyperion Plasma Cannon V1", ESPERTECH]);
    const combat = combatOf(300);
    const timing = blackOpsInstallTiming({ input, at, combat, gain, installable: true });
    const after = blackOpsRouteEstimate(
      { ...input, forecast: bladeburnerPersonAfterInstall(strong, gain) },
      { ...at, firstToRankSeconds: null },
    );
    expect(timing.afterSeconds).toBe(after.seconds);
    // The walk: the rebuild (Training's, no rank), then the rank at the sustainable rate ρ a second between the Black
    // Ops (its mean, Wald's), each attempt its seconds, a success its gain and a failure its loss, ±10% uniform.
    const random = seeded(404);
    const runs = 20_000;
    const offset = () => 0.9 + 0.2 * random();
    const times: number[] = [];
    for (let run = 0; run < runs; run++) {
      let time = timing.rebuildSeconds;
      let rank = at.rank;
      let next = 0;
      while (next < after.steps.length) {
        const op = after.steps[next] as (typeof after.steps)[number];
        if (rank < op.rank) {
          time += (op.rank - rank) / after.rate;
          rank = op.rank;
        }
        time += op.seconds;
        if (random() < op.chance) {
          rank += op.gain * offset();
          next += 1;
        } else rank = Math.max(0, rank - op.loss * offset());
      }
      times.push(time);
    }
    const mean = times.reduce((a, b) => a + b, 0) / runs;
    const variance = times.reduce((a, b) => a + (b - mean) ** 2, 0) / (runs - 1);
    const standardError = Math.sqrt(variance / runs);
    const estimate = timing.installNowSeconds as number;
    console.log(
      `with an install: ${(estimate / 3600).toFixed(2)} h by the sum (rebuild ${(timing.rebuildSeconds / 3600).toFixed(2)} h); ` +
        `the walk ${(mean / 3600).toFixed(2)} ± ${(standardError / 3600).toFixed(3)} h (${runs} runs), ` +
        `${(((estimate - mean) / mean) * 100).toFixed(2)}%`,
    );
    expect(Math.abs(estimate - mean)).toBeLessThan(4 * standardError);
    expect(Math.abs(estimate - mean) / mean).toBeLessThan(0.01);
  });
});

describe("BN6's playability by the estimate with installs (#404): within ×2 of the slowest destroy so far, or not", () => {
  /** The bar: BN4.1's 27 h 5 min online, the slowest destroy in the campaign report (2026-11-12), twice. */
  const BAR_SECONDS = 2 * (27 * 3600 + 5 * 60);

  test("at B6's BN6.1 states (rank 0, combat 100 and 300, no skills), the whole shop installed: past the bar", () => {
    const shop = bladeburnerInstallGain(0, augmentationsSoldBy("Bladeburners", 6, null));
    // Every augmentation in the game with a multiplier the route reads, all at once: the most installs can bring here.
    const every = bladeburnerInstallGain(
      0,
      Object.keys(AUGMENTATIONS).filter((name) => {
        const { multipliers } = AUGMENTATIONS[name] as { multipliers: Record<string, number> };
        return (
          name !== "NeuroFlux Governor" &&
          [...COMBAT_STATS, "bladeburner_success_chance", "bladeburner_max_stamina", "bladeburner_stamina_gain"].some(
            (key) => (multipliers[key] ?? 1) > 1,
          )
        );
      }),
    );
    for (const combat of [100, 300]) {
      const who = { ...person(combat), skills: { ...person(combat).skills, charisma: 1 } };
      const at = routeAt(who, BLADEBURNER_BLACK_OPS[0] as BladeburnerBlackOp, 0);
      for (const [label, gain] of [
        ["the Bladeburners' shop", shop],
        ["every one", every],
      ] as const) {
        const timing = blackOpsInstallTiming({
          input: inputAt(who),
          at,
          combat: combatOf(combat),
          gain,
          installable: true,
        });
        console.log(
          `combat ${combat}, ${label} installed: ${((timing.installNowSeconds as number) / 3600).toPrecision(4)} h ` +
            `(keep ${(timing.keepSeconds / 3600).toPrecision(4)} h); the bar ${(BAR_SECONDS / 3600).toFixed(1)} h`,
        );
        expect(timing.installNowSeconds as number).toBeGreaterThan(100 * BAR_SECONDS);
      }
    }
  });
});
