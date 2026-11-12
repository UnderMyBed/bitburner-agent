// The time to the destroy (#360): w0r1d_d43m0n's level by BitNode, each term's cases, and golden cases from the
// store's tables (#360: the 2026-11-11 analyses of install timing and the Red Pill stretch, BN1.2 to BN4.1, online
// minutes).
import { describe, expect, test } from "vitest";
import {
  type DestroyEstimateInputs,
  type DestroyPrior,
  destroyEstimate,
  worldDaemonRequiredLevel,
} from "../src/destroy-estimate.ts";

const MINUTE = 60_000;
const min = (ms: number | null) => (ms === null ? null : ms / MINUTE);

describe("w0r1d_d43m0n's level (#360)", () => {
  test("3000 × WorldDaemonDifficulty for BitNodes 1-15 (`BitNode.tsx`), at levels 1-3", () => {
    const byBitNode = [3000, 15000, 6000, 9000, 4500, 6000, 6000, 3000, 6000, 6000, 4500, 3060, 9000, 15000, 6000];
    for (const [index, level] of byBitNode.entries()) {
      const n = index + 1;
      if (n === 12) continue;
      for (const sf of [0, 1, 2]) {
        expect(worldDaemonRequiredLevel(n, sf === 0 ? {} : { [n]: sf }), `BN${n}.${sf + 1}`).toBe(level);
      }
    }
  });

  test("BN12's grows with its level: 3000 × 1.02^level (`BitNode.tsx:993`), other Source-Files no matter", () => {
    expect(worldDaemonRequiredLevel(12, {})).toBeCloseTo(3060, 9);
    expect(worldDaemonRequiredLevel(12, { 12: 1 })).toBeCloseTo(3000 * 1.02 ** 2, 9);
    expect(worldDaemonRequiredLevel(12, { 12: 49, 1: 3 })).toBeCloseTo(3000 * 1.02 ** 50, 9);
    expect(worldDaemonRequiredLevel(1, { 12: 49 })).toBe(3000);
  });
});

/** BN1, nothing joined, at `t` minutes with `count` installed: the inputs, with `fields` over them. */
const inputs = (t: number, count: number, fields: Partial<DestroyEstimateInputs> = {}): DestroyEstimateInputs => ({
  currentNode: 1,
  ownedSF: { 1: 2 },
  onlineMs: t * MINUTE,
  count,
  redPillInstalled: false,
  countMetOnlineMs: null,
  daedalus: "not joined",
  holdEtaMs: null,
  levellingMs: null,
  prior: null,
  ...fields,
});
/** A prior from the issue's table, in minutes. */
const prior = (bitNode: string, a: number, bc: number, cycle: number, d: number, level = 3000): DestroyPrior => ({
  bitNode,
  currentNode: Number(bitNode[2]),
  aMs: a * MINUTE,
  bcMs: bc * MINUTE,
  redPillCycleMs: cycle * MINUTE,
  dMs: d * MINUTE,
  requiredLevel: level,
});
const BN1_2 = prior("BN1.2", 570, 15 + 85, 18, 3);
const BN1_3 = prior("BN1.3", 547, 102 + 99, 22, 4);
const BN1_4 = prior("BN1.4", 349, 6 + 42, 8, 2);
const termsOf = (estimate: ReturnType<typeof destroyEstimate>) =>
  Object.fromEntries(estimate.terms.map((term) => [term.term, min(term.ms)]));

