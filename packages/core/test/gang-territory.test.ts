// Gangs G4 (#332, of #324): territory warfare's facts checked against the game's source and worked by hand, and the
// rule: territory's worth, a death's cost, the engagement measure, the crew, the plan, and the protocol's order.
// The win chance and the power gain are checked against the engine too (packages/brain's gang-parity.test.ts).
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  GANG_CLASH_CHANCE_FALL_PER_UPDATE,
  GANG_DEATH_CHANCE_LOST,
  GANG_DEATH_CHANCE_WON,
  GANG_DEATH_RESPECT_SHARE,
  GANG_DEATH_ROUND_CHANCE,
  GANG_FACTIONS,
  GANG_OTHER_POWER_KEPT_LOSING,
  GANG_POWER_KEPT_LOSING,
  GANG_POWER_MULTIPLIERS,
  GANG_STATS,
  GANG_TERRITORY_UPDATE_CYCLES,
  type GangMemberFigures,
  type GangOtherGang,
  gangClashesPerUpdate,
  gangClashTailUpdates,
  gangClashWinChance,
  gangDeathChancePerClash,
  gangFreshRecruit,
  gangMemberAscended,
  gangMemberPower,
  gangOtherPowerGainPerUpdate,
  gangOthersAfterUpdate,
  gangOwnPowerLossPerUpdate,
  gangPowerGainPerUpdate,
  gangRecruitsAllowed,
  gangSkillLevel,
  gangTerritoryPerClash,
  gangTerritoryPerUpdate,
  gangWarfareOrderStands,
  parseGangState,
} from "../src/gang.ts";
import {
  GANG_ASCENSION_HORIZON_CAP_MS,
  GANG_TERRITORY_UPDATE_MS,
  GANG_WARFARE_HORIZON_MS,
  type GangRuleInputs,
  type GangWarfareFigures,
  gangAscensionConvertsEnough,
  gangAscensionCost,
  gangAscensionToMake,
  gangDeathCost,
  gangMemberBestOutputOver,
  gangOutputOver,
  gangWarfareBasis,
  gangWarfareCrew,
  gangWarfareMeasure,
  planGang,
} from "../src/gang-rule.ts";

const gameSource = (file: string) =>
  readFileSync(new URL(`../../../vendor/bitburner-src/src/${file}`, import.meta.url), "utf8");

/** The experience that gives `level` with no multipliers: the inverse of `gangSkillLevel`. */
const expFor = (level: number) => Math.max(0, Math.exp((level + 200) / 32) - 534.5);

/** A member with these levels (the others 1), their experience to match, no multipliers, on `task`. */
function member(name: string, levels: Partial<Record<(typeof GANG_STATS)[number], number>> = {}, task = "Unassigned") {
  const figures: Record<string, unknown> = { name, task, earnedRespect: 0 };
  for (const stat of GANG_STATS) {
    const level = levels[stat] ?? 1;
    figures[stat] = level;
    figures[`${stat}_exp`] = expFor(level);
    figures[`${stat}_mult`] = 1;
    figures[`${stat}_asc_mult`] = 1;
    figures[`${stat}_asc_points`] = 0;
  }
  return figures as unknown as GangMemberFigures;
}

/** The six gangs other than NiteSec, each at `power` and 1/7 of the territory. */
const othersAt = (power: number): GangOtherGang[] =>
  GANG_FACTIONS.filter((faction) => faction !== "NiteSec").map((faction) => ({ faction, power, territory: 1 / 7 }));

/** NiteSec's gang with `members`, at `power` against the others at `otherPower`. */
const inputs = (
  members: GangMemberFigures[],
  power: number,
  otherPower: number,
  gang = { respect: 1_000, wantedLevel: 1, territory: 1 / 7 },
): GangRuleInputs => ({
  gang,
  isHacking: true,
  members,
  softcap: 1,
  warfare: { power, engaged: false, clashChance: 0, others: othersAt(otherPower) },
});

/**
 * A hacker who works, and a fighter whose combat levels give power (210 each, `gangMemberPower`) and whose hacking
 * earns nothing: two of them gain 0.9 power an update at 1/7 territory, more than the strongest other gang's expected
 * pace once capped, 0.625 (`gangOtherPowerGainPerUpdate`).
 */
const HACKER = (name: string) => member(name, { hack: 400, cha: 100 });
const FIGHTER = (name: string, def = 5_000) => member(name, { str: 5_000, def, dex: 5_000, agi: 5_000 });

