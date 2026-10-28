// Intents (#141): each action's args, the id made from them, and when the game shows one done.
import { describe, expect, test } from "vitest";
import { intentDone, intentId, parseIntentRequest } from "../src/intents.ts";
import type { MediumSnapshotData } from "../src/snapshots.ts";

describe("parseIntentRequest", () => {
  test.each([
    ["buyTor", { vendor: "Alpha Enterprises" }],
    ["buyProgram", { program: "SQLInject.exe" }],
    ["upgradeHomeRam", { fromRam: 8, vendor: "CompuTek" }],
    ["travel", { city: "New Tokyo" }],
  ])("%s with valid args, rebuilt from the known fields only", (action, args) => {
    expect(parseIntentRequest({ action, args: { ...args, extra: 1 }, extra: 2 })).toEqual({
      ok: true,
      message: { id: intentId(action as never, args as never), action, args },
    });
  });

  test.each([
    ["not an object", 7],
    ["an unknown action", { action: "hackTheGibson", args: {} }],
    ["no args", { action: "travel" }],
    ["TOR at a place that doesn't sell it", { action: "buyTor", args: { vendor: "Noodle Bar" } }],
    ["a program that isn't a port opener", { action: "buyProgram", args: { program: "Formulas.exe" } }],
    ["home RAM that isn't a power of two", { action: "upgradeHomeRam", args: { fromRam: 24, vendor: "CompuTek" } }],
    ["home RAM below 1 GB", { action: "upgradeHomeRam", args: { fromRam: 0.5, vendor: "CompuTek" } }],
    ["home RAM at the limit", { action: "upgradeHomeRam", args: { fromRam: 2 ** 30, vendor: "CompuTek" } }],
    ["home RAM as text", { action: "upgradeHomeRam", args: { fromRam: "8", vendor: "CompuTek" } }],
    ["home RAM without a vendor", { action: "upgradeHomeRam", args: { fromRam: 8 } }],
    ["a city that isn't one", { action: "travel", args: { city: "Atlantis" } }],
  ])("refuses %s, with a reason", (_description, request) => {
    const parsed = parseIntentRequest(request);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).not.toBe("");
  });
});

test("an intent's id is its action and args, in the args' fixed order", () => {
  expect(intentId("travel", { city: "Aevum" })).toBe("travel(Aevum)");
  expect(intentId("upgradeHomeRam", { fromRam: 8, vendor: "CompuTek" })).toBe("upgradeHomeRam(8, CompuTek)");
  const reordered = parseIntentRequest({ action: "upgradeHomeRam", args: { vendor: "CompuTek", fromRam: 8 } });
  expect(reordered.ok && reordered.message.id).toBe("upgradeHomeRam(8, CompuTek)");
});

describe("intentDone, from the medium snapshot", () => {
  const medium = (changes: Partial<MediumSnapshotData>): MediumSnapshotData => ({
    player: { city: "Sector-12" },
    hasTorRouter: false,
    programs: [],
    servers: [{ hostname: "home", maxRam: 8, cpuCores: 1, hasAdminRights: true }],
    ...changes,
  });
  const intent = (request: unknown) => {
    const parsed = parseIntentRequest(request);
    if (!parsed.ok) throw new Error(parsed.reason);
    return parsed.message;
  };

  test("buyTor: the TOR router owned", () => {
    const buyTor = intent({ action: "buyTor", args: { vendor: "Alpha Enterprises" } });
    expect(intentDone(buyTor, medium({}))).toBe(false);
    expect(intentDone(buyTor, medium({ hasTorRouter: true }))).toBe(true);
  });

  test("buyProgram: the program on home", () => {
    const buyProgram = intent({ action: "buyProgram", args: { program: "FTPCrack.exe" } });
    expect(intentDone(buyProgram, medium({ programs: ["BruteSSH.exe"] }))).toBe(false);
    expect(intentDone(buyProgram, medium({ programs: ["BruteSSH.exe", "FTPCrack.exe"] }))).toBe(true);
  });

  test("upgradeHomeRam: home with more than it was upgraded from", () => {
    const upgrade = intent({ action: "upgradeHomeRam", args: { fromRam: 8, vendor: "CompuTek" } });
    expect(intentDone(upgrade, medium({}))).toBe(false);
    const upgraded = medium({ servers: [{ hostname: "home", maxRam: 16, cpuCores: 1, hasAdminRights: true }] });
    expect(intentDone(upgrade, upgraded)).toBe(true);
  });

  test("travel: the player in the city", () => {
    const travel = intent({ action: "travel", args: { city: "Aevum" } });
    expect(intentDone(travel, medium({}))).toBe(false);
    expect(intentDone(travel, medium({ player: { city: "Aevum" } }))).toBe(true);
  });

  test("snapshot data it can't read is never done", () => {
    const odd = {
      player: null,
      hasTorRouter: "yes",
      programs: "all",
      servers: "none",
    } as unknown as MediumSnapshotData;
    for (const request of [
      { action: "buyTor", args: { vendor: "Alpha Enterprises" } },
      { action: "buyProgram", args: { program: "BruteSSH.exe" } },
      { action: "upgradeHomeRam", args: { fromRam: 8, vendor: "CompuTek" } },
      { action: "travel", args: { city: "Aevum" } },
    ]) {
      expect(intentDone(intent(request), odd)).toBe(false);
    }
  });
});
