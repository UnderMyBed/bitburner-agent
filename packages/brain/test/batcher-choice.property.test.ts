// Property test (#274): the batcher's choice of target never leaves a better target without a path to it. In BN1.3's
// exit run the batcher sat on n00dles for about 5 hours at hacking 1,300 to 1,700, with targets 40,000 times richer
// rooted: none of the 5 best by A1's ceiling could be moved to (none prepared) or be the next (a weaken at their
// security after the install was past the 15-minute horizon), and the mid targets that could were never weighed. Over
// random shapes (the player's level and speed, the targets' figures, money and security, the hosts' RAM), with
// n00dles batched: whenever a target is worth a path from the one batched (a move's worth once prepared, one the move
// can reach, and preparable within `BATCHER_NEXT_HORIZON_MS` on the next's RAM), the brain moves or sends a next; each
// next is one it can move to; and following its choices (each next prepared, then moved to), it comes to rest within a
// bounded number of choices where no target is worth a path. The example tests are batcher.test.ts's.
import {
  type HackingPlayer,
  type HackingTarget,
  type MediumSnapshotData,
  operationTimeMs,
  preparationTimeMs,
  type StaticSnapshotData,
} from "@bitburner-agent/core";
import fc from "fast-check";
import { expect, test } from "vitest";
import {
  BATCHER_MOST_IDLE_MS,
  BATCHER_MOVE_GAIN,
  BATCHER_NEXT_HORIZON_MS,
  BATCHER_NEXT_RAM_SHARE,
  BATCHER_TARGET_HORIZON_MS,
  chooseBatcher,
  planBatcher,
} from "../src/batcher.ts";

const N00DLES = { moneyMax: 1_750_000, minDifficulty: 1, requiredHackingSkill: 1, serverGrowth: 3_000 };

interface Target {
  hostname: string;
  figures: HackingTarget;
  /** Its security, as a multiple of its minimum, and its money, as a share of its maximum. */
  securityTimes: number;
  moneyShare: number;
}
interface Shape {
  player: HackingPlayer;
  targets: Target[];
  hostsRam: number[];
}

/** A target: its hacking level a share of the player's, BN1's span of minimum security, money and growth. */
const anyTarget = (index: number, hacking: number) =>
  fc
    .record({
      // Under 90% of the player's: one just reached has a tiny share a thread, and a plan tries its many threads.
      requiredShare: fc.double({ min: 0.02, max: 0.9, noNaN: true }),
      minDifficulty: fc.integer({ min: 2, max: 35 }),
      moneyExponent: fc.double({ min: 7, max: 12.2, noNaN: true }),
      serverGrowth: fc.integer({ min: 10, max: 99 }),
      // After an install the game's servers are at 3 times their minimum (Server.ts:83) and 4% of their maximum
      // (:76); a target prepared, or part way.
      securityTimes: fc.constantFrom(1, 1.5, 2, 3),
      moneyShare: fc.constantFrom(1 / 25, 0.5, 1),
    })
    .map(
      ({ requiredShare, minDifficulty, moneyExponent, serverGrowth, securityTimes, moneyShare }): Target => ({
        hostname: `target-${index}`,
        figures: {
          moneyMax: Math.round(10 ** moneyExponent),
          minDifficulty,
          requiredHackingSkill: Math.max(1, Math.floor(requiredShare * hacking)),
          serverGrowth,
        },
        securityTimes,
        moneyShare,
      }),
    );

const anyShape: fc.Arbitrary<Shape> = fc
  .record({
    hacking: fc.integer({ min: 300, max: 2500 }),
    speed: fc.double({ min: 1, max: 3, noNaN: true }),
    count: fc.integer({ min: 1, max: 14 }),
    // Cloud servers of 4 TB to 1 PB (2^12 to 2^20 GB), one to four.
    hostExponents: fc.array(fc.integer({ min: 12, max: 20 }), { minLength: 1, maxLength: 4 }),
  })
  .chain(({ hacking, speed, count, hostExponents }) =>
    fc.tuple(...Array.from({ length: count }, (_, index) => anyTarget(index, hacking))).map((targets) => ({
      player: {
        skills: { hacking, intelligence: 0 },
        mults: { hacking_chance: 1.5, hacking_speed: speed, hacking_money: 2, hacking_grow: 1.5 },
      },
      targets,
      hostsRam: hostExponents.map((exponent) => 2 ** exponent),
    })),
  );

