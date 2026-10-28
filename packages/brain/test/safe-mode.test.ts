// Safe mode's chaos tests in the simulator (#160, architecture §5.4), in an 8 GB fresh start: with the brain gone, the
// Agent keeps converging the hack loop and the work on the last desired state, never its intents, until its ttlMs
// passes; through a reload, and onto a new deployment, from agent/desired-state.json; and drops it after a reset.
import { gunzipSync } from "node:zlib";
import {
  AGENT_CONFIG_FILE_NAME,
  AGENT_SIM_EFFECTORS_GLOBAL,
  BOOT_SCRIPT,
  CURRENT_DEPLOYMENT_FILE,
  DESIRED_STATE_FILE,
  deployedFilePath,
  type FastSnapshotData,
  HACK_LOOP_SCRIPT_NAME,
  isHackLoopFile,
  parseSafeModeState,
  TOKEN_FILE_NAME,
} from "@bitburner-agent/core";
import type { Simulation } from "@bitburner-agent/sim";
import { useSimulations } from "@bitburner-agent/sim/test-helpers";
import { expect, test } from "vitest";
import { SAFE_MODE_TTL_MS } from "../src/desired-state.ts";
import { CONTROL_PORT, CONTROL_URL, TOKEN } from "./helpers/agent-in-simulation.ts";
import { RFA_URL, startBrainInSimulation } from "./helpers/brain-in-simulation.ts";
import { type FreshGame, useFreshStarts } from "./helpers/fresh-start.ts";

const freshStartOf = useFreshStarts();
const start = useSimulations();
const MINUTE = 60_000;
const ROUND_MS = 2_000;
/** The hack loop and the work converge every 15 rounds while nothing changes. */
const CONVERGE_EVERY_MS = 15 * ROUND_MS;
/** A fresh start's servers that need no open ports: the loop's hosts there. */
const NO_PORT_SERVERS = [
  "foodnstuff",
  "harakiri-sushi",
  "hong-fang-tea",
  "joesguns",
  "n00dles",
  "nectar-net",
  "sigma-cosmetics",
];

/** Our loops on the no-port servers, each with its server. */
async function loopsRunning(simulation: Simulation) {
  const each = await Promise.all(
    NO_PORT_SERVERS.map(async (hostname) =>
      (await simulation.ps(hostname))
        .filter((process) => isHackLoopFile(process.filename))
        .map(({ pid, filename, args }) => ({ hostname, pid, filename, args })),
    ),
  );
  return each.flat();
}
const hostsOf = async (simulation: Simulation) => (await loopsRunning(simulation)).map((loop) => loop.hostname).sort();

/** Kills the loop on joesguns, as anything in the game might. */
async function killJoesgunsLoop(simulation: Simulation) {
  const [loop] = (await loopsRunning(simulation)).filter((each) => each.hostname === "joesguns");
  if (!loop) throw new Error("no loop on joesguns");
  expect(await simulation.kill(loop.pid)).toBe(true);
}

/** The player's faction work and focus, as the game saves them: `null` for none. */
async function savedWork(simulation: Simulation) {
  const saveObject = JSON.parse(gunzipSync(await simulation.save()).toString("utf8"));
  const player = JSON.parse(saveObject.data.PlayerSave).data;
  const work = player.currentWork?.data;
  return work ? { faction: work.factionName, workType: work.factionWorkType, focus: player.focus } : null;
}
const HACKING_FOCUSED = { faction: "Sector-12", workType: "hacking", focus: true };

/**
 * Runs `source` on home as the owner would, and steps a second: its pid. An 8 GB home has room for it beside the Agent,
 * but not beside the Agent's larger workers, so it's started at the first step one isn't running.
 */
async function ownerRuns({ simulation, game }: FreshGame, source: string, args: string[] = []): Promise<number> {
  await simulation.writeFile("home", "owner.js", source);
  for (let tries = 0; tries < 20; tries += 1) {
    const { pid, error } = await simulation.run("home", "owner.js", { args });
    if (error === undefined) {
      await game.run(1_000);
      return pid;
    }
    await game.step();
  }
  throw new Error("the owner's script never found room on home");
}

