// Bladeburner B8 (#411): BN6's and BN7's multipliers against the engine's, and core's route formulas in BN7's own
// engine. Paths are `vendor/bitburner-src/src/`'s (v3.0.1).
// - **Every multiplier** of `getBitNodeMultipliers` at BN6 and BN7 (`BitNode/BitNode.tsx:694-727`, `:728-769`): each is
//   core's (its table's value the engine's), or core takes it at 1 (the engine's 1 in both), or the route doesn't read
//   it, and the table says why. The table is the engine's keys, all of them, so a game bump that adds one fails here.
// - **The simulator's record of attempts** (#411, the hindcasts' expected measure): each chance the one drawn against.
// - **In BN7.2** (SF1.3, SF5.1 and SF7.1, as B2's parity test is in BN6, bladeburner-parity.test.ts): every contract's
//   and operation's estimate's range, time and rank gained and lost over two cities, the stamina and the levels; every
//   Black Op's range, time and rank; every skill's cost (`getSkillUpgradeCost`, ×2) for 1, 3 and 10 levels at 0 and at
//   the levels bought, and the points each `upgradeSkill` takes.
// The augmentations' prices and reputation at BN6's and BN7's multipliers are sim's game-data.test.ts's (every
// augmentation against `getAugCost`, queued one by one).
import {
  actionRankGain,
  actionRankLoss,
  actionSeconds,
  actionSuccessChance,
  actionSuccessRange,
  augmentationBitNodeMultipliers,
  BLACK_OPERATIONS,
  BLADEBURNER_BLACK_OPS,
  BLADEBURNER_LEVELLED_ACTIONS,
  BLADEBURNER_SKILL_NAMES,
  type BladeburnerPerson,
  type BladeburnerSkillLevels,
  bitNodeHackingMultipliers,
  bitNodePriceMultipliers,
  blackOpRankGain,
  blackOpRankLoss,
  blackOpSeconds,
  blackOpSuccessChance,
  bladeburnerBlackOp,
  bladeburnerLevelledAction,
  bladeburnerPersonOf,
  bladeburnerRankMultiplierOf,
  bladeburnerSkill,
  bladeburnerSkillCost,
  bladeburnerSkillCostMultiplierOf,
  bladeburnerSkillMultsOf,
  skillExpFor,
  staminaPenalty,
} from "@bitburner-agent/core";
import { runScript, useSimulations } from "@bitburner-agent/sim/test-helpers";
import { expect, test } from "vitest";

const start = useSimulations();

/** Where a multiplier stands for the route: core's figure for the BitNode, or why the route doesn't read it. */
type Where = { core: (bitNode: number) => number | undefined; is: string } | { why: string };
const augmentations = (name: keyof ReturnType<typeof augmentationBitNodeMultipliers>) => ({
  core: (bitNode: number) => augmentationBitNodeMultipliers(bitNode, {})[name],
  is: "core's `augmentationBitNodeMultipliers`",
});
const hacking = (name: keyof NonNullable<ReturnType<typeof bitNodeHackingMultipliers>>) => ({
  core: (bitNode: number) => bitNodeHackingMultipliers(bitNode)?.[name],
  is: "core's `bitNodeHackingMultipliers`",
});
const prices = (name: keyof NonNullable<ReturnType<typeof bitNodePriceMultipliers>>) => ({
  core: (bitNode: number) => bitNodePriceMultipliers(bitNode)?.[name],
  is: "core's `bitNodePriceMultipliers`",
});
const one = (is: string) => ({ core: () => 1, is: `taken at 1: ${is}` });

/**
 * Every multiplier the engine has (`BitNode/BitNodeMultipliers.ts:8-180`), and where it stands for the Black Ops' route
 * in BN6 and BN7: core's, taken at 1, or not read by the route, and why.
 */
