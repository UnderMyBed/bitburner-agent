import { describe, expect, test } from "vitest";
import { sfc32 } from "../src/host/rng.ts";

/**
 * Independent reference for sfc32 (Chris Doty-Humphrey's "small fast chaotic" PRNG, from PractRand), written with
 * BigInt and explicit 32-bit masking rather than JS int32 tricks, plus the same splitmix32 seeding. Used to check
 * that the fast implementation computes the published algorithm.
 */
function referenceSfc32(seed: number): () => number {
  const M = 0xffffffffn;
  let s = BigInt(seed >>> 0);
  const splitmix32 = () => {
    s = (s + 0x9e3779b9n) & M;
    let z = s;
    z = ((z ^ (z >> 16n)) * 0x21f0aaadn) & M;
    z = ((z ^ (z >> 15n)) * 0x735a2d97n) & M;
    return (z ^ (z >> 15n)) & M;
  };
  let a = splitmix32();
  let b = splitmix32();
  let c = splitmix32();
  let d = splitmix32();
  const next = () => {
    const t = (a + b + d) & M;
    d = (d + 1n) & M;
    a = b ^ (b >> 9n);
    b = (c + (c << 3n)) & M;
    c = ((c << 21n) | (c >> 11n)) & M;
    c = (c + t) & M;
    return Number(t) / 2 ** 32;
  };
  for (let i = 0; i < 12; i++) next();
  return next;
}

describe("sfc32", () => {
  test.each([0, 1, 42, 0xdeadbeef, 2 ** 32 - 1])("matches the reference implementation for seed %d", (seed) => {
    const fast = sfc32(seed);
    const reference = referenceSfc32(seed);
    for (let i = 0; i < 1000; i++) expect(fast()).toBe(reference());
  });

  // Frozen outputs: every seeded scenario depends on this stream. Changing it is a deliberate, visible break.
  test("produces the recorded stream for seed 1", () => {
    const rng = sfc32(1);
    expect(Array.from({ length: 4 }, () => rng())).toMatchInlineSnapshot(`
      [
        0.263228221796453,
        0.6034020676743239,
        0.7019734452478588,
        0.22371549904346466,
      ]
    `);
  });

  test("gives different streams for different seeds, all in [0, 1)", () => {
    const a = sfc32(1);
    const b = sfc32(2);
    const xs = Array.from({ length: 100 }, () => a());
    const ys = Array.from({ length: 100 }, () => b());
    expect(xs).not.toEqual(ys);
    for (const x of [...xs, ...ys]) expect(x >= 0 && x < 1).toBe(true);
  });
});
