/**
 * The Singularity backend's home workers (#145, architecture §5.6): one per action, so each costs only its own call.
 * At SF4.3 or in BN4 each is within the 4.65 GB home-worker rule; with less of SF4 the game charges 4× or 16×
 * (`Netscript/RamCostGenerator.ts:82-95`), so on a small home they can't start, and the Agent uses the page instead.
 * Used by the in-game code and the bridge's deployer.
 */
export const SINGULARITY_TRAVEL_WORKER_NAME = "singularity-travel.js";
export const SINGULARITY_BUY_TOR_WORKER_NAME = "singularity-buy-tor.js";
export const SINGULARITY_BUY_PROGRAM_WORKER_NAME = "singularity-buy-program.js";
export const SINGULARITY_UPGRADE_HOME_RAM_WORKER_NAME = "singularity-upgrade-home-ram.js";

/** The most the game multiplies a Singularity function's RAM by: 16, with no SF4 or SF4.1 outside BN4. */
export const SINGULARITY_MOST_RAM_MULTIPLIER = 16;
/** What every script costs before its functions (`Netscript/RamCostGenerator.ts`, `RamCostConstants.Base`). */
export const SCRIPT_BASE_RAM_GB = 1.6;

/**
 * The most a Singularity worker with `budgetGb` at SF4.3 can cost with less of SF4: the multiplier applies to its
 * functions, never the base, so at most 1.6 + 16 × (budget − 1.6), if every function were Singularity's.
 */
export function singularityWorkerMostRamGb(budgetGb: number): number {
  return SCRIPT_BASE_RAM_GB + SINGULARITY_MOST_RAM_MULTIPLIER * (budgetGb - SCRIPT_BASE_RAM_GB);
}

/** Every Singularity worker: they fit a home only with SF4.3 or in BN4, so RAM checks of a fresh save leave them out. */
export function singularityWorkerFileNames(): string[] {
  return [
    SINGULARITY_TRAVEL_WORKER_NAME,
    SINGULARITY_BUY_TOR_WORKER_NAME,
    SINGULARITY_BUY_PROGRAM_WORKER_NAME,
    SINGULARITY_UPGRADE_HOME_RAM_WORKER_NAME,
  ];
}

/** The global the simulator puts its `sim` effectors on (packages/sim, `agent-effectors.ts`); absent in a browser. */
export const AGENT_SIM_EFFECTORS_GLOBAL = "__bitburnerAgentSim";
