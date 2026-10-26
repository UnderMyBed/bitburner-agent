// Turns the public SimulationOptions into what the host receives: the epoch decided and a save fixture read.
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import {
  type HostFixture,
  type HostOptions,
  type SaveFixture,
  type SimulationOptions,
  validateHostOptions,
} from "./protocol.ts";

export function resolveOptions(options: SimulationOptions): HostOptions {
  const { fixture, epochMs, ...rest } = options;
  if (fixture?.kind !== "save") {
    if (epochMs === undefined) throw new RangeError("epochMs is required (except with a save fixture)");
    const resolved: HostOptions = { ...rest, epochMs, ...(fixture ? { fixture } : {}) };
    validateHostOptions(resolved);
    return resolved;
  }

  if (epochMs !== undefined) {
    throw new RangeError("a save fixture takes its epoch from the save: don't pass epochMs (use offlineMs instead)");
  }
  const offlineMs = fixture.offlineMs ?? 0;
  if (!Number.isSafeInteger(offlineMs) || offlineMs < 0) {
    throw new RangeError(`offlineMs must be a non-negative integer, got ${offlineMs}`);
  }
  const bytes = readSaveBytes(fixture);
  const { hostFixture, json } = parseSaveFile(bytes);
  const lastUpdate = playerLastUpdate(json);
  const resolved: HostOptions = { ...rest, epochMs: lastUpdate + offlineMs, fixture: hostFixture };
  validateHostOptions(resolved);
  return resolved;
}

function readSaveBytes(fixture: SaveFixture): Uint8Array {
  // The type allows only one of them; plain JavaScript callers (e.g. a JSON scenario) get a clear error instead.
  if ((fixture.bytes === undefined) === (fixture.path === undefined)) {
    throw new RangeError("a save fixture needs exactly one of bytes or path");
  }
  return fixture.bytes ?? readFileSync(fixture.path as string);
}

/** The game writes saves as gzip bytes (Steam/Electron `.json.gz`) or, in the web build's export, as base64 text. */
function parseSaveFile(bytes: Uint8Array): { hostFixture: HostFixture; json: string } {
  const isGzip = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  if (isGzip) {
    let json: string;
    try {
      json = gunzipSync(bytes).toString("utf8");
    } catch (error) {
      throw new Error(`Not a valid .json.gz save (gzip: ${(error as Error).message})`);
    }
    return { hostFixture: { kind: "save", format: "gzip", data: Buffer.from(bytes).toString("base64") }, json };
  }
  if (bytes[0] === 0x7b /* "{" */) {
    throw new Error("A save must be gzip bytes (.json.gz) or the web build's base64 export, not plain JSON");
  }
  const text = Buffer.from(bytes).toString("utf8").trim();
  return {
    hostFixture: { kind: "save", format: "base64", data: text },
    json: Buffer.from(text, "base64").toString("utf8"),
  };
}

/** `Player.lastUpdate` from a save's JSON: the moment it was taken, which becomes the simulation's epoch. */
export function playerLastUpdate(json: string): number {
  try {
    const save = JSON.parse(json) as { ctor?: string; data?: { PlayerSave?: string } };
    const player = JSON.parse(save.data?.PlayerSave ?? "") as { data?: { lastUpdate?: number } };
    const lastUpdate = player.data?.lastUpdate;
    if (save.ctor === "BitburnerSaveObject" && Number.isSafeInteger(lastUpdate) && (lastUpdate as number) >= 0) {
      return lastUpdate as number;
    }
  } catch {
    // reported below
  }
  throw new Error("Not a Bitburner save: expected a BitburnerSaveObject with the player's lastUpdate");
}
