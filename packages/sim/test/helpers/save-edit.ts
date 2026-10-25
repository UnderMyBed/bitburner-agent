import { gunzipSync, gzipSync } from "node:zlib";

// biome-ignore lint/suspicious/noExplicitAny: a save's parts are untyped JSON; tests reach into them by path.
type SaveParts = Record<string, any>;

/**
 * Re-encodes a save after editing it, to build test fixtures the game can't easily reach on its own (a finished
 * BitNode, a Source-File). `edit` gets the save's parts (PlayerSave, AllServersSave…) already parsed. Test-only:
 * edited saves never leave the simulator.
 */
export function editSave(bytes: Uint8Array, edit: (parts: SaveParts) => void): Uint8Array {
  const outer = JSON.parse(gunzipSync(bytes).toString("utf8")) as { data: Record<string, string> };
  const parts: SaveParts = {};
  for (const [key, value] of Object.entries(outer.data)) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "object" && parsed !== null) parts[key] = parsed;
    } catch {
      // not JSON: left as it is
    }
  }
  edit(parts);
  for (const [key, value] of Object.entries(parts)) outer.data[key] = JSON.stringify(value);
  return new Uint8Array(gzipSync(JSON.stringify(outer)));
}

/** Gives the player Source-File 4.3 (Singularity functions at their base RAM cost) and 1 TB of home RAM to run them. */
export function withSingularity(bytes: Uint8Array): Uint8Array {
  return editSave(bytes, ({ PlayerSave, AllServersSave }) => {
    PlayerSave.data.sourceFiles.data.push([4, 3]);
    AllServersSave.home.data.maxRam = 1024;
  });
}

/** Marks the BitNode as finished, as backdooring w0r1d_d43m0n does (`finishBitNode`). */
export function withBitNodeFinished(bytes: Uint8Array): Uint8Array {
  return editSave(bytes, ({ AllServersSave }) => {
    AllServersSave.w0r1d_d43m0n.data.backdoorInstalled = true;
  });
}
