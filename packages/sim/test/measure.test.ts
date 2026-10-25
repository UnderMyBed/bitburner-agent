import { expect, test } from "vitest";
import { heapUsed } from "../src/host/measure.ts";

test("collecting garbage for a heap reading doesn't put gc where player scripts could see it", () => {
  expect(heapUsed()).toBeGreaterThan(0);
  expect("gc" in globalThis).toBe(false);
});
