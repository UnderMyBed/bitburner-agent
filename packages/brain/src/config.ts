// The brain's data directory and its config.json: created with defaults on first run, then read (packages/brain/README.md).
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MAX_BACKUP_INTERVAL_MS } from "./save-backups.ts";
import type { Environment } from "./telemetry-store.ts";

export const DATA_DIRECTORY_VARIABLE = "BITBURNER_AGENT_DATA_DIR";
export const CONFIG_FILE_NAME = "config.json";
export const STORE_FILE_NAME = "telemetry.sqlite";
/** The environments a brain's config can name: Steam, or a source build under test. The simulator's brain has none. */
export const CONFIG_ENVIRONMENTS: readonly Environment[] = ["E0", "E2"];
/** The longest backup interval a timer can wait, in whole minutes. */
export const MAX_SAVE_BACKUP_INTERVAL_MINUTES = Math.floor(MAX_BACKUP_INTERVAL_MS / 60_000);

export interface BrainConfig {
  /** E0 on Steam (the default); E2 for a source build under test. */
  environment: Environment;
  /** 0 picks a free port (tests only: the Agent couldn't find it). */
  controlPort: number;
  remoteFileApiPort: number;
  dashboardPort: number;
  /** `Origin` headers allowed to connect: `file://` is Steam's page. */
  allowedOrigins: string[];
  /** The control channel's shared secret: 32 random bytes, hex. */
  token: string;
  /** How often the game's save is backed up, besides once on each Remote File API connection. */
  saveBackupIntervalMinutes: number;
  /** How many save backups to keep, the newest, per environment. */
  saveBackupsKept: number;
  /** Bitburner's Steam app ID, which the supervisor launches through Steam (#94; E0 on Windows only). */
  steamAppId: number;
  /** The game's executable name, as tasklist shows it. */
  gameExecutable: string;
}

/**
 * A command-line flag's value: the argument after `name`. Throws if the flag is last, or followed by another flag, so a
 * missing value is never taken from somewhere else.
 */
export function flagValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}

/**
 * A time from a command-line flag (`npm run gaps`, `npm run report`): ISO, with a `Z` or an explicit offset, since
 * without one JavaScript reads a date-time as local time.
 */
export function parseIsoTime(text: string, flagName: string): number {
  const epochMs = /(Z|[+-]\d\d:\d\d)$/.test(text) ? Date.parse(text) : Number.NaN;
  if (Number.isNaN(epochMs)) {
    throw new Error(`${flagName} must be an ISO time with Z or an offset, e.g. 2026-10-26T00:00:00Z; got ${text}`);
  }
  return epochMs;
}

/**
 * The data directory when none is given: the repository's own `.data/` (gitignored). The agent runs from the repo and
 * keeps everything in it (owner decision 30, #122).
 */
export const DEFAULT_DATA_DIRECTORY = path.resolve(import.meta.dirname, "../../../.data");

/**
 * The data directory from `--data-dir <dir>` or the environment variable (the flag first), resolved against the
 * directory the command was run from (npm runs scripts from the repository root, and records the caller's directory
 * in INIT_CWD); otherwise the repository's `.data/`.
 *
 * Only an absent one means the default. A brain there with a new config is E0, which on Windows launches Steam's game,
 * so a given but empty one (`--data-dir "$UNSET"`) is refused, and so is the default under a test runner: a test's
 * brain must have its own directory (Vitest sets VITEST, which a brain it starts inherits).
 */
export function resolveDataDirectory(argv: string[], environmentVariables: NodeJS.ProcessEnv): string {
  const dataDirectory = flagValue(argv, "--data-dir") ?? environmentVariables[DATA_DIRECTORY_VARIABLE];
  if (dataDirectory === undefined) {
    if (environmentVariables.VITEST) {
      throw new Error("A brain started by a test must be given its own data directory (--data-dir), never .data/");
    }
    return DEFAULT_DATA_DIRECTORY;
  }
  if (dataDirectory.trim() === "") {
    throw new Error(
      `The data directory given (--data-dir or ${DATA_DIRECTORY_VARIABLE}) is empty: give one, or neither for .data/`,
    );
  }
  return path.resolve(environmentVariables.INIT_CWD ?? process.cwd(), dataDirectory);
}

