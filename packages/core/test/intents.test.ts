// Intents (#141): each action's args, and the id made from them.
import { describe, expect, test } from "vitest";
import { intentId, parseIntentRequest } from "../src/intents.ts";

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
    ["an action that can't be made a string", { action: { toString: 1 }, args: {} }],
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
