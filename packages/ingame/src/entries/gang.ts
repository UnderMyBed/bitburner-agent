// agent/<deploymentId>/gang.js: a home worker that does the brain's gang state and reads the gang (#325), every 10 s
// while the brain manages a gang (../agent/gang.ts). Argument: the desired state's `gang`, as JSON; one the protocol
// wouldn't take is a problem, and nothing is done. What it does, and its RAM, are in ../workers/gang-management.ts
// (ram-budget.json).
import { parseGangState } from "@bitburner-agent/core";
import type { NS } from "../ns.ts";
import { gangManagement } from "../workers/gang-management.ts";
import { reportToAgent } from "../workers/report-to-agent.ts";

export function main(ns: NS): void {
  ns.disableLog("ALL");
  let state: unknown = null;
  try {
    state = JSON.parse(String(ns.args[0] ?? ""));
  } catch {
    // Refused below, as a state that isn't one.
  }
  const parsed = parseGangState(state);
  if (!parsed.ok || parsed.gang === null) {
    const reason = parsed.ok ? "none was given" : parsed.reason;
    reportToAgent(ns, { gang: null, members: [], problems: [`the gang state isn't one to do: ${reason}`] });
    return;
  }
  reportToAgent(ns, gangManagement(ns, parsed.gang));
}
