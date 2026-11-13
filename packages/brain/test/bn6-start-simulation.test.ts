// Bladeburner B1 (#367): the brain from a BN6.1 start with the campaign's Source-Files (SF1.3, SF2.3, SF4.3 and SF5.1:
// BN1.1, BN4 ×3, BN1.2-1.3, BN5.1, BN2 ×3, docs/synthesis.md §3), its rules as on Steam (all on), the simulator's own
// effectors taken away so the Agent uses its workers as in a browser. One seed: a thin slice, no sweep. Bounded by
// virtual time, under a minute of CI. The training is the game's own, from 1: SF1.3 multiplies each combat stat's
// level and experience by 1.28 (`SourceFile/applySourceFile.ts:14-48`: 16 + 8 + 4%), so 100 takes 5,417 experience,
// not 11,255, at 12.8 a second at Powerhouse Gym: about 28 minutes for all four, not #359's 75 at ×1. Harness edits
// stand in for the hours the gym doesn't take:
// - $50m, the hours of BN6's hacking that pay the gym ($2,400 a second) and home's RAM;
// - the rank set to 25 once the reading shows the division, as no B1 run earns any (Bladeburner's actions are B2's).
// Then: the training at the gym through Singularity, within its estimate; the division joined through the gate and its
// worker; the reading once home's RAM beyond what it keeps holds it; the faction at 25; section 8 passing; and the
// campaign still skipping BN6 and BN7 (no win route until B6).
import {
  BITNODE_BLACK_OPS_HOPELESS_REASON,
  BITNODE_NO_WIN_ROUTE_REASON,
  type FastSnapshotData,
  type MediumSnapshotData,
  nextBitNodeOf,
  skillExpFor,
} from "@bitburner-agent/core";
import { expect, test } from "vitest";
import { runReport } from "../src/run-report.ts";
import { EPOCH_MS } from "./helpers/agent-in-simulation.ts";
import { useFreshStarts, withoutSimEffectors } from "./helpers/fresh-start.ts";

const freshStartOf = useFreshStarts();
const SOURCE_FILES = { 1: 3, 2: 3, 4: 3, 5: 1 };
const MINUTE = 60_000;

