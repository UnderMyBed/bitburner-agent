// A brain wired as main.ts wires it, on the lockstep driver: the control channel and the deployer on the game's
// connections, and, given a store, both recorded into it. Used by the deploy tests (#91) and the skeleton suite (#98).
import {
  type Connection,
  ControlChannel,
  type ControlChannelEvent,
  Deployer,
  type DeployerEvent,
  type InGameBuild,
} from "@bitburner-agent/bridge";
import { readPinnedDefinitions } from "../../src/in-game-build.ts";
import { recordChannelEvents, recordDeployerEvents } from "../../src/record-channel-events.ts";
import type { SimulatedGame } from "../../src/simulated-game.ts";
import type { TelemetryStore } from "../../src/telemetry-store.ts";
import { CONTROL_PORT, CONTROL_URL, TOKEN } from "./agent-in-simulation.ts";

export const RFA_PORT = 12525;
export const RFA_URL = `ws://127.0.0.1:${RFA_PORT}`;
/** The game retries a dropped RFA connection after this many seconds (its own setting). */
export const RFA_RECONNECT_SECONDS = 2;

/** Game settings naming the brain's Remote File API, as the owner sets them once (#95). */
export const BRAIN_RFA_SETTINGS = {
  RemoteFileApiAddress: "127.0.0.1",
  RemoteFileApiPort: RFA_PORT,
  RemoteFileApiReconnectionDelay: RFA_RECONNECT_SECONDS,
};

export interface BrainInSimulation {
  channel: ControlChannel;
  deployer: Deployer;
  /** Every event either reported, in order. */
  channelEvents: ControlChannelEvent[];
  deployerEvents: DeployerEvent[];
  /** The page's control channel connections, in order: tests can close one from the brain's side. */
  controlConnections: Connection[];
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
    recordInto,
  }: {
    build: InGameBuild;
    token?: string;
    pinnedDefinitions?: string;
    /** The store, and the release its rows are tagged with: environment E1, the simulator. */
    recordInto?: { store: TelemetryStore; brainRelease: string };
  },
): BrainInSimulation {
  const channel = new ControlChannel({ token, clock: game.clock });
  const deployer = new Deployer({
    build,
    controlPort: CONTROL_PORT,
    token,
    pinnedDefinitions,
    channel,
    clock: game.clock,
  });
  if (recordInto) {
    const context = { environment: "E1", brainRelease: recordInto.brainRelease } as const;
    recordChannelEvents(channel, recordInto.store, context);
    recordDeployerEvents(deployer, recordInto.store, context);
  }
  const openConnections: Connection[] = [];
  const brain: BrainInSimulation = {
    channel,
    deployer,
    channelEvents: [],
    deployerEvents: [],
    controlConnections: [],
    closeConnections: () => {
      for (const connection of openConnections.splice(0)) connection.close(1001, "brain restarting");
    },
  };
  channel.subscribe((event) => brain.channelEvents.push(event));
  deployer.subscribe((event) => brain.deployerEvents.push(event));
  game.listen(CONTROL_URL, (connection) => {
    openConnections.push(connection);
    brain.controlConnections.push(connection);
    channel.accept(connection);
  });
  game.listen(RFA_URL, (connection) => {
    openConnections.push(connection);
    void deployer.accept(connection);
  });
  return brain;
}