const MULTIPLIERS: Readonly<Record<string, Where>> = {
  // Bladeburner's own: the rank (`Bladeburner/Formulas.ts:13`, `:22`, `:25`; its reputation 2 × the rank gained,
  // `:46-49`, so slower by time, not by rank) and the skills' cost (`Bladeburner/Skill.ts:76-80`, `:122`).
  BladeburnerRank: { core: (bitNode) => bladeburnerRankMultiplierOf(bitNode) ?? undefined, is: "core's rank" },
  BladeburnerSkillCost: {
    core: (bitNode) => bladeburnerSkillCostMultiplierOf(bitNode) ?? undefined,
    is: "core's skill cost",
  },
  // The augmentations' prices and reputation (`Augmentation/AugmentationHelpers.ts:135-136`, `:157-158`): A6's and B7's.
  AugmentationMoneyCost: augmentations("AugmentationMoneyCost"),
  AugmentationRepCost: augmentations("AugmentationRepCost"),
  // The Red Pill's route (`Faction/FactionInfo.tsx:142`, `Server/ServerHelpers.ts:384`): B6's estimate of it.
  DaedalusAugsRequirement: augmentations("DaedalusAugsRequirement"),
  WorldDaemonDifficulty: augmentations("WorldDaemonDifficulty"),
  FactionWorkRepGain: augmentations("FactionWorkRepGain"),
  FavorToDonateToFaction: augmentations("FavorToDonateToFaction"),
  ScriptHackMoney: hacking("ScriptHackMoney"),
  HackExpGain: hacking("HackExpGain"),
  ServerGrowthRate: hacking("ServerGrowthRate"),
  // The hacking level, which the operations' competence weighs (at most 0.25): the snapshot reads it, the multiplier in.
  HackingLevelMultiplier: hacking("HackingLevelMultiplier"),
  HomeComputerRamCost: prices("HomeComputerRamCost"),
  CloudServerCost: prices("CloudServerCost"),
  CloudServerSoftcap: prices("CloudServerSoftcap"),
  CloudServerLimit: prices("CloudServerLimit"),
  CloudServerMaxRam: prices("CloudServerMaxRam"),
  // The combat levels and charisma (`PersonObjects/Person.ts:66-145`): core's levels at the player's `mults.<stat>`.
  StrengthLevelMultiplier: one("core's combat levels (`skillLevelOf`)"),
  DefenseLevelMultiplier: one("core's combat levels (`skillLevelOf`)"),
  DexterityLevelMultiplier: one("core's combat levels (`skillLevelOf`)"),
  AgilityLevelMultiplier: one("core's combat levels (`skillLevelOf`)"),
  CharismaLevelMultiplier: one("read by the snapshot, the contracts' weight 0.1"),
  HackingSpeedMultiplier: one("the hack loop's times (bitnodes.ts)"),
  ServerWeakenRate: one("the hack loop's weakens (bitnodes.ts)"),
  ScriptHackMoneyGain: one("the hack loop's money (bitnodes.ts)"),
  ClassGymExpGain: { why: "never applied in v3.0.1 (core's bladeburner.ts, B1's gym)" },
  CodingContractMoney: {
    why: "money: the route's estimate reads none (B7's shop priced at rank 0, its money left out)",
  },
  CompanyWorkMoney: { why: "money: the route's estimate reads none" },
  CompanyWorkExpGain: { why: "company work, not on the route (one focus, Bladeburner's)" },
  CompanyWorkRepGain: { why: "company work, not on the route" },
  CrimeMoney: { why: "money: the route's estimate reads none" },
  CrimeExpGain: { why: "crime, not on the route" },
  CrimeSuccessRate: { why: "crime, not on the route" },
  HacknetNodeMoney: { why: "money: the route's estimate reads none" },
  InfiltrationMoney: { why: "infiltration, not played" },
  InfiltrationRep: { why: "infiltration, not played" },
  ManualHackMoney: { why: "manual hacking, not played" },
  FactionPassiveRepGain: { why: "the Bladeburners' reputation is the rank's (`Bladeburner/Formulas.ts:46-49`)" },
  FactionWorkExpGain: { why: "faction work, not on the route" },
  ServerMaxMoney: { why: "the servers' money, read by the snapshots (bitnodes.ts)" },
  ServerStartingMoney: { why: "the servers' money, read by the snapshots" },
  ServerStartingSecurity: { why: "the servers' security, read by the snapshots" },
  FourSigmaMarketDataCost: { why: "the stock market, not played" },
  FourSigmaMarketDataApiCost: { why: "the stock market, not played" },
  CorporationValuation: { why: "corporations, not played" },
  CorporationSoftcap: { why: "corporations, not played" },
  CorporationDivisions: { why: "corporations, not played" },
  GangSoftcap: { why: "gangs: not on the route" },
  GangUniqueAugs: { why: "gangs' shops (`Faction/FactionHelpers.tsx:197`): not the Bladeburners'" },
  GoPower: { why: "IPvGO, not played" },
  DarknetMoneyMultiplier: { why: "the darknet, not played" },
  DarknetLabyrinthRewardsTheRedPill: { why: "the darknet, not played" },
  StaneksGiftPowerMultiplier: { why: "Stanek's Gift, left out by #359 (BN13's epic)" },
  StaneksGiftExtraSize: { why: "Stanek's Gift, left out by #359 (BN13's epic)" },
};