export function defaultConfig(): BrainConfig {
  return {
    environment: "E0",
    controlPort: 12526,
    remoteFileApiPort: 12525,
    dashboardPort: 12527,
    allowedOrigins: ["file://"],
    token: randomBytes(32).toString("hex"),
    saveBackupIntervalMinutes: 30,
    // Two days at 30 minutes.
    saveBackupsKept: 96,
    // Verified on the reference rig: steamapps/appmanifest_1812820.acf names Bitburner (#94).
    steamAppId: 1812820,
    gameExecutable: "bitburner.exe",
  };
}

/** Reads `<dataDirectory>/config.json`, creating the directory and the file (with a new token) the first time. */
export function loadOrCreateConfig(dataDirectory: string): BrainConfig {
  const configPath = path.join(dataDirectory, CONFIG_FILE_NAME);
  mkdirSync(dataDirectory, { recursive: true });
  try {
    // "wx": only if it doesn't exist yet, so two brains starting at once can't both write a token.
    writeFileSync(configPath, `${JSON.stringify(defaultConfig(), null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(`${configPath}: not valid JSON (${(error as Error).message})`);
  }
  const problem = configProblem(config);
  if (problem) throw new Error(`${configPath}: ${problem}`);
  return config as BrainConfig;
}

function configProblem(config: unknown): string | null {
  if (typeof config !== "object" || config === null || Array.isArray(config)) return "must be a JSON object";
  const fields = config as Partial<BrainConfig>;
  if (!CONFIG_ENVIRONMENTS.includes(fields.environment as Environment)) {
    return `environment must be ${CONFIG_ENVIRONMENTS.join(" or ")}`;
  }
  const ports = [fields.controlPort, fields.remoteFileApiPort, fields.dashboardPort];
  if (!ports.every((port) => Number.isInteger(port) && (port as number) >= 0 && (port as number) <= 65535)) {
    return "controlPort, remoteFileApiPort and dashboardPort must be port numbers";
  }
  const fixedPorts = ports.filter((port) => port !== 0);
  if (new Set(fixedPorts).size !== fixedPorts.length) return "the ports must be different";
  if (
    !Array.isArray(fields.allowedOrigins) ||
    fields.allowedOrigins.length === 0 ||
    !fields.allowedOrigins.every((origin) => typeof origin === "string" && origin !== "")
  ) {
    return "allowedOrigins must list at least one origin (Steam's page is file://)";
  }
  if (typeof fields.token !== "string" || !/^[0-9a-f]{64}$/.test(fields.token)) return "token must be 64 hex digits";
  const { saveBackupIntervalMinutes, saveBackupsKept } = fields;
  // A timer can't wait longer than 2^31 - 1 ms (about 24.8 days): Node would run it after 1 ms.
  if (
    typeof saveBackupIntervalMinutes !== "number" ||
    !(saveBackupIntervalMinutes > 0 && saveBackupIntervalMinutes <= MAX_SAVE_BACKUP_INTERVAL_MINUTES)
  ) {
    return `saveBackupIntervalMinutes must be a number of minutes above 0 and at most ${MAX_SAVE_BACKUP_INTERVAL_MINUTES} (the default is 30)`;
  }
  if (!Number.isInteger(saveBackupsKept) || (saveBackupsKept as number) < 1) {
    return "saveBackupsKept must be a whole number, at least 1 (the default is 96)";
  }
  if (!Number.isInteger(fields.steamAppId) || (fields.steamAppId as number) < 1) {
    return "steamAppId must be a Steam app ID, a whole number of at least 1 (the default is 1812820, Bitburner's)";
  }
  // A bare file name: it goes into tasklist's filter and taskkill's arguments.
  if (typeof fields.gameExecutable !== "string" || !/^[\w .-]+\.exe$/i.test(fields.gameExecutable)) {
    return "gameExecutable must be the game's .exe file name, with no folder (the default is bitburner.exe)";
  }
  return null;
}
