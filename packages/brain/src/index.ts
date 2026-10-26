export { type BrainConfig, defaultConfig, loadOrCreateConfig, resolveDataDirectory } from "./config.ts";
export { DEFAULT_GAP_THRESHOLD_MS, findGaps, type Gap, type GapReport, type GapWindow } from "./gap-report.ts";
export { recordChannelEvents } from "./record-channel-events.ts";
export { SimulatedGame, type SimulatedGameOptions } from "./simulated-game.ts";
export {
  type Environment,
  type RecordContext,
  type StoredEvent,
  type StoredSnapshot,
  TelemetryStore,
} from "./telemetry-store.ts";
