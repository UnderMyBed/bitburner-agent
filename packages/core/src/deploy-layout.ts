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
