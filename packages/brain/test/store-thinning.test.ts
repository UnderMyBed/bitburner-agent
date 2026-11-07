// Thinning the telemetry store (#283): what stays whole, what's cut to a stub with its times, where each thinning
// starts and stops, what it records and logs, and its command. Over stores built here, never the owner's .data/.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CONFIG_FILE_NAME, loadOrCreateConfig, STORE_FILE_NAME } from "../src/config.ts";
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
const fastData = (offsetMs: number) => ({
  degradedTiers: offsetMs % (10 * SECOND) === 4 * SECOND ? ["medium"] : [],
  pageHeapUsedBytes: 100_000_000 + offsetMs,
  game: { money: offsetMs, homeRamUsed: 4, homeMaxRam: 8, homeProcesses: [{ pid: 1, filename: "a.js" }] },
  intents: [{ id: "buyTor()", done: false, tries: 1, problem: null, backend: "ui" }],
  dialogs: { handled: [], blocking: null },
  batcher: { state: "batching", target: "n00dles", sharing: 64 },
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
      if (offsetMs % MINUTE === 0) record("slow", offsetMs, { purchasedServers: [] });
      if (offsetMs % (10 * SECOND) === 0) record("medium", offsetMs, mediumData(offsetMs));
      record("fast", offsetMs, fastData(offsetMs));
    }
    if (fromMs === 0) record("static", 0, { servers: [] });
  });
}
const snapshotsOf = (tier: string, environment: "E0" | "E2" = "E0") =>
  store.snapshots({ environment }).filter((snapshot) => snapshot.tier === tier);
