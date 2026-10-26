// The in-game Agent (#88), built from packages/ingame, against a real ControlChannel on the lockstep driver: hello and
// welcome, reconnecting with backoff, restarting onto a new deployment, giving way to a newer Agent, and never leaving
// a socket open.
import { BOOT_SCRIPT, deployedFilePath } from "@bitburner-agent/core";
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
    game: { version: "3.0.1", versionNumber: 51 },
  });
  expect(await runningFiles(simulation)).toEqual([agentFile("deployment-a")]);
});

test.each([
  ["an empty token.txt", "token.txt", ""],
  ["a config.json with no port", "config.json", '{"deploymentId":"deployment-a"}'],
])("with %s, the Agent exits at once, without connecting", async (_problem, fileName, content) => {
  const simulation = await start(NEW_GAME_WITH_NETWORK);
  await writeDeployment(simulation, await bundles(), "deployment-a");
  await simulation.writeFile("home", deployedFilePath("deployment-a", fileName), content);
  const { game, events } = await attachBrain(simulation);
  const { pid } = await simulation.run("home", agentFile("deployment-a"));
  await game.run(2_000);
  expect(await runningFiles(simulation)).toEqual([]);
  expect(events).toEqual([]);
  expect((await simulation.logs(pid)).join("\n")).toMatch(/agent: can't start/);
});

test("a wrong token is refused (4003), and the Agent keeps trying, backing off, without crashing", async () => {
  const { simulation, events, runUntil } = await gameWithAgent("deployment-a", { brainToken: "c".repeat(64) });
  await runUntil(() => eventsOfType(events, "connectionRejected").length >= 5, 60_000);
  const rejections = eventsOfType(events, "connectionRejected");
  expect(rejections.map((event) => event.reason)).toEqual(Array(rejections.length).fill("wrongToken"));
  const gapsMs = rejections.slice(1).map((event, index) => event.atMs - (rejections[index]?.atMs as number));
  // 1 s, 2 s, 4 s, 8 s apart, each plus the step or two a connect takes.
  for (const [index, expectedDelayMs] of [1_000, 2_000, 4_000, 8_000].entries()) {
    expect(gapsMs[index]).toBeGreaterThanOrEqual(expectedDelayMs);
    expect(gapsMs[index]).toBeLessThan(expectedDelayMs + 500);
  }
  expect(await runningFiles(simulation)).toEqual([agentFile("deployment-a")]);
});

test("when the brain drops the connection, the Agent comes back after 1 s, every time, in the same session", async () => {
  const { events, connections, runUntil } = await gameWithAgent();
  const comebackDelaysMs: number[] = [];
  // Twice: being welcomed resets the backoff, so the second comeback isn't slower.
  for (const connectionIndex of [0, 1]) {
    await runUntil(() => eventsOfType(events, "agentConnected").length === connectionIndex + 1, 10_000);
    const droppedAtMs = events.at(-1)?.atMs as number;
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
  expect(eventsOfType(events, "agentConnected").at(-1)).toMatchObject({ deploymentId: "deployment-b" });
  expect(await runningFiles(simulation)).toEqual([agentFile("deployment-b")]);
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

test("a killed Agent closes its connection", async () => {
  const { simulation, events, runUntil } = await gameWithAgent();
  await runUntil(() => eventsOfType(events, "agentConnected").length === 1, 5_000);
  const [agentProcess] = await simulation.ps("home");
  expect(await simulation.kill(agentProcess?.pid as number)).toBe(true);
  await runUntil(() => eventsOfType(events, "agentDisconnected").length === 1, 5_000);
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
  expect((await simulation.run("home", "calls-ns-from-a-handler.js")).error).toBeUndefined();
  await game.run(2_000);
  expect(await runningFiles(simulation)).toEqual([agentFile("deployment-a")]);
});
