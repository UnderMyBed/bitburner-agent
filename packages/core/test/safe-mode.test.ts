// What the Agent keeps on home for safe mode (#160): the file's format, and what it refuses.
import { describe, expect, test } from "vitest";
import type { BatcherState } from "../src/control-protocol.ts";
import { DESIRED_STATE_FILE } from "../src/deploy-layout.ts";
import { encodeSafeModeState, parseSafeModeState, type SafeModeState } from "../src/safe-mode.ts";

const BATCHER: BatcherState = {
  runOn: "foodnstuff",
  config: {
    target: "n00dles",
    figures: { moneyMax: 1_750_000, minDifficulty: 1, requiredHackingSkill: 1, serverGrowth: 3_000 },
    player: { intelligence: 0, mults: { hacking_chance: 1, hacking_speed: 1, hacking_money: 1, hacking_grow: 1 } },
    hosts: ["sigma-cosmetics", "joesguns"],
    hackShare: 0.1,
    spacingMs: 20_000,
  },
};

const kept: SafeModeState = {
  hackLoop: { enabled: true, target: "n00dles", hosts: ["n00dles", "foodnstuff"] },
  batcher: null,
  work: { kind: "faction", faction: "CyberSec", workType: "hacking", focus: true },
  ttlMs: 43_200_000,
  heardAtMs: 1_767_225_600_000,
  lastAugReset: 1_767_220_000_000,
};

test("a file from before the batcher (#205) has none; a batcher the protocol refuses makes it invalid", () => {
  const { batcher: _none, ...older } = kept;
  expect(parseSafeModeState(JSON.stringify(older))).toEqual({ ok: true, message: kept });
  const sharing = { ...kept, batcher: { ...BATCHER, config: { ...BATCHER.config, hosts: ["n00dles"] } } };
  expect(parseSafeModeState(JSON.stringify(sharing))).toMatchObject({
    ok: false,
    reason: expect.stringContaining("n00dles"),
  });
});

test("lives beside current.txt, outside every deployment's folder, as a text file the game takes", () => {
  expect(DESIRED_STATE_FILE).toBe("agent/desired-state.json");
});

test.each<SafeModeState>([
  kept,
  { ...kept, work: null },
  { ...kept, hackLoop: { enabled: false, target: null, hosts: [] } },
  // Preparing the next target (#184).
  { ...kept, hackLoop: { ...kept.hackLoop, preparing: { target: "zer0", hosts: ["max-hardware"] } } },
  // Each host's hack threads (#187).
  {
    ...kept,
    hackLoop: {
      ...kept.hackLoop,
      preparing: { target: "zer0", hosts: ["max-hardware"] },
      hackThreads: { n00dles: 2, "max-hardware": 8 },
    },
  },
  { ...kept, work: { kind: "crime", crime: "Shoplift", focus: false } },
  // A save older than lastAugReset's migration can hold -1 (SaveDataMigrationUtils.ts:432).
  { ...kept, lastAugReset: -1 },
  // The batcher (#205), on hosts the hack loop doesn't use.
  { ...kept, hackLoop: { enabled: true, target: "n00dles", hosts: [] }, batcher: BATCHER },
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

test("a file from before #184 and #187, with no preparing and no hack threads, still parses: none", () => {
  const older =
    '{"hackLoop":{"enabled":true,"target":"n00dles","hosts":["n00dles"]},"work":null,"ttlMs":43200000,' +
    '"heardAtMs":1767225600000,"lastAugReset":1767220000000}';
  const parsed = parseSafeModeState(older);
  expect(parsed).toEqual({
    ok: true,
    message: expect.objectContaining({ hackLoop: { enabled: true, target: "n00dles", hosts: ["n00dles"] } }),
  });
});

describe("refused, each with a reason", () => {
  test.each([
    ["not JSON", "{"],
    ["not an object", "[1]"],
    ["empty", ""],
    ["no hack loop", JSON.stringify({ ...kept, hackLoop: undefined })],
    ["a hack loop with a bad target", JSON.stringify({ ...kept, hackLoop: { ...kept.hackLoop, target: 7 } })],
    ["hosts that aren't hostnames", JSON.stringify({ ...kept, hackLoop: { ...kept.hackLoop, hosts: [7] } })],
    [
      "preparing on an earning host",
      JSON.stringify({ ...kept, hackLoop: { ...kept.hackLoop, preparing: { target: "zer0", hosts: ["n00dles"] } } }),
    ],
    [
      "hack threads for a host it doesn't name",
      JSON.stringify({ ...kept, hackLoop: { ...kept.hackLoop, hackThreads: { "max-hardware": 4 } } }),
    ],
    ["work of an unknown kind", JSON.stringify({ ...kept, work: { kind: "gardening", focus: true } })],
    ["a ttlMs of 0", JSON.stringify({ ...kept, ttlMs: 0 })],
    ["a fractional ttlMs", JSON.stringify({ ...kept, ttlMs: 1.5 })],
    ["a ttlMs over 7 days", JSON.stringify({ ...kept, ttlMs: 604_800_001 })],
    ["a heardAtMs past what a date can show", JSON.stringify({ ...kept, heardAtMs: 9e15 })],
    ["a heardAtMs whose end a date can't show", JSON.stringify({ ...kept, heardAtMs: 8.64e15 - 1, ttlMs: 2 })],
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
