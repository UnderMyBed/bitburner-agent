// Thinning the telemetry store (#283): what stays whole, what's cut to a stub with its times, where each thinning
// starts and stops, what it records and logs, the fast model's calibration extract over it, and its command (a dry
// run, a backup first, refused while the brain runs). Over stores built here, never the owner's .data/.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { BRAIN_LOCK_FILE_NAME, runningBrain, writeBrainLock } from "../src/brain-lock.ts";
import { CONFIG_FILE_NAME, defaultConfig, STORE_FILE_NAME } from "../src/config.ts";
import {
  DEFAULT_KEPT_WHOLE_DAYS,
  describeThinning,
  STORE_THINNED_EVENT_KIND,
  STORE_THINNING_FAILED_EVENT_KIND,
  thinStore,
  thinStoreAtStart,
} from "../src/store-thinning.ts";
import { isThinnedReading, type StoredSnapshot, TelemetryStore } from "../src/telemetry-store.ts";

const THIN_CLI = path.resolve(import.meta.dirname, "../src/thin-cli.ts");
const T0 = Date.parse("2026-10-26T00:00:00Z");
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;
const context = { environment: "E0", release: "r" } as const;

let directory: string;
let store: TelemetryStore;
beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "store-thinning-"));
  store = TelemetryStore.open(path.join(directory, STORE_FILE_NAME));
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

let sequenceNumber = 0;
const intent = (id: string) => ({ id, done: false, tries: 1, problem: null, backend: "ui" });
/** The reset intents a fast snapshot holds: an install every 4 s, a destroy every 6 s. */
const resetIntentsAt = (offsetMs: number) => [
  ...(offsetMs % (4 * SECOND) === 0 ? ["installAugmentations()"] : []),
  ...(offsetMs % (6 * SECOND) === 0 ? ["destroyBitNode(1)"] : []),
];
const fastData = (offsetMs: number) => ({
  degradedTiers: offsetMs % (10 * SECOND) === 4 * SECOND ? ["medium"] : [],
  pageHeapUsedBytes: 100_000_000 + offsetMs,
  game: { money: offsetMs, homeRamUsed: 4, homeMaxRam: 8, homeProcesses: [{ pid: 1, filename: "a.js" }] },
  intents: [intent("buyTor()"), ...resetIntentsAt(offsetMs).map(intent)],
  dialogs: { handled: [], blocking: null },
  batcher: { state: "batching", target: "n00dles", sharing: 64 + offsetMs / 1000 },
});
const mediumData = (offsetMs: number) => ({ player: { money: offsetMs }, servers: [{ hostname: "home" }] });

/** Every tier at its period, from `fromMs` to before `toMs` (offsets from T0), as the Agent sends them. */
function run(
  fromMs: number,
  toMs: number,
  { environment = "E0" as "E0" | "E2", session = "session-1", baseMs = T0 } = {},
) {
  store.writeTransaction(() => {
    const record = (tier: string, offsetMs: number, data: unknown) =>
      store.recordSnapshot(
        { environment, release: "r" },
        {
          agentSessionId: session,
          tier,
          sequenceNumber: ++sequenceNumber,
          gameTimeMs: baseMs + offsetMs + 7,
          receivedAtMs: baseMs + offsetMs,
          missedBefore: 0,
          data,
        },
      );
    for (let offsetMs = fromMs; offsetMs < toMs; offsetMs += 2 * SECOND) {
      if (offsetMs % MINUTE === 0) record("slow", offsetMs, { purchasedServers: [], money: offsetMs });
      if (offsetMs % (10 * SECOND) === 0) record("medium", offsetMs, mediumData(offsetMs));
      record("fast", offsetMs, fastData(offsetMs));
    }
    if (fromMs === 0) record("static", 0, { servers: [] });
  });
}
const snapshotsOf = (tier: string, environment: "E0" | "E2" = "E0") =>
  store.snapshots({ environment }).filter((snapshot) => snapshot.tier === tier);
const thinnedEvents = () => store.events({ environment: "E0" }).filter((e) => e.kind === STORE_THINNED_EVENT_KIND);
/** Thins at `nowMs` (an offset from T0), keeping a day whole unless said. */
const thin = (nowOffsetMs: number, keptWholeDays = 1, dryRun = false) =>
  thinStore(store, { context, nowMs: T0 + nowOffsetMs, keptWholeDays, dryRun });
