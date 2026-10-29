// The Effectors (#141, #145, #147, #149, #151, #153, #155, #156, #158, #159, #162, #164, #175, #194, architecture
// §5.6): for each action an intent can name, and for the work activity's work, how each backend does it.
// - `sim`: the simulator's own effectors, called directly (packages/sim, `agent-effectors.ts`): the simulator renders
//   no page. They're on the page's global object there, and absent in a browser.
// - `singularity`: a home worker that calls the Singularity API, once SF4 or BN4 makes it available.
// - `ui`: a home worker that does it without Singularity: through the game's page, or with NS calls alone where the
//   API has them (`buyServer`, #159; `upgradeServer`, #194). Such an action has no Singularity worker: the `ui` one
//   does it in any game.
// The brain never knows which backend does an intent or the work. The simulator's effectors aren't named like NS
// functions: the game charges RAM for such names in in-game code.
import {
  AGENT_SIM_EFFECTORS_GLOBAL,
  BACKDOOR_WORKER_NAME,
  BOOT_SCRIPT,
  BUY_AUGMENTATION_WORKER_NAME,
  BUY_PROGRAM_WORKER_NAME,
  BUY_SERVER_WORKER_NAME,
  CLASS_WORK_WORKER_NAME,
  COMPANY_WORK_WORKER_NAME,
  CRIME_WORK_WORKER_NAME,
  classLabel,
  DESTROY_BITNODE_WORKER_NAME,
  type EffectorReport,
  FACTION_WORK_WORKER_NAME,
  INSTALL_AUGMENTATIONS_WORKER_NAME,
  type Intent,
  JOIN_FACTION_WORKER_NAME,
  NEUROFLUX_GOVERNOR,
  SINGULARITY_BACKDOOR_WORKER_NAME,
  SINGULARITY_BUY_AUGMENTATION_WORKER_NAME,
  SINGULARITY_BUY_PROGRAM_WORKER_NAME,
  SINGULARITY_BUY_TOR_WORKER_NAME,
  SINGULARITY_CLASS_WORK_WORKER_NAME,
  SINGULARITY_COMPANY_WORK_WORKER_NAME,
  SINGULARITY_CRIME_WORK_WORKER_NAME,
  SINGULARITY_DESTROY_BITNODE_WORKER_NAME,
  SINGULARITY_FACTION_WORK_WORKER_NAME,
  SINGULARITY_INSTALL_AUGMENTATIONS_WORKER_NAME,
  SINGULARITY_JOIN_FACTION_WORKER_NAME,
  SINGULARITY_TRAVEL_WORKER_NAME,
  SINGULARITY_UPGRADE_HOME_RAM_WORKER_NAME,
  TOR_ROUTER,
  TRAVEL_WORKER_NAME,
  UPGRADE_HOME_RAM_WORKER_NAME,
  UPGRADE_SERVER_WORKER_NAME,
  type Work,
  type WorkEffectorReport,
} from "@bitburner-agent/core";

/** The simulator's effectors, as it puts them on the page's global object. */
export interface SimEffectors {
  buyTorRouter(): EffectorReport;
  buyDarkwebProgram(program: string): EffectorReport;
  buyHomeRam(fromRam: number): EffectorReport;
  travelTo(city: string): EffectorReport;
  acceptFactionInvitation(faction: string): EffectorReport;
  buyAugmentationFrom(faction: string, augmentation: string, level: number): EffectorReport;
  convergeFactionWork(faction: string, workType: string, focus: boolean): EffectorReport;
  convergeCompanyWork(company: string, field: string, focus: boolean, checkPromotion: boolean): WorkEffectorReport;
  buyCloudServer(hostname: string, ram: number): EffectorReport;
  upgradeCloudServer(hostname: string, ram: number): EffectorReport;
  backdoorServer(hostname: string): EffectorReport;
  convergeCrimeWork(crime: string, focus: boolean): EffectorReport;
  convergeClassWork(location: string, classType: string, focus: boolean): EffectorReport;
  installQueuedAugmentations(callbackScript: string): EffectorReport;
  destroyWorldDaemon(nextBitNode: number, callbackScript: string): EffectorReport;
}

/** A home worker and its arguments, before the deadline it's given. */
export interface WorkerEffector {
  workerName: string;
  workerArguments: (string | number)[];
}

