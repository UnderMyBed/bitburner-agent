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
// - BN2 (#355): the gang formed with NiteSec (A5's join a harness edit, as G5's), The Red Pill queued (a harness edit)
//   and installed, then NiteSec's reputation at 1m and $1t: its shop's hacking augmentations within reach and no
//   NeuroFlux Governor (no gang's shop sells it). Rooted, the planner chooses the install with the set alone; A6 buys it
//   at NiteSec and installs ("the hacking level"), the gang kept, and the planner is back on money.
// - BN4's A/B (#380): levelling mode against (d), batching for the money then the install, from The Red Pill with the
//   level short (harness edits shaped like BN4.2: the first NeuroFlux Governor level's donation past the money the
//   first minutes bring, so (c) has none as levelling chooses); the time to the destroy in each arm.
// CI runs seed 1 (BN2's case and the A/B once); `LEVELLING_SEEDS` (`1,2,3`, say) runs others.
import {
  AUGMENTATIONS,
  addsToLevelling,
  augmentationsSoldBy,
  deployedFilePath,
  hackingExpOfLevel,
  LEVEL_GROW_SCRIPT_NAME,
  LEVEL_LOOP_SCRIPT_NAME,
  type MediumSnapshotData,
  NEUROFLUX_GOVERNOR,
  type SlowSnapshotData,
} from "@bitburner-agent/core";
import { expect, test } from "vitest";
import { AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND, writeAugmentationsEnabled } from "../src/augmentations.ts";
import { CLOUD_SERVERS_ENABLED_SETTING } from "../src/cloud-servers.ts";
import { gangSnapshotOf } from "../src/gang.ts";
import { HOME_RAM_ENABLED_SETTING } from "../src/home-ram.ts";
import { LEVELLING_CHOSEN_EVENT_KIND, type LevellingEvent } from "../src/levelling.ts";
import { runReport } from "../src/run-report.ts";
import { SHARE_HOME_KEPT_GB } from "../src/share.ts";
import { writeSwitch } from "../src/switches.ts";
import { BITNODE_DESTROY_SENT_EVENT_KIND } from "../src/world-daemon.ts";
import { EPOCH_MS } from "./helpers/agent-in-simulation.ts";
import { useFreshStarts, withoutSimEffectors } from "./helpers/fresh-start.ts";

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
/** BN2 with SF1.3 and SF4.3, as the campaign enters it (G1's fixture, gang-simulation.test.ts). */
const BN2 = { kind: "bitnode", n: 2, sourceFiles: { 1: 3, 4: 3 } } as const;
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
    // Levelling's loops aren't bundles (#339): until it's sent, the deploy worker has written neither to home.
    for (const name of [LEVEL_LOOP_SCRIPT_NAME, LEVEL_GROW_SCRIPT_NAME]) {
      await expect(simulation.staticRamUsage("home", deployedFilePath(fresh.deploymentId, name))).rejects.toThrow(
        /does not exist/,
      );
    }
    // Rooted, the planner measures batching's rate a minute, and chooses levelling mode.
    await game.runUntil(() => fresh.controller().levellingView().mode === "level", STAGE_MS);
    const view = fresh.controller().levellingView();
    expect(view).toMatchObject({ applies: true, target: "joesguns", estimates: { install: null } });
    expect(view.estimates?.level as number).toBeLessThan((view.estimates?.money as number) / 1.25);
    expect(events(LEVELLING_CHOSEN_EVENT_KIND).map((event) => event.detail)).toEqual([
      expect.objectContaining({ mode: "level", from: "money", target: "joesguns" }),
    ]);
    expect(fresh.controller().hackLoopView()).toMatchObject({ target: "joesguns", levelling: true });

    // The weaken from its starting security first, then the grow at its minimum: a round fills it to its maximum money
    // (the install left it at a 25th, `Server/Server.ts:74-76`), raising its security once, a weaken round takes it
    // back, and from then on the grow, which moves no money and adds no security.
    const operations: string[] = [];
    await game.runUntil(() => {
      const operation = /(growing|weakening) it/.exec(fresh.controller().levellingView().lines[1] ?? "")?.[1];
      if (operation !== undefined && operations.at(-1) !== operation) operations.push(operation);
      return fresh.controller().levellingView().fit !== null && operations.at(-1) === "growing";
    }, STAGE_MS);
    // Its measured rate, fitted against the formula's for the threads running, the grow's: near it over the window's
    // 10 minutes (0.953 to 1.008 on seeds 1 to 4, the threads counted equal; the 5% under on three seeds has no known cause); the grow
    // throughout.
    await game.run(11 * MINUTE);
    const fit = fresh.controller().levellingView().fit;
    console.log(`seed ${seed}: levelling's operations ${operations.join(", ")}; fit ${JSON.stringify(fit)}`);
    expect(operations.length).toBeLessThanOrEqual(4);
    expect(fresh.controller().levellingView().lines[1]).toContain("growing it (the operation sent)");
    expect(fit?.factor).toBeGreaterThan(0.94);
    expect(fit?.factor).toBeLessThan(1.06);
    // The grow loop on home, beyond what home keeps for the Agent, and on the hosts; joesguns at its minimum security
    // and maximum money. No batcher.
    const loopFile = deployedFilePath(fresh.deploymentId, LEVEL_GROW_SCRIPT_NAME);
    const onHome = (await simulation.ps("home")).filter((process) => process.filename === loopFile);
    expect(onHome).toEqual([expect.objectContaining({ args: ["joesguns"] })]);
    const homeThreads = onHome[0]?.threads ?? 0;
    expect(homeThreads * 1.75).toBeLessThanOrEqual(HOME_GB - SHARE_HOME_KEPT_GB);
    expect(homeThreads).toBeGreaterThan(((HOME_GB - SHARE_HOME_KEPT_GB) / 1.75) * 0.95);
    const onJoesguns = (await simulation.ps("joesguns")).filter((process) => process.filename === loopFile);
    expect(onJoesguns).toEqual([expect.objectContaining({ args: ["joesguns"] })]);
    const medium: MediumSnapshotData | null = fresh.medium();
    const joesguns = medium?.servers.find((server) => server.hostname === "joesguns");
    expect(joesguns?.hackDifficulty).toBe(5);
    expect(joesguns?.moneyAvailable).toBeGreaterThan(0);
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

