// Bladeburner B1 (#367): the facts checked against the pinned game's source, then the experience to 100, the gym chosen
// by money, the training plan and its estimate, worked by hand.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  BLADEBURNER_BITNODES,
  BLADEBURNER_FACTION,
  BLADEBURNER_FACTION_RANK,
  BLADEBURNER_JOIN_LEVEL,
  BLADEBURNER_WORKER_RAM_GB,
  bladeburnerWorkerFits,
  COMBAT_GYM_TYPES,
  COMBAT_STATS,
  type CombatPerson,
  chooseGym,
  combatExpLeft,
  combatPersonOf,
  combatTrained,
  GYM_KEPT_SECONDS,
  gymExpPerSecond,
  parseBladeburnerState,
  planCombatTraining,
  skillExpFor,
  skillLevelOf,
} from "../src/bladeburner.ts";
import { CLASS_LOCATIONS, CLASS_TYPES } from "../src/classes.ts";
import { FACTIONS } from "../src/faction-data.ts";

const gameSource = (file: string) =>
  readFileSync(new URL(`../../../vendor/bitburner-src/src/${file}`, import.meta.url), "utf8");

/** A player with each combat stat at `level` and `exp`, every multiplier `mult` (level) and `expMult`. */
function person(
  levels: Partial<Record<(typeof COMBAT_STATS)[number], number>> = {},
  { mult = 1, expMult = 1, exp = {} as Partial<Record<(typeof COMBAT_STATS)[number], number>> } = {},
): CombatPerson {
  return {
    skills: Object.fromEntries(COMBAT_STATS.map((stat) => [stat, levels[stat] ?? 1])) as CombatPerson["skills"],
    exp: Object.fromEntries(COMBAT_STATS.map((stat) => [stat, exp[stat] ?? 0])) as CombatPerson["exp"],
    mults: Object.fromEntries(
      COMBAT_STATS.flatMap((stat) => [
        [stat, mult],
        [`${stat}_exp`, expMult],
      ]),
    ) as CombatPerson["mults"],
  };
}

