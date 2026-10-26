// Saves for E2 tests, made by the simulator: saves flow from test environments only into test environments.
import { gunzipSync } from "node:zlib";
import { type GameSettingsOverride, Simulation } from "@bitburner-agent/sim";

/**
 * A new game (tutorial skipped) in the simulator, saved after `prepare` has had its way with it: writing files,
 * running scripts, moving time. `gameSettings` go into the save: the Remote API's address and port, autoexec.
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
    return await sim.save();
  } finally {
    await sim.close();
  }
}

/** The player's money, as the save holds it. */
export function moneyInSave(save: Uint8Array): number {
  const saveObject = JSON.parse(gunzipSync(save).toString("utf8")) as { data: { PlayerSave: string } };
  return (JSON.parse(saveObject.data.PlayerSave) as { data: { money: number } }).data.money;
}
