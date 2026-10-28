// Whether the game has Singularity (#145), as the Agent's slow snapshot says: the backend choice's first test.
import type { SlowSnapshotData } from "@bitburner-agent/core";
import { expect, test } from "vitest";
import { singularityAvailableIn } from "../../src/agent/snapshotter.ts";

const slowIn = (currentNode: number, ownedSF: Record<string, number>) =>
  ({ resetInfo: { currentNode, ownedSF } }) as unknown as SlowSnapshotData;

test.each([
  ["BN4, with no SF4", slowIn(4, {}), true],
  ["BN1 with SF4.1", slowIn(1, { 4: 1 }), true],
  ["BN1 with SF4.3", slowIn(1, { 1: 1, 4: 3 }), true],
  ["BN1 with other Source-Files only", slowIn(1, { 1: 3, 5: 1 }), false],
  ["BN1 with none", slowIn(1, {}), false],
  ["no slow snapshot yet", null, false],
])("%s", (_description, slowData, available) => {
  expect(singularityAvailableIn(slowData)).toBe(available);
});
