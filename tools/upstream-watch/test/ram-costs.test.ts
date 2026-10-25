import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { diffRamCosts, extractRamCosts } from "../src/ram-costs.ts";

const PINNED = path.resolve(import.meta.dirname, "../../../vendor/bitburner-src/src/Netscript/RamCostGenerator.ts");

const BEFORE = `
import { Player } from "@player";

/** Constants for assigning costs to ns functions */
export const RamCostConstants = {
  Base: 1.6,
  Hack: 0.1,
  SingularityFn1: 2,
} as const;

function SF4Cost(cost: number): () => number {
  return () => cost; // the real one multiplies without SF4
}

// Hacknet API
const hacknet = {
  numNodes: 0.5,
  purchaseNode: RamCostConstants.Hack * 3,
} as const;

const singularity = {
  cat: SF4Cost(RamCostConstants.SingularityFn1 / 4),
  b1tflum3: SF4Cost(16),
} as const;

export const RamCosts: RamCostTree<NSFull> = {
  hacknet,
  singularity,
  hack: RamCostConstants.Hack,
  heart: { break: 0 },
  formulas: {
    hacking: {
      hackChance: 0,
    },
  },
  removed: 1,
} as const;
`;

const AFTER = BEFORE.replace("Hack: 0.1,", "Hack: 0.15,")
  .replace(
    "b1tflum3: SF4Cost(16),",
    "b1tflum3: SF4Cost(16),\n  hasBonus: SF4Cost(RamCostConstants.SingularityFn1 / 4),",
  )
  .replace("  removed: 1,\n", "")
  .replace("      hackChance: 0,", "      hackChance: 0,\n      hackExp: 0,");

describe("extractRamCosts", () => {
  test("flattens the cost tree to dotted paths, resolving constants, arithmetic and shorthand sections", () => {
    expect(Object.fromEntries(extractRamCosts(BEFORE))).toEqual({
      "hacknet.numNodes": "0.5",
      "hacknet.purchaseNode": "0.3",
      "singularity.cat": "0.5 (SF4)",
      "singularity.b1tflum3": "16 (SF4)",
      hack: "0.1",
      "heart.break": "0",
      "formulas.hacking.hackChance": "0",
      removed: "1",
    });
  });

  test("keeps an expression it can't resolve as written", () => {
    const odd = BEFORE.replace("numNodes: 0.5,", "numNodes: someFunction(),");
    expect(extractRamCosts(odd).get("hacknet.numNodes")).toBe("someFunction()");
  });

  test("reads the real pinned cost table", () => {
    const real = extractRamCosts(readFileSync(PINNED, "utf8"));
    expect(real.get("hack")).toBe("0.1");
    expect(real.get("singularity.destroyW0r1dD43m0n")).toBe("32 (SF4)");
    expect(real.get("formulas.hacking.hackChance")).toBe("0");
    expect(real.size).toBeGreaterThan(400);
    expect([...real.values()].filter((cost) => !/^[\d.]+( \(SF4\))?$/.test(cost))).toEqual([]);
  });
});

describe("diffRamCosts", () => {
  test("lists added, removed and changed costs by path, in that order, a constant's change showing where it's used", () => {
    expect(diffRamCosts(extractRamCosts(BEFORE), extractRamCosts(AFTER))).toEqual([
      { path: "singularity.hasBonus", before: null, after: "0.5 (SF4)" },
      { path: "formulas.hacking.hackExp", before: null, after: "0" },
      { path: "removed", before: "1", after: null },
      { path: "hacknet.purchaseNode", before: "0.3", after: "0.45" },
      { path: "hack", before: "0.1", after: "0.15" },
    ]);
  });
});
