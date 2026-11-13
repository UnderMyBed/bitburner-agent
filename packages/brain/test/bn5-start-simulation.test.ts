// BN5 (#323): the brain from a BN5 start with SF1.3 and SF4.3, as the campaign's order enters it from BN4.3, for a
// bounded hour of virtual time, its rules as on Steam (all on), the simulator's own effectors taken away so the Agent
// chooses its backends as in a browser: Singularity, at ×1 RAM with SF4.3 (core's `singularityRamMultiplier`). One
// seed: a thin slice, no sweep, as #321's BN4 suite. It plays BN5 with BN1's rules at BN5's prices and hacking
// multipliers (core's tables: `CloudServerSoftcap` 1.2, `ScriptHackMoney` 0.15, `HackExpGain` 0.5,
// `BitNode.tsx:663-693`); what BN5 sets on the servers (`ServerStartingSecurity` 2, `ServerStartingMoney` 0.5) the
// snapshots read. The first live BN5 run shows what else breaks.
import { bitNodeAssumptions } from "@bitburner-agent/core";
import { expect, test } from "vitest";
import { runReport } from "../src/run-report.ts";
import { EPOCH_MS } from "./helpers/agent-in-simulation.ts";
import { useFreshStarts, withoutSimEffectors } from "./helpers/fresh-start.ts";

const freshStartOf = useFreshStarts();
const RUN_MS = 60 * 60_000;

