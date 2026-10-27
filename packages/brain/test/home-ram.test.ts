// The brain's side of upgrading home's RAM (#138): the game's price, the limits, the BitNode, the vendor and the
// dashboard's switch.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MediumSnapshotData } from "@bitburner-agent/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { chooseHomeRamUpgrade, homeRamUpgradePrice, readHomeRamEnabled } from "../src/home-ram.ts";
import { TelemetryStore } from "../src/telemetry-store.ts";
import { mediumData, slowData } from "./helpers/snapshot-fixtures.ts";

/** Home's RAM and the player's money and city: the rest of the snapshot doesn't matter here. */
const medium = (homeRam: number, options: Parameters<typeof mediumData>[2] = {}) =>
  mediumData(1, {}, { homeRam, ...options });

test("the price is the game's, in BN1: the getting-started guide's $1.010m for 8 GB to 16 GB, ×3.16 a doubling", () => {
  // PersonObjects/Player/PlayerObjectServerMethods.ts:30: ram × 32,000 × 1.58^log2(ram) × HomeComputerRamCost (1).
  expect(homeRamUpgradePrice(1)).toBe(32_000);
  expect(homeRamUpgradePrice(8)).toBeCloseTo(1_009_743.872, 3);
  expect(homeRamUpgradePrice(16)).toBeCloseTo(3_190_790.636, 3);
  expect(homeRamUpgradePrice(64)).toBeCloseTo(31_861_958.97, 2);
  expect(homeRamUpgradePrice(256)).toBeCloseTo(318_160_777.49, 2);
});

describe("chooseHomeRamUpgrade", () => {
  test("the next doubling, at the city's tech vendor, once its price is there", () => {
    expect(chooseHomeRamUpgrade(medium(8, { money: 1_009_000 }), slowData())).toEqual({
      ram: 8,
      next: null,
      price: homeRamUpgradePrice(8),
      waitingFor: "money for 16 GB ($1,009,744)",
    });
    expect(chooseHomeRamUpgrade(medium(8, { money: 1_009_744 }), slowData())).toEqual({
      ram: 8,
      next: { fromRam: 8, vendor: "Alpha Enterprises" },
      price: homeRamUpgradePrice(8),
      waitingFor: null,
    });
    expect(chooseHomeRamUpgrade(medium(64, { money: 1e9, city: "Ishima" }), slowData()).next).toEqual({
      fromRam: 64,
      vendor: "Omega Software",
    });
  });

  test("no tech vendor in the city: nothing, and the dashboard says travel is needed", () => {
    expect(chooseHomeRamUpgrade(medium(8, { money: 1e9, city: "New Tokyo" }), slowData())).toMatchObject({
      next: null,
      waitingFor: "travel: no tech vendor sells home RAM in New Tokyo",
    });
  });

  test("at the game's limit, 2^30 GB: nothing, and nothing to wait for", () => {
    expect(chooseHomeRamUpgrade(medium(2 ** 30, { money: 1e300 }), slowData())).toEqual({
      ram: 2 ** 30,
      next: null,
      price: null,
      waitingFor: null,
    });
  });

  test("with the BitNode option restrictHomePCUpgrade, 128 GB is the limit", () => {
    const restricted = slowData(1, { restrictHomePCUpgrade: true });
    expect(chooseHomeRamUpgrade(medium(128, { money: 1e12 }), restricted)).toMatchObject({ next: null, price: null });
    expect(chooseHomeRamUpgrade(medium(64, { money: 1e12 }), restricted).next).toEqual({
      fromRam: 64,
      vendor: "Alpha Enterprises",
    });
  });

  test("outside BN1 the price isn't known yet: nothing, and the dashboard says why", () => {
    expect(chooseHomeRamUpgrade(medium(8, { money: 1e12 }), slowData(2))).toEqual({
      ram: 8,
      next: null,
      price: null,
      waitingFor: "the home RAM price in BitNode 2 (not known yet)",
    });
  });

  test("no slow snapshot from this Agent yet: nothing until it says which BitNode", () => {
    expect(chooseHomeRamUpgrade(medium(8, { money: 1e12 }), null)).toMatchObject({
      next: null,
      waitingFor: "the Agent's slow snapshot (which BitNode)",
    });
  });

  test("snapshot data it can't read: no home RAM is no upgrade", () => {
    const odd = { player: {}, hasTorRouter: false, programs: [], servers: "all" } as unknown as MediumSnapshotData;
    expect(chooseHomeRamUpgrade(odd, slowData())).toEqual({
      ram: null,
      next: null,
      price: null,
      waitingFor: "home's RAM in a medium snapshot",
    });
    // Not a size the game gives home: never sent, as the Agent would refuse it.
    expect(chooseHomeRamUpgrade(medium(24, { money: 1e12 }), slowData())).toMatchObject({ ram: null, next: null });
  });
});

describe("the switch", () => {
  let directory: string;
  let store: TelemetryStore;
  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), "home-ram-"));
    store = TelemetryStore.open(path.join(directory, "telemetry.sqlite"));
  });
  afterEach(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("on until the owner turns it off", () => {
    expect(readHomeRamEnabled(store)).toBe(true);
    store.setSetting("homeRam.enabled", "false");
    expect(readHomeRamEnabled(store)).toBe(false);
  });
});
