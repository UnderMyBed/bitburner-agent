// The fork baseline (#33, architecture §12.3): the legacy fork from a fresh BN1 with SF4.3, played to a destroy in the
// simulator. Its time-to-destroy is what the agent's planner has to beat (M4).
import { readFileSync } from "node:fs";
import path from "node:path";
import { type Scenario, validateScenario } from "@bitburner-agent/sim";
import { gameFiles } from "./index.ts";

const DAY = 24 * 60 * 60 * 1000;

/** The scripted early game: what a player does first, until the fork fits in home RAM (bootstrap.js). */
export const BOOTSTRAP = readFileSync(path.resolve(import.meta.dirname, "bootstrap.js"), "utf8");

/**
 * The baseline scenario: BN1 entered with SF4.3, so 8 GB of home RAM and $1000. The fork's game files and the bootstrap
 * are on home, and the bootstrap runs, then hands over to `autopilot.js --disable-casino`. A run passes when the fork
 * destroys the BitNode; it stops at the BitVerse either way, and gives up after 30 virtual days.
 */
export function baselineScenario(overrides: Partial<Scenario> = {}): Scenario {
  const scenario: unknown = {
    name: "legacy-bn1-sf4: the fork from a fresh BN1 with SF4.3, after a scripted early game",
    fixture: { kind: "bitnode", n: 1, sourceFiles: { 4: 3 } },
    epochMs: Date.UTC(2026, 0, 1),
    files: {
      home: { ...Object.fromEntries(gameFiles().map((file) => [file.path, file.content])), "bootstrap.js": BOOTSTRAP },
    },
    run: [{ script: "bootstrap.js" }],
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
