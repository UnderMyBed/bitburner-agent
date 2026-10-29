// `upgrade-server.js`'s logic (#194) with a stand-in NS, for the branches the simulator's BN1 can't reach: a RAM over
// the BitNode's most, and the game refusing past the worker's checks. The simulator drives the real worker (brain's
// effector-backends).
import { describe, expect, test } from "vitest";
import type { NS } from "../../src/ns.ts";
import { cloudServerUpgrade } from "../../src/workers/cloud-server-upgrade.ts";

/** A game with these servers (`cloud`: the player's), this money, BN1's prices, and what `upgradeServer` answers. */
function game({
  servers = {},
  money = 1e9,
  maxRam = 2 ** 20,
  upgrades = true,
}: {
  servers?: Record<string, { maxRam: number; cloud: boolean }>;
  money?: number;
  maxRam?: number;
  upgrades?: boolean;
}) {
  const upgraded: string[] = [];
  const price = (ram: number) => (ram > maxRam ? Number.POSITIVE_INFINITY : ram * 55_000);
  const ns = {
    serverExists: (hostname: string) => hostname in servers,
    getServerMaxRam: (hostname: string) => servers[hostname]?.maxRam ?? 0,
    getServerMoneyAvailable: () => money,
    cloud: {
      // As the game: -1 for a server that isn't a cloud server, or RAM not above its own; else the difference.
      getServerUpgradeCost: (hostname: string, ram: number) => {
        const server = servers[hostname];
        if (!server?.cloud || ram <= server.maxRam) return -1;
        return price(ram) - price(server.maxRam);
      },
      upgradeServer: (hostname: string, ram: number) => {
        if (!upgrades) return false;
        upgraded.push(`${hostname} ${ram}`);
        return true;
      },
    },
  } as unknown as NS;
  return { ns, upgraded };
}

describe("cloudServerUpgrade", () => {
  test("upgraded: done, at the difference in price", () => {
    const { ns, upgraded } = game({ servers: { "pserv-0": { maxRam: 8, cloud: true } } });
    expect(cloudServerUpgrade(ns, "pserv-0", 64)).toEqual({ done: true, problem: null });
    expect(upgraded).toEqual(["pserv-0 64"]);
  });

  test("the RAM already there, or more: done, nothing upgraded", () => {
    const { ns, upgraded } = game({ servers: { "pserv-0": { maxRam: 64, cloud: true } } });
    expect(cloudServerUpgrade(ns, "pserv-0", 64)).toEqual({ done: true, problem: null });
    expect(cloudServerUpgrade(ns, "pserv-0", 32)).toEqual({ done: true, problem: null });
    // At the most: twice it is Infinity, not -1, so still the player's.
    const most = game({ servers: { "pserv-0": { maxRam: 2 ** 20, cloud: true } } });
    expect(cloudServerUpgrade(most.ns, "pserv-0", 2 ** 20)).toEqual({ done: true, problem: null });
    expect([...upgraded, ...most.upgraded]).toEqual([]);
  });

  test("no such server, or another server's name: not done, nothing upgraded", () => {
    const { ns, upgraded } = game({ servers: { n00dles: { maxRam: 4, cloud: false } } });
    expect(cloudServerUpgrade(ns, "pserv-9", 64)).toEqual({ done: false, problem: "there's no server named pserv-9" });
    expect(cloudServerUpgrade(ns, "n00dles", 64)).toEqual({
      done: false,
      problem: "n00dles isn't one of the player's cloud servers",
    });
    expect(upgraded).toEqual([]);
  });

  test("past the BitNode's most (an Infinity price), or short of the money: not done, nothing upgraded", () => {
    const over = game({ servers: { "pserv-0": { maxRam: 8, cloud: true } }, maxRam: 64 });
    expect(cloudServerUpgrade(over.ns, "pserv-0", 128)).toEqual({
      done: false,
      problem: "the game sells no 128 GB server in this BitNode",
    });
    // 8 to 64 GB is 56 GB more: $3,080,000.
    const poor = game({ servers: { "pserv-0": { maxRam: 8, cloud: true } }, money: 3_079_999 });
    expect(cloudServerUpgrade(poor.ns, "pserv-0", 64)).toEqual({
      done: false,
      problem: "not enough money: upgrading pserv-0 to 64 GB costs $3080000",
    });
    const enough = game({ servers: { "pserv-0": { maxRam: 8, cloud: true } }, money: 3_080_000 });
    expect(cloudServerUpgrade(enough.ns, "pserv-0", 64)).toEqual({ done: true, problem: null });
    expect([...over.upgraded, ...poor.upgraded]).toEqual([]);
  });

  test("refused by the game past the checks: not done, saying so", () => {
    const { ns } = game({ servers: { "pserv-0": { maxRam: 8, cloud: true } }, upgrades: false });
    expect(cloudServerUpgrade(ns, "pserv-0", 64)).toEqual({
      done: false,
      problem: "the game refused to upgrade pserv-0 from 8 to 64 GB",
    });
  });
});
