// Save backups (#92) through the game's own Remote File API, in the simulator: a backup is the game's own save at that
// moment, and loads as a simulator save fixture to the same state as that save.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { useSimulations } from "@bitburner-agent/sim/test-helpers";
import { afterAll, expect, test } from "vitest";
import { type SaveBackupEvent, SaveBackups } from "../src/save-backups.ts";
import { SimulatedGame } from "../src/simulated-game.ts";
import { EPOCH_MS } from "./helpers/agent-in-simulation.ts";
import { BRAIN_RFA_SETTINGS, RFA_URL } from "./helpers/brain-in-simulation.ts";

const start = useSimulations();
const dataDirectory = mkdtempSync(path.join(os.tmpdir(), "save-backup-round-trip-"));
afterAll(() => rmSync(dataDirectory, { recursive: true, force: true }));

test("a backup taken through the game's RFA is the game's own save, and loads as a save fixture to the same state", async () => {
  const simulation = await start({
    seed: 1,
    epochMs: EPOCH_MS,
    fixture: { kind: "new", tutorial: "skipped" },
    network: { listenUrls: [RFA_URL] },
    gameSettings: BRAIN_RFA_SETTINGS,
  });
  // Small steps: the backup is compared with the game's save taken right after the step its reply came in.
  const game = await SimulatedGame.create({ simulation, stepMs: 10 });
  const backups = new SaveBackups({
    dataDirectory,
    environment: "E1",
    backupIntervalMs: 30 * 60_000,
    backupsKept: 96,
    clock: game.clock,
  });
  const events: SaveBackupEvent[] = [];
  backups.subscribe((event) => events.push(event));
  game.listen(RFA_URL, (connection) => backups.accept(connection));
  await game.runUntil(() => events.length > 0, 10_000);
  const ownSave = await simulation.save();

  const [event] = events;
  if (!event || !("file" in event)) throw new Error(`the backup failed: ${JSON.stringify(event)}`);
  expect(event.file).toMatch(/^saves\/E1\/[^/]+\.json\.gz$/);
  const backupPath = path.join(dataDirectory, event.file);
  const backup = readFileSync(backupPath);
  expect(event.sizeBytes).toBe(backup.length);
  expect(gunzipSync(backup).toString("utf8")).toBe(gunzipSync(ownSave).toString("utf8"));

  const [fromBackup, fromOwnSave] = await Promise.all([
    start({ seed: 1, fixture: { kind: "save", path: backupPath } }),
    start({ seed: 1, fixture: { kind: "save", bytes: ownSave } }),
  ]);
  expect(await fromBackup.stateHash()).toBe(await fromOwnSave.stateHash());
});
