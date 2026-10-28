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

type SaveObject = { data: { PlayerSave: string } };

/** A save's outer object and its player, parsed. */
function readPlayerSave(save: Uint8Array): {
  saveObject: SaveObject;
  player: { data: { money: number; city: string } };
} {
  const saveObject = JSON.parse(gunzipSync(save).toString("utf8")) as SaveObject;
  return { saveObject, player: JSON.parse(saveObject.data.PlayerSave) };
}

/**
 * `save` with the player's money set: a test environment's save, edited by the test harness (allowed there; never a
 * Steam save, which only ever flows one way, from Steam).
 */
export function withMoney(save: Uint8Array, money: number): Uint8Array {
  const { saveObject, player } = readPlayerSave(save);
  player.data.money = money;
  saveObject.data.PlayerSave = JSON.stringify(player);
  return new Uint8Array(gzipSync(JSON.stringify(saveObject)));
}

/**
 * `save` with these game settings (Options) changed, the rest kept: a test environment's save, as for `withMoney`.
 * The settings are the game's own names (`Settings/Settings.ts`), e.g. `DisableASCIIArt`.
 */
export function withGameSettings(save: Uint8Array, changes: Record<string, unknown>): Uint8Array {
  const saveObject = JSON.parse(gunzipSync(save).toString("utf8")) as { data: { SettingsSave?: string } };
  const settings = saveObject.data.SettingsSave ? (JSON.parse(saveObject.data.SettingsSave) as object) : {};
  saveObject.data.SettingsSave = JSON.stringify({ ...settings, ...changes });
  return new Uint8Array(gzipSync(JSON.stringify(saveObject)));
}

/** `save` with the player in `city` (one of the game's six), as for `withMoney`. */
export function withCity(save: Uint8Array, city: string): Uint8Array {
  const { saveObject, player } = readPlayerSave(save);
  player.data.city = city;
  saveObject.data.PlayerSave = JSON.stringify(player);
  return new Uint8Array(gzipSync(JSON.stringify(saveObject)));
}

/**
 * `save` with a script on home, as the owner's own: a test environment's save, as for `withMoney`. Home's scripts are
 * a `JSONMap` of `Script`s in the save (`Types/Jsonable.ts`, `Script/Script.ts` `savedKeys`).
 */
export function withHomeScript(save: Uint8Array, filename: string, code: string): Uint8Array {
  const saveObject = JSON.parse(gunzipSync(save).toString("utf8")) as { data: { AllServersSave: string } };
  const servers = JSON.parse(saveObject.data.AllServersSave) as Record<
    string,
    { data: { hostname: string; scripts: { data: unknown[] } } }
  >;
  const home = Object.values(servers).find((server) => server.data.hostname === "home");
  if (!home) throw new Error("the save has no home");
  home.data.scripts.data.push([filename, { ctor: "Script", data: { code, filename, server: "home" } }]);
  saveObject.data.AllServersSave = JSON.stringify(servers);
  return new Uint8Array(gzipSync(JSON.stringify(saveObject)));
}

/** The player's money, as the save holds it. */
export function moneyInSave(save: Uint8Array): number {
  return readPlayerSave(save).player.data.money;
}
