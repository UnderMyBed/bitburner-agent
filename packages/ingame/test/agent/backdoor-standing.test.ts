// Where a backdoor stands (#162), as both backdoor workers read it first, with a stand-in NS: each refusal the
// terminal's `backdoor` makes, and the ones the simulator's BN1 can't reach (no way from home).
import { describe, expect, test } from "vitest";
import type { NS } from "../../src/ns.ts";
import { backdoorStanding, installingProblem } from "../../src/workers/backdoor-standing.ts";

interface StandInServer {
  backdoorInstalled?: boolean;
  isConnectedTo?: boolean;
  purchasedByPlayer?: boolean;
  hasAdminRights?: boolean;
  requiredHackingSkill?: number;
}

/** A game with these servers, linked home → n00dles → CSEC, and `island` linked to nothing; hacking level 50. */
function game(servers: Record<string, StandInServer>): NS {
  const links: Record<string, string[]> = { home: ["n00dles"], n00dles: ["home", "CSEC"], CSEC: ["n00dles"] };
  return {
    serverExists: (hostname: string) => hostname in servers,
    getServer: (hostname: string) => ({
      backdoorInstalled: false,
      isConnectedTo: false,
      purchasedByPlayer: false,
      hasAdminRights: true,
      requiredHackingSkill: 1,
      ...servers[hostname],
    }),
    getHackingLevel: () => 50,
    scan: (hostname: string) => links[hostname] ?? [],
  } as unknown as NS;
}

describe("backdoorStanding", () => {
  test("to install: the way from home, home left out", () => {
    expect(backdoorStanding(game({ CSEC: { requiredHackingSkill: 50 } }), "CSEC")).toEqual({
      installed: false,
      problem: null,
      route: ["n00dles", "CSEC"],
    });
  });

  test("installed: done, and whether the terminal is still on it", () => {
    expect(backdoorStanding(game({ CSEC: { backdoorInstalled: true } }), "CSEC")).toEqual({
      installed: true,
      terminalThere: false,
    });
    expect(backdoorStanding(game({ CSEC: { backdoorInstalled: true, isConnectedTo: true } }), "CSEC")).toEqual({
      installed: true,
      terminalThere: true,
    });
  });

  test.each([
    ["no such server", {}, "CSEC", "no server CSEC"],
    [
      "the player's own",
      { "pserv-0": { purchasedByPlayer: true } },
      "pserv-0",
      "pserv-0 is the player's own: the game backdoors only others' servers",
    ],
    ["no root", { CSEC: { hasAdminRights: false } }, "CSEC", "no root access on CSEC (NUKE.exe first)"],
    ["the level short", { CSEC: { requiredHackingSkill: 51 } }, "CSEC", "hacking level 50: CSEC needs 51"],
    ["no way there", { island: {} }, "island", "no way from home to island"],
  ])("refused, saying why: %s", (_description, servers, hostname, problem) => {
    expect(backdoorStanding(game(servers as Record<string, StandInServer>), hostname)).toEqual({
      installed: false,
      problem,
      route: null,
    });
  });
});

test("installingProblem: whole seconds left, at least 1", () => {
  expect(installingProblem("CSEC", 25_100)).toBe("installing the backdoor on CSEC: about 26 s left");
  expect(installingProblem("CSEC", 0)).toBe("installing the backdoor on CSEC: about 1 s left");
});
