// A brain wired like main.ts, on the lockstep driver, in main.ts's order: the control channel and the deployer on the
// game's connections, and, given a data directory, everything recorded into its store and the save backups beside the
// deployer on the same RFA connection. Used by the deploy tests (#91) and the skeleton suite (#98). main.ts's own
// wiring, on real sockets, is tested by brain-process.test.ts.
import {
  type Connection,
  ControlChannel,
  type ControlChannelEvent,
  Deployer,
  type DeployerEvent,
  type InGameBuild,
} from "@bitburner-agent/bridge";
import { DesiredStateController } from "../../src/desired-state.ts";
import { readPinnedDefinitions } from "../../src/in-game-build.ts";
import { IncomeWatch } from "../../src/income-watch.ts";
import { brainChannel, recordChannelEvents, recordEvents } from "../../src/record-channel-events.ts";
import { type SaveBackupEvent, SaveBackups } from "../../src/save-backups.ts";
import type { SimulatedGame } from "../../src/simulated-game.ts";
import type { TelemetryStore } from "../../src/telemetry-store.ts";
import { CONTROL_PORT, CONTROL_URL, TOKEN } from "./agent-in-simulation.ts";

/**
 * How long a first deploy may take, in virtual time. Its requests and replies cross one step each way, several per
 * bundle, so it takes longer with each bundle the build adds: at a 100 ms step, 20 bundles were past 10 s (#147), and
 * at 200 ms, the 33 after #162's backdoor workers were past 30 s.
 */
export const DEPLOY_WITHIN_MS = 60_000;
export const RFA_PORT = 12525;
export const RFA_URL = `ws://127.0.0.1:${RFA_PORT}`;
/** The game retries a dropped RFA connection after this many seconds (its own setting). */
export const RFA_RECONNECT_SECONDS = 2;
/** The brain's defaults (config.ts). */
const SAVE_BACKUP_INTERVAL_MS = 30 * 60_000;
const SAVE_BACKUPS_KEPT = 96;

/** Game settings naming the brain's Remote File API, as the owner sets them once (#95). */
export const BRAIN_RFA_SETTINGS = {
  RemoteFileApiAddress: "127.0.0.1",
  RemoteFileApiPort: RFA_PORT,
  RemoteFileApiReconnectionDelay: RFA_RECONNECT_SECONDS,
};

export interface BrainInSimulation {
  channel: ControlChannel;
  deployer: Deployer;
  /** The desired state's controller (the hack loop, #134; the hacking programs, #136), when asked for. */
  desiredState: DesiredStateController | null;
  /** With the controller, the money's last rise (#184), as main.ts has it. */
  incomeWatch: IncomeWatch | null;
  /** What the brain logged, in order: the income watch's lines (#184), the backdoors' (#195), the factions' (#203). */
  logLines: string[];
  /** Every event the control channel reported, in order. */
  channelEvents: ControlChannelEvent[];
  /** Every event the deployer reported, in order. */
  deployerEvents: DeployerEvent[];
  /** Every event the save backups reported, in order (none without a data directory). */
  saveBackupEvents: SaveBackupEvent[];
  /** The page's control channel connections, in order: tests can close one from the brain's side. */
  controlConnections: Connection[];
  /** The game's Remote File API connections, in order. */
  remoteFileApiConnections: Connection[];
  /** Closes every connection the game opened to this brain, as a brain stopping does, so the game reconnects. */
  closeConnections(): void;
  /**
   * The brain gone (#160): its connections closed, and every new one closed as it's made (a real one would be refused,
   * 1006, a moment sooner), until another brain starts on the game and takes over the listening.
   */
  stop(): void;
}

/**
 * Starts a brain on `game`, listening for the Agent and the game's Remote File API. A brain started later on the same
 * game takes over the listening; close this one's connections first, as a stopping brain would.
 */
