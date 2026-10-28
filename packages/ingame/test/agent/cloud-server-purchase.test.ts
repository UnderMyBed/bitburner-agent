// `buy-server.js`'s logic (#159) with a stand-in NS, for the branches the simulator's BN1 can't reach: a RAM over the
// BitNode's most, and a purchase the game renames. The simulator drives the real worker (brain's effector-backends).
import { describe, expect, test } from "vitest";
import type { NS } from "../../src/ns.ts";
import { cloudServerPurchase } from "../../src/workers/cloud-server-purchase.ts";

/** A game with these servers (`cloud`: the player's), this money, and what `purchaseServer` answers. */
function game({
  servers = {},
  money = 1e9,
  price = 440_000,
  bought = (hostname: string) => hostname,
}: {
  servers?: Record<string, { maxRam: number; cloud: boolean }>;
  money?: number;
  price?: number;
  bought?: (hostname: string) => string;
}) {
  const purchases: string[] = [];
  const ns = {
    serverExists: (hostname: string) => hostname in servers,
    getServerMaxRam: (hostname: string) => servers[hostname]?.maxRam ?? 0,
    getServerMoneyAvailable: () => money,
    cloud: {
      getServerUpgradeCost: (hostname: string) => (servers[hostname]?.cloud ? 1e6 : -1),
      getServerCost: () => price,
      getServerLimit: () => 25,
      purchaseServer: (hostname: string) => {
        const name = bought(hostname);
        if (name !== "") purchases.push(name);
        return name;
      },
    },
  } as unknown as NS;
  return { ns, purchases };
}

describe("cloudServerPurchase", () => {
  test("the player's cloud server of that name: done, nothing bought", () => {
    const { ns, purchases } = game({ servers: { "pserv-0": { maxRam: 8, cloud: true } } });
    expect(cloudServerPurchase(ns, "pserv-0", 64)).toEqual({ done: true, problem: null });
    expect(purchases).toEqual([]);
  });

  test("a name another server has: not done, nothing bought", () => {
    const { ns, purchases } = game({ servers: { home: { maxRam: 8, cloud: false } } });
    expect(cloudServerPurchase(ns, "home", 8)).toEqual({
      done: false,
      problem: "home is the name of a server that isn't one of the player's cloud servers",
    });
    expect(purchases).toEqual([]);
  });

  test("over the BitNode's most (an Infinity price), or short of the money: not done, nothing bought", () => {
    const over = game({ price: Number.POSITIVE_INFINITY });
    expect(cloudServerPurchase(over.ns, "pserv-0", 2 ** 20)).toEqual({
      done: false,
      problem: "the game sells no 1048576 GB server in this BitNode",
    });
    const poor = game({ money: 439_999 });
    expect(cloudServerPurchase(poor.ns, "pserv-0", 8)).toEqual({
      done: false,
      problem: "not enough money: the 8 GB server costs $440000",
    });
    expect([...over.purchases, ...poor.purchases]).toEqual([]);
  });

  test("bought: done; refused by the game past the checks: the limit", () => {
    const fine = game({});
    expect(cloudServerPurchase(fine.ns, "pserv-0", 8)).toEqual({ done: true, problem: null });
    expect(fine.purchases).toEqual(["pserv-0"]);
    const full = game({ bought: () => "" });
    expect(cloudServerPurchase(full.ns, "pserv-0", 8)).toEqual({
      done: false,
      problem: "the game's limit of 25 cloud servers is reached",
    });
  });

  test("bought under another name (a server off the network held it): done, saying so, so it's never bought twice", () => {
    const { ns, purchases } = game({ bought: (hostname) => `${hostname}-0` });
    expect(cloudServerPurchase(ns, "hidden", 8)).toEqual({
      done: true,
      problem: "bought as hidden-0: a server off the network held hidden",
    });
    expect(purchases).toEqual(["hidden-0"]);
  });
});
