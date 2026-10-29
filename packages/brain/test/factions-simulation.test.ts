// The brain joins CyberSec and works for it from a fresh start (#203), in the simulator: an 8 GB new game in BN1, the
// brain's rules as on Steam (the hack loop, the programs, home RAM and the faction work, all on). The loop buys
// BruteSSH.exe and roots CSEC, the brain backdoors it at its level (A3, #195), and CyberSec invites the player. The slow
// snapshot's faction state (A4b, #197) shows the invitation; the brain joins (`joinFaction` through the Agent's `sim`
// effector, #147), then chooses CyberSec's hacking work for its nearest augmentation, and the Agent works it (#151). Its
// reputation rises in the slow snapshots. CI runs seed 1; `FACTION_SEEDS` (`1,2,3`, say) runs others.
import {
  type FastSnapshotData,
  factionStateOf,
  type MediumSnapshotData,
  type SlowSnapshotData,
} from "@bitburner-agent/core";
import { expect, test } from "vitest";
import { FACTION_WORK_CHOSEN_EVENT_KIND } from "../src/factions.ts";
import { runReport } from "../src/run-report.ts";
import { EPOCH_MS } from "./helpers/agent-in-simulation.ts";
import { useFreshStarts } from "./helpers/fresh-start.ts";

/** `FACTION_SEEDS`: seeds 1 or more, comma separated; unset, seed 1 alone (CI). Anything else fails loudly. */
function factionSeeds(text: string | undefined): number[] {
  if (text === undefined) return [1];
  const seeds = text.split(",").map((each) => each.trim());
  if (!seeds.every((each) => /^[1-9]\d*$/.test(each))) {
    throw new Error(`FACTION_SEEDS is ${JSON.stringify(text)}: give seeds 1 or more, comma separated`);
  }
  return seeds.map(Number);
}

const freshStartOf = useFreshStarts();
const SEEDS = factionSeeds(process.env.FACTION_SEEDS);
/** Virtual time to CyberSec joined: CSEC's backdoor (about 15 min, #195), then a slow snapshot, then the join. */
const JOINED_WITHIN_MS = 60 * 60_000;
/** Then the work: long enough for several slow snapshots to show the reputation rising. */
const WORKED_MS = 15 * 60_000;

test("FACTION_SEEDS: seeds 1 or more, or unset for seed 1; an empty or odd entry fails loudly", () => {
  expect(factionSeeds(undefined)).toEqual([1]);
  expect(factionSeeds("1, 4")).toEqual([1, 4]);
  for (const odd of ["", "1,", "0", "2.5", "x"]) expect(() => factionSeeds(odd)).toThrow(/FACTION_SEEDS/);
});

test.each(SEEDS)(
  "seed %i: from a fresh start, the brain joins CyberSec once it invites, works hacking for it, and its reputation rises",
  { timeout: 300_000 },
  async (seed) => {
    const fresh = await freshStartOf({ withDesiredState: true, seed });
    const { game, brain } = fresh;
    const joined = () => {
      const factions = (fresh.medium() as MediumSnapshotData | null)?.player.factions;
      return Array.isArray(factions) && factions.includes("CyberSec");
    };
    await game.runUntil(joined, JOINED_WITHIN_MS);
    const joinedAtMs = game.clock.now() - EPOCH_MS;
    await game.run(WORKED_MS);

    // The brain joined once, chose CyberSec's hacking work, and logged both.
    expect(brain.logLines.filter((line) => line.startsWith("factions: joining "))).toEqual([
      "factions: joining CyberSec (its invitation)",
    ]);
    expect(brain.logLines).toContain("factions: CyberSec joined");
    const chosen = brain.logLines.filter((line) => line.startsWith("faction work: "));
    expect(chosen[0]).toMatch(/^faction work: hacking for CyberSec, for Neurotrainer I \(reputation \d of 1,000, /);
    expect(brain.logLines.filter((line) => line.includes("STALLED"))).toEqual([]);

    // The Agent did it: the join done, the work converged, through the simulator's effectors.
    const fast = fresh.latest<FastSnapshotData>("fast");
    expect(fast?.intents.filter((outcome) => outcome.id.startsWith("joinFaction("))).toEqual([]);
    expect(fast?.work).toMatchObject({ converged: true, problem: null, backend: "sim" });
    const view = fresh.controller().workView();
    expect(view.source).toBe("brain");
    expect(view.desired).toEqual({ kind: "faction", faction: "CyberSec", workType: "hacking", focus: true });
    expect(fresh.controller().factionsView()).toMatchObject({ sent: true, choice: { faction: "CyberSec" } });

    // Its reputation rose, slow snapshot after slow snapshot, once the work began.
    const reputations = fresh.data.store
      .snapshots({ environment: "E1" })
      .filter((row) => row.tier === "slow")
      .map((row) => factionStateOf(row.data as SlowSnapshotData)?.joined.find((each) => each.name === "CyberSec"))
      .filter((each) => each !== undefined)
      .map((each) => each.reputation);
    expect(reputations.length).toBeGreaterThanOrEqual(10);
    const rising = reputations.slice(2);
    for (const [index, reputation] of rising.entries()) {
      if (index > 0) expect(reputation).toBeGreaterThan(rising[index - 1] as number);
    }
    // About 0.28 a second at hacking 55, more as the level rises: over 15 minutes, a few hundred.
    expect(reputations.at(-1)).toBeGreaterThan(150);

    // The stored choice, and the run report: the join, the choice and the reputation gained, and PASS.
    const events = fresh.data.store.events({ environment: "E1" });
    expect(events.filter((event) => event.kind === FACTION_WORK_CHOSEN_EVENT_KIND)[0]?.detail).toMatchObject({
      faction: "CyberSec",
      workType: "hacking",
      augmentation: "Neurotrainer I",
      reputationNeeded: 1_000,
    });
    const { text, failures } = runReport(fresh.data.store, {
      environment: "E1",
      sinceMs: EPOCH_MS,
      untilMs: game.clock.now(),
    });
    const lines = text.split("\n");
    expect(lines).toContainEqual(
      expect.stringMatching(/^ {4}joinFaction\(CyberSec\): done after 1 try \(sim\); done by /),
    );
    expect(lines).toContainEqual(expect.stringMatching(/^ {4}joined: CyberSec by \S+$/));
    expect(lines).toContainEqual(
      expect.stringMatching(/^ {6}\S+ {2}hacking for CyberSec, for Neurotrainer I \(reputation \d of 1,000, /),
    );
    expect(lines).toContainEqual(
      expect.stringMatching(/^ {4}reputation gained with the brain's work on it: CyberSec \+\d/),
    );
    expect(failures).toEqual([]);
    console.log(
      `seed ${seed}: CyberSec joined by ${(joinedAtMs / 60_000).toFixed(1)} virtual min; reputation ` +
        `${Math.round(reputations.at(-1) ?? 0)} ${WORKED_MS / 60_000} min on; ${chosen.join(" | ")}`,
    );
  },
);