export function startBrainInSimulation(
  game: SimulatedGame,
  {
    build,
    token = TOKEN,
    pinnedDefinitions = readPinnedDefinitions(),
    data,
    withDesiredState = false,
  }: {
    build: InGameBuild;
    token?: string;
    pinnedDefinitions?: string;
    /**
     * The brain's data: its store, its release (which starts each row's release tag, `<brainRelease>+<deploymentId>`)
     * and its data directory, where the save backups go. The environment is E1, the simulator.
     */
    data?: { store: TelemetryStore; brainRelease: string; dataDirectory: string };
    /**
     * With the desired state's controller, as main.ts has it (#134, #136), its switches kept in `data`'s store. Off by
     * default, so the M2 suites see the observe-only skeleton they test.
     */
    withDesiredState?: boolean;
  },
): BrainInSimulation {
  const channel = data
    ? brainChannel({ token, clock: game.clock, store: data.store, environment: "E1" })
    : new ControlChannel({ token, clock: game.clock });
  const logLines: string[] = [];
  const log = (line: string) => logLines.push(line);
  if (data) recordChannelEvents(channel, data.store, { environment: "E1", brainRelease: data.brainRelease, log });
  const saveBackups =
    data &&
    new SaveBackups({
      dataDirectory: data.dataDirectory,
      environment: "E1",
      backupIntervalMs: SAVE_BACKUP_INTERVAL_MS,
      backupsKept: SAVE_BACKUPS_KEPT,
      clock: game.clock,
    });
  let desiredStateController: DesiredStateController | null = null;
  if (withDesiredState) {
    if (!data) throw new Error("the desired state keeps its switches in the store: give the brain its data");
    desiredStateController = new DesiredStateController({
      channel,
      store: data.store,
      saveBackups,
      log: (line) => logLines.push(line),
    });
  }
  const controller = desiredStateController;
  const incomeWatch =
    controller === null
      ? null
      : new IncomeWatch({
          channel,
          hackLoopTarget: () => controller.hackLoopView().target,
          log: (line) => logLines.push(line),
        });
  const deployer = new Deployer({
    build,
    controlPort: CONTROL_PORT,
    token,
    pinnedDefinitions,
    channel,
    clock: game.clock,
  });
  const deployerReleaseContext = {
    environment: "E1",
    release: `${data?.brainRelease}+${deployer.deploymentId}`,
  } as const;
  if (data) recordEvents(deployer, data.store, deployerReleaseContext);
  if (data && saveBackups) recordEvents(saveBackups, data.store, deployerReleaseContext);
  // The rules' events (#203, #210), as main.ts records them.
  if (data && desiredStateController) recordEvents(desiredStateController, data.store, deployerReleaseContext);
  const openConnections: Connection[] = [];
  let stopped = false;
  const brain: BrainInSimulation = {
    channel,
    deployer,
    desiredState: desiredStateController,
    incomeWatch,
    logLines,
    channelEvents: [],
    deployerEvents: [],
    saveBackupEvents: [],
    controlConnections: [],
    remoteFileApiConnections: [],
    closeConnections: () => {
      for (const connection of openConnections.splice(0)) connection.close(1001, "brain restarting");
    },
    stop: () => {
      stopped = true;
      brain.closeConnections();
    },
  };
  channel.subscribe((event) => brain.channelEvents.push(event));
  deployer.subscribe((event) => brain.deployerEvents.push(event));
  saveBackups?.subscribe((event) => brain.saveBackupEvents.push(event));
  /** Stopped, a connection is closed as it's made; reports whether it was. */
  const closedIfStopped = (connection: Connection): boolean => {
    if (stopped) connection.close(1011, "no brain");
    return stopped;
  };
  game.listen(CONTROL_URL, (connection) => {
    if (closedIfStopped(connection)) return;
    openConnections.push(connection);
    brain.controlConnections.push(connection);
    channel.accept(connection);
  });
  game.listen(RFA_URL, (connection) => {
    if (closedIfStopped(connection)) return;
    openConnections.push(connection);
    brain.remoteFileApiConnections.push(connection);
    void deployer.accept(connection);
    saveBackups?.accept(connection);
  });
  return brain;
}
