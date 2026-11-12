// agent/<deploymentId>/bladeburner.js: a home worker that does the brain's Bladeburner state and reads the division
// (#367), every 10 s while the brain asks for it (../agent/bladeburner.ts). Argument: the desired state's
// `bladeburner`, as JSON; one the protocol wouldn't take is a problem, and nothing is done. What it does, and its RAM,
// are in ../workers/bladeburner-reading.ts (ram-budget.json).
import { parseBladeburnerState } from "@bitburner-agent/core";
import type { NS } from "../ns.ts";
import { bladeburnerReading } from "../workers/bladeburner-reading.ts";
import { reportToAgent } from "../workers/report-to-agent.ts";

export function main(ns: NS): void {
  ns.disableLog("ALL");
  let state: unknown = null;
  try {
    state = JSON.parse(String(ns.args[0] ?? ""));
  } catch {
    // Refused below, as a state that isn't one.
  }
  const parsed = parseBladeburnerState(state);
  if (!parsed.ok || parsed.bladeburner === null) {
    const reason = parsed.ok ? "none was given" : parsed.reason;
    reportToAgent(ns, { rank: null, problems: [`the Bladeburner state isn't one to do: ${reason}`] });
    return;
  }
  reportToAgent(ns, bladeburnerReading(ns, parsed.bladeburner));
}
