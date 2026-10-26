// Rotating save backups (#92): the game's own save over the Remote File API, validated, filed under its environment,
// and rotated, on every RFA connection and every interval. Against the fake game and a hand-moved clock.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { FakeRfaGame, ManualClock, steamSaveFile } from "@bitburner-agent/bridge/test-helpers";
import { afterEach, beforeEach, expect, test } from "vitest";
import { MAX_BACKUP_INTERVAL_MS, type SaveBackupEvent, SaveBackups } from "../src/save-backups.ts";

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

function startBackups({ backupsKept = 96 }: { backupsKept?: number } = {}) {
  const backups = new SaveBackups({
    dataDirectory,
    environment: "E0",
    backupIntervalMs: THIRTY_MINUTES_MS,
    backupsKept,
    clock,
  });
  const events: SaveBackupEvent[] = [];
  backups.subscribe((event) => events.push(event));
  return { backups, events };
}

/** Lets the fake game's replies (microtasks) and the backup's own awaits run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Takes `count` more backups over `game`, one each interval. */
async function backupsEveryInterval(count: number): Promise<void> {
  for (let interval = 0; interval < count; interval++) {
    clock.advance(THIRTY_MINUTES_MS);
    await settle();
  }
}

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
  // The file relative to the data directory, so the store's records hold if the directory moves.
  expect(events).toEqual([
    { type: "saveBackup", atMs: clock.now(), file: `saves/E0/${fileName}`, sizeBytes: bytes.length },
  ]);
});

test("every interval another backup is taken, over the newest connection", async () => {
  const { backups, events } = startBackups();
  const older = new FakeRfaGame();
  const newer = new FakeRfaGame();
  backups.accept(older);
  // The newer connection's own backup follows the older one's, rather than being lost to it. Both are at 12:00, so
  // the newer's file replaces the older's.
  backups.accept(newer);
  await settle();
  await backupsEveryInterval(2);
  expect(older.requests.filter((request) => request === "getSaveFile")).toHaveLength(1);
  expect(newer.requests.filter((request) => request === "getSaveFile")).toHaveLength(3);
  expect(events).toHaveLength(4);
  expect(events.every((event) => "file" in event)).toBe(true);
  expect(filesIn(steamDirectory())).toEqual([
    "2026-10-26T12-00-00.000Z.json.gz",
    "2026-10-26T12-30-00.000Z.json.gz",
    "2026-10-26T13-00-00.000Z.json.gz",
  ]);
});

test("rotation keeps the newest N in this environment, and touches nothing else", async () => {
  const otherEnvironment = path.join(dataDirectory, "saves", "E2");
  mkdirSync(otherEnvironment, { recursive: true });
  writeFileSync(path.join(otherEnvironment, "2026-01-01T00-00-00.000Z.json.gz"), "theirs");
  mkdirSync(steamDirectory(), { recursive: true });
  writeFileSync(path.join(steamDirectory(), "keep-me.json.gz"), "the owner's");
  const { backups } = startBackups({ backupsKept: 3 });
  backups.accept(new FakeRfaGame());
  await settle();
  await backupsEveryInterval(4);
  expect(filesIn(steamDirectory())).toEqual([
    "2026-10-26T13-00-00.000Z.json.gz",
    "2026-10-26T13-30-00.000Z.json.gz",
    "2026-10-26T14-00-00.000Z.json.gz",
    "keep-me.json.gz",
  ]);
  expect(filesIn(otherEnvironment)).toEqual(["2026-01-01T00-00-00.000Z.json.gz"]);
});

test("rotation never deletes the backup just written, even after the clock went back; and clears partial files", async () => {
  mkdirSync(steamDirectory(), { recursive: true });
  // Two backups from the "future" (a clock since set back), and a half-written one a crash left.
  for (const name of ["2099-01-01T00-00-00.000Z.json.gz", "2099-01-02T00-00-00.000Z.json.gz"]) {
    writeFileSync(path.join(steamDirectory(), name), "later");
  }
  writeFileSync(path.join(steamDirectory(), "2026-01-01T00-00-00.000Z.json.gz.partial"), "half");
  const { backups } = startBackups({ backupsKept: 2 });
  backups.accept(new FakeRfaGame());
  await settle();
  expect(filesIn(steamDirectory())).toEqual(["2026-10-26T12-00-00.000Z.json.gz", "2099-01-02T00-00-00.000Z.json.gz"]);
});

