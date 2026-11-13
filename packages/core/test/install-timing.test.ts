// Install timing (#343): the estimates' cases, the choice, and the next countables' times, with golden cases from the
// store's tables (#343: BN1.2 to BN4.1, read to 2026-11-10 23:53).
import { describe, expect, test } from "vitest";
import { type AugmentationSet, installRule } from "../src/augmentation-plan.ts";
import type { CountableWithMoney } from "../src/augmentation-reach.ts";
import {
  type AugmentationPurchaseState,
  augmentationBitNodeMultipliers,
  purchaseSequenceCost,
} from "../src/augmentations.ts";
import {
  type CountableLeft,
  countablesLeft,
  type InstallTiming,
  type LaterCycles,
  installNowEstimateMs,
  installTiming,
  LATER_CYCLE_FACTIONS,
  laterCyclesMs,
  nextCountables,
  reputationOneFactionAtATime,
  waitEstimateMs,
} from "../src/install-timing.ts";
import { BN4_2, BN4_FACTION_WORK_REP_GAIN, type Cycle, deadFor, endRise, measuredFactor, multipliers } from "./bn4-2-fixture.ts";
import { favorAfterInstall, repToFavor } from "../src/donations.ts";
import { factionReputationPerSecond } from "../src/faction-work.ts";

const MINUTE = 60_000;
const NEUROFLUX = "NeuroFlux Governor";
const STATE: AugmentationPurchaseState = {
  installed: {},
  queued: [],
  sourceFile11Level: 0,
  bitNodeMultipliers: { AugmentationMoneyCost: 1, AugmentationRepCost: 1 },
};
const NO_SET: AugmentationSet = { purchases: [], money: 0, donations: [], donationMoney: 0, byDonation: [] };
const toCome = (augmentation: string, etaMs: number, fields: Partial<CountableWithMoney> = {}): CountableWithMoney => ({
  augmentation,
  faction: "CyberSec",
  way: "money",
  etaMs,
  money: purchaseSequenceCost([augmentation], STATE).money,
  ...fields,
});

describe("the estimates (#343)", () => {
  test("install now: 0 once the set meets the count; else ⌈(N − n) / n⌉ cycles of T; none with nothing new", () => {
    expect(installNowEstimateMs(5, 5, 40 * MINUTE)).toBe(0);
    expect(installNowEstimateMs(5, 7, 40 * MINUTE)).toBe(0);
    // 13 to go, 4 a cycle: 3 more cycles (the ceiling), not 2.25.
    expect(installNowEstimateMs(13, 4, 44 * MINUTE)).toBe(3 * 44 * MINUTE);
    expect(installNowEstimateMs(13, 0, 44 * MINUTE)).toBeNull();
  });

  test("wait for k: τ_k once n + k meets it; else τ_k and ⌈(N − n − k) / (n + k)⌉ cycles of T + τ_k; none if never", () => {
    expect(waitEstimateMs(5, 4, 1, 17 * MINUTE, 28 * MINUTE)).toBe(17 * MINUTE);
    // 8 left after the wait, 5 a cycle: 2 more cycles of 44 + 77 minutes.
    expect(waitEstimateMs(13, 4, 1, 77 * MINUTE, 44 * MINUTE)).toBe(77 * MINUTE + 2 * 121 * MINUTE);
    expect(waitEstimateMs(13, 0, 2, 10 * MINUTE, 44 * MINUTE)).toBe(10 * MINUTE + 6 * 54 * MINUTE);
    expect(waitEstimateMs(13, 4, 1, Number.POSITIVE_INFINITY, 44 * MINUTE)).toBeNull();
  });
});

