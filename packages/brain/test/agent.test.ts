// The in-game Agent (#88), built from packages/ingame, against a real ControlChannel on the lockstep driver: hello and
// welcome, reconnecting with backoff, restarting onto a new deployment, giving way to a newer Agent, and never leaving
// a socket open.
import { BOOT_SCRIPT, CURRENT_DEPLOYMENT_FILE, deployedFilePath, PINNED_GAME } from "@bitburner-agent/core";
import type { Simulation } from "@bitburner-agent/sim";
import { useSimulations } from "@bitburner-agent/sim/test-helpers";
import { expect, test } from "vitest";
import {
  attachBrain,
  CONTROL_URL,
  NEW_GAME_WITH_NETWORK,
  useBuiltBundles,
  writeDeployment,
} from "./helpers/agent-in-simulation.ts";

const start = useSimulations();
const bundles = useBuiltBundles();

const runningFiles = async (simulation: Simulation) =>
  (await simulation.ps("home")).map((process) => process.filename).sort();
const agentFile = (deploymentId: string) => deployedFilePath(deploymentId, "agent.js");

async function gameWithAgent(deploymentId = "deployment-a", options: { brainToken?: string } = {}) {
  const simulation = await start(NEW_GAME_WITH_NETWORK);
  await writeDeployment(simulation, await bundles(), deploymentId);
  const brain = await attachBrain(simulation, options.brainToken ? { token: options.brainToken } : {});
  expect((await simulation.run("home", BOOT_SCRIPT)).error).toBeUndefined();
  return { simulation, ...brain };
}

function eventsOfType<Type extends string, Event extends { type: string }>(events: Event[], type: Type) {
  return events.filter((event): event is Extract<Event, { type: Type }> => event.type === type);
}

test("the Agent says hello with its deployment and the game's version, and is welcomed", async () => {
  const { simulation, events, runUntil } = await gameWithAgent();
  await runUntil(() => eventsOfType(events, "agentConnected").length > 0, 5_000);
  expect(events[0]).toMatchObject({
    type: "agentConnected",
    deploymentId: "deployment-a",
    game: {
      version: PINNED_GAME.versionString,
      versionNumber: PINNED_GAME.versionNumber,
      commit: PINNED_GAME.commit,
      platform: expect.any(String),
    },
  });
  expect(await runningFiles(simulation)).toEqual([agentFile("deployment-a")]);
});

test.each([
  ["an empty token.txt", "token.txt", "", "token.txt is missing or empty"],
  ["an empty config.json", "config.json", "", "config.json is missing or empty"],
  ["a config.json with no port", "config.json", '{"deploymentId":"deployment-a"}', "no valid controlPort"],
  [
    "a config.json naming another deployment",
    "config.json",
    '{"deploymentId":"deployment-b","controlPort":12526}',
    "names deployment deployment-b, not its folder's deployment-a",
  ],
])("with %s, the Agent exits at once, says why, and never connects", async (_problem, fileName, content, reason) => {
  const simulation = await start(NEW_GAME_WITH_NETWORK);
  await writeDeployment(simulation, await bundles(), "deployment-a");
  await simulation.writeFile("home", deployedFilePath("deployment-a", fileName), content);
  const { game, events } = await attachBrain(simulation);
  const { pid } = await simulation.run("home", agentFile("deployment-a"));
  await game.run(2_000);
  expect(await runningFiles(simulation)).toEqual([]);
  expect(events).toEqual([]);
  expect((await simulation.logs(pid)).join("\n")).toContain(reason);
});

test("outside a deployment folder, the Agent exits at once, says why, and never connects", async () => {
  const simulation = await start(NEW_GAME_WITH_NETWORK);
  await simulation.writeFile("home", "agent.js", (await bundles())("agent.js"));
  const { game, events } = await attachBrain(simulation);
  const { pid } = await simulation.run("home", "agent.js");
  await game.run(2_000);
  expect(await runningFiles(simulation)).toEqual([]);
  expect(events).toEqual([]);
  expect((await simulation.logs(pid)).join("\n")).toContain("isn't in a deployment folder");
});

test("a wrong token is refused (4003), and the Agent keeps trying, backing off to 30 s, without crashing", async () => {
  const { simulation, events, runUntil } = await gameWithAgent("deployment-a", { brainToken: "c".repeat(64) });
  await runUntil(() => eventsOfType(events, "connectionRejected").length >= 8, 120_000);
  const rejections = eventsOfType(events, "connectionRejected");
  expect(rejections.map((event) => event.reason)).toEqual(Array(rejections.length).fill("wrongToken"));
  const gapsMs = rejections.slice(1).map((event, index) => event.atMs - (rejections[index]?.atMs as number));
  // 1 s, 2 s, 4 s, 8 s, 16 s, then capped at 30 s, each plus the step or two a connect takes.
  for (const [index, expectedDelayMs] of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000].entries()) {
    expect(gapsMs[index]).toBeGreaterThanOrEqual(expectedDelayMs);
    expect(gapsMs[index]).toBeLessThan(expectedDelayMs + 500);
  }
  expect(await runningFiles(simulation)).toEqual([agentFile("deployment-a")]);
});