describe("the game's facts (G4)", () => {
  test("power, clashes and deaths are the game's: the source's figures", () => {
    const gang = gameSource("Gang/Gang.ts");
    expect(gameSource("Gang/data/Constants.ts")).toContain(
      `CyclesPerTerritoryAndPowerUpdate: ${GANG_TERRITORY_UPDATE_CYCLES},`,
    );
    expect(gameSource("Gang/GangMember.ts")).toContain(
      "return (this.hack + this.str + this.def + this.dex + this.agi + this.cha) / 95;",
    );
    expect(gang).toContain("return 0.015 * Math.max(0.002, this.getTerritory()) * memberTotal;");
    expect(gang).toContain('if (this.members[i].task !== "Territory Warfare") continue;');
    // The others' growth.
    expect(gang).toContain("const multiplicativeGain = AllGangs[name].power * 0.005;");
    expect(gang).toContain("AllGangs[name].power += Math.min(0.85, multiplicativeGain);");
    expect(gang).toContain("const additiveGain = 0.75 * gainRoll * AllGangs[name].territory * powerMult;");
    const multipliers = [...gameSource("Gang/data/power.ts").matchAll(/\]: (\d+),/g)].map((match) => Number(match[1]));
    expect(GANG_FACTIONS.map((faction) => GANG_POWER_MULTIPLIERS[faction])).toEqual(multipliers);
    // Clashes: the chance, the territory a clash moves, the chance's fall once disengaged.
    expect(gameSource("Gang/AllGangs.ts")).toContain("return thisGangPower / (thisGangPower + otherGangPower);");
    expect(gang).toContain(
      "const powerBonus = Math.max(1, 1 + Math.log(AllGangs[winGang].power / AllGangs[loseGang].power) / Math.log(50));",
    );
    expect(gang).toContain(
      "const gains = Math.min(AllGangs[loseGang].territory, powerBonus * 0.0001 * (Math.random() + 0.5));",
    );
    expect(gang).toContain(
      `this.territoryClashChance = Math.max(0, this.territoryClashChance - ${GANG_CLASH_CHANCE_FALL_PER_UPDATE});`,
    );
    expect(gang).toContain(
      "const gangs = GangConstants.Names.filter((g) => AllGangs[g].territory > 0 || g === gangName);",
    );
    // Deaths: who, how likely, and what they cost.
    expect(gang).toContain(`let baseDeathChance = ${GANG_DEATH_CHANCE_LOST};`);
    expect(gang).toContain("if (won) baseDeathChance /= 2;");
    expect(GANG_DEATH_CHANCE_WON).toBe(GANG_DEATH_CHANCE_LOST / 2);
    expect(gang).toContain(`if (Math.random() < ${1 - GANG_DEATH_ROUND_CHANCE}) return;`);
    expect(gang).toContain('if (member.task !== "Territory Warfare") continue;');
    expect(gang).toContain("const modifiedDeathChance = baseDeathChance / Math.pow(member.def, 0.6);");
    expect(gang).toContain(`const lostRespect = ${GANG_DEATH_RESPECT_SHARE} * totalRespect + member.earnedRespect;`);
    // A recruit (`GangMember.ts:31-66`): levels 1, no experience.
    const recruit = gangFreshRecruit("a");
    expect(GANG_STATS.map((stat) => [recruit[stat], recruit[`${stat}_exp`], recruit[`${stat}_asc_mult`]])).toEqual(
      GANG_STATS.map(() => [1, 0, 1]),
    );
    expect(gangSkillLevel(0, 1)).toBe(1);
  });

  test("a member's power and the gang's gain by hand: levels over 95, × 0.015 × territory (at least 0.002)", () => {
    const even = member("a", { hack: 95, str: 95, def: 95, dex: 95, agi: 95, cha: 95 });
    expect(gangMemberPower(even)).toBeCloseTo(6, 12);
    expect(gangPowerGainPerUpdate(1 / 7, [even])).toBeCloseTo((0.015 / 7) * 6, 15);
    expect(gangPowerGainPerUpdate(0, [even, even])).toBeCloseTo(0.015 * 0.002 * 12, 15);
    expect(gangPowerGainPerUpdate(1 / 7, [])).toBe(0);
    expect(GANG_TERRITORY_UPDATE_MS).toBe(20_000);
  });

  test("the win chance, the territory a clash moves, and the others' expected growth, by hand", () => {
    expect(gangClashWinChance(3, 1)).toBe(0.75);
    expect(gangClashWinChance(0, 0)).toBe(0);
    expect(gangTerritoryPerClash(1, 1)).toBeCloseTo(1e-4, 15);
    expect(gangTerritoryPerClash(50, 1)).toBeCloseTo(2e-4, 15);
    // The weaker winner takes the least, never under it.
    expect(gangTerritoryPerClash(1, 50)).toBeCloseTo(1e-4, 15);
    // Small: 0.5 × 0.005 × 100 + 0.28125 × 1/7 × 1; large, capped: 0.5 × 0.85 + 0.28125 × 0.2 × 5.
    expect(gangOtherPowerGainPerUpdate({ faction: "Slum Snakes", power: 100, territory: 1 / 7 })).toBeCloseTo(
      0.25 + 0.28125 / 7,
      12,
    );
    expect(gangOtherPowerGainPerUpdate({ faction: "Speakers for the Dead", power: 1_000, territory: 0.2 })).toBeCloseTo(
      0.425 + 0.28125,
      12,
    );
  });

  test("clashes an update: 2/(n − 1) with each, n the gangs with territory and the player's", () => {
    expect(gangClashesPerUpdate(othersAt(1))).toBeCloseTo(1 / 3, 15);
    const two = othersAt(1).map((each, index) => (index < 2 ? { ...each, territory: 0 } : each));
    expect(gangClashesPerUpdate(two)).toBeCloseTo(2 / 4, 15);
    expect(gangClashesPerUpdate([])).toBe(0);
  });

  test("the territory expected an update: none at equal power, positive stronger, negative weaker, capped", () => {
    expect(gangTerritoryPerUpdate(1, 1 / 7, othersAt(1))).toBeCloseTo(0, 18);
    // 50 against six at 1: 2 × (50/51 × 0.0002 − 1/51 × 0.0001).
    expect(gangTerritoryPerUpdate(50, 1 / 7, othersAt(1))).toBeCloseTo(2 * ((50 / 51) * 2e-4 - (1 / 51) * 1e-4), 15);
    expect(gangTerritoryPerUpdate(1, 1 / 7, othersAt(50))).toBeCloseTo(2 * ((1 / 51) * 1e-4 - (50 / 51) * 2e-4), 15);
    // A gain capped at the loser's territory; one with none clashes none.
    const tiny = othersAt(1).map((each, index) => ({ ...each, territory: index === 0 ? 5e-5 : 0 }));
    expect(gangTerritoryPerUpdate(50, 1 / 7, tiny)).toBeCloseTo(2 * ((50 / 51) * 5e-5 - (1 / 51) * 1e-4), 15);
    // Nothing to lose: no territory, no loss.
    expect(gangTerritoryPerUpdate(1, 0, othersAt(50))).toBeCloseTo(2 * (1 / 51) * 1e-4, 15);
  });

  test("a Territory Warfare member's death chance a clash: 35% × (0.005 won, 0.01 lost) / def^0.6", () => {
    expect(gangDeathChancePerClash(1, 1)).toBeCloseTo(0.35 * 0.005, 15);
    expect(gangDeathChancePerClash(1, 0)).toBeCloseTo(0.35 * 0.01, 15);
    expect(gangDeathChancePerClash(1_000, 0.5)).toBeCloseTo((0.35 * 0.0075) / 1_000 ** 0.6, 15);
  });
});

