/**
 * Where the in-game code lives on the game's home server: the contract between the deployer, which writes it over the
 * Remote File API, and `boot.js`, which starts the Agent from it (packages/ingame/README.md, "Deploy layout").
 *
 * A deployment is a build plus its configuration, each in its own folder, so a new one never overwrites files a
 * running script uses. `current.txt` names the deployment in use; `boot.js` stays at one path, so the game's autoexec
 * setting never changes.
 */
export const DEPLOYMENT_ROOT = "agent";
/** Holds the id of the deployment in use, and nothing else. */
export const CURRENT_DEPLOYMENT_FILE = `${DEPLOYMENT_ROOT}/current.txt`;
/** The one fixed-path script: autoexec runs it on every load of a save. */
export const BOOT_SCRIPT = `${DEPLOYMENT_ROOT}/boot.js`;
/** The Agent's file name inside a deployment folder. */
export const AGENT_SCRIPT_NAME = "agent.js";

export function deploymentFolder(deploymentId: string): string {
  return `${DEPLOYMENT_ROOT}/${deploymentId}`;
}

export function deployedFilePath(deploymentId: string, fileName: string): string {
  return `${deploymentFolder(deploymentId)}/${fileName}`;
}