test("BN2 (#355): The Red Pill installed, the gang's faction's reputation for its shop, no NeuroFlux Governor: the install for the level with the set alone", {
  timeout: 300_000,
}, async () => {
  const fresh = await freshStartOf({
    withDesiredState: true,
    fixture: BN2,
    beforeAgent: async (game) => {
      await game.simulation.diagnostics.setHomeRam(HOME_GB);
      await game.simulation.diagnostics.joinFactionWithReputation("NiteSec", 0);
      await withoutSimEffectors(game);
    },
  });
  const { game, simulation, data } = fresh;
  writeSwitch(data.store, CLOUD_SERVERS_ENABLED_SETTING, false);
  writeSwitch(data.store, HOME_RAM_ENABLED_SETTING, false);
  const slow = () => fresh.latest<SlowSnapshotData>("slow");
  const events = (kind: string) =>
    data.store
      .eventsInWindow({ environment: "E1", sinceMs: EPOCH_MS, untilMs: game.clock.now() })
      .filter((event) => event.kind === kind)
      .map((event): Record<string, unknown> & { storedAtMs: number } => ({
        ...(event.detail as Record<string, unknown>),
        storedAtMs: event.atMs,
      }));
  // The gang formed with NiteSec (through the gate), then The Red Pill queued (a harness edit): A6 installs it at
  // once, the gang kept (`Prestige.ts:133-146`), its faction joined again at no reputation.
  await game.runUntil(() => gangSnapshotOf(fresh.medium()).kind === "gang", STAGE_MS);
  await simulation.diagnostics.queueAugmentation("The Red Pill");
  await game.runUntil(() => slow()?.resetInfo.ownedAugs["The Red Pill"] === 1, STAGE_MS);
  // NiteSec at 1m (harness edits for the gang's hours of respect) and $1t: its shop's hacking augmentations within
  // reach, no NeuroFlux Governor (no gang's shop sells it, `FactionHelpers.tsx:172-178`, and no other faction joined).
  await simulation.diagnostics.joinFactionWithReputation("NiteSec", 1e6);
  await simulation.diagnostics.setMoney(1e12);
  const installedBefore = Object.keys(slow()?.resetInfo.ownedAugs ?? {});
  const resetBefore = slow()?.resetInfo.lastAugReset as number;
  // Rooted, the planner measures batching's rate, and chooses the install: A6 buys the set at NiteSec and installs.
  await game.runUntil(() => (slow()?.resetInfo.lastAugReset ?? resetBefore) !== resetBefore, 2 * STAGE_MS);
  const chosen = events(LEVELLING_CHOSEN_EVENT_KIND);
  const install = chosen.find((event) => event.mode === "install");
  const offered = (install?.installAugmentations ?? []) as string[];
  const bought = events("augmentationBought").map((event) => `${event.augmentation} (${event.faction})`);
  console.log(
    `BN2 levelling: ${chosen.map((event) => `${event.mode} at ${new Date(event.storedAtMs).toISOString()}: ${event.detail}`).join("; ")}\n` +
      `offered: ${offered.join(", ")}\nbought: ${bought.join(", ")}`,
  );
  expect(chosen.map((event) => event.mode)).toEqual(["install", "money"]);
  expect(install).toMatchObject({ from: "money", neuroFluxLevels: 0 });
  expect(offered.length).toBeGreaterThan(1);
  const shop = augmentationsSoldBy("NiteSec", 2, "NiteSec");
  for (const name of offered) {
    expect(shop, name).toContain(name);
    expect(addsToLevelling([name]), name).toBe(true);
  }
  expect(events(AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND)).toContainEqual(
    expect.objectContaining({ reason: "the hacking level" }),
  );
  // Bought at the gang's faction, the set offered and nothing else (#355's review: under the destroy's hold, only
  // what adds to levelling), no NeuroFlux Governor; installed; the gang kept.
  expect(bought).toEqual(offered.map((name) => `${name} (NiteSec)`));
  const owned = slow()?.resetInfo.ownedAugs ?? {};
  for (const name of offered) expect(owned, name).toHaveProperty([name]);
  expect(Object.keys(owned).length).toBeGreaterThan(installedBefore.length);
  expect(owned).not.toHaveProperty([NEUROFLUX_GOVERNOR]);
  expect(bought.every((each) => each.endsWith("(NiteSec)"))).toBe(true);
  expect(fresh.controller().levellingView().mode).toBe("money");
  await game.runUntil(() => gangSnapshotOf(fresh.medium()).kind === "gang", STAGE_MS);
  // The run report to 30 s after the choice (before the reset): the install scored with the set the brain offered.
  const untilMs = (install?.storedAtMs as number) + 30_000;
  const { text, failures } = runReport(data.store, { environment: "E1", sinceMs: EPOCH_MS, untilMs }, {});
  const line = text.split("\n").find((each) => each.includes("levelling (the hacking level all that's left"));
  console.log(`${line}\n${failures.join("\n")}`);
  expect(line).toMatch(/, augmentations, then an install about [^,]+, batching for the money, then an install none$/);
  expect(text).toContain("the brain's choice: augmentations, then an install since");
  expect(failures.filter((failure) => failure.startsWith("levelling:"))).toEqual([]);
  // On, $1t again (the install took the money, `Prestige.ts`: a harness edit for the port openers), w0r1d_d43m0n
  // rooted again, NiteSec's reputation gone with the install: no set now, levelling mode. Once the
  // level has been all that's left 10 minutes in the BitNode, added up across the install (#355's review), the hopeless
  // estimate fails the report, as it must: BN2's 15,000 at ×0.8 from a fresh level is far past the BitNode's time.
  const resetMs = chosen.find((event) => event.mode === "money")?.storedAtMs as number;
  await simulation.diagnostics.setMoney(1e12);
  const rootedAgain = () =>
    fresh.medium()?.servers.find((server) => server.hostname === "w0r1d_d43m0n")?.hasAdminRights;
  await game.runUntil(() => rootedAgain() === true, STAGE_MS);
  const rerootedMs = game.clock.now();
  const reportNow = () =>
    runReport(data.store, { environment: "E1", sinceMs: EPOCH_MS, untilMs: game.clock.now() }, {});
  const hopeless = (failures: string[]) => failures.filter((failure) => / a hopeless estimate$/.test(failure));
  // Before the install's 5 min and this stretch add up to 10: passing, the last stretch alone short of it anyway.
  await game.run(MINUTE);
  expect(hopeless(reportNow().failures)).toEqual([]);
  // Checked every 30 s (a report each time), for 10 minutes at most.
  for (let checks = 0; checks < 20 && hopeless(reportNow().failures).length === 0; checks++) await game.run(30_000);
  const firedMs = game.clock.now();
  const now = reportNow();
  console.log(
    `reset at ${new Date(resetMs).toISOString()}, rooted again at ${new Date(rerootedMs).toISOString()}, the hopeless ` +
      `failure from ${new Date(firedMs).toISOString()}:\n${now.failures.join("\n")}`,
  );
  // The stretch since the root again alone is under 10 minutes: only the sum across the install fires it.
  expect(firedMs - rerootedMs).toBeLessThan(10 * MINUTE);
  expect(now.failures).toEqual([
    expect.stringMatching(
      /^levelling: the brain's choice, .*, past the .* the BitNode has taken so far: a hopeless estimate$/,
    ),
  ]);
});