describe("the rule (G4)", () => {
  const DAY = GANG_WARFARE_HORIZON_MS / 200;

  test("the horizon is a day, G2's cap", () => {
    expect(GANG_WARFARE_HORIZON_MS).toBe(GANG_ASCENSION_HORIZON_CAP_MS);
    expect(GANG_WARFARE_HORIZON_MS).toBe(24 * 60 * 60_000);
  });

  test("territory's worth: the rise in each member's output over a day per unit of territory; none for nothing earned", () => {
    const given = inputs([HACKER("h"), FIGHTER("f")], 1, 1);
    const basis = gangWarfareBasis(given, "respect");
    const output = gangMemberBestOutputOver(given, HACKER("h"), "respect", DAY);
    expect(basis.output.get("h")).toBeCloseTo(output, 6);
    const more = { ...given, gang: { ...given.gang, territory: 1 / 7 + 0.001 } };
    expect(basis.territoryValue.get("h")).toBeCloseTo(
      (gangMemberBestOutputOver(more, HACKER("h"), "respect", DAY) - output) / 0.001,
      0,
    );
    // The best (PR #333's review): the hacker's ascension is due (its experience converts enough), so its ascended
    // self's day, which a death would destroy as surely as it adds to territory's worth; a member with none due, as it is.
    const ascended = gangOutputOver(given, gangMemberAscended(HACKER("h")), "respect", DAY);
    expect(ascended).toBeGreaterThan(gangOutputOver(given, HACKER("h"), "respect", DAY));
    expect(output).toBeCloseTo(ascended, 6);
    const fresh = member("y", { hack: 60 });
    expect(gangMemberBestOutputOver(given, fresh, "respect", DAY)).toBe(gangOutputOver(given, fresh, "respect", DAY));
    // The death's cost on the same footing: the best less a recruit's, and the respect's.
    expect(basis.deathCost.get("h") ?? 0).toBeGreaterThan(
      output - gangOutputOver(given, gangFreshRecruit("r"), "respect", DAY),
    );
    // The hacker's output grows with territory (every task's factor is at least 1, `formulas.ts:26`).
    expect(basis.territoryValue.get("h")).toBeGreaterThan(0);
    // At full territory there's none more to gain.
    const full = gangWarfareBasis({ ...given, gang: { ...given.gang, territory: 1 } }, "respect");
    expect(full.territoryValue.get("h")).toBe(0);
  });

  test("a death's cost: the respect lost and its toll, plus the member's output over a day less a recruit's", () => {
    const victim = { ...HACKER("h"), earnedRespect: 100 };
    const others = [member("a"), member("b"), member("c"), member("d")];
    const given = inputs([victim, ...others], 1, 1);
    const output = gangOutputOver(given, victim, "respect", DAY);
    const recruit = gangOutputOver(given, gangFreshRecruit("h"), "respect", DAY);
    // 5% of 1,000 and its 100 earned: 150 respect, through G2's cost (the respect, and its toll on the others).
    const lost = gangAscensionCost(given, { ...victim, earnedRespect: 150 }, "respect", DAY);
    expect(lost).toBeGreaterThanOrEqual(150);
    expect(gangRecruitsAllowed(850, 4)).toBeGreaterThan(0);
    expect(gangDeathCost(given, victim, "respect", DAY)).toBeCloseTo(lost + output - recruit, 6);
    // Respect 26 with 5 members: 24.7 left wouldn't recruit the fifth (25), so no replacement: the whole output.
    const short = inputs([{ ...victim, earnedRespect: 0 }, ...others], 1, 1, {
      respect: 26,
      wantedLevel: 1,
      territory: 1 / 7,
    });
    expect(gangRecruitsAllowed(26 - 1.3, 4)).toBe(0);
    const shortLost = gangAscensionCost(short, { ...victim, earnedRespect: 1.3 }, "respect", DAY);
    expect(gangDeathCost(short, { ...victim, earnedRespect: 0 }, "respect", DAY)).toBeCloseTo(
      shortLost + gangOutputOver(short, victim, "respect", DAY),
      6,
    );
  });

  test("the measure: the territory's worth against the deaths' cost; pays stronger with no crew, never weaker", () => {
    const members = [HACKER("h"), FIGHTER("f")];
    const strong = inputs(members, 50, 1);
    const basis = gangWarfareBasis(strong, "respect");
    const none = gangWarfareMeasure(strong, basis, []);
    const value = (basis.territoryValue.get("h") ?? 0) + (basis.territoryValue.get("f") ?? 0);
    expect(none.territoryValue).toBeCloseTo(value, 6);
    expect(none.gainPerUpdate).toBeCloseTo(none.territoryPerUpdate * value, 6);
    expect(none).toMatchObject({ deathsPerUpdate: 0, deathCostPerUpdate: 0, pays: true, leastTerritoryPerUpdate: 0 });
    expect(none.winChances).toEqual({ least: 50 / 51, most: 50 / 51 });
    // Weaker: the clashes lose territory, whatever its worth.
    const weak = inputs(members, 1, 50);
    expect(gangWarfareMeasure(weak, gangWarfareBasis(weak, "respect"), [])).toMatchObject({ pays: false });
    // Equal: none expected, so none engaged.
    const even = inputs(members, 1, 1);
    expect(gangWarfareMeasure(even, gangWarfareBasis(even, "respect"), []).pays).toBe(false);
    // The crew: its worth left out of the territory's, its deaths at def 5,000 by hand, 6 × 1/3 × the chance at 50/51.
    const crewed = gangWarfareMeasure(strong, basis, ["f"]);
    expect(crewed.territoryValue).toBeCloseTo(basis.territoryValue.get("h") ?? 0, 6);
    expect(crewed.deathsPerUpdate).toBeCloseTo(2 * gangDeathChancePerClash(5_000, 50 / 51), 15);
    expect(crewed.deathCostPerUpdate).toBeCloseTo(crewed.deathsPerUpdate * (basis.deathCost.get("f") ?? 0), 6);
    // A disengage's tail, 49.5 updates of clashes at the full rate, its deaths spread over the day's 4,320 updates.
    expect(crewed.tailCostPerUpdate).toBeCloseTo((crewed.deathCostPerUpdate * 49.5) / 4_320, 18);
    // Each death's cost with the tail's share, as the crew's projection counts it.
    expect(crewed.crewDeaths).toEqual([
      { name: "f", perUpdate: crewed.deathsPerUpdate, cost: (basis.deathCost.get("f") ?? 0) * (1 + 49.5 / 4_320) },
    ]);
    expect(crewed.leastTerritoryPerUpdate).toBeCloseTo(
      (crewed.deathCostPerUpdate + crewed.tailCostPerUpdate) / crewed.territoryValue,
      18,
    );
    // The tail counted: a death's cost set so the gain beats the deaths an update by half a percent, under the tail's
    // 49.5 / 4,320 (1.15%) on top: it doesn't pay.
    const deaths = crewed.deathsPerUpdate;
    const close = { ...basis, deathCost: new Map([["f", crewed.gainPerUpdate / deaths / 1.005]]) };
    const tight = gangWarfareMeasure(strong, close, ["f"]);
    expect(tight.gainPerUpdate).toBeGreaterThan(tight.deathCostPerUpdate);
    expect(tight.pays).toBe(false);
    const wide = { ...basis, deathCost: new Map([["f", crewed.gainPerUpdate / deaths / 1.02]]) };
    expect(gangWarfareMeasure(strong, wide, ["f"]).pays).toBe(true);
    // No territory worth (every member on the crew): never pays, its break-even Infinity.
    expect(gangWarfareMeasure(strong, basis, ["h", "f"])).toMatchObject({
      pays: false,
      leastTerritoryPerUpdate: Number.POSITIVE_INFINITY,
    });
  });

  test("never engaged while a death would likely lose more than the clashes gain: a working hacker at def 1 on the crew", () => {
    // Barely stronger (1.2 against six at 1): the clashes gain a little territory. With the hacker on the crew (def 1),
    // its expected deaths an update × its death's cost (its day's output) outweigh what that territory is worth.
    const members = [HACKER("h1"), HACKER("h2")];
    const given = inputs(members, 1.2, 1);
    const basis = gangWarfareBasis(given, "respect");
    const none = gangWarfareMeasure(given, basis, []);
    expect(none.territoryPerUpdate).toBeGreaterThan(0);
    expect(none.pays).toBe(true);
    const crewed = gangWarfareMeasure(given, basis, ["h1"]);
    expect(crewed.territoryPerUpdate).toBe(none.territoryPerUpdate);
    expect(crewed.gainPerUpdate).toBeGreaterThan(0);
    expect(crewed.deathCostPerUpdate).toBeGreaterThan(crewed.gainPerUpdate);
    expect(crewed.pays).toBe(false);
    // The same comparison as a death's cost against the territory's worth in the expected time to one.
    const toDeath = 1 / crewed.deathsPerUpdate;
    expect(crewed.gainPerUpdate * toDeath).toBeLessThan(basis.deathCost.get("h1") ?? 0);
  });

  test("the crew: none against others far stronger; fighters, not the hackers who earn, when their power can tell", () => {
    // An hour's gang: the others grown to 20 against 1, hackers on respect: no crew a day's power could make pay.
    const hour = inputs(["a", "b", "c", "d"].map(HACKER), 1, 20);
    expect(gangWarfareCrew(hour, gangWarfareBasis(hour, "respect"))).toMatchObject({ crew: [], value: 0 });
    // A fighter at 300 can, against others at 1 (PR #333's review, the others' territory projected): the four weak
    // gangs, beaten early, are worth it before the two strong take their territory (`gangOthersAfterUpdate`), the
    // hacker's due ascension making territory worth much; and the fighter earns nothing, so its death costs little.
    const weak = inputs([HACKER("h1"), member("f1", { str: 300, def: 300, dex: 300, agi: 300 })], 1, 1);
    expect(gangWarfareCrew(weak, gangWarfareBasis(weak, "respect")).crew).toEqual(["f1"]);
    // Two hackers and two fighters, all at power 1: the fighters' power for the little they'd earn.
    const members = [HACKER("h1"), HACKER("h2"), FIGHTER("f1"), FIGHTER("f2")];
    const even = inputs(members, 1, 1);
    const basis = gangWarfareBasis(even, "respect");
    expect(gangMemberPower(FIGHTER("f1"))).toBeGreaterThan(gangMemberPower(HACKER("h1")));
    expect(basis.output.get("f1") ?? 0).toBeLessThan((basis.output.get("h1") ?? 0) / 10);
    const crew = gangWarfareCrew(even, basis);
    expect(crew.crew).toEqual(["f1", "f2"]);
    expect(crew.value).toBeGreaterThan(0);
    // Weighed by power for the output forgone: a fighter at 300, which earns as little, comes after the ones at 5,000.
    const mixed = inputs([HACKER("h1"), member("w1", { str: 300, def: 300, dex: 300, agi: 300 }), FIGHTER("f1")], 1, 1);
    expect(gangWarfareCrew(mixed, gangWarfareBasis(mixed, "respect")).crew[0]).toBe("f1");
    // Excluded (the member G2 ascends) or a name the protocol can't carry: never on it.
    expect(gangWarfareCrew(even, basis, new Set(["f1"])).crew).toEqual(["f2"]);
    const long = inputs([...members.slice(0, 3), FIGHTER("x".repeat(65))], 1, 1);
    expect(gangWarfareCrew(long, gangWarfareBasis(long, "respect")).crew).toEqual(["f1"]);
    // A member whose day's output is worth more than its power: a fighter as strong as these who hacks too stays off
    // it, the gang's other member too weak a hacker for territory to be worth its output.
    const hybrid = { ...FIGHTER("x"), hack: 400, hack_exp: expFor(400), cha: 100, cha_exp: expFor(100) };
    const earner = inputs([member("h1", { hack: 100, cha: 50 }), hybrid], 1, 1);
    const earnerBasis = gangWarfareBasis(earner, "respect");
    expect(earnerBasis.output.get("x") ?? 0).toBeGreaterThan(10 * (earnerBasis.output.get("h1") ?? 0));
    expect(gangWarfareCrew(earner, earnerBasis)).toMatchObject({ crew: [], value: 0 });
    // No warfare figures (an older Agent): none.
    const { warfare: _, ...older } = even;
    expect(gangWarfareCrew(older, basis)).toMatchObject({ crew: [], value: 0 });
  });

  test("the plan: the crew on Territory Warfare, engaged by the measure with it; none without the figures", () => {
    const members = [HACKER("h1"), HACKER("h2"), FIGHTER("f1"), FIGHTER("f2")];
    const plan = planGang(inputs(members, 1, 1));
    expect(plan.assignments.filter((each) => each.role === "territory").map((each) => [each.name, each.task])).toEqual([
      ["f1", "Territory Warfare"],
      ["f2", "Territory Warfare"],
    ]);
    // Equal powers: nothing expected yet, so not engaged while the crew builds power.
    expect(plan.warfare).toMatchObject({ crew: ["f1", "f2"], engage: false });
    // Stronger: engaged, the crew's deaths (def 5,000) outweighed.
    const strong = planGang(inputs(members, 50, 1));
    expect(strong.warfare?.engage).toBe(true);
    expect(strong.warfare?.measure.pays).toBe(true);
    expect(strong.warfare?.measure.deathsPerUpdate).toBeGreaterThan(0);
    // A crew building power but not engaged yet, though the clashes would gain: barely stronger (1.05 against six at
    // 1), fighters at defence 1 and the gang's respect 100 million, so a death's 5 million respect outweighs the little
    // territory now; as the crew's power grows, the territory does, which is what the crew is for.
    const exposed = [HACKER("h1"), FIGHTER("f1", 1), FIGHTER("f2", 1)];
    const rich = planGang(inputs(exposed, 1.05, 1, { respect: 1e8, wantedLevel: 1, territory: 1 / 7 }));
    expect(rich.warfare?.crew).toEqual(["f1", "f2"]);
    expect(rich.warfare?.measure.territoryPerUpdate).toBeGreaterThan(0);
    expect(rich.warfare?.measure.deathCostPerUpdate).toBeGreaterThan(rich.warfare?.measure.gainPerUpdate ?? 0);
    expect(rich.warfare?.engage).toBe(false);
    // The same while clashes run (engaged, or a disengage's tail): the crew off Territory Warfare, as it would die for
    // less than the territory's worth; the clashes then pay with no crew, so they stay engaged.
    for (const running of [
      { engaged: true, clashChance: 1 },
      { engaged: false, clashChance: 0.4 },
    ]) {
      const given = inputs(exposed, 1.05, 1, { respect: 1e8, wantedLevel: 1, territory: 1 / 7 });
      const plan = planGang({ ...given, warfare: { ...(given.warfare as GangWarfareFigures), ...running } });
      expect(plan.warfare?.crew, JSON.stringify(running)).toEqual([]);
      expect(plan.assignments.some((each) => each.task === "Territory Warfare")).toBe(false);
      expect(plan.warfare?.engage).toBe(true);
    }
    const { warfare: _, ...older } = inputs(members, 1, 1);
    const none = planGang(older);
    expect(none.warfare).toBeNull();
    expect(none.assignments.some((each) => each.task === "Territory Warfare")).toBe(false);
  });

  test("wanted control comes after, the crew last: kept while the others will do; else on justice, the measure without it", () => {
    const members = [HACKER("h1"), member("t1"), FIGHTER("f1"), FIGHTER("f2")];
    const roles = (wantedLevel: number) => {
      const plan = planGang(inputs(members, 50, 1, { respect: 10, wantedLevel, territory: 1 / 7 }));
      return { plan, roles: plan.assignments.map((each) => [each.name, each.role]) };
    };
    // 90% over the floor, the bound 25%: the one training, then the one working, on course with the crew kept.
    const over = roles(100);
    expect(over.plan.lostShare).toBeGreaterThan(over.plan.bound);
    expect(over.roles).toEqual([
      ["h1", "justice"],
      ["t1", "justice"],
      ["f1", "territory"],
      ["f2", "territory"],
    ]);
    expect(over.plan.warfare?.crew).toEqual(["f1", "f2"]);
    // A million: on course only with every member on justice; no crew left, so no deaths in the measure.
    const far = roles(1e6);
    expect(far.roles.every(([, role]) => role === "justice")).toBe(true);
    expect(far.plan.warfare?.crew).toEqual([]);
    expect(far.plan.warfare?.measure.deathsPerUpdate).toBe(0);
  });

  test("the member G2 ascends is never on the crew", () => {
    // A fighter (combat 1,000) whose hacking converts enough, so G2 ascends it. The plan weighs the crew for the gang
    // after it: there, unexcluded, the ascended fighter, its combat multipliers huge, would be the crew.
    const ready = {
      ...member("x", { str: 1_000, def: 1_000, dex: 1_000, agi: 1_000 }),
      hack: 400,
      hack_exp: expFor(400),
    };
    const given = inputs([ready, HACKER("h1")], 1, 1);
    const plan = planGang(given);
    expect(plan.ascend?.name).toBe("x");
    expect(plan.warfare?.crew).toEqual([]);
    const after = { ...given, members: [{ ...gangMemberAscended(ready), task: ready.task }, HACKER("h1")] };
    expect(gangWarfareCrew(after, gangWarfareBasis(after, "respect")).crew).toEqual(["x"]);
  });

  test("a crew member doesn't ascend while warfare is engaged (G4's review): its power holds as weighed; off, it does", () => {
    const ready = { ...FIGHTER("x"), hack: 400, hack_exp: expFor(400), task: "Territory Warfare" };
    const members = [ready, HACKER("h1")];
    const engaged = inputs(members, 50, 1);
    expect(planGang(engaged).ascend?.name).toBe("x");
    const clashing = { ...engaged, warfare: { ...(engaged.warfare as GangWarfareFigures), engaged: true } };
    expect(gangAscensionToMake(clashing, "respect")?.name).not.toBe("x");
    expect(planGang(clashing).ascend?.name).not.toBe("x");
    // Off Territory Warfare, it ascends as G2 has it, engaged or not.
    const working = { ...clashing, members: [{ ...ready, task: "Train Hacking" }, HACKER("h1")] };
    expect(gangAscensionToMake(working, "respect")?.name).toBe("x");
  });
});

