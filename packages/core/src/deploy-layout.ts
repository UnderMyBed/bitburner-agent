/**
 * Where the in-game code lives on the game's home server: the contract between the deployer, which writes it over the
 * Remote File API, and `boot.js`, which starts the Agent from it (packages/ingame/README.md, "Deploy layout").
 *
 * A deployment is a build plus its configuration, each in its own folder, so a new one never overwrites files a
 * running script uses. `current.txt` names the deployment in use; `boot.js` stays at one path, so the game's autoexec
 * setting never changes.
 *
 * The constants are plain literals: in-game bundles include this module, and an unused literal constant is dropped
 * from a bundle, where a computed one would be kept (and its names charged by the game's RAM calculator).
 */
export const DEPLOYMENT_ROOT = "agent";
/** Holds the id of the deployment in use, and nothing else. */
export const CURRENT_DEPLOYMENT_FILE = "agent/current.txt";
/** The one fixed-path script: autoexec runs it on every load of a save. */
export const BOOT_SCRIPT = "agent/boot.js";
/** The Agent's file name inside a deployment folder. */
export const AGENT_SCRIPT_NAME = "agent.js";
/** The deployment's configuration for the Agent, inside its folder (`AgentConfig`, as JSON). */
export const AGENT_CONFIG_FILE_NAME = "config.json";
/** The control channel's shared secret, inside the deployment's folder. */
export const TOKEN_FILE_NAME = "token.txt";

/** What the deployer tells the Agent in `config.json` (#91). */
export interface AgentConfig {
  /** The deployment this folder holds: the Agent reports it in `hello`. */
  deploymentId: string;
  /** The brain's control channel: the Agent connects to `ws://127.0.0.1:<controlPort>`. */
  controlPort: number;
}

/** Reads `config.json`: the config, or `ok: false` and the reason it isn't a valid one. */
export function parseAgentConfig(text: string): { ok: true; config: AgentConfig } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "not JSON" };
  }
  const { deploymentId, controlPort } = (parsed ?? {}) as Partial<AgentConfig>;
  if (typeof deploymentId !== "string" || !isValidDeploymentId(deploymentId)) {
    return { ok: false, reason: "no valid deploymentId" };
  }
  if (!Number.isInteger(controlPort) || (controlPort as number) < 1 || (controlPort as number) > 65535) {
    return { ok: false, reason: "no valid controlPort" };
  }
  return { ok: true, config: { deploymentId, controlPort: controlPort as number } };
}

/** The deployment a deployed file belongs to: `agent/<deploymentId>/<file>` gives `<deploymentId>`, else null. */
export function deploymentIdOfPath(filePath: string): string | null {
  const parts = filePath.replace(/^\//, "").split("/");
  if (parts.length !== 3 || parts[0] !== DEPLOYMENT_ROOT) return null;
  const deploymentId = parts[1] as string;
  return isValidDeploymentId(deploymentId) ? deploymentId : null;
}

/** A deployment id names a folder: letters, digits, `-` and `_` only, so it can't reach outside `agent/`. */
export function isValidDeploymentId(deploymentId: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(deploymentId);
}

export function deploymentFolder(deploymentId: string): string {
  return `${DEPLOYMENT_ROOT}/${deploymentId}`;
}

export function deployedFilePath(deploymentId: string, fileName: string): string {
  return `${deploymentFolder(deploymentId)}/${fileName}`;
}