const thinnedEvents = () => store.events({ environment: "E0" }).filter((e) => e.kind === STORE_THINNED_EVENT_KIND);
/** Thins as the brain would at `nowMs` (an offset from T0), keeping a day whole unless said. */
const thin = (nowOffsetMs: number, keptWholeDays = 1) =>
  thinStore(store, { context, nowMs: T0 + nowOffsetMs, keptWholeDays });

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
      thinned: { fast: 58, medium: 10 },
      bytesBefore: expect.any(Number),
      bytesAfter: expect.any(Number),
    });
    expect(result.bytesAfter).toBeLessThan(result.bytesBefore / 3);
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

  test("a fast snapshot's stub keeps a degraded tier, and a null page heap; data that says nothing gives nulls", () => {
    store.recordSnapshot(context, {
      agentSessionId: "s",
      tier: "fast",
      sequenceNumber: 1,
      gameTimeMs: 0,
      receivedAtMs: T0,
      missedBefore: 0,
      data: { degradedTiers: ["slow", "fast"], pageHeapUsedBytes: null },
    });
    for (const [index, data] of [
      { degradedTiers: ["slow", "fast"], pageHeapUsedBytes: null },
      null,
      { other: 1 },
    ].entries()) {
      store.recordSnapshot(context, {
        agentSessionId: "s",
        tier: "fast",
        sequenceNumber: index + 2,
        gameTimeMs: 0,
        receivedAtMs: T0 + (index + 1) * 2 * SECOND,
        missedBefore: 0,
        data,
      });
    }
    store.recordSnapshot(context, {
      agentSessionId: "s",
      tier: "fast",
      sequenceNumber: 9,
      gameTimeMs: 0,
      receivedAtMs: T0 + 2 * DAY,
      missedBefore: 0,
      data: null,
    });
    thin(2 * DAY);
    expect(snapshotsOf("fast").map((snapshot) => snapshot.data)).toEqual([
      { degradedTiers: ["slow", "fast"], pageHeapUsedBytes: null },
      { thinned: true, degradedTiers: ["slow", "fast"], pageHeapUsedBytes: null },
      { thinned: true, degradedTiers: null, pageHeapUsedBytes: null },
      { thinned: true, degradedTiers: null, pageHeapUsedBytes: null },
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
});

describe("when, and from where (#283)", () => {
  test("the cutoff is the days kept before the newest snapshot, on a minute: after a long pause, nothing new is thinned", () => {
    run(0, 3 * MINUTE);
    // A month on, the brain starts: its newest record is 3 minutes in, so with 1 day kept, nothing is old enough.
    const paused = thin(30 * DAY);
    expect(paused).toMatchObject({ beforeMs: Math.floor((T0 + 3 * MINUTE - 2 * SECOND - DAY) / MINUTE) * MINUTE });
    expect(paused.thinned).toEqual({ fast: 0, medium: 0 });
    expect(thinnedEvents()).toEqual([]);
    // With the newest record in the future (a clock set back), now is the bound.
    run(40 * DAY, 40 * DAY + 2 * SECOND);
    expect(thin(DAY + MINUTE + 30 * SECOND)).toMatchObject({ beforeMs: T0 + MINUTE, thinned: { fast: 29, medium: 5 } });
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

  test("more days kept than last time: nothing until the new cutoff passes the old", () => {
    run(0, 4 * MINUTE);
    run(DAY + 2 * MINUTE, DAY + 2 * MINUTE + 2 * SECOND);
    thin(DAY + 2 * MINUTE);
    expect(thin(DAY + 2 * MINUTE, 2).thinned).toEqual({ fast: 0, medium: 0 });
    expect(thinnedEvents()).toHaveLength(1);
  });

  test("a store with no snapshots: nothing to thin, nothing recorded", () => {
    expect(thin(DAY)).toEqual({
      beforeMs: null,
      fromMs: null,
      keptWholeDays: 1,
      thinned: { fast: 0, medium: 0 },
      bytesBefore: 0,
      bytesAfter: 0,
    });
    expect(thinnedEvents()).toEqual([]);
  });
});

describe("what it says (#283)", () => {
  test("its line: what it cut and the bytes, or that there was nothing", () => {
    run(0, 3 * MINUTE);
    run(DAY + 2 * MINUTE, DAY + 2 * MINUTE + 2 * SECOND);
    const result = thin(DAY + 2 * MINUTE);
    expect(describeThinning(result)).toBe(
      "store thinned before 2026-10-26T00:02:00.000Z (the last 1 days of records kept whole; before, one fast and one " +
        "medium snapshot a minute): 58 fast and 10 medium snapshots cut to their times, their data " +
        `${(result.bytesBefore / 1e6).toFixed(1)} MB → ${(result.bytesAfter / 1e6).toFixed(1)} MB`,
    );
    expect(describeThinning({ ...result, bytesBefore: 123_456_789, bytesAfter: 2_345_678 })).toMatch(
      /their data 123\.5 MB → 2\.3 MB$/,
    );
    expect(describeThinning(thin(DAY + 2 * MINUTE))).toBe(
      "store thinning: nothing to thin before 2026-10-26T00:02:00.000Z (the last 1 days of records kept whole)",
    );
    expect(describeThinning({ ...result, beforeMs: null })).toBe("store thinning: no snapshots recorded yet");
  });

  test("at the brain's start: logged; a failure logged and recorded, never thrown", () => {
    run(0, 3 * MINUTE);
    run(DAY + 2 * MINUTE, DAY + 2 * MINUTE + 2 * SECOND);
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    thinStoreAtStart(store, { context, nowMs: T0 + DAY + 2 * MINUTE, keptWholeDays: 1, log });
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
    thinStoreAtStart(failing, { context, nowMs: T0 + DAY + 3 * MINUTE, keptWholeDays: 1, log });
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
    const config = { ...loadOrCreateConfig(directory), dashboardPort, telemetryKeptWholeDays: keptWholeDays };
    writeFileSync(path.join(directory, CONFIG_FILE_NAME), JSON.stringify(config));
  }

  test("thins as the brain's start does, by config.json's days kept or --kept-whole-days, and says what it did", () => {
    // Before now, whenever the test runs: the cutoff is the newest snapshot's time less the days kept.
    const baseMs = Math.floor((Date.now() - 60 * DAY) / DAY) * DAY;
    const iso = (offsetMs: number) => new Date(baseMs + offsetMs).toISOString();
    run(0, 3 * MINUTE, { baseMs });
    run(16 * DAY, 16 * DAY + 2 * SECOND, { baseMs });
    store.close();
    // config.json's 19 days: none of it is old enough.
    configure(0, 19);
    expect(runThin([])).toEqual({
      exitCode: 0,
      output: `store thinning: nothing to thin before ${iso(-3 * DAY)} (the last 19 days of records kept whole)\n`,
    });
    // Saying nothing, the default: 14 days, so minutes 0 to 2 are 2 days before the cutoff.
    configure(0);
    expect(DEFAULT_KEPT_WHOLE_DAYS).toBe(14);
    expect(runThin([])).toEqual({
      exitCode: 0,
      output: expect.stringMatching(new RegExp(`^store thinned before ${iso(2 * DAY)} .*: 87 fast and 15 medium`)),
    });
    // The flag beats config.json.
    configure(0, 19);
    expect(runThin(["--kept-whole-days", "1"]).output).toContain(`nothing to thin before ${iso(15 * DAY)}`);
    store = TelemetryStore.open(path.join(directory, STORE_FILE_NAME));
  });

  test("--vacuum compacts the file after thinning, with sizes; refused while the brain's dashboard answers", async () => {
    const baseMs = Math.floor((Date.now() - 60 * DAY) / DAY) * DAY;
    run(0, 30 * MINUTE, { baseMs });
    run(2 * DAY, 2 * DAY + 2 * SECOND, { baseMs });
    store.close();
    // Something listening on the dashboard's port: a brain running. Refused, and nothing changed.
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const { port } = listener.address() as { port: number };
    configure(port, 1);
    const refused = runThin(["--vacuum"]);
    listener.close();
    expect(refused).toEqual({ exitCode: 2, output: expect.stringContaining(`dashboard answers on 127.0.0.1:${port}`) });
    store = TelemetryStore.openReadOnly(path.join(directory, STORE_FILE_NAME));
    expect(snapshotsOf("fast").some((s) => isThinnedReading(s.data))).toBe(false);
    store.close();
    configure(0, 1);
    const sizeBefore = statSync(path.join(directory, STORE_FILE_NAME)).size;
    const vacuumed = runThin(["--vacuum"]);
    expect(vacuumed.exitCode).toBe(0);
    expect(vacuumed.output).toMatch(/store thinned before .*\ncompacted: \d+\.\d MB → \d+\.\d MB\n/);
    expect(statSync(path.join(directory, STORE_FILE_NAME)).size).toBeLessThan(sizeBefore);
    store = TelemetryStore.open(path.join(directory, STORE_FILE_NAME));
  });

  test("it can't run: no store, a bad flag (exit 2)", () => {
    store.close();
    rmSync(path.join(directory, STORE_FILE_NAME));
    expect(runThin([])).toEqual({ exitCode: 2, output: expect.stringContaining("No telemetry store at") });
    store = TelemetryStore.open(path.join(directory, STORE_FILE_NAME));
    for (const days of ["0", "2.5", "x"]) {
      expect(runThin(["--kept-whole-days", days])).toEqual({
        exitCode: 2,
        output: expect.stringContaining("--kept-whole-days must be a whole number of days, at least 1"),
      });
    }
  });
});