describe("the desired state's warfare order (G4)", () => {
  test("parsed: engage or not, with its break-even; absent or null, none; a bad one refuses the state", () => {
    const base = { recruit: [], tasks: {} };
    expect(parseGangState(base)).toMatchObject({ ok: true, gang: { warfare: null } });
    const warfare = { engage: true, leastTerritoryPerUpdate: 1e-5 };
    expect(parseGangState({ ...base, warfare })).toMatchObject({ ok: true, gang: { warfare } });
    expect(parseGangState({ ...base, warfare: null })).toMatchObject({ ok: true, gang: { warfare: null } });
    for (const bad of [
      { engage: "yes", leastTerritoryPerUpdate: 0 },
      { engage: true },
      { engage: true, leastTerritoryPerUpdate: -1 },
      { engage: true, leastTerritoryPerUpdate: Number.POSITIVE_INFINITY },
      "engage",
    ]) {
      expect(parseGangState({ ...base, warfare: bad }), JSON.stringify(bad)).toMatchObject({ ok: false });
    }
  });

  test("an order stands while the territory expected now is above its break-even; off never stands", () => {
    const order = { engage: true, leastTerritoryPerUpdate: 1e-5 };
    expect(gangWarfareOrderStands(order, 2e-5)).toBe(true);
    expect(gangWarfareOrderStands(order, 1e-5)).toBe(false);
    expect(gangWarfareOrderStands({ engage: true, leastTerritoryPerUpdate: 0 }, 0)).toBe(false);
    expect(gangWarfareOrderStands({ engage: false, leastTerritoryPerUpdate: 0 }, 1)).toBe(false);
  });
});

