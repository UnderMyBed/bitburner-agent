// The data directory's rotating backup (#284): the store copied with VACUUM INTO in a worker thread, with config.json
// and the newest save backup of each environment, each copy opened and checked, the newest N kept; at the start and
// each interval, before a thinning at the start, and never stopping play. Against a real store and a hand-moved clock.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { ManualClock } from "@bitburner-agent/bridge/test-helpers";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  backupBeforeThinning,
  backupName,
  DATA_BACKUPS_DIRECTORY_NAME,
  type DataBackupEvent,
  DataBackups,
  describeDataBackup,
  MIN_FREE_BYTES_AFTER_BACKUP,
  RETRY_AFTER_FAILURE_MS,
} from "../src/data-backup.ts";
import { TelemetryStore } from "../src/telemetry-store.ts";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const START_MS = Date.UTC(2026, 10, 7, 12, 0, 0, 0);
const context = { environment: "E0", release: "r" } as const;

let dataDirectory: string;
let clock: ManualClock;
let store: TelemetryStore;
let running: DataBackups[];
beforeEach(() => {
  dataDirectory = mkdtempSync(path.join(os.tmpdir(), "data-backup-"));
  clock = new ManualClock(START_MS);
  store = TelemetryStore.open(storePath());
  running = [];
});
afterEach(async () => {
  for (const backups of running) {
    backups.stop();
    // Any under way finishes before the folder goes.
    await backups.backupNow("interval");
  }
  store.close();
  rmSync(dataDirectory, { recursive: true, force: true });
});

const storePath = () => path.join(dataDirectory, "telemetry.sqlite");
const backupDirectory = () => path.join(dataDirectory, DATA_BACKUPS_DIRECTORY_NAME);
const backupsOnDisk = () => (existsSync(backupDirectory()) ? readdirSync(backupDirectory()).sort() : []);

function startBackups(
  options: {
    backupsKept?: number;
    backupIntervalMs?: number;
    freeBytes?: (directory: string) => Promise<number>;
    backupDirectory?: string;
  } = {},
) {
  const backups = new DataBackups({
    dataDirectory,
    storePath: storePath(),
    configPath: path.join(dataDirectory, "config.json"),
    savesDirectory: path.join(dataDirectory, "saves"),
    backupDirectory: options.backupDirectory ?? backupDirectory(),
    backupsKept: options.backupsKept ?? 2,
    backupIntervalMs: options.backupIntervalMs ?? DAY_MS,
    clock,
    ...(options.freeBytes ? { freeBytes: options.freeBytes } : {}),
  });
  running.push(backups);
  const events: DataBackupEvent[] = [];
  backups.subscribe((event) => events.push(event));
  /** Resolves with the next event. */
  const nextEvent = () =>
    new Promise<DataBackupEvent>((resolve) => {
      const stop = backups.subscribe((event) => {
        stop();
        resolve(event);
      });
    });
  return { backups, events, nextEvent };
}

/** `count` fast snapshots, each with a `rowMarked` event of the same number, written in one transaction. */
function writePairs(from: number, count: number, padding = "") {
  store.writeTransaction(() => {
    for (let index = from; index < from + count; index++) {
      store.recordSnapshot(context, {
        agentSessionId: "s",
        tier: "fast",
        sequenceNumber: index,
        gameTimeMs: index,
        receivedAtMs: START_MS - DAY_MS + index,
        missedBefore: 0,
        data: { index, padding },
      });
      store.recordEvent(context, { atMs: START_MS - DAY_MS + index, kind: "rowMarked", detail: { index } });
    }
  });
}

function saveBackup(environment: string, name: string, text: string) {
  mkdirSync(path.join(dataDirectory, "saves", environment), { recursive: true });
  writeFileSync(path.join(dataDirectory, "saves", environment, name), text);
}

