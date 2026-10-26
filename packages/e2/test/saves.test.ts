// The E2 saves helper, without a browser: this runs in CI with the other unit tests.
import { gunzipSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { simulatorSave } from "./helpers/saves.ts";

describe("simulatorSave", () => {
  test("turns the game's default autosave back on, which the simulator's own saves have off", async () => {
    const save = await simulatorSave({ gameSettings: { AutoexecScript: "agent/boot.js" } });
    const saveObject = JSON.parse(gunzipSync(save).toString("utf8")) as { data: { SettingsSave: string } };
    expect(JSON.parse(saveObject.data.SettingsSave)).toMatchObject({
      AutosaveInterval: 60,
      SuppressAutosaveDisabledWarnings: false,
      // The settings asked for are kept.
      AutoexecScript: "agent/boot.js",
    });
  });
});
