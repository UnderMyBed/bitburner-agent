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
import { favorAfterInstall, repToFavor } from "../src/donations.ts";
import { factionReputationPerSecond } from "../src/faction-work.ts";
import {
  type CountableLeft,
  countablesLeft,
  factionRepGain,
  type InstallTiming,
  installNowEstimateMs,
  installTiming,
  LATER_CYCLE_FACTIONS,
  type LaterCycles,
  laterCyclesMs,
  meanRelativeError,
  nextCountables,
  reputationOneFactionAtATime,
  tauRelativeError,
  waitEstimateMs,
} from "../src/install-timing.ts";
import type { LevelRise } from "../src/level-rise.ts";
import { levellingInstallMultipliers } from "../src/levelling.ts";
import {
  BN4_2,
  BN4_FACTION_WORK_REP_GAIN,
  type Cycle,
  deadFor,
  endRise,
  measuredFactor,
  multipliers,
} from "./bn4-2-fixture.ts";

const MINUTE = 60_000;
const sum = (values: readonly number[]) => values.reduce((total, each) => total + each, 0);
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
      tauError: 0,
      kept: null,
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

  test("the set meeting the count installs; a tie goes to the wait (#406), then to the fewer to wait for", () => {
    expect(installTiming({ needed: 3, adding: 3, onlineMs: MINUTE, next: [{ tauMs: 0 }] }).choice).toBe(0);
    // 2 to go, 1 a cycle of 10 minutes: install now 10; the next at 10 minutes, 10 too. Installing, irreversible, only
    // when it's less: a tie waits (the next reading decides again).
    expect(
      installTiming({ needed: 2, adding: 1, onlineMs: 10 * MINUTE, next: [{ tauMs: 10 * MINUTE }] }),
    ).toMatchObject({
      choice: 1,
      kept: "margin",
    });
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

describe("the margin (#406): installing only by more than the error, a choice kept within it", () => {
  test("a rate's relative error: the samples' standard deviation over √n, over their mean; none with one", () => {
    expect(meanRelativeError([])).toBeNull();
    expect(meanRelativeError([1.6])).toBeNull();
    expect(meanRelativeError([0, 0])).toBeNull();
    // 1, 2, 3: mean 2, standard deviation 1, over √3: 0.2887.
    expect(meanRelativeError([1, 2, 3])).toBeCloseTo(1 / Math.sqrt(3) / 2, 12);
    expect(meanRelativeError([1.6, 1.6, 1.6])).toBeCloseTo(0, 12);
    // τ's: the share's and κ's in quadrature; none measured, 0.
    expect(tauRelativeError(0.03, 0.04)).toBeCloseTo(0.05, 12);
    expect(tauRelativeError(null, 0.04)).toBeCloseTo(0.04, 12);
    expect(tauRelativeError(null, null)).toBe(0);
  });

  // 9 to go, 4 new, T 59: install now 2T = 118; waiting for 1 at τ, τ + T + τ.
  const at59 = (tauMinutes: number, fields: Partial<Parameters<typeof installTiming>[0]> = {}) =>
    installTiming({ needed: 9, adding: 4, onlineMs: 59 * MINUTE, next: [{ tauMs: tauMinutes * MINUTE }], ...fields });

  test("a near tie within the wait's τ's error waits; a clear win installs", () => {
    // τ 29.4: the wait 117.8 against 118, install now by 0.2 min: a win with no error measured, within 10% of τ's.
    expect(at59(29.6)).toMatchObject({ choice: 0, kept: null });
    expect(at59(29.4)).toMatchObject({ choice: 1, kept: null });
    expect(at59(29.6, { tauError: 0.1 })).toMatchObject({ choice: 1, kept: "margin", tauError: 0.1 });
    // τ 33: the wait 125 against 118, install now by 7 min, more than 10% of 33's 3.3: install.
    expect(at59(33, { tauError: 0.1 })).toMatchObject({ choice: 0, kept: null });
    // The edge: install now wins by 2τ − 59, the margin 0.1τ: τ 31.05. Under it, the wait; over it, install.
    expect(at59(31, { tauError: 0.1 })).toMatchObject({ choice: 1, kept: "margin" });
    expect(at59(31.2, { tauError: 0.1 })).toMatchObject({ choice: 0, kept: null });
  });

  test("a held choice doesn't flap within the error: a rival beating it by less is passed over; by more, taken", () => {
    const next = [{ tauMs: 20 * MINUTE }, { tauMs: 26 * MINUTE }];
    // 9 to go, 4 new, T 59: wait for 1, 20 + (59 + 20) = 99; for 2, 26 + (59 + 26) = 111; install now 118.
    const base = { needed: 9, adding: 4, onlineMs: 59 * MINUTE, next };
    const free = installTiming(base);
    const [, one, two] = free.candidates;
    expect(free.choice).toBe((one?.estimateMs as number) <= (two?.estimateMs as number) ? 1 : 2);
    // Held at the other (wait for 2): kept while the least beats it by less than the error of the larger τ, 26 min's.
    const other = free.choice === 1 ? 2 : 1;
    const gap = Math.abs((one?.estimateMs as number) - (two?.estimateMs as number)) / MINUTE;
    const within = installTiming({ ...base, held: other, tauError: (gap + 0.1) / 26 });
    expect(within).toMatchObject({ choice: other, kept: "held" });
    const beyond = installTiming({ ...base, held: other, tauError: (gap - 0.1) / 26 });
    expect(beyond).toMatchObject({ choice: free.choice, kept: null });
    // Held, and install now beats it by more than its τ's error: install; within it: kept.
    expect(at59(40, { held: 1, tauError: 0.1 })).toMatchObject({ choice: 0, kept: null });
    expect(at59(30.5, { held: 1, tauError: 0.1 })).toMatchObject({ choice: 1, kept: "margin" });
    // The set meeting the count installs whatever was held.
    expect(installTiming({ needed: 4, adding: 4, onlineMs: MINUTE, next: [{ tauMs: MINUTE }], held: 1 }).choice).toBe(
      0,
    );
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
  const left_ = (augmentation: string, reputation: number, ...sellers: string[]): CountableLeft => ({
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
    expect(reputationOneFactionAtATime([left_("D", 15_000, "Volhaven"), left_("C", 18_750, "Volhaven")])).toBe(18_750);
    expect(reputationOneFactionAtATime([left_("N", 37_500, "Tian Di Hui"), left_("G", 37_500, "Chongqing")])).toBe(
      75_000,
    );
    // Neuralstimulator at Chongqing, which sells the other too: one faction's work serves both.
    expect(
      reputationOneFactionAtATime([left_("S", 50_000, "The Black Hand", "Chongqing"), left_("G", 37_500, "Chongqing")]),
    ).toBe(50_000);
    // The dearest first: a cheaper one at a faction already worked for adds nothing; one with no seller, nothing.
    expect(
      reputationOneFactionAtATime([left_("A", 5_000, "Volhaven"), left_("B", 20_000, "Volhaven"), left_("X", 9)]),
    ).toBe(20_000);
  });

  /** Countables with no hacking, hacking_exp, hacking_speed or faction_rep multiplier: they leave the rate as it is. */
  const [WIRED, RIB, DERMA, SPEECH, TARGETING] = [
    "Wired Reflexes",
    "Combat Rib I",
    "DermaForce Particle Barrier",
    "Speech Enhancement",
    "Augmented Targeting I",
  ];
  test("the plain countables leave the rate as it is", () => {
    const plain = [WIRED, RIB, DERMA, SPEECH, TARGETING];
    expect(levellingInstallMultipliers(0, plain)).toEqual({ hacking: 1, hackingExp: 1, hackingSpeed: 1 });
    expect(factionRepGain(plain)).toBe(1);
  });
  /** A path that rises (so the later cycles price), and a rate that doesn't depend on the level: each cycle R + W / c. */
  const RISING: LevelRise = { exp: 0, level: 100, levelMult: 1, kappa: 1 };
  /** 10,000 reputation in 20 minutes. */
  const PER_SECOND = 10_000 / (20 * 60);
  const priced = (left: CountableLeft[], fields: Partial<LaterCycles> = {}): LaterCycles => ({
    left,
    rebuildMs: 4 * MINUTE,
    rise: RISING,
    deadSeconds: 0,
    rateAt: () => PER_SECOND,
    installing: [],
    ...fields,
  });

  test("unpriced (no R, no rise, κ 0): ⌈count / perCycle⌉ cycles of this one's shape, as before #389", () => {
    const left = [left_(WIRED, 10_000, "F")];
    for (const unpriced of [
      priced(left, { rebuildMs: null }),
      priced(left, { rise: null }),
      priced(left, { rise: { ...RISING, kappa: 0 } }),
      priced(left, { rise: { ...RISING, levelMult: 0 } }),
      undefined,
    ]) {
      expect(laterCyclesMs({ count: 5, perCycle: 2, shapeMs: 30 * MINUTE, later: unpriced })).toEqual([
        30 * MINUTE,
        30 * MINUTE,
        30 * MINUTE,
      ]);
    }
    expect(laterCyclesMs({ count: 0, perCycle: 2, shapeMs: MINUTE, later: priced(left) })).toEqual([]);
  });

  test("priced: R and each faction's work in turn; split to the least total, here one cycle (a split adds an R)", () => {
    // 20,000 at F (A's 10,000 served by C's) and 10,000 at G: 4 + 40 + 20 min in one cycle.
    const left = [left_(WIRED, 10_000, "F"), left_(RIB, 10_000, "G"), left_(DERMA, 20_000, "F")];
    const cycles = laterCyclesMs({ count: 3, perCycle: 1, shapeMs: MINUTE, later: priced(left) });
    expect(cycles.map((ms) => ms / MINUTE)).toEqual([expect.closeTo(64, 6)]);
    // Past the countables known: the 3 priced, then ⌈2 / 2⌉ cycle of the last priced one's length.
    expect(
      laterCyclesMs({ count: 5, perCycle: 2, shapeMs: MINUTE, later: priced(left) }).map((ms) => ms / MINUTE),
    ).toEqual([expect.closeTo(64, 6), expect.closeTo(64, 6)]);
  });

  test("the recurrence is the least over every split of the cheapest first (BN4.2's c4, 8 left: all 128 splits)", () => {
    const { later, count } = hindcastAt(CHOICES[2] as (typeof CHOICES)[number]);
    expect(count).toBe(8);
    const cycleOf = (from: number, to: number) =>
      laterCyclesMs({
        count: to - from,
        perCycle: to - from,
        shapeMs: Number.NaN,
        later: {
          ...later,
          left: later.left.slice(from, to),
          installing: [...later.installing, ...later.left.slice(0, from).map((each) => each.augmentation)],
        },
      });
    let least = Number.POSITIVE_INFINITY;
    for (let mask = 0; mask < 2 ** (count - 1); mask++) {
      let total = 0;
      let from = 0;
      for (let to = 1; to <= count; to++) {
        if (to === count || (mask & (1 << (to - 1))) !== 0) {
          // One cycle alone: its own least is itself, the same cycle as the recurrence prices.
          total += sum(cycleOf(from, to));
          from = to;
        }
      }
      least = Math.min(least, total);
    }
    const cycles = laterCyclesMs({ count, perCycle: 1, shapeMs: Number.NaN, later });
    expect(sum(cycles)).toBeCloseTo(least, 3);
    expect(cycles.length).toBeGreaterThan(1);
  });

  test("dearer countables left: install now's estimate rises, and the choice moves from install to wait", () => {
    // 4 to go, 2 new: before #389, install now T 24, wait for 1 at 20 min 20 + 44 = 64. Install.
    const base = { needed: 4, adding: 2, onlineMs: 24 * MINUTE, next: [{ tauMs: 20 * MINUTE, augmentation: SPEECH }] };
    expect(installTiming(base)).toMatchObject({
      candidates: [{ estimateMs: 24 * MINUTE }, { estimateMs: 64 * MINUTE }],
      choice: 0,
    });
    // Left cheap (10,000 each at Tian Di Hui): install now's next cycle 4 + 20 = 24 min; the wait's, M alone, 24 after
    // 20. Install.
    const cheap = [left_(SPEECH, 10_000, "Tian Di Hui"), left_(TARGETING, 10_000, "Tian Di Hui")];
    expect(installTiming({ ...base, later: priced(cheap) })).toMatchObject({
      candidates: [
        { k: 0, estimateMs: expect.closeTo(24 * MINUTE, 3), cyclesMs: [expect.closeTo(24 * MINUTE, 3)] },
        { k: 1, estimateMs: expect.closeTo(44 * MINUTE, 3), cyclesMs: [expect.closeTo(24 * MINUTE, 3)] },
      ],
      choice: 0,
      later: { rebuildMs: 4 * MINUTE, deadSeconds: 0, kappa: 1 },
    });
    // Left dearer, M 50,000 at Chongqing: install now's next cycle (N and M, two factions) 4 + 20 + 100 = 124 min; the
    // wait's, M alone, 104 after 20. A tie, to the wait (#406); before #389 (24 against 64), install.
    const dear = [left_(SPEECH, 10_000, "Tian Di Hui"), left_(TARGETING, 50_000, "Chongqing")];
    const dearTiming = installTiming({ ...base, later: priced(dear) });
    expect(dearTiming.candidates.map((each) => [each.k, Math.round(each.estimateMs / MINUTE)])).toEqual([
      [0, 124],
      [1, 124],
    ]);
    expect(dearTiming.choice).toBe(1);
    expect(installTiming(base).choice).toBe(0);
    // A minute more of τ: install now, by a minute.
    const later = { ...base, next: [{ tauMs: 21 * MINUTE, augmentation: SPEECH }] };
    expect(installTiming({ ...later, later: priced(dear) }).choice).toBe(0);
    // Unpriced (no R measured): as before #389, no `cyclesMs` and no `later`.
    expect(installTiming({ ...base, later: priced(dear, { rebuildMs: null }) })).toEqual(installTiming(base));
  });

  test("the installs' multipliers raise the later cycles' rate: faction_rep times the rate, hacking and its exp the level", () => {
    expect(factionRepGain(["Social Negotiation Assistant (S.N.A)", "NeuroFlux Governor", "Nonesuch"])).toBeCloseTo(
      1.15 * 1.01,
      2,
    );
    // A rate of the level: installing S.N.A (faction_rep 1.15) before a cycle makes it 1.15 times faster after R.
    const level = (_: string, at: number) => at / 100;
    const one = [left_(WIRED, 10_000, "F")];
    const plain = laterCyclesMs({ count: 1, perCycle: 1, shapeMs: 0, later: priced(one, { rateAt: level }) });
    const faster = laterCyclesMs({
      count: 1,
      perCycle: 1,
      shapeMs: 0,
      later: priced(one, { rateAt: level, installing: ["Social Negotiation Assistant (S.N.A)"] }),
    });
    expect((faster[0] as number) < (plain[0] as number)).toBe(true);
    // A hacking multiplier (Cranial Signal Processors - Gen II, 1.07) raises the level along the path: faster again.
    const hacking = laterCyclesMs({
      count: 1,
      perCycle: 1,
      shapeMs: 0,
      later: priced(one, { rateAt: level, installing: ["Cranial Signal Processors - Gen II"] }),
    });
    expect((hacking[0] as number) < (plain[0] as number)).toBe(true);
    // The dead time holds the level flat first: slower.
    const dead = laterCyclesMs({
      count: 1,
      perCycle: 1,
      shapeMs: 0,
      later: priced(one, { rateAt: level, deadSeconds: 600 }),
    });
    expect((dead[0] as number) > (plain[0] as number)).toBe(true);
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
  const before = (faction: string) => BN4_2.slice(0, index).reduce((sum, each) => sum + (each.earned[faction] ?? 0), 0);
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
  return {
    before389: installTiming(base),
    priced: installTiming({ ...base, later }),
    later,
    count: needed - cycle.bought.length,
  };
}

describe("BN4.2's choices c2-c8 hindcast (#389): install now along the level's path, and the planner's choice", () => {
  /**
   * Each choice: before #389 (this cycle's shape) and priced (the countables left split to the least total, along the
   * level's path: c2 on, a κ carried over an install, so the DP prices), install now's estimate over the actual and the
   * k chosen, under #406's margin (installing only by more than the best wait's τ error; the evidence holds no rate
   * series for its error, so 0: a tie waits). Within ×2 every one priced (before, c6 and c7 aren't: 0.36, 0.32). The
   * choice is the same as main's at c2 and c4-c7. Two differ (the coordinator's decisions on #389 and #406):
   * - c3 waits for 3 (Cranial Signal Processors - Gen III's 123 min), 266 against install now's 275: about 20 min worse
   *   in hindsight (24 installed at +123 waiting, at +103 installing), right in expectation.
   * - c8 waits for the last (Neuroreceptor Management Implant, 46 min) against install now's 47: about 4 min better
   *   (the count at +46, installing's at +50).
   */
  const ROWS: [cycle: string, actual: number, before: number, beforeK: number, priced: number, pricedK: number][] = [
    ["c2", 325, 481, 0, 435.3, 0],
    ["c3", 257, 198, 0, 275.0, 3],
    ["c4", 220, 288, 0, 266.0, 0],
    ["c5", 153, 195, 0, 101.9, 0],
    ["c6", 128, 46, 0, 98.4, 0],
    ["c7", 96, 31, 0, 72.7, 0],
    ["c8", 50, 44, 0, 47.2, 1],
  ];

  test("every row, before #389 and priced, against the actual; the choices", () => {
    const now = (timing: InstallTiming) => (timing.candidates.find((each) => each.k === 0)?.estimateMs ?? 0) / MINUTE;
    const rows = CHOICES.map((choice) => {
      const { before389, priced } = hindcastAt(choice);
      return [
        `c${choice.index + 1}`,
        choice.actual,
        Math.round(now(before389)),
        before389.choice,
        Number(now(priced).toFixed(1)),
        priced.choice,
      ];
    });
    expect(rows).toEqual(
      ROWS.map(([cycle, actual, before, beforeK, , pricedK]) => [
        cycle,
        actual,
        before,
        beforeK,
        expect.any(Number),
        pricedK,
      ]),
    );
    for (const [index, row] of rows.entries()) {
      const [, actual, , , priced] = row as [string, number, number, number, number, number];
      expect(priced).toBeCloseTo((ROWS[index] as (typeof ROWS)[number])[4], 0);
      expect(priced / actual).toBeGreaterThan(0.5);
      expect(priced / actual).toBeLessThan(2);
    }
    // Before #389, 5 of 7 within ×2; priced, 7 of 7.
    const within = (ratio: number) => ratio > 0.5 && ratio < 2;
    expect(ROWS.filter(([, actual, before]) => within(before / actual))).toHaveLength(5);
    expect(ROWS.filter(([, actual, , , priced]) => within(priced / actual))).toHaveLength(7);
  });

  test("its cost a reading: c2's (13 left, 3 waits) under a tenth of a second", () => {
    const start = performance.now();
    hindcastAt(CHOICES[0] as (typeof CHOICES)[number]);
    expect(performance.now() - start).toBeLessThan(100);
  });
});
