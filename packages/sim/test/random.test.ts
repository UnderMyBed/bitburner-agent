import { beforeEach, describe, expect, test } from "vitest";
import { installSeededRandom } from "../src/host/random.ts";
import { sfc32 } from "../src/host/rng.ts";

// installSeededRandom replaces this test file's own globals; Vitest isolates test files from each other.
describe("installSeededRandom", () => {
  beforeEach(() => installSeededRandom(7));

  test("Math.random is sfc32 seeded with the seed", () => {
    const expected = sfc32(7);
    for (let i = 0; i < 100; i++) expect(Math.random()).toBe(expected());
  });

  test("drawing crypto randomness doesn't shift the Math.random stream", () => {
    const expected = sfc32(7);
    expect(Math.random()).toBe(expected());
    crypto.getRandomValues(new Uint8Array(1000));
    crypto.randomUUID();
    for (let i = 0; i < 10; i++) expect(Math.random()).toBe(expected());
  });

  test("getRandomValues fills exactly the view it is given, for any integer typed array", () => {
    const buffer = new Uint32Array(8);
    const view = buffer.subarray(2, 6);
    expect(crypto.getRandomValues(view)).toBe(view);
    expect([buffer[0], buffer[1], buffer[6], buffer[7]]).toEqual([0, 0, 0, 0]);
    expect(Array.from(view).some((x) => x !== 0)).toBe(true);
    expect(() => crypto.getRandomValues(new BigUint64Array(2))).not.toThrow();
  });

  test("getRandomValues is deterministic from the seed", () => {
    const first = Array.from(crypto.getRandomValues(new Uint8Array(32)));
    installSeededRandom(7);
    expect(Array.from(crypto.getRandomValues(new Uint8Array(32)))).toEqual(first);
    installSeededRandom(8);
    expect(Array.from(crypto.getRandomValues(new Uint8Array(32)))).not.toEqual(first);
  });

  test("getRandomValues keeps Web Crypto's errors", () => {
    expect(() => crypto.getRandomValues(new Float64Array(4) as unknown as Uint8Array<ArrayBuffer>)).toThrow(
      expect.objectContaining({ name: "TypeMismatchError" }),
    );
    expect(() => crypto.getRandomValues(null as unknown as Uint8Array<ArrayBuffer>)).toThrow(
      expect.objectContaining({ name: "TypeMismatchError" }),
    );
    expect(() => crypto.getRandomValues(new Uint8Array(65537))).toThrow(
      expect.objectContaining({ name: "QuotaExceededError" }),
    );
    expect(() => crypto.getRandomValues(new Uint8Array(65536))).not.toThrow();
  });

  test("randomUUID is a deterministic version 4 UUID", () => {
    const uuid = crypto.randomUUID();
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    installSeededRandom(7);
    expect(crypto.randomUUID()).toBe(uuid);
  });
});
