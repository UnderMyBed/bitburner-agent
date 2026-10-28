// Intents (#141): each action's args, the id made from them, and which are irreversible (#147).

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { AUGMENTATION_NAMES, NEUROFLUX_GOVERNOR, neuroFluxLevel } from "../src/augmentations.ts";
import { FACTION_ENEMIES, FACTION_NAMES } from "../src/factions.ts";
import {
  INTENT_ACTIONS,
  type IntentRequest,
  intentId,
  isIrreversibleIntent,
  parseIntentRequest,
} from "../src/intents.ts";

describe("parseIntentRequest", () => {
  test.each([
    ["buyTor", { vendor: "Alpha Enterprises" }],
    ["buyProgram", { program: "SQLInject.exe" }],
    ["upgradeHomeRam", { fromRam: 8, vendor: "CompuTek" }],
    ["travel", { city: "New Tokyo" }],
    ["joinFaction", { faction: "Bachman & Associates" }],
    ["purchaseAugmentation", { faction: "CyberSec", augmentation: "Neurotrainer I", level: 1 }],
    ["purchaseAugmentation", { faction: "Sector-12", augmentation: "NeuroFlux Governor", level: 7 }],
    ["purchaseAugmentation", { faction: "Blade Industries", augmentation: "The Blade's Simulacrum", level: 1 }],
  ])("%s with valid args, rebuilt from the known fields only", (action, args) => {
    expect(parseIntentRequest({ action, args: { ...args, extra: 1 }, extra: 2 })).toEqual({
      ok: true,
      message: { id: intentId(action as never, args as never), action, args },
    });
  });

  test.each([
    ["not an object", 7],
    ["an action that can't be made a string", { action: { toString: 1 }, args: {} }],
    ["an unknown action", { action: "hackTheGibson", args: {} }],
    ["no args", { action: "travel" }],
    ["TOR at a place that doesn't sell it", { action: "buyTor", args: { vendor: "Noodle Bar" } }],
    ["a program that isn't a port opener", { action: "buyProgram", args: { program: "Formulas.exe" } }],
    ["home RAM that isn't a power of two", { action: "upgradeHomeRam", args: { fromRam: 24, vendor: "CompuTek" } }],
    ["home RAM below 1 GB", { action: "upgradeHomeRam", args: { fromRam: 0.5, vendor: "CompuTek" } }],
    ["home RAM at the limit", { action: "upgradeHomeRam", args: { fromRam: 2 ** 30, vendor: "CompuTek" } }],
    ["home RAM as text", { action: "upgradeHomeRam", args: { fromRam: "8", vendor: "CompuTek" } }],
    ["home RAM without a vendor", { action: "upgradeHomeRam", args: { fromRam: 8 } }],
    ["a city that isn't one", { action: "travel", args: { city: "Atlantis" } }],
    ["a faction that isn't one", { action: "joinFaction", args: { faction: "The Gibson" } }],
    ["a faction named in another case", { action: "joinFaction", args: { faction: "cybersec" } }],
    [
      "an augmentation that isn't one",
      { action: "purchaseAugmentation", args: { faction: "CyberSec", augmentation: "Gibson Implant", level: 1 } },
    ],
    [
      "an augmentation from a faction that isn't one",
      { action: "purchaseAugmentation", args: { faction: "The Gibson", augmentation: "Neurotrainer I", level: 1 } },
    ],
    [
      "a level past 1 for an augmentation that has none",
      { action: "purchaseAugmentation", args: { faction: "CyberSec", augmentation: "Neurotrainer I", level: 2 } },
    ],
    [
      "a NeuroFlux level that isn't a whole number from 1",
      { action: "purchaseAugmentation", args: { faction: "Sector-12", augmentation: "NeuroFlux Governor", level: 0 } },
    ],
    [
      "a level as text",
      {
        action: "purchaseAugmentation",
        args: { faction: "Sector-12", augmentation: "NeuroFlux Governor", level: "3" },
      },
    ],
  ])("refuses %s, with a reason", (_description, request) => {
    const parsed = parseIntentRequest(request);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).not.toBe("");
  });
});

test("INTENT_ACTIONS names every action the parser knows, and only those", () => {
  const known = (action: string) =>
    !/unknown action/.test((parseIntentRequest({ action, args: {} }) as { reason: string }).reason);
  for (const action of INTENT_ACTIONS) expect(known(action), action).toBe(true);
});

