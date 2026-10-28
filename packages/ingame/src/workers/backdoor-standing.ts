// Where a backdoor stands (#162), for the `ui` and `singularity` backdoor workers alike: installed, and whether the
// terminal is still on the server; or refused, as the terminal's `backdoor` would refuse it
// (`Terminal/commands/backdoor.ts`); or to install, along the way from home.
// RAM: `serverExists` 0.1 + `getServer` 2.0 + `getHackingLevel` 0.05 + `scan` 0.2.
import type { NS } from "../ns.ts";
import { routeFromHome } from "./route-from-home.ts";

export type BackdoorStanding =
  | { installed: true; terminalThere: boolean }
  | { installed: false; problem: string; route: null }
  | { installed: false; problem: null; route: string[] };

export function backdoorStanding(ns: NS, hostname: string): BackdoorStanding {
  const refused = (problem: string) => ({ installed: false as const, problem, route: null });
  if (!ns.serverExists(hostname)) return refused(`no server ${hostname}`);
  const server = ns.getServer(hostname);
  if (server.backdoorInstalled) return { installed: true, terminalThere: server.isConnectedTo };
  if (server.purchasedByPlayer) {
    return refused(`${hostname} is the player's own: the game backdoors only others' servers`);
  }
  if (!server.hasAdminRights) return refused(`no root access on ${hostname} (NUKE.exe first)`);
  const level = ns.getHackingLevel();
  const required = server.requiredHackingSkill ?? 0;
  if (required > level) return refused(`hacking level ${level}: ${hostname} needs ${required}`);
  const route = routeFromHome(ns, hostname);
  if (route === null) return refused(`no way from home to ${hostname}`);
  return { installed: false, problem: null, route };
}

/** The problem while the backdoor's action runs: its time is hacking time / 4 (`Terminal/Terminal.ts:233-243`). */
export const installingProblem = (hostname: string, msLeft: number) =>
  `installing the backdoor on ${hostname}: about ${Math.max(1, Math.ceil(msLeft / 1000))} s left`;