describe("the game's facts", () => {
  test("the division: all four combat stats at 100, from BN6, BN7, SF6 or SF7; Bladeburner off in BN8", () => {
    const api = gameSource("NetscriptFunctions/Bladeburner.ts");
    expect(api).toContain("if (!canAccessBitNodeFeature(7) && !canAccessBitNodeFeature(6)) {");
    for (const stat of ["strength", "defense", "dexterity", "agility"]) {
      expect(api).toContain(`Player.skills.${stat} < 100`);
    }
    expect(BLADEBURNER_JOIN_LEVEL).toBe(100);
    expect(COMBAT_STATS).toEqual(["strength", "defense", "dexterity", "agility"]);
    expect(gameSource("BitNode/BitNode.tsx")).toMatch(/case 8: \{[^}]*BladeburnerRank: 0,/);
    expect(BLADEBURNER_BITNODES).toEqual([6, 7]);
  });

  test("the faction: Bladeburners at rank 25, joined only by asking, and offering no work", () => {
    expect(gameSource("Bladeburner/data/Constants.ts")).toContain("RankNeededForFaction: 25,");
    expect(gameSource("Bladeburner/Bladeburner.ts")).toContain(
      "if (this.rank >= BladeburnerConstants.RankNeededForFaction) {",
    );
    expect(BLADEBURNER_FACTION_RANK).toBe(25);
    expect(BLADEBURNER_FACTION).toBe("Bladeburners");
    expect(FACTIONS[BLADEBURNER_FACTION]?.workTypes).toEqual([]);
    const info = gameSource("Faction/FactionInfo.tsx");
    const block = info.slice(info.indexOf("[FactionName.Bladeburners]: new FactionInfo({"));
    expect(block.slice(0, block.indexOf("special: true"))).toMatch(
      /offerHackingWork: false,\s*offerFieldWork: false,\s*offerSecurityWork: false,/,
    );
  });

  test("RAM: inBladeburner free, getRank and both joins 4 GB, so the worker is 1.6 + 4 + 4", () => {
    const ram = gameSource("Netscript/RamCostGenerator.ts");
    const bladeburner = ram.slice(ram.indexOf("const bladeburner = {"), ram.indexOf("const infiltration = {"));
    expect(bladeburner).toContain("  inBladeburner: 0,");
    for (const name of ["getRank", "joinBladeburnerFaction", "joinBladeburnerDivision"]) {
      expect(bladeburner).toContain(`  ${name}: RamCostConstants.BladeburnerApiBase,`);
    }
    expect(ram).toContain("BladeburnerApiBase: 4,");
    expect(ram).toContain("  Base: 1.6,");
    expect(BLADEBURNER_WORKER_RAM_GB).toBe(1.6 + 4 + 4);
  });

  test("a level and its experience are the game's: ⌊m·(32·ln(exp + 534.6) − 200)⌋, its inverse raised past rounding", () => {
    const skill = gameSource("PersonObjects/formulas/skill.ts");
    expect(skill).toContain("const value = Math.floor(mult * (32 * Math.log(exp + 534.6) - 200));");
    expect(skill).toContain("let value = Math.exp((skill / mult + 200) / 32) - 534.6;");
    // The level's multiplier: the player's times the BitNode's, which neither BN6 nor BN7 sets.
    expect(gameSource("PersonObjects/Person.ts")).toContain(
      "this.mults.strength * currentNodeMults.StrengthLevelMultiplier,",
    );
    expect(gameSource("BitNode/BitNode.tsx")).not.toMatch(
      /case 6: \{[^}]*(Strength|Defense|Dexterity|Agility)LevelMultiplier/,
    );
  });

  test("the gyms: each stat 1 experience a cycle at 5 a second, times the gym's expMult, for 120 × costMult a second", () => {
    const classes = gameSource("Work/ClassWork.tsx");
    for (const type of ["strength", "defense", "dexterity", "agility"]) {
      expect(classes).toMatch(new RegExp(`\\[GymType\\.${type}\\]: \\{[^}]*money: -120, \\w+Exp: 1 \\}`));
    }
    const formulas = gameSource("Work/Formulas.ts");
    expect(formulas).toContain("scaleWorkStats(classs.earnings, (location.expMult / gameCPS) * hashMult, false),");
    expect(formulas).toContain("const gameCPS = 1000 / CONSTANTS.MilliPerCycle; // 5 cycles per second");
    for (const stat of COMBAT_STATS) expect(CLASS_TYPES[COMBAT_GYM_TYPES[stat]]?.at).toBe("gym");
    expect(CLASS_LOCATIONS["Powerhouse Gym"]).toEqual({ city: "Sector-12", kind: "gym", costMult: 20, expMult: 10 });
    // The BitNode's ClassGymExpGain is defined but applied nowhere in v3.0.1.
    expect(formulas).not.toContain("ClassGymExpGain");
  });
});

describe("the experience to 100", () => {
  test("at ×1, 11,255.3 experience: e^(300/32) − 534.6; the level the game makes of it is 100, a hair less 99", () => {
    expect(skillExpFor(100, 1)).toBeCloseTo(Math.exp(300 / 32) - 534.6, 6);
    expect(skillExpFor(100, 1)).toBeCloseTo(11_255.32, 2);
    expect(skillLevelOf(skillExpFor(100, 1), 1)).toBe(100);
    expect(skillLevelOf(skillExpFor(100, 1) - 0.01, 1)).toBe(99);
    expect(skillLevelOf(0, 1)).toBe(1);
  });

  test("with multipliers: the level's divides into the exponent, so ×1.5 needs 3,625.7, and SF6.1's ×1.08 8,819.0", () => {
    expect(skillExpFor(100, 1.5)).toBeCloseTo(Math.exp((100 / 1.5 + 200) / 32) - 534.6, 6);
    expect(skillExpFor(100, 1.5)).toBeCloseTo(3_625.66, 2);
    expect(skillExpFor(100, 1.08)).toBeCloseTo(8_819.02, 2);
    for (const mult of [0.7, 1, 1.08, 1.5, 3]) {
      for (const level of [10, 50, 99, 100, 101, 500]) {
        expect(skillLevelOf(skillExpFor(level, mult), mult), `${level} at ×${mult}`).toBe(level);
      }
    }
  });

  test("what's left: each stat's experience to 100 less what it has, 0 at 100 or more", () => {
    const left = combatExpLeft(person({ strength: 100, defense: 50 }, { exp: { strength: 11_300, defense: 3_000 } }));
    expect(left.strength).toBe(0);
    expect(left.defense).toBeCloseTo(11_255.32 - 3_000, 2);
    expect(left.agility).toBeCloseTo(11_255.32, 2);
    // At each stat's own level multiplier: SF1.3's ×1.28 needs 5,417.
    expect(combatExpLeft(person({}, { mult: 1.28 })).dexterity).toBeCloseTo(skillExpFor(100, 1.28), 6);
    expect(skillExpFor(100, 1.28)).toBeCloseTo(5_416.9, 1);
    expect(combatTrained(person({ strength: 100, defense: 100, dexterity: 100, agility: 100 }))).toBe(true);
    expect(combatTrained(person({ strength: 100, defense: 100, dexterity: 100, agility: 99 }))).toBe(false);
  });

  test("combatPersonOf: getPlayer()'s skills, exp and mults; a figure that isn't a number reads none", () => {
    const player = {
      skills: { strength: 5, defense: 6, dexterity: 7, agility: 8, hacking: 100 },
      exp: { strength: 50, defense: 60, dexterity: 70, agility: 80 },
      mults: Object.fromEntries(
        COMBAT_STATS.flatMap((stat) => [
          [stat, 1.1],
          [`${stat}_exp`, 1.2],
        ]),
      ),
      money: 1,
    };
    expect(combatPersonOf(player)).toEqual({
      skills: { strength: 5, defense: 6, dexterity: 7, agility: 8 },
      exp: { strength: 50, defense: 60, dexterity: 70, agility: 80 },
      mults: player.mults,
    });
    expect(combatPersonOf({ ...player, exp: { ...player.exp, agility: "80" } })).toBeNull();
    expect(combatPersonOf({ ...player, mults: {} })).toBeNull();
    expect(combatPersonOf(null)).toBeNull();
  });
});

