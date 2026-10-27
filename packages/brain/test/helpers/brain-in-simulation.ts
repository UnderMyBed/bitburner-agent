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
import { HackLoopController } from "../../src/hack-loop.ts";
import { readPinnedDefinitions } from "../../src/in-game-build.ts";
import { recordChannelEvents, recordEvents } from "../../src/record-channel-events.ts";
import { type SaveBackupEvent, SaveBackups } from "../../src/save-backups.ts";
import type { SimulatedGame } from "../../src/simulated-game.ts";
import type { TelemetryStore } from "../../src/telemetry-store.ts";
import { CONTROL_PORT, CONTROL_URL, TOKEN } from "./agent-in-simulation.ts";

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
  /** The hack loop's controller, when asked for (#134). */
  hackLoop: HackLoopController | null;
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
    hackLoop = false,
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
     * With the hack loop's controller, as main.ts has it (#134), its switch kept in `data`'s store. Off by default, so
     * the M2 suites see the observe-only skeleton they test.
     */
    hackLoop?: boolean;
  },
): BrainInSimulation {
  const channel = new ControlChannel({ token, clock: game.clock });
  if (data) recordChannelEvents(channel, data.store, { environment: "E1", brainRelease: data.brainRelease });
  if (hackLoop && !data) throw new Error("the hack loop keeps its switch in the store: give the brain its data");
  const hackLoopController = hackLoop && data ? new HackLoopController({ channel, store: data.store }) : null;
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
  const saveBackups =
    data &&
    new SaveBackups({
      dataDirectory: data.dataDirectory,
      environment: "E1",
      backupIntervalMs: SAVE_BACKUP_INTERVAL_MS,
      backupsKept: SAVE_BACKUPS_KEPT,
      clock: game.clock,
    });
  if (data && saveBackups) recordEvents(saveBackups, data.store, deployerReleaseContext);
  const openConnections: Connection[] = [];
  const brain: BrainInSimulation = {
    channel,
    deployer,
    hackLoop: hackLoopController,
    channelEvents: [],
    deployerEvents: [],
    saveBackupEvents: [],
    controlConnections: [],
    remoteFileApiConnections: [],
    closeConnections: () => {
      for (const connection of openConnections.splice(0)) connection.close(1001, "brain restarting");
    },
  };
  channel.subscribe((event) => brain.channelEvents.push(event));
  deployer.subscribe((event) => brain.deployerEvents.push(event));
  saveBackups?.subscribe((event) => brain.saveBackupEvents.push(event));
  game.listen(CONTROL_URL, (connection) => {
    openConnections.push(connection);
    brain.controlConnections.push(connection);
    channel.accept(connection);
  });
  game.listen(RFA_URL, (connection) => {
    openConnections.push(connection);
    brain.remoteFileApiConnections.push(connection);
    void deployer.accept(connection);
    saveBackups?.accept(connection);
  });
  return brain;
}
