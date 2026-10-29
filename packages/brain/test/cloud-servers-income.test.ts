// Cloud servers (#194) in the simulator: an 8 GB fresh start in BN1, the brain's rules as on Steam (the hack loop, the
// programs, home RAM and cloud servers, all on), for `RUN_MS` of virtual time, against the same run with cloud servers
// switched off, as `main` was before #194. The brain buys cloud servers by its payback rule, the hack loop runs on
// them, and the run earns more. CI runs seed 1; `CLOUD_SERVER_SEEDS` (`1,2,3,4,5,6,7,8`, say) runs others (the brain
// README's cloud server suite says how). Each seed prints what each run earned and ended with, and the servers bought.
import type { FastSnapshotData, MediumSnapshotData } from "@bitburner-agent/core";
import { expect, test } from "vitest";
import { hackLoopHosts } from "../src/hack-loop.ts";
import { runReport } from "../src/run-report.ts";
import { EPOCH_MS } from "./helpers/agent-in-simulation.ts";
import { useFreshStarts } from "./helpers/fresh-start.ts";

/** `CLOUD_SERVER_SEEDS`: seeds 1 or more, comma separated; unset, seed 1 alone (CI). Anything else fails loudly. */
function cloudServerSeeds(text: string | undefined): number[] {
  if (text === undefined) return [1];
  const seeds = text.split(",").map((each) => each.trim());
  if (!seeds.every((each) => /^[1-9]\d*$/.test(each))) {
    throw new Error(`CLOUD_SERVER_SEEDS is ${JSON.stringify(text)}: give seeds 1 or more, comma separated`);
  }
  return seeds.map(Number);
}

const freshStartOf = useFreshStarts();
const SEEDS = cloudServerSeeds(process.env.CLOUD_SERVER_SEEDS);
/** The virtual time each run takes. */
const RUN_MS = Number(process.env.CLOUD_SERVER_RUN_MINUTES ?? 180) * 60_000;

test("CLOUD_SERVER_SEEDS: seeds 1 or more, or unset for seed 1; an empty or odd entry fails loudly", () => {
  expect(cloudServerSeeds(undefined)).toEqual([1]);
  expect(cloudServerSeeds("1,2, 3")).toEqual([1, 2, 3]);
  for (const odd of ["", "1,", "0", "1.5", "two", "-1"]) {
    expect(() => cloudServerSeeds(odd)).toThrow(/CLOUD_SERVER_SEEDS/);
  }
});

/** Money's rises added up: what came in, less what was spent in the same 10 s (#187's `earnedSince`). */
function earned(samples: { money: number }[]): number {
  let total = 0;
  for (let index = 1; index < samples.length; index += 1) {
    total += Math.max(0, (samples[index] as { money: number }).money - (samples[index - 1] as { money: number }).money);
  }
  return total;
}

/** One run of `RUN_MS` from a fresh start, cloud servers on or off: what it earned, and what it bought. */
async function run(seed: number, cloudServers: boolean) {
  const fresh = await freshStartOf({ withDesiredState: true, seed });
  if (!cloudServers) fresh.controller().setCloudServersEnabled(false);
  const samples: { atMs: number; money: number }[] = [];
  const purchases: string[] = [];
  let lastPurchase: string | null = null;
  fresh.brain.channel.subscribe((event) => {
    if (event.type !== "snapshotReceived" || event.snapshot.tier !== "medium") return;
    const money = (event.snapshot.data as MediumSnapshotData).player?.money;
    if (typeof money === "number") samples.push({ atMs: event.atMs, money });
    const buying = fresh.controller().cloudServersView().buying;
    const described = buying === null ? null : `${buying.hostname} ${buying.ram} GB`;
    if (described !== null && described !== lastPurchase) {
      purchases.push(`${Math.round((event.atMs - (samples[0]?.atMs ?? event.atMs)) / 60_000)} min ${described}`);
    }
    lastPurchase = described;
  });
  await fresh.game.run(RUN_MS);
  const medium = fresh.medium();
  const outcomes = fresh.latest<FastSnapshotData>("fast")?.intents ?? [];
  return {
    fresh,
    earned: earned(samples),
    money: samples.at(-1)?.money ?? 0,
    purchases,
    cloud: fresh.controller().cloudServersView(),
    hostsRam: hackLoopHosts(medium).reduce((total, host) => total + host.ram, 0),
    // Earning on the target, or preparing the next (the largest hosts, #184).
    hosts: [...fresh.controller().hackLoopView().hosts, ...(fresh.controller().hackLoopView().preparing?.hosts ?? [])],
    outcomes,
  };
}

test.each(SEEDS)(
  "seed %i: cloud servers are bought by the payback rule, the hack loop runs on them, and the run earns more",
  { timeout: 600_000 },
  async (seed) => {
    const off = await run(seed, false);
    const on = await run(seed, true);
    const millions = (amount: number) => `$${(amount / 1e6).toFixed(1)}m`;
    console.log(
      `seed ${seed}: earned ${millions(off.earned)} off → ${millions(on.earned)} on ` +
        `(${(((on.earned - off.earned) / off.earned) * 100).toFixed(1)}%); money at the end ` +
        `${millions(off.money)} → ${millions(on.money)}; hosts' RAM ${off.hostsRam} → ${on.hostsRam} GB; ` +
        `cloud servers ${on.cloud.servers.length} (${on.cloud.servers.reduce((total, server) => total + server.ram, 0)} GB); ` +
        `purchases: ${on.purchases.join(", ")}`,
    );
    expect(off.cloud.servers).toEqual([]);
    expect(on.cloud.servers.length).toBeGreaterThan(0);
    expect(on.cloud.problem).toBeNull();
    // Each is a host of the loop's, running it.
    for (const { hostname } of on.cloud.servers) {
      expect(on.hosts).toContain(hostname);
      const loops = (await on.fresh.simulation.ps(hostname)).filter((process) =>
        process.filename.endsWith("/hack-loop.js"),
      );
      expect(loops.length, hostname).toBeGreaterThan(0);
    }
    // No cloud purchase stuck.
    expect(on.outcomes.filter((outcome) => !outcome.done && outcome.tries >= 5)).toEqual([]);
    expect(on.earned).toBeGreaterThan(off.earned);
    // The run report over the run with them: each purchase with its RAM and price, the hosts' RAM, and PASS.
    const report = runReport(on.fresh.data.store, {
      environment: "E1",
      sinceMs: EPOCH_MS,
      untilMs: on.fresh.game.clock.now(),
    });
    expect(report.text).toMatch(/\n {4}\S+ {2}pserv-0 bought, \d+ GB, \$[\d,]+\n/);
    expect(report.text).toMatch(/\n {4}in all: \d+ bought, \d+ upgraded, \$[\d,]+\n/);
    expect(report.text).toMatch(
      /\n {2}the hack loop's hosts' RAM: [\d.]+ GB on \d+ servers? → [\d.]+ GB on \d+ servers\n/,
    );
    expect(report.failures).toEqual([]);
  },
);
