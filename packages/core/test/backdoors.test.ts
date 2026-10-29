// The hacker factions' servers (#195): the four the brain backdoors, checked against the pinned game's source.

import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { HACKER_FACTION_SERVERS, isServerHostname } from "../src/backdoors.ts";
import { FACTION_NAMES } from "../src/factions.ts";

const source = (file: string) =>
  readFileSync(new URL(`../../../vendor/bitburner-src/src/${file}`, import.meta.url), "utf8");

/** Each server's `SpecialServers` key, and its faction's `FactionName` key. */
const GAME_KEYS = [
  { server: "CyberSecServer", faction: "CyberSec" },
  { server: "NiteSecServer", faction: "NiteSec" },
  { server: "TheBlackHandServer", faction: "TheBlackHand" },
  { server: "BitRunnersServer", faction: "BitRunners" },
];

test("HACKER_FACTION_SERVERS: CSEC, avmnite-02h, I.I.I.I and run4theh111z, each with its faction, in that order", () => {
  expect(HACKER_FACTION_SERVERS).toEqual([
    { hostname: "CSEC", faction: "CyberSec" },
    { hostname: "avmnite-02h", faction: "NiteSec" },
    { hostname: "I.I.I.I", faction: "The Black Hand" },
    { hostname: "run4theh111z", faction: "BitRunners" },
  ]);
  for (const { hostname, faction } of HACKER_FACTION_SERVERS) {
    expect(isServerHostname(hostname)).toBe(true);
    expect(FACTION_NAMES).toContain(faction);
  }
});

test("HACKER_FACTION_SERVERS is the pinned game's: the servers' names, and each faction invites on its backdoor alone", () => {
  const specialServers = source("Server/data/SpecialServers.ts");
  const factionNames = source("Faction/Enums.ts");
  const factionInfo = source("Faction/FactionInfo.tsx");
  for (const [index, { hostname, faction }] of HACKER_FACTION_SERVERS.entries()) {
    const keys = GAME_KEYS[index] as (typeof GAME_KEYS)[number];
    expect(specialServers).toContain(`${keys.server}: "${hostname}",`);
    expect(factionNames).toContain(`${keys.faction} = "${faction}",`);
    // The faction's entry, to the next one: its invitation's only requirement is the backdoor.
    const start = factionInfo.indexOf(`[FactionName.${keys.faction}]: new FactionInfo({`);
    expect(start).toBeGreaterThan(-1);
    const entry = factionInfo.slice(start, factionInfo.indexOf("[FactionName.", start + 1));
    const inviteReqs = /inviteReqs: \[([^\]]*)\]/.exec(entry)?.[1]?.replace(/\s+/g, "");
    expect(inviteReqs).toBe(`haveBackdooredServer(SpecialServers.${keys.server})`);
  }
});

test("HACKER_FACTION_SERVERS goes up in the ports and the hacking level each server needs", () => {
  const servers = source("Server/data/servers.ts");
  const needs = GAME_KEYS.map(({ server }) => {
    const start = servers.indexOf(`hostname: SpecialServers.${server},`);
    const entry = servers.slice(start, servers.indexOf("specialName:", start));
    return {
      ports: Number(/numOpenPortsRequired: (\d+),/.exec(entry)?.[1]),
      level: /requiredHackingSkill: \{\s*max: (\d+),\s*min: (\d+),/.exec(entry)?.slice(1).map(Number),
    };
  });
  expect(needs).toEqual([
    { ports: 1, level: [60, 51] },
    { ports: 2, level: [220, 202] },
    { ports: 3, level: [365, 340] },
    { ports: 4, level: [550, 505] },
  ]);
});