/** The owner switches to field work, unfocused, as the Factions page would (the simulator's own effector). */
const ownerSwitchesWork = (fresh: FreshGame) =>
  ownerRuns(
    fresh,
    `export async function main() { globalThis.${AGENT_SIM_EFFECTORS_GLOBAL}.convergeFactionWork("Sector-12", "field", false); }`,
  );

/** A file on home, read by a script of the owner's. */
async function fileOnHome(fresh: FreshGame, file: string): Promise<string> {
  const pid = await ownerRuns(
    fresh,
    `export async function main(ns) { ns.disableLog("ALL"); ns.print(JSON.stringify(ns.read(ns.args[0]))); }`,
    [file],
  );
  const [line] = await fresh.simulation.logs(pid);
  return JSON.parse(line ?? '""') as string;
}

/** The Agent running now, and its log. */
async function agentLog(simulation: Simulation): Promise<string[]> {
  const [agent] = (await simulation.ps("home")).filter((process) => process.filename.endsWith("/agent.js"));
  if (!agent) throw new Error("no Agent on home");
  return simulation.logs(agent.pid);
}

/**
 * An 8 GB fresh start with the brain's desired state: the hack loop on, faction work for Sector-12 (joined), and a join
 * of CyberSec queued, which no invitation lets happen, so the Agent tries it every 30 s while the brain is there.
 * Purchases off, so nothing else moves the page. Runs until all three are under way.
 */
async function keptGame() {
  const fresh = await freshStartOf({
    withDesiredState: true,
    beforeAgent: (game) => game.simulation.diagnostics.joinFactionWithReputation("Sector-12", 0),
  });
  const controller = fresh.controller();
  controller.setProgramsEnabled(false);
  controller.setHomeRamEnabled(false);
  expect(controller.setWork({ faction: "Sector-12", workType: "hacking" })).toEqual({ ok: true });
  expect(controller.addManualIntent({ action: "joinFaction", args: { faction: "CyberSec" } })).toMatchObject({
    ok: true,
  });
  const fast = () => fresh.latest<FastSnapshotData>("fast");
  await fresh.game.runUntil(() => fast()?.work?.converged === true && (fast()?.intents[0]?.tries ?? 0) >= 1, 60_000);
  await fresh.game.run(CONVERGE_EVERY_MS);
  expect(await hostsOf(fresh.simulation)).toEqual(NO_PORT_SERVERS);
  expect(await savedWork(fresh.simulation)).toEqual(HACKING_FOCUSED);
  return fresh;
}