/** BN4 with SF1.3, as the campaign enters it (bn4-start-simulation.test.ts's fixture). */
const BN4 = { kind: "bitnode", n: 4, sourceFiles: { 1: 3 } } as const;
/** CyberSec's five that add to levelling (its shop, `Faction/Factions.ts`), given installed: no set to buy there. */
const CYBERSEC_FIVE = [
  "BitWire",
  "Synaptic Enhancement Implant",
  "Neurotrainer I",
  "Cranial Signal Processors - Gen I",
  "Cranial Signal Processors - Gen II",
];
/** Other augmentations with a hacking multiplier, the smallest first, while their product stays at 6.7 or under. */
const BN4_AUGMENTATIONS = (() => {
  const names: string[] = [];
  let mult = 1;
  const byHacking = Object.entries(AUGMENTATIONS).sort(
    ([a, x], [b, y]) => (x.multipliers.hacking ?? 1) - (y.multipliers.hacking ?? 1) || (a < b ? -1 : 1),
  );
  for (const [name, data] of byHacking) {
    const hacking = data.multipliers.hacking;
    if (hacking === undefined || hacking <= 1 || mult * hacking > 6.7 || name === NEUROFLUX_GOVERNOR) continue;
    if (CYBERSEC_FIVE.includes(name) || data.factions.length === 0 || !Number.isFinite(data.baseMoneyCost)) continue;
    names.push(name);
    mult *= hacking;
  }
  return names;
})();

