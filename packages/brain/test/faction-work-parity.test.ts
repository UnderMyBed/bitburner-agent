// Faction work's reputation (#203, core's faction-work.ts) against the game's own, in the simulator:
// `ns.formulas.work.factionGains` (Formulas.exe, bought through the simulator's own effectors) takes any person and
// favour, so the rate is checked for each work type over people and favours that differ in every figure it reads.
// SF15.3's charisma term needs a Source-File the simulator's new game hasn't: core's test works it by hand.
import {
  AGENT_SIM_EFFECTORS_GLOBAL,
  FACTION_WORK_TYPES,
  factionReputationPerCycle,
  type WorkingPerson,
} from "@bitburner-agent/core";
import { runScript, useSimulations } from "@bitburner-agent/sim/test-helpers";
import { expect, test } from "vitest";

const start = useSimulations();

/** A fresh start's player at hacking 55; a fighter; one with every figure moved, intelligence and the multiplier too. */
const PEOPLE: WorkingPerson[] = [
  {
    skills: { hacking: 55, strength: 1, defense: 1, dexterity: 1, agility: 1, charisma: 1, intelligence: 0 },
    mults: { faction_rep: 1 },
  },
  {
    skills: { hacking: 10, strength: 400, defense: 350, dexterity: 300, agility: 250, charisma: 200, intelligence: 0 },
    mults: { faction_rep: 1 },
  },
  {
    skills: { hacking: 812, strength: 40, defense: 50, dexterity: 60, agility: 70, charisma: 80, intelligence: 145 },
    mults: { faction_rep: 1.37 },
  },
];
const FAVOURS = [0, 12.5, 150];

test("core's reputation a cycle matches ns.formulas.work.factionGains, for each work type, person and favour", async () => {
  const sim = await start({ seed: 1, epochMs: Date.UTC(2026, 0, 1), fixture: { kind: "new", tutorial: "skipped" } });
  await sim.diagnostics.setHomeRam(64);
  await sim.diagnostics.setMoney(1e11);
  const { out } = await runScript(
    sim,
    `const effectors = globalThis.${AGENT_SIM_EFFECTORS_GLOBAL};
effectors.buyTorRouter();
effectors.buyDarkwebProgram("Formulas.exe");
const people = ${JSON.stringify(PEOPLE)};
for (const [index, each] of people.entries()) {
  const person = ns.formulas.mockPerson();
  Object.assign(person.skills, each.skills);
  Object.assign(person.mults, each.mults);
  for (const favor of ${JSON.stringify(FAVOURS)}) {
    for (const workType of ${JSON.stringify(FACTION_WORK_TYPES)}) {
      out({ index, favor, workType, reputation: ns.formulas.work.factionGains(person, workType, favor).reputation });
    }
  }
}`,
  );
  const figures = out as {
    index: number;
    favor: number;
    workType: (typeof FACTION_WORK_TYPES)[number];
    reputation: number;
  }[];
  expect(figures).toHaveLength(PEOPLE.length * FAVOURS.length * FACTION_WORK_TYPES.length);
  for (const { index, favor, workType, reputation } of figures) {
    const ours = factionReputationPerCycle(PEOPLE[index] as WorkingPerson, workType, favor, 0);
    expect(ours, `person ${index}, favour ${favor}, ${workType}`).toBeCloseTo(reputation, 14);
    expect(reputation).toBeGreaterThan(0);
  }
  // The best work type differs: hacking for the hacker, security for the fighter (field divides by 5.5, security 4.5).
  const best = (index: number) =>
    figures
      .filter((each) => each.index === index && each.favor === 0)
      .reduce((top, each) => (each.reputation > top.reputation ? each : top)).workType;
  expect([best(0), best(1)]).toEqual(["hacking", "security"]);
});