test("the brain down for an hour, with a reload in the middle: the loops and the work are kept, no intent is tried, and the brain comes back to them", async () => {
  const fresh = await keptGame();
  const { game, brain } = fresh;
  // The file has the state's activities, never its intents.
  const kept = parseSafeModeState(await fileOnHome(fresh, DESIRED_STATE_FILE));
  expect(kept).toMatchObject({
    ok: true,
    message: {
      hackLoop: { enabled: true, target: "n00dles", hosts: NO_PORT_SERVERS },
      work: { kind: "faction", faction: "Sector-12", workType: "hacking", focus: true },
      ttlMs: SAFE_MODE_TTL_MS,
    },
  });
  expect(Object.keys(kept.ok ? kept.message : {})).not.toContain("intents");
  // Connected to the brain that sent it, its clock moves on: written again every 60 s.
  await game.run(2 * MINUTE);
  const later = parseSafeModeState(await fileOnHome(fresh, DESIRED_STATE_FILE));
  const heardAtMs = (state: typeof kept) => (state.ok ? state.message.heardAtMs : 0);
  expect(heardAtMs(later) - heardAtMs(kept)).toBeGreaterThanOrEqual(MINUTE);

  brain.stop();
  const downAtMs = game.clock.now();
  /**
   * Runs `ms` in 10-minute spells, checking after each that the Agent hasn't tried the intent since the disconnect:
   * one-shot actions need the brain. Its log keeps the last 50 lines (a "disconnected" every 30 s), so each spell's are
   * all there.
   */
  const runWithNoIntentTried = async (simulation: Simulation, ms: number) => {
    for (let ranMs = 0; ranMs < ms; ranMs += 10 * MINUTE) {
      await game.run(Math.min(10 * MINUTE, ms - ranMs));
      const lines = await agentLog(simulation);
      const disconnectedAt = Math.max(
        0,
        lines.findIndex((line) => line.includes("agent: disconnected")),
      );
      expect(lines.slice(disconnectedAt).filter((line) => line.includes("join CyberSec"))).toEqual([]);
    }
  };
  await runWithNoIntentTried(fresh.simulation, 5 * MINUTE);
  expect(await agentLog(fresh.simulation)).toContainEqual(
    expect.stringContaining("agent: safe mode: no brain: converging on its last desired state, without intents, until"),
  );
  // Anything may change the game meanwhile: within a convergence, the Agent puts it back.
  await killJoesgunsLoop(fresh.simulation);
  await ownerSwitchesWork(fresh);
  expect(await savedWork(fresh.simulation)).toMatchObject({ workType: "field", focus: false });
  await game.run(CONVERGE_EVERY_MS + 2 * ROUND_MS);
  expect(await hostsOf(fresh.simulation)).toEqual(NO_PORT_SERVERS);
  expect(await savedWork(fresh.simulation)).toEqual(HACKING_FOCUSED);
  await runWithNoIntentTried(fresh.simulation, 30 * MINUTE - (game.clock.now() - downAtMs));

  // The reload: autoexec brings a new Agent back, which has only the file.
  const reloaded = await start({
    seed: 1,
    fixture: { kind: "save", bytes: await fresh.simulation.save() },
    network: { listenUrls: [CONTROL_URL, RFA_URL] },
  });
  game.replaceSimulation(reloaded);
  const afterReload: FreshGame = { simulation: reloaded, game };
  await game.run(10 * ROUND_MS);
  const untilMs = (await agentLog(reloaded)).find((line) => line.includes("agent: safe mode: no brain"));
  // Its clock didn't start again: the same 12 hours from the disconnect, give or take a round.
  const until = Date.parse(untilMs?.split(" until ")[1] ?? "");
  expect(Math.abs(until - (downAtMs + SAFE_MODE_TTL_MS))).toBeLessThanOrEqual(2 * ROUND_MS);
  await killJoesgunsLoop(reloaded);
  await ownerSwitchesWork(afterReload);
  await game.run(CONVERGE_EVERY_MS + 2 * ROUND_MS);
  expect(await hostsOf(reloaded)).toEqual(NO_PORT_SERVERS);
  expect(await savedWork(reloaded)).toEqual(HACKING_FOCUSED);
  await runWithNoIntentTried(reloaded, downAtMs + 60 * MINUTE - game.clock.now());
  const loopsAfterTheHour = await loopsRunning(reloaded);
  expect(loopsAfterTheHour.map((loop) => loop.hostname).sort()).toEqual(NO_PORT_SERVERS);

  // The brain back: it sends a fresh state, and its intent is tried again; the loops and the work as they were.
  const back = startBrainInSimulation(game, { build: fresh.build, data: fresh.data, withDesiredState: true });
  await game.runUntil(() => back.channelEvents.some((event) => event.type === "agentConnected"), 60_000);
  await game.run(CONVERGE_EVERY_MS);
  expect((await agentLog(reloaded)).filter((line) => line.includes("join CyberSec")).length).toBeGreaterThan(0);
  expect(await hostsOf(reloaded)).toEqual(NO_PORT_SERVERS);
  expect(await savedWork(reloaded)).toEqual(HACKING_FOCUSED);
});

