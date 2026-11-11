// Levelling's formulas (#336, core's levelling.ts) against the game's own, in the simulator: `ns.formulas` (Formulas.exe,
// bought through the simulator's own effectors) takes any server and any person. A weaken thread's experience a
// second is `formulas.hacking.hackExp` over `formulas.hacking.weakenTime`; the level from the experience and back,
// `formulas.skills.calculateSkill` and `calculateExp`; each over servers and players that differ in every figure read.
import {
  AGENT_SIM_EFFECTORS_GLOBAL,
  type HackingPlayer,
  hackingExpOfLevel,
  hackingLevelOfExp,
  levellingExpPerThreadSecond,
} from "@bitburner-agent/core";
import { runScript, useSimulations } from "@bitburner-agent/sim/test-helpers";
import { expect, test } from "vitest";

const start = useSimulations();

/** joesguns, n00dles and ecorp at their minimum (BN1's), and joesguns' base difficulty moved. */
const SERVERS = [
  { moneyMax: 6.25e7, minDifficulty: 5, baseDifficulty: 15, requiredHackingSkill: 10, serverGrowth: 20 },
  { moneyMax: 1.75e6, minDifficulty: 1, baseDifficulty: 1, requiredHackingSkill: 1, serverGrowth: 3000 },
  { moneyMax: 1.7e12, minDifficulty: 33, baseDifficulty: 99, requiredHackingSkill: 1100, serverGrowth: 99 },
  { moneyMax: 6.25e7, minDifficulty: 5, baseDifficulty: 40, requiredHackingSkill: 10, serverGrowth: 20 },
];
/** A fresh start's player at hacking 50, and one far on: every multiplier the formulas read moved, intelligence too. */
const PLAYERS: { player: HackingPlayer; hackingExp: number }[] = [
  {
    player: {
      skills: { hacking: 50, intelligence: 0 },
      mults: { hacking_chance: 1, hacking_speed: 1, hacking_money: 1, hacking_grow: 1 },
    },
    hackingExp: 1,
  },
  {
    player: {
      skills: { hacking: 6779, intelligence: 140 },
      mults: { hacking_chance: 3, hacking_speed: 4.465, hacking_money: 20, hacking_grow: 3 },
    },
    hackingExp: 19.06,
  },
];
/** Levels and multipliers for the skill's formula: a fresh start's, BN1's end, BN4.1's (#336). */
const SKILLS = [
  { level: 50, mult: 1 },
  { level: 3000, mult: 6.2 },
  { level: 9000, mult: 11.38 },
];

test("a weaken thread's experience a second, and the level from the experience, match ns.formulas", async () => {
  const sim = await start({ seed: 1, epochMs: Date.UTC(2026, 0, 1), fixture: { kind: "new", tutorial: "skipped" } });
  await sim.diagnostics.setHomeRam(64);
  await sim.diagnostics.setMoney(1e11);
  const { out } = await runScript(
    sim,
    `const effectors = globalThis.${AGENT_SIM_EFFECTORS_GLOBAL};
effectors.buyTorRouter();
effectors.buyDarkwebProgram("Formulas.exe");
const servers = ${JSON.stringify(SERVERS)};
const players = ${JSON.stringify(PLAYERS)};
for (const [serverIndex, figures] of servers.entries()) {
  const server = { ...ns.formulas.mockServer(), ...figures, hackDifficulty: figures.minDifficulty, hasAdminRights: true };
  for (const [playerIndex, each] of players.entries()) {
    const person = ns.formulas.mockPerson();
    Object.assign(person.skills, each.player.skills);
    Object.assign(person.mults, each.player.mults, { hacking_exp: each.hackingExp });
    out({
      server: serverIndex,
      player: playerIndex,
      exp: ns.formulas.hacking.hackExp(server, person),
      weakenMs: ns.formulas.hacking.weakenTime(server, person),
    });
  }
}
for (const { level, mult } of ${JSON.stringify(SKILLS)}) {
  const exp = ns.formulas.skills.calculateExp(level, mult);
  out({ level, mult, exp, skill: ns.formulas.skills.calculateSkill(exp, mult) });
}`,
  );
  const figures = out.slice(0, SERVERS.length * PLAYERS.length) as {
    server: number;
    player: number;
    exp: number;
    weakenMs: number;
  }[];
  for (const game of figures) {
    const server = SERVERS[game.server] as (typeof SERVERS)[number];
    const { player, hackingExp } = PLAYERS[game.player] as (typeof PLAYERS)[number];
    const theirs = game.exp / (game.weakenMs / 1000);
    const ours = levellingExpPerThreadSecond(server, player, hackingExp);
    expect(ours / theirs, `server ${game.server}, player ${game.player}`).toBeCloseTo(1, 12);
  }
  const skills = out.slice(SERVERS.length * PLAYERS.length) as {
    level: number;
    mult: number;
    exp: number;
    skill: number;
  }[];
  expect(skills).toHaveLength(SKILLS.length);
  for (const { level, mult, exp, skill } of skills) {
    expect(skill).toBe(level);
    expect(hackingExpOfLevel(level, mult) / exp, `exp for ${level} at ×${mult}`).toBeCloseTo(1, 12);
    expect(hackingLevelOfExp(exp, mult), `level at ×${mult}`).toBe(level);
  }
});
