// The brain's backdoors for the hacker factions (#195): which server is due, why none is, and the rule's log.
import type { MediumSnapshotData, StaticSnapshotData } from "@bitburner-agent/core";
import { describe, expect, test } from "vitest";
import { BackdoorRule, backdoorIntent, chooseBackdoor } from "../src/backdoors.ts";
import { mediumData, staticServer } from "./helpers/snapshot-fixtures.ts";

/** The four as a game might roll them (`Server/data/servers.ts`): CSEC at 54, and so on. */
const network: StaticSnapshotData = {
  servers: [
    staticServer("home", { moneyMax: 0 }),
    staticServer("n00dles"),
    staticServer("CSEC", { moneyMax: 0, requiredHackingSkill: 54, numOpenPortsRequired: 1 }),
    staticServer("avmnite-02h", { moneyMax: 0, requiredHackingSkill: 207, numOpenPortsRequired: 2 }),
    staticServer("I.I.I.I", { moneyMax: 0, requiredHackingSkill: 350, numOpenPortsRequired: 3 }),
    staticServer("run4theh111z", { moneyMax: 0, requiredHackingSkill: 530, numOpenPortsRequired: 4 }),
  ],
};
const FOUR = ["CSEC", "avmnite-02h", "I.I.I.I", "run4theh111z"];

/** A medium snapshot at `hacking`, the four rooted as `rooted` says (all, by default) and backdoored as `backdoored`. */
function medium(hacking: number, { rooted = FOUR, backdoored = [] as string[] } = {}): MediumSnapshotData {
  const data = mediumData(hacking, Object.fromEntries(["n00dles", ...FOUR].map((host) => [host, true])));
  for (const server of data.servers) {
    server.hasAdminRights = server.hostname === "n00dles" || rooted.includes(server.hostname);
    server.backdoorInstalled = backdoored.includes(server.hostname);
  }
  return data;
}

describe("chooseBackdoor", () => {
  test("the first rooted, not backdoored, at its level: CSEC at 54 from hacking 54 (exactly at it is enough)", () => {
    expect(chooseBackdoor(network, medium(54))).toEqual({
      next: { hostname: "CSEC", faction: "CyberSec", hackingLevel: 54, requiredHackingSkill: 54 },
      installed: [],
      waitingFor: null,
    });
  });

  test("below the level: none, saying the level", () => {
    expect(chooseBackdoor(network, medium(53))).toEqual({
      next: null,
      installed: [],
      waitingFor: "hacking 53: CSEC needs 54",
    });
  });

  test("not rooted: none, saying the ports the hack loop roots it with", () => {
    expect(chooseBackdoor(network, medium(400, { rooted: [] })).waitingFor).toBe(
      "root on CSEC (the hack loop roots it with 1 port opener)",
    );
    expect(chooseBackdoor(network, medium(400, { rooted: ["CSEC"], backdoored: ["CSEC"] })).waitingFor).toBe(
      "root on avmnite-02h (the hack loop roots it with 2 port openers)",
    );
  });

  test("in order, skipping those backdoored; then the next one's reason; none once all four are", () => {
    expect(chooseBackdoor(network, medium(400, { backdoored: ["CSEC"] }))).toEqual({
      next: { hostname: "avmnite-02h", faction: "NiteSec", hackingLevel: 400, requiredHackingSkill: 207 },
      installed: ["CSEC"],
      waitingFor: null,
    });
    expect(chooseBackdoor(network, medium(400, { backdoored: ["CSEC", "avmnite-02h"] })).next?.hostname).toBe(
      "I.I.I.I",
    );
    expect(chooseBackdoor(network, medium(400, { backdoored: ["CSEC", "avmnite-02h", "I.I.I.I"] }))).toEqual({
      next: null,
      installed: ["CSEC", "avmnite-02h", "I.I.I.I"],
      waitingFor: "hacking 400: run4theh111z needs 530",
    });
    expect(chooseBackdoor(network, medium(600, { backdoored: FOUR }))).toEqual({
      next: null,
      installed: FOUR,
      waitingFor: null,
    });
    expect(chooseBackdoor(network, medium(600, { backdoored: ["avmnite-02h"] })).next?.hostname).toBe("CSEC");
  });

  test("one passed over (not rooted) doesn't hold up a later one that can go, rooted by the owner say", () => {
    expect(chooseBackdoor(network, medium(400, { rooted: ["avmnite-02h"] }))).toEqual({
      next: { hostname: "avmnite-02h", faction: "NiteSec", hackingLevel: 400, requiredHackingSkill: 207 },
      installed: [],
      waitingFor: null,
    });
  });

  test("fails closed on what the snapshots don't say: a server missing, no required level, no backdoor field", () => {
    const withoutCsec = { servers: network.servers.filter((server) => server.hostname !== "CSEC") };
    expect(chooseBackdoor(withoutCsec, medium(100)).waitingFor).toBe("CSEC in the Agent's snapshots");
    expect(chooseBackdoor(withoutCsec, medium(400)).next?.hostname).toBe("avmnite-02h");
    const noLevel = {
      servers: network.servers.map((server) =>
        server.hostname === "CSEC" ? { ...server, requiredHackingSkill: undefined } : server,
      ),
    };
    expect(chooseBackdoor(noLevel, medium(100)).waitingFor).toBe("CSEC in the Agent's snapshots");
    const noField = medium(400);
    for (const server of noField.servers) delete server.backdoorInstalled;
    expect(chooseBackdoor(network, noField)).toEqual({
      next: null,
      installed: [],
      waitingFor: "CSEC in the Agent's snapshots",
    });
    const noHacking = medium(400);
    noHacking.player = { skills: { hacking: "lots" } };
    expect(chooseBackdoor(network, noHacking)).toEqual({
      next: null,
      installed: [],
      waitingFor: "the hacking level in the Agent's medium snapshot",
    });
    expect(chooseBackdoor({} as StaticSnapshotData, {} as MediumSnapshotData).next).toBeNull();
  });
});