describe("the choice (#343)", () => {
  test("29 of 30, the last 17 minutes off (run #3's BN1.2 17:49): waiting wins, by the ceiling alone", () => {
    // BN1.2 cycle 7: 25 at its start, the set's four make 29; The Black Hand's augmentation 17 minutes off by work;
    // 28 minutes online (the brain's clock). Installing now costs a whole cycle more for the last one.
    // The Black Hand's τ from run #3's figures: 51,352 of its 100,000 at 46.9 a second, 17.3 minutes.
    const tauMs = ((100_000 - 51_352) / 46.9) * 1000;
    expect(tauMs / MINUTE).toBeCloseTo(17.3, 1);
    expect(installTiming({ needed: 5, adding: 4, onlineMs: 28 * MINUTE, next: [{ tauMs }] }).choice).toBe(1);
    // It waits for any τ under the cycle's 28 minutes, the bound it holds for.
    const timing = installTiming({ needed: 5, adding: 4, onlineMs: 28 * MINUTE, next: [{ tauMs: 17 * MINUTE }] });
    expect(timing).toEqual({
      needed: 5,
      adding: 4,
      onlineMs: 28 * MINUTE,
      candidates: [
        { k: 0, tauMs: 0, estimateMs: 28 * MINUTE },
        { k: 1, tauMs: 17 * MINUTE, estimateMs: 17 * MINUTE },
      ],
      choice: 1,
      heldForIncome: false,
      heldForInvitation: false,
      tauScale: 1,
    });
    // The last one a cycle off, or more: install now.
    expect(installTiming({ needed: 5, adding: 4, onlineMs: 28 * MINUTE, next: [{ tauMs: 29 * MINUTE }] }).choice).toBe(
      0,
    );
  });

  test("BN1.2 cycle 5: installed 77 minutes sooner than the count rule did, on its plateau", () => {
    // 17 at its start (16 and NeuroFlux Governor), so 13 to go; its four others affordable as its income plateaued, 44
    // minutes in (121 online at the install, 77 of them at 90% of its peak income or more); no fifth in the 77 minutes
    // after, so its τ is 77 minutes at the least. NeuroFlux Governor installed already adds nothing to the count.
    const at44 = { needed: 13, adding: 4, onlineMs: 44 * MINUTE };
    expect(installTiming({ ...at44, next: [{ tauMs: 77 * MINUTE }] })).toMatchObject({
      candidates: [
        { k: 0, estimateMs: 132 * MINUTE },
        { k: 1, estimateMs: 319 * MINUTE },
      ],
      choice: 0,
    });
    // The bound it holds for: a fifth more than 14.7 minutes off (3τ + 88 against 132) installs; 14.6 would wait. The
    // store saw none in 77.
    const fifth = (tauMinutes: number) => installTiming({ ...at44, next: [{ tauMs: tauMinutes * MINUTE }] }).choice;
    expect([fifth(14.6), fifth(14.7), fifth(77)]).toEqual([1, 0, 0]);
    // The count rule at 44 minutes: 4 of 8, 11 of 12 with its NeuroFlux Governor levels, no install (it came at 121).
    const rule = installRule({
      onlineMs: 44 * MINUTE,
      sinceResetMs: 44 * MINUTE,
      installing: 4,
      neuroFluxLevels: 7,
      nothingLeft: false,
      affordable: 4,
      affordableWithNeuroFlux: 11,
    });
    expect(rule.install).toBe(false);
  });

  test("a longer rebuild (BN4's) waits longer by itself: the same n and τ, T 40 minutes installs, T 140 waits", () => {
    const next = [{ tauMs: 30 * MINUTE }];
    expect(installTiming({ needed: 17, adding: 4, onlineMs: 40 * MINUTE, next })).toMatchObject({
      candidates: [{ estimateMs: 160 * MINUTE }, { estimateMs: 240 * MINUTE }],
      choice: 0,
    });
    expect(installTiming({ needed: 17, adding: 4, onlineMs: 140 * MINUTE, next })).toMatchObject({
      candidates: [{ estimateMs: 560 * MINUTE }, { estimateMs: 540 * MINUTE }],
      choice: 1,
    });
  });

  test("the set meeting the count installs; a tie goes to install, then to the fewer to wait for", () => {
    expect(installTiming({ needed: 3, adding: 3, onlineMs: MINUTE, next: [{ tauMs: 0 }] }).choice).toBe(0);
    // 2 to go, 1 a cycle of 10 minutes: install now 10; the next at 10 minutes, 10 too.
    expect(installTiming({ needed: 2, adding: 1, onlineMs: 10 * MINUTE, next: [{ tauMs: 10 * MINUTE }] }).choice).toBe(
      0,
    );
    const tied = installTiming({ needed: 9, adding: 0, onlineMs: MINUTE, next: [{ tauMs: 0 }, { tauMs: 0 }] });
    expect(tied.candidates.map((each) => each.estimateMs)).toEqual([8 * MINUTE, 4 * MINUTE]);
    expect(tied.choice).toBe(2);
  });

  test("nothing new to install (n = 0): no install candidate, so a wait or nothing; never an install", () => {
    const waiting = installTiming({ needed: 14, adding: 0, onlineMs: 20 * MINUTE, next: [{ tauMs: 5 * MINUTE }] });
    expect(waiting.candidates.map((each) => each.k)).toEqual([1]);
    expect(waiting.choice).toBe(1);
    expect(installTiming({ needed: 14, adding: 0, onlineMs: 20 * MINUTE, next: [] })).toMatchObject({
      candidates: [],
      choice: null,
    });
  });

  test("an invitation's money held: installing now held likewise, unless the set meets the count", () => {
    const holding = { needed: 5, adding: 4, onlineMs: 28 * MINUTE, invitationHeld: true };
    expect(installTiming({ ...holding, next: [{ tauMs: 30 * MINUTE }] })).toMatchObject({
      choice: 1,
      heldForInvitation: true,
      heldForIncome: false,
    });
    expect(installTiming({ ...holding, next: [] })).toMatchObject({ choice: null, heldForInvitation: true });
    expect(installTiming({ ...holding, adding: 5, next: [] })).toMatchObject({ choice: 0, heldForInvitation: false });
    expect(installTiming({ ...holding, invitationHeld: false, next: [] })).toMatchObject({ choice: 0 });
  });

  test("no income measured: installing now held unless the set meets the count; the least wait, or none, instead", () => {
    const unmeasured = { needed: 5, adding: 4, onlineMs: 28 * MINUTE, incomeMeasured: false };
    expect(installTiming({ ...unmeasured, next: [{ tauMs: 30 * MINUTE }] })).toMatchObject({
      candidates: [{ k: 0, estimateMs: 28 * MINUTE }, { k: 1 }],
      choice: 1,
      heldForIncome: true,
    });
    expect(installTiming({ ...unmeasured, next: [] })).toMatchObject({ choice: null, heldForIncome: true });
    // A wait shorter anyway isn't held; the set meeting the count installs whatever the income.
    expect(installTiming({ ...unmeasured, next: [{ tauMs: 10 * MINUTE }] })).toMatchObject({
      choice: 1,
      heldForIncome: false,
    });
    expect(installTiming({ ...unmeasured, adding: 5, next: [] })).toMatchObject({ choice: 0, heldForIncome: false });
  });

  test("an overdue wait's measured error scales each τ: the wait gives way where its cycles cost more than installing", () => {
    // 9 to go, 4 new: installing now 2T; waiting 10 min, T + 2τ. Scaled 3.1 (31 minutes waited of 10): 2T is less.
    const at59 = { needed: 9, adding: 4, onlineMs: 59 * MINUTE, next: [{ tauMs: 10 * MINUTE }] };
    expect(installTiming(at59).choice).toBe(1);
    expect(installTiming({ ...at59, tauScale: 3.1 })).toMatchObject({
      candidates: [
        { k: 0, estimateMs: 118 * MINUTE },
        { k: 1, tauMs: 31 * MINUTE, estimateMs: 121 * MINUTE },
      ],
      choice: 0,
      tauScale: 3.1,
    });
    // At the last one, the scaled wait is the wait so far, never more than a cycle's T: it goes on.
    expect(
      installTiming({ needed: 5, adding: 4, onlineMs: 63 * MINUTE, next: [{ tauMs: 10 * MINUTE }], tauScale: 3.5 }),
    ).toMatchObject({ candidates: [{ estimateMs: 63 * MINUTE }, { estimateMs: 35 * MINUTE }], choice: 1 });
    // A first τ of 0 overdue: a scale of Infinity, so no wait has an estimate (a τ of 0 stays 0).
    expect(installTiming({ ...at59, tauScale: Number.POSITIVE_INFINITY }).candidates.map((each) => each.k)).toEqual([
      0,
    ]);
  });

  test("no estimate for the next one (τ never): install now is the only candidate", () => {
    const timing = installTiming({
      needed: 14,
      adding: 2,
      onlineMs: 20 * MINUTE,
      next: [{ tauMs: Number.POSITIVE_INFINITY }],
    });
    expect(timing.candidates).toEqual([{ k: 0, tauMs: 0, estimateMs: 6 * 20 * MINUTE }]);
    expect(timing.choice).toBe(0);
  });
});

