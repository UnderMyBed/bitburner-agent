import { expect, test } from "vitest";
import { pinDefaultLocale, pinnedLocale } from "../src/host/locale.ts";

// pinDefaultLocale replaces this test file's own built-ins; Vitest isolates test files from each other.
// German is used because its formats differ visibly from English whatever this machine's own locale is.
pinDefaultLocale("de-DE");

test("locale-sensitive calls without a locale use the pinned one", () => {
  const date = new Date(Date.UTC(2026, 0, 2, 15, 4, 5));
  expect((1234.5).toLocaleString()).toBe("1.234,5");
  expect(date.toLocaleDateString(undefined, { timeZone: "UTC" })).toBe("2.1.2026");
  expect(date.toLocaleTimeString(undefined, { timeZone: "UTC" })).toBe("15:04:05");
  expect(date.toLocaleString(undefined, { timeZone: "UTC" })).toBe("2.1.2026, 15:04:05");
  expect(new Intl.NumberFormat().format(1234.5)).toBe("1.234,5");
  expect(new Intl.DateTimeFormat().resolvedOptions().locale).toBe("de-DE");
  expect(Intl.NumberFormat().resolvedOptions().locale).toBe("de-DE"); // called without `new`
});

test("reports the pinned locale", () => {
  expect(pinnedLocale()).toBe("de-DE");
});

test("an explicit locale still wins", () => {
  expect((1234.5).toLocaleString("en-US")).toBe("1,234.5");
  expect(new Intl.NumberFormat(["en", "de"]).format(1234.5)).toBe("1,234.5");
});