test("a backup holds the store, config.json and the newest save backup of each environment, in a folder of its own", async () => {
  writePairs(1, 10);
  writeFileSync(path.join(dataDirectory, "config.json"), '{"environment":"E0"}');
  saveBackup("E0", "2026-11-07T10-00-00.000Z.json.gz", "older");
  saveBackup("E0", "2026-11-07T11-30-00.000Z.json.gz", "newest E0");
  saveBackup("E0", "2026-11-07T11-45-00.000Z.json.gz.partial", "a partial one isn't a backup");
  saveBackup("E2", "2026-11-06T09-00-00.000Z.json.gz", "newest E2");
  const { backups } = startBackups();
  const event = await backups.backupNow("start");
  const name = "2026-11-07T12-00-00.000Z";
  expect(backupsOnDisk()).toEqual([name]);
  const folder = path.join(backupDirectory(), name);
  expect(readdirSync(folder).sort()).toEqual(["config.json", "saves", "telemetry.sqlite"]);
  expect(readFileSync(path.join(folder, "config.json"), "utf8")).toBe('{"environment":"E0"}');
  expect(readFileSync(path.join(folder, "saves/E0/2026-11-07T11-30-00.000Z.json.gz"), "utf8")).toBe("newest E0");
  expect(readFileSync(path.join(folder, "saves/E2/2026-11-06T09-00-00.000Z.json.gz"), "utf8")).toBe("newest E2");
  expect(readdirSync(path.join(folder, "saves/E0"))).toHaveLength(1);
  // The restore check: the copy opens on its own, and holds what the store held.
  const copy = TelemetryStore.openReadOnly(path.join(folder, "telemetry.sqlite"));
  expect(copy.snapshots({ environment: "E0" })).toEqual(store.snapshots({ environment: "E0" }));
  expect(copy.events({ environment: "E0" })).toEqual(store.events({ environment: "E0" }));
  copy.close();
  expect(event).toMatchObject({
    type: "dataBackup",
    atMs: START_MS,
    reason: "start",
    // Relative to the data directory, as the save backups' events are.
    directory: `backups/${name}`,
    saves: ["saves/E0/2026-11-07T11-30-00.000Z.json.gz", "saves/E2/2026-11-06T09-00-00.000Z.json.gz"],
    removed: [],
  });
  expect(event).not.toHaveProperty("rotationFailure");
  expect(event.type === "dataBackup" && event.storeBytes).toBeGreaterThan(0);
  expect(backups.problem()).toBeNull();
  expect(backups.newestBackupAtMs()).toBe(START_MS);
});

test("with no config.json and no save backups yet, a backup is the store alone", async () => {
  const { backups } = startBackups();
  expect(await backups.backupNow("start")).toMatchObject({ type: "dataBackup", saves: [] });
  expect(readdirSync(path.join(backupDirectory(), backupName(START_MS)))).toEqual(["telemetry.sqlite"]);
});

