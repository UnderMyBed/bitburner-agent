// Rotating save backups (#92): the game's own save over the Remote File API, validated, filed under its environment,
// and rotated, on every RFA connection and every interval. Against the fake game and a hand-moved clock.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { FakeRfaGame, ManualClock, steamSaveFile } from "@bitburner-agent/bridge/test-helpers";
import { afterEach, beforeEach, expect, test } from "vitest";
import { type SaveBackupEvent, SaveBackups } from "../src/save-backups.ts";

const THIRTY_MINUTES_MS = 30 * 60_000;
let dataDirectory: string;
let clock: ManualClock;
beforeEach(() => {
  dataDirectory = mkdtempSync(path.join(os.tmpdir(), "save-backups-"));
  clock = new ManualClock(Date.UTC(2026, 9, 26, 12, 0, 0, 0));
});
afterEach(() => rmSync(dataDirectory, { recursive: true, force: true }));

const steamDirectory = () => path.join(dataDirectory, "saves", "E0");
const filesIn = (directory: string) => readdirSync(directory).sort();

function startBackups({ kept = 96 }: { kept?: number } = {}) {
  const backups = new SaveBackups({ directory: steamDirectory(), intervalMs: THIRTY_MINUTES_MS, kept, clock });
  const events: SaveBackupEvent[] = [];
  backups.subscribe((event) => events.push(event));
  return { backups, events };
}

/** Lets the fake game's replies (microtasks) and the backup's own awaits run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("on each RFA connection a backup is taken: the game's own bytes, filed as <UTC time>.json.gz", async () => {
  const { backups, events } = startBackups();
  const game = new FakeRfaGame();
  game.saveFile = steamSaveFile('{"ctor":"BitburnerSaveObject","data":{"PlayerSave":"x"}}');
  backups.accept(game);
  await settle();
  const fileName = "2026-10-26T12-00-00.000Z.json.gz";
  expect(filesIn(steamDirectory())).toEqual([fileName]);
  const bytes = readFileSync(path.join(steamDirectory(), fileName));
  expect(bytes.equals(Buffer.from(game.saveFile.save, "latin1"))).toBe(true);
  expect(events).toEqual([
    { type: "saveBackup", atMs: clock.now(), file: path.join(steamDirectory(), fileName), sizeBytes: bytes.length },
  ]);
});

test("every interval another backup is taken, over the newest connection", async () => {
  const { backups, events } = startBackups();
  const older = new FakeRfaGame();
  const newer = new FakeRfaGame();
  backups.accept(older);
  backups.accept(newer);
  await settle();
  clock.advance(THIRTY_MINUTES_MS);
  await settle();
  clock.advance(THIRTY_MINUTES_MS);
  await settle();
  // The newer connection's own backup followed the older one's, rather than being lost to it; both are at 12:00, so
  // the newer replaces the older's file.
  expect(newer.requests.filter((request) => request === "getSaveFile")).toHaveLength(3);
  expect(older.requests.filter((request) => request === "getSaveFile")).toHaveLength(1);
  expect(events).toHaveLength(4);
  expect(filesIn(steamDirectory())).toEqual([
    "2026-10-26T12-00-00.000Z.json.gz",
    "2026-10-26T12-30-00.000Z.json.gz",
    "2026-10-26T13-00-00.000Z.json.gz",
  ]);
  expect(events.every((event) => "file" in event)).toBe(true);
});

test("rotation keeps the newest N in this environment, and touches nothing else", async () => {
  const otherEnvironment = path.join(dataDirectory, "saves", "E2");
  mkdirSync(otherEnvironment, { recursive: true });
  writeFileSync(path.join(otherEnvironment, "2026-01-01T00-00-00.000Z.json.gz"), "theirs");
  mkdirSync(steamDirectory(), { recursive: true });
  writeFileSync(path.join(steamDirectory(), "keep-me.json.gz"), "the owner's");
  const { backups } = startBackups({ kept: 3 });
  backups.accept(new FakeRfaGame());
  await settle();
  for (let interval = 0; interval < 4; interval++) {
    clock.advance(THIRTY_MINUTES_MS);
    await settle();
  }
  expect(filesIn(steamDirectory())).toEqual([
    "2026-10-26T13-00-00.000Z.json.gz",
    "2026-10-26T13-30-00.000Z.json.gz",
    "2026-10-26T14-00-00.000Z.json.gz",
    "keep-me.json.gz",
  ]);
  expect(filesIn(otherEnvironment)).toEqual(["2026-01-01T00-00-00.000Z.json.gz"]);
});

test.each([
  [
    "a save sent as text (binary: false), from a page that isn't Steam's",
    { identifier: "x", binary: false, save: "eyJjdG9yIjoi" },
    "the game sent its save as text (binary: false), not Steam's gzip bytes",
  ],
  [
    "characters that aren't bytes",
    { identifier: "x", binary: true, save: "Ā" },
    "the save isn't one byte per character",
  ],
  ["bytes that don't gunzip", { identifier: "x", binary: true, save: "not gzip" }, "the save doesn't gunzip"],
  [
    "a gzip that isn't JSON",
    { identifier: "x", binary: true, save: gzipSync("{ not json").toString("latin1") },
    "the save isn't JSON",
  ],
  [
    "JSON that isn't a Bitburner save",
    { identifier: "x", binary: true, save: gzipSync('{"ctor":"Something"}').toString("latin1") },
    "the save isn't a BitburnerSaveObject",
  ],
])("a damaged save (%s) isn't kept, and the failure is recorded", async (_description, saveFile, reason) => {
  const { backups, events } = startBackups();
  const game = new FakeRfaGame();
  game.saveFile = saveFile;
  backups.accept(game);
  await settle();
  expect(readdirSync(dataDirectory)).not.toContain("saves");
  expect(events).toEqual([{ type: "saveBackup", atMs: clock.now(), failure: expect.stringContaining(reason) }]);
});

test("with no connection, or one that drops, the backup fails and is recorded", async () => {
  const { backups, events } = startBackups();
  clock.advance(THIRTY_MINUTES_MS);
  await settle();
  const game = new FakeRfaGame();
  game.dropAtRequest = 1;
  backups.accept(game);
  await settle();
  expect(events).toEqual([
    { type: "saveBackup", atMs: expect.any(Number), failure: "no Remote File API connection" },
    { type: "saveBackup", atMs: expect.any(Number), failure: "getSaveFile: the connection closed" },
  ]);
});

test("one backup at a time: one asked for while another waits for the game follows it", async () => {
  const { backups, events } = startBackups();
  const game = new FakeRfaGame();
  game.silentAtRequest = 1;
  backups.accept(game);
  await settle();
  // The interval's backup is due while the first still waits (its timeout fires in the same advance).
  clock.advance(THIRTY_MINUTES_MS);
  expect(game.requests).toEqual(["getSaveFile"]);
  await settle();
  expect(game.requests).toEqual(["getSaveFile", "getSaveFile"]);
  expect(events).toEqual([
    { type: "saveBackup", atMs: expect.any(Number), failure: "getSaveFile: no reply within 30 s" },
    { type: "saveBackup", atMs: expect.any(Number), file: expect.any(String), sizeBytes: expect.any(Number) },
  ]);
});
