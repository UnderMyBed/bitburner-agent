// The Agent's batcher activity (#205): the config on its port each round it's on, the deploy worker when the batcher's
// host changes, it's turned on or off, and every 15 rounds while on, and the health read off its port. Ports and the
// worker are stand-ins; the simulator runs the real ones (packages/brain/test/batcher-simulation.test.ts).
import {
  BATCHER_CONFIG_PORT,
  BATCHER_DEPLOY_WORKER_NAME,
  BATCHER_HEALTH_PORT,
  type BatcherState,
  deployedFilePath,
  newBatcherHealth,
} from "@bitburner-agent/core";
import { expect, test } from "vitest";
import { createBatcherActivity } from "../../src/agent/batcher.ts";
import type { WorkerRunner } from "../../src/agent/run-worker.ts";
import type { NS } from "../../src/ns.ts";

const BATCHER: BatcherState = {
  runOn: "joesguns",
  config: {
    target: "n00dles",
    figures: { moneyMax: 1_750_000, minDifficulty: 1, requiredHackingSkill: 1, serverGrowth: 3_000 },
    player: { intelligence: 0, mults: { hacking_chance: 1, hacking_speed: 1, hacking_money: 1, hacking_grow: 1 } },
    hosts: ["joesguns", "sigma-cosmetics"],
    hackShare: 0.1,
    spacingMs: 20_000,
  },
};

function agentWith({ reports = true }: { reports?: boolean } = {}) {
  const ports = new Map<number, unknown[]>();
  const lines: string[] = [];
  const runs: unknown[][] = [];
  const ns = {
    clearPort: (port: number) => ports.set(port, []),
    writePort: (port: number, data: unknown) => {
      ports.set(port, [...(ports.get(port) ?? []), data]);
      return null;
    },
    peek: (port: number) => ports.get(port)?.[0] ?? "NULL PORT DATA",
    print: (line: string) => lines.push(line),
  } as unknown as NS;
  const workerRunner = {
    runWorker: async (file: string, args: unknown[]) => {
      expect(file).toBe(deployedFilePath("0123456789ab", BATCHER_DEPLOY_WORKER_NAME));
      runs.push(args);
      return reports
        ? {
            outcome: "reported",
            report: {
              workerPid: 1,
              gameTimeMs: 0,
              data: { running: args[0] ?? null, started: true, stopped: 0, problem: null },
            },
          }
        : { outcome: "noReport" };
    },
  } as unknown as WorkerRunner;
  const batcher = createBatcherActivity(ns, { deploymentId: "0123456789ab", workerRunner });
  const rounds = async (count: number) => {
    for (let round = 0; round < count; round += 1) await batcher.convergeIfDue(Number.POSITIVE_INFINITY);
  };
  return { batcher, ports, lines, runs, rounds };
}

test("no instructions: nothing written, no worker", async () => {
  const { rounds, ports, runs } = agentWith();
  await rounds(3);
  expect(ports.size).toBe(0);
  expect(runs).toEqual([]);
});

test("on: the config on its port every round, the worker at once and every 15 rounds", async () => {
  const { batcher, rounds, ports, runs, lines } = agentWith();
  batcher.desire(BATCHER);
  await rounds(1);
  expect(ports.get(BATCHER_CONFIG_PORT)).toEqual([BATCHER.config]);
  expect(runs).toEqual([["joesguns"]]);
  expect(lines).toEqual(["agent: batcher: on joesguns, against n00dles (started)"]);
  await rounds(14);
  expect(runs).toHaveLength(1);
  await rounds(1);
  expect(runs).toHaveLength(2);
  // Only the latest config is on the port.
  expect(ports.get(BATCHER_CONFIG_PORT)).toHaveLength(1);
});

test("a new config on the same host goes on the port, with no worker; another host runs the worker at once", async () => {
  const { batcher, rounds, ports, runs } = agentWith();
  batcher.desire(BATCHER);
  await rounds(1);
  const faster = { ...BATCHER, config: { ...BATCHER.config, spacingMs: 10_000 } };
  batcher.desire(faster);
  await rounds(1);
  expect(ports.get(BATCHER_CONFIG_PORT)).toEqual([faster.config]);
  expect(runs).toHaveLength(1);
  batcher.desire({ ...faster, runOn: "home" });
  await rounds(1);
  expect(runs).toEqual([["joesguns"], ["home"]]);
});

test("off: the config cleared, the worker once with no host, then nothing until it changes", async () => {
  const { batcher, rounds, ports, runs, lines } = agentWith();
  batcher.desire(BATCHER);
  await rounds(1);
  batcher.desire(null);
  await rounds(20);
  expect(ports.get(BATCHER_CONFIG_PORT)).toEqual([]);
  expect(runs).toEqual([["joesguns"], []]);
  expect(lines.at(-1)).toBe("agent: batcher: off");
});

test("a worker that doesn't report is tried again next round, and says why", async () => {
  const { batcher, rounds, runs, lines } = agentWith({ reports: false });
  batcher.desire(BATCHER);
  await rounds(2);
  expect(runs).toHaveLength(2);
  expect(lines.at(-1)).toContain("didn't report in time; trying again next round");
});

test("forgotten: what runs keeps running, and nothing is written", async () => {
  const { batcher, rounds, ports, runs } = agentWith();
  batcher.desire(BATCHER);
  await rounds(1);
  batcher.forget();
  ports.clear();
  await rounds(20);
  expect(ports.size).toBe(0);
  expect(runs).toHaveLength(1);
});

test("health: what the batcher last wrote on its port, or null", () => {
  const { batcher, ports } = agentWith();
  expect(batcher.health()).toBeNull();
  const health = newBatcherHealth("n00dles", "r1", 5);
  ports.set(BATCHER_HEALTH_PORT, [health]);
  expect(batcher.health()).toEqual(health);
});