describe("the next countables (#343)", () => {
  const BITWIRE = "BitWire";
  const NEUROTRAINER = "Neurotrainer I";
  const GEN_I = "Cranial Signal Processors - Gen I";

  test("the soonest first; each τ the latest of its own, those before it, and the money for all with the set", () => {
    // At $1m a second with $0: BitWire alone at 2 minutes by work, Neurotrainer I at 1 by its money; together, bought
    // in buy order (the dearer first, the next 1.9 times), $10m + $4m × 1.9 = $17.6m, 17.6 s.
    const next = nextCountables({
      toCome: [toCome(BITWIRE, 2 * MINUTE, { way: "work" }), toCome(NEUROTRAINER, MINUTE)],
      set: NO_SET,
      state: STATE,
      money: 0,
      income: 1e6,
      upTo: 5,
    });
    const both = purchaseSequenceCost([BITWIRE, NEUROTRAINER], STATE).money;
    expect(both).toBeCloseTo(10e6 + 4e6 * 1.9, 0);
    expect(next.map((each) => [each.augmentation, each.tauMs, each.addedMoney])).toEqual([
      [NEUROTRAINER, MINUTE, 4e6],
      [BITWIRE, 2 * MINUTE, both],
    ]);
    // The money for both is what's latest at $10k a second: 1,760 s.
    const slow = nextCountables({
      toCome: [toCome(BITWIRE, 2 * MINUTE, { way: "work" }), toCome(NEUROTRAINER, MINUTE)],
      set: NO_SET,
      state: STATE,
      money: 0,
      income: 1e4,
      upTo: 5,
    });
    expect(slow[1]?.tauMs).toBeCloseTo((both / 1e4) * 1000, 6);
  });

  test("the work one faction at a time: two factions' work added up, one faction's its longest", () => {
    const work = (augmentation: string, faction: string, workMs: number) =>
      toCome(augmentation, workMs, { way: "work", faction, workMs });
    const next = nextCountables({
      toCome: [
        work(NEUROTRAINER, "CyberSec", MINUTE),
        work(BITWIRE, "NiteSec", 2 * MINUTE),
        work(GEN_I, "CyberSec", 3 * MINUTE),
      ],
      set: NO_SET,
      state: STATE,
      money: 1e12,
      income: null,
      upTo: 5,
    });
    // CyberSec 1, then NiteSec 2 more; then CyberSec's longest, 3, and NiteSec's 2.
    expect(next.map((each) => each.tauMs)).toEqual([MINUTE, 3 * MINUTE, 5 * MINUTE]);
  });

  test("after the set, its prices 1.9 times each; a donation's money counted for each; at most `upTo`", () => {
    const set: AugmentationSet = {
      ...NO_SET,
      purchases: purchaseSequenceCost([GEN_I], STATE).purchases,
      money: purchaseSequenceCost([GEN_I], STATE).money,
      donations: [{ faction: "NiteSec", reputation: 1, amount: 1e6 }],
      donationMoney: 1e6,
    };
    const priceAfterSet = purchaseSequenceCost([GEN_I, BITWIRE], STATE).money - set.money;
    const next = nextCountables({
      toCome: [
        toCome(BITWIRE, 0, { way: "donation", faction: "NiteSec", money: priceAfterSet + 5e6 }),
        toCome(NEUROTRAINER, MINUTE),
      ],
      set,
      state: STATE,
      money: set.money + set.donationMoney + priceAfterSet + 5e6,
      income: null,
      upTo: 1,
    });
    // The money covers the set, BitWire after it and its donation: at once. Only one asked for.
    expect(next).toEqual([
      expect.objectContaining({ augmentation: BITWIRE, tauMs: 0, addedMoney: priceAfterSet + 5e6 }),
    ]);
  });

  test("no income measured: only what the money covers; the first never ends them", () => {
    const next = nextCountables({
      toCome: [toCome(NEUROTRAINER, 0), toCome(BITWIRE, 1), toCome(GEN_I, Number.POSITIVE_INFINITY)],
      set: NO_SET,
      state: STATE,
      money: 4e6,
      income: null,
      upTo: 5,
    });
    // Neurotrainer I's $4m is covered; with BitWire, $17.6m isn't, and no income: never.
    expect(next.map((each) => each.augmentation)).toEqual([NEUROTRAINER]);
    expect(
      nextCountables({
        toCome: [toCome(NEUROTRAINER, MINUTE)],
        set: NO_SET,
        state: STATE,
        money: 0,
        income: 1,
        upTo: 0,
      }),
    ).toEqual([]);
  });
});