test("past ttlMs with no brain, the state is dropped: a loop killed then stays killed, and the file is emptied", async () => {
  const fresh = await freshStartOf({ withDesiredState: false });
  const { simulation, game, brain } = fresh;
  brain.channel.setDesiredState({
    hackLoop: { enabled: true, target: "n00dles", hosts: NO_PORT_SERVERS },
    intents: [],
    ttlMs: 5 * MINUTE,
  });
  await game.run(3 * ROUND_MS);
  expect(await hostsOf(simulation)).toEqual(NO_PORT_SERVERS);
  brain.stop();
  // Within it: put back.
  await game.run(2 * MINUTE);
  await killJoesgunsLoop(simulation);
  await game.run(CONVERGE_EVERY_MS + 2 * ROUND_MS);
  expect(await hostsOf(simulation)).toContain("joesguns");
  // Past it: dropped, logged, the file emptied; the loops left run on, untended.
  await game.run(3 * MINUTE);
  expect(await agentLog(simulation)).toContainEqual(
    expect.stringContaining("agent: safe mode: dropped the last desired state: no brain for 5 min, its ttlMs"),
  );
  expect(await fileOnHome(fresh, DESIRED_STATE_FILE)).toBe("");
  await killJoesgunsLoop(simulation);
  await game.run(2 * CONVERGE_EVERY_MS);
  expect(await hostsOf(simulation)).toEqual(NO_PORT_SERVERS.filter((hostname) => hostname !== "joesguns"));
});

test("a reset with no brain (a new BitNode): the kept state is from before it, so it's dropped, never converged on", async () => {
  const fresh = await keptGame();
  const { simulation, game, brain } = fresh;
  brain.stop();
  await game.run(2 * ROUND_MS);
  // Every script is killed; boot.js stands in for the restart path (§5.7).
  await simulation.diagnostics.destroyBitNode(1);
  expect((await simulation.run("home", BOOT_SCRIPT)).error).toBeUndefined();
  await game.run(2 * CONVERGE_EVERY_MS);
  expect(await agentLog(simulation)).toContainEqual(
    expect.stringContaining("agent: safe mode: dropped the last desired state: it's from before the game's last reset"),
  );
  expect(await loopsRunning(simulation)).toEqual([]);
  expect(await savedWork(simulation)).toBeNull();
  expect(await fileOnHome(fresh, DESIRED_STATE_FILE)).toBe("");
});

test("deployed again while the brain is down: the new deployment's Agent carries on from the file, its own loops in place of the old", async () => {
  const fresh = await keptGame();
  const { simulation, game, brain, build } = fresh;
  brain.stop();
  await game.run(5 * ROUND_MS);
  // As a deploy would leave it (#91), written by hand: the brain is gone.
  const newId = "0123456789ab";
  for (const [fileName, source] of Object.entries(build.scripts)) {
    await simulation.writeFile("home", deployedFilePath(newId, fileName), source);
  }
  await simulation.writeFile(
    "home",
    deployedFilePath(newId, AGENT_CONFIG_FILE_NAME),
    JSON.stringify({ deploymentId: newId, controlPort: CONTROL_PORT }),
  );
  await simulation.writeFile("home", deployedFilePath(newId, TOKEN_FILE_NAME), TOKEN);
  await simulation.writeFile("home", CURRENT_DEPLOYMENT_FILE, newId);
  // At its next try to reconnect (30 s at most), the Agent hands over; the new one converges at once.
  await game.run(CONVERGE_EVERY_MS + 3 * ROUND_MS);
  const agents = (await simulation.ps("home")).filter((process) => process.filename.endsWith("/agent.js"));
  expect(agents.map((agent) => agent.filename)).toEqual([deployedFilePath(newId, "agent.js")]);
  const loops = await loopsRunning(simulation);
  expect(loops.map((loop) => loop.hostname).sort()).toEqual(NO_PORT_SERVERS);
  for (const loop of loops) expect(loop.filename).toBe(deployedFilePath(newId, HACK_LOOP_SCRIPT_NAME));
  expect(await savedWork(simulation)).toEqual(HACKING_FOCUSED);
});
