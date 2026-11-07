/**
 * The batches' use of their hosts (#294's item 5), for #242's share: from the state, by core's own batch maths, not
 * by the cycle's index. The brain's batcher (packages/brain/src/batcher.ts) runs on the hack loop's hosts (the rooted
 * world servers and the cloud servers) and plans with core's `batchPlan` (#204) on the target worth most; the share
 * fills what it leaves, up to core's `SHARE_MOST_USE`. A plan's RAM is bounded by its target's money as well as by the
 * RAM (#275): at most a batch of `MAX_BATCH_SHARE` every `MIN_BATCH_SPACING_MS`, which needs less RAM as the level and
 * the hacking speed shorten the operations and a thread takes more of the money. So the batches fill the hosts in the
 * early cycles and leave most of them at a high level: core's plan gives 99% to 100% at run #3's 4th cycle (its one
 * reading, 82%: both past 80%, so the hosts share nothing) and 12% to 16% at hacking 4,000 to 5,000 at the model's
 * Daedalus cycle's multipliers (BN1.3's 9th left about 10%). Nothing fitted: the targets are the game's
 * (`BATCH_TARGETS`), the maths core's.
 */
import {
  batchHoldsMs,
  batchIncomeMostPerSecond,
  batchPeakRamGb,
  batchRamGb,
  batchThreads,
  type HackingPlayer,
  type HackingTarget,
  hackSharePerThread,
  MAX_BATCH_SHARE,
  MIN_BATCH_SPACING_MS,
} from "@bitburner-agent/core";

/**
 * BN1's servers with money, as the batcher's targets: [hostname, ports, `moneyMax`, `hackDifficulty`,
 * `requiredHackingSkill`, `serverGrowth`] (`Server/data/servers.ts`; `Server.ts:76` makes the money 25 times the
 * starting money; `:83` the minimum security a third of the security). A range's mean where the game draws one per
 * save (`ServerHelpers.ts:350-353`). The game's; a test recomputes it.
 */
export const BATCH_TARGETS: readonly (readonly [string, number, number, number, number, number])[] = [
  ["ecorp", 5, 1.25e12, 99, 1225, 99],
  ["megacorp", 5, 1.25e12, 99, 1225, 99],
  ["b-and-a", 5, 5.625e11, 80, 1025, 70],
  ["blade", 5, 6.25e11, 92.5, 1050, 70],
  ["nwo", 5, 7.5e11, 99, 1125, 80],
  ["clarkinc", 5, 5e11, 55, 1100, 60],
  ["omnitek", 5, 4.375e11, 94.5, 1000, 97],
  ["4sigma", 5, 5e11, 65, 1075, 87],
  ["kuai-gong", 5, 6.25e11, 97, 1125, 94.5],
  ["fulcrumtech", 5, 4e10, 90, 1100, 89.5],
  ["fulcrumassets", 5, 2.5e7, 99, 1350, 1],
  ["stormtech", 5, 2.75e10, 85, 975, 80],
  ["defcomm", 5, 2.1875e10, 90, 950, 60],
  ["infocomm", 5, 1.875e10, 80, 912.5, 55],
  ["helios", 5, 1.625e10, 90, 850, 75],
  ["vitalife", 5, 1.875e10, 85, 837.5, 70],
  ["icarus", 5, 2.375e10, 90, 887.5, 90],
  ["univ-energy", 4, 2.875e10, 85, 850, 85],
  ["titan-labs", 5, 2.0625e10, 75, 837.5, 70],
  ["microdyne", 5, 1.5e10, 70, 837.5, 80],
  ["taiyang-digital", 5, 2.125e10, 75, 900, 75],
  ["galactic-cyber", 5, 2e10, 60, 850, 80],
  ["aerocorp", 5, 2.75e10, 85, 887.5, 60],
  ["omnia", 5, 2.375e10, 90, 900, 65],
  ["zb-def", 4, 2.5e10, 60, 800, 70],
  ["applied-energetics", 4, 2.125e10, 70, 812.5, 72.5],
  ["solaris", 5, 2e10, 75, 800, 75],
  ["deltaone", 5, 3.75e10, 80, 850, 60],
  ["global-pharm", 4, 4.0625e10, 80, 800, 85],
  ["nova-med", 4, 2.9375e10, 70, 812.5, 75],
  ["zeus-med", 5, 3.5e10, 80, 825, 75],
  ["unitalife", 4, 2.625e10, 75, 800, 75],
  ["lexo-corp", 4, 1.875e10, 70, 700, 60],
  ["rho-construction", 3, 1.5e10, 50, 500, 50],
  ["alpha-ent", 4, 1.6875e10, 60, 550, 55],
  ["aevum-police", 4, 7.5e9, 75, 425, 40],
  ["rothman-uni", 3, 5.3125e9, 50, 400, 40],
  ["zb-institute", 5, 2.375e10, 75, 750, 80],
  ["summit-uni", 3, 6.875e9, 55, 450, 50],
  ["syscore", 4, 1.25e10, 70, 600, 65],
  ["catalyst", 3, 1.0625e10, 65, 425, 40],
  ["the-hub", 2, 4.375e9, 40, 300, 50],
  ["computek", 3, 5.875e9, 60, 350, 55],
  ["netlink", 3, 6.875e9, 70, 400, 60],
  ["johnson-ortho", 2, 1.9375e9, 50, 275, 50],
  ["n00dles", 0, 1.75e6, 1, 1, 3000],
  ["foodnstuff", 0, 5e7, 10, 1, 5],
  ["sigma-cosmetics", 0, 5.75e7, 10, 5, 10],
  ["joesguns", 0, 6.25e7, 15, 10, 20],
  ["zer0", 1, 1.875e8, 25, 75, 40],
  ["nectar-net", 0, 6.875e7, 20, 20, 25],
  ["neo-net", 1, 1.25e8, 25, 50, 25],
  ["silver-helix", 2, 1.125e9, 30, 150, 30],
  ["hong-fang-tea", 0, 7.5e7, 15, 30, 20],
  ["harakiri-sushi", 0, 1e8, 15, 40, 40],
  ["phantasy", 2, 6e8, 20, 100, 35],
  ["max-hardware", 1, 2.5e8, 15, 80, 30],
  ["omega-net", 2, 1.625e9, 30, 200, 35],
  ["crush-fitness", 2, 1.25e9, 40, 250, 30],
  ["iron-gym", 1, 5e8, 30, 100, 20],
  ["millenium-fitness", 3, 6.25e9, 50, 500, 35],
  ["powerhouse-fitness", 5, 2.25e10, 60, 1025, 55],
  ["snap-fitness", 4, 1.125e10, 50, 737.5, 50],
];

