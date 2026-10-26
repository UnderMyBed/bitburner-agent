// The brain's data directory and its config.json: created with defaults on first run, then read (packages/brain/README.md).
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Environment } from "./telemetry-store.ts";

export const DATA_DIRECTORY_VARIABLE = "BITBURNER_AGENT_DATA_DIR";
export const CONFIG_FILE_NAME = "config.json";
export const STORE_FILE_NAME = "telemetry.sqlite";
/** The environments a brain's config can name: Steam, or a source build under test. The simulator's brain has none. */
export const CONFIG_ENVIRONMENTS: readonly Environment[] = ["E0", "E2"];

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
 * The data directory from `--data-dir <dir>` or the environment variable, resolved against the directory the command
 * was run from (npm runs scripts from the repository root, and records the caller's directory in INIT_CWD). There's
 * no default: the owner picks it.
 */
export function resolveDataDirectory(argv: string[], environmentVariables: NodeJS.ProcessEnv): string {
  const dataDirectory = flagValue(argv, "--data-dir") ?? environmentVariables[DATA_DIRECTORY_VARIABLE];
  if (!dataDirectory) {
    throw new Error(
      `The brain needs a data directory: pass --data-dir <dir> or set ${DATA_DIRECTORY_VARIABLE}. ` +
        'Put it on a non-system drive (ADR 0006; packages/brain/README.md, "Running it").',
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
  return null;
}
