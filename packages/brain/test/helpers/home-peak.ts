// Home's RAM while the Agent runs, for the simulator suites (#98, #134). A worker starts and exits within one timer, so
// checking between steps would never see it: the simulator's `homePeak` is taken as RAM in use and the script count
// change.
import { AGENT_SCRIPT_NAME, deployedFilePath } from "@bitburner-agent/core";
import type { Simulation } from "@bitburner-agent/sim";
import { expect } from "vitest";

/**
 * Home never held more than the Agent and one of `workerFileNames` since the simulation's game booted: two scripts at
 * most, and at most the RAM of the Agent and the largest of them, by the game's own figures.
 */
export async function expectHomeWithinTheAgentPlusOneWorker(
  simulation: Simulation,
  deploymentId: string,
  workerFileNames: string[],
): Promise<void> {
  const ramOf = (fileName: string) => simulation.staticRamUsage("home", deployedFilePath(deploymentId, fileName));
  const workerRams = await Promise.all(workerFileNames.map(ramOf));
  // Rounded as the game rounds RAM in use, so a sum like 2.8 + 4.35 compares as 7.15.
  const limitGb = Math.round(((await ramOf(AGENT_SCRIPT_NAME)) + Math.max(...workerRams)) * 100) / 100;
  expect(limitGb).toBeLessThanOrEqual(8);
  const peak = await simulation.diagnostics.homePeak();
  expect(peak.scripts).toBe(2);
  expect(peak.ramUsed).toBeLessThanOrEqual(limitGb);
}