/** What a thinning that cut nothing returns. */
const nothing = { thinned: { fast: 0, medium: 0 }, bytesBefore: 0, bytesAfter: 0 };

describe("what thinning keeps (#283)", () => {
  test("before the cutoff, the first fast and medium snapshot of each minute stay whole; the others keep their row, times and a stub", () => {
    run(0, 3 * MINUTE);
    // A day and 2 minutes on, the newest snapshot then: the cutoff is 00:02, so minutes 0 and 1 are thinned.
    run(DAY + 2 * MINUTE, DAY + 2 * MINUTE + 2 * SECOND);
    const before = store.snapshots({ environment: "E0" });
    const result = thin(DAY + 2 * MINUTE + 30 * SECOND);
    expect(result).toEqual({
      beforeMs: T0 + 2 * MINUTE,
      fromMs: null,
      keptWholeDays: 1,
      dryRun: false,
      skipped: null,
      thinned: { fast: 58, medium: 10 },
      bytesBefore: expect.any(Number),
      bytesAfter: expect.any(Number),
      tookMs: expect.any(Number),
    });
    expect(result.bytesAfter).toBeLessThan(result.bytesBefore / 2);
    const after = store.snapshots({ environment: "E0" });
    // Every row stays, in order, with its times, session, sequence number and release.
    expect(after.map(({ data: _, ...row }) => row)).toEqual(before.map(({ data: _, ...row }) => row));
    after.forEach((snapshot, index) => {
      const original = before[index] as StoredSnapshot;
      const offsetMs = snapshot.receivedAtMs - T0;
      const thinned =
        (snapshot.tier === "fast" || snapshot.tier === "medium") && offsetMs < 2 * MINUTE && offsetMs % MINUTE !== 0;
      if (!thinned) {
        expect(snapshot.data).toEqual(original.data);
        return;
      }
      expect(snapshot.data).toEqual(
        snapshot.tier === "fast"
          ? {
              thinned: true,
              degradedTiers: fastData(offsetMs).degradedTiers,
              pageHeapUsedBytes: 100_000_000 + offsetMs,
              // The install and destroy intents it held, by id, in order (#283's review: the reloads read them).
              resetIntents: resetIntentsAt(offsetMs),
            }
          : { thinned: true },
      );
      expect(isThinnedReading(snapshot.data)).toBe(true);
    });
    // From the cutoff on, whole.
    expect(snapshotsOf("fast").filter((s) => s.receivedAtMs >= T0 + 2 * MINUTE && isThinnedReading(s.data))).toEqual(
      [],
    );
    // The slow and static snapshots, whole.
    for (const tier of ["slow", "static"]) {
      expect(snapshotsOf(tier).some((s) => isThinnedReading(s.data))).toBe(false);
    }
  });

  test("a fast snapshot's stub keeps a degraded tier, a null page heap and the reset intents' ids; data that says nothing gives nulls", () => {
    const datas = [
      { degradedTiers: ["slow", "fast"], pageHeapUsedBytes: null },
      { degradedTiers: ["slow", "fast"], pageHeapUsedBytes: null },
      null,
      { other: 1 },
      // Malformed intents, the Agent's word: only the install or destroy ids that are strings.
      { intents: ["installAugmentations()", 5, { id: 7 }, { id: "destroyBitNode(2)" }, { id: "buyTor()" }] },
      { intents: { id: "installAugmentations()" } },
    ];
    for (const [index, data] of [...datas, null].entries()) {
      store.recordSnapshot(context, {
        agentSessionId: "s",
        tier: "fast",
        sequenceNumber: index + 1,
        gameTimeMs: 0,
        receivedAtMs: index === datas.length ? T0 + 2 * DAY : T0 + index * 2 * SECOND,
        missedBefore: 0,
        data,
      });
    }
    thin(2 * DAY);
    const empty = { thinned: true, degradedTiers: null, pageHeapUsedBytes: null, resetIntents: [] };
    expect(snapshotsOf("fast").map((snapshot) => snapshot.data)).toEqual([
      { degradedTiers: ["slow", "fast"], pageHeapUsedBytes: null },
      { thinned: true, degradedTiers: ["slow", "fast"], pageHeapUsedBytes: null, resetIntents: [] },
      empty,
      empty,
      { ...empty, resetIntents: ["destroyBitNode(2)"] },
      empty,
      null,
    ]);
  });

  test("the first stored of each minute stays whole, whichever tier and session; the minutes are the brain's clock's", () => {
    // Two sessions' fast snapshots interleaved in one minute: the first stored stays.
    run(30 * SECOND, 90 * SECOND, { session: "a" });
    run(31 * SECOND, 91 * SECOND, { session: "b" });
    run(2 * DAY, 2 * DAY + 2 * SECOND);
    thin(2 * DAY);
    const whole = snapshotsOf("fast").filter((s) => s.receivedAtMs < T0 + DAY && !isThinnedReading(s.data));
    expect(whole.map((s) => [s.receivedAtMs - T0, s.agentSessionId])).toEqual([
      [30 * SECOND, "a"],
      [60 * SECOND, "a"],
    ]);
  });

  test("events, settings, slow and static snapshots, and another environment's snapshots are never touched", () => {
    run(0, 2 * MINUTE);
    run(0, 2 * MINUTE, { environment: "E2" });
    // Two of each other tier in one minute (a brain restart, say): both whole.
    run(0, 2 * SECOND, { session: "again" });
    run(2 * DAY, 2 * DAY + 2 * SECOND);
    for (const tier of ["slow", "static"]) {
      expect(snapshotsOf(tier).filter((s) => s.receivedAtMs === T0)).toHaveLength(2);
    }
    store.recordEvent(context, { atMs: T0 + 5 * SECOND, kind: "gameDialog", detail: { text: "x" } });
    store.setSetting("hackLoop.enabled", "true");
    const e2Before = store.snapshots({ environment: "E2" });
    thin(2 * DAY);
    expect(store.snapshots({ environment: "E2" })).toEqual(e2Before);
    expect(store.events({ environment: "E0" }).map((e) => e.kind)).toEqual(["gameDialog", STORE_THINNED_EVENT_KIND]);
    expect(store.getSetting("hackLoop.enabled")).toBe("true");
    for (const tier of ["slow", "static"]) {
      expect(snapshotsOf(tier).some((s) => isThinnedReading(s.data))).toBe(false);
    }
  });

  test("the store's thinning cuts a snapshot once: over the same span again, none", () => {
    run(0, 2 * MINUTE);
    const span = { environment: "E0", fromMs: T0, beforeMs: T0 + 2 * MINUTE } as const;
    const first = store.writeTransaction(() => store.thinSnapshots(span));
    expect(first.map(({ tier, count }) => [tier, count])).toEqual([
      ["fast", 58],
      ["medium", 10],
    ]);
    expect(store.writeTransaction(() => store.thinSnapshots(span))).toEqual([]);
  });

  test("a stub is told by its own mark: true, and nothing else", () => {
    expect(isThinnedReading({ thinned: true })).toBe(true);
    for (const data of [null, undefined, 1, "thinned", {}, { thinned: false }, { thinned: 1 }, { thinned: "true" }]) {
      expect(isThinnedReading(data)).toBe(false);
    }
  });

  test("the write-ahead log is emptied after a thinning that cut something", () => {
    run(0, 3 * MINUTE);
    run(DAY + 2 * MINUTE, DAY + 2 * MINUTE + 2 * SECOND);
    thin(DAY + 2 * MINUTE);
    expect(statSync(path.join(directory, `${STORE_FILE_NAME}-wal`)).size).toBe(0);
  });
});

