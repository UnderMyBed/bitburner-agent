// BN4 (#321, owner decision 66): the brain from a BN4 start with SF1.3, as the campaign's order enters it from BN1.4,
// for a bounded hour of virtual time (about 10 s of real time), its rules as on Steam (all on), the simulator's own
// effectors taken away so the Agent chooses its backends as in a browser: Singularity, at ×1 RAM in BN4
// (`Netscript/RamCostGenerator.ts:82-95`), beside the Agent on SF1's 32 GB home. One seed: a thin slice, no sweep. It
// plays BN4 with BN1's rules (core's `bitNodeAssumptions` lists what they take as BN1's); the first live BN4 run shows
// what breaks.
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
  // What it takes as BN1's here: logged, and listed under the BitNode.
  const assumptions = bitNodeAssumptions(4);
  expect(fresh.brain.logLines.filter((each) => each.startsWith("in BitNode 4, taken as BN1's: "))).toEqual(
    assumptions.map((each) => `in BitNode 4, taken as BN1's: ${each}`),
  );
  expect(text).toContain(`    taken as BN1's in BitNode 4 (#321):\n      ${assumptions.join("\n      ")}\n`);
  // No stall: income rising, nothing stuck, and a passing verdict.
  expect(text).toContain(
    "  income stalls (money in the medium snapshots not rising for 10 min or more, after it first rose):\n    none",
  );
  expect(text).toContain("  stuck intents (5 tries or more, not done at the last look):\n    none");
  expect(failures).toEqual([]);
  expect(lines.at(-1)).toBe("Verdict: PASS");
  // The World Daemon's destroy, when it comes, would go into BN4 again (SF4 short of 3).
  expect(fresh.controller().worldDaemonView()).toMatchObject({ nextBitNode: 4, replay: null, stall: null });
});
