// The supervision switch (#93, #94): the dashboard sets it, the supervisor reads it, and the store keeps it across
// restarts of the brain.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { readSupervisionSwitch, recordSupervisionGaveUp, setSupervisionPaused } from "../src/supervision.ts";
import { TelemetryStore } from "../src/telemetry-store.ts";

let directory: string;
let store: TelemetryStore;
beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "supervision-"));
  store = TelemetryStore.open(path.join(directory, "telemetry.sqlite"));
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

test("by default supervision runs: not paused, not given up", () => {
  expect(readSupervisionSwitch(store)).toEqual({ paused: false, gaveUpAtMs: null });
});

test("pausing is stored and survives a restart of the brain", () => {
  setSupervisionPaused(store, true);
  store.close();
  store = TelemetryStore.open(path.join(directory, "telemetry.sqlite"));
  expect(readSupervisionSwitch(store)).toEqual({ paused: true, gaveUpAtMs: null });
  setSupervisionPaused(store, false);
  expect(readSupervisionSwitch(store)).toEqual({ paused: false, gaveUpAtMs: null });
});

test("a give-up stays until supervision is unpaused; pausing alone keeps it", () => {
  recordSupervisionGaveUp(store, 1_000);
  expect(readSupervisionSwitch(store)).toEqual({ paused: false, gaveUpAtMs: 1_000 });
  setSupervisionPaused(store, true);
  expect(readSupervisionSwitch(store)).toEqual({ paused: true, gaveUpAtMs: 1_000 });
  setSupervisionPaused(store, false);
  expect(readSupervisionSwitch(store)).toEqual({ paused: false, gaveUpAtMs: null });
});
