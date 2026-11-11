// Levelling (#336), in the simulator: The Red Pill installed and the hacking level short of w0r1d_d43m0n's 3,000, the
// brain's rules as on Steam. Harness edits stand in for the run so far, through the harness's own hooks: home of
// 4 TB, augmentations given installed that raise the level's multiplier to about 4 (at ×1, 2,000's experience is 8e29,
// past a double's precision for a weaken's thousands a second), and The Red Pill queued, before the Agent (A6 installs
// it at once, through the gate and a backup, and the reset applies them all and links w0r1d_d43m0n); then the level
// at 2,000 and $1t for the port openers. Cloud servers and home RAM are switched
// off, so the RAM the prediction is for doesn't move under the measurement.
// - Levelling mode, A6 switched off (no NeuroFlux Governor on offer): the brain buys the openers, the hack loop roots
//   w0r1d_d43m0n, the planner measures batching's rate and chooses levelling mode, and the level loop runs on the
//   hosts and on home beyond what home keeps; its measured rate, fitted, is near the formula's.
// - The install, A6 switched on: A5 has joined CyberSec meanwhile (hacking 2,000), whose reputation buys NeuroFlux
//   Governor's levels with the money; the install is now the shortest, A6 buys the levels and installs ("the hacking
//   level"), and after the reset the planner is back on batching for money (w0r1d_d43m0n to root again).
// CI runs seed 1; `LEVELLING_SEEDS` (`1,2,3`, say) runs others.
import {
  AUGMENTATIONS,
  deployedFilePath,
  hackingExpOfLevel,
  LEVEL_LOOP_SCRIPT_NAME,
  type MediumSnapshotData,
  NEUROFLUX_GOVERNOR,
  type SlowSnapshotData,
} from "@bitburner-agent/core";
import { expect, test } from "vitest";
import { AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND, writeAugmentationsEnabled } from "../src/augmentations.ts";
import { CLOUD_SERVERS_ENABLED_SETTING } from "../src/cloud-servers.ts";
import { HOME_RAM_ENABLED_SETTING } from "../src/home-ram.ts";
import { LEVELLING_CHOSEN_EVENT_KIND } from "../src/levelling.ts";
import { SHARE_HOME_KEPT_GB } from "../src/share.ts";
import { writeSwitch } from "../src/switches.ts";
import { EPOCH_MS } from "./helpers/agent-in-simulation.ts";
import { useFreshStarts } from "./helpers/fresh-start.ts";

/** `LEVELLING_SEEDS`: seeds 1 or more, comma separated; unset, seed 1 alone (CI). Anything else fails loudly. */
function levellingSeeds(text: string | undefined): number[] {
  if (text === undefined) return [1];
  const seeds = text.split(",").map((each) => each.trim());
  if (!seeds.every((each) => /^[1-9]\d*$/.test(each))) {
    throw new Error(`LEVELLING_SEEDS is ${JSON.stringify(text)}: give seeds 1 or more, comma separated`);
  }
  return seeds.map(Number);
}

const freshStartOf = useFreshStarts();
const SEEDS = levellingSeeds(process.env.LEVELLING_SEEDS);
const MINUTE = 60_000;
/** Each stage's bound: an install through the gate, the port openers and a root, a choice, a fit. */
const STAGE_MS = 10 * MINUTE;
const HOME_GB = 4096;
/** Augmentations sold by a faction with a hacking multiplier, by name, until their product is 4 or more; and it. */
const { names: HACKING_AUGMENTATIONS, mult: HACKING_MULT } = (() => {
  const names: string[] = [];
  let mult = 1;
  for (const [name, data] of Object.entries(AUGMENTATIONS).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const hacking = data.multipliers.hacking;
    if (mult >= 4 || hacking === undefined || hacking <= 1 || name === NEUROFLUX_GOVERNOR) continue;
    if (data.factions.length === 0 || !Number.isFinite(data.baseMoneyCost)) continue;
    names.push(name);
    mult *= hacking;
  }
  return { names, mult };
})();

test("LEVELLING_SEEDS: seeds 1 or more, or unset for seed 1; an empty or odd entry fails loudly", () => {
  expect(levellingSeeds(undefined)).toEqual([1]);
  expect(levellingSeeds("1, 4")).toEqual([1, 4]);
  for (const odd of ["", "1,", "0", "2.5", "x"]) expect(() => levellingSeeds(odd)).toThrow(/LEVELLING_SEEDS/);
});

