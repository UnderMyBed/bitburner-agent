// The brain's data directory and its config.json: created with defaults on first run, then read (packages/brain/README.md).
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Environment } from "./telemetry-store.ts";

export const DATA_DIRECTORY_VARIABLE = "BITBURNER_AGENT_DATA_DIR";
export const CONFIG_FILE_NAME = "config.json";
export const STORE_FILE_NAME = "telemetry.sqlite";

export interface BrainConfig {
  /** E0 on Steam (the default); E2 for a source build under test. The simulator's brain doesn't use a config. */
  environment: Environment;
  controlPort: number;
  remoteFileApiPort: number;
  dashboardPort: number;
  /** `Origin` headers allowed to connect: `file://` is Steam's page. */
  allowedOrigins: string[];
  /** The control channel's shared secret: 32 random bytes, hex. */
  token: string;
}

/** The data directory from `--data-dir <dir>` or the environment variable. There's no default: the owner picks it. */
export function resolveDataDirectory(argv: string[], environmentVariables: NodeJS.ProcessEnv): string {
  const flagIndex = argv.indexOf("--data-dir");
  const fromFlag = flagIndex >= 0 ? argv[flagIndex + 1] : undefined;
  const dataDirectory = fromFlag ?? environmentVariables[DATA_DIRECTORY_VARIABLE];
  if (!dataDirectory) {
    throw new Error(
      `The brain needs a data directory: pass --data-dir <dir> or set ${DATA_DIRECTORY_VARIABLE}. ` +
        "Put it on a non-system drive (ADR 0006); docs/setup.md has the steps.",
    );
  }
  return path.resolve(dataDirectory);
}

export function defaultConfig(): BrainConfig {
  return {
    environment: "E0",
    controlPort: 12526,
    remoteFileApiPort: 12525,
    dashboardPort: 12527,
    allowedOrigins: ["file://"],
    token: randomBytes(32).toString("hex"),
  };
}

/** Reads `<dataDirectory>/config.json`, creating the directory and the file (with a new token) the first time. */
export function loadOrCreateConfig(dataDirectory: string): BrainConfig {
  const configPath = path.join(dataDirectory, CONFIG_FILE_NAME);
  if (!existsSync(configPath)) {
    mkdirSync(dataDirectory, { recursive: true });
    writeFileSync(configPath, `${JSON.stringify(defaultConfig(), null, 2)}\n`);
  }
  const config = JSON.parse(readFileSync(configPath, "utf8")) as BrainConfig;
  const problem = configProblem(config);
  if (problem) throw new Error(`${configPath}: ${problem}`);
  return config;
}

function configProblem(config: BrainConfig): string | null {
  if (!["E0", "E1", "E2"].includes(config.environment)) return "environment must be E0, E1 or E2";
  for (const port of ["controlPort", "remoteFileApiPort", "dashboardPort"] as const) {
    if (!Number.isInteger(config[port]) || config[port] < 0 || config[port] > 65535)
      return `${port} must be a port number`;
  }
  if (!Array.isArray(config.allowedOrigins) || !config.allowedOrigins.every((origin) => typeof origin === "string")) {
    return "allowedOrigins must be a list of origins";
  }
  if (typeof config.token !== "string" || !/^[0-9a-f]{64}$/.test(config.token)) return "token must be 64 hex digits";
  return null;
}