describe("the later cycles priced from the countables left (#389)", () => {
  const left = (augmentation: string, reputation: number, ...sellers: string[]): CountableLeft => ({
    augmentation,
    reputation,
    sellers,
  });

  test("the countables left: the cheapest first, ties to the game's order, none owned, queued, in the set or special", () => {
    const names = (each: CountableLeft[]) => each.map((one) => [one.augmentation, one.reputation]);
    expect(names(countablesLeft({ factions: ["Volhaven"], bitNode: 1, state: STATE, set: [] }))).toEqual([
      ["Wired Reflexes", 1250],
      ["Nuoptimal Nootropic Injector Implant", 5000],
      ["Combat Rib I", 7500],
      ["Speech Processor Implant", 7500],
      ["DermaForce Particle Barrier", 15000],
      ["Combat Rib II", 18750],
      ["Neuralstimulator", 50000],
    ]);
    // Installed, queued or in the set: not left. Combat Rib II's prerequisite in the set: it's still left.
    const after = countablesLeft({
      factions: ["Volhaven", "Volhaven"],
      bitNode: 1,
      state: { ...STATE, installed: { "Wired Reflexes": 1 }, queued: ["Speech Processor Implant"] },
      set: ["Combat Rib I"],
    });
    expect(after.map((one) => one.augmentation)).toEqual([
      "Nuoptimal Nootropic Injector Implant",
      "DermaForce Particle Barrier",
      "Combat Rib II",
      "Neuralstimulator",
    ]);
    // Each seller among the factions counted; a faction listed twice, once.
    expect(after.at(-1)?.sellers).toEqual(["Volhaven"]);
    const two = countablesLeft({ factions: ["Volhaven", "Sector-12"], bitNode: 1, state: STATE, set: [] });
    expect(two.find((one) => one.augmentation === "Neuralstimulator")?.sellers).toEqual(["Volhaven", "Sector-12"]);
    // Daedalus: never The Red Pill or NeuroFlux Governor; the Netburner Module's upgrades need it, sold elsewhere.
    const daedalus = countablesLeft({ factions: ["Daedalus"], bitNode: 1, state: STATE, set: [] });
    expect(daedalus.map((one) => one.augmentation)).toEqual([
      "Synfibril Muscle",
      "Synthetic Heart",
      "NEMEAN Subdermal Weave",
    ]);
    // Tian Di Hui and the six city factions: the later cycles' (a city and money).
    expect(LATER_CYCLE_FACTIONS).toEqual([
      "Tian Di Hui",
      "Sector-12",
      "Aevum",
      "Chongqing",
      "New Tokyo",
      "Ishima",
      "Volhaven",
    ]);
  });

  test("the reputation one faction at a time: each faction's dearest, added up; a shared seller where it serves more", () => {
    expect(reputationOneFactionAtATime([])).toBe(0);
    expect(reputationOneFactionAtATime([left("D", 15_000, "Volhaven"), left("C", 18_750, "Volhaven")])).toBe(18_750);
    expect(reputationOneFactionAtATime([left("N", 37_500, "Tian Di Hui"), left("G", 37_500, "Chongqing")])).toBe(
      75_000,
    );
    // Neuralstimulator at Chongqing, which sells the other too: one faction's work serves both.
    expect(
      reputationOneFactionAtATime([left("S", 50_000, "The Black Hand", "Chongqing"), left("G", 37_500, "Chongqing")]),
    ).toBe(50_000);
    // The dearest first: a cheaper one at a faction already worked for adds nothing; one with no seller, nothing.
    expect(
      reputationOneFactionAtATime([left("A", 5_000, "Volhaven"), left("B", 20_000, "Volhaven"), left("X", 9)]),
    ).toBe(20_000);
  });

  test("each later cycle R + (T − R) · W_j / W_0; the same W, T again; unpriced or past those known, this one's shape", () => {
    const work = { rebuildMs: 4 * MINUTE, reputation: 12_500 };
    const cheap = [left("A", 12_500, "Sector-12"), left("B", 12_500, "Volhaven"), left("C", 25_000, "Volhaven")];
    const at = (
      count: number,
      perCycle: number,
      shapeMs: number,
      later: Parameters<typeof laterCyclesMs>[0]["later"],
    ) => laterCyclesMs({ count, perCycle, onlineMs: 23 * MINUTE, shapeMs, later });
    // 3 countables at 1 a cycle: 12,500 each, then 25,000 (twice the work).
    expect(at(3, 1, 23 * MINUTE, { left: cheap, work })).toEqual([23 * MINUTE, 23 * MINUTE, 42 * MINUTE]);
    // 2 a cycle: A and B (two factions, 25,000), then C alone.
    expect(at(3, 2, 23 * MINUTE, { left: cheap, work })).toEqual([42 * MINUTE, 42 * MINUTE]);
    // Past the countables known: this one's shape (`shapeMs`) for each cycle short of them.
    expect(at(5, 2, 30 * MINUTE, { left: cheap, work })).toEqual([42 * MINUTE, 30 * MINUTE, 30 * MINUTE]);
    // Unpriced: no work (R not measured), W_0 0, or T not past R: each cycle this one's shape.
    for (const unpriced of [null, { ...work, reputation: 0 }, { ...work, rebuildMs: 23 * MINUTE }]) {
      expect(at(3, 1, 30 * MINUTE, { left: cheap, work: unpriced })).toEqual([30 * MINUTE, 30 * MINUTE, 30 * MINUTE]);
    }
    expect(at(2, 1, MINUTE, undefined)).toEqual([MINUTE, MINUTE]);
    // A wait's later cycles bring n + k each: 6 to go, 2 new, waiting for 1 at 10 min, then 3 at three factions
    // (30,000) in one cycle, 4 + 20 · 3; never the 2 a cycle installing now has.
    const four = ["F0", "F1", "F2", "F3"].map((faction) => left(faction, 10_000, faction));
    const at24 = { rebuildMs: 4 * MINUTE, reputation: 10_000 };
    expect(waitEstimateMs(6, 2, 1, 10 * MINUTE, 24 * MINUTE, { left: four, work: at24 })).toBe(74 * MINUTE);
    expect(installNowEstimateMs(6, 2, 24 * MINUTE, { left: four, work: at24 })).toBe(88 * MINUTE);
  });

  test("the countables left costing as this cycle's: install now's estimate is the one before #389, ⌈(N − n) / n⌉ · T", () => {
    for (const [needed, adding] of [
      [13, 4],
      [6, 2],
      [30, 16],
      [9, 1],
    ] as const) {
      const work = { rebuildMs: 5 * MINUTE, reputation: 10_000 };
      // n a cycle, all at one faction of its own at 10,000: W_0 again in every cycle.
      const same = Array.from({ length: needed }, (_, index) =>
        left(`L${index}`, 10_000, `F${Math.floor(index / adding)}`),
      );
      const old = installNowEstimateMs(needed, adding, 44 * MINUTE);
      expect(old).toBe(Math.ceil((needed - adding) / adding) * 44 * MINUTE);
      expect(installNowEstimateMs(needed, adding, 44 * MINUTE, { left: same, work })).toBeCloseTo(old as number, 6);
    }
  });

  test("dearer countables left: install now's estimate rises, and the choice moves from install to wait", () => {
    const work = { rebuildMs: 4 * MINUTE, reputation: 10_000 };
    // 4 to go, 2 new: before #389, install now T 24, wait for 1 at 20 min 20 + 44 = 64. Install.
    const base = { needed: 4, adding: 2, onlineMs: 24 * MINUTE, next: [{ tauMs: 20 * MINUTE, augmentation: "N" }] };
    expect(installTiming(base)).toMatchObject({
      candidates: [{ estimateMs: 24 * MINUTE }, { estimateMs: 64 * MINUTE }],
      choice: 0,
    });
    // Left as this cycle's (10,000 at one faction): the same estimate to install now, each cycle's length given.
    const same = [left("N", 10_000, "Tian Di Hui"), left("M", 10_000, "Tian Di Hui")];
    expect(installTiming({ ...base, later: { left: same, work } })).toMatchObject({
      candidates: [
        { k: 0, estimateMs: 24 * MINUTE, cyclesMs: [24 * MINUTE] },
        // After the wait, M alone at 10,000: R + (T − R) · 1, 24; not 44, its shape.
        { k: 1, estimateMs: 44 * MINUTE, cyclesMs: [24 * MINUTE] },
      ],
      choice: 0,
      work,
    });
    // Left dearer, 50,000 at Chongqing: install now's next cycle (N and M, two factions) 4 + 20 · 6 = 124 min; the
    // wait's, M alone, 4 + 20 · 5 = 104 after 20. A tie, to install; 1 minute less of τ moves the choice to the wait.
    const dear = [left("N", 10_000, "Tian Di Hui"), left("M", 50_000, "Chongqing")];
    const priced = installTiming({ ...base, later: { left: dear, work } });
    expect(priced.candidates).toEqual([
      { k: 0, tauMs: 0, estimateMs: 124 * MINUTE, cyclesMs: [124 * MINUTE] },
      { k: 1, tauMs: 20 * MINUTE, estimateMs: 124 * MINUTE, cyclesMs: [104 * MINUTE] },
    ]);
    expect(priced.choice).toBe(0);
    const sooner = { ...base, next: [{ tauMs: 19 * MINUTE, augmentation: "N" }] };
    expect(installTiming({ ...sooner, later: { left: dear, work } }).choice).toBe(1);
    expect(installTiming(sooner).choice).toBe(0);
    // Unpriced (no R measured): as before #389, no `cyclesMs` and no `work`.
    expect(installTiming({ ...base, later: { left: dear, work: null } })).toEqual(installTiming(base));
  });

});