describe("clashes' power losses and the tail (G4's review)", () => {
  test("the source's: 0.8% of the player's power a lost clash, 1% of another's; the chance falls 0.01 an update", () => {
    const gang = gameSource("Gang/Gang.ts");
    expect(gang).toContain("else AllGangs[this.facName].power *= 1 / 1.008;");
    expect(GANG_POWER_KEPT_LOSING).toBe(1 / 1.008);
    expect(gang).toContain("AllGangs[otherGang].power *= 1 / 1.01;");
    expect(gang).toContain("AllGangs[thisGang].power *= 1 / 1.01;");
    expect(GANG_OTHER_POWER_KEPT_LOSING).toBe(1 / 1.01);
    // From 1: 0.99 + 0.98 + … + 0.01; from 0.5, 0.49 + … + 0.01; none from 0.
    expect(gangClashTailUpdates(1)).toBeCloseTo(49.5, 9);
    expect(gangClashTailUpdates(0.5)).toBeCloseTo(12.25, 9);
    expect(gangClashTailUpdates(0)).toBe(0);
  });

  test("the others after an update, by hand: their gains, then 1% at each clash lost to another of them", () => {
    // Two with territory and four without: n = 3, so one clash an update between the two.
    const others = othersAt(1).map((each, index) => ({
      ...each,
      power: [10, 30][index] ?? 5,
      territory: index < 2 ? 0.4 : 0,
    }));
    const after = gangOthersAfterUpdate(others);
    const grown = others.map((each) => each.power + gangOtherPowerGainPerUpdate(each));
    const [a, b] = grown as [number, number];
    expect(after[0]?.power).toBeCloseTo(a * (1 - (b / (a + b)) * (1 - 1 / 1.01)), 12);
    expect(after[1]?.power).toBeCloseTo(b * (1 - (a / (a + b)) * (1 - 1 / 1.01)), 12);
    // One with no territory clashes none: its gain alone.
    expect(after[2]?.power).toBeCloseTo(grown[2] as number, 12);
  });

  test("so the others level off: from 1 over a day, a few hundred at most, against thousands with no clashes", () => {
    let others = othersAt(1);
    let unchecked = othersAt(1);
    for (let update = 0; update < 4_320; update += 1) {
      others = gangOthersAfterUpdate(others);
      unchecked = unchecked.map((each) => ({ ...each, power: each.power + gangOtherPowerGainPerUpdate(each) }));
    }
    // The ones still with territory, which the clashes are with.
    const most = Math.max(...others.filter((each) => each.territory > 0.001).map((each) => each.power));
    const mostUnchecked = Math.max(...unchecked.map((each) => each.power));
    // Measured on 2026-11-10: the two ×5 gangs (Speakers for the Dead, The Black Hand) at 207 with 42.9% of the
    // territory each, the other four with none left, out of the clashes and growing unchecked (702, 565 ×3); 2,592
    // with no clashes at all.
    console.log(
      `after a day: ${others.map((each) => each.power.toFixed(0)).join(", ")}; unchecked ${mostUnchecked.toFixed(0)}`,
    );
    expect(most).toBeLessThan(1_000);
    expect(mostUnchecked).toBeGreaterThan(2_000);
  });

  test("the gang's own loss an update: 0.8% at each clash expected lost; none winning every one", () => {
    // Equal powers against six: 2 clashes an update, half lost.
    expect(gangOwnPowerLossPerUpdate(1, othersAt(1))).toBeCloseTo(1 - 1 / 1.008, 15);
    expect(gangOwnPowerLossPerUpdate(3, othersAt(1))).toBeCloseTo(2 * 0.25 * (1 - 1 / 1.008), 15);
    expect(gangOwnPowerLossPerUpdate(1, [])).toBe(0);
  });
});