test("when the brain drops the connection, the Agent comes back after 1 s, every time, in the same session", async () => {
  const { game, events, connections, runUntil } = await gameWithAgent();
  const comebackDelaysMs: number[] = [];
  // Twice: being welcomed resets the backoff, so the second comeback isn't slower.
  for (const connectionIndex of [0, 1]) {
    await runUntil(() => eventsOfType(events, "agentConnected").length === connectionIndex + 1, 10_000);
    const droppedAtMs = game.clock.now();
    connections[connectionIndex]?.close(4999, "brain restarting");
    await runUntil(() => eventsOfType(events, "agentConnected").length === connectionIndex + 2, 10_000);
    comebackDelaysMs.push((events.at(-1)?.atMs as number) - droppedAtMs);
  }
  for (const delayMs of comebackDelaysMs) {
    expect(delayMs).toBeGreaterThanOrEqual(1_000);
    expect(delayMs).toBeLessThan(1_500);
  }
  const sessionIds = eventsOfType(events, "agentConnected").map((event) => event.agentSessionId);
  expect(new Set(sessionIds).size).toBe(1);
});

test("told to restart, the Agent hands over to boot.js, which starts the deployed one, in an 8 GB home", async () => {
  const { simulation, channel, events, runUntil } = await gameWithAgent("deployment-a");
  expect((await simulation.summary()).homeRamMax).toBe(8);
  await runUntil(() => eventsOfType(events, "agentConnected").length === 1, 5_000);
  // As the deployer will (#91): write deployment-b, switch current.txt to it, tell the channel.
  await writeDeployment(simulation, await bundles(), "deployment-b");
  channel.setDeploymentState({ deployedId: "deployment-b", hold: false, deployFailed: false });
  await runUntil(() => eventsOfType(events, "agentConnected").length === 2, 10_000);
  const [first, second] = eventsOfType(events, "agentConnected");
  expect(second).toMatchObject({ deploymentId: "deployment-b" });
  expect(second?.agentSessionId).not.toBe(first?.agentSessionId);
  expect(await runningFiles(simulation)).toEqual([agentFile("deployment-b")]);
});

test("the handover also works with another script on home: boot.js waits for the old Agent to free its RAM", async () => {
  const { simulation, channel, events, runUntil } = await gameWithAgent("deployment-a");
  await runUntil(() => eventsOfType(events, "agentConnected").length === 1, 5_000);
  // 1.6 GB taken: the old Agent, boot.js and the new Agent (7.9 GB) can't all be in RAM at once.
  await simulation.writeFile("home", "hold-ram.js", "export async function main(ns) { await ns.sleep(1e9); }");
  await simulation.run("home", "hold-ram.js");
  await writeDeployment(simulation, await bundles(), "deployment-b");
  channel.setDeploymentState({ deployedId: "deployment-b", hold: false, deployFailed: false });
  await runUntil(() => eventsOfType(events, "agentConnected").length === 2, 10_000);
  expect(eventsOfType(events, "agentConnected").at(-1)).toMatchObject({ deploymentId: "deployment-b" });
  expect(await runningFiles(simulation)).toEqual([agentFile("deployment-b"), "hold-ram.js"]);
});

test("told to restart onto a deployment current.txt doesn't name, the Agent restarts as current.txt says", async () => {
  const { simulation, channel, events, runUntil } = await gameWithAgent("deployment-a");
  await runUntil(() => eventsOfType(events, "agentConnected").length === 1, 5_000);
  // The brain thinks deployment-z is deployed; current.txt still names deployment-a. boot.js starts deployment-a
  // again, once the old one has exited, and the brain welcomes it (it only says restart once per deployment).
  channel.setDeploymentState({ deployedId: "deployment-z", hold: false, deployFailed: false });
  await runUntil(() => eventsOfType(events, "agentConnected").length === 2, 10_000);
  const [first, second] = eventsOfType(events, "agentConnected");
  expect(second).toMatchObject({ deploymentId: "deployment-a" });
  expect(second?.agentSessionId).not.toBe(first?.agentSessionId);
  expect(await runningFiles(simulation)).toEqual([agentFile("deployment-a")]);
});

test("told to restart when home is too full for boot.js, the Agent carries on, and hands over once it can", async () => {
  const { simulation, game, channel, events, connections, runUntil } = await gameWithAgent("deployment-a");
  await runUntil(() => eventsOfType(events, "agentConnected").length === 1, 5_000);
  // 3.2 GB taken: with the Agent's 2.6, 2.2 GB stay free, short of boot.js's 2.7.
  await simulation.writeFile("home", "hold-ram.js", "export async function main(ns) { await ns.sleep(1e9); }");
  const { pid: holderPid } = await simulation.run("home", "hold-ram.js", { threads: 2 });
  await writeDeployment(simulation, await bundles(), "deployment-b");
  channel.setDeploymentState({ deployedId: "deployment-b", hold: false, deployFailed: false });
  await game.run(2_000);
  expect(await runningFiles(simulation)).toEqual([agentFile("deployment-a"), "hold-ram.js"]);
  expect(eventsOfType(events, "agentDisconnected")).toHaveLength(0);
  // With RAM free, its next disconnect hands over.
  await simulation.kill(holderPid);
  connections[0]?.close(4999, "brain restarting");
  await runUntil(() => eventsOfType(events, "agentConnected").length === 2, 10_000);
  expect(eventsOfType(events, "agentConnected").at(-1)).toMatchObject({ deploymentId: "deployment-b" });
  expect(await runningFiles(simulation)).toEqual([agentFile("deployment-b")]);
});

