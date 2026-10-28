// w0r1d_d43m0n as a destroy needs it (#175), for the destroy workers: null while it isn't reachable (no network links
// before The Red Pill is installed: `serverExists` is false, and every other call on it fails "Invalid host",
// `Netscript/NetscriptHelpers.tsx:504-516`); else root, and the hacking level against its required level. Core's
// `worldDaemonProblem` words them.
// RAM: `serverExists` and `getServerRequiredHackingLevel` 0.1 each + `hasRootAccess` and `getHackingLevel` 0.05 each.
import { WORLD_DAEMON, type WorldDaemonStanding } from "@bitburner-agent/core";
import type { NS } from "../ns.ts";

export function worldDaemonStanding(ns: NS): WorldDaemonStanding | null {
  if (!ns.serverExists(WORLD_DAEMON)) return null;
  return {
    rooted: ns.hasRootAccess(WORLD_DAEMON),
    hackingLevel: ns.getHackingLevel(),
    requiredHackingLevel: ns.getServerRequiredHackingLevel(WORLD_DAEMON),
  };
}
