// Favour and donations (#225, core's donations.ts) against the game's own, in the simulator: `ns.formulas.reputation`
// (Formulas.exe, bought through the simulator's own effectors) gives favour's worth both ways, and a donation's
// reputation both ways for any person, so each is checked over favours, reputations, amounts and `faction_rep`s.
import {
  AGENT_SIM_EFFECTORS_GLOBAL,
  donationForReputation,
  favorToRep,
  repFromDonation,
  repToFavor,
  reputationToUnlockDonations,
} from "@bitburner-agent/core";
import { runScript, useSimulations } from "@bitburner-agent/sim/test-helpers";
import { expect, test } from "vitest";

const start = useSimulations();

const FAVOURS = [0, 1, 12.5, 99.99, 100, 149, 150, 1000];
const REPUTATIONS = [0, 500, 25_000, 306_374, 462_491, 2.5e6, 1e9];
const AMOUNTS = [1, 1e6, 13_750_010_000, 2.5e12];
const FACTION_REPS = [1, 1.16, 2.5];

test("core's favour and donation formulas match ns.formulas.reputation's, to the last bit", async () => {
  // The reputation that unlocks donations at the next install from each favour, and one less: the game's favour then.
  const unlocks = [0, 100, 149].flatMap((favor) => {
    const reputation = reputationToUnlockDonations(favor, { FavorToDonateToFaction: 1 });
    return [
      { favor, reputation, unlocks: true },
      { favor, reputation: reputation - 1, unlocks: false },
    ];
  });
  const sim = await start({ seed: 1, epochMs: Date.UTC(2026, 0, 1), fixture: { kind: "new", tutorial: "skipped" } });
  await sim.diagnostics.setHomeRam(64);
  await sim.diagnostics.setMoney(1e11);
  const { out } = await runScript(
    sim,
    `const effectors = globalThis.${AGENT_SIM_EFFECTORS_GLOBAL};
effectors.buyTorRouter();
effectors.buyDarkwebProgram("Formulas.exe");
const r = ns.formulas.reputation;
// One line out for all: the script's log keeps only its last 50.
const figures = [];
for (const favor of ${JSON.stringify(FAVOURS)}) figures.push({ kind: "favorToRep", favor, value: r.calculateFavorToRep(favor) });
for (const rep of ${JSON.stringify(REPUTATIONS)}) figures.push({ kind: "repToFavor", rep, value: r.calculateRepToFavor(rep) });
for (const { favor, reputation, unlocks } of ${JSON.stringify(unlocks)}) {
  figures.push({ kind: "afterInstall", favor, unlocks, value: r.calculateRepToFavor(r.calculateFavorToRep(favor) + reputation) });
}
for (const factionRep of ${JSON.stringify(FACTION_REPS)}) {
  const person = ns.formulas.mockPerson();
  person.mults.faction_rep = factionRep;
  for (const amount of ${JSON.stringify(AMOUNTS)}) figures.push({ kind: "repFromDonation", factionRep, amount, value: r.repFromDonation(amount, person) });
  for (const rep of ${JSON.stringify(REPUTATIONS)}) figures.push({ kind: "donationForRep", factionRep, rep, value: r.donationForRep(rep, person) });
}
out(figures);`,
  );
  const figures = out[0] as {
    kind: string;
    favor?: number;
    rep?: number;
    factionRep?: number;
    amount?: number;
    unlocks?: boolean;
    value: number;
  }[];
  expect(figures).toHaveLength(
    FAVOURS.length + REPUTATIONS.length + unlocks.length + FACTION_REPS.length * (AMOUNTS.length + REPUTATIONS.length),
  );
  // The game's favour after the install: 150 or more at core's reputation, under 150 a reputation short of it.
  for (const { favor, unlocks: enough, value } of figures.filter((each) => each.kind === "afterInstall")) {
    if (enough) expect(value, `from ${favor}`).toBeGreaterThanOrEqual(150);
    else expect(value, `from ${favor}`).toBeLessThan(150);
  }
  for (const { kind, favor, rep, factionRep, amount, value } of figures.filter(
    (each) => each.kind !== "afterInstall",
  )) {
    const ours =
      kind === "favorToRep"
        ? favorToRep(favor as number)
        : kind === "repToFavor"
          ? repToFavor(rep as number)
          : kind === "repFromDonation"
            ? repFromDonation(amount as number, factionRep as number, 1)
            : donationForReputation(rep as number, factionRep as number, 1);
    expect(ours, `${kind} ${JSON.stringify({ favor, rep, factionRep, amount })}`).toBe(value);
  }
});
