// The hacking ceiling's formulas (#196, core's hacking-ceiling.ts and hack-loop.ts) against the game's own, in the
// simulator: `ns.formulas.hacking` (Formulas.exe, bought through the simulator's own effectors) takes any server and
// any person, so each is checked over servers and players that differ in every figure it reads, multipliers and
// intelligence included; the security a thread and the scripts' RAM come from the base NS API and the game's own RAM
// calculator. Then the batcher ceiling stands above a whole-thread HWGW batch sized with the game's own grow threads
// (`formulas.hacking.growThreads`), at every share, and the hacking ceiling above that.
import {
  AGENT_SIM_EFFECTORS_GLOBAL,
  batcherIncomePerGigabyteSecond,
  coreBonus,
  GROW_SCRIPT_RAM_GB,
  GROW_SECURITY_PER_THREAD,
  GROW_TIME_PER_HACK_TIME,
  growthLogPerThread,
  HACK_SCRIPT_RAM_GB,
  HACK_SECURITY_PER_THREAD,
  type HackingPlayer,
  hackChance,
  hackingIncomePerGigabyteSecond,
  hackTimeSeconds,
  percentMoneyHackedPerThread,
  WEAKEN_SCRIPT_RAM_GB,
  WEAKEN_SECURITY_PER_THREAD,
  WEAKEN_TIME_PER_HACK_TIME,
} from "@bitburner-agent/core";
import { runScript, useSimulations } from "@bitburner-agent/sim/test-helpers";
import { expect, test } from "vitest";

const start = useSimulations();

/** Servers as BN1 has them at their minimum (n00dles, zer0, phantasy), and one well above it, hard to hack. */
const SERVERS = [
  { moneyMax: 1_750_000, minDifficulty: 1, hackDifficulty: 1, requiredHackingSkill: 1, serverGrowth: 3_000 },
  { moneyMax: 187_500_000, minDifficulty: 10, hackDifficulty: 10, requiredHackingSkill: 75, serverGrowth: 25 },
  { moneyMax: 600_000_000, minDifficulty: 7, hackDifficulty: 7, requiredHackingSkill: 100, serverGrowth: 35 },
  { moneyMax: 50_000_000, minDifficulty: 30, hackDifficulty: 64, requiredHackingSkill: 300, serverGrowth: 50 },
];
/** A fresh start's player at hacking 150, and one with every hacking multiplier moved and some intelligence. */
const PLAYERS: HackingPlayer[] = [
  {
    skills: { hacking: 150, intelligence: 0 },
    mults: { hacking_chance: 1, hacking_speed: 1, hacking_money: 1, hacking_grow: 1 },
  },
  {
    skills: { hacking: 420, intelligence: 120 },
    mults: { hacking_chance: 1.3, hacking_speed: 1.2, hacking_money: 1.4, hacking_grow: 1.6 },
  },
];
const CORES = [1, 4];
/** The shares a batch hacks, from most to least. */
const SHARES = [0.9, 0.5, 0.1, 0.01];

interface GameFigures {
  server: number;
  player: number;
  cores: number;
  chance: number;
  percent: number;
  hackMs: number;
  growMs: number;
  weakenMs: number;
  /** One grow thread's multiplier. */
  growPercent: number;
  weakenEffect: number;
  /** For each share: the hack threads taking it, and the game's grow threads bringing it back. */
  batches: { hackThreads: number; growThreads: number }[];
}