export interface Effector {
  /** What it does, for the log: "travel to Aevum". */
  description: string;
  ui: WorkerEffector;
  /** Null for an action the NS API does without Singularity (#159): the `ui` worker does it in any game. */
  singularity: WorkerEffector | null;
  sim(effectors: SimEffectors): EffectorReport;
}

/** The simulator's effectors, if the page has them. */
export function simEffectors(): SimEffectors | null {
  const found = (globalThis as unknown as Record<string, unknown>)[AGENT_SIM_EFFECTORS_GLOBAL];
  return typeof found === "object" && found !== null ? (found as SimEffectors) : null;
}

export function effectorFor(intent: Intent): Effector {
  switch (intent.action) {
    case "buyTor":
      return {
        description: "buy the TOR router",
        ui: { workerName: BUY_PROGRAM_WORKER_NAME, workerArguments: [TOR_ROUTER, intent.args.vendor] },
        singularity: { workerName: SINGULARITY_BUY_TOR_WORKER_NAME, workerArguments: [] },
        sim: (effectors) => effectors.buyTorRouter(),
      };
    case "buyProgram":
      return {
        description: `buy ${intent.args.program}`,
        ui: { workerName: BUY_PROGRAM_WORKER_NAME, workerArguments: [intent.args.program, ""] },
        singularity: { workerName: SINGULARITY_BUY_PROGRAM_WORKER_NAME, workerArguments: [intent.args.program] },
        sim: (effectors) => effectors.buyDarkwebProgram(intent.args.program),
      };
    case "upgradeHomeRam":
      return {
        description: `upgrade home RAM to ${intent.args.fromRam * 2} GB`,
        ui: { workerName: UPGRADE_HOME_RAM_WORKER_NAME, workerArguments: [intent.args.fromRam, intent.args.vendor] },
        singularity: { workerName: SINGULARITY_UPGRADE_HOME_RAM_WORKER_NAME, workerArguments: [intent.args.fromRam] },
        sim: (effectors) => effectors.buyHomeRam(intent.args.fromRam),
      };
    case "travel":
      return {
        description: `travel to ${intent.args.city}`,
        ui: { workerName: TRAVEL_WORKER_NAME, workerArguments: [intent.args.city] },
        singularity: { workerName: SINGULARITY_TRAVEL_WORKER_NAME, workerArguments: [intent.args.city] },
        sim: (effectors) => effectors.travelTo(intent.args.city),
      };
    case "joinFaction":
      return {
        description: `join ${intent.args.faction}`,
        ui: { workerName: JOIN_FACTION_WORKER_NAME, workerArguments: [intent.args.faction] },
        singularity: { workerName: SINGULARITY_JOIN_FACTION_WORKER_NAME, workerArguments: [intent.args.faction] },
        sim: (effectors) => effectors.acceptFactionInvitation(intent.args.faction),
      };
    case "purchaseAugmentation": {
      const { faction, augmentation, level } = intent.args;
      const workerArguments = [faction, augmentation, level];
      return {
        description: `buy ${augmentation}${augmentation === NEUROFLUX_GOVERNOR ? ` level ${level}` : ""} from ${faction}`,
        ui: { workerName: BUY_AUGMENTATION_WORKER_NAME, workerArguments },
        singularity: { workerName: SINGULARITY_BUY_AUGMENTATION_WORKER_NAME, workerArguments },
        sim: (effectors) => effectors.buyAugmentationFrom(faction, augmentation, level),
      };
    }
    case "buyServer": {
      const { hostname, ram } = intent.args;
      return {
        description: `buy the ${ram} GB server ${hostname}`,
        ui: { workerName: BUY_SERVER_WORKER_NAME, workerArguments: [hostname, ram] },
        singularity: null,
        sim: (effectors) => effectors.buyCloudServer(hostname, ram),
      };
    }
    case "upgradeServer": {
      const { hostname, ram } = intent.args;
      return {
        description: `upgrade the server ${hostname} to ${ram} GB`,
        ui: { workerName: UPGRADE_SERVER_WORKER_NAME, workerArguments: [hostname, ram] },
        singularity: null,
        sim: (effectors) => effectors.upgradeCloudServer(hostname, ram),
      };
    }
    case "backdoor":
      return {
        description: `install a backdoor on ${intent.args.hostname}`,
        ui: { workerName: BACKDOOR_WORKER_NAME, workerArguments: [intent.args.hostname] },
        singularity: { workerName: SINGULARITY_BACKDOOR_WORKER_NAME, workerArguments: [intent.args.hostname] },
        sim: (effectors) => effectors.backdoorServer(intent.args.hostname),
      };
    // Installing kills every script, the Agent too, and resets the game; `boot.js`, started after it, starts the next
    // Agent (#164, architecture §5.7); through the page, the worker's page timer types it into the terminal (#167).
    // Sent again after the reset, it's done: nothing is left to install.
    case "installAugmentations":
      return {
        description: "install the augmentations queued",
        ui: { workerName: INSTALL_AUGMENTATIONS_WORKER_NAME, workerArguments: [BOOT_SCRIPT] },
        singularity: { workerName: SINGULARITY_INSTALL_AUGMENTATIONS_WORKER_NAME, workerArguments: [BOOT_SCRIPT] },
        sim: (effectors) => effectors.installQueuedAugmentations(BOOT_SCRIPT),
      };
    // Destroying kills every script, the Agent too, and enters the next BitNode; `boot.js`, started after it, starts
    // the next Agent (#175, architecture §5.7). The game can't show one done: the brain's reset check takes it off.
    case "destroyBitNode": {
      const { nextBitNode } = intent.args;
      const workerArguments = [nextBitNode, BOOT_SCRIPT];
      return {
        description: `destroy the BitNode, into BitNode ${nextBitNode}`,
        ui: { workerName: DESTROY_BITNODE_WORKER_NAME, workerArguments },
        singularity: { workerName: SINGULARITY_DESTROY_BITNODE_WORKER_NAME, workerArguments },
        sim: (effectors) => effectors.destroyWorldDaemon(nextBitNode, BOOT_SCRIPT),
      };
    }
  }
}

