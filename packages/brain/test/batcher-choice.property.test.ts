// Property test (#274): the batcher's choice of target never leaves a better target without a path to it. In BN1.3's
// exit run the batcher sat on n00dles for about 5 hours at hacking 1,300 to 1,700, with targets 40,000 times richer
// rooted: none of the 5 best by A1's ceiling could be moved to (none prepared) or be the next (a weaken at their
// security after the install was past the 15-minute horizon), and the mid targets that could were never weighed. Over
// random shapes (the player's level and speed, the targets' figures, money and security, the hosts' RAM), with
// n00dles batched: whenever a target is worth a path from the one batched (a move's worth once prepared, one the move
// can reach, earning within `BATCHER_NEXT_HORIZON_MS` on the next's RAM, and gaining more after than the batches lose
// meanwhile), the brain moves or sends a next; each move is to a target prepared and within `BATCHER_MOST_IDLE_MS`;
// each next is one it can move to; and following its choices (each next prepared, then moved to), it comes to rest
// within a bounded number of choices where no target is worth a path.
//
// The limit that remains: a richer target whose weaken is more than `BATCHER_MOST_IDLE_MS` past the batched one's is
// reached only through a chain of steps, each worth a path from the last. Every chain starts with a step worth a path
// from where the brain rests, and at rest there is none, so a richer target left there has no chain. The floor test
// counts the shapes that needed a chain (two moves or more) and those that rest with a richer target and no chain. The
// example tests are batcher.test.ts's.
import {
  batcherIncomePerGigabyteSecond,
  type HackingPlayer,
  type HackingTarget,
  isTargetPrepared,
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
  BATCHER_TARGETS_PLANNED,
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
 * move to it leaves at most `BATCHER_MOST_IDLE_MS` without a hack (its weaken past the batched one's); it earns within
 * `BATCHER_NEXT_HORIZON_MS` prepared on the RAM the batched one's batches leave, a fifth at least; and what it earns
 * more after that, over the hour, is more than the batched one's batches lose meanwhile on four fifths of the RAM.
 */
function worthAPath(staticData: StaticSnapshotData, data: MediumSnapshotData, hosts: string[], batched: string) {
  const player = data.player as unknown as HackingPlayer;
  const from = planBatcher(staticData, data, batched, hosts);
  const rest = planBatcher(staticData, data, batched, hosts, null, 1 - BATCHER_NEXT_RAM_SHARE);
  if (from.batcher === null) throw new Error(from.why);
  const lostPerSecond = rest.batcher === null ? from.incomePerSecond : from.incomePerSecond - rest.incomePerSecond;
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
      const untilMs = preparationTimeMs(figures, player, nowIn(data, hostname), plan.ramGb * nextShare) + weakenMs;
      if (!(untilMs < BATCHER_NEXT_HORIZON_MS)) return false;
      const gain = (plan.incomePerSecond - from.incomePerSecond) * (BATCHER_NEXT_HORIZON_MS - untilMs);
      return gain - lostPerSecond * untilMs > 0;
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

interface Followed {
  problems: string[];
  /** The moves made before it rested. */
  moves: number;
  /** At rest, a target worth `BATCHER_MOVE_GAIN` times the one batched once prepared, with no chain to it. */
  richerLeft: boolean;
}

/**
 * The brain's choices from n00dles batched, each next prepared before the next choice and a move made batched. Each
 * target worth a path gets a move or a next; each move is to a target prepared, within `BATCHER_MOST_IDLE_MS` of the
 * one batched (#236, #237's review); each next sent is one a move can reach and earns within the next's horizon; and
 * it comes to rest (no move, no next) within as many choices as targets and two, with none worth a path from there.
 */
function follow(shape: Shape): Followed {
  const { staticData, data } = snapshotsOf(shape);
  const hosts = hostsOf(shape);
  const player = shape.player;
  const weakenOf = (hostname: string) => operationTimeMs("weaken1", figuresIn(staticData, hostname), player);
  let batching = "n00dles";
  let current = planBatcher(staticData, data, batching, hosts).batcher;
  let moves = 0;
  const failed = (problem: string): Followed => ({ problems: [problem], moves, richerLeft: false });
  const most = shape.targets.length + 2;
  for (let choice = 0; choice < most; choice++) {
    const chosen = chooseBatcher(staticData, data, hosts, current, batching);
    if (chosen.batcher === null) return failed(`choice ${choice}: none: ${chosen.why}`);
    const target = chosen.batcher.config.target;
    const next = chosen.batcher.config.next;
    const worth = worthAPath(staticData, data, hosts, batching);
    if (target === batching && next === undefined) {
      if (worth.length > 0)
        return failed(`choice ${choice}: rests on ${batching}, with ${worth.join(", ")} worth a path`);
      const restingWorth = (planBatcher(staticData, data, batching, hosts) as { incomePerSecond: number })
        .incomePerSecond;
      const richerLeft = staticData.servers.some(({ hostname }) => {
        const plan = planBatcher(staticData, data, hostname, hosts);
        const preparedWorth =
          plan.batcher === null
            ? 0
            : plan.incomePerSecond * Math.max(0, BATCHER_TARGET_HORIZON_MS - weakenOf(hostname));
        return preparedWorth >= restingWorth * BATCHER_TARGET_HORIZON_MS * BATCHER_MOVE_GAIN;
      });
      return { problems: [], moves, richerLeft };
    }
    if (target !== batching) {
      if (!isTargetPrepared(figuresIn(staticData, target), nowIn(data, target))) {
        return failed(`choice ${choice}: a move to ${target}, not prepared`);
      }
      if (weakenOf(target) - weakenOf(batching) > BATCHER_MOST_IDLE_MS) {
        return failed(`choice ${choice}: a move from ${batching} to ${target}, idle past BATCHER_MOST_IDLE_MS`);
      }
      moves++;
    }
    if (next !== undefined) {
      const weakenMs = operationTimeMs("weaken1", next.figures, player);
      if (weakenMs - weakenOf(target) > BATCHER_MOST_IDLE_MS) {
        return failed(`choice ${choice}: ${next.target}, the next, can't be moved to from ${target}`);
      }
      const untilMs = preparationTimeMs(next.figures, player, nowIn(data, next.target), next.ramGb) + weakenMs;
      if (!(untilMs < BATCHER_NEXT_HORIZON_MS)) {
        return failed(`choice ${choice}: ${next.target}, the next, earns only in ${(untilMs / 60_000).toFixed(1)} min`);
      }
      prepare(staticData, data, next.target);
    }
    batching = target;
    current = chosen.batcher;
  }
  return failed(`still choosing after ${most} choices, batching ${batching}`);
}

test("over random shapes from n00dles batched: a path to any target worth one, moves and nexts as the rules allow, at rest within a bound", () => {
  fc.assert(
    fc.property(anyShape, (shape) => {
      const followed = follow(shape);
      expect(followed.problems).toEqual([]);
    }),
    { numRuns: 150, endOnFailure: true },
  );
});

test("the shapes reach what it's for: a move or a next beyond the 5 best by the ceiling, chains, rests with a richer target left", () => {
  // A fixed seed, so these floors can't miss on a random one. On seed 274's 150 shapes: 145 with a target worth a
  // path from n00dles, 45 moving at once, 134 sending a next, 18 whose move or next is beyond the 5 best by the ceiling,
  // 35 needing a chain of two moves or more, and 2 resting with a richer target and no chain to it. The floors are
  // about half.
  const counts = { worth: 0, moved: 0, nextSent: 0, beyondTheBest: 0, chains: 0, richerLeft: 0 };
  fc.assert(
    fc.property(anyShape, (shape) => {
      const { staticData, data } = snapshotsOf(shape);
      const hosts = hostsOf(shape);
      const current = planBatcher(staticData, data, "n00dles", hosts).batcher;
      if (worthAPath(staticData, data, hosts, "n00dles").length > 0) counts.worth++;
      const chosen = chooseBatcher(staticData, data, hosts, current, "n00dles");
      const target = chosen.batcher?.config.target;
      const next = chosen.batcher?.config.next?.target;
      if (target !== "n00dles") counts.moved++;
      if (next !== undefined) counts.nextSent++;
      const ceilingOf = (hostname: string) =>
        batcherIncomePerGigabyteSecond(figuresIn(staticData, hostname), shape.player, 1);
      const best = staticData.servers
        .map(({ hostname }) => hostname)
        .sort((a, b) => ceilingOf(b) - ceilingOf(a))
        .slice(0, BATCHER_TARGETS_PLANNED);
      const beyond = (hostname: string | undefined) => hostname !== undefined && !best.includes(hostname);
      if ((target !== "n00dles" && beyond(target)) || beyond(next)) counts.beyondTheBest++;
      const followed = follow(shape);
      if (followed.moves >= 2) counts.chains++;
      if (followed.richerLeft) counts.richerLeft++;
    }),
    { numRuns: 150, seed: 274 },
  );
  expect(counts.worth).toBeGreaterThan(70);
  expect(counts.moved).toBeGreaterThan(20);
  expect(counts.nextSent).toBeGreaterThan(60);
  expect(counts.beyondTheBest).toBeGreaterThan(8);
  expect(counts.chains).toBeGreaterThan(16);
});