test("backdoorIntent: the #162 intent, with its id", () => {
  expect(backdoorIntent("I.I.I.I")).toEqual({
    id: "backdoor(I.I.I.I)",
    action: "backdoor",
    args: { hostname: "I.I.I.I" },
  });
});

describe("BackdoorRule: the controller's side, and the brain's log", () => {
  const MINUTE = 60_000;
  const at = (minutes: number) => Date.UTC(2026, 9, 28) + minutes * MINUTE;
  const NONE_DONE: ReadonlySet<string> = new Set();
  const inputs = (data: MediumSnapshotData, minutes: number, resetAt: number | null = 1, done: string[] = []) => ({
    staticData: network,
    mediumData: data,
    mediumAtMs: at(minutes),
    resetAt,
    doneIds: new Set(done),
  });
  const CSEC = backdoorIntent("CSEC");

  test("none before the connected Agent's static and medium snapshots", () => {
    const rule = new BackdoorRule();
    const none = { mediumAtMs: 1, resetAt: 1, doneIds: NONE_DONE };
    expect(rule.intent({ ...none, staticData: null, mediumData: medium(400) })).toBeNull();
    expect(rule.intent({ ...none, staticData: network, mediumData: null, mediumAtMs: null })).toBeNull();
    expect(rule.plan).toBeNull();
  });

  test("asks once, logged once, until installed and the Agent reports it done (the terminal home); then the next", () => {
    const lines: string[] = [];
    const rule = new BackdoorRule((line) => lines.push(line));
    expect(rule.intent(inputs(medium(53), 0))).toBeNull();
    expect(rule.intent(inputs(medium(58), 1))).toEqual(CSEC);
    // Every update until it's done: the same intent, not logged again.
    expect(rule.intent(inputs(medium(58), 1))).toEqual(CSEC);
    expect(rule.intent(inputs(medium(59), 1.5))).toEqual(CSEC);
    // Installed, but the Agent hasn't said it's done: its next try sends the terminal home.
    expect(rule.intent(inputs(medium(60, { backdoored: ["CSEC"] }), 2))).toEqual(CSEC);
    expect(rule.intent(inputs(medium(60, { backdoored: ["CSEC"] }), 2.5))).toEqual(CSEC);
    expect(rule.intent(inputs(medium(60, { backdoored: ["CSEC"] }), 3, 1, [CSEC.id]))).toBeNull();
    expect(rule.plan?.waitingFor).toBe("hacking 60: avmnite-02h needs 207");
    expect(rule.intent(inputs(medium(207, { backdoored: ["CSEC"] }), 30))).toEqual(backdoorIntent("avmnite-02h"));
    expect(lines).toEqual([
      "backdoor: asking for CSEC (hacking 58, needs 54), for CyberSec's invitation",
      "backdoor: CSEC backdoored, 60 s after it was asked for",
      "backdoor: asking for avmnite-02h (hacking 207, needs 207), for NiteSec's invitation",
    ]);
  });

  test("reported done before a medium snapshot shows it installed: still sent (held done) until one does", () => {
    const rule = new BackdoorRule();
    rule.intent(inputs(medium(58), 0));
    expect(rule.intent(inputs(medium(58), 1, 1, [CSEC.id]))).toEqual(CSEC);
    expect(rule.intent(inputs(medium(58, { backdoored: ["CSEC"] }), 1.2, 1, [CSEC.id]))).toBeNull();
  });

  test("installed, then gone before the Agent said done (an install): dropped, and asked for afresh when due", () => {
    const lines: string[] = [];
    const rule = new BackdoorRule((line) => lines.push(line));
    rule.intent(inputs(medium(58), 0, 1));
    expect(rule.intent(inputs(medium(58, { backdoored: ["CSEC"] }), 1, 1))).toEqual(CSEC);
    expect(rule.intent(inputs(medium(1), 60, 2))).toBeNull();
    expect(rule.intent(inputs(medium(58), 70, 2))).toEqual(CSEC);
    expect(lines.filter((line) => line.startsWith("backdoor: asking for CSEC"))).toHaveLength(2);
    expect(lines.filter((line) => line.includes("REPEATED"))).toEqual([]);
  });

  test("one backdoored before it asked (the owner's, or a brain before this one) is passed over, not logged", () => {
    const lines: string[] = [];
    const rule = new BackdoorRule((line) => lines.push(line));
    expect(rule.intent(inputs(medium(100, { backdoored: ["CSEC"] }), 0))).toBeNull();
    expect(lines).toEqual([]);
  });

  test("REPEATED: asked for again after it was seen backdoored in the same game", () => {
    const lines: string[] = [];
    const rule = new BackdoorRule((line) => lines.push(line));
    rule.intent(inputs(medium(58), 0));
    rule.intent(inputs(medium(58, { backdoored: ["CSEC"] }), 1));
    // A save loaded over the game, say: CSEC not backdoored, the same lastAugReset.
    expect(rule.intent(inputs(medium(58), 5))).toEqual(backdoorIntent("CSEC"));
    expect(lines.slice(2)).toEqual([
      "backdoor: asking for CSEC (hacking 58, needs 54), for CyberSec's invitation",
      "backdoor REPEATED: asking for CSEC again, though the game showed it backdoored at 2026-10-28T00:01:00.000Z, " +
        "since its last reset",
    ]);
  });

  test("REPEATED in the game after an install too: what was seen in the last game is forgotten, this one's kept", () => {
    const lines: string[] = [];
    const rule = new BackdoorRule((line) => lines.push(line));
    rule.intent(inputs(medium(58), 0, 1));
    rule.intent(inputs(medium(58, { backdoored: ["CSEC"] }), 1, 1, [CSEC.id]));
    // The install: gone, asked for and backdoored again in the next game.
    rule.intent(inputs(medium(58), 60, 2));
    rule.intent(inputs(medium(58, { backdoored: ["CSEC"] }), 61, 2, [CSEC.id]));
    expect(lines.filter((line) => line.includes("REPEATED"))).toEqual([]);
    // Gone again in that game.
    rule.intent(inputs(medium(58), 70, 2));
    expect(lines.filter((line) => line.includes("REPEATED"))).toEqual([
      "backdoor REPEATED: asking for CSEC again, though the game showed it backdoored at 2026-10-28T01:01:00.000Z, " +
        "since its last reset",
    ]);
  });

  test("not REPEATED after an install (another lastAugReset), nor before the slow snapshot says which game", () => {
    const lines: string[] = [];
    const rule = new BackdoorRule((line) => lines.push(line));
    rule.intent(inputs(medium(58), 0, 1));
    rule.intent(inputs(medium(58, { backdoored: ["CSEC"] }), 1, 1));
    // After the install, the next Agent's medium snapshot comes before its slow one: no reset known yet.
    rule.intent(inputs(medium(1), 60, null));
    expect(rule.intent(inputs(medium(58), 61, null))).toEqual(backdoorIntent("CSEC"));
    rule.intent(inputs(medium(58, { backdoored: ["CSEC"] }), 62, 2));
    // And once the slow snapshot has said: the backdoor seen in the last game is forgotten.
    const again = new BackdoorRule((line) => lines.push(line));
    again.intent(inputs(medium(58, { backdoored: ["CSEC"] }), 0, 1));
    expect(again.intent(inputs(medium(58), 60, 2))).toEqual(backdoorIntent("CSEC"));
    expect(lines.filter((line) => line.includes("REPEATED"))).toEqual([]);
  });
});