describe("the gym, by money", () => {
  test("Sector-12: Powerhouse from 10 minutes of its $2,400 a second, $1.44m; under it Iron's, from $72,000; under that none", () => {
    expect(chooseGym({ money: 1_440_000, city: "Sector-12", kept: null })).toBe("Powerhouse Gym");
    expect(chooseGym({ money: 1_439_999, city: "Sector-12", kept: null })).toBe("Iron Gym");
    expect(chooseGym({ money: 72_000, city: "Sector-12", kept: null })).toBe("Iron Gym");
    expect(chooseGym({ money: 71_999, city: "Sector-12", kept: null })).toBeNull();
  });

  test("a gym under way is kept while the money covers a minute of it: Powerhouse to $144,000, Iron to $7,200", () => {
    expect(GYM_KEPT_SECONDS).toBe(60);
    expect(chooseGym({ money: 144_000, city: "Sector-12", kept: "Powerhouse Gym" })).toBe("Powerhouse Gym");
    expect(chooseGym({ money: 143_999, city: "Sector-12", kept: "Powerhouse Gym" })).toBe("Iron Gym");
    expect(chooseGym({ money: 7_200, city: "Sector-12", kept: "Iron Gym" })).toBe("Iron Gym");
    expect(chooseGym({ money: 7_199, city: "Sector-12", kept: "Iron Gym" })).toBeNull();
    // A kept gym never holds back a better one the money covers.
    expect(chooseGym({ money: 2e6, city: "Sector-12", kept: "Iron Gym" })).toBe("Powerhouse Gym");
  });

  test("the player's city only: Aevum's Snap (5 a second) and Crush (2), Volhaven's Millenium (4); none in Chongqing", () => {
    expect(chooseGym({ money: 1e9, city: "Aevum", kept: null })).toBe("Snap Fitness Gym");
    expect(chooseGym({ money: 719_999, city: "Aevum", kept: null })).toBe("Crush Fitness Gym");
    expect(chooseGym({ money: 1e9, city: "Volhaven", kept: null })).toBe("Millenium Fitness Gym");
    for (const city of ["Chongqing", "New Tokyo", "Ishima"])
      expect(chooseGym({ money: 1e9, city, kept: null })).toBeNull();
    // A gym kept from another city (a travel since) isn't kept: it's not where the player is.
    expect(chooseGym({ money: 1e9, city: "Aevum", kept: "Powerhouse Gym" })).toBe("Snap Fitness Gym");
    expect(chooseGym({ money: 1e9, city: "Ishima", kept: "Powerhouse Gym" })).toBeNull();
  });

  test("a gym's experience a second: its expMult times the stat's multiplier", () => {
    const player = person({}, { expMult: 1.25 });
    expect(gymExpPerSecond("Powerhouse Gym", "agility", player)).toBe(12.5);
    expect(gymExpPerSecond("Iron Gym", "strength", player)).toBe(1.25);
    expect(gymExpPerSecond("Rothman University", "strength", player)).toBe(0);
  });
});

