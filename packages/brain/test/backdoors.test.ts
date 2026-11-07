// The brain's backdoors for the hacker factions (#195): which server is due, why none is, and the rule's log.
import { readFileSync } from "node:fs";
import {
  HACKER_FACTION_SERVERS,
  hackTimeSeconds,
  type MediumSnapshotData,
  SNAPSHOT_TIER_PERIOD_MS,
  type StaticSnapshotData,
} from "@bitburner-agent/core";
import {
  backdoorMs,
  GATE_MEDIUM_SNAPSHOTS,
  HACKER_FACTION_JOINS,
  INVITATION_CHECK_MS,
  JoinPipeline,
  ROUNDS_BETWEEN_TRIES,
} from "@bitburner-agent/model";
import { describe, expect, test } from "vitest";
import { BackdoorRule, backdoorIntent, chooseBackdoor } from "../src/backdoors.ts";
import { chooseJoin } from "../src/factions.ts";
import { GUARD_SNAPSHOTS } from "../src/irreversible-gate.ts";
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

  test("REPEATED for one backdoored before the brain started, first seen before the slow snapshot said the game", () => {
    const lines: string[] = [];
    const rule = new BackdoorRule((line) => lines.push(line));
    // The brain's first medium snapshot comes before its first slow one: seen with no reset, then given it.
    rule.intent(inputs(medium(58, { backdoored: ["CSEC"] }), 0, null));
    rule.intent(inputs(medium(58, { backdoored: ["CSEC"] }), 0.5, 1));
    expect(rule.intent(inputs(medium(58), 5, 1))).toEqual(CSEC);
    expect(lines).toEqual([
      "backdoor: asking for CSEC (hacking 58, needs 54), for CyberSec's invitation",
      "backdoor REPEATED: asking for CSEC again, though the game showed it backdoored at 2026-10-28T00:00:00.000Z, " +
        "since its last reset",
    ]);
  });

  test("not REPEATED when neither the sighting nor now has a reset: no telling which game", () => {
    const lines: string[] = [];
    const rule = new BackdoorRule((line) => lines.push(line));
    rule.intent(inputs(medium(58, { backdoored: ["CSEC"] }), 0, null));
    expect(rule.intent(inputs(medium(58), 60, null))).toEqual(CSEC);
    expect(lines.filter((line) => line.includes("REPEATED"))).toEqual([]);
  });

  test("another lastAugReset forgets what was asked for: refused at the BitVerse, then the destroy", () => {
    const lines: string[] = [];
    const rule = new BackdoorRule((line) => lines.push(line));
    rule.intent(inputs(medium(58), 0, 1));
    // The next BitNode: CSEC due again, asked for afresh (and logged), never seen installed.
    expect(rule.intent(inputs(medium(58), 60, 2))).toEqual(CSEC);
    expect(lines.filter((line) => line.startsWith("backdoor: asking for CSEC"))).toHaveLength(2);
  });

  test("a snapshot that doesn't show the server isn't a reset: still asked for until the Agent says done", () => {
    const rule = new BackdoorRule();
    rule.intent(inputs(medium(58), 0));
    rule.intent(inputs(medium(58, { backdoored: ["CSEC"] }), 1));
    const withoutCsec = medium(58, { backdoored: ["CSEC"] });
    withoutCsec.servers = withoutCsec.servers.filter((server) => server.hostname !== "CSEC");
    expect(rule.intent(inputs(withoutCsec, 1.5))).toEqual(CSEC);
    expect(rule.intent(inputs(medium(58, { backdoored: ["CSEC"] }), 2, 1, [CSEC.id]))).toBeNull();
  });

  test("due(): each server due since its first medium snapshot in a row; none without the Agent's snapshots", () => {
    const rule = new BackdoorRule();
    rule.intent(inputs(medium(53), 0));
    expect(rule.due()).toEqual([]);
    rule.intent(inputs(medium(54), 1));
    rule.intent(inputs(medium(60), 2));
    expect(rule.due()).toEqual([{ hostname: "CSEC", sinceMs: at(1) }]);
    // At 207 avmnite-02h is due too, from then.
    rule.intent(inputs(medium(207), 3));
    expect(rule.due()).toEqual([
      { hostname: "CSEC", sinceMs: at(1) },
      { hostname: "avmnite-02h", sinceMs: at(3) },
    ]);
    rule.intent(inputs(medium(207, { backdoored: ["CSEC"] }), 4));
    expect(rule.due()).toEqual([{ hostname: "avmnite-02h", sinceMs: at(3) }]);
    rule.intent({ ...inputs(medium(207), 5), mediumData: null, mediumAtMs: null });
    expect(rule.due()).toEqual([]);
  });
});

