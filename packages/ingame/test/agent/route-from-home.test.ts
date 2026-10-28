// The way from home to a server (#162), as the backdoor workers walk it with `connect`: found with `scan`.
import { expect, test } from "vitest";
import type { NS } from "../../src/ns.ts";
import { routeFromHome } from "../../src/workers/route-from-home.ts";

/** A stand-in `scan` over this network: each server's neighbours, both ways, as the game links them. */
function networkOf(links: [string, string][]): NS {
  const neighbours = new Map<string, string[]>();
  for (const [a, b] of links) {
    neighbours.set(a, [...(neighbours.get(a) ?? []), b]);
    neighbours.set(b, [...(neighbours.get(b) ?? []), a]);
  }
  return { scan: (host: string) => neighbours.get(host) ?? [] } as unknown as NS;
}

const NETWORK = networkOf([
  ["home", "n00dles"],
  ["home", "foodnstuff"],
  ["home", "pserv-0"],
  ["foodnstuff", "nectar-net"],
  ["nectar-net", "neo-net"],
  ["n00dles", "CSEC"],
  ["CSEC", "neo-net"],
]);

test("the hops from home, home left out: a neighbour, two layers down, and the shortest of two ways", () => {
  expect(routeFromHome(NETWORK, "n00dles")).toEqual(["n00dles"]);
  expect(routeFromHome(NETWORK, "nectar-net")).toEqual(["foodnstuff", "nectar-net"]);
  expect(routeFromHome(NETWORK, "neo-net")?.length).toBe(3);
  expect(routeFromHome(NETWORK, "home")).toEqual([]);
});

test("a server no scan reaches has no way", () => {
  expect(routeFromHome(NETWORK, "The-Cave")).toBeNull();
});
