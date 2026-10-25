import { describe, expect, test } from "vitest";
import { closingIndex, normalize, splitTopLevel, stripComments, topLevelIndex } from "../src/scan.ts";

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

describe("normalize", () => {
  test("collapses whitespace and drops it inside brackets and before a closing one, with a trailing separator", () => {
    expect(normalize("{\n  a: number;\n  b: ( x ,  y );\n}")).toBe("{a: number; b: (x, y)}");
  });

  test("leaves string contents alone, so a changed string value still compares different", () => {
    expect(normalize('x:  "a  b" | "( c )" ;')).toBe('x: "a  b" | "( c )";');
  });
});

describe("topLevelIndex", () => {
  test("skips what's inside generics' angle brackets, but not an arrow's >", () => {
    const iface = "interface Foo<T extends { a: number }> { x: T }";
    expect(topLevelIndex(iface, "{")).toBe(iface.lastIndexOf("{"));
    const alias = "type X<T = string> = { a: T }";
    expect(topLevelIndex(alias, "=")).toBe(alias.lastIndexOf("= {"));
    const defaults = "type X<F = () => void, G = 1> = { a: 1 }";
    expect(topLevelIndex(defaults, "=")).toBe(defaults.lastIndexOf("= {"));
    const arrow = "type F = () => void; next";
    expect(topLevelIndex(arrow, ";")).toBe(arrow.indexOf(";"));
  });

  test("skips brackets and strings, starts where asked, and is -1 if there's none", () => {
    expect(topLevelIndex(`a(";") "x;" [;];b`, ";")).toBe(15);
    expect(topLevelIndex("a;b;c", ";", 2)).toBe(3);
    expect(topLevelIndex("abc", ";")).toBe(-1);
  });
});