describe("a dry run (#283's review)", () => {
  test("says what it would cut, and the bytes, and changes nothing", () => {
    run(0, 3 * MINUTE);
    run(DAY + 2 * MINUTE, DAY + 2 * MINUTE + 2 * SECOND);
    const before = store.snapshots({ environment: "E0" });
    const dry = thin(DAY + 2 * MINUTE, 1, true);
    expect(dry).toMatchObject({ dryRun: true, beforeMs: T0 + 2 * MINUTE, thinned: { fast: 58, medium: 10 } });
    expect(store.snapshots({ environment: "E0" })).toEqual(before);
    expect(thinnedEvents()).toEqual([]);
    // What it said is what the thinning then does.
    const done = thin(DAY + 2 * MINUTE);
    expect([done.thinned, done.bytesBefore, done.bytesAfter]).toEqual([dry.thinned, dry.bytesBefore, dry.bytesAfter]);
    // A dry run takes no write lock: another connection's write under way doesn't hold it up.
    run(DAY + 3 * MINUTE, DAY + 3 * MINUTE + 2 * SECOND);
    const writer = new DatabaseSync(path.join(directory, STORE_FILE_NAME));
    writer.exec("BEGIN IMMEDIATE");
    try {
      expect(thin(DAY + 3 * MINUTE, 1, true).thinned).toEqual({ fast: 29, medium: 5 });
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }
    // A dry run writes nothing: a store it can't write to is fine.
    store.close();
    store = TelemetryStore.openReadOnly(path.join(directory, STORE_FILE_NAME));
    expect(thin(DAY + 3 * MINUTE, 1, true)).toMatchObject({ dryRun: true, thinned: { fast: 29, medium: 5 } });
  });
});

