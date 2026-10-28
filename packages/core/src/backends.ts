/**
 * The Singularity backend's home workers (#145, architecture §5.6): one per action, so each costs only its own call.
 * They never run on a fresh save, so the fresh-save check (the Agent's budget plus its largest worker within 8 GB) leaves
 * them out: at SF4.3 or in BN4 the first four are within today's largest fresh-save worker, the faction join is 5.1 GB,
 * the augmentation purchase 12.6 GB, faction work 5.3 GB (#151) and company work 8.8 GB (#153). With less of SF4 the game charges their calls 4× or 16×
 * (`Netscript/RamCostGenerator.ts:82-95`). One that doesn't fit home beside the Agent leaves its action to the page.
 * Used by the in-game code and the bridge's deployer.
 */
export const SINGULARITY_TRAVEL_WORKER_NAME = "singularity-travel.js";
export const SINGULARITY_BUY_TOR_WORKER_NAME = "singularity-buy-tor.js";
export const SINGULARITY_BUY_PROGRAM_WORKER_NAME = "singularity-buy-program.js";
export const SINGULARITY_UPGRADE_HOME_RAM_WORKER_NAME = "singularity-upgrade-home-ram.js";
/** 5.1 GB, more than any fresh-save worker: no Singularity worker runs on a fresh save (#147). */
export const SINGULARITY_JOIN_FACTION_WORKER_NAME = "singularity-join-faction.js";
/** 12.6 GB: `getResetInfo`, `getOwnedAugmentations` and `purchaseAugmentation` (#149). */
export const SINGULARITY_BUY_AUGMENTATION_WORKER_NAME = "singularity-buy-augmentation.js";
/** `getCurrentWork`, `isFocused`, `workForFaction` and `setFocus` (#151). */
export const SINGULARITY_FACTION_WORK_WORKER_NAME = "singularity-faction-work.js";
/** 8.8 GB: `getPlayer`, `getCurrentWork`, `isFocused`, `applyToCompany`, `workForCompany` and `setFocus` (#153). */
export const SINGULARITY_COMPANY_WORK_WORKER_NAME = "singularity-company-work.js";

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
    SINGULARITY_JOIN_FACTION_WORKER_NAME,
    SINGULARITY_BUY_AUGMENTATION_WORKER_NAME,
    SINGULARITY_FACTION_WORK_WORKER_NAME,
    SINGULARITY_COMPANY_WORK_WORKER_NAME,
  ];
}

/** The global the simulator puts its `sim` effectors on (packages/sim, `agent-effectors.ts`); absent in a browser. */
export const AGENT_SIM_EFFECTORS_GLOBAL = "__bitburnerAgentSim";
