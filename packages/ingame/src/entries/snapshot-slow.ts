// agent/<deploymentId>/snapshot-slow.js: the slow tier's worker (#89). The reset info, the purchased servers, and the
// money made by source since the last install (#196: hacking's, for the run report's hacking ceiling).
// RAM: `getResetInfo` 1.0 + `cloud.getServerNames` 1.05 + `getMoneySources` 1.0 (ram-budget.json).
import type { SlowSnapshotData } from "@bitburner-agent/core";
import type { NS } from "../ns.ts";
import { reportToAgent } from "../workers/report-to-agent.ts";

export function main(ns: NS): void {
  ns.disableLog("ALL");
  const resetInfo = ns.getResetInfo();
  const data: SlowSnapshotData = {
    // Maps become plain objects: the snapshot goes to the brain as JSON.
    resetInfo: {
      lastAugReset: resetInfo.lastAugReset,
      lastNodeReset: resetInfo.lastNodeReset,
      currentNode: resetInfo.currentNode,
      ownedAugs: Object.fromEntries(resetInfo.ownedAugs),
      ownedSF: Object.fromEntries(resetInfo.ownedSF),
      bitNodeOptions: {
        ...resetInfo.bitNodeOptions,
        sourceFileOverrides: Object.fromEntries(resetInfo.bitNodeOptions.sourceFileOverrides),
      },
    },
    purchasedServers: ns.cloud.getServerNames(),
    moneySources: { ...ns.getMoneySources().sinceInstall },
  };
  reportToAgent(ns, data);
}
