export { type BrainConfig, defaultConfig, loadOrCreateConfig, resolveDataDirectory } from "./config.ts";
export { AGENT_SILENT_AFTER_MS, type Alert, type AlertName, activeAlerts } from "./dashboard/alerts.ts";
export { type RunningDashboardServer, startDashboardServer } from "./dashboard/server.ts";
export { buildDashboardStatus, type DashboardStatus } from "./dashboard/status.ts";
export { DEFAULT_GAP_THRESHOLD_MS, findGaps, type Gap, type GapReport, type GapWindow } from "./gap-report.ts";
export { recordChannelEvents, recordEvents } from "./record-channel-events.ts";
export { type SaveBackupEvent, SaveBackups, type SaveBackupsOptions } from "./save-backups.ts";
export { SimulatedGame, type SimulatedGameOptions } from "./simulated-game.ts";
export {
  readSupervisionSwitch,
  recordSupervisionGaveUp,
  type SupervisionSwitch,
  setSupervisionPaused,
} from "./supervision.ts";
export {
  type Environment,
  type RecordContext,
  type StoredEvent,
  type StoredSnapshot,
  TelemetryStore,
} from "./telemetry-store.ts";