test("BN6.1 with the campaign's Source-Files: trained at the gym, joined through the gate, read, the faction at 25; the report passes", async () => {
  const fresh = await freshStartOf({
    withDesiredState: true,
    fixture: { kind: "bitnode", n: 6, sourceFiles: SOURCE_FILES },
    beforeAgent: async (game) => {
      await game.simulation.diagnostics.setMoney(5e7);
      await withoutSimEffectors(game);
    },
  });
  const startedAtMs = fresh.game.clock.now();
  const medium = () => fresh.medium() as MediumSnapshotData | null;
  // The training: the brain's work, a class at Powerhouse Gym, through Singularity (SF4.3), A5's work waiting.
  await fresh.game.runUntil(() => fresh.controller().bladeburnerView().training?.work != null, 2 * MINUTE);
  const training = fresh.controller().bladeburnerView().training;
  console.log(fresh.controller().bladeburnerView().line);
  expect(training).toMatchObject({ stat: "strength", gym: "Powerhouse Gym" });
  const estimateMs = (training?.etaSeconds ?? 0) * 1000;
  // Core's estimate on the player's multipliers as read: 4 × 5,417 / 12.8 s at SF1.3's 1.28, about 28 minutes.
  const mults = (medium()?.player as { mults?: Record<string, number> } | undefined)?.mults ?? {};
  expect(mults.strength).toBeCloseTo(1.28, 6);
  expect(mults.agility_exp).toBeCloseTo(1.28, 6);
  expect(estimateMs / 1000).toBeCloseTo((4 * skillExpFor(100, 1.28)) / (10 * 1.28), 0);
  expect(estimateMs / MINUTE).toBeCloseTo(28.2, 0);
  expect(fresh.controller().workView()).toMatchObject({
    source: "brain",
    desired: { kind: "class", location: "Powerhouse Gym", classType: "str", focus: false },
  });
  await fresh.game.runUntil(() => fresh.controller().workView().outcome?.converged === true, MINUTE);
  expect(fresh.controller().workView().outcome?.backend).toBe("singularity");
  // Trained and joined: within twice the estimate (the run report's bound, less its slack).
  const trainingFromMs = fresh.game.clock.now();
  await fresh.game.runUntil(() => medium()?.inBladeburner === true, 2 * estimateMs + 5 * MINUTE);
  expect(fresh.game.clock.now() - trainingFromMs).toBeLessThan(1.25 * estimateMs);
  const joinedAtMs = fresh.game.clock.now();
  console.log(`joined ${((joinedAtMs - trainingFromMs) / MINUTE).toFixed(1)} min after the class converged`);
  expect(medium()?.inBladeburner).toBe(true);
  const join = (fresh.latest<FastSnapshotData>("fast")?.intents ?? []).find(
    (each) => each.id === "joinBladeburnerDivision()",
  );
  expect(join === undefined || join.done).toBe(true);
  // The reading, once home's RAM beyond what it keeps (65.9 GB at SF4.3) holds its 9.6 GB: home RAM bought to 128 GB.
  await fresh.game.runUntil(() => typeof medium()?.bladeburner?.rank === "number", 15 * MINUTE);
  const home = medium()?.servers.find((server) => server.hostname === "home");
  console.log(
    `read at home ${home?.maxRam} GB, ${((fresh.game.clock.now() - joinedAtMs) / MINUTE).toFixed(1)} min after the join`,
  );
  expect(home?.maxRam).toBeGreaterThanOrEqual(128);
  expect(medium()?.bladeburner).toMatchObject({ rank: 0, problems: [] });
  // Rank 25 by a harness edit: the faction joined through the worker.
  await fresh.simulation.diagnostics.setBladeburnerRank(25);
  await fresh.game.runUntil(() => {
    const factions = (medium()?.player as { factions?: string[] } | undefined)?.factions ?? [];
    return factions.includes("Bladeburners");
  }, 2 * MINUTE);
  await fresh.game.run(MINUTE);
  // Joined, and (B2, #375) the actions under way, the rank rising from 25 with them.
  expect(fresh.controller().bladeburnerView().line).toMatch(
    /^Bladeburner: in the division, rank 2\d\.\d; Bladeburners joined; /,
  );
  // Never Bladeburners' faction work (it offers none); A5's held for the actions (#375).
  const work = fresh.controller().workView().desired;
  expect(work?.kind === "faction" ? work.faction : null).not.toBe("Bladeburners");

  const window = { environment: "E1", sinceMs: EPOCH_MS, untilMs: fresh.game.clock.now() } as const;
  const { text, failures } = runReport(fresh.data.store, window, { verbose: true });
  const section = text.slice(text.indexOf("8. Bladeburner"), text.indexOf("Verdict"));
  console.log(section);
  console.log(`virtual: ${((fresh.game.clock.now() - startedAtMs) / MINUTE).toFixed(1)} min`);
  expect(text).toMatch(/\n {4}joinBladeburnerDivision\(\): done after 1 try \(ui\); /);
  expect(section).toMatch(
    /\n {4}from [^:]+:\d\d:\d\d\.\d{3}Z \(strength 1, defense 1, dexterity 1, agility 1\): estimated 28 min /,
  );
  const ratio = Number(/ \((\d\.\d\d) of the estimate from when it was made\)\n/.exec(section)?.[1]);
  expect(ratio).toBeGreaterThan(0.8);
  expect(ratio).toBeLessThan(1.5);
  expect(section).toMatch(/\n {2}the division: joined, first seen /);
  expect(section).toMatch(/\n {2}rank: 0\.0 → 2\d\.\d, read from /);
  // Joined, by the worker's asking or A5's accepting its invitation: either path (#373's review).
  expect(section).toMatch(/\n {2}Bladeburners: joined, first seen /);
  // Its bound: twice Iron Gym's estimate at SF1.3's ×1.28 (4 × 5,417 / 1.28 s) and 10 min.
  expect(section).toContain("; overdue past 9 h 34 min; ");
  expect(section).toContain("  problems the Bladeburner worker reported, as first seen:\n    none\n");
  for (const check of [
    "the training past twice the slowest gym's estimate and 10 min from its first sighting, still short of 100, at " +
      "any reading:\n    none",
    "all four at 100 with the division not joined for 5 min or more:\n    none",
    "the division unread with home's RAM there for its worker for 5 min or more:\n    none",
    "the rank at 25 or more with Bladeburners not joined for 1 min or more:\n    none",
  ]) {
    expect(section).toContain(check);
  }
  // Nothing taken as BN1's in BN6: core has its prices and hacking multipliers now (#367).
  expect(text).not.toContain("taken as BN1's");
  expect(failures).toEqual([]);
  // The campaign still skips BN6 and BN7 (#367): no win route until B6. BN6.1's destroy, were there one, would enter
  // BN5 (the order's row 8), BN6, BN7 and BN3 skipped.
  expect(nextBitNodeOf({ currentNode: 6, ownedSF: SOURCE_FILES })).toEqual({
    bitNode: 5,
    replay: null,
    skipped: [
      { bitNode: 6, reason: BITNODE_BLACK_OPS_HOPELESS_REASON },
      { bitNode: 7, reason: BITNODE_NO_WIN_ROUTE_REASON },
      { bitNode: 3, reason: "no hacking multipliers or prices yet" },
    ],
  });
}, 180_000);