test.each(SEEDS)(
  "seed %i: The Red Pill installed, the level short: levelling mode on joesguns and home at near the formula's rate; then the install for the level",
  { timeout: 300_000 },
  async (seed) => {
    const fresh = await freshStartOf({
      withDesiredState: true,
      seed,
      beforeAgent: async ({ simulation }) => {
        await simulation.diagnostics.setHomeRam(HOME_GB);
        for (const name of HACKING_AUGMENTATIONS) await simulation.diagnostics.giveInstalledAugmentation(name);
        await simulation.diagnostics.queueAugmentation("The Red Pill");
      },
    });
    const { game, simulation, data } = fresh;
    writeSwitch(data.store, CLOUD_SERVERS_ENABLED_SETTING, false);
    writeSwitch(data.store, HOME_RAM_ENABLED_SETTING, false);
    const slow = () => fresh.latest<SlowSnapshotData>("slow");
    const events = (kind: string) =>
      data.store
        .eventsInWindow({ environment: "E1", sinceMs: EPOCH_MS, untilMs: game.clock.now() })
        .filter((event) => event.kind === kind);

    // A6 installs The Red Pill at once; the reset links w0r1d_d43m0n. Then A6 off: no NeuroFlux Governor on offer.
    await game.runUntil(() => slow()?.resetInfo.ownedAugs["The Red Pill"] === 1, STAGE_MS);
    writeAugmentationsEnabled(data.store, false);
    // The level at 2,000 of 3,000 (a harness edit for the hours of it), and the money for the port openers.
    expect(HACKING_MULT).toBeGreaterThan(4);
    expect(HACKING_MULT).toBeLessThan(5);
    await simulation.diagnostics.gainHackingExp(hackingExpOfLevel(2000, HACKING_MULT));
    await simulation.diagnostics.setMoney(1e12);
    // Rooted, the planner measures batching's rate a minute, and chooses levelling mode.
    await game.runUntil(() => fresh.controller().levellingView().mode === "level", STAGE_MS);
    const view = fresh.controller().levellingView();
    expect(view).toMatchObject({ applies: true, target: "joesguns", estimates: { install: null } });
    expect(view.estimates?.level as number).toBeLessThan((view.estimates?.money as number) / 1.25);
    expect(events(LEVELLING_CHOSEN_EVENT_KIND).map((event) => event.detail)).toEqual([
      expect.objectContaining({ mode: "level", from: "money", target: "joesguns" }),
    ]);
    expect(fresh.controller().hackLoopView()).toMatchObject({ target: "joesguns", levelling: true });

    // Its measured rate once settled, fitted against the formula's for the RAM sent: near it over the window's 10
    // minutes (a minute's counts its hosts' whole landings, a weaken's 4 s apart: 0.95 to 1.03 on seeds 1 to 4).
    await game.runUntil(() => fresh.controller().levellingView().fit !== null, STAGE_MS);
    await game.run(10 * MINUTE);
    const fit = fresh.controller().levellingView().fit;
    console.log(`seed ${seed}: levelling's fit ${JSON.stringify(fit)}`);
    expect(fit?.factor).toBeGreaterThan(0.95);
    expect(fit?.factor).toBeLessThan(1.05);
    // The level loop on home, beyond what home keeps for the Agent, and on the hosts; no batcher.
    const loopFile = deployedFilePath(fresh.deploymentId, LEVEL_LOOP_SCRIPT_NAME);
    const onHome = (await simulation.ps("home")).filter((process) => process.filename === loopFile);
    expect(onHome).toEqual([expect.objectContaining({ args: ["joesguns"] })]);
    const homeThreads = onHome[0]?.threads ?? 0;
    expect(homeThreads * 1.75).toBeLessThanOrEqual(HOME_GB - SHARE_HOME_KEPT_GB);
    expect(homeThreads).toBeGreaterThan(((HOME_GB - SHARE_HOME_KEPT_GB) / 1.75) * 0.95);
    const onJoesguns = (await simulation.ps("joesguns")).filter((process) => process.filename === loopFile);
    expect(onJoesguns).toEqual([expect.objectContaining({ args: ["joesguns"] })]);
    // Weakened to its minimum.
    const medium: MediumSnapshotData | null = fresh.medium();
    expect(medium?.servers.find((server) => server.hostname === "joesguns")?.hackDifficulty).toBe(5);
    expect(fresh.controller().batcherView().sent).toBeNull();

    // A6 on: CyberSec's reputation, A5's meanwhile, and the money buy NeuroFlux Governor's levels; the install is the
    // shortest now, bought and installed for the hacking level, and the planner starts again from money.
    writeAugmentationsEnabled(data.store, true);
    const resetBefore = slow()?.resetInfo.lastAugReset as number;
    await game.runUntil(() => (slow()?.resetInfo.lastAugReset ?? resetBefore) !== resetBefore, STAGE_MS);
    expect(events(AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND).map((event) => event.detail)).toContainEqual(
      expect.objectContaining({ reason: "the hacking level" }),
    );
    expect(events(LEVELLING_CHOSEN_EVENT_KIND).map((event) => (event.detail as { mode: string }).mode)).toEqual([
      "level",
      "install",
      "money",
    ]);
    expect(slow()?.resetInfo.ownedAugs["NeuroFlux Governor"]).toBeGreaterThan(0);
    expect(fresh.controller().levellingView().mode).toBe("money");
  },
);