describe("brain against the fast model (#294): a hacker faction's join, the brain's own rules on the game's clocks", () => {
  // The network's four servers at 54, 207, 350 and 530; the level reaching 600 at `termsAt`, the hacking speed 1.8.
  const HACKING = 600;
  const SPEED = 1.8;
  const { fast: ROUND_MS, medium: MEDIUM_MS, slow: SLOW_MS } = SNAPSHOT_TIER_PERIOD_MS;
  const REQUIRED: Record<string, number> = { CSEC: 54, "avmnite-02h": 207, "I.I.I.I": 350, run4theh111z: 530 };
  const FACTION_OF = Object.fromEntries(HACKER_FACTION_SERVERS.map(({ hostname, faction }) => [hostname, faction]));

  /**
   * The ms from `termsAt` to each faction's join in the slow snapshot that shows it. The Agent's rounds every 2 s
   * from 0 carry the medium snapshot every 5th and the slow one every 30th
   * (packages/ingame/src/agent/snapshotter.ts:4-5); the game's invitation check every 2 s from `checkAt`
   * (`engine.tsx:177-182`). The brain's own `BackdoorRule` asks on each medium snapshot, serially; the Agent tries an
   * intent the round after the brain sends it and every 15 rounds after (`ROUNDS_BETWEEN_TRIES`), the first try
   * starting the backdoor, a try after its end reporting it done in the next round's fast snapshot; the game invites at
   * its next check; the brain's `chooseJoin` picks the join at a slow snapshot from the invitations shown, in the order
   * invited; the Agent joins in the next round, and the next slow snapshot shows it.
   */
  function joinsAfter(
    termsAt: number,
    checkAt: number,
    backdoored: string[],
    hacking = HACKING,
    speed = SPEED,
  ): Record<string, number> {
    const rule = new BackdoorRule();
    const completesAt = new Map<string, number>();
    const doneAtRound = new Map<string, number>();
    const invitedAt = new Map<string, number>();
    const shownAt: Record<string, number> = {};
    let held: { hostname: string; nextTryRound: number } | null = null;
    let joining: { faction: string; round: number } | null = null;
    const joined: string[] = [];
    const due = FOUR.filter((host) => !backdoored.includes(host));
    for (let round = 0; Object.keys(shownAt).length < due.length; round++) {
      const at = round * ROUND_MS;
      if (round > 10_000) throw new Error("the joins never came");
      // The Agent's try of the held intent, sent in an earlier round.
      // Once done, never run again while it's sent (intent-runner.ts).
      if (held !== null && !doneAtRound.has(held.hostname) && round >= held.nextTryRound) {
        const ends = completesAt.get(held.hostname);
        if (ends === undefined) {
          completesAt.set(held.hostname, at + backdoorMs(REQUIRED[held.hostname] as number, hacking, speed));
        }
        if (ends !== undefined && ends <= at) doneAtRound.set(held.hostname, round);
        else held.nextTryRound = round + ROUNDS_BETWEEN_TRIES;
      }
      for (const [hostname, ends] of completesAt) {
        if (ends <= at && !invitedAt.has(hostname)) {
          invitedAt.set(hostname, checkAt + INVITATION_CHECK_MS * Math.ceil((ends - checkAt) / INVITATION_CHECK_MS));
        }
      }
      if (round % (MEDIUM_MS / ROUND_MS) === 0) {
        const installed = [...backdoored, ...[...completesAt].filter(([, ends]) => ends <= at).map(([host]) => host)];
        const doneIds = new Set(
          [...doneAtRound].filter(([, doneRound]) => doneRound < round).map(([host]) => backdoorIntent(host).id),
        );
        const intent = rule.intent({
          staticData: network,
          mediumData: medium(at >= termsAt ? hacking : 53, { backdoored: installed }),
          mediumAtMs: at,
          resetAt: 1,
          doneIds,
        });
        const hostname = FOUR.find((host) => backdoorIntent(host).id === intent?.id);
        const heldNow = held as { hostname: string } | null;
        if (hostname !== undefined && heldNow?.hostname !== hostname) held = { hostname, nextTryRound: round + 1 };
      }
      if (round % (SLOW_MS / ROUND_MS) === 0) {
        if (joining !== null && round > joining.round) {
          joined.push(joining.faction);
          shownAt[joining.faction] = at - termsAt;
          joining = null;
        }
        const invitations = [...invitedAt]
          .filter(([, invited]) => invited < at)
          .sort((a, b) => a[1] - b[1])
          .map(([host]) => FACTION_OF[host] as string);
        const next: string | null = joining === null ? chooseJoin(invitations, joined).next : null;
        if (next !== null) joining = { faction: next, round: round + 1 };
      }
    }
    return shownAt;
  }

  /** The mean of `joinsAfter` over the terms' place in a slow snapshot's minute and the check's phase (midpoints). */
  function meanJoins(backdoored: string[], hacking = HACKING, speed = SPEED): Record<string, number> {
    const sums: Record<string, number> = {};
    let runs = 0;
    for (let terms = 0; terms < 240; terms++) {
      for (let check = 0; check < 8; check++) {
        const shown = joinsAfter(SLOW_MS + (terms + 0.5) * 250, (check + 0.5) * 250, backdoored, hacking, speed);
        for (const [faction, ms] of Object.entries(shown)) sums[faction] = (sums[faction] ?? 0) + ms;
        runs += 1;
      }
    }
    return Object.fromEntries(Object.entries(sums).map(([faction, sum]) => [faction, sum / runs]));
  }

  test("the backdoor's time is the game's, a quarter of the hack time at security 1 (core's `hackTimeSeconds`)", () => {
    const player = { skills: { hacking: HACKING, intelligence: 0 }, mults: { hacking_speed: SPEED } } as never;
    const hackSeconds = hackTimeSeconds({ hackDifficulty: 1, requiredHackingSkill: 530 }, player);
    expect(backdoorMs(530, HACKING, SPEED)).toBeCloseTo((hackSeconds / 4) * 1000, 6);
    // The model's terms are the brain's servers and factions, in its order (core's `HACKER_FACTION_SERVERS`).
    expect(HACKER_FACTION_JOINS.map((each) => each.faction)).toEqual(
      HACKER_FACTION_SERVERS.map((each) => each.faction),
    );
  });

  test("BitRunners alone due: the mean from its terms to its join in a slow snapshot is the model's [0.3 s]", () => {
    const simulated = meanJoins(["CSEC", "avmnite-02h", "I.I.I.I"]).BitRunners as number;
    const modelled = new JoinPipeline().hackerFaction(0, 530, HACKING, SPEED);
    expect(Math.abs(simulated - modelled)).toBeLessThan(300);
    // The medium snapshot after, then the slow snapshot after the invitation, then the next: 100 s.
    expect(modelled).toBe(100_000);
  });

  test("a slow backdoor (CyberSec at hacking 54, speed 0.8: 9.5 s) puts the invitation past the next medium snapshot [0.3 s]", () => {
    const simulated = meanJoins(["avmnite-02h", "I.I.I.I", "run4theh111z"], 54, 0.8).CyberSec as number;
    const modelled = new JoinPipeline().hackerFaction(0, 54, 54, 0.8);
    expect(Math.abs(simulated - modelled)).toBeLessThan(300);
    expect(modelled).toBe(110_000);
  });

  test("all four due at once: the backdoors one at a time in `chooseBackdoor`'s order, one join a slow snapshot [0.3 s]", () => {
    const simulated = meanJoins([]);
    const pipeline = new JoinPipeline();
    for (const [hostname, required] of Object.entries(REQUIRED)) {
      const faction = FACTION_OF[hostname] as string;
      const modelled = pipeline.hackerFaction(0, required, HACKING, SPEED);
      expect(Math.abs((simulated[faction] as number) - modelled), faction).toBeLessThan(300);
    }
    // BitRunners last: three minutes after CyberSec, a slow snapshot a join.
    expect((simulated.BitRunners as number) - (simulated.CyberSec as number)).toBeCloseTo(3 * SLOW_MS, -2);
  });

  test("the model's copies of the Agent's, the game's and the gate's constants are theirs", () => {
    const runner = readFileSync(new URL("../../ingame/src/agent/intent-runner.ts", import.meta.url), "utf8");
    expect(runner).toContain(`const ROUNDS_BETWEEN_TRIES = ${ROUNDS_BETWEEN_TRIES};`);
    const engine = readFileSync(new URL("../../../vendor/bitburner-src/src/engine.tsx", import.meta.url), "utf8");
    expect(engine).toContain(`Engine.Counters.checkFactionInvitations = ${INVITATION_CHECK_MS / 200};`);
    expect(GATE_MEDIUM_SNAPSHOTS).toBe(GUARD_SNAPSHOTS);
  });
});
