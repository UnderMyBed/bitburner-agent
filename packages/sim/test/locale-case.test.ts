import { expect, test } from "vitest";
import { pinDefaultLocale } from "../src/host/parity/locale.ts";

// Turkish casing differs from every other default ("i" upper-cases to dotted "İ"), so these only pass if the pin
// applies. A separate file, because Vitest isolates each file's globals and locale.test.ts pins German.
pinDefaultLocale("tr-TR");

test("case conversion uses the pinned locale", () => {
  expect("i".toLocaleUpperCase()).toBe("İ");
  expect("I".toLocaleLowerCase()).toBe("ı");
});

test("comparison uses the pinned locale", () => {
  // In Turkish collation "ı" (dotless) sorts before "i"; most other locales put "i" first.
  expect("ı".localeCompare("i")).toBeLessThan(0);
});
