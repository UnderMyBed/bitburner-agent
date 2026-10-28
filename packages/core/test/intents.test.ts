// Intents (#141): each action's args, the id made from them, and which are irreversible (#147, #164).

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { AUGMENTATION_NAMES, NEUROFLUX_GOVERNOR, neuroFluxLevel } from "../src/augmentations.ts";
import {
  CLOUD_SERVER_MAX_RAM,
  isCloudServerHostname,
  RESERVED_HOSTNAME_PREFIXES,
  WORLD_DAEMON,
} from "../src/cloud-servers.ts";
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
    ["buyServer", { hostname: "pserv-0", ram: 8 }],
    ["buyServer", { hostname: "a", ram: 1 }],
    ["buyServer", { hostname: `Big_Box.${"x".repeat(56)}`, ram: 2 ** 20 }],
    ["backdoor", { hostname: "CSEC" }],
    ["backdoor", { hostname: "." }],
    ["backdoor", { hostname: "I.I.I.I" }],
    ["backdoor", { hostname: "run4theh111z" }],
    ["installAugmentations", {}],
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
    ["a server named with a space", { action: "buyServer", args: { hostname: "my server", ram: 8 } }],
    ["a server named ''", { action: "buyServer", args: { hostname: "", ram: 8 } }],
    ["a server named from a '-'", { action: "buyServer", args: { hostname: "-pserv", ram: 8 } }],
    ["a server named as an IP address", { action: "buyServer", args: { hostname: "10.0.0.1", ram: 8 } }],
    ["a server named as a Hacknet node", { action: "buyServer", args: { hostname: "hacknet-node-3", ram: 8 } }],
    ["a server named as a Hacknet server", { action: "buyServer", args: { hostname: "hacknet-server-0", ram: 8 } }],
    ["a server name of 65 characters", { action: "buyServer", args: { hostname: "x".repeat(65), ram: 8 } }],
    ["a server name that isn't text", { action: "buyServer", args: { hostname: 7, ram: 8 } }],
    ["server RAM that isn't a power of two", { action: "buyServer", args: { hostname: "pserv-0", ram: 24 } }],
    ["server RAM over 2^20 GB", { action: "buyServer", args: { hostname: "pserv-0", ram: 2 ** 21 } }],
    ["server RAM below 1 GB", { action: "buyServer", args: { hostname: "pserv-0", ram: 0.5 } }],
    ["server RAM as text", { action: "buyServer", args: { hostname: "pserv-0", ram: "8" } }],
    ["server RAM of 0", { action: "buyServer", args: { hostname: "pserv-0", ram: 0 } }],
    ["negative server RAM", { action: "buyServer", args: { hostname: "pserv-0", ram: -8 } }],
    ["server RAM that's NaN", { action: "buyServer", args: { hostname: "pserv-0", ram: Number.NaN } }],
    [
      "a server named w0r1d_d43m0n, which the game would buy as w0r1d_d43m0n-0, every try",
      { action: "buyServer", args: { hostname: "w0r1d_d43m0n", ram: 8 } },
    ],
    ["a backdoor on a name with a space", { action: "backdoor", args: { hostname: "The Cave" } }],
    ["a backdoor on ''", { action: "backdoor", args: { hostname: "" } }],
    ["a backdoor on a name of 65 characters", { action: "backdoor", args: { hostname: "x".repeat(65) } }],
    ["a backdoor on a name that isn't text", { action: "backdoor", args: { hostname: 7 } }],
    ["a backdoor on an IP address", { action: "backdoor", args: { hostname: "10.0.0.1" } }],
    ["a backdoor on w0r1d_d43m0n, which ends the BitNode", { action: "backdoor", args: { hostname: "w0r1d_d43m0n" } }],
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
  expect(intentId("buyServer", { hostname: "pserv-0", ram: 8 })).toBe("buyServer(pserv-0, 8)");
  expect(intentId("backdoor", { hostname: "CSEC" })).toBe("backdoor(CSEC)");
  // An install has no args (#164): one id, whatever was queued.
  expect(intentId("installAugmentations", {})).toBe("installAugmentations()");
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

  test("installing augmentations is irreversible: it resets the game (#164)", () => {
    expect(isIrreversibleIntent(intent({ action: "installAugmentations", args: {} }))).toBe(true);
  });

  test("nothing else so far is irreversible", () => {
    expect(isIrreversibleIntent(intent({ action: "joinFaction", args: { faction: "CyberSec" } }))).toBe(false);
    expect(isIrreversibleIntent(intent({ action: "travel", args: { city: "Aevum" } }))).toBe(false);
    expect(isIrreversibleIntent(intent({ action: "buyTor", args: { vendor: "Alpha Enterprises" } }))).toBe(false);
    const augmentation = { faction: "CyberSec", augmentation: "Neurotrainer I", level: 1 };
    expect(isIrreversibleIntent(intent({ action: "purchaseAugmentation", args: augmentation }))).toBe(false);
    expect(isIrreversibleIntent(intent({ action: "buyServer", args: { hostname: "pserv-0", ram: 8 } }))).toBe(false);
    expect(isIrreversibleIntent(intent({ action: "backdoor", args: { hostname: "CSEC" } }))).toBe(false);
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

test("cloud servers: the most RAM, the reserved prefixes and the IP address pattern are the pinned game's", () => {
  const source = (file: string) =>
    readFileSync(new URL(`../../../vendor/bitburner-src/src/${file}`, import.meta.url), "utf8");
  expect(source("Server/data/Constants.ts")).toContain(`CloudServerMaxRam: ${CLOUD_SERVER_MAX_RAM}, // 2^20`);
  expect(source("Server/data/SpecialServers.ts")).toContain(`WorldDaemon: "${WORLD_DAEMON}"`);
  const cloud = source("NetscriptFunctions/Cloud.ts");
  for (const prefix of RESERVED_HOSTNAME_PREFIXES) expect(cloud).toContain(`hostname.startsWith("${prefix}")`);
  // The game's own test of an IP address, character for character.
  const ipAddress = /const regex =\s+(\/\^.*\$\/);/.exec(source("Types/strings.ts"))?.[1];
  expect(ipAddress).toBeDefined();
  const gameIsIpAddress = new RegExp((ipAddress as string).slice(1, -1));
  for (const hostname of ["10.0.0.1", "255.255.255.255", "1.2.3", "999.1.1.1", "pserv-0", "1.2.3.4.5"]) {
    expect(isCloudServerHostname(hostname), hostname).toBe(!gameIsIpAddress.test(hostname));
  }
});

test.each([
  ["none installed or queued", 0, [], 0],
  ["none installed, two queued", 0, ["Neurotrainer I", NEUROFLUX_GOVERNOR, NEUROFLUX_GOVERNOR], 2],
  ["level 5 installed, none queued", 5, [NEUROFLUX_GOVERNOR, "Neurotrainer I"], 5],
  ["level 2 installed, one queued", 2, [NEUROFLUX_GOVERNOR, NEUROFLUX_GOVERNOR], 3],
])("neuroFluxLevel: %s is level %s", (_description, installedLevel, ownedNames, level) => {
  expect(neuroFluxLevel(installedLevel as number, ownedNames as string[])).toBe(level);
});
