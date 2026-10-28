// agent/<deploymentId>/install-augmentations.js: the `ui` backend's install (#164). Installing through the page needs
// the restart after it: a page-level timer that outlives the scripts the install kills, to start `agent/boot.js` again
// (architecture §5.7, Q5). That's M3's slice 10b; until then this worker installs nothing, and says so, so the Agent
// never kills itself with no way back. Arguments: when to give up (unused).
// RAM: nothing beyond the base (ram-budget.json).
import type { NS } from "../ns.ts";
import { reportToAgent } from "../workers/report-to-agent.ts";

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  reportToAgent(ns, {
    done: false,
    problem: "installing through the page, and the restart after it, aren't built yet (M3 slice 10b)",
  });
}