/**
 * BN4.2's choices c2-c9 (#389's bar, the coordinator's decision on #389): at each, install now's estimate before #389
 * (this cycle's shape) and priced from the countables left along the level's path (#401), against the time online from
 * the choice to the count met, and the planner's choice under each. From `m4/predaedalus` (the read-only store copy of
 * 2026-11-12): the trail's N, T and the next countables' τ (`cycles2-BN4.2.txt`'s install timing lines, the level now,
 * flat: the same τ in both columns, so the pricing alone differs), each cycle's set, NeuroFlux Governor's levels, joined
 * factions, first work (R), end rate and ramp from #401's fixture (`bn4-2-fixture.ts`).
 */
const CHOICES: {
  index: number;
  T: number;
  next: [string, number][];
  actual: number;
}[] = [
  {
    index: 1,
    T: 37,
    next: [
      ["Embedded Netburner Module", 60],
      ["Magnetism Amplifier", 132],
      ["Cranial Signal Processors - Gen II", 148],
    ],
    actual: 325,
  },
  {
    index: 2,
    T: 66,
    next: [
      ["Magnetism Amplifier", 45],
      ["CRTX42-AA Gene Modification", 110],
      ["Cranial Signal Processors - Gen III", 123],
    ],
    actual: 257,
  },
  {
    index: 3,
    T: 36,
    next: [
      ["CRTX42-AA Gene Modification", 69],
      ["Nanofiber Weave", 140],
      ["Neuralstimulator", 217],
    ],
    actual: 220,
  },
  {
    index: 4,
    T: 65,
    next: [
      ["Nanofiber Weave", 60],
      ["Neuregen Gene Modification", 131],
      ["Neuralstimulator", 207],
    ],
    actual: 153,
  },
  {
    index: 5,
    T: 23,
    next: [
      ["Nanofiber Weave", 54],
      ["Neuralstimulator", 119],
      ["Neuroreceptor Management Implant", 174],
    ],
    actual: 128,
  },
  {
    index: 6,
    T: 31,
    next: [
      ["Nanofiber Weave", 49],
      ["Neuralstimulator", 99],
    ],
    actual: 96,
  },
  { index: 7, T: 44, next: [["Neuroreceptor Management Implant", 46]], actual: 50 },
];