test("every BN6 and BN7 multiplier is core's, taken at 1, or not read by the route, and why (#411)", async () => {
  const sim = await start({ seed: 1, epochMs: Date.UTC(2026, 0, 1), fixture: { kind: "new", tutorial: "skipped" } });
  const rows: string[] = [];
  for (const bitNode of [6, 7]) {
    const engine = (await sim.diagnostics.bitNodeMultipliers(bitNode, 1)) as Record<string, number>;
    expect(Object.keys(MULTIPLIERS).sort(), "the table: the engine's every multiplier").toEqual(
      Object.keys(engine).sort(),
    );
    let compared = 0;
    for (const [name, where] of Object.entries(MULTIPLIERS)) {
      if ("core" in where) {
        expect(where.core(bitNode), `BN${bitNode}'s ${name} (${where.is})`).toBe(engine[name]);
        compared++;
      } else expect(where.why.length, name).toBeGreaterThan(0);
    }
    const route = ["BladeburnerRank", "BladeburnerSkillCost", "AugmentationMoneyCost", "AugmentationRepCost"];
    rows.push(
      `BN${bitNode}: ${compared} of ${Object.keys(engine).length} compared; the route's own ` +
        route.map((name) => `${name} ${engine[name]}`).join(", "),
    );
  }
  console.log(rows.join("\n"));
}, 60_000);

const ACTIONS = JSON.stringify(BLADEBURNER_LEVELLED_ACTIONS.map(({ type, name }) => ({ type, name })));
const SKILLS = JSON.stringify(BLADEBURNER_SKILL_NAMES);
/** The levels bought: every skill, Overclock to 89 (one short of its max), and some of each other. */
const LEVELS: BladeburnerSkillLevels = {
  "Blade's Intuition": 4,
  Cloak: 3,
  "Short-Circuit": 2,
  "Digital Observer": 2,
  Tracer: 5,
  Overclock: 89,
  Reaper: 3,
  "Evasive System": 2,
  Datamancer: 1,
  "Cyber's Edge": 4,
  "Hands of Midas": 1,
  Hyperdrive: 1,
};
const CASES = [
  { population: 1e9, estimate: 1.4e9, communities: 20, chaos: 10, share: 1, level: 3 },
  { population: 1.4e9, estimate: 0.9e9, communities: 5, chaos: 75, share: 0.25, level: 5 },
];
/** Each skill's level and its cost for 1, 3 and 10 levels from there (strings: JSON has no Infinity), the points. */
const READ_COSTS = `const read = () => ({
  points: ns.bladeburner.getSkillPoints(),
  levels: Object.fromEntries(${SKILLS}.map((name) => [name, ns.bladeburner.getSkillLevel(name)])),
  costs: Object.fromEntries(${SKILLS}.map((name) => [name, [1, 3, 10].map((count) => String(ns.bladeburner.getSkillUpgradeCost(name, count)))])),
});`;
interface Costs {
  points: number;
  levels: Record<string, number>;
  costs: Record<string, [string, string, string]>;
}
interface Read {
  type: string;
  name: string;
  range: [number, number];
  ms: number;
  gain: number;
  loss: number;
}

