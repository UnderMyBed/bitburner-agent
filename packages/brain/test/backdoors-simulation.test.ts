// The brain backdoors CSEC from a fresh start (#195), in the simulator: an 8 GB new game in BN1, the brain's rules as on
// Steam (the hack loop, the programs and home RAM, all on). The loop buys BruteSSH.exe and roots CSEC (1 port); once the
// hacking level reaches CSEC's (51 to 60, rolled per game), the brain asks for its backdoor, and the Agent's `sim`
// effector types it into the terminal (#162). The game then invites the player to CyberSec. The simulator has no page,
// so no invitation dialog: its save shows the invitation. CI runs seed 1; `BACKDOOR_SEEDS` (`1,2,3`, say) runs others.
import { gunzipSync } from "node:zlib";
import type { FastSnapshotData, StaticSnapshotData } from "@bitburner-agent/core";
import { expect, test } from "vitest";
import { runReport } from "../src/run-report.ts";
import { EPOCH_MS } from "./helpers/agent-in-simulation.ts";
import { useFreshStarts } from "./helpers/fresh-start.ts";

/** `BACKDOOR_SEEDS`: seeds 1 or more, comma separated; unset, seed 1 alone (CI). Anything else fails loudly. */
function backdoorSeeds(text: string | undefined): number[] {
  if (text === undefined) return [1];
  const seeds = text.split(",").map((each) => each.trim());
  if (!seeds.every((each) => /^[1-9]\d*$/.test(each))) {
    throw new Error(`BACKDOOR_SEEDS is ${JSON.stringify(text)}: give seeds 1 or more, comma separated`);
  }
  return seeds.map(Number);
}

const freshStartOf = useFreshStarts();
const SEEDS = backdoorSeeds(process.env.BACKDOOR_SEEDS);
/** Virtual time for the backdoor: BruteSSH.exe, then hacking 51 to 60, from a fresh start. */
const BACKDOORED_WITHIN_MS = 60 * 60_000;
/** After it: long enough for the brain to see it installed and stop asking, and to show it never asks again. */
const AFTER_MS = 5 * 60_000;

test("BACKDOOR_SEEDS: seeds 1 or more, or unset for seed 1; an empty or odd entry fails loudly", () => {
  expect(backdoorSeeds(undefined)).toEqual([1]);
  expect(backdoorSeeds("1, 4")).toEqual([1, 4]);
  for (const odd of ["", "1,", "0", "2.5", "x"]) expect(() => backdoorSeeds(odd)).toThrow(/BACKDOOR_SEEDS/);
});

test.each(SEEDS)(
  "seed %i: from a fresh start, the brain backdoors CSEC once its level allows, and CyberSec invites the player",
  { timeout: 300_000 },
  async (seed) => {
    const fresh = await freshStartOf({ withDesiredState: true, seed });
    const { game, brain } = fresh;
    const csec = () => fresh.medium()?.servers.find((server) => server.hostname === "CSEC");
    await game.runUntil(() => csec()?.backdoorInstalled === true, BACKDOORED_WITHIN_MS);
    const backdooredAtMs = game.clock.now() - EPOCH_MS;
    await game.run(AFTER_MS);

    // The brain asked once, at CSEC's level, and saw it installed.
    const required = fresh
      .latest<StaticSnapshotData>("static")
      ?.servers.find((server) => server.hostname === "CSEC")?.requiredHackingSkill;
    const asked = brain.logLines.filter((line) => line.startsWith("backdoor: asking for "));
    expect(asked).toEqual([
      expect.stringMatching(
        new RegExp(`^backdoor: asking for CSEC \\(hacking \\d+, needs ${required}\\), for CyberSec's invitation$`),
      ),
    ]);
    expect(Number(/hacking (\d+)/.exec(asked[0] ?? "")?.[1])).toBeGreaterThanOrEqual(required ?? Number.NaN);
    expect(brain.logLines).toContainEqual(
      expect.stringMatching(/^backdoor: CSEC backdoored, \d+ s after it was asked for$/),
    );
    expect(brain.logLines.filter((line) => line.includes("REPEATED"))).toEqual([]);
    // No longer asked for, and nothing else is due yet (avmnite-02h needs 2 ports and hacking 202 or more).
    const intents = fresh.latest<FastSnapshotData>("fast")?.intents ?? [];
    expect(intents.filter((outcome) => outcome.id.startsWith("backdoor("))).toEqual([]);
    // Nothing due, so no backdoorOverdue alert.
    expect(fresh.controller().backdoorsDue()).toEqual([]);

    // The game: CyberSec's invitation, and the terminal back home.
    const saveObject = JSON.parse(gunzipSync(await fresh.simulation.save()).toString("utf8"));
    const player = JSON.parse(saveObject.data.PlayerSave).data as {
      factionInvitations: string[];
      currentServer: string;
    };
    expect(player.factionInvitations).toContain("CyberSec");
    expect(player.currentServer).toBe("home");

    // The run report: the backdoor, done through the simulator's effector, and PASS.
    const { text, failures } = runReport(fresh.data.store, {
      environment: "E1",
      sinceMs: EPOCH_MS,
      untilMs: game.clock.now(),
    });
    const lines = text.split("\n");
    expect(lines).toContainEqual(
      expect.stringMatching(/^ {4}backdoor\(CSEC\): done after [12] tr(y|ies) \(sim\); done by /),
    );
    expect(lines).toContainEqual(
      expect.stringMatching(
        /^ {4}CSEC: not backdoored at the window's start; backdoored by \S+; no invitation from CyberSec seen$/,
      ),
    );
    expect(failures).toEqual([]);
    console.log(
      `seed ${seed}: CSEC (needs ${required}) backdoored by ${(backdooredAtMs / 60_000).toFixed(1)} virtual min; ` +
        `${asked[0]}`,
    );
  },
);
