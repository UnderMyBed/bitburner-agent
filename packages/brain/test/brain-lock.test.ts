// The brain's lock file (#283's review, #297's re-review): written whole, claimed over a dead brain's but never over a
// live one's, never fatal, removed only by its own brain, and counted while the brain or its runner is alive.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  BRAIN_LOCK_FILE_NAME,
  claimBrainLock,
  isAlive,
  removeBrainLock,
  runningBrain,
  writeBrainLock,
} from "../src/brain-lock.ts";

let directory: string;
let lines: string[];
const log = (line: string) => lines.push(line);
beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "brain-lock-"));
  lines = [];
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

/** A process id that was alive and isn't now. */
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid as number;
const lockText = () => readFileSync(path.join(directory, BRAIN_LOCK_FILE_NAME), "utf8");

test("written whole, through a file of its own renamed into place: nothing else left", () => {
  writeBrainLock(directory, { pid: 7, runnerPid: 8 });
  expect(JSON.parse(lockText())).toEqual({ pid: 7, runnerPid: 8 });
  expect(readdirSync(directory)).toEqual([BRAIN_LOCK_FILE_NAME]);
});

test("claimed over a dead brain's lock (a crash, restarted by the same runner), never over a live one's", () => {
  const dead = deadPid();
  writeBrainLock(directory, { pid: dead, runnerPid: process.pid });
  expect(isAlive(dead)).toBe(false);
  expect(claimBrainLock(directory, { pid: 41, runnerPid: process.pid }, log)).toBe(true);
  expect(JSON.parse(lockText())).toEqual({ pid: 41, runnerPid: process.pid });
  // A live brain's (this test's own process standing for it): left as it is, and said so.
  writeBrainLock(directory, { pid: process.pid, runnerPid: null });
  expect(claimBrainLock(directory, { pid: 42, runnerPid: null }, log)).toBe(false);
  expect(JSON.parse(lockText())).toEqual({ pid: process.pid, runnerPid: null });
  expect(lines).toEqual([
    `brain lock: another brain's process ${process.pid} holds ${path.join(directory, BRAIN_LOCK_FILE_NAME)}: left as it is`,
  ]);
  // Its own, again (the same process): claimed.
  expect(claimBrainLock(directory, { pid: process.pid, runnerPid: 5 }, log)).toBe(true);
});

test("a lock it can't write is logged, never thrown, and leaves no file of its own behind", () => {
  mkdirSync(path.join(directory, BRAIN_LOCK_FILE_NAME));
  expect(claimBrainLock(directory, { pid: 43, runnerPid: null }, log)).toBe(false);
  expect(lines).toEqual([
    expect.stringMatching(
      /^brain lock: couldn't write .*: npm run thin can tell this brain runs by its dashboard's port alone$/,
    ),
  ]);
  expect(readdirSync(directory)).toEqual([BRAIN_LOCK_FILE_NAME]);
  expect(runningBrain(directory)).toBeNull();
});

test("removed only by its own brain", () => {
  writeBrainLock(directory, { pid: 44, runnerPid: null });
  removeBrainLock(directory, 45);
  expect(JSON.parse(lockText())).toEqual({ pid: 44, runnerPid: null });
  removeBrainLock(directory, 44);
  expect(readdirSync(directory)).toEqual([]);
});

test("running while the brain or its runner is alive; not once both are dead, nor with no lock or a malformed one", () => {
  expect(runningBrain(directory)).toBeNull();
  const dead = deadPid();
  writeBrainLock(directory, { pid: process.pid, runnerPid: null });
  expect(runningBrain(directory)).toMatchObject({ pid: process.pid, runnerPid: null });
  writeBrainLock(directory, { pid: dead, runnerPid: process.pid });
  expect(runningBrain(directory)).toMatchObject({ pid: dead, runnerPid: process.pid });
  writeBrainLock(directory, { pid: dead, runnerPid: dead });
  expect(runningBrain(directory)).toBeNull();
  writeBrainLock(directory, { pid: "x" as unknown as number, runnerPid: null });
  expect(runningBrain(directory)).toBeNull();
});