test("a folder the owner names outside the data directory: the backup goes there, named in full", async () => {
  const elsewhere = path.join(dataDirectory, "..", `${path.basename(dataDirectory)}-elsewhere`);
  try {
    const { backups } = startBackups({ backupDirectory: elsewhere });
    const event = await backups.backupNow("start");
    expect(event).toMatchObject({ type: "dataBackup", directory: path.join(elsewhere, backupName(START_MS)) });
    expect(readdirSync(elsewhere)).toEqual([backupName(START_MS)]);
    expect(backupsOnDisk()).toEqual([]);
  } finally {
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("two asked for at once are taken one after the other, both whole", async () => {
  writePairs(1, 10);
  const { backups } = startBackups();
  const [first, second] = await Promise.all([backups.backupNow("start"), backups.backupNow("thinning")]);
  expect([first.type, second.type]).toEqual(["dataBackup", "dataBackup"]);
  // The same millisecond: the second replaced the first.
  expect(backupsOnDisk()).toEqual([backupName(START_MS)]);
});

test("the newest N are kept: older and partial backups go, anything else in the folder stays", async () => {
  const { backups } = startBackups({ backupsKept: 2 });
  mkdirSync(path.join(backupDirectory(), "2026-11-01T00-00-00.000Z.partial"), { recursive: true });
  mkdirSync(path.join(backupDirectory(), "the owner's own folder"));
  writeFileSync(path.join(backupDirectory(), "notes.txt"), "kept");
  const names: string[] = [];
  const removed: string[][] = [];
  for (let day = 0; day < 4; day++) {
    names.push(backupName(clock.now()));
    const event = await backups.backupNow("interval");
    if (event.type !== "dataBackup") throw new Error(event.failure);
    removed.push(event.removed);
    clock.advance(DAY_MS);
  }
  expect(backupsOnDisk()).toEqual([names[2], names[3], "notes.txt", "the owner's own folder"]);
  expect(removed).toEqual([["2026-11-01T00-00-00.000Z.partial"], [], [names[0]], [names[1]]]);
});

test("the backup just written is kept even if the clock went back and its name sorts first", async () => {
  const { backups } = startBackups({ backupsKept: 1 });
  await backups.backupNow("start");
  clock.advance(-DAY_MS);
  const event = await backups.backupNow("interval");
  expect(event).toMatchObject({ type: "dataBackup", removed: [backupName(START_MS)] });
  expect(backupsOnDisk()).toEqual([backupName(START_MS - DAY_MS)]);
});

/**
 * A backup while the store is written every millisecond: its event, the event loop's longest delay over it (ms), the
 * writes made during it, and the copy's snapshot and event numbers. The store holds about `megabytes` of pairs first.
 */
async function backupWhileWriting(megabytes: number) {
  const padding = "x".repeat(5_000);
  // A pair is about 5.2 KB stored.
  const pairs = Math.ceil((megabytes * 1e6) / 5_200);
  for (let from = 1; from <= pairs; from += 2_000) writePairs(from, Math.min(2_000, pairs - from + 1), padding);
  let next = pairs + 1;
  let writesDuring = 0;
  const writer = setInterval(() => {
    writePairs(next, 5, padding);
    next += 5;
    writesDuring++;
  }, 1);
  const delay = monitorEventLoopDelay({ resolution: 5 });
  delay.enable();
  const { backups } = startBackups();
  const event = await backups.backupNow("interval");
  delay.disable();
  clearInterval(writer);
  if (event.type !== "dataBackup") throw new Error(event.failure);
  const copy = TelemetryStore.openReadOnly(path.join(dataDirectory, event.directory, "telemetry.sqlite"));
  const snapshotNumbers = copy.snapshots({ environment: "E0" }).map((snapshot) => snapshot.sequenceNumber);
  const eventNumbers = copy
    .events({ environment: "E0" })
    .map((stored) => (stored.detail as { index: number }).index)
    .sort((a, b) => a - b);
  copy.close();
  return { event, longestDelayMs: delay.max / 1e6, writesDuring, pairs, snapshotNumbers, eventNumbers };
}

test("a backup taken while the store is being written is the store at one moment, and the event loop runs on", async () => {
  // About 100 MB, so the copy takes long enough to tell a blocked event loop, and for writes to land during it.
  const { event, longestDelayMs, writesDuring, pairs, snapshotNumbers, eventNumbers } = await backupWhileWriting(100);
  // The brain's writes went on while the copy was made, on another thread.
  expect(writesDuring).toBeGreaterThan(0);
  // Every transaction whole or not at all, with none missing before the last: one moment of the store.
  expect(eventNumbers).toEqual(snapshotNumbers);
  expect(snapshotNumbers).toEqual(Array.from({ length: snapshotNumbers.length }, (_, index) => index + 1));
  expect(snapshotNumbers.length).toBeGreaterThanOrEqual(pairs);
  // A copy on the event loop would hold it for the copy's whole length; the worker leaves it to the writes.
  expect(longestDelayMs).toBeLessThan(event.tookMs / 2);
});

// The measurement behind #284's numbers, by hand: DATA_BACKUP_LARGE_STORE_MB=420 (a store of that size, built in the
// test's own temporary folder). Prints the copy's time and the event loop's longest delay.
test.runIf(process.env.DATA_BACKUP_LARGE_STORE_MB)(
  "a large store's backup, measured",
  async () => {
    const { event, longestDelayMs, writesDuring } = await backupWhileWriting(
      Number(process.env.DATA_BACKUP_LARGE_STORE_MB),
    );
    const storeBytes = statSync(storePath()).size;
    console.log(
      `the store ${(storeBytes / 1e6).toFixed(0)} MB: copied (${(event.storeBytes / 1e6).toFixed(0)} MB) and checked in ` +
        `${event.tookMs.toFixed(0)} ms; the event loop's longest delay ${longestDelayMs.toFixed(0)} ms; ${writesDuring} writes ` +
        "during it",
    );
    expect(longestDelayMs).toBeLessThan(event.tookMs / 2);
  },
  300_000,
);

test("too little free space: no backup, a failure saying what's needed, nothing left behind; a later one clears it", async () => {
  writePairs(1, 10);
  let free = 10_000_000;
  const { backups } = startBackups({ freeBytes: async () => free });
  const event = await backups.backupNow("interval");
  expect(event).toMatchObject({ type: "dataBackupFailed", atMs: START_MS, reason: "interval" });
  expect(event.type === "dataBackupFailed" && event.failure).toMatch(
    /^not enough free space in .*backups: a backup needs up to [\d.]+ MB and leaves at least 1000\.0 MB free, and 10\.0 MB is free$/,
  );
  expect(backupsOnDisk()).toEqual([]);
  expect(backups.problem()).toEqual({
    atMs: START_MS,
    kind: "failed",
    failure: (event as { failure: string }).failure,
  });
  // Just enough: the store and its log, and the 1 GB left free.
  free = MIN_FREE_BYTES_AFTER_BACKUP + 100_000_000;
  clock.advance(HOUR_MS);
  expect(await backups.backupNow("interval")).toMatchObject({ type: "dataBackup" });
  expect(backups.problem()).toBeNull();
});

test("a store that can't be copied is a failure: logged as an event, the partial copy removed, play unaffected", async () => {
  store.close();
  writeFileSync(storePath(), "this isn't a database, and it's long enough to have a header to read....");
  const { backups } = startBackups();
  const event = await backups.backupNow("start");
  expect(event).toMatchObject({ type: "dataBackupFailed", reason: "start" });
  expect(event.type === "dataBackupFailed" && event.failure).toMatch(/^the store's copy failed: .*not a database/);
  expect(backupsOnDisk()).toEqual([]);
  expect(backups.problem()).toMatchObject({ kind: "failed" });
  store = TelemetryStore.open(path.join(dataDirectory, "another.sqlite"));
});

test("a backup folder that can't be made is a failure, not a crash", async () => {
  writeFileSync(backupDirectory(), "a file where the folder would be");
  const { backups } = startBackups();
  const event = await backups.backupNow("start");
  expect(event).toMatchObject({ type: "dataBackupFailed" });
  expect(event.type === "dataBackupFailed" && event.failure).toMatch(/EEXIST|ENOTDIR/);
});

/** Lets a finished backup's promise settle: its next check is scheduled once it has. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("its schedule", () => {
  test("at the start a backup is taken when none is, then one each interval", async () => {
    const { backups, events, nextEvent } = startBackups({ backupIntervalMs: 6 * HOUR_MS });
    let next = nextEvent();
    backups.start();
    expect(await next).toMatchObject({ type: "dataBackup", reason: "start", atMs: START_MS });
    await settle();
    next = nextEvent();
    clock.advance(6 * HOUR_MS - 1);
    await settle();
    expect(events).toHaveLength(1);
    clock.advance(1);
    expect(await next).toMatchObject({ type: "dataBackup", reason: "interval", atMs: START_MS + 6 * HOUR_MS });
  });

  test("at the start, a backup newer than the interval is enough: the next is due from it (a crash loop rotates nothing)", async () => {
    const { backups: first } = startBackups({ backupIntervalMs: DAY_MS });
    await first.backupNow("start");
    first.stop();
    clock.advance(3 * HOUR_MS);
    const { backups, events, nextEvent } = startBackups({ backupIntervalMs: DAY_MS });
    const next = nextEvent();
    backups.start();
    clock.advance(21 * HOUR_MS - 1);
    await settle();
    expect(events).toEqual([]);
    clock.advance(1);
    expect(await next).toMatchObject({ reason: "interval", atMs: START_MS + DAY_MS });
  });

  test("a newest backup after now (the clock was wrong) makes one due at once", async () => {
    mkdirSync(path.join(backupDirectory(), backupName(START_MS + 30 * DAY_MS)), { recursive: true });
    const { backups, nextEvent } = startBackups();
    const next = nextEvent();
    backups.start();
    expect(await next).toMatchObject({ type: "dataBackup", reason: "start", atMs: START_MS });
  });

  test("after a failure it's tried again within the hour, not at the next interval", async () => {
    let free = 0;
    const { backups, nextEvent } = startBackups({ freeBytes: async () => free });
    let next = nextEvent();
    backups.start();
    expect(await next).toMatchObject({ type: "dataBackupFailed", reason: "start" });
    free = 10 * MIN_FREE_BYTES_AFTER_BACKUP;
    await settle();
    next = nextEvent();
    clock.advance(RETRY_AFTER_FAILURE_MS);
    expect(await next).toMatchObject({
      type: "dataBackup",
      reason: "interval",
      atMs: START_MS + RETRY_AFTER_FAILURE_MS,
    });
  });

  test("stopped, it takes no more backups and reports nothing more", async () => {
    const { backups, events, nextEvent } = startBackups({ backupIntervalMs: HOUR_MS });
    const next = nextEvent();
    backups.start();
    await next;
    // The next one's timer set, then stopped.
    await settle();
    backups.stop();
    clock.advance(10 * HOUR_MS);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(events).toHaveLength(1);
    expect(backupsOnDisk()).toEqual([backupName(START_MS)]);
    // One asked for after the stop runs, but isn't reported (the store it'd be recorded in is closed).
    expect(await backups.backupNow("interval")).toMatchObject({ type: "dataBackup" });
    expect(events).toHaveLength(1);
  });

  test("the interval and the number kept are checked", () => {
    const options = {
      dataDirectory,
      storePath: storePath(),
      configPath: "",
      savesDirectory: "",
      backupDirectory: backupDirectory(),
      clock,
    };
    expect(() => new DataBackups({ ...options, backupsKept: 0, backupIntervalMs: DAY_MS })).toThrow(/at least one/);
    expect(() => new DataBackups({ ...options, backupsKept: 1.5, backupIntervalMs: DAY_MS })).toThrow(/at least one/);
    expect(() => new DataBackups({ ...options, backupsKept: 1, backupIntervalMs: 0 })).toThrow(/interval/);
    expect(() => new DataBackups({ ...options, backupsKept: 1, backupIntervalMs: 2 ** 31 })).toThrow(/interval/);
  });
});

describe("before a thinning at the start (#283)", () => {
  const cutoffMs = START_MS - 14 * DAY_MS;

  test("with data backups off, there's no thinning: it says why", async () => {
    expect(await backupBeforeThinning(null, { beforeMs: cutoffMs, nowMs: START_MS, intervalMs: DAY_MS })).toBe(
      "data backups are off (config.json's dataBackupsKept is 0)",
    );
  });

  test("a backup within the interval and after the cutoff holds what it cuts: none taken", async () => {
    const { backups, events } = startBackups();
    await backups.backupNow("interval");
    clock.advance(DAY_MS - 1);
    expect(
      await backupBeforeThinning(backups, { beforeMs: cutoffMs, nowMs: clock.now(), intervalMs: DAY_MS }),
    ).toBeNull();
    expect(events).toHaveLength(1);
  });

  test("with none, or the newest older than the interval or before the cutoff, one is taken first", async () => {
    const { backups, events } = startBackups();
    expect(await backupBeforeThinning(backups, { beforeMs: cutoffMs, nowMs: START_MS, intervalMs: DAY_MS })).toBeNull();
    expect(events.map((event) => [event.type, event.reason])).toEqual([["dataBackup", "thinning"]]);
    clock.advance(DAY_MS);
    await backupBeforeThinning(backups, { beforeMs: cutoffMs, nowMs: clock.now(), intervalMs: DAY_MS });
    expect(events).toHaveLength(2);
    // A cutoff after the newest backup: snapshots it would cut came after that backup.
    clock.advance(HOUR_MS);
    await backupBeforeThinning(backups, { beforeMs: clock.now() - 1, nowMs: clock.now(), intervalMs: DAY_MS });
    expect(events).toHaveLength(3);
  });

  test("a backup that fails means no thinning, and says why", async () => {
    const { backups } = startBackups({ freeBytes: async () => 0 });
    expect(await backupBeforeThinning(backups, { beforeMs: cutoffMs, nowMs: START_MS, intervalMs: DAY_MS })).toMatch(
      /^the backup before it failed: not enough free space/,
    );
  });
});

test("its lines: the brain's log and the run report's section 1", () => {
  expect(
    describeDataBackup("dataBackup", {
      atMs: START_MS,
      reason: "start",
      directory: "backups/2026-11-07T12-00-00.000Z",
      storeBytes: 412_300_000,
      saves: ["saves/E0/a.json.gz"],
      tookMs: 3_210,
      removed: ["2026-11-05T12-00-00.000Z"],
    }),
  ).toBe(
    "data backup backups/2026-11-07T12-00-00.000Z (at the brain's start): the store 412.3 MB, 1 save backup, in 3.2 s; " +
      "removed 2026-11-05T12-00-00.000Z",
  );
  expect(
    describeDataBackup("dataBackup", {
      reason: "thinning",
      directory: "D:\\backups\\x",
      storeBytes: 1_000_000,
      saves: [],
      tookMs: 100,
      removed: [],
      rotationFailure: "couldn't remove y: EBUSY",
    }),
  ).toBe(
    "data backup D:\\backups\\x (before the start's thinning): the store 1.0 MB, 0 save backups, in 0.1 s; older ones " +
      "NOT removed: couldn't remove y: EBUSY",
  );
  expect(describeDataBackup("dataBackupFailed", { reason: "interval", failure: "disk full" })).toBe(
    "data backup FAILED (at the interval): disk full",
  );
});
