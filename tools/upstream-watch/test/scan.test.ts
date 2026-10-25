import { describe, expect, test } from "vitest";
import { closingIndex, splitTopLevel, stripComments } from "../src/scan.ts";

describe("stripComments", () => {
  test("removes line and block comments, keeping line breaks", () => {
    expect(stripComments("a; // note\n/* block\nmore */ b;")).toBe("a; \n\n b;");
  });

  test("leaves comment-like text inside strings and template literals alone", () => {
    const source = `const url = "http://x"; const t = \`/* not \${a} */\`; const s = '//';`;
    expect(stripComments(source)).toBe(source);
  });

  test("handles escaped quotes inside strings", () => {
    expect(stripComments(`"a \\" // b" // c`)).toBe(`"a \\" // b" `);
  });
});

describe("closingIndex", () => {
  test("finds the bracket that closes the one at the index, skipping strings", () => {
    const text = `{ a: "}", b: { c: [1, 2] } } tail`;
    expect(closingIndex(text, 0)).toBe(text.indexOf(" tail") - 1);
    expect(closingIndex(text, text.indexOf("["))).toBe(text.indexOf("]"));
  });

  test("throws on an unbalanced bracket", () => {
    expect(() => closingIndex("{ a: (", 0)).toThrow(/unbalanced/);
  });
});

describe("splitTopLevel", () => {
  test("splits on the separator outside brackets and strings, trimming and dropping empty parts", () => {
    expect(splitTopLevel(`a: 1, b: f(1, 2), c: { d: 3, e: ";," }, `, ",")).toEqual([
      "a: 1",
      "b: f(1, 2)",
      `c: { d: 3, e: ";," }`,
    ]);
  });

  test("an arrow's > isn't a bracket", () => {
    expect(splitTopLevel("f: () => void; g: number", ";")).toEqual(["f: () => void", "g: number"]);
  });
});