test("core's chance, share, times, growth and weaken match ns.formulas.hacking; security and RAM, the game's", async () => {
  const sim = await start({ seed: 1, epochMs: Date.UTC(2026, 0, 1), fixture: { kind: "new", tutorial: "skipped" } });
  await sim.diagnostics.setHomeRam(64);
  await sim.diagnostics.setMoney(1e11);
  const { out } = await runScript(
    sim,
    `const effectors = globalThis.${AGENT_SIM_EFFECTORS_GLOBAL};
effectors.buyTorRouter();
effectors.buyDarkwebProgram("Formulas.exe");
const formulas = ns.formulas.hacking;
out({ hackSecurity: ns.hackAnalyzeSecurity(1), growSecurity: ns.growthAnalyzeSecurity(1) });
const servers = ${JSON.stringify(SERVERS)};
const players = ${JSON.stringify(PLAYERS)};
const shares = ${JSON.stringify(SHARES)};
for (const [serverIndex, figures] of servers.entries()) {
  const server = { ...ns.formulas.mockServer(), ...figures, hasAdminRights: true, moneyAvailable: figures.moneyMax };
  for (const [playerIndex, each] of players.entries()) {
    const person = ns.formulas.mockPerson();
    Object.assign(person.skills, each.skills);
    Object.assign(person.mults, each.mults);
    for (const cores of ${JSON.stringify(CORES)}) {
      const percent = formulas.hackPercent(server, person);
      const batches = percent <= 0 ? [] : shares.map((share) => {
        const hackThreads = Math.max(1, Math.floor(share / percent));
        const left = { ...server, moneyAvailable: server.moneyMax * (1 - Math.min(1, hackThreads * percent)) };
        return { hackThreads, growThreads: formulas.growThreads(left, person, server.moneyMax, cores) };
      });
      out({
        server: serverIndex,
        player: playerIndex,
        cores,
        chance: formulas.hackChance(server, person),
        percent,
        hackMs: formulas.hackTime(server, person),
        growMs: formulas.growTime(server, person),
        weakenMs: formulas.weakenTime(server, person),
        growPercent: formulas.growPercent(server, 1, person, cores),
        weakenEffect: formulas.weakenEffect(1, cores),
        batches,
      });
    }
  }
}`,
  );
  const [security, ...figures] = out as [{ hackSecurity: number; growSecurity: number }, ...GameFigures[]];
  expect(security).toEqual({ hackSecurity: HACK_SECURITY_PER_THREAD, growSecurity: GROW_SECURITY_PER_THREAD });
  expect(figures).toHaveLength(SERVERS.length * PLAYERS.length * CORES.length);

  for (const game of figures) {
    const server = SERVERS[game.server] as (typeof SERVERS)[number];
    const player = PLAYERS[game.player] as HackingPlayer;
    const label = `server ${game.server}, player ${game.player}, ${game.cores} cores`;
    const close = (ours: number, theirs: number, what: string) =>
      expect(ours, `${what}, ${label}`).toBeCloseTo(
        theirs,
        Math.max(0, 12 - Math.ceil(Math.log10(Math.abs(theirs) + 1))),
      );
    close(hackChance(server, player), game.chance, "chance");
    close(percentMoneyHackedPerThread(server, player), game.percent, "share");
    const hackMs = hackTimeSeconds(server, player) * 1000;
    close(hackMs, game.hackMs, "hack time");
    close(hackMs * GROW_TIME_PER_HACK_TIME, game.growMs, "grow time");
    close(hackMs * WEAKEN_TIME_PER_HACK_TIME, game.weakenMs, "weaken time");
    close(growthLogPerThread(server, player) * coreBonus(game.cores), Math.log(game.growPercent), "growth log");
    close(WEAKEN_SECURITY_PER_THREAD * coreBonus(game.cores), game.weakenEffect, "weaken");

    // At their minimum, the batcher ceiling stands above a whole-thread HWGW batch at every share (its threads all
    // committed, a failed hack's included), as the game sizes its grow; the hacking ceiling above that.
    if (server.hackDifficulty !== server.minDifficulty || !(game.percent > 0) || !(game.chance > 0)) continue;
    const ceiling = batcherIncomePerGigabyteSecond(server, player, game.cores);
    expect(ceiling).toBeLessThanOrEqual(hackingIncomePerGigabyteSecond(server, player, game.cores));
    for (const { hackThreads, growThreads } of game.batches) {
      const taken = Math.min(1, hackThreads * game.percent);
      const security = hackThreads * HACK_SECURITY_PER_THREAD + growThreads * GROW_SECURITY_PER_THREAD;
      const weakenThreads = Math.ceil(security / game.weakenEffect);
      const gigabyteSeconds =
        (hackThreads * HACK_SCRIPT_RAM_GB * game.hackMs +
          growThreads * GROW_SCRIPT_RAM_GB * game.growMs +
          weakenThreads * WEAKEN_SCRIPT_RAM_GB * game.weakenMs) /
        1000;
      const batch = (game.chance * taken * server.moneyMax) / gigabyteSeconds;
      expect(batch, `batch of ${hackThreads} hack threads, ${label}`).toBeLessThanOrEqual(ceiling);
    }
  }

  // A script that only hacks, grows or weakens, by the game's own RAM calculator.
  for (const [operation, ram] of [
    ["hack", HACK_SCRIPT_RAM_GB],
    ["grow", GROW_SCRIPT_RAM_GB],
    ["weaken", WEAKEN_SCRIPT_RAM_GB],
  ] as const) {
    await sim.writeFile(
      "home",
      `${operation}.js`,
      `export async function main(ns) { await ns.${operation}(ns.args[0]); }`,
    );
    expect(await sim.staticRamUsage("home", `${operation}.js`), operation).toBe(ram);
  }
});
