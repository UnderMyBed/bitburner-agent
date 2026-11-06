// The Singularity backdoor's worker (#162) against its round, on the page's monotonic clock (#251): a backdoor that
// ends within the round is waited for, one that doesn't is reported under way at once, with its time left.
import { WORKER_REPORT_PORT } from "@bitburner-agent/core";
import { expect, test } from "vitest";
import { main } from "../../src/entries/singularity-backdoor.ts";
import type { NS } from "../../src/ns.ts";

/** A game where CSEC is reached from home by n00dles, its backdoor hacking time / 4: the reports, as they come. */
async function backdoor(hackTimeMs: number, deadlineMs: number): Promise<unknown[]> {
  const reports: unknown[] = [];
  let installed = false;
  const links: Record<string, string[]> = { home: ["n00dles"], n00dles: ["home", "CSEC"], CSEC: ["n00dles"] };
  const ns = {
    args: ["CSEC", deadlineMs],
    pid: 7,
    disableLog: () => {},
    serverExists: () => true,
    getServer: (hostname: string) => ({
      backdoorInstalled: hostname === "CSEC" && installed,
      isConnectedTo: false,
      purchasedByPlayer: false,
      hasAdminRights: true,
      requiredHackingSkill: 1,
    }),
    getHackingLevel: () => 50,
    scan: (hostname: string) => links[hostname] ?? [],
    getHackTime: () => hackTimeMs,
    singularity: {
      connect: () => true,
      installBackdoor: async () => {
        installed = true;
      },
    },
    writePort: (port: number, report: { data: unknown }) => {
      expect(port).toBe(WORKER_REPORT_PORT);
      reports.push(report.data);
    },
  } as unknown as NS;
  await main(ns);
  return reports;
}

test("a backdoor ending within the round (#251: on the monotonic clock): waited for, then done, one report", async () => {
  // 1 s of backdoor, 2 s of round left.
  expect(await backdoor(4_000, performance.now() + 2_000)).toEqual([{ done: true, problem: null }]);
});

test("one ending after the round: reported under way at once, its whole time left", async () => {
  // 3 s of backdoor, 2 s of round left.
  expect(await backdoor(12_000, performance.now() + 2_000)).toEqual([
    { done: false, problem: "installing the backdoor on CSEC: about 3 s left" },
  ]);
});