const hostsOf = (shape: Shape) => shape.hostsRam.map((_, index) => `pserv-${index}`);

/** The snapshots: n00dles prepared and every target as the shape has it, all rooted; the hosts. */
function snapshotsOf(shape: Shape): { staticData: StaticSnapshotData; data: MediumSnapshotData } {
  const all = [{ hostname: "n00dles", figures: N00DLES, securityTimes: 1, moneyShare: 1 }, ...shape.targets];
  const staticData = {
    servers: all.map(({ hostname, figures }) => ({
      hostname,
      purchasedByPlayer: false,
      numOpenPortsRequired: 0,
      ...figures,
    })),
  } as StaticSnapshotData;
  const server = (hostname: string, maxRam: number, money: number, security: number) => ({
    hostname,
    maxRam,
    cpuCores: 1,
    hasAdminRights: true,
    backdoorInstalled: false,
    moneyAvailable: money,
    hackDifficulty: security,
  });
  const data = {
    player: shape.player,
    hasTorRouter: false,
    programs: [],
    servers: [
      ...all.map(({ hostname, figures, securityTimes, moneyShare }) =>
        server(hostname, 0, figures.moneyMax * moneyShare, figures.minDifficulty * securityTimes),
      ),
      ...shape.hostsRam.map((ram, index) => server(`pserv-${index}`, ram, 0, 1)),
    ],
  } as unknown as MediumSnapshotData;
  return { staticData, data };
}

const figuresIn = (staticData: StaticSnapshotData, hostname: string) =>
  staticData.servers.find((each) => each.hostname === hostname) as unknown as HackingTarget;
const nowIn = (data: MediumSnapshotData, hostname: string) => {
  const server = data.servers.find((each) => each.hostname === hostname);
  return { money: Number(server?.moneyAvailable), security: Number(server?.hackDifficulty) };
};

/**
 * The targets worth a path from the one batched, worked out here from core's formulas and `planBatcher` alone: worth
 * `BATCHER_MOVE_GAIN` times it once prepared (over `BATCHER_TARGET_HORIZON_MS`, less a weaken for its first batch); a
 * move to it leaves at most `BATCHER_MOST_IDLE_MS` without a hack (its weaken past the batched one's); and it earns
 * within `BATCHER_NEXT_HORIZON_MS` prepared on the RAM the batched one's batches leave, a fifth at least.
 */
function worthAPath(staticData: StaticSnapshotData, data: MediumSnapshotData, hosts: string[], batched: string) {
  const player = data.player as unknown as HackingPlayer;
  const from = planBatcher(staticData, data, batched, hosts);
  if (from.batcher === null) throw new Error(from.why);
  const fromWeakenMs = operationTimeMs("weaken1", figuresIn(staticData, batched), player);
  const nextShare = Math.max(BATCHER_NEXT_RAM_SHARE, 1 - from.peakRamGb / from.ramGb);
  return staticData.servers
    .map((each) => each.hostname)
    .filter((hostname) => {
      if (hostname === batched) return false;
      const plan = planBatcher(staticData, data, hostname, hosts);
      if (plan.batcher === null) return false;
      const figures = figuresIn(staticData, hostname);
      const weakenMs = operationTimeMs("weaken1", figures, player);
      const preparedWorth = plan.incomePerSecond * Math.max(0, BATCHER_TARGET_HORIZON_MS - weakenMs);
      if (preparedWorth < from.incomePerSecond * BATCHER_TARGET_HORIZON_MS * BATCHER_MOVE_GAIN) return false;
      if (weakenMs - fromWeakenMs > BATCHER_MOST_IDLE_MS) return false;
      const preparingMs = preparationTimeMs(figures, player, nowIn(data, hostname), plan.ramGb * nextShare);
      return preparingMs + weakenMs < BATCHER_NEXT_HORIZON_MS;
    });
}