test("an intent's id is its action and args, in the args' fixed order", () => {
  expect(intentId("travel", { city: "Aevum" })).toBe("travel(Aevum)");
  expect(intentId("upgradeHomeRam", { fromRam: 8, vendor: "CompuTek" })).toBe("upgradeHomeRam(8, CompuTek)");
  // NeuroFlux Governor keyed by level (#149): each level is its own intent.
  expect(intentId("purchaseAugmentation", { faction: "Sector-12", augmentation: "NeuroFlux Governor", level: 3 })).toBe(
    "purchaseAugmentation(Sector-12, NeuroFlux Governor, 3)",
  );
  const reordered = parseIntentRequest({ action: "upgradeHomeRam", args: { vendor: "CompuTek", fromRam: 8 } });
  expect(reordered.ok && reordered.message.id).toBe("upgradeHomeRam(8, CompuTek)");
});

describe("isIrreversibleIntent", () => {
  const intent = (request: IntentRequest) => ({ ...request, id: intentId(request.action, request.args) });

  test("joining a faction with enemies is irreversible: the six city factions, and only them", () => {
    const withEnemies = FACTION_NAMES.filter((faction) =>
      isIrreversibleIntent(intent({ action: "joinFaction", args: { faction } })),
    );
    expect(withEnemies.sort()).toEqual(["Aevum", "Chongqing", "Ishima", "New Tokyo", "Sector-12", "Volhaven"]);
  });

  test("the game's enemies: each city faction's, and they're mutual", () => {
    expect(FACTION_ENEMIES["Sector-12"]).toEqual(["Chongqing", "New Tokyo", "Ishima", "Volhaven"]);
    expect(FACTION_ENEMIES.Volhaven).toEqual(["Chongqing", "Sector-12", "New Tokyo", "Aevum", "Ishima"]);
    for (const [faction, enemies] of Object.entries(FACTION_ENEMIES)) {
      for (const enemy of enemies) expect(FACTION_ENEMIES[enemy], `${enemy} against ${faction}`).toContain(faction);
    }
  });

  test("nothing else so far is irreversible", () => {
    expect(isIrreversibleIntent(intent({ action: "joinFaction", args: { faction: "CyberSec" } }))).toBe(false);
    expect(isIrreversibleIntent(intent({ action: "travel", args: { city: "Aevum" } }))).toBe(false);
    expect(isIrreversibleIntent(intent({ action: "buyTor", args: { vendor: "Alpha Enterprises" } }))).toBe(false);
    const augmentation = { faction: "CyberSec", augmentation: "Neurotrainer I", level: 1 };
    expect(isIrreversibleIntent(intent({ action: "purchaseAugmentation", args: augmentation }))).toBe(false);
  });
});

/** The string values of `enumName` in the pinned game's source file `file` (commented-out entries left out). */
function gameEnumValues(file: string, enumName: string): string[] {
  const source = readFileSync(new URL(`../../../vendor/bitburner-src/src/${file}`, import.meta.url), "utf8");
  const start = source.indexOf(`export enum ${enumName}`);
  const body = source.slice(start, source.indexOf("}", start));
  return [...body.matchAll(/^\s+\w+ = "([^"]+)",/gm)].map((match) => match[1] as string);
}

test("AUGMENTATION_NAMES and FACTION_NAMES are the pinned game's, exactly", () => {
  expect(AUGMENTATION_NAMES).toEqual(gameEnumValues("Augmentation/Enums.ts", "AugmentationName"));
  expect(AUGMENTATION_NAMES).toContain(NEUROFLUX_GOVERNOR);
  expect(FACTION_NAMES).toEqual(gameEnumValues("Faction/Enums.ts", "FactionName"));
});

test.each([
  ["none installed or queued", 0, [], 0],
  ["none installed, two queued", 0, ["Neurotrainer I", NEUROFLUX_GOVERNOR, NEUROFLUX_GOVERNOR], 2],
  ["level 5 installed, none queued", 5, [NEUROFLUX_GOVERNOR, "Neurotrainer I"], 5],
  ["level 2 installed, one queued", 2, [NEUROFLUX_GOVERNOR, NEUROFLUX_GOVERNOR], 3],
])("neuroFluxLevel: %s is level %s", (_description, installedLevel, ownedNames, level) => {
  expect(neuroFluxLevel(installedLevel as number, ownedNames as string[])).toBe(level);
});