/** Choice `index`'s two timings: before #389, and priced along the level's path, as the brain would take them. */
function hindcastAt({ index, T, next }: (typeof CHOICES)[number]) {
  const cycle = BN4_2[index] as Cycle;
  const installedBefore = [...BN4_2.slice(0, index).flatMap((each) => each.bought), NEUROFLUX];
  const state: AugmentationPurchaseState = {
    ...STATE,
    installed: Object.fromEntries(installedBefore.map((name) => [name, 1])),
    bitNodeMultipliers: augmentationBitNodeMultipliers(4, { 4: 1 }),
  };
  const needed = 30 - installedBefore.length;
  const joined = Object.keys(cycle.earned);
  const base = {
    needed,
    adding: cycle.bought.length,
    onlineMs: T * MINUTE,
    next: next.map(([augmentation, minutes]) => ({ augmentation, tauMs: minutes * MINUTE })),
  };
  // The work's rate at a faction: the game's hacking work at the level, this cycle's faction_rep (the installs' own
  // applied by core), the faction's favour after this install where it's joined (`favorAfterInstall`), none where it
  // isn't (the brain reads only the joined), and this cycle's measured factor in the share's place (#401's hindcast).
  const before = (faction: string) =>
    BN4_2.slice(0, index).reduce((sum, each) => sum + (each.earned[faction] ?? 0), 0);
  const favorOf = (faction: string) =>
    joined.includes(faction) ? favorAfterInstall(repToFavor(before(faction)), cycle.earned[faction] ?? 0) : 0;
  const factor = measuredFactor(index);
  const rateAt = (faction: string, level: number) =>
    factionReputationPerSecond(
      {
        skills: { hacking: level, strength: 1, defense: 1, dexterity: 1, agility: 1, charisma: 1, intelligence: 0 },
        mults: { faction_rep: multipliers[index]?.factionRep ?? 1 },
      },
      "hacking",
      {
        favor: favorOf(faction),
        sourceFile15Level: 0,
        focused: true,
        implant: false,
        factionWorkRepGain: BN4_FACTION_WORK_REP_GAIN,
        shareBonus: factor,
      },
    );
  const later: LaterCycles = {
    left: countablesLeft({ factions: [...joined, ...LATER_CYCLE_FACTIONS], bitNode: 4, state, set: cycle.bought }),
    rebuildMs: cycle.firstWork * MINUTE,
    rise: endRise(index),
    deadSeconds: deadFor(index + 1).minutes * 60,
    rateAt,
    installing: [...cycle.bought, ...Array.from({ length: cycle.neuroFlux }, () => NEUROFLUX)],
  };
  // Exploration: the later cycles grouped by a partition of the cheapest first that minimises the total (a DP).
  const dp = (count: number, left: typeof later.left, installing: readonly string[]) => {
    const best: number[] = [0];
    for (let j = 1; j <= count; j++) {
      best[j] = Number.POSITIVE_INFINITY;
      for (let i = 0; i < j; i++) {
        const group = laterCyclesMs({
          count: j - i,
          perCycle: j - i,
          shapeMs: Number.POSITIVE_INFINITY,
          later: { ...later, left: left.slice(i, j), installing: [...installing, ...left.slice(0, i).map((x) => x.augmentation)] },
        });
        best[j] = Math.min(best[j] as number, (best[i] as number) + (group[0] as number));
      }
    }
    return best[count] as number;
  };
  const n = cycle.bought.length;
  const options = [[0, dp(needed - n, later.left, later.installing)]];
  for (const [k] of next.entries()) {
    const names = next.slice(0, k + 1).map(([name]) => name);
    const tau = (next[k]?.[1] ?? 0) * MINUTE;
    const rest = needed - n - (k + 1);
    options.push([k + 1, tau + (rest <= 0 ? 0 : dp(rest, later.left.filter((x) => !names.includes(x.augmentation)), [...later.installing, ...names]))]);
  }
  const least = options.reduce((a, b) => ((b[1] as number) < (a[1] as number) ? b : a));
  console.log(`c${index + 1} DP: ${options.map(([k, ms]) => `k${k} ${((ms as number) / MINUTE).toFixed(1)}`).join(", ")}; choice ${least[0]}`);
  return { before389: installTiming(base), priced: installTiming({ ...base, later }) };
}

