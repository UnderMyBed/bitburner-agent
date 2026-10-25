import { gunzipSync } from "node:zlib";

/**
 * The game's save is JSON whose `data` fields are themselves JSON strings (PlayerSave, AllServersSave…). Decodes a
 * save (gzip bytes) into one plain object, parsing those nested strings.
 */
export function decodeSave(bytes: Uint8Array): Record<string, unknown> {
  const outer = JSON.parse(gunzipSync(bytes).toString("utf8")) as { data: Record<string, string> };
  return Object.fromEntries(
    Object.entries(outer.data).map(([key, value]) => {
      try {
        return [key, JSON.parse(value)];
      } catch {
        return [key, value];
      }
    }),
  );
}

/** Paths (like `PlayerSave.data.money`) where two decoded saves differ. */
export function diffPaths(a: unknown, b: unknown, path = ""): string[] {
  if (Object.is(a, b)) return [];
  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    a === null ||
    b === null ||
    Array.isArray(a) !== Array.isArray(b)
  ) {
    return [path];
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].flatMap((key) =>
    diffPaths((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], path ? `${path}.${key}` : key),
  );
}