/** Prepared: at its minimum security and maximum money, as the batcher leaves the next once its waves land. */
function prepare(staticData: StaticSnapshotData, data: MediumSnapshotData, hostname: string): void {
  const figures = figuresIn(staticData, hostname);
  data.servers = data.servers.map((server) =>
    server.hostname === hostname
      ? { ...server, moneyAvailable: figures.moneyMax, hackDifficulty: figures.minDifficulty }
      : server,
  );
}

/**
 * The brain's choices from n00dles batched, each next prepared before the next choice and a move made batched: the
 * problems found, none if it held. Each target worth a path gets a move or a next; each next sent is one a move can
 * reach and earns within the next's horizon; and it comes to rest (no move, no next) within a choice a target and two,
 * with none worth a path from where it rests.
 */
function problemsFollowing(shape: Shape): string[] {
  const { staticData, data } = snapshotsOf(shape);
  const hosts = hostsOf(shape);
  const player = shape.player;
  let batching = "n00dles";
  let current = planBatcher(staticData, data, batching, hosts).batcher;
  const most = shape.targets.length + 2;
  for (let choice = 0; choice < most; choice++) {
    const chosen = chooseBatcher(staticData, data, hosts, current, batching);
    if (chosen.batcher === null) return [`choice ${choice}: none: ${chosen.why}`];
    const target = chosen.batcher.config.target;
    const next = chosen.batcher.config.next;
    const worth = worthAPath(staticData, data, hosts, batching);
    if (target === batching && next === undefined) {
      return worth.length === 0
        ? []
        : [`choice ${choice}: rests on ${batching}, with ${worth.join(", ")} worth a path`];
    }
    if (next !== undefined) {
      const weakenMs = operationTimeMs("weaken1", next.figures, player);
      const targetWeakenMs = operationTimeMs("weaken1", figuresIn(staticData, target), player);
      if (weakenMs - targetWeakenMs > BATCHER_MOST_IDLE_MS) {
        return [`choice ${choice}: ${next.target}, the next, can't be moved to from ${target}`];
      }
      const untilMs = preparationTimeMs(next.figures, player, nowIn(data, next.target), next.ramGb) + weakenMs;
      if (!(untilMs < BATCHER_NEXT_HORIZON_MS)) {
        return [`choice ${choice}: ${next.target}, the next, earns only in ${(untilMs / 60_000).toFixed(1)} min`];
      }
      prepare(staticData, data, next.target);
    }
    // While one earns, a move goes only to a target prepared (#236): it's batched at once.
    batching = target;
    current = chosen.batcher;
  }
  return [`still choosing after ${most} choices, batching ${batching}`];
}

test("over random shapes from n00dles batched: a path to any target worth one, each next reachable, at rest within a bound", () => {
  fc.assert(
    fc.property(anyShape, (shape) => {
      expect(problemsFollowing(shape)).toEqual([]);
    }),
    { numRuns: 150, endOnFailure: true },
  );
});

test("the shapes reach what it's for: targets worth a path from n00dles, beyond the 5 best by ceiling, a move, a next", () => {
  // A fixed seed, so these floors can't miss on a random one.
  let worth = 0;
  let moved = 0;
  let nextSent = 0;
  fc.assert(
    fc.property(anyShape, (shape) => {
      const { staticData, data } = snapshotsOf(shape);
      const hosts = hostsOf(shape);
      const current = planBatcher(staticData, data, "n00dles", hosts).batcher;
      if (worthAPath(staticData, data, hosts, "n00dles").length > 0) worth++;
      const chosen = chooseBatcher(staticData, data, hosts, current, "n00dles");
      if (chosen.batcher?.config.target !== "n00dles") moved++;
      if (chosen.batcher?.config.next !== undefined) nextSent++;
    }),
    { numRuns: 150, seed: 274 },
  );
  expect(worth).toBeGreaterThan(50);
  expect(moved).toBeGreaterThan(10);
  expect(nextSent).toBeGreaterThan(30);
});
