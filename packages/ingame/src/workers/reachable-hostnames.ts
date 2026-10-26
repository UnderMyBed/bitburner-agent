// Every server `scan` reaches from home, home first.
import type { NS } from "../ns.ts";

export function reachableHostnames(ns: NS): string[] {
  const found = ["home"];
  for (let index = 0; index < found.length; index++) {
    for (const neighbour of ns.scan(found[index])) if (!found.includes(neighbour)) found.push(neighbour);
  }
  return found;
}