describe("each term's cases (#360)", () => {
  test("A: the BitNode's mean t·(N − c)/c; 0 once met or The Red Pill installed; the prior's at c = 0; none without", () => {
    const mean = destroyEstimate(inputs(87, 5, { prior: BN1_2 }));
    expect(min(mean.terms[0]?.ms ?? null)).toBeCloseTo((87 * 25) / 5, 9);
    expect(mean.terms[0]).toMatchObject({ term: "A", label: "either way", atLeast: false });
    expect(mean.terms[0]?.source).toBe("the BitNode's mean: 5 of 30 in its time online so far");
    expect(destroyEstimate(inputs(547, 32)).terms[0]).toMatchObject({ ms: 0, label: "done", atLeast: false });
    expect(destroyEstimate(inputs(547, 30)).terms[0]).toMatchObject({ ms: 0, label: "done" });
    expect(destroyEstimate(inputs(600, 1, { redPillInstalled: true })).terms[0]).toMatchObject({ ms: 0 });
    expect(destroyEstimate(inputs(0, 0, { prior: BN1_2 })).terms[0]).toMatchObject({
      ms: 570 * MINUTE,
      source: "the prior's (BN1.2)",
      atLeast: false,
    });
    // A count at a time online of 0 (none seen yet): the prior's, never 0.
    expect(destroyEstimate(inputs(0, 3, { prior: BN1_2 })).terms[0]?.ms).toBe(570 * MINUTE);
    const noPrior = destroyEstimate(inputs(0, 0));
    expect(noPrior.terms.map((term) => term.ms)).toEqual([null, null, null]);
    expect(noPrior).toMatchObject({ atLeast: true, never: false, remainingMs: 0, totalMs: 0 });
    expect(noPrior.terms.every((term) => term.label === "optimistic")).toBe(true);
  });

  test("BC before the join: the prior's B + C less the time since the count was met, never under its Red Pill cycle", () => {
    expect(min(destroyEstimate(inputs(300, 10, { prior: BN1_2 })).terms[1]?.ms ?? null)).toBe(100);
    const met = (t: number) => inputs(t, 31, { prior: BN1_2, countMetOnlineMs: 547 * MINUTE });
    expect(min(destroyEstimate(met(547)).terms[1]?.ms ?? null)).toBe(100);
    expect(min(destroyEstimate(met(587)).terms[1]?.ms ?? null)).toBe(60);
    expect(min(destroyEstimate(met(647)).terms[1]?.ms ?? null)).toBe(18);
    expect(destroyEstimate(met(647)).terms[1]).toMatchObject({ label: "either way", atLeast: false });
    expect(destroyEstimate(inputs(547, 31, { countMetOnlineMs: 0 })).terms[1]).toMatchObject({
      ms: null,
      atLeast: true,
    });
  });

  test("BC once joined: A5's hold ETA plus the prior's Red Pill cycle, cautious; at least with no prior's cycle", () => {
    const joined = (fields: Partial<DestroyEstimateInputs>) =>
      destroyEstimate(inputs(650, 37, { daedalus: "joined", countMetOnlineMs: 547 * MINUTE, ...fields })).terms[1];
    expect(joined({ holdEtaMs: 114 * MINUTE, prior: BN1_2 })).toMatchObject({
      ms: (114 + 18) * MINUTE,
      atLeast: false,
      label: "cautious",
    });
    expect(joined({ holdEtaMs: 114 * MINUTE })).toMatchObject({ ms: 114 * MINUTE, atLeast: true, label: "cautious" });
    // Joined with no hold's ETA (the brain's faction work off): the prior's, as before the join.
    expect(joined({ holdEtaMs: null, prior: BN1_2 })).toMatchObject({ ms: Math.max(100 - 103, 18) * MINUTE });
    expect(joined({ holdEtaMs: null, prior: BN1_2 })?.source).toContain("joined, no hold's ETA");
  });

  test("BC after the donations install: the prior's Red Pill cycle alone; 0 once The Red Pill is installed", () => {
    const after = { daedalus: "donations installed", holdEtaMs: 50 * MINUTE } as const;
    expect(destroyEstimate(inputs(700, 37, { ...after, prior: BN1_2 })).terms[1]).toMatchObject({ ms: 18 * MINUTE });
    expect(destroyEstimate(inputs(700, 37, after)).terms[1]).toMatchObject({ ms: null, atLeast: true });
    expect(destroyEstimate(inputs(720, 38, { ...after, redPillInstalled: true })).terms[1]).toMatchObject({
      ms: 0,
      label: "done",
    });
  });

  test("D: levelling's chosen estimate once The Red Pill is installed; else the prior's at the same level only", () => {
    const installed = { redPillInstalled: true, prior: BN1_2 };
    expect(destroyEstimate(inputs(720, 38, { ...installed, levellingMs: 9 * MINUTE })).terms[2]).toMatchObject({
      ms: 9 * MINUTE,
      source: "levelling's chosen candidate (#336)",
    });
    // Before levelling's first choice: the prior's, and said so.
    expect(destroyEstimate(inputs(720, 38, installed)).terms[2]).toMatchObject({
      ms: 3 * MINUTE,
      atLeast: false,
      source: "the prior's (BN1.2), levelling not yet chosen",
    });
    // A prior whose D came before levelling (BN4.1's 419 min, 409 at the money pace): cautious.
    const preLevelling = { ...prior("BN4.1", 1023, 182, 20, 419, 9000), dBeforeLevelling: true };
    expect(
      destroyEstimate(inputs(0, 0, { currentNode: 4, ownedSF: { 1: 3, 4: 1 }, prior: preLevelling })).terms[2],
    ).toMatchObject({
      ms: 419 * MINUTE,
      label: "cautious",
      source: "the prior's (BN4.1), pre-#336 (levelling chosen late, or not, after its Red Pill): cautious",
    });
    // BN4 (9,000) from BN1's prior (3,000): none, and the total at least.
    const bn4 = destroyEstimate(inputs(0, 0, { currentNode: 4, ownedSF: { 1: 3 }, prior: BN1_4 }));
    expect(bn4.terms[2]).toMatchObject({
      ms: null,
      atLeast: true,
      label: "optimistic",
      source: "the prior's (BN1.4) at level 3000, not 9000: none",
    });
    expect(bn4).toMatchObject({ requiredLevel: 9000, atLeast: true });
    const bn4Prior = prior("BN4.1", 1023, 182, 20, 419, 9000);
    expect(
      destroyEstimate(inputs(0, 0, { currentNode: 4, ownedSF: { 1: 3, 4: 1 }, prior: bn4Prior })).terms[2],
    ).toMatchObject({ ms: 419 * MINUTE, atLeast: false });
  });

  test("a term that's never (a rate of 0) makes the estimate never, its remaining infinite", () => {
    const hold = destroyEstimate(
      inputs(650, 37, { daedalus: "joined", holdEtaMs: Number.POSITIVE_INFINITY, prior: BN1_2 }),
    );
    expect(hold).toMatchObject({ never: true, remainingMs: Number.POSITIVE_INFINITY });
    const level = destroyEstimate(
      inputs(720, 38, { redPillInstalled: true, levellingMs: Number.POSITIVE_INFINITY, prior: BN1_2 }),
    );
    expect(level.never).toBe(true);
    expect(destroyEstimate(inputs(720, 38, { redPillInstalled: true, levellingMs: 60_000 })).never).toBe(false);
  });

  test("the total: the time online so far plus the remaining; N and the level are the BitNode's", () => {
    const estimate = destroyEstimate(inputs(87, 5, { prior: BN1_2 }));
    expect(min(estimate.remainingMs)).toBeCloseTo(435 + 100 + 3, 9);
    expect(min(estimate.totalMs)).toBeCloseTo(87 + 538, 9);
    expect(estimate).toMatchObject({ atLeast: false, never: false, required: 30, requiredLevel: 3000 });
    // BN12's N and level grow with it (`BitNode.tsx:924-929`, `:993`).
    expect(destroyEstimate(inputs(0, 0, { currentNode: 12, ownedSF: { 12: 9 } }))).toMatchObject({
      required: Math.floor(30 + 1.02 ** 10),
      requiredLevel: 3000 * 1.02 ** 10,
    });
  });
});

