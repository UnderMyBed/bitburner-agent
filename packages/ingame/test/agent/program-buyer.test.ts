// The program buyer's schedule (#136): when it runs `buy-program.js`, and what it logs. The worker itself is the
// stand-in here; E2 drives the real one on the real page (packages/e2/test/programs.e2.test.ts).
import type { BuyProgramReport } from "@bitburner-agent/core";
import { expect, test, vi } from "vitest";
import { createProgramBuyer } from "../../src/agent/program-buyer.ts";
import type { WorkerRun, WorkerRunner } from "../../src/agent/run-worker.ts";
import type { NS } from "../../src/ns.ts";

const TOR = { enabled: true, next: { item: "TOR router", vendor: "Alpha Enterprises" } };
const ROUND_MS = 2_000;

function buyerWith(reports: BuyProgramReport[]) {
  const lines: string[] = [];
  const ns = { print: (line: string) => lines.push(line) } as unknown as NS;
  const runWorker = vi.fn(async (): Promise<WorkerRun> => {
    const report = reports.shift();
    if (!report) throw new Error("no report left for the stand-in worker");
    return { outcome: "reported", report: { workerPid: 1, data: report } as never };
  });
  const buyer = createProgramBuyer(ns, { deploymentId: "abcdef123456", workerRunner: { runWorker } as WorkerRunner });
  /** One round, with `leftMs` of it left when the buyer's turn comes. */
  const round = (leftMs = ROUND_MS) => buyer.buyIfDue(Date.now() + leftMs);
  return { buyer, lines, runWorker, round };
}

test("with less than a second of the round left, it waits for the next round rather than start the page", async () => {
  const { buyer, runWorker, round } = buyerWith([{ item: "TOR router", done: true, problem: null }]);
  buyer.desire(TOR);
  await round(900);
  expect(runWorker).not.toHaveBeenCalled();
  await round();
  expect(runWorker).toHaveBeenCalledTimes(1);
  // The worker gives up 200 ms before the Agent stops waiting for it.
  const [, workerArguments, deadlineMs] = runWorker.mock.calls[0] as unknown as [string, unknown[], number];
  expect(workerArguments.slice(0, 2)).toEqual(["TOR router", "Alpha Enterprises"]);
  expect(deadlineMs - (workerArguments[2] as number)).toBe(200);
});

test("not bought: each try logs why, and the next is 15 rounds (30 s) later", async () => {
  const notBought = { item: "TOR router", done: false, problem: "no TOR button that can be bought with on the page" };
  const { buyer, lines, runWorker, round } = buyerWith([notBought, notBought]);
  buyer.desire(TOR);
  for (let each = 0; each < 16; each += 1) await round();
  expect(runWorker).toHaveBeenCalledTimes(2);
  expect(lines).toEqual([
    "agent: hacking programs: couldn't buy TOR router: no TOR button that can be bought with on the page; trying again in 30 s",
    "agent: hacking programs: couldn't buy TOR router: no TOR button that can be bought with on the page; trying again in 30 s",
  ]);
});

test("bought: nothing more until the brain names the next item, and a problem on the way is still logged", async () => {
  const { buyer, lines, runWorker, round } = buyerWith([
    { item: "TOR router", done: true, problem: 'no "Terminal" in the sidebar (is its section collapsed?)' },
    { item: "BruteSSH.exe", done: true, problem: null },
  ]);
  buyer.desire(TOR);
  for (let each = 0; each < 20; each += 1) await round();
  expect(runWorker).toHaveBeenCalledTimes(1);
  buyer.desire({ enabled: true, next: { item: "BruteSSH.exe", vendor: null } });
  await round();
  expect(runWorker).toHaveBeenCalledTimes(2);
  expect(lines).toEqual([
    'agent: hacking programs: bought TOR router: no "Terminal" in the sidebar (is its section collapsed?)',
    "agent: hacking programs: bought BruteSSH.exe",
  ]);
});

test("off, or forgotten on a disconnect, it buys nothing", async () => {
  const { buyer, runWorker, round } = buyerWith([]);
  buyer.desire({ ...TOR, enabled: false });
  await round();
  buyer.desire(TOR);
  buyer.forget();
  await round();
  expect(runWorker).not.toHaveBeenCalled();
});