const TARGETS: readonly (HackingTarget & { ports: number })[] = BATCH_TARGETS.map(
  ([, ports, moneyMax, hackDifficulty, requiredHackingSkill, serverGrowth]) => ({
    ports,
    moneyMax,
    minDifficulty: Math.min(Math.max(1, Math.round(hackDifficulty / 3)), 100),
    requiredHackingSkill,
    serverGrowth,
  }),
);

/** What the batches' RAM is worked out from: the player's level and hacking multipliers, and the ports open. */
export interface BatchesState {
  hacking: number;
  mults: HackingPlayer["mults"];
  ports: number;
}

/**
 * The most RAM the batches hold, GB (#294): on the target the most a batcher can earn from (`batchIncomeMostPerSecond`)
 * among those the level and the ports reach, core's plan at that most (`MAX_BATCH_SHARE` a batch, or one hack thread's
 * where that's more, every `MIN_BATCH_SPACING_MS`), at its peak (`batchPeakRamGb`). Infinity with nothing to hack. The
 * batcher's target is the one worth most counting its preparation (`chooseBatcher`); left out, as is the next target
 * prepared beside the batches.
 */
export function batchesPeakGbOf({ hacking, mults, ports }: BatchesState): number {
  const player: HackingPlayer = { skills: { hacking, intelligence: 0 }, mults };
  let best: HackingTarget | null = null;
  let bestIncome = 0;
  for (const target of TARGETS) {
    if (target.requiredHackingSkill > hacking || target.ports > ports) continue;
    const income = batchIncomeMostPerSecond(target, player);
    if (income > bestIncome) {
      best = target;
      bestIncome = income;
    }
  }
  if (best === null) return Number.POSITIVE_INFINITY;
  const perThread = hackSharePerThread(best, player);
  const hackCount = Math.max(1, Math.floor(MAX_BATCH_SHARE / perThread));
  const threads = batchThreads(best, player, hackCount);
  return batchPeakRamGb(threads, batchHoldsMs(best, player, threads), MIN_BATCH_SPACING_MS);
}

/**
 * The batches' use of their hosts' RAM (`hostsGb`, the rooted world servers and the cloud servers), 0 to 1, from
 * their most (`peakGb`, `batchesPeakGbOf`) times `factor` (`Calibration.batchesUseFactor`): at most all of it (with
 * less, core's `batchPlan` fills it); all of it with no RAM a batch can use.
 */
export function batchesUseFromPeak(peakGb: number, hostsGb: number, factor = 1): number {
  if (!(batchRamGb([hostsGb]) > 0)) return 1;
  return Math.min(1, (factor * peakGb) / hostsGb);
}

/** The batches' use of their hosts' RAM in `state` (#294): `batchesUseFromPeak` on `batchesPeakGbOf`. */
export function batchesUseOf(state: BatchesState & { hostsGb: number }, factor = 1): number {
  return batchesUseFromPeak(batchesPeakGbOf(state), state.hostsGb, factor);
}