describe("when, and from where (#283)", () => {
  test("the cutoff is the days kept before the newest snapshot, on a minute: after a long pause, nothing new is thinned", () => {
    run(0, 3 * MINUTE);
    // A month on, the brain starts: its newest record is 3 minutes in, so with 1 day kept, nothing is old enough.
    const paused = thin(30 * DAY);
    expect(paused).toMatchObject({ beforeMs: Math.floor((T0 + 3 * MINUTE - 2 * SECOND - DAY) / MINUTE) * MINUTE });
    expect(paused.thinned).toEqual({ fast: 0, medium: 0 });
    expect(thinnedEvents()).toEqual([]);
  });

  test("with the newest snapshot after now, a clock is wrong: nothing thinned, and it says why", () => {
    run(0, 3 * MINUTE);
    run(40 * DAY, 40 * DAY + 2 * SECOND);
    const skipped = thin(DAY + MINUTE + 30 * SECOND);
    expect(skipped).toMatchObject({
      beforeMs: null,
      ...nothing,
      skipped:
        "the newest snapshot, at 2026-12-05T00:00:00.000Z, is after now, 2026-10-27T00:01:30.000Z: a clock is wrong",
    });
    expect(snapshotsOf("fast").some((s) => isThinnedReading(s.data))).toBe(false);
    expect(thinnedEvents()).toEqual([]);
    expect(describeThinning(skipped)).toBe(
      "store thinning: nothing thinned: the newest snapshot, at 2026-12-05T00:00:00.000Z, is after now, " +
        "2026-10-27T00:01:30.000Z: a clock is wrong",
    );
    // Now as late as the newest: thinned again.
    expect(thin(40 * DAY).thinned).toEqual({ fast: 87, medium: 15 });
  });

  test("again, it starts where the last stopped: nothing twice, and only what's aged since", () => {
    run(0, 4 * MINUTE);
    run(DAY + 2 * MINUTE, DAY + 2 * MINUTE + 2 * SECOND);
    expect(thin(DAY + 2 * MINUTE).thinned).toEqual({ fast: 58, medium: 10 });
    // The same start again: nothing to do, and nothing recorded.
    expect(thin(DAY + 2 * MINUTE)).toMatchObject({ fromMs: T0 + 2 * MINUTE, thinned: { fast: 0, medium: 0 } });
    expect(thinnedEvents()).toHaveLength(1);
    // A minute later, with a newer snapshot: minute 2 alone.
    run(DAY + 3 * MINUTE, DAY + 3 * MINUTE + 2 * SECOND);
    expect(thin(DAY + 3 * MINUTE)).toMatchObject({
      beforeMs: T0 + 3 * MINUTE,
      fromMs: T0 + 2 * MINUTE,
      thinned: { fast: 29, medium: 5 },
    });
    expect(thinnedEvents().map((e) => e.detail)).toEqual([
      expect.objectContaining({ beforeMs: T0 + 2 * MINUTE, fromMs: null, thinned: { fast: 58, medium: 10 } }),
      expect.objectContaining({ beforeMs: T0 + 3 * MINUTE, fromMs: T0 + 2 * MINUTE, thinned: { fast: 29, medium: 5 } }),
    ]);
    expect(thinnedEvents().map((e) => e.atMs)).toEqual([T0 + DAY + 2 * MINUTE, T0 + DAY + 3 * MINUTE]);
    // The time it took, in the event too.
    expect(thinnedEvents().map((e) => typeof (e.detail as { tookMs?: unknown }).tookMs)).toEqual(["number", "number"]);
    // A snapshot stored since with a time before the last cutoff (a clock set back) is left whole: each thinning reads
    // only what's aged past the last one's cutoff, so a start never reads the months before it.
    run(30 * SECOND, 34 * SECOND, { session: "late" });
    run(DAY + 4 * MINUTE, DAY + 4 * MINUTE + 2 * SECOND);
    expect(thin(DAY + 4 * MINUTE).thinned).toEqual({ fast: 29, medium: 5 });
    const late = snapshotsOf("fast").filter((s) => s.agentSessionId === "late");
    expect(late.map((s) => isThinnedReading(s.data))).toEqual([false, false]);
    // With nothing aged since, it doesn't even open a write: a store it can't write to is no failure then.
    store.close();
    store = TelemetryStore.openReadOnly(path.join(directory, STORE_FILE_NAME));
    expect(thin(DAY + 4 * MINUTE)).toMatchObject({ beforeMs: T0 + 4 * MINUTE, thinned: { fast: 0, medium: 0 } });
  });

  test("more days kept than last time: nothing until the new cutoff passes the old; fewer days don't bring data back", () => {
    run(0, 4 * MINUTE);
    run(DAY + 2 * MINUTE, DAY + 2 * MINUTE + 2 * SECOND);
    thin(DAY + 2 * MINUTE);
    expect(thin(DAY + 2 * MINUTE, 2).thinned).toEqual({ fast: 0, medium: 0 });
    expect(thinnedEvents()).toHaveLength(1);
    expect(snapshotsOf("fast").filter((s) => isThinnedReading(s.data))).toHaveLength(58);
  });

  test("a store with no snapshots: nothing to thin, nothing recorded", () => {
    expect(thin(DAY)).toEqual({
      beforeMs: null,
      fromMs: null,
      keptWholeDays: 1,
      dryRun: false,
      skipped: null,
      ...nothing,
      tookMs: expect.any(Number),
    });
    expect(thinnedEvents()).toEqual([]);
  });
});

