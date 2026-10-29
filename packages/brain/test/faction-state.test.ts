// The faction state (#197) in the simulator: each joined faction's reputation and favour, the invitations and the
// queued augmentations, read with each slow snapshot by the backend the Agent picks, and what the brain makes of them:
// the store, the dashboard's panel and alert, and the run report. A bounded run each, in virtual time.
// - `sim`: CyberSec joined, working for it, so its reputation rises; Sector-12's invitation ($20m in Sector-12); three
//   augmentations queued, NeuroFlux Governor twice.
// - `singularity`: the same, in BN1 with SF4.3, through Singularity's worker.
// - `ui` in the simulator, whose page renders no sidebar: every reading says why, an event, the alert, and a FAIL.
//   Never an empty state. E2 reads the real page (packages/e2/test/effectors.e2.test.ts).
import { type DesiredState, type FactionState, factionReadingOf, type SlowSnapshotData } from "@bitburner-agent/core";
import { expect, test } from "vitest";
import { buildDashboardStatus } from "../src/dashboard/status.ts";
import { runReport } from "../src/run-report.ts";
import { EPOCH_MS } from "./helpers/agent-in-simulation.ts";
import { type FreshGame, useFreshStarts, withoutSimEffectors } from "./helpers/fresh-start.ts";

const freshStart = useFreshStarts();
const HACK_LOOP_OFF: DesiredState["hackLoop"] = { enabled: false, target: null, hosts: [] };
/** Four slow snapshots: at the welcome, then each minute. */
const RUN_MS = 3 * 60_000 + 10_000;
const QUEUE = ["Neurotrainer I", "NeuroFlux Governor", "NeuroFlux Governor"];

/**
 * CyberSec joined with 1,000 reputation, $20m in Sector-12 (its invitation), and three augmentations queued; BitWire
 * installed, which isn't queued.
 */
async function factionsToRead({ simulation, game }: FreshGame) {
  await simulation.diagnostics.giveInstalledAugmentation("BitWire");
  await simulation.diagnostics.joinFactionWithReputation("CyberSec", 1_000);
  await simulation.diagnostics.setMoney(20_000_000);
  for (const augmentation of QUEUE) await simulation.diagnostics.queueAugmentation(augmentation);
  // The game checks for invitations every 2 s (`engine.tsx`, `checkFactionInvitations`).
  await game.run(3_000);
}

/** The run: hacking work for CyberSec, focused, so its reputation rises; then `RUN_MS` of virtual time. */
async function run(fresh: Awaited<ReturnType<typeof freshStart>>) {
  fresh.brain.channel.setDesiredState({
    hackLoop: HACK_LOOP_OFF,
    intents: [],
    work: { kind: "faction", faction: "CyberSec", workType: "hacking", focus: true },
  });
  await fresh.game.run(RUN_MS);
  const slows = fresh.data.store
    .snapshots({ environment: "E1" })
    .filter((row) => row.tier === "slow")
    .map((row) => row.data as SlowSnapshotData);
  const report = runReport(fresh.data.store, { environment: "E1", sinceMs: EPOCH_MS, untilMs: fresh.game.clock.now() });
  return { slows, report };
}

/** The dashboard's status over the store now, the controllers' views left empty. */
const dashboard = (fresh: Awaited<ReturnType<typeof freshStart>>) =>
  buildDashboardStatus({
    store: fresh.data.store,
    environment: "E1",
    brainRelease: "test",
    brainStartedAtMs: EPOCH_MS,
    brainStartedEventId: 0,
    supervising: false,
    hackLoop: { enabled: false, waiting: false, target: null, hosts: [], hackThreads: null, preparing: null },
    programs: { enabled: false, waiting: false, owned: [], buying: null, waitingFor: null },
    homeRam: { enabled: false, waiting: false, ram: null, upgradingTo: null, waitingFor: null },
    intents: [],
    work: { desired: null, outcome: null },
    income: null,
    backdoorsDue: [],
    nowMs: fresh.game.clock.now(),
  });

/** Each slow snapshot's state, the reading's backend and problem checked on the way. */
function statesOf(slows: SlowSnapshotData[], backend: string): FactionState[] {
  return slows.map((slow) => {
    const reading = factionReadingOf(slow);
    expect(reading, "a reading in every slow snapshot").toMatchObject({ backend, problem: null });
    return reading?.state as FactionState;
  });
}

