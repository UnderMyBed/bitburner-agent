// The Effectors (#141, architecture §5.6): for each action an intent can name, the home worker that does it and its
// arguments. Every one is the `ui` backend for now, driving the game's page: there's no API for them before
// Singularity. The brain never knows which backend does an intent.
import {
  BUY_PROGRAM_WORKER_NAME,
  type Intent,
  TOR_ROUTER,
  TRAVEL_WORKER_NAME,
  UPGRADE_HOME_RAM_WORKER_NAME,
} from "@bitburner-agent/core";

export interface Effector {
  workerName: string;
  /** The worker's arguments, before the deadline it's given. */
  workerArguments: (string | number)[];
  /** What it does, for the log: "travel to Aevum". */
  description: string;
}

export function effectorFor(intent: Intent): Effector {
  switch (intent.action) {
    case "buyTor":
      return {
        workerName: BUY_PROGRAM_WORKER_NAME,
        workerArguments: [TOR_ROUTER, intent.args.vendor],
        description: "buy the TOR router",
      };
    case "buyProgram":
      return {
        workerName: BUY_PROGRAM_WORKER_NAME,
        workerArguments: [intent.args.program, ""],
        description: `buy ${intent.args.program}`,
      };
    case "upgradeHomeRam":
      return {
        workerName: UPGRADE_HOME_RAM_WORKER_NAME,
        workerArguments: [intent.args.fromRam, intent.args.vendor],
        description: `upgrade home RAM to ${intent.args.fromRam * 2} GB`,
      };
    case "travel":
      return {
        workerName: TRAVEL_WORKER_NAME,
        workerArguments: [intent.args.city],
        description: `travel to ${intent.args.city}`,
      };
  }
}
