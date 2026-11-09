// BN4 (#321, owner decision 66): the brain from a BN4 start with SF1.3, as the campaign's order enters it from BN1.4,
// for a bounded hour of virtual time (about 10 s of real time), its rules as on Steam (all on), the simulator's own
// effectors taken away so the Agent chooses its backends as in a browser: Singularity, at ×1 RAM in BN4
// (`Netscript/RamCostGenerator.ts:82-95`), beside the Agent on SF1's 32 GB home. One seed: a thin slice, no sweep. It
// plays BN4 with BN1's rules at BN4's prices and hacking multipliers (core's `bitNodePriceMultipliers` and
// `bitNodeHackingMultipliers`); the first live BN4 run shows what else breaks.
import { bitNodeAssumptions } from "@bitburner-agent/core";
import { expect, test } from "vitest";
import { runReport } from "../src/run-report.ts";
import { EPOCH_MS } from "./helpers/agent-in-simulation.ts";
import { useFreshStarts, withoutSimEffectors } from "./helpers/fresh-start.ts";

const freshStartOf = useFreshStarts();
const RUN_MS = 60 * 60_000;

test("1 virtual hour from BN4.1 with SF1.3: roots, batches, earns and buys through Singularity; the report passes", async () => {
  const fresh = await freshStartOf({
    withDesiredState: true,
    fixture: { kind: "bitnode", n: 4, sourceFiles: { 1: 3 } },
    beforeAgent: withoutSimEffectors,
  });
  await fresh.game.run(RUN_MS);
  const window = { environment: "E1", sinceMs: EPOCH_MS, untilMs: fresh.game.clock.now() } as const;
  const { text, failures } = runReport(fresh.data.store, window, { verbose: true });
  const lines = text.split("\n");
  const line = (start: string) => lines.find((each) => each.startsWith(start));

  // In BN4.1, with SF1.3: its progress.
  expect(line("  BitNodes: BN4.1 from ")).toMatch(/, not destroyed, /);
  expect(line("    Source-Files:")).toBe("    Source-Files: SF1.3 (unchanged)");
  const money = /^ {4}money: \$1,262 → \$([\d,]+)$/.exec(line("    money:") ?? "");
  expect(Number(money?.[1]?.replaceAll(",", ""))).toBeGreaterThan(10_000);
  expect(line("    hacking: 1 → ")).toMatch(/^ {4}hacking: 1 → \d{2,}$/);
  expect(line("    the game's servers rooted:")).toMatch(/^ {4}the game's servers rooted: 0 → \d{2}$/);
  expect(line("    TOR router:")).toBe("    TOR router: no → yes");
  expect(line("    port openers:")).toMatch(/^ {4}port openers: none → BruteSSH\.exe/);
  // The batcher (on by default) batching, its hacks landing.
  expect(text).toMatch(/\n {4}hour 1: preparing, batching on \S+; [1-9]\d* batches, [1-9]\d* hack parts landed/);
  // Every action through Singularity, done: the TOR router and a program at least.
  const actions = lines.filter((each) => /^ {4}\w+\(.*\): (done|not done)/.test(each));
  expect(actions.map((each) => /\((\w+)\)(;|$)/.exec(each)?.[1])).toEqual(actions.map(() => "singularity"));
  expect(actions.every((each) => / done after /.test(each))).toBe(true);
  expect(line("    buyTor(Alpha Enterprises): ")).toMatch(/: done after 1 try \(singularity\); /);
  expect(line("    buyProgram(BruteSSH.exe): ")).toMatch(/: done after 1 try \(singularity\); /);
  // Nothing taken as BN1's in BN4: core has its prices and its hacking multipliers (#321's review).
  expect(bitNodeAssumptions(4)).toEqual([]);
  expect(text).not.toContain("taken as BN1's");
  // BN4's ScriptHackMoney folded in: what the batcher's hacks landed (its own count, from each hack's return) is what
  // the slow snapshots' money sources say hacking earned, and the ceilings are BN4's, so hacking sits under them (no
  // "income above the bound" failure) at a share like BN1's on n00dles. Measured on 2026-11-09: $3.72m landed,
  // $993/s over the 59 min, 6.5% of the batcher ceiling; BN1 from the same start, 19.4%. Both batch n00dles all hour:
  // BN1's has 8.9 times BN4's most money (ServerMaxMoney 0.1125 there, BitNode.tsx:635), and the BN4 run's hosts held
  // 524 GB, five times the BN1 run's, so the ceiling on the best target outgrows what n00dles gives.
  const landed = Number(/ hack parts landed \(\$(\d+)\)/.exec(text)?.[1]);
  const window5 = /\n {2}over the window: \$([\d,]+)\/s: ([\d.]+)% of the batcher ceiling .*\((\d+\.\d) h\)\n/.exec(
    text,
  );
  const perSecond = Number(window5?.[1]?.replaceAll(",", ""));
  const hours = Number(window5?.[3]);
  expect(landed / (perSecond * hours * 3600)).toBeGreaterThan(0.8);
  expect(landed / (perSecond * hours * 3600)).toBeLessThan(1.25);
  expect(Number(window5?.[2])).toBeGreaterThan(3);
  expect(Number(window5?.[2])).toBeLessThan(100);
  // No stall: income rising, nothing stuck, and a passing verdict.
  expect(text).toContain(
    "  income stalls (money in the medium snapshots not rising for 10 min or more, after it first rose):\n    none",
  );
  expect(text).toContain("  stuck intents (5 tries or more, not done at the last look):\n    none");
  expect(failures).toEqual([]);
  expect(lines.at(-1)).toBe("Verdict: PASS");
  // The World Daemon's destroy, when it comes, would go into BN4 again (SF4 short of 3).
  expect(fresh.controller().worldDaemonView()).toMatchObject({ nextBitNode: 4, replay: null, stall: null });
  // About 8 s locally; its own bound, as the BN5 suite's, for CI's slower runners.
}, 180_000);
