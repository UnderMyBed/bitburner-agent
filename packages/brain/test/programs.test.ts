// The brain's side of buying the hacking programs (#136): the next item, its order, affordability and vendor, and the
// dashboard's switch.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type MediumSnapshotData, PORT_OPENER_PROGRAMS, TOR_ROUTER } from "@bitburner-agent/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { chooseNextPurchase, PURCHASE_PRICES, readProgramsEnabled } from "../src/programs.ts";
import { TelemetryStore } from "../src/telemetry-store.ts";
import { mediumData } from "./helpers/snapshot-fixtures.ts";

/** The player's money, city and programs: the rest of the snapshot doesn't matter here. */
const medium = (options: Parameters<typeof mediumData>[2]) => mediumData(1, {}, options);

test("every item has a price: one without would always look affordable", () => {
  for (const item of [TOR_ROUTER, ...PORT_OPENER_PROGRAMS]) expect(PURCHASE_PRICES[item]).toBeGreaterThan(0);
});

describe("chooseNextPurchase", () => {
  test("TOR first, at the city's tech vendor, once its $200k is there", () => {
    expect(chooseNextPurchase(medium({ money: 199_999 }))).toEqual({
      owned: [],
      next: null,
      price: 200_000,
      waitingFor: "money for TOR router ($200,000)",
    });
    expect(chooseNextPurchase(medium({ money: 200_000 })).next).toEqual({
      item: "TOR router",
      vendor: "Alpha Enterprises",
    });
    expect(chooseNextPurchase(medium({ money: 1e9, city: "Volhaven" })).next).toEqual({
      item: "TOR router",
      vendor: "CompuTek",
    });
  });

  test("no tech vendor in the city: nothing, and the dashboard says travel is needed", () => {
    expect(chooseNextPurchase(medium({ money: 1e9, city: "Chongqing" }))).toEqual({
      owned: [],
      next: null,
      price: 200_000,
      waitingFor: "travel: no tech vendor sells the TOR router in Chongqing",
    });
  });

  test("then the port openers, cheapest first, each when it's affordable", () => {
    const withTor = { hasTorRouter: true };
    expect(chooseNextPurchase(medium({ ...withTor, money: 500_000 })).next).toEqual({
      item: "BruteSSH.exe",
      vendor: null,
    });
    expect(chooseNextPurchase(medium({ ...withTor, money: 1e9, programs: ["BruteSSH.exe"] })).next?.item).toBe(
      "FTPCrack.exe",
    );
    expect(
      chooseNextPurchase(
        medium({ ...withTor, money: 29e6, programs: ["BruteSSH.exe", "FTPCrack.exe", "relaySMTP.exe"] }),
      ),
    ).toEqual({
      owned: ["TOR router", "BruteSSH.exe", "FTPCrack.exe", "relaySMTP.exe"],
      next: null,
      price: 30e6,
      waitingFor: "money for HTTPWorm.exe ($30,000,000)",
    });
  });

  test("a gap is filled first: a program the player owns out of order doesn't skip a cheaper one", () => {
    expect(chooseNextPurchase(medium({ hasTorRouter: true, money: 1e9, programs: ["SQLInject.exe"] })).next?.item).toBe(
      "BruteSSH.exe",
    );
  });

  test("everything owned: nothing, and nothing to wait for", () => {
    const all = ["BruteSSH.exe", "FTPCrack.exe", "relaySMTP.exe", "HTTPWorm.exe", "SQLInject.exe"];
    expect(chooseNextPurchase(medium({ hasTorRouter: true, money: 1e12, programs: all }))).toEqual({
      owned: ["TOR router", ...all],
      next: null,
      price: null,
      waitingFor: null,
    });
  });

  test("snapshot data it can't read counts as nothing owned, and no money", () => {
    const odd = { player: {}, hasTorRouter: "yes", programs: "all", servers: [] } as unknown as MediumSnapshotData;
    expect(chooseNextPurchase(odd)).toEqual({
      owned: [],
      next: null,
      price: 200_000,
      waitingFor: "money for TOR router ($200,000)",
    });
  });
});

describe("the switch", () => {
  let directory: string;
  let store: TelemetryStore;
  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), "programs-"));
    store = TelemetryStore.open(path.join(directory, "telemetry.sqlite"));
  });
  afterEach(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("on until the owner turns it off", () => {
    expect(readProgramsEnabled(store)).toBe(true);
    store.setSetting("programs.enabled", "false");
    expect(readProgramsEnabled(store)).toBe(false);
  });

  test("a value it didn't write fails, rather than guess", () => {
    store.setSetting("programs.enabled", "maybe");
    expect(() => readProgramsEnabled(store)).toThrow(/programs\.enabled/);
  });
});
