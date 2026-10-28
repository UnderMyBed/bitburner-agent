// The way from home to a server, as the terminal's `connect` walks it (#162): each hop a neighbour of the last
// (`Terminal/commands/connect.ts`), found breadth-first with `scan`, so it's a shortest way.
import type { NS } from "../ns.ts";

/** The hostnames to `connect` to, in turn, from home to `hostname` (home itself left out), or null if none reaches it. */
export function routeFromHome(ns: NS, hostname: string): string[] | null {
  const cameFrom = new Map<string, string | null>([["home", null]]);
  const queue = ["home"];
  for (let index = 0; index < queue.length; index++) {
    const here = queue[index] as string;
    if (here === hostname) {
      const route: string[] = [];
      for (let step: string | null = here; step !== null && step !== "home"; step = cameFrom.get(step) ?? null) {
        route.unshift(step);
      }
      return route;
    }
    for (const neighbour of ns.scan(here)) {
      if (!cameFrom.has(neighbour)) {
        cameFrom.set(neighbour, here);
        queue.push(neighbour);
      }
    }
  }
  return null;
}