test("1 virtual hour from BN5.1 with SF1.3 and SF4.3: roots, batches, earns and buys through Singularity; the report passes", async () => {
  const fresh = await freshStartOf({
    withDesiredState: true,
    fixture: { kind: "bitnode", n: 5, sourceFiles: { 1: 3, 4: 3 } },
    beforeAgent: withoutSimEffectors,
  });
  await fresh.game.run(RUN_MS);
  const window = { environment: "E1", sinceMs: EPOCH_MS, untilMs: fresh.game.clock.now() } as const;
  const { text, failures } = runReport(fresh.data.store, window, { verbose: true });
  const lines = text.split("\n");
  const line = (start: string) => lines.find((each) => each.startsWith(start));

  // In BN5.1, with SF1.3 and SF4.3: its progress.
  expect(line("  BitNodes: BN5.1 from ")).toMatch(/, not destroyed, /);
  expect(line("    Source-Files:")).toBe("    Source-Files: SF1.3, SF4.3 (unchanged)");
  const money = /^ {4}money: \$[\d,]+ → \$([\d,]+)$/.exec(line("    money:") ?? "");
  expect(Number(money?.[1]?.replaceAll(",", ""))).toBeGreaterThan(10_000);
  expect(line("    hacking: 1 → ")).toMatch(/^ {4}hacking: 1 → \d{3,}$/);
  // Intelligence in BN5: 1 with no experience (`PersonObjects/Person.ts:159`), then gained (`Person.ts:185`) from the
  // Singularity calls, the TOR router's, home RAM's and the programs' (`NetscriptFunctions/Singularity.ts:416,456,648`):
  // 1 → 4 on 2026-11-11. The report's own line (#349).
  expect(line("    intelligence:")).toMatch(/^ {4}intelligence: 1 → (?!1$)\d+$/);
  expect(line("    home RAM: 32 GB → ")).toMatch(/^ {4}home RAM: 32 GB → (64|128|256|512|1024) GB$/);
  expect(line("    the game's servers rooted:")).toMatch(/^ {4}the game's servers rooted: 0 → \d{2}$/);
  expect(line("    TOR router:")).toBe("    TOR router: no → yes");
  expect(line("    port openers:")).toMatch(/^ {4}port openers: none → BruteSSH\.exe/);
  // The batcher (on by default) batching, its hacks landing.
  expect(text).toMatch(/\n {4}hour 1: preparing, batching on [^;]+; [1-9]\d* batches, [1-9]\d* hack parts landed/);
  // Every action done, through Singularity where it has a backend there: all but the NS API's own, whose worker is
  // `ui` (effectors.ts): the cloud servers' (`ns.cloud`) and, since #387, Netburners' Hacknet setup (`ns.hacknet`,
  // `hacknet-setup.js`). The TOR router, a program and home RAM at least.
  const actions = lines.filter((each) => /^ {4}\w+\(.*\): (done|not done)/.test(each));
  const nsOnly = /^ {4}(buyServer|upgradeServer|buyHacknetSetup)\(/;
  expect(actions.map((each) => [nsOnly.test(each), /\((\w+)\)(;|$)/.exec(each)?.[1]])).toEqual(
    actions.map((each) => [nsOnly.test(each), nsOnly.test(each) ? "ui" : "singularity"]),
  );
  expect(actions.every((each) => / done after /.test(each))).toBe(true);
  expect(line("    upgradeHomeRam(32, ")).toMatch(/: done after 1 try \(singularity\); /);
  expect(line("    buyTor(Alpha Enterprises): ")).toMatch(/: done after 1 try \(singularity\); /);
  expect(line("    buyProgram(BruteSSH.exe): ")).toMatch(/: done after 1 try \(singularity\); /);
  // Nothing taken as BN1's in BN5: core has its prices and its hacking multipliers (#323); cloud servers' prices too.
  expect(bitNodeAssumptions(5)).toEqual([]);
  expect(text).not.toContain("taken as BN1's");
  expect(text).not.toContain("the brain buys none in BitNode");
  // Cloud servers at BN5's prices: 64 GB at BN1's, 128 GB at the softcap's 1.2 (`Server/ServerPurchases.ts:34-41`).
  expect(text).toMatch(/ bought, 64 GB, \$3,520,000\n/);
  expect(text).toMatch(/ bought, 128 GB, \$8,448,000\n/);
  // BN5's ScriptHackMoney folded in: what the batcher's hacks landed (its own count, from each hack's return) is what
  // the slow snapshots' money sources say hacking earned, and the ceilings are BN5's, so hacking sits under them.
  // Measured on 2026-11-09: $1.55b landed, $351,414/s over the 59 min (1.22 times: the batcher's count runs a minute
  // past the last slow snapshot, as the income climbs with the cloud servers bought from minute 47), 18.6% of the
  // batcher ceiling; $122m at the end, after home RAM to 256 GB and 25 cloud servers.
  const landed = Number(/ hack parts landed \(\$(\d+)\)/.exec(text)?.[1]);
  const window5 = /\n {2}over the window: \$([\d,]+)\/s: ([\d.]+)% of the batcher ceiling .*\((\d+\.\d) h\)\n/.exec(
    text,
  );
  const perSecond = Number(window5?.[1]?.replaceAll(",", ""));
  const hours = Number(window5?.[3]);
  expect(landed / (perSecond * hours * 3600)).toBeGreaterThan(0.8);
  expect(landed / (perSecond * hours * 3600)).toBeLessThan(1.3);
  expect(Number(window5?.[2])).toBeGreaterThan(3);
  expect(Number(window5?.[2])).toBeLessThan(100);
  // No stall: income rising, nothing stuck, and a passing verdict.
  expect(text).toContain(
    "  income stalls (money in the medium snapshots not rising for 10 min or more, after it first rose):\n    none",
  );
  expect(text).toContain("  stuck intents (5 tries or more, not done at the last look):\n    none");
  expect(failures).toEqual([]);
  expect(lines.at(-1)).toBe("Verdict: PASS");
  // The World Daemon's destroy, when it comes, would go into BN2 (synthesis §3's row 5), playable since #334.
  expect(fresh.controller().worldDaemonView()).toMatchObject({
    nextBitNode: 2,
    replay: null,
    skipped: null,
    stall: null,
  });
  // About 14 s locally; CI's runners are slower (over 30 s on 2026-11-09), so it gets its own bound.
}, 180_000);
