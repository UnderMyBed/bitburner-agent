// The run report (#185) over a real run's store: an 8 GB fresh start in the simulator, the brain and the Agent as on
// Steam, for a bounded stretch of virtual time. The report reads what they recorded, as it would after a live run.
import { expect, test } from "vitest";
import { runReport } from "../src/run-report.ts";
import { EPOCH_MS } from "./helpers/agent-in-simulation.ts";
import { useFreshStarts } from "./helpers/fresh-start.ts";

const freshStartOf = useFreshStarts();
/** Long enough for the hack loop to pay for TOR, two programs and two home RAM upgrades (about 4 s of real time). */
const RUN_MS = 20 * 60_000;

test("20 virtual minutes from a fresh start: the hack loop's progress, its purchases, and PASS", async () => {
  const fresh = await freshStartOf({ withDesiredState: true });
  await fresh.game.run(RUN_MS);
  // The simulator's brain records no brainStarted (main.ts does): the window starts at the game's epoch.
  const { text, failures } = runReport(fresh.data.store, {
    environment: "E1",
    sinceMs: EPOCH_MS,
    untilMs: fresh.game.clock.now(),
  });
  const lines = text.split("\n");
  const line = (start: string) => lines.find((each) => each.startsWith(start));

  // The window: the deploy and the Agent's session.
  expect(line("  brain starts:")).toBe(
    "  brain starts: 0; Agent connections: 1, disconnections: 0; relaunches: 0; deploys: 1; save backups: 1",
  );
  // Progress, under its one BitNode (#244): money and hacking up, TOR, programs and home RAM bought, servers rooted,
  // n00dles worked.
  expect(line("  BitNodes: BN1.1 from ")).toMatch(/, not destroyed, \d+ min( \d+ s)? by the window's last record$/);
  expect(line("  BN1.1, first snapshot → last:")).toBeDefined();
  expect(line("    money: $1,262 → $")).toBeDefined();
  expect(line("    hacking: 1 → ")).toMatch(/^ {4}hacking: 1 → \d{2,}$/);
  expect(line("    TOR router:")).toBe("    TOR router: no → yes");
  expect(line("    port openers:")).toMatch(/^ {4}port openers: none → BruteSSH\.exe/);
  expect(line("    home RAM:")).toMatch(/^ {4}home RAM: 8 GB → (16|32|64) GB$/);
  expect(line("    the game's servers rooted:")).toMatch(/^ {4}the game's servers rooted: 0 → \d{2}$/);
  // Its one cycle (#244): the fresh start's, not ended.
  expect(line("    cycle 1 from ")).toMatch(/, not ended in the window$/);
  expect(line("      held back by: ")).toBeDefined();
  expect(line("    n00dles: ")).toBeDefined();
  // The purchases, counted by action (#245), each done on its first try through the simulator's own effectors (its
  // line, with --verbose).
  expect(line("  intents: ")).toMatch(/^ {2}intents: \d+, by action and outcome \(--verbose lists each\):$/);
  expect(line("    buyTor: ")).toBe("    buyTor: 1 done");
  expect(line("    buyProgram: ")).toMatch(/^ {4}buyProgram: \d+ done$/);
  expect(line("    upgradeHomeRam: ")).toMatch(/^ {4}upgradeHomeRam: \d+ done$/);
  const verbose = runReport(
    fresh.data.store,
    { environment: "E1", sinceMs: EPOCH_MS, untilMs: fresh.game.clock.now() },
    { verbose: true },
  );
  const verboseLines = verbose.text.split("\n");
  for (const id of ["buyTor(Alpha Enterprises)", "buyProgram(BruteSSH.exe)", "upgradeHomeRam(8, Alpha Enterprises)"]) {
    expect(verboseLines.find((each) => each.startsWith(`    ${id}: `))).toMatch(/: done after 1 try \(sim\); done by /);
  }
  expect(verbose.failures).toEqual(failures);
  // Health: a steady heartbeat, money rising, nothing stuck.
  expect(text).toContain("    longest interval 2.0 s\n    no gaps");
  expect(text).toContain(
    "  income stalls (money in the medium snapshots not rising for 10 min or more, after it first rose):\n    none",
  );
  expect(failures).toEqual([]);
  expect(lines.at(-1)).toBe("Verdict: PASS");
});
