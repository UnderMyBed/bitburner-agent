// agent/<deploymentId>/destroy-bitnode.js: the `ui` backend's destroy (#175). Destroying through the page needs the
// restart after it: the terminal's backdoor on w0r1d_d43m0n reaches the BitVerse, where every script dies, so a page
// timer that outlives them picks the portal, closes the dialogs, and starts `agent/boot.js` again (architecture §5.7).
// That's M3's slice 11b-2; until then this worker destroys nothing, and says so, so the Agent never kills itself with
// no way back. Arguments: the BitNode to enter, the script to start after it, and when to give up (all unused).
// RAM: nothing beyond the base (ram-budget.json).
import type { NS } from "../ns.ts";
import { reportToAgent } from "../workers/report-to-agent.ts";

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  reportToAgent(ns, {
    done: false,
    problem: "destroying through the page, and the restart after it, aren't built yet (M3 slice 11b-2)",
  });
}