describe("the training plan", () => {
  test("from nothing at ×1 at Powerhouse: strength first, all four in 4 × 11,255.3 / 10 s, about 75 minutes", () => {
    const plan = planCombatTraining(person(), { money: 2e6, city: "Sector-12", kept: null });
    expect(plan).toMatchObject({
      stat: "strength",
      gym: "Powerhouse Gym",
      work: { location: "Powerhouse Gym", classType: "str" },
      waitingFor: null,
    });
    expect(plan.etaSeconds).toBeCloseTo((4 * 11_255.32) / 10, 0);
    expect((plan.etaSeconds ?? 0) / 60).toBeCloseTo(75, 0);
  });

  test("the stats in the game's order, each to 100; the estimate each stat's left over its own rate", () => {
    const player = person(
      { strength: 100, defense: 100, dexterity: 40 },
      { exp: { strength: 11_300, defense: 11_300, dexterity: 1_000 } },
    );
    player.mults.agility_exp = 2;
    const plan = planCombatTraining(player, { money: 2e6, city: "Sector-12", kept: null });
    expect(plan.stat).toBe("dexterity");
    expect(plan.work).toEqual({ location: "Powerhouse Gym", classType: "dex" });
    expect(plan.etaSeconds).toBeCloseTo((11_255.32 - 1_000) / 10 + 11_255.32 / 20, 1);
  });

  test("no gym the money covers, or none in the city: no class, the reason said, no estimate", () => {
    const poor = planCombatTraining(person(), { money: 1_000, city: "Sector-12", kept: null });
    expect(poor).toMatchObject({ stat: "strength", gym: null, work: null, etaSeconds: null });
    expect(poor.waitingFor).toBe("money for a gym in Sector-12: 10 minutes of its cost");
    const far = planCombatTraining(person(), { money: 1e9, city: "Chongqing", kept: null });
    expect(far.waitingFor).toBe("a gym: none in Chongqing (the travel is left out)");
  });

  test("trained: no stat, no class, an estimate of 0", () => {
    const trained = person({ strength: 100, defense: 120, dexterity: 100, agility: 100 });
    expect(planCombatTraining(trained, { money: 0, city: "Sector-12", kept: null })).toMatchObject({
      stat: null,
      work: null,
      etaSeconds: 0,
      waitingFor: null,
    });
  });
});

describe("the worker", () => {
  test("its state: null or absent is none; else joinTheFaction true or false, the rest dropped", () => {
    expect(parseBladeburnerState(undefined)).toEqual({ ok: true, bladeburner: null });
    expect(parseBladeburnerState(null)).toEqual({ ok: true, bladeburner: null });
    expect(parseBladeburnerState({ joinTheFaction: true, x: 1 })).toEqual({
      ok: true,
      bladeburner: { joinTheFaction: true },
    });
    expect(parseBladeburnerState({ joinTheFaction: 1 })).toMatchObject({ ok: false });
    expect(parseBladeburnerState("x")).toMatchObject({ ok: false });
  });

  test("it fits home beyond what home keeps: 9.6 GB of room, not less", () => {
    expect(bladeburnerWorkerFits({ homeMaxRamGb: 128, homeKeptGb: 65.9 })).toBe(true);
    expect(bladeburnerWorkerFits({ homeMaxRamGb: 41.6, homeKeptGb: 32 })).toBe(true);
    expect(bladeburnerWorkerFits({ homeMaxRamGb: 41.5, homeKeptGb: 32 })).toBe(false);
    expect(bladeburnerWorkerFits({ homeMaxRamGb: 64, homeKeptGb: 65.9 })).toBe(false);
    expect(bladeburnerWorkerFits({ homeMaxRamGb: 64, homeKeptGb: 32 })).toBe(true);
    // Exactly its 9.6 GB beyond the reserve holds it.
    expect(bladeburnerWorkerFits({ homeMaxRamGb: 10, homeKeptGb: 0.4 })).toBe(true);
    expect(bladeburnerWorkerFits({ homeMaxRamGb: 10, homeKeptGb: 0.5 })).toBe(false);
  });
});