/** What every backend reads of the same game, and the reputation rising with the work. */
function expectRead(states: FactionState[]) {
  expect(states.length).toBeGreaterThanOrEqual(4);
  for (const state of states) {
    expect(state.joined.map(({ name, favor }) => [name, favor])).toEqual([["CyberSec", 0]]);
    expect(state.invitations).toEqual(["Sector-12"]);
    expect(state.queuedAugmentations).toEqual(QUEUE);
  }
  const reputations = states.map((state) => state.joined[0]?.reputation as number);
  expect(reputations[0]).toBeGreaterThanOrEqual(1_000);
  for (let index = 1; index < reputations.length; index += 1) {
    expect(reputations[index], "rising with the work").toBeGreaterThan(reputations[index - 1] as number);
  }
}

test("sim backend: each slow snapshot has CyberSec's rising reputation, Sector-12's invitation and the queue; the dashboard and the report show them", async () => {
  const fresh = await freshStart({ withDesiredState: false, beforeAgent: factionsToRead });
  const { slows, report } = await run(fresh);
  const states = statesOf(slows, "sim");
  expectRead(states);

  const status = dashboard(fresh);
  expect(status.factions).toMatchObject({ backend: "sim", problem: null, state: states.at(-1) });
  expect(status.alerts.map((alert) => alert.name)).not.toContain("factionStateUnread");

  const lines = report.text.split("\n");
  const first = Math.round(states[0]?.joined[0]?.reputation as number).toLocaleString("en-US");
  const last = Math.round(states.at(-1)?.joined[0]?.reputation as number).toLocaleString("en-US");
  expect(lines).toContain(`    CyberSec: reputation ${first} → ${last}, favour 0 (unchanged)`);
  expect(lines.find((line) => line.startsWith("    Sector-12, "))).toBeDefined();
  expect(lines).toContain("  augmentations queued: Neurotrainer I, NeuroFlux Governor ×2 (unchanged)");
  expect(report.text).toContain(
    "  faction state unread (slow snapshots whose faction state couldn't be read, #197):\n    none",
  );
  expect(report.failures).toEqual([]);
  expect(fresh.data.store.events({ environment: "E1" }).map((event) => event.kind)).not.toContain("factionStateUnread");
});

test("singularity backend: in BN1 with SF4.3, the simulator's effectors taken away, the same state through Singularity's worker", async () => {
  // SF1.1 starts home at 32 GB: room for the 12.1 GB worker beside the Agent.
  const fresh = await freshStart({
    withDesiredState: false,
    fixture: { kind: "bitnode", n: 1, sourceFiles: { 1: 1, 4: 3 } },
    beforeAgent: async (game) => {
      await factionsToRead(game);
      await withoutSimEffectors(game);
    },
  });
  const { slows, report } = await run(fresh);
  // The first too: the Agent keeps the slow worker's data, which says SF4, before it reads.
  expectRead(statesOf(slows, "singularity"));
  expect(report.failures).toEqual([]);
});

test("ui backend on the simulator's page, which renders no sidebar: every slow snapshot says why, never an empty state; the event, the alert and a FAIL", async () => {
  const fresh = await freshStart({
    withDesiredState: false,
    beforeAgent: async (game) => {
      await factionsToRead(game);
      await withoutSimEffectors(game);
    },
  });
  const { slows, report } = await run(fresh);
  const problem = '"Factions" in the sidebar (is its section collapsed?)';
  expect(slows.length).toBeGreaterThanOrEqual(4);
  for (const slow of slows) expect(slow.factions).toEqual({ backend: "ui", state: null, problem });
  // One event for the stretch, as the problem didn't change.
  const unread = fresh.data.store.events({ environment: "E1" }).filter((event) => event.kind === "factionStateUnread");
  expect(unread.map((event) => event.detail)).toEqual([{ backend: "ui", problem }]);
  expect(dashboard(fresh).alerts).toContainEqual(
    expect.objectContaining({
      name: "factionStateUnread",
      detail: `the faction state couldn't be read (ui): ${problem}`,
    }),
  );
  const slowTimes = fresh.data.store
    .snapshots({ environment: "E1" })
    .filter((row) => row.tier === "slow")
    .map((row) => new Date(row.receivedAtMs).toISOString());
  const [unreadFrom, unreadTo] = [slowTimes[0], slowTimes.at(-1)];
  expect(report.failures).toEqual([
    `faction state unread from ${unreadFrom} to ${unreadTo} (${slows.length} slow snapshots, ui): ${problem}`,
  ]);
  expect(report.text).toContain("  faction reputation and favour, first reading → last:\n    never read");
});