/**
 * Each cycle of the four BitNodes (install timing's tables, #343): its online minutes, and Daedalus's count at its
 * start (the other augmentations installed, and NeuroFlux Governor once).
 */
const CYCLES = {
  "BN1.2": { online: [39, 56, 75, 95, 123, 124, 31, 27, 81, 18, 2], counts: [0, 3, 5, 10, 17, 21, 25, 29, 31, 32, 36] },
  "BN1.3": { online: [37, 50, 70, 141, 18, 93, 138, 85, 92, 22, 4], counts: [0, 3, 5, 10, 14, 18, 23, 32, 37, 37, 41] },
  "BN1.4": {
    online: [34, 38, 32, 17, 18, 19, 18, 19, 47, 37, 31, 17, 22, 39, 8, 2],
    counts: [0, 3, 14, 15, 15, 15, 16, 17, 17, 19, 22, 25, 27, 36, 37, 41],
  },
  "BN4.1": {
    online: [140, 121, 128, 136, 219, 125, 154, 36, 125, 20, 409],
    counts: [0, 4, 5, 7, 11, 15, 23, 32, 36, 37, 41],
  },
};
/** A's ratio, estimated over what was left, at each install short of the count: the issue's, to two places. */
const A_RATIOS = {
  "BN1.2": [0.66, 1.0, 0.85, 0.66, 0.91, 1.77, 0.69],
  "BN1.3": [0.65, 0.95, 0.81, 1.37, 0.91, 0.9],
  "BN1.4": [0.97, 0.3, 0.42, 0.53, 0.66, 0.72, 0.78, 0.97, 1.31, 1.45, 1.59, 1.65],
  "BN4.1": [1.03, 1.71, 2.02, 1.82, 2.67, 1.72],
};
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