test("disconnected with an invalid id in current.txt, the Agent reconnects instead of handing over", async () => {
  const { simulation, events, connections, runUntil } = await gameWithAgent("deployment-a");
  await runUntil(() => eventsOfType(events, "agentConnected").length === 1, 5_000);
  await simulation.writeFile("home", CURRENT_DEPLOYMENT_FILE, "../not an id");
  connections[0]?.close(4999, "brain restarting");
  await runUntil(() => eventsOfType(events, "agentConnected").length === 2, 10_000);
  expect(eventsOfType(events, "agentConnected").map((event) => event.deploymentId)).toEqual([
    "deployment-a",
    "deployment-a",
  ]);
  expect(await runningFiles(simulation)).toEqual([agentFile("deployment-a")]);
});

test("deployed again while disconnected, the Agent hands over to the new deployment instead of reconnecting", async () => {
  const { simulation, events, connections, runUntil } = await gameWithAgent("deployment-a");
  await runUntil(() => eventsOfType(events, "agentConnected").length === 1, 5_000);
  await writeDeployment(simulation, await bundles(), "deployment-b");
  connections[0]?.close(4999, "brain restarting");
  await runUntil(() => eventsOfType(events, "agentConnected").length === 2, 10_000);
  expect(eventsOfType(events, "agentConnected").map((event) => event.deploymentId)).toEqual([
    "deployment-a",
    "deployment-b",
  ]);
  expect(await runningFiles(simulation)).toEqual([agentFile("deployment-b")]);
});

test("replaced by a newer Agent (4000), the older one exits and doesn't come back", async () => {
  const { simulation, game, events, runUntil } = await gameWithAgent("deployment-a");
  await runUntil(() => eventsOfType(events, "agentConnected").length === 1, 5_000);
  // A second copy (its argument tells them apart) connects and replaces the first.
  expect((await simulation.run("home", agentFile("deployment-a"), { args: ["second"] })).error).toBeUndefined();
  await runUntil(() => eventsOfType(events, "agentConnected").length === 2, 5_000);
  await game.run(1_000);
  expect((await simulation.ps("home")).map((process) => process.args)).toEqual([["second"]]);
  // Long after the first one's backoff would have run out, nothing else has connected.
  await game.run(60_000);
  expect(eventsOfType(events, "agentConnected")).toHaveLength(2);
});

test("a killed Agent closes its connection at once", async () => {
  const { simulation, events, runUntil } = await gameWithAgent();
  await runUntil(() => eventsOfType(events, "agentConnected").length === 1, 5_000);
  const [agentProcess] = await simulation.ps("home");
  expect(await simulation.kill(agentProcess?.pid as number)).toBe(true);
  // Within the next step: the close comes from atExit, not from a timeout.
  await runUntil(() => eventsOfType(events, "agentDisconnected").length === 1, 100);
});

// Handlers that called ns would pass this today: frames only arrive while main awaits the queue, not ns.sleep. The
// rule is pinned once main sleeps while connected, between snapshots (#89).
test("unknown and malformed frames from the brain are ignored: the Agent stays up and connected", async () => {
  const { simulation, game, events, connections, runUntil } = await gameWithAgent();
  await runUntil(() => eventsOfType(events, "agentConnected").length === 1, 5_000);
  for (let frame = 0; frame < 50; frame++) {
    connections[0]?.send(frame % 2 === 0 ? `{"protocolVersion":1,"type":"unknown${frame}"}` : "not json");
  }
  await game.run(2_000);
  expect(await runningFiles(simulation)).toEqual([agentFile("deployment-a")]);
  expect(eventsOfType(events, "agentDisconnected")).toHaveLength(0);
});

test("the trap is real: a script whose socket handler calls ns while it sleeps is killed", async () => {
  const { simulation, game } = await gameWithAgent();
  // Its hello is refused (4002), so its close handler runs while main awaits ns.sleep.
  await simulation.writeFile(
    "home",
    "calls-ns-from-a-handler.js",
    `export async function main(ns) {
       const socket = new WebSocket("${CONTROL_URL}");
       socket.onopen = () => socket.send("not a hello");
       socket.onclose = () => ns.print("closed");
       await ns.sleep(60_000);
     }`,
  );
  const { pid, error } = await simulation.run("home", "calls-ns-from-a-handler.js");
  expect(error).toBeUndefined();
  await game.run(2_000);
  expect(await runningFiles(simulation)).toEqual([agentFile("deployment-a")]);
  expect((await simulation.logs(pid)).join("\n")).toContain("Concurrent calls to Netscript functions are not allowed");
});