/**
 * The work activity's effector (#151, #153, #156, #158): converges the game on `work`, starting it, or setting its
 * focus. With `checkPromotion`, company work also takes any later title of its field the game offers (#155).
 */
export function workEffectorFor(work: Work, { checkPromotion = false } = {}): Effector {
  if (work.kind === "class") {
    const { location, classType, focus } = work;
    const workerArguments = [location, classType, String(focus)];
    return {
      description: `${classLabel(work)}${focus ? ", focused" : ""}`,
      ui: { workerName: CLASS_WORK_WORKER_NAME, workerArguments },
      singularity: { workerName: SINGULARITY_CLASS_WORK_WORKER_NAME, workerArguments },
      sim: (effectors) => effectors.convergeClassWork(location, classType, focus),
    };
  }
  if (work.kind === "crime") {
    const { crime, focus } = work;
    const workerArguments = [crime, String(focus)];
    return {
      description: `${crime}${focus ? ", focused" : ""}`,
      ui: { workerName: CRIME_WORK_WORKER_NAME, workerArguments },
      singularity: { workerName: SINGULARITY_CRIME_WORK_WORKER_NAME, workerArguments },
      sim: (effectors) => effectors.convergeCrimeWork(crime, focus),
    };
  }
  if (work.kind === "company") {
    const { company, field, focus } = work;
    const workerArguments = [company, field, String(focus), String(checkPromotion)];
    return {
      description: `${field} work at ${company}${focus ? ", focused" : ""}`,
      ui: { workerName: COMPANY_WORK_WORKER_NAME, workerArguments },
      singularity: { workerName: SINGULARITY_COMPANY_WORK_WORKER_NAME, workerArguments },
      sim: (effectors) => effectors.convergeCompanyWork(company, field, focus, checkPromotion),
    };
  }
  const { faction, workType, focus } = work;
  const workerArguments = [faction, workType, String(focus)];
  return {
    description: `${workType} work for ${faction}${focus ? ", focused" : ""}`,
    ui: { workerName: FACTION_WORK_WORKER_NAME, workerArguments },
    singularity: { workerName: SINGULARITY_FACTION_WORK_WORKER_NAME, workerArguments },
    sim: (effectors) => effectors.convergeFactionWork(faction, workType, focus),
  };
}