test("in BN7's engine: the actions' and Black Ops' success, time and rank, and the skills' costs ×2 (#411)", async () => {
  const sim = await start({
    seed: 1,
    epochMs: Date.UTC(2026, 0, 1),
    fixture: { kind: "bitnode", n: 7, sourceFiles: { 1: 3, 5: 1, 7: 1 } },
  });
  await sim.diagnostics.setHomeRam(128);
  await sim.diagnostics.gainCombatExp(skillExpFor(400, 1.28));
  await sim.diagnostics.gainHackingExp(5_000);
  await sim.diagnostics.gainCharismaExp(3_000);
  await sim.diagnostics.gainIntelligenceExp(20_000);
  const joined = await runScript(sim, "out(ns.bladeburner.joinBladeburnerDivision());");
  expect(joined.out).toEqual([true]);
  // 60,000 rank: 20,000 points, one for each 3 (`Bladeburner.ts:1284-1293`), as in BN6: the levels bought cost twice
  // BN6's (Overclock to 89 alone 11,499).
  await sim.diagnostics.setBladeburnerRank(60_000);
  const rankMultiplier = bladeburnerRankMultiplierOf(7) as number;
  const costMultiplier = bladeburnerSkillCostMultiplierOf(7) as number;
  expect([rankMultiplier, costMultiplier]).toEqual([0.6, 2]);

  // The skills' costs at 0, each bought to its level in one call (its points core's cost), and the costs there.
  const bought = await runScript(
    sim,
    `${READ_COSTS}
const before = read();
const bought = [];
for (const [name, level] of Object.entries(${JSON.stringify(LEVELS)})) {
  const points = ns.bladeburner.getSkillPoints();
  const ok = ns.bladeburner.upgradeSkill(name, level);
  bought.push({ name, level, ok, spent: points - ns.bladeburner.getSkillPoints() });
}
out({ before, bought, after: read() });`,
  );
  expect(bought.log.filter((line) => !line.startsWith("out:") && !line.includes("Upgraded skill"))).toEqual([]);
  const { before, after, ...rest } = bought.out[0] as {
    before: Costs;
    bought: { name: string; level: number; ok: boolean; spent: number }[];
    after: Costs;
  };
  expect(before.points).toBe(20_000);
  let costs = 0;
  for (const [read, label] of [
    [before, "at 0"],
    [after, "at the levels bought"],
  ] as const) {
    for (const name of BLADEBURNER_SKILL_NAMES) {
      const skill = bladeburnerSkill(name);
      if (skill === null) throw new Error(`no ${name}`);
      const level = read.levels[name] as number;
      expect(level, `${name} ${label}`).toBe(label === "at 0" ? 0 : LEVELS[name]);
      [1, 3, 10].forEach((count, index) => {
        const cost = bladeburnerSkillCost(skill, level, count, costMultiplier);
        expect(cost, `${name}'s ${count} from ${level}`).toBe(Number(read.costs[name]?.[index]));
        // Not BN6's: twice its unrounded sum, rounded (`Skill.ts:76-80`).
        if (Number.isFinite(cost)) expect(cost).not.toBe(bladeburnerSkillCost(skill, level, count, 1));
        costs++;
      });
    }
  }
  expect(costs).toBe(72);
  let spent = 0;
  for (const each of rest.bought) {
    const skill = bladeburnerSkill(each.name);
    if (skill === null) throw new Error(`no ${each.name}`);
    expect(each.ok, each.name).toBe(true);
    expect(each.spent, `${each.name}'s points`).toBe(bladeburnerSkillCost(skill, 0, each.level, costMultiplier));
    spent += each.spent;
  }
  expect(after.points).toBe(20_000 - spent);

  // Every contract's, operation's and Black Op's range, time and rank, at the levels bought, over the cases.
  const skills = bladeburnerSkillMultsOf(LEVELS);
  const blackOps = JSON.stringify(BLADEBURNER_BLACK_OPS.map((op) => op.name));
  let ranges = 0;
  let compared = 0;
  for (const each of CASES) {
    const max = (await runScript(sim, "out(ns.bladeburner.getStamina()[1]);")).out[0] as number;
    await sim.diagnostics.setBladeburnerFigures({
      population: each.population,
      estimate: each.estimate,
      communities: each.communities,
      chaos: each.chaos,
      stamina: max * each.share,
      maxLevels: Object.fromEntries(BLADEBURNER_LEVELLED_ACTIONS.map((action) => [action.name, 5])),
    });
    const { out, log } = await runScript(
      sim,
      `const figures = (type, name, level) => ({
  type,
  name,
  range: ns.bladeburner.getActionEstimatedSuccessChance(type, name),
  ms: ns.bladeburner.getActionTime(type, name),
  gain: ns.bladeburner.getActionRankGain(type, name, level),
  loss: ns.bladeburner.getActionRankLoss(type, name, level),
});
const actions = [];
for (const { type, name } of ${ACTIONS}) {
  ns.bladeburner.setActionLevel(type, name, ${each.level});
  actions.push(figures(type, name, ${each.level}));
}
const ops = ${blackOps}.map((name) => figures("${BLACK_OPERATIONS}", name));
out({ person: ns.getPlayer(), stamina: ns.bladeburner.getStamina(), actions, ops });`,
    );
    expect(log.filter((line) => !line.startsWith("out:"))).toEqual([]);
    const figures = out[0] as { person: unknown; stamina: [number, number]; actions: Read[]; ops: Read[] };
    const person = bladeburnerPersonOf(figures.person) as BladeburnerPerson;
    expect(person.mults.bladeburner_success_chance).toBeCloseTo(1.08, 12);
    expect(person.skills.strength).toBe(400);
    const penalty = staminaPenalty(figures.stamina[0], figures.stamina[1]);
    expect(penalty).toBeCloseTo(Math.min(1, 2 * each.share), 9);
    expect(figures.actions).toHaveLength(BLADEBURNER_LEVELLED_ACTIONS.length);
    for (const read of figures.actions) {
      const action = bladeburnerLevelledAction(read.type, read.name);
      if (action === null) throw new Error(`no ${read.name}`);
      const label = `${read.name} at ${JSON.stringify(each)}`;
      const at = (population: number) =>
        actionSuccessChance(action, each.level, person, {
          city: { population, communities: each.communities, chaos: each.chaos },
          penalty,
          skills,
        });
      const range = actionSuccessRange(at(each.population), at(each.estimate), each.population, each.estimate);
      expect(range[0], `${label}: the low end`).toBeCloseTo(read.range[0], 12);
      expect(range[1], `${label}: the high end`).toBeCloseTo(read.range[1], 12);
      expect(actionSeconds(action, each.level, person, skills) * 1000, `${label}: the time`).toBe(read.ms);
      expect(actionRankGain(action, each.level, rankMultiplier), `${label}: the rank`).toBeCloseTo(read.gain, 12);
      expect(actionRankLoss(action, each.level), `${label}: the loss`).toBeCloseTo(read.loss, 12);
      if (read.range[1] > 0 && read.range[0] < 1) ranges++;
      compared++;
    }
    expect(figures.ops).toHaveLength(21);
    for (const read of figures.ops) {
      const op = bladeburnerBlackOp(read.name);
      if (op === null) throw new Error(`no ${read.name}`);
      const label = `${read.name} at ${JSON.stringify(each)}`;
      const real = blackOpSuccessChance(op, person, { penalty, skills });
      const range = actionSuccessRange(real, real, each.population, each.estimate);
      expect(range[0], `${label}: the low end`).toBeCloseTo(read.range[0], 12);
      expect(range[1], `${label}: the high end`).toBeCloseTo(read.range[1], 12);
      expect(blackOpSeconds(op, person, skills) * 1000, `${label}: the time`).toBe(read.ms);
      expect(blackOpRankGain(op, rankMultiplier), `${label}: the rank`).toBeCloseTo(read.gain, 12);
      expect(blackOpRankLoss(op), `${label}: the loss`).toBeCloseTo(read.loss, 12);
      if (read.range[1] > 0 && read.range[0] < 1) ranges++;
      compared++;
    }
  }
  // Not all clamped: some ranges are inside (0, 1) in each case.
  expect(ranges).toBeGreaterThan(CASES.length * 4);
  console.log(
    `BN7.2: ${costs} skill costs ×${costMultiplier} and ${rest.bought.length} purchases (${spent} points); ` +
      `${compared} actions' and Black Ops' ranges, times and ranks at BladeburnerRank ${rankMultiplier}, ` +
      `${ranges} ranges inside (0, 1)`,
  );
}, 240_000);

