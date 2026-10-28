// What the Agent keeps on home for safe mode (#160): the file's format, and what it refuses.
import { describe, expect, test } from "vitest";
import { DESIRED_STATE_FILE } from "../src/deploy-layout.ts";
import { encodeSafeModeState, parseSafeModeState, type SafeModeState } from "../src/safe-mode.ts";

const kept: SafeModeState = {
  hackLoop: { enabled: true, target: "n00dles", hosts: ["n00dles", "foodnstuff"] },
  work: { kind: "faction", faction: "CyberSec", workType: "hacking", focus: true },
  ttlMs: 43_200_000,
  heardAtMs: 1_767_225_600_000,
  lastAugReset: 1_767_220_000_000,
};

test("lives beside current.txt, outside every deployment's folder, as a text file the game takes", () => {
  expect(DESIRED_STATE_FILE).toBe("agent/desired-state.json");
});

test.each<SafeModeState>([
  kept,
  { ...kept, work: null },
  { ...kept, hackLoop: { enabled: false, target: null, hosts: [] } },
  { ...kept, work: { kind: "crime", crime: "Shoplift", focus: false } },
  // A save older than lastAugReset's migration can hold -1 (SaveDataMigrationUtils.ts:432).
  { ...kept, lastAugReset: -1 },
])("round trips %#", (state) => {
  expect(parseSafeModeState(encodeSafeModeState(state))).toEqual({ ok: true, message: state });
});

test("only the known fields, so nothing else written there (intents, say) comes back", () => {
  const text = JSON.stringify({
    ...kept,
    intents: [{ id: "travel(Aevum)", action: "travel", args: { city: "Aevum" } }],
    hackLoop: { ...kept.hackLoop, extra: 1 },
  });
  expect(parseSafeModeState(text)).toEqual({ ok: true, message: kept });
});

describe("refused, each with a reason", () => {
  test.each([
    ["not JSON", "{"],
    ["not an object", "[1]"],
    ["empty", ""],
    ["no hack loop", JSON.stringify({ ...kept, hackLoop: undefined })],
    ["a hack loop with a bad target", JSON.stringify({ ...kept, hackLoop: { ...kept.hackLoop, target: 7 } })],
    ["hosts that aren't hostnames", JSON.stringify({ ...kept, hackLoop: { ...kept.hackLoop, hosts: [7] } })],
    ["work of an unknown kind", JSON.stringify({ ...kept, work: { kind: "gardening", focus: true } })],
    ["a ttlMs of 0", JSON.stringify({ ...kept, ttlMs: 0 })],
    ["a fractional ttlMs", JSON.stringify({ ...kept, ttlMs: 1.5 })],
    ["no heardAtMs", JSON.stringify({ ...kept, heardAtMs: undefined })],
    ["a negative heardAtMs", JSON.stringify({ ...kept, heardAtMs: -5 })],
    ["no lastAugReset", JSON.stringify({ ...kept, lastAugReset: undefined })],
    ["a lastAugReset that isn't a number", JSON.stringify({ ...kept, lastAugReset: "yesterday" })],
  ])("%s", (_description, text) => {
    const result = parseSafeModeState(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).not.toBe("");
  });
});
