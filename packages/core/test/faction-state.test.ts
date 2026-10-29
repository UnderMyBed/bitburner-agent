// The faction state (#197): the slow snapshot's reading, taken only when it's as the Agent writes it.
import { describe, expect, test } from "vitest";
import { factionReadingOf, factionStateOf, parseFactionState } from "../src/faction-state.ts";

const STATE = {
  joined: [{ name: "CyberSec", reputation: 1234.5678, favor: 3.25 }],
  invitations: ["Sector-12"],
  queuedAugmentations: ["Neurotrainer I", "NeuroFlux Governor", "NeuroFlux Governor"],
};

describe("parseFactionState", () => {
  test("a well-formed state, copied", () => {
    const parsed = parseFactionState(STATE);
    expect(parsed).toEqual(STATE);
    expect(parsed?.joined).not.toBe(STATE.joined);
  });

  test("an empty state is a state: nothing joined, invited or queued", () => {
    expect(parseFactionState({ joined: [], invitations: [], queuedAugmentations: [] })).toEqual({
      joined: [],
      invitations: [],
      queuedAugmentations: [],
    });
  });

  test.each([
    ["null", null],
    ["no joined list", { ...STATE, joined: undefined }],
    ["an invitation that isn't a name", { ...STATE, invitations: [3] }],
    ["a queue that isn't a list", { ...STATE, queuedAugmentations: "Neurotrainer I" }],
    ["a faction with no name", { ...STATE, joined: [{ reputation: 1, favor: 0 }] }],
    ["a reputation that isn't a number", { ...STATE, joined: [{ name: "CyberSec", reputation: "1", favor: 0 }] }],
    ["a negative favour", { ...STATE, joined: [{ name: "CyberSec", reputation: 1, favor: -1 }] }],
    ["an infinite reputation", { ...STATE, joined: [{ name: "CyberSec", reputation: Infinity, favor: 0 }] }],
  ])("%s: null", (_description, value) => {
    expect(parseFactionState(value)).toBeNull();
  });
});

describe("factionReadingOf and factionStateOf", () => {
  test("a reading with its state", () => {
    const slow = { factions: { backend: "ui", state: STATE, problem: null } };
    expect(factionReadingOf(slow)).toEqual({ backend: "ui", state: STATE, problem: null });
    expect(factionStateOf(slow)).toEqual(STATE);
  });

  test("a reading with a problem: well formed, but no state, never an empty one", () => {
    const slow = { factions: { backend: "ui", state: null, problem: "no game page to read it through" } };
    expect(factionReadingOf(slow)).toEqual({
      backend: "ui",
      state: null,
      problem: "no game page to read it through",
    });
    expect(factionStateOf(slow)).toBeNull();
  });

  test("a state with a problem after the read (the page not left as found): both kept", () => {
    const slow = { factions: { backend: "ui", state: STATE, problem: 'no "Terminal" in the sidebar' } };
    expect(factionReadingOf(slow)).toEqual({ backend: "ui", state: STATE, problem: 'no "Terminal" in the sidebar' });
    expect(factionStateOf(slow)).toEqual(STATE);
  });

  test.each([
    ["no slow snapshot", null],
    ["a slow snapshot from an older Agent, with no reading", {}],
    ["an unknown backend", { factions: { backend: "page", state: STATE, problem: null } }],
    ["neither a state nor a problem", { factions: { backend: "ui", state: null, problem: null } }],

    ["a state not well formed", { factions: { backend: "sim", state: { joined: [] }, problem: null } }],
    [
      "a state not well formed, with a problem",
      { factions: { backend: "ui", state: { joined: [] }, problem: "late" } },
    ],
    ["a problem that isn't text", { factions: { backend: "sim", state: null, problem: 3 } }],
  ])("%s: no reading", (_description, slow) => {
    expect(factionReadingOf(slow as never)).toBeNull();
    expect(factionStateOf(slow as never)).toBeNull();
  });
});