describe("whether it would engage in BN2 (PR #333's review, from the model)", () => {
  /** The others `hours` after the gang forms, each from 1, by their expected pace and clashes with each other. */
  const othersAfterHours = (hours: number) => {
    let others = othersAt(1);
    for (let update = 0; update < hours * 180; update += 1) others = gangOthersAfterUpdate(others);
    return others;
  };
  /** The least power, in steps of 5%, at which the clashes are expected to gain territory against `others`. */
  const breakEven = (others: GangOtherGang[]) => {
    let power = 1;
    while (gangTerritoryPerUpdate(power, 1 / 7, others) <= 0) power *= 1.05;
    return power;
  };

  test("the others: the four weak lose their territory to the two strong within about 9 hours, and drop out", () => {
    // Measured on 2026-11-10 (PR #333's third review: under a clash's least take, none, so a gang drops out): an hour
    // on, 3 to 33 power, the weak at 12.2% to 13.8%; 6 hours on, Slum Snakes at none, the other weak three at 5.5%, the
    // strong at 293; 9 hours on, the weak at none, the strong at 262 with 42.9% each, clashing only each other now and
    // settling at about 207. So the clashes gain territory from a power of 11 an hour on, 22 six hours on, 273 nine
    // hours on and 214 from twelve.
    const at = (hours: number) => othersAfterHours(hours);
    expect(at(6)[0]?.territory).toBe(0);
    expect(at(9).filter((each) => each.territory === 0).length).toBe(4);
    expect(
      at(9)
        .filter((each) => each.territory > 0)
        .map((each) => each.faction),
    ).toEqual(["Speakers for the Dead", "The Black Hand"]);
    expect(breakEven(at(1))).toBeCloseTo(11, -1);
    expect(breakEven(at(6))).toBeCloseTo(22, -1);
    expect(breakEven(at(12))).toBeCloseTo(214, -1);
    expect(at(24)[4]?.power).toBeCloseTo(207, -1);
  });

  /**
   * A member G2 reaches: ascended to a hacking multiplier of ×10 (points 200,000), 3,000 experience since (hacking 614;
   * under the 5,000 G2's ascension needs, so none due), every other level 1 but defence at `def`.
   */
  const grown = (name: string, def = 1): GangMemberFigures => {
    const figures = member(name, { def });
    const hack = 10 * (32 * Math.log(3_000 + 534.5) - 200);
    return { ...figures, hack: Math.floor(hack), hack_exp: 3_000, hack_asc_mult: 10, hack_asc_points: 200_000 };
  };
  const gang = (def: number, others: GangOtherGang[]): GangRuleInputs => ({
    gang: { respect: 1_300, wantedLevel: 1, territory: 1 / 7 },
    isHacking: true,
    members: Array.from({ length: 7 }, (_, index) => grown(`m${index}`, def)),
    softcap: 1,
    warfare: { power: 1, engaged: false, clashChance: 0, others },
  });
  const crewAt = (def: number, others: GangOtherGang[]) => planGang(gang(def, others)).warfare?.crew.length;

  test("seven such hackers at defence 1: none on Territory Warfare, so never engaged; the defence it takes, computed", () => {
    const now = othersAt(1);
    expect(gangAscensionConvertsEnough(grown("m0"), true)).toBe(false);
    expect(grown("m0").hack).toBe(614);
    for (const others of [now, othersAfterHours(1), othersAfterHours(3)]) {
      expect(planGang(gang(1, others)).warfare).toMatchObject({ crew: [], engage: false });
    }
    // With the crew's worth against the output it forgoes too, the defence the first on it needs (measured on
    // 2026-11-10): about 2,000 when the gang forms, 3,000 an hour on, 7,000 three hours on, as the strong gangs grow
    // (defence counts in power too). A hacking gang's training raises none of it: never engaged.
    expect([1_000, 2_000].map((def) => crewAt(def, now))).toEqual([0, 1]);
    const hour = othersAfterHours(1);
    expect([2_000, 3_000].map((def) => crewAt(def, hour))).toEqual([0, 1]);
    const three = othersAfterHours(3);
    expect([5_000, 7_000].map((def) => (crewAt(def, three) ?? 0) > 0)).toEqual([false, true]);
  });
});

