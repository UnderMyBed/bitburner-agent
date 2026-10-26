// boot.js (architecture §5.7): starts the deployed Agent if it isn't running, never a second copy, and after a load
// only autoexec brings the Agent back, because it runs as a temporary script.
import { BOOT_SCRIPT, CURRENT_DEPLOYMENT_FILE, deployedFilePath } from "@bitburner-agent/core";
import type { Simulation } from "@bitburner-agent/sim";
import { expect, test } from "vitest";
import { NEW_GAME, useInGameBuild, useSimulations } from "./helpers/simulation.ts";

const start = useSimulations();
const build = useInGameBuild();

const DEPLOYMENT_ID = "deployment1";
const AGENT_FILE = deployedFilePath(DEPLOYMENT_ID, "agent.js");
/** A stand-in Agent: runs until killed. */
const STUB_AGENT = "export async function main(ns) { for (;;) await ns.asleep(60_000); }";

async function deployedGame(options: { autoexec?: string } = {}): Promise<Simulation> {
  const simulation = await start({
    ...NEW_GAME,
    ...(options.autoexec ? { gameSettings: { AutoexecScript: options.autoexec } } : {}),
  });
  const { source } = await build();
  await simulation.writeFile("home", BOOT_SCRIPT, source("boot.js"));
  await simulation.writeFile("home", AGENT_FILE, STUB_AGENT);
  await simulation.writeFile("home", CURRENT_DEPLOYMENT_FILE, `${DEPLOYMENT_ID}\n`);
  return simulation;
}

const runningFiles = async (simulation: Simulation) => (await simulation.ps("home")).map((process) => process.filename);

async function runBoot(simulation: Simulation): Promise<string[]> {
  const { pid, error } = await simulation.run("home", BOOT_SCRIPT);
  expect(error).toBeUndefined();
  await simulation.advance(1_000);
  return simulation.logs(pid);
}

test("starts the deployed Agent once, and exits", async () => {
  const simulation = await deployedGame();
  await runBoot(simulation);
  expect(await runningFiles(simulation)).toEqual([AGENT_FILE]);
  await runBoot(simulation);
  expect(await runningFiles(simulation)).toEqual([AGENT_FILE]);
});

test("with nothing deployed it says so, and starts nothing", async () => {
  const simulation = await start(NEW_GAME);
  const { source } = await build();
  await simulation.writeFile("home", BOOT_SCRIPT, source("boot.js"));
  const { pid } = await simulation.run("home", BOOT_SCRIPT);
  await simulation.advance(1_000);
  expect(await runningFiles(simulation)).toEqual([]);
  expect((await simulation.logs(pid)).join("\n")).toContain("nothing is deployed");
});

test("an Agent that can't start is reported, not silently skipped", async () => {
  const simulation = await deployedGame();
  // Home has 8 GB: a 4.8 GB filler and boot.js (2.7 GB) leave too little for a 4.3 GB Agent.
  await simulation.writeFile(
    "home",
    AGENT_FILE,
    "export async function main(ns) { ns.getServer(); ns.scan(); ns.getPlayer(); for (;;) await ns.asleep(60_000); }",
  );
  await simulation.writeFile("home", "filler.js", STUB_AGENT);
  await simulation.run("home", "filler.js", { threads: 3 });
  const log = await runBoot(simulation);
  expect(log.join("\n")).toContain(`couldn't start ${AGENT_FILE}`);
});

test("after a load the Agent is back only through autoexec: it runs as a temporary script", async () => {
  const withoutAutoexec = await deployedGame();
  await runBoot(withoutAutoexec);
  const loadedWithoutAutoexec = await start({
    seed: 1,
    fixture: { kind: "save", bytes: await withoutAutoexec.save() },
  });
  await loadedWithoutAutoexec.advance(1_000);
  expect(await runningFiles(loadedWithoutAutoexec)).toEqual([]);

  const withAutoexec = await deployedGame({ autoexec: BOOT_SCRIPT });
  await runBoot(withAutoexec);
  const loadedWithAutoexec = await start({ seed: 1, fixture: { kind: "save", bytes: await withAutoexec.save() } });
  await loadedWithAutoexec.advance(1_000);
  expect(await runningFiles(loadedWithAutoexec)).toEqual([AGENT_FILE]);
});
