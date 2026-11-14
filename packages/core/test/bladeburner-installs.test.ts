// Bladeburner B7 (#404): augmentations and installs on the Black Ops' route. The gain an install gives the route
// against core's augmentation data, the person after it, the rebuild by Training, the forecast at an install's person,
// and the planner's choice (keep or install now) on both sides, now on the route's grown estimate (#408, whose own tests
// have its walk, the choice's bias and BN6's playability: bladeburner-growth.test.ts).
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
import { blackOpsRouteGrownEstimate } from "../src/bladeburner-growth.ts";
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

const ESPERTECH = "EsperTech Bladeburner Eyewear";
/** The grown estimate's BN6 figures (#408): its skill cost 1, no points unspent. */
const GROWTH = { costMultiplier: 1 };
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
    const timing = blackOpsInstallTiming({ input, at, combat, gain, installable: true, growth: GROWTH });
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
    expect(blackOpsInstallTiming({ input, at, combat, gain, installable: false, growth: GROWTH })).toMatchObject({
      installNowSeconds: null,
      choice: "keep",
    });
    const none = blackOpsInstallTiming({ input, at, combat, gain: NO_INSTALL_GAIN, installable: true, growth: GROWTH });
    expect(none.afterSeconds).toBeGreaterThanOrEqual(none.keepSeconds);
    expect(none.choice).toBe("keep");
    // Never either way (a chance of 0 now and after): a tie, kept.
    const hopeless = { ...at, chanceRead: [0, 0] as [number, number] };
    const weak = {
      ...input,
      readings: input.readings.map((read) => ({ ...read, chance: [0, 0] as [number, number] })),
    };
    const tie = blackOpsInstallTiming({ input: weak, at: hopeless, combat, gain, installable: true, growth: GROWTH });
    expect(tie.keepSeconds).toBe(Number.POSITIVE_INFINITY);
    expect(tie.choice).toBe("keep");
  });

  test("mid-rebuild (#407's review): both priced at its targets, keeping finishing it first", () => {
    const gain = bladeburnerInstallGain(0, [ESPERTECH]);
    const weak = person(20);
    const now = combatOf(20);
    const targets = { strength: 100, defense: 100, dexterity: 100, agility: 100 };
    const timing = blackOpsInstallTiming({
      input: inputAt(weak),
      at,
      combat: now,
      gain,
      installable: true,
      levels: targets,
      growth: GROWTH,
    });
    const atTargets = blackOpsInstallTiming({
      input: inputAt(weak),
      at,
      combat: now,
      gain,
      installable: true,
      growth: GROWTH,
    });
    const finish = bladeburnerRebuildSeconds(now, { targets }).seconds;
    // The grown estimate at the targets: the person there, its experience the least for them (#408).
    const route100 = blackOpsRouteGrownEstimate(
      { ...inputAt(weak), forecast: { ...weak, skills: { ...weak.skills, ...targets } } },
      at,
      { combat: combatOf(100), costMultiplier: 1 },
    ).seconds;
    expect(timing.keepSeconds).toBeCloseTo(finish + route100, 3);
    expect(timing.rebuildSeconds).toBeCloseTo(
      bladeburnerRebuildSeconds(now, { targets, gain, fromZero: true }).seconds,
      6,
    );
    // Not at the stats now: keeping there is the route at combat 20.
    expect(atTargets.keepSeconds).toBeGreaterThan(timing.keepSeconds);
  });

  test("the rebuild's cost decides at high levels: at combat 1,000, Training back to it takes longer than the route saves", () => {
    const strong = person(1000);
    const timing = blackOpsInstallTiming({
      input: inputAt(strong),
      at: routeAt(strong, BLADEBURNER_BLACK_OPS[0] as BladeburnerBlackOp, 0),
      combat: combatOf(1000),
      gain: bladeburnerInstallGain(0, augmentationsSoldBy("Bladeburners", 6, null)),
      installable: true,
      growth: GROWTH,
    });
    expect(timing.afterSeconds).toBeLessThan(timing.keepSeconds);
    expect(timing.rebuildSeconds).toBeGreaterThan(timing.keepSeconds);
    expect(timing.choice).toBe("keep");
  });

  test("each augmentation's value: the route's time saved by it alone, after an install of nothing; 0 for none", () => {
    const values = bladeburnerAugmentationValues({
      input,
      at,
      combat,
      growth: GROWTH,
      augmentations: [ESPERTECH, "The Blade's Simulacrum", "Hyperion Plasma Cannon V1"],
    });
    expect(values.map((each) => each.augmentation)).toEqual([
      ESPERTECH,
      "The Blade's Simulacrum",
      "Hyperion Plasma Cannon V1",
    ]);
    // None of the route's multipliers: the same estimate, to the bit.
    expect(values[1]?.savedSeconds).toBe(0);
    // A small one is within the grown estimate's own step (2%, #408's tests): its value is noise there, and the
    // planner's choice is the whole set's against its rebuild (`blackOpsInstallTiming`).
    const nothing = blackOpsRouteGrownEstimate(
      { ...input, forecast: bladeburnerPersonAfterInstall(input.person, NO_INSTALL_GAIN) },
      at,
      { combat, costMultiplier: 1 },
    ).seconds;
    for (const value of values) expect(Math.abs(value.savedSeconds)).toBeLessThan(0.2 * nothing);
    console.log(
      values.map((each) => `${each.augmentation} ${((each.savedSeconds / nothing) * 100).toFixed(1)}%`).join(", "),
    );
  });
});

describe("the route's estimate with an install (#404, #408)", () => {
  test("the rebuild, then the grown estimate at the install's person: its experience from 0 at the gain's multipliers", () => {
    // At combat 300, its combat figures' own (the growth reads the level multipliers times the gain).
    const strong = person(300);
    const levels = { "Blade's Intuition": 40, Overclock: 50 };
    const ultron = BLADEBURNER_BLACK_OPS[17] as BladeburnerBlackOp;
    const input = inputAt(strong, levels, 5);
    const at = routeAt(strong, ultron, 240_000, levels);
    const gain = bladeburnerInstallGain(0, ["Hyperion Plasma Cannon V1", ESPERTECH]);
    const combat = combatOf(300);
    const timing = blackOpsInstallTiming({ input, at, combat, gain, installable: true, growth: GROWTH });
    const after = blackOpsRouteGrownEstimate({ ...input, forecast: bladeburnerPersonAfterInstall(strong, gain) }, at, {
      combat: {
        skills: combat.skills,
        exp: Object.fromEntries(
          COMBAT_STATS.map((stat) => [stat, skillExpFor(300, SF1_3 * gain.levels[stat])]),
        ) as CombatPerson["exp"],
        mults: Object.fromEntries(
          COMBAT_STATS.flatMap((stat) => [
            [stat, SF1_3 * gain.levels[stat]],
            [`${stat}_exp`, SF1_3 * gain.exp[stat]],
          ]),
        ) as CombatPerson["mults"],
      },
      costMultiplier: 1,
    });
    expect(timing.afterSeconds).toBe(after.seconds);
    expect(timing.installNowSeconds).toBe(timing.rebuildSeconds + after.seconds);
  });
});
