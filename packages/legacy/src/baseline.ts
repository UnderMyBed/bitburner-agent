// The fork baseline (#33, architecture §12.3): the legacy fork from BN1 with SF1.1 and SF4.3, recorded at fixed
// checkpoints in the simulator. Its progress at each is what the agent's planner has to match (M4, ADR 0011).
import { type Scenario, validateScenario } from "@bitburner-agent/sim";
import { gameFiles } from "./index.ts";

const HOUR = 60 * 60 * 1000;

/**
 * The checkpoints the baseline is recorded at, in virtual ms: 4, 8 and 12 hours (ADR 0011). They come before the fork
 * runs tens of thousands of batch scripts, where a virtual day costs hours of real time.
 */
export const CHECKPOINTS_MS = [4 * HOUR, 8 * HOUR, 12 * HOUR];

/**
 * The baseline scenario (owner decisions log #28, #29): BN1 re-entered with SF1.1 and SF4.3, the least a player can
 * hold along with SF4.3, which the game makes BN1.2. SF1 starts home at 32 GB, so the fork runs unattended from the
 * start: its game files are on home and `autopilot.js --disable-casino` runs, as a player starts it. It runs 12 virtual
 * hours, with a checkpoint every 4, and passes if it gets there without failing. It has no stop condition: the fork
 * doesn't destroy BN1 that early.
 *
 * `overrides` replace top-level fields (a shallow merge), for shorter runs and tests; the baseline never overrides.
 */
export function baselineScenario(overrides: Partial<Scenario> = {}): Scenario {
  const scenario: unknown = {
    name: "legacy-bn1: the fork from BN1 with SF1.1 and SF4.3",
    fixture: { kind: "bitnode", n: 1, sourceFiles: { 1: 1, 4: 3 } },
    epochMs: Date.UTC(2026, 0, 1),
    files: { home: Object.fromEntries(gameFiles().map((file) => [file.path, file.content])) },
    // --disable-casino: casino.js plays through the game's page and reloads the game, which a headless run can't.
    run: [{ script: "autopilot.js", args: ["--disable-casino"] }],
    durationMs: CHECKPOINTS_MS.at(-1),
    checkpointEveryMs: CHECKPOINTS_MS[0],
    seeds: { from: 1, to: 8 },
    ...overrides,
  };
  validateScenario(scenario);
  return scenario;
}
