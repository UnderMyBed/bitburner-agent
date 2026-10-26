// Saves for E2 tests, made by the simulator: saves flow from test environments only into test environments.
import { gunzipSync, gzipSync } from "node:zlib";
import { type GameSettingsOverride, Simulation } from "@bitburner-agent/sim";

/** The game's own autosave settings (vendor/bitburner-src/src/Settings/Settings.ts): every 60 s, warnings shown. */
const GAME_DEFAULT_AUTOSAVE = { AutosaveInterval: 60, SuppressAutosaveDisabledWarnings: false };

/**
 * `save` with the game's default autosave back on. The simulator turns autosave off, and its saves carry that
 * (packages/sim); on E2 the page should autosave as a player's does, since a deploy is saved only by an autosave (#91).
 */
function withGameDefaultAutosave(save: Uint8Array): Uint8Array {
  const saveObject = JSON.parse(gunzipSync(save).toString("utf8")) as { data: Record<string, string> };
  const settings = JSON.parse(saveObject.data.SettingsSave ?? "{}") as Record<string, unknown>;
  saveObject.data.SettingsSave = JSON.stringify({ ...settings, ...GAME_DEFAULT_AUTOSAVE });
  return new Uint8Array(gzipSync(JSON.stringify(saveObject)));
}

/**
 * A new game (tutorial skipped) in the simulator, saved after `prepare` has had its way with it: writing files,
 * running scripts, moving time. `gameSettings` go into the save (the Remote API's address and port, autoexec), and
 * so does the game's default autosave.
 */
export async function simulatorSave({
  gameSettings,
  prepare = async () => {},
}: {
  gameSettings?: GameSettingsOverride;
  prepare?: (sim: Simulation) => Promise<void>;
} = {}): Promise<Uint8Array> {
  const sim = await Simulation.start({
    fixture: { kind: "new", tutorial: "skipped" },
    epochMs: Date.UTC(2026, 0, 1),
    seed: 1,
    ...(gameSettings ? { gameSettings } : {}),
  });
  try {
    await prepare(sim);
    return withGameDefaultAutosave(await sim.save());
  } finally {
    await sim.close();
  }
}

/** The player's money, as the save holds it. */
export function moneyInSave(save: Uint8Array): number {
  const saveObject = JSON.parse(gunzipSync(save).toString("utf8")) as { data: { PlayerSave: string } };
  return (JSON.parse(saveObject.data.PlayerSave) as { data: { money: number } }).data.money;
}