test("a backup that can't be written is recorded as failed, leaving nothing behind", async () => {
  // The environment's folder can't be made: `saves` is a file.
  writeFileSync(path.join(dataDirectory, "saves"), "in the way");
  const { backups, events } = startBackups();
  backups.accept(new FakeRfaGame());
  await settle();
  expect(events).toEqual([
    {
      type: "saveBackup",
      atMs: clock.now(),
      failure: expect.stringContaining("couldn't write 2026-10-26T12-00-00.000Z.json.gz"),
    },
  ]);
  expect(readdirSync(dataDirectory)).toEqual(["saves"]);
});

test("a backup written but not renamed into place leaves no partial file", async () => {
  mkdirSync(steamDirectory(), { recursive: true });
  // A folder holds the backup's name, so the rename onto it fails after the partial file is written.
  mkdirSync(path.join(steamDirectory(), "2026-10-26T12-00-00.000Z.json.gz"));
  const { backups, events } = startBackups();
  backups.accept(new FakeRfaGame());
  await settle();
  expect(events).toEqual([
    expect.objectContaining({ failure: expect.stringContaining("couldn't write 2026-10-26T12-00-00.000Z.json.gz") }),
  ]);
  expect(filesIn(steamDirectory())).toEqual(["2026-10-26T12-00-00.000Z.json.gz"]);
});

test("an old backup that can't be deleted is reported, the backup is still kept, and the rest are still rotated", async () => {
  mkdirSync(steamDirectory(), { recursive: true });
  // A folder named like a backup can't be removed as a file.
  mkdirSync(path.join(steamDirectory(), "2026-01-01T00-00-00.000Z.json.gz"));
  writeFileSync(path.join(steamDirectory(), "2026-01-02T00-00-00.000Z.json.gz"), "old");
  const { backups, events } = startBackups({ backupsKept: 1 });
  backups.accept(new FakeRfaGame());
  await settle();
  expect(events).toEqual([
    expect.objectContaining({ type: "saveBackup", file: "saves/E0/2026-10-26T12-00-00.000Z.json.gz" }),
    {
      type: "saveBackupRotationFailed",
      atMs: clock.now(),
      failure: expect.stringContaining("couldn't delete 2026-01-01T00-00-00.000Z.json.gz"),
    },
  ]);
  expect(filesIn(steamDirectory())).toEqual(["2026-01-01T00-00-00.000Z.json.gz", "2026-10-26T12-00-00.000Z.json.gz"]);
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
    "a gzip that isn't UTF-8",
    { identifier: "x", binary: true, save: gzipSync(Buffer.from([0xff, 0xfe])).toString("latin1") },
    "the save doesn't gunzip into UTF-8",
  ],
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
  [
    "a Bitburner save with no player, which Import Game would refuse",
    { identifier: "x", binary: true, save: gzipSync('{"ctor":"BitburnerSaveObject","data":{}}').toString("latin1") },
    "the save has no player",
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

test("with no connection, or one that drops or has closed, the backup fails and is recorded", async () => {
  const { backups, events } = startBackups();
  await backupsEveryInterval(1);
  const game = new FakeRfaGame();
  game.dropAtRequest = 1;
  backups.accept(game);
  await settle();
  // The dropped connection is no longer used.
  await backupsEveryInterval(1);
  expect(events.map((event) => ("failure" in event ? event.failure : event))).toEqual([
    "no Remote File API connection",
    "getSaveFile: the connection closed",
    "no Remote File API connection",
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

test("an interval a timer can't wait, or no backup kept, is refused at the start", () => {
  const options = { dataDirectory, environment: "E0", backupsKept: 1, clock } as const;
  expect(() => new SaveBackups({ ...options, backupIntervalMs: MAX_BACKUP_INTERVAL_MS + 1 })).toThrow(RangeError);
  expect(() => new SaveBackups({ ...options, backupIntervalMs: 0 })).toThrow(RangeError);
  expect(() => new SaveBackups({ ...options, backupIntervalMs: 1_000, backupsKept: 0 })).toThrow(RangeError);
  expect(() => new SaveBackups({ ...options, backupIntervalMs: MAX_BACKUP_INTERVAL_MS })).not.toThrow();
});