describe("BN4.2's choices c2-c9 hindcast (#389): install now along the level's path, and the planner's choice", () => {
  test("every row, before #389 and priced, against the actual", () => {
    const rows = CHOICES.map((choice) => {
      const { before389, priced } = hindcastAt(choice);
      const now = (timing: InstallTiming) => (timing.candidates.find((each) => each.k === 0)?.estimateMs ?? 0) / MINUTE;
      const chosen = (timing: InstallTiming) => timing.candidates.find((each) => each.k === timing.choice);
      return {
        cycle: `c${choice.index + 1}`,
        actual: choice.actual,
        before: { now: now(before389), choice: before389.choice, chosenMs: (chosen(before389)?.estimateMs ?? 0) / MINUTE },
        priced: { now: now(priced), choice: priced.choice, chosenMs: (chosen(priced)?.estimateMs ?? 0) / MINUTE },
        candidates: priced.candidates.map((each) => [each.k, Math.round(each.estimateMs / MINUTE)]),
      };
    });
    console.log(
      rows
        .map(
          (row) =>
            `${row.cycle} actual ${row.actual}: before #389 install now ${row.before.now.toFixed(1)} ` +
            `(${(row.before.now / row.actual).toFixed(2)}), choice ${row.before.choice}; priced install now ` +
            `${row.priced.now.toFixed(1)} (${(row.priced.now / row.actual).toFixed(2)}), choice ${row.priced.choice} ` +
            `(${row.priced.chosenMs.toFixed(1)}) [${row.candidates.map(([k, ms]) => `k${k} ${ms}`).join(", ")}]`,
        )
        .join("\n"),
    );
  });
});