test("BN4 A/B (#380): from The Red Pill with the level short, levelling mode against (d); the time to the destroy", {
  timeout: 300_000,
}, async () => {
  /**
   * One arm: BN4.2's shape by harness edits. Home 16 TB; the augmentations above and CyberSec's five installed, and
   * NeuroFlux Governor's 50 levels and The Red Pill queued before the Agent (A6 installs them at once): ×16.3. Then
   * hacking 5,000 of 9,000, $300m for the port openers, and CyberSec joined at no reputation with favour 200: each
   * level by a donation (500 × 1.14^50 reputation, about $3e11), past the money the first minutes bring, so (c) has
   * none as levelling chooses, as BN4.2's $2.8e12 first level was past its $789b. After each install, the money for
   * the openers and CyberSec again (harness edits for the live 3.4-minute re-root). Cloud servers and home RAM off.
   */
  async function arm(levellingBatch: boolean) {
    const fresh = await freshStartOf({
      withDesiredState: true,
      fixture: BN4,
      levellingBatch,
      beforeAgent: async ({ simulation }) => {
        await simulation.diagnostics.setHomeRam(16_384);
        for (const name of [...CYBERSEC_FIVE, ...BN4_AUGMENTATIONS]) {
          await simulation.diagnostics.giveInstalledAugmentation(name);
        }
        for (let level = 0; level < 50; level++) await simulation.diagnostics.queueAugmentation(NEUROFLUX_GOVERNOR);
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
    await game.runUntil(() => slow()?.resetInfo.ownedAugs["The Red Pill"] === 1, STAGE_MS);
    const mult = (fresh.medium()?.player as { mults?: { hacking?: number } } | undefined)?.mults?.hacking as number;
    const reroot = async () => {
      await simulation.diagnostics.setMoney(3e8);
      await simulation.diagnostics.joinFactionWithReputation("CyberSec", 0);
      await simulation.diagnostics.setFactionFavor("CyberSec", 200);
    };
    await simulation.diagnostics.gainHackingExp(hackingExpOfLevel(5000, mult));
    await reroot();
    const startMs = game.clock.now();
    let reset = slow()?.resetInfo.lastAugReset as number;
    for (let minutes = 0; minutes < 120 && events(BITNODE_DESTROY_SENT_EVENT_KIND).length === 0; minutes++) {
      await game.run(MINUTE);
      if (slow()?.resetInfo.lastAugReset !== reset) {
        reset = slow()?.resetInfo.lastAugReset as number;
        await reroot();
      }
    }
    const destroyed = events(BITNODE_DESTROY_SENT_EVENT_KIND)[0];
    const chosen = events(LEVELLING_CHOSEN_EVENT_KIND).map((event) => ({
      ...(event.detail as LevellingEvent),
      afterMs: event.atMs - startMs,
    }));
    const installs = events(AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND).map((event) => event.detail as { reason: string });
    console.log(
      `(d) ${levellingBatch ? "on" : "off"}: ×${mult.toFixed(2)}; the destroy sent ${destroyed === undefined ? "never" : `at ${((destroyed.atMs - startMs) / MINUTE).toFixed(1)} min`}\n` +
        chosen.map((each) => `  ${(each.afterMs / MINUTE).toFixed(1)} min: ${each.detail}`).join("\n"),
    );
    return { mult, destroyedMs: destroyed === undefined ? null : destroyed.atMs - startMs, chosen, installs };
  }

  const off = await arm(false);
  const on = await arm(true);
  expect(on.mult).toBeCloseTo(16.35, 2);
  // Off (main's levelling): levelling mode at once, (c) none (the first level's donation past the money in hand), and
  // (d) never weighed.
  expect(off.chosen[0]).toMatchObject({ mode: "level", from: "money", estimates: { install: null, batch: null } });
  expect(off.chosen.every((each) => each.estimates.batch === null)).toBe(true);
  // On: (d) at once, 1.25 times shorter than levelling mode; batching until (c), the money in hand, is no longer than
  // (d), then the install for the level; after it, the level from the install's start.
  const first = on.chosen[0] as LevellingEvent & { afterMs: number };
  expect(first).toMatchObject({ mode: "batch", from: "money", estimates: { install: null } });
  expect(first.estimates.batch as number).toBeLessThan((first.estimates.level as number) / 1.25);
  expect(first.batch).toMatchObject({ levels: expect.any(Number), money: expect.any(Number) });
  expect(on.chosen.map((each) => each.mode).slice(0, 3)).toEqual(["batch", "install", "money"]);
  expect(on.installs.filter((each) => each.reason === "the hacking level").length).toBeGreaterThan(0);
  // The time to the destroy: (d)'s the shorter.
  expect(on.destroyedMs).not.toBeNull();
  expect(off.destroyedMs).not.toBeNull();
  expect(on.destroyedMs as number).toBeLessThan(off.destroyedMs as number);
});