describe("the fast model's calibration extract over a thinned store (#283's review)", () => {
  /**
   * The documented pattern (packages/brain/README.md, "Thinning"): at each mark, the newest whole medium snapshot at or
   * before it (a stub skipped), and the fast snapshots' `batcher.sharing` between marks.
   */
  function extract(databasePath: string, installMs: number) {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const whole = "substr(data, 1, 11) <> '{\"thinned\":'";
      return [5, 10, 15].map((minutes) => {
        const markMs = installMs + minutes * MINUTE;
        const medium = database
          .prepare(
            `SELECT received_at_ms AS atMs, json_extract(data, '$.player.money') AS money FROM snapshots
              WHERE tier = 'medium' AND received_at_ms <= ? AND ${whole} ORDER BY received_at_ms DESC LIMIT 1`,
          )
          .get(markMs) as { atMs: number; money: number };
        const slow = database
          .prepare(
            `SELECT received_at_ms AS atMs FROM snapshots WHERE tier = 'slow' AND received_at_ms <= ?
              ORDER BY received_at_ms DESC LIMIT 1`,
          )
          .get(markMs) as { atMs: number };
        const sharing = database
          .prepare(
            `SELECT AVG(json_extract(data, '$.batcher.sharing')) AS mean, COUNT(*) AS count FROM snapshots
              WHERE tier = 'fast' AND received_at_ms > ? AND received_at_ms <= ? AND ${whole}`,
          )
          .get(markMs - 5 * MINUTE, markMs) as { mean: number; count: number };
        return { markMs, medium, slow, sharing };
      });
    } finally {
      database.close();
    }
  }

  test("each mark's medium reading within 60 s of the whole store's, the slow ones exact, the sharing a minute at a time", () => {
    // An install 37 s into the run: its marks fall between whole snapshots.
    const installMs = T0 + 37 * SECOND;
    run(0, 17 * MINUTE);
    run(DAY + 17 * MINUTE, DAY + 17 * MINUTE + 2 * SECOND);
    const databasePath = path.join(directory, STORE_FILE_NAME);
    const before = extract(databasePath, installMs);
    thin(DAY + 17 * MINUTE);
    const after = extract(databasePath, installMs);
    for (const [index, { markMs, medium, slow, sharing }] of after.entries()) {
      const was = before[index] as (typeof before)[number];
      // Never after the mark, within a minute of the whole store's reading (10 s before), and its own money.
      expect(medium.atMs).toBeLessThanOrEqual(markMs);
      expect(was.medium.atMs - medium.atMs).toBeLessThan(MINUTE);
      expect(markMs - was.medium.atMs).toBeLessThan(10 * SECOND);
      expect(medium.money).toBe(medium.atMs - T0);
      expect(slow).toEqual(was.slow);
      // 5 minutes of fast snapshots: 150 whole before, 5 after, the mean of a rising share within a minute's rise.
      expect([was.sharing.count, sharing.count]).toEqual([150, 5]);
      expect(Math.abs(sharing.mean - was.sharing.mean)).toBeLessThan(60);
    }
  });
});

