// Install timing (#343): the estimates' cases, the choice, and the next countables' times, with golden cases from the
// store's tables (#343: BN1.2 to BN4.1, read to 2026-11-10 23:53).
import { describe, expect, test } from "vitest";
import { type AugmentationSet, installRule } from "../src/augmentation-plan.ts";
import type { CountableWithMoney } from "../src/augmentation-reach.ts";
import { type AugmentationPurchaseState, purchaseSequenceCost } from "../src/augmentations.ts";
import { installNowEstimateMs, installTiming, nextCountables, waitEstimateMs } from "../src/install-timing.ts";

const MINUTE = 60_000;
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