test("the simulator's record of attempts (#411, the hindcasts' expected measure): each chance the game's, its rank its draw", async () => {
  const sim = await start({
    seed: 1,
    epochMs: Date.UTC(2026, 0, 1),
    fixture: { kind: "bitnode", n: 7, sourceFiles: { 1: 3, 5: 1 } },
  });
  await sim.diagnostics.setHomeRam(128);
  await sim.diagnostics.gainCombatExp(skillExpFor(400, 1.28));
  const joined = await runScript(sim, "out(ns.bladeburner.joinBladeburnerDivision());");
  expect(joined.out).toEqual([true]);
  await sim.diagnostics.setBladeburnerRank(100);
  // The true population its estimate, so the range read is the chance drawn against (`Action.ts:149-150`).
  await sim.diagnostics.setBladeburnerFigures({ population: 1.2e9, estimate: 1.2e9, communities: 20, chaos: 0 });
  const before = (await sim.diagnostics.bladeburnerAttempts()).length;
  // Each tick, the chance read before the attempt that lands in it, until 12 attempts.
  const { out, log } = await runScript(
    sim,
    `const type = "Operations", name = "Undercover Operation";
ns.bladeburner.startAction(type, name);
const reads = [];
let count = ns.bladeburner.getActionCountRemaining(type, name);
while (reads.length < 12) {
  const range = ns.bladeburner.getActionEstimatedSuccessChance(type, name);
  const rank = ns.bladeburner.getRank();
  await ns.bladeburner.nextUpdate();
  const now = ns.bladeburner.getActionCountRemaining(type, name);
  if (now < count) reads.push({ range, rank, after: ns.bladeburner.getRank() });
  count = now;
}
ns.bladeburner.stopBladeburnerAction();
out(reads);`,
    600_000,
  );
  expect(log.filter((line) => !line.startsWith("out:"))).toEqual([]);
  const reads = out[0] as { range: [number, number]; rank: number; after: number }[];
  const attempts = (await sim.diagnostics.bladeburnerAttempts(before)).filter(
    (attempt) => attempt.name === "Undercover Operation",
  );
  expect(attempts.length).toBeGreaterThanOrEqual(12);
  const undercover = bladeburnerLevelledAction("Operations", "Undercover Operation");
  if (undercover === null) throw new Error("no Undercover Operation");
  let successes = 0;
  for (const [index, read] of reads.entries()) {
    const attempt = attempts[index];
    if (attempt === undefined) throw new Error(`no attempt ${index}`);
    // The chance drawn against: the range read at the same state. The first one's a point (the estimate set to the
    // truth); Undercover's success moves the estimate and its failure may migrate the population (`Bladeburner.ts:
    // 814-821`), so later ones bracket it.
    if (index === 0) {
      expect(read.range[0]).toBeCloseTo(read.range[1], 12);
      expect(attempt.chance, "the first attempt's chance").toBeCloseTo(read.range[0], 9);
    }
    expect(attempt.chance, `attempt ${index}'s chance`).toBeGreaterThanOrEqual(read.range[0] - 1e-9);
    expect(attempt.chance, `attempt ${index}'s chance`).toBeLessThanOrEqual(read.range[1] + 1e-9);
    expect(attempt.gain).toBeCloseTo(actionRankGain(undercover, attempt.level, 0.6), 12);
    expect(attempt.loss).toBeCloseTo(actionRankLoss(undercover, attempt.level), 12);
    const change = attempt.rankAfter - attempt.rankBefore;
    // Its rank its draw: a success's gain, a failure's loss, each ±10% (`addOffset`).
    if (attempt.success) {
      successes++;
      expect(change / attempt.gain).toBeGreaterThanOrEqual(0.9 - 1e-9);
      expect(change / attempt.gain).toBeLessThanOrEqual(1.1 + 1e-9);
    } else {
      expect(-change / attempt.loss).toBeGreaterThanOrEqual(0.9 - 1e-9);
      expect(-change / attempt.loss).toBeLessThanOrEqual(1.1 + 1e-9);
    }
    expect(attempt.rankBefore).toBeCloseTo(read.rank, 9);
  }
  // Both draws seen: successes and failures.
  expect(successes).toBeGreaterThan(0);
  expect(successes).toBeLessThan(reads.length);
  console.log(
    `${reads.length} Undercover Operations recorded: ${successes} successes, chances ` +
      attempts
        .slice(0, reads.length)
        .map((attempt) => attempt.chance.toFixed(3))
        .join(", "),
  );
}, 240_000);
