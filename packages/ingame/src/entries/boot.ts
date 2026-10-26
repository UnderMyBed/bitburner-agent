// agent/boot.js: starts the deployed Agent if it isn't running. Autoexec runs it on every load of a save, and it's safe
// to run any number of times (architecture §5.7).
import { AGENT_SCRIPT_NAME, CURRENT_DEPLOYMENT_FILE, deployedFilePath } from "@bitburner-agent/core";
import type { NS } from "../ns.ts";

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  // To the terminal for whoever is watching, and to the script's log for later.
  const report = (message: string) => {
    ns.print(message);
    ns.tprint(message);
  };
  const deploymentId = ns.read(CURRENT_DEPLOYMENT_FILE).trim();
  if (deploymentId === "") {
    report(`boot: nothing is deployed (${CURRENT_DEPLOYMENT_FILE} is missing or empty)`);
    return;
  }
  const agentFile = deployedFilePath(deploymentId, AGENT_SCRIPT_NAME);
  if (ns.isRunning(agentFile, "home")) return;
  // Temporary, so it isn't saved: after a load, autoexec (this script) is the one way back, and a load never starts an
  // old Agent and its workers at once.
  const agentProcessId = ns.run(agentFile, { temporary: true });
  if (agentProcessId === 0) report(`boot: couldn't start ${agentFile} (missing, or not enough RAM)`);
}
