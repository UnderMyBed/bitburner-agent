// The fork baseline (#33, architecture §12.3): the legacy fork from BN1 with SF1.1 and SF4.3, played to a destroy in
// the simulator. Its time-to-destroy is what the agent's planner has to beat (M4).
import { type Scenario, validateScenario } from "@bitburner-agent/sim";
import { gameFiles } from "./index.ts";

/** A virtual day, in ms: the baseline's checkpoint interval. */
export const DAY = 24 * 60 * 60 * 1000;

/**
 * The baseline scenario (owner decisions log #28): BN1 re-entered with SF1.1 and SF4.3, the least a player can hold
 * along with SF4.3, which the game makes BN1.2. SF1 starts home at 32 GB, so the fork runs unattended from the start:
 * its game files are on home and `autopilot.js --disable-casino` runs, as a player starts it. A run passes when the
 * fork destroys the BitNode, through Singularity or by reaching the BitVerse, and stops there; it gives up after 30
 * virtual days.
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
    durationMs: 30 * DAY,
    checkpointEveryMs: DAY,
    stopWhen: [{ event: "bitnodeDestroyed" }],
    onBitVerse: "stop",
    seeds: { from: 1, to: 8 },
    ...overrides,
  };
  validateScenario(scenario);
  return scenario;
}