describe("golden cases from the store's tables (#360)", () => {
  test("A at every install of BN1.2-BN4.1: within ×2 of what was left at 27 of 31, within 0.8-1.25 at 10", () => {
    const all: number[] = [];
    for (const [name, { online, counts }] of Object.entries(CYCLES)) {
      const currentNode = Number(name[2]);
      const met = counts.findIndex((count) => count >= 30);
      const actualA = sum(online.slice(0, met));
      const ratios = counts.slice(1, met).map((count, index) => {
        const t = sum(online.slice(0, index + 1));
        const estimate = destroyEstimate({ ...inputs(t, count), currentNode, ownedSF: { 1: 2 } });
        expect(estimate.terms[0]?.label).toBe("either way");
        return (estimate.terms[0]?.ms ?? Number.NaN) / ((actualA - t) * MINUTE);
      });
      expect(
        ratios.map((ratio) => Number(ratio.toFixed(2))),
        name,
      ).toEqual(A_RATIOS[name as keyof typeof A_RATIOS]);
      all.push(...ratios);
    }
    // The issue's named ones: BN1.3 c3 0.95, BN1.4 c3 0.30 (after c2's 11), BN4.1 c6 2.67.
    expect(all).toHaveLength(31);
    expect(all.filter((ratio) => ratio >= 0.5 && ratio <= 2)).toHaveLength(27);
    expect(all.filter((ratio) => ratio >= 0.8 && ratio <= 1.25)).toHaveLength(10);
  });

  test("BN1.2: A alone, its prior (BN1.1) not in the findings: the rest none, the total at least", () => {
    const estimate = destroyEstimate(inputs(39 + 56, 5));
    expect(termsOf(estimate)).toEqual({ A: (95 * 25) / 5, BC: null, D: null });
    expect(estimate.atLeast).toBe(true);
  });

  /** The whole estimate at a moment against the actual remaining (the BitNode's online less t), to two places. */
  const ratio = (estimate: ReturnType<typeof destroyEstimate>, online: number, t: number) =>
    Number((estimate.remainingMs / ((online - t) * MINUTE)).toFixed(2));

  test("BN1.3 (prior BN1.2): its start, count met and join against its 756 minutes", () => {
    const start = destroyEstimate(inputs(0, 0, { prior: BN1_2 }));
    expect(termsOf(start)).toEqual({ A: 570, BC: 100, D: 3 });
    expect(ratio(start, 756, 0)).toBe(0.89);
    const met = destroyEstimate(inputs(547, 32, { prior: BN1_2, countMetOnlineMs: 547 * MINUTE }));
    expect(termsOf(met)).toEqual({ A: 0, BC: 100, D: 3 });
    expect(ratio(met, 756, 547)).toBe(0.49);
    // Joined 102 + 1 minutes after: A5's ETA then, as the store has it and the brain's hindcast reads it (184 min: the
    // share not yet running at the choice; with it, 114).
    const joined = destroyEstimate(
      inputs(650, 37, { prior: BN1_2, countMetOnlineMs: 547 * MINUTE, daedalus: "joined", holdEtaMs: 184 * MINUTE }),
    );
    expect(termsOf(joined)).toEqual({ A: 0, BC: 184 + 18, D: 3 });
    expect(ratio(joined, 756, 650)).toBe(1.93);
    expect([start, met, joined].map((each) => each.atLeast)).toEqual([false, false, false]);
  });

  test("BN1.4 (prior BN1.3): its start, count met and join against its 406 minutes", () => {
    const start = destroyEstimate(inputs(0, 0, { prior: BN1_3 }));
    expect(termsOf(start)).toEqual({ A: 547, BC: 201, D: 4 });
    expect(ratio(start, 406, 0)).toBe(1.85);
    const met = destroyEstimate(inputs(349, 36, { prior: BN1_3, countMetOnlineMs: 349 * MINUTE }));
    expect(termsOf(met)).toEqual({ A: 0, BC: 201, D: 4 });
    expect(ratio(met, 406, 349)).toBe(3.6);
    const joined = destroyEstimate(
      inputs(356, 36, { prior: BN1_3, countMetOnlineMs: 349 * MINUTE, daedalus: "joined", holdEtaMs: 35 * MINUTE }),
    );
    // A5's ETA then, as stored: 35 min.
    expect(termsOf(joined)).toEqual({ A: 0, BC: 35 + 22, D: 4 });
    expect(ratio(joined, 406, 356)).toBe(1.22);
  });

  test("BN4.1 (prior BN1.4, none of BN4 before): D none at 9,000, the total at least, against its 1,624 minutes", () => {
    const bn4 = { currentNode: 4, ownedSF: { 1: 3 }, prior: BN1_4 };
    const start = destroyEstimate(inputs(0, 0, bn4));
    expect(termsOf(start)).toEqual({ A: 349, BC: 48, D: null });
    expect(ratio(start, 1624, 0)).toBe(0.24);
    const met = destroyEstimate(inputs(1023, 32, { ...bn4, countMetOnlineMs: 1023 * MINUTE }));
    expect(termsOf(met)).toEqual({ A: 0, BC: 48, D: null });
    expect(ratio(met, 1624, 1023)).toBe(0.08);
    const joined = destroyEstimate(
      inputs(1083, 36, { ...bn4, countMetOnlineMs: 1023 * MINUTE, daedalus: "joined", holdEtaMs: 165 * MINUTE }),
    );
    // A5's ETA then, as stored: 165 min.
    expect(termsOf(joined)).toEqual({ A: 0, BC: 165 + 8, D: null });
    expect(ratio(joined, 1624, 1083)).toBe(0.32);
    expect([start, met, joined].every((each) => each.atLeast)).toBe(true);
  });
});