describe("rounds 2 and 3 of PR #333's review: the ascension due, crew slots", () => {
  const DAY = GANG_WARFARE_HORIZON_MS / 200;

  test("the best output counts only an ascension G2 would make: none that converts too little", () => {
    // Hacking 75 from 4,900 experience: an ascension the game allows (over 1,000), which would pay over a day, but
    // under the 5,000 G2 waits for: as it is.
    const near = { ...member("y"), hack: 75, hack_exp: 4_900 };
    const given = inputs([near], 1, 1);
    expect(gangAscensionConvertsEnough(near, true)).toBe(false);
    const asIs = gangOutputOver(given, near, "respect", DAY);
    expect(gangOutputOver(given, gangMemberAscended(near), "respect", DAY)).toBeGreaterThan(asIs);
    expect(gangMemberBestOutputOver(given, near, "respect", DAY)).toBe(asIs);
  });

  test("crew slots (PR #333's third review): a slot at defence 1 dies λ × its time on the crew, its recruit rejoining", () => {
    const given = inputs([HACKER("h1"), FIGHTER("f1", 1)], 1, 1);
    const basis = gangWarfareBasis(given, "respect");
    const crew = gangWarfareCrew(given, basis);
    expect(crew.crew).toEqual(["f1"]);
    // About 0.0035 deaths an update engaged (0.35 × 0.005 × 2 clashes, won): more than the one a member has, as each
    // replacement dies too. Measured on 2026-11-10: about 3.7 in the day, as the recruits that take the slot have too
    // little power to keep the clashes paying, so the gang disengages within about 1,000 updates.
    expect(crew.deaths).toBeGreaterThan(2);
    expect(crew.deaths).toBeLessThan(0.0036 * 4_320);
    expect(planGang(given).warfare?.deaths).toBeCloseTo(crew.deaths, 9);
    // A recruit's death: its own rate at defence 1, and its cost, the respect toll, the tail's share in it.
    const measure = gangWarfareMeasure(given, basis, ["f1"]);
    expect(measure.recruitDeath.perUpdate).toBeCloseTo(measure.crewDeaths[0]?.perUpdate ?? 0, 12);
    expect(measure.recruitDeath.cost).toBeCloseTo(basis.recruitDeathCost * (1 + 49.5 / 4_320), 9);
    expect(basis.recruitDeathCost).toBeGreaterThanOrEqual(0.05 * 1_000);
    // The slot's later deaths, each the respect toll: a dearer toll is worth less.
    const dearer = gangWarfareCrew(given, { ...basis, recruitDeathCost: basis.recruitDeathCost * 1_000 });
    expect(dearer.value).toBeLessThan(crew.value);
    // The output forgone, the member's × its time alive: a tenth more of it costs much less than a tenth, as the
    // member at defence 1 is alive a small share of the day.
    const extra = crew.value / 10;
    const output = new Map(basis.output);
    output.set("f1", (output.get("f1") ?? 0) + extra);
    const costlier = gangWarfareCrew(given, { ...basis, output });
    expect(costlier.crew).toEqual(["f1"]);
    expect(crew.value - costlier.value).toBeGreaterThan(0);
    expect(crew.value - costlier.value).toBeLessThan(extra / 2);
  });
});