describe("what it says (#283)", () => {
  test("its line: what it cut, the bytes and the time, a dry run's, or that there was nothing", () => {
    run(0, 3 * MINUTE);
    run(DAY + 2 * MINUTE, DAY + 2 * MINUTE + 2 * SECOND);
    const dry = thin(DAY + 2 * MINUTE, 1, true);
    const bytes = `${(dry.bytesBefore / 1e6).toFixed(1)} MB → ${(dry.bytesAfter / 1e6).toFixed(1)} MB`;
    expect(describeThinning(dry)).toBe(
      "store thinning (a dry run, nothing changed): would cut 58 fast and 10 medium snapshots before " +
        "2026-10-26T00:02:00.000Z to their times (the last 1 days before the newest snapshot kept whole; before, one " +
        `fast and one medium snapshot a minute), their data ${bytes}`,
    );
    const result = thin(DAY + 2 * MINUTE);
    expect(describeThinning({ ...result, tookMs: 1_234 })).toBe(
      "store thinned before 2026-10-26T00:02:00.000Z (the last 1 days before the newest snapshot kept whole; before, " +
        `one fast and one medium snapshot a minute): 58 fast and 10 medium snapshots cut to their times, their data ${bytes}, ` +
        "in 1.2 s",
    );
    expect(describeThinning({ ...result, bytesBefore: 123_456_789, bytesAfter: 2_345_678, tookMs: 0 })).toMatch(
      /their data 123\.5 MB → 2\.3 MB, in 0\.0 s$/,
    );
    expect(describeThinning(thin(DAY + 2 * MINUTE))).toBe(
      "store thinning: nothing to thin before 2026-10-26T00:02:00.000Z (the last 1 days before the newest snapshot " +
        "kept whole)",
    );
    expect(describeThinning({ ...result, beforeMs: null })).toBe("store thinning: no snapshots recorded yet");
  });

  test("at the brain's start: logged; a failure logged, recorded and returned for the dashboard, never thrown", () => {
    run(0, 3 * MINUTE);
    run(DAY + 2 * MINUTE, DAY + 2 * MINUTE + 2 * SECOND);
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    expect(thinStoreAtStart(store, { context, nowMs: T0 + DAY + 2 * MINUTE, keptWholeDays: 1, log })).toBeNull();
    expect(lines).toEqual([expect.stringMatching(/^store thinned before 2026-10-26T00:02:00\.000Z .*58 fast/)]);
    // Thinning that fails (a disk error, say): logged and recorded, the store as it was.
    run(DAY + 3 * MINUTE, DAY + 3 * MINUTE + 2 * SECOND);
    const wholeBefore = store.snapshots({ environment: "E0" });
    const failing = new Proxy(store, {
      get(target, property) {
        if (property === "thinSnapshots") {
          return () => {
            throw new Error("disk I/O error");
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    lines.length = 0;
    expect(thinStoreAtStart(failing, { context, nowMs: T0 + DAY + 3 * MINUTE, keptWholeDays: 1, log })).toEqual({
      atMs: T0 + DAY + 3 * MINUTE,
      failure: "disk I/O error",
    });
    expect(lines).toEqual(["store thinning FAILED, the store left as it was: disk I/O error"]);
    expect(store.events({ environment: "E0" }).at(-1)).toMatchObject({
      atMs: T0 + DAY + 3 * MINUTE,
      kind: STORE_THINNING_FAILED_EVENT_KIND,
      detail: { failure: "disk I/O error" },
    });
    expect(store.snapshots({ environment: "E0" })).toEqual(wholeBefore);
    // A store that can't be written at all: recording the failure fails too; both logged.
    store.close();
    store = TelemetryStore.openReadOnly(path.join(directory, STORE_FILE_NAME));
    lines.length = 0;
    thinStoreAtStart(store, { context, nowMs: T0 + DAY + 3 * MINUTE, keptWholeDays: 1, log });
    expect(lines).toEqual([
      expect.stringMatching(/^store thinning FAILED, the store left as it was: .*readonly/),
      expect.stringMatching(/^store thinning's failure not recorded: .*readonly/),
    ]);
  });
});

describe("the command: npm run thin (#283)", () => {
  /** Runs the command on the test's data directory: its output and exit code. */
  function runThin(args: string[]): { output: string; exitCode: number } {
    try {
      const output = execFileSync(process.execPath, [THIN_CLI, "--data-dir", directory, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { output, exitCode: 0 };
    } catch (error) {
      const { stdout, stderr, status } = error as { stdout: string; stderr: string; status: number };
      return { output: `${stdout}${stderr}`, exitCode: status };
    }
  }
  /** A config whose dashboard port is `dashboardPort`, and the days kept if given. */
  function configure(dashboardPort: number, keptWholeDays?: number) {
    const config = { ...defaultConfig(), dashboardPort, telemetryKeptWholeDays: keptWholeDays };
    writeFileSync(path.join(directory, CONFIG_FILE_NAME), JSON.stringify(config));
  }
  /** The backups beside the store. */
  const backups = () => readdirSync(directory).filter((name) => name.startsWith("telemetry.pre-thinning-"));
  /** Two runs before now, whenever the test runs: 3 minutes, and the newest snapshot 16 days later. */
  function oldRuns(minutes = 3) {
    const baseMs = Math.floor((Date.now() - 60 * DAY) / DAY) * DAY;
    run(0, minutes * MINUTE, { baseMs });
    run(16 * DAY, 16 * DAY + 2 * SECOND, { baseMs });
    store.close();
    return (offsetMs: number) => new Date(baseMs + offsetMs).toISOString();
  }
  const reopen = () => {
    store = TelemetryStore.open(path.join(directory, STORE_FILE_NAME));
  };

  test("by config.json's days kept, else 14, else --kept-whole-days; it never writes a config.json", () => {
    const iso = oldRuns();
    // No config.json: the default, 14 days, so minutes 0 to 2 are 2 days before the cutoff; and none is written.
    expect(DEFAULT_KEPT_WHOLE_DAYS).toBe(14);
    const byDefault = runThin(["--no-backup"]);
    expect(byDefault).toEqual({
      exitCode: 0,
      output: expect.stringMatching(new RegExp(`^store thinned before ${iso(2 * DAY)} .*: 87 fast and 15 medium`)),
    });
    expect(existsSync(path.join(directory, CONFIG_FILE_NAME))).toBe(false);
    // config.json's 19 days: none of it is old enough.
    configure(0, 19);
    expect(runThin([])).toEqual({
      exitCode: 0,
      output:
        `store thinning: nothing to thin before ${iso(-3 * DAY)} (the last 19 days before the newest snapshot kept ` +
        "whole)\n",
    });
    // The flag beats config.json.
    expect(runThin(["--kept-whole-days", "1"]).output).toContain(`nothing to thin before ${iso(15 * DAY)}`);
    reopen();
  });

  test("--dry-run says what it would cut and changes nothing; a thinning that cuts something backs up first, unless --no-backup", () => {
    const iso = oldRuns();
    configure(0);
    const dry = runThin(["--dry-run"]);
    expect(dry).toEqual({
      exitCode: 0,
      output: expect.stringMatching(
        new RegExp(
          `^store thinning \\(a dry run, nothing changed\\): would cut 87 fast and 15 medium snapshots before ${iso(2 * DAY)} `,
        ),
      ),
    });
    expect(backups()).toEqual([]);
    reopen();
    expect(snapshotsOf("fast").some((s) => isThinnedReading(s.data))).toBe(false);
    const whole = store.snapshots({ environment: "E0" });
    store.close();
    // The real one: a backup of the whole store first, named, then the thinning.
    const done = runThin([]);
    expect(done.exitCode).toBe(0);
    const [backup] = backups();
    expect(backup).toMatch(/^telemetry\.pre-thinning-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z\.sqlite$/);
    expect(done.output).toMatch(
      new RegExp(`^backed up first: .*${backup?.replace(/\./g, "\\.")} \\(\\d+\\.\\d MB\\)\\nstore thinned before `),
    );
    const copy = TelemetryStore.openReadOnly(path.join(directory, backup as string));
    expect(copy.snapshots({ environment: "E0" })).toEqual(whole);
    copy.close();
    // Nothing more to cut: no second backup.
    expect(runThin([]).output).toMatch(/^store thinning: nothing to thin/);
    expect(backups()).toHaveLength(1);
    reopen();
  });

  test("--no-backup thins with no copy", () => {
    oldRuns();
    configure(0);
    expect(runThin(["--no-backup"]).output).toMatch(/^store thinned before /);
    expect(backups()).toEqual([]);
    reopen();
    expect(snapshotsOf("fast").filter((s) => isThinnedReading(s.data))).toHaveLength(87);
  });

  test("refused while the brain runs: its lock names a live process, or its dashboard answers; a dead brain's lock doesn't count", async () => {
    oldRuns();
    configure(0);
    // This test's own process stands for a brain that's running.
    writeBrainLock(directory, { pid: process.pid, runnerPid: null });
    const locked = runThin([]);
    expect(locked).toEqual({
      exitCode: 2,
      output: expect.stringContaining(
        `the brain is running (its lock, ${path.join(directory, BRAIN_LOCK_FILE_NAME)}, names process ${process.pid})`,
      ),
    });
    expect(runThin(["--dry-run"]).exitCode).toBe(2);
    // A runner alive with its brain dead (crashed, about to be restarted) is running too.
    const dead = spawnSync(process.execPath, ["-e", ""]).pid as number;
    writeBrainLock(directory, { pid: dead, runnerPid: process.pid });
    expect(runThin([]).output).toContain(`names process ${dead} and its runner ${process.pid})`);
    // Both dead: a killed brain's lock, no longer running.
    writeBrainLock(directory, { pid: dead, runnerPid: dead });
    expect(runningBrain(directory)).toBeNull();
    // Something listening on the dashboard's port: refused, whatever the flags.
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const { port } = listener.address() as { port: number };
    configure(port);
    const refused = runThin(["--dry-run"]);
    listener.close();
    expect(refused).toEqual({ exitCode: 2, output: expect.stringContaining(`dashboard answers on 127.0.0.1:${port}`) });
    reopen();
    expect(snapshotsOf("fast").some((s) => isThinnedReading(s.data))).toBe(false);
    expect(backups()).toEqual([]);
    store.close();
    configure(0);
    expect(runThin(["--no-backup"]).exitCode).toBe(0);
    reopen();
  });

  test("--vacuum compacts the file after thinning, in the data directory, with sizes", () => {
    oldRuns(30);
    configure(0);
    const sizeBefore = statSync(path.join(directory, STORE_FILE_NAME)).size;
    const vacuumed = runThin(["--vacuum", "--no-backup"]);
    expect(vacuumed.exitCode).toBe(0);
    expect(vacuumed.output).toMatch(/store thinned before .*\ncompacted: \d+\.\d MB → \d+\.\d MB\n/);
    expect(statSync(path.join(directory, STORE_FILE_NAME)).size).toBeLessThan(sizeBefore);
    expect(readdirSync(directory).filter((name) => name.includes("compacted"))).toEqual([]);
    reopen();
    expect(snapshotsOf("fast").filter((s) => isThinnedReading(s.data))).toHaveLength(30 * 29);
  });

  test("it can't run: no store, a bad flag (exit 2)", () => {
    store.close();
    rmSync(path.join(directory, STORE_FILE_NAME));
    expect(runThin([])).toEqual({ exitCode: 2, output: expect.stringContaining("No telemetry store at") });
    reopen();
    for (const days of ["0", "2.5", "x"]) {
      expect(runThin(["--kept-whole-days", days])).toEqual({
        exitCode: 2,
        output: expect.stringContaining("--kept-whole-days must be a whole number of days, at least 1"),
      });
    }
  });
});
