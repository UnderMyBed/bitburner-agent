// The page's WebSockets reach the parent process in lockstep (ADR 0012): browser semantics for what the game's RFA
// client and the Agent use, frames crossing only at requests, and determinism whatever real time the parent takes.
import { setTimeout as realDelay } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import type { NetworkOutboxEntry, Simulation, SimulationOptions } from "../src/simulation.ts";
import { useSimulations } from "./helpers/sim.ts";

const start = useSimulations();
const EPOCH_MS = Date.UTC(2026, 0, 1);
const CONTROL_URL = "ws://127.0.0.1:12526";

function newGame(options: Partial<SimulationOptions> = {}): Promise<Simulation> {
  return start({
    seed: 1,
    epochMs: EPOCH_MS,
    fixture: { kind: "new", tutorial: "skipped" },
    network: { listenUrls: [CONTROL_URL] },
    ...options,
  });
}

let scripts = 0;

/**
 * Starts a script whose body can call `record(value)` from anywhere, socket handlers included. The main loop prints
 * the records (handlers mustn't call `ns` while the script sleeps: the game's concurrency check would kill it), so the
 * test reads them from the log with `records()`.
 */
async function startRecorder(
  sim: Simulation,
  body: string,
  name = `recorder${++scripts}.js`,
): Promise<{ pid: number; records(): Promise<unknown[]> }> {
  await sim.writeFile(
    "home",
    name,
    `export async function main(ns) {
       ns.disableLog("ALL");
       const pending = [];
       const record = (value) => pending.push(value);
       ${body}
       for (;;) {
         await ns.asleep(1);
         while (pending.length > 0) ns.print("record:" + JSON.stringify(pending.shift()));
       }
     }`,
  );
  const { pid, error } = await sim.run("home", name);
  expect(error).toBeUndefined();
  return {
    pid,
    records: async () =>
      (await sim.logs(pid))
        .filter((line) => line.startsWith("record:"))
        .map((line) => JSON.parse(line.slice("record:".length)) as unknown),
  };
}

const LISTENERS = `
  socket.addEventListener("open", function (event) {
    record({ event: "open", readyState: socket.readyState, thisIsSocket: this === socket, target: event.currentTarget === socket });
  });
  socket.addEventListener("message", (event) => record({ event: "message", data: event.data, origin: event.origin }));
  socket.addEventListener("error", (event) => record({ event: "error", readyState: socket.readyState, target: event.target === socket }));
  socket.addEventListener("close", (event) =>
    record({ event: "close", code: event.code, reason: event.reason, wasClean: event.wasClean, readyState: socket.readyState, isWebSocket: event.currentTarget instanceof WebSocket }));`;

describe("a socket to a listening URL", () => {
  test("opens, exchanges text both ways, and closes from the parent, with the browser's event order", async () => {
    const sim = await newGame();
    const recorder = await startRecorder(
      sim,
      `const socket = new WebSocket("${CONTROL_URL}");
       record({ constructed: socket.readyState, url: socket.url, constants: [WebSocket.CONNECTING, socket.OPEN, WebSocket.CLOSING, socket.CLOSED] });
       ${LISTENERS}
       socket.onopen = () => socket.send("hello from the page");`,
    );
    await sim.advance(10);
    const opened = await sim.network.take();
    expect(opened.map(({ atMs, ...entry }) => entry)).toEqual([
      { connectionId: 1, type: "connect", url: `${CONTROL_URL}/` },
      { connectionId: 1, type: "message", data: "hello from the page" },
    ]);
    // The open arrives 1 virtual ms after the connect, and the page's frame goes out from the open handler.
    const [connect, message] = opened as [NetworkOutboxEntry, NetworkOutboxEntry];
    expect(message.atMs - connect.atMs).toBe(1);

    expect(await sim.network.send(1, "hello from the parent")).toBe(true);
    await sim.advance(10);
    expect(await sim.network.close(1, 4000, "bye")).toBe(true);
    await sim.advance(10);
    expect(await recorder.records()).toEqual([
      {
        constructed: 0,
        url: `${CONTROL_URL}/`,
        constants: [0, 1, 2, 3],
      },
      { event: "open", readyState: 1, thisIsSocket: true, target: true },
      { event: "message", data: "hello from the parent", origin: CONTROL_URL },
      { event: "close", code: 4000, reason: "bye", wasClean: true, readyState: 3, isWebSocket: true },
    ]);
    // Closed: a later send from the parent is dropped, as on a closed connection.
    expect(await sim.network.send(1, "too late")).toBe(false);
  });

  test("closes from the page: CLOSING at once, the close event later, and the close in the outbox", async () => {
    const sim = await newGame();
    const recorder = await startRecorder(
      sim,
      `const socket = new WebSocket("${CONTROL_URL}");
       ${LISTENERS}
       socket.onopen = () => {
         socket.close(1000, "done");
         record({ afterClose: socket.readyState });
         socket.send("dropped after close");
       };`,
    );
    await sim.advance(10);
    expect((await sim.network.take()).map(({ atMs, ...entry }) => entry)).toEqual([
      { connectionId: 1, type: "connect", url: `${CONTROL_URL}/` },
      { connectionId: 1, type: "close", code: 1000, reason: "done" },
    ]);
    expect(await recorder.records()).toEqual([
      { event: "open", readyState: 1, thisIsSocket: true, target: true },
      { afterClose: 2 },
      { event: "close", code: 1000, reason: "done", wasClean: true, readyState: 3, isWebSocket: true },
    ]);
  });

  test("a close without a code reports 1005, as a browser does", async () => {
    const sim = await newGame();
    const recorder = await startRecorder(
      sim,
      `const socket = new WebSocket("${CONTROL_URL}");
       socket.onopen = () => socket.close();
       socket.onclose = (event) => record({ code: event.code, wasClean: event.wasClean });`,
    );
    await sim.advance(10);
    expect(await recorder.records()).toEqual([{ code: 1005, wasClean: true }]);
    expect((await sim.network.take()).at(-1)).toMatchObject({ type: "close", code: null, reason: "" });
  });

  test("a frame the parent sends before the open arrives after it, as a server can't send first", async () => {
    const sim = await newGame();
    const recorder = await startRecorder(sim, `const socket = new WebSocket("${CONTROL_URL}");\n${LISTENERS}`);
    // The script has connected (it ran before this request), and its open is due 1 ms later.
    expect((await sim.network.take()).map((entry) => entry.type)).toEqual(["connect"]);
    expect(await sim.network.send(1, "early")).toBe(true);
    await sim.advance(10);
    expect(await recorder.records()).toEqual([
      { event: "open", readyState: 1, thisIsSocket: true, target: true },
      { event: "message", data: "early", origin: CONTROL_URL },
    ]);
  });

  test("the parent closing a socket that hasn't opened yet fails it, as a refused handshake does", async () => {
    const sim = await newGame();
    const recorder = await startRecorder(sim, `const socket = new WebSocket("${CONTROL_URL}");\n${LISTENERS}`);
    // The script starts on the next advance; stop before the open is delivered.
    await sim.advance(0);
    expect(await sim.network.close(1, 4003, "refused")).toBe(true);
    await sim.advance(10);
    expect(await recorder.records()).toEqual([
      { event: "error", readyState: 3, target: true },
      { event: "close", code: 1006, reason: "", wasClean: false, readyState: 3, isWebSocket: true },
    ]);
  });
});

describe("a socket to a URL nobody listens on", () => {
  test("fails as a refused connection: error, then close 1006, and nothing reaches the parent", async () => {
    const sim = await newGame();
    const recorder = await startRecorder(sim, `const socket = new WebSocket("ws://127.0.0.1:9");\n${LISTENERS}`);
    await sim.advance(10);
    expect(await recorder.records()).toEqual([
      { event: "error", readyState: 3, target: true },
      { event: "close", code: 1006, reason: "", wasClean: false, readyState: 3, isWebSocket: true },
    ]);
    expect(await sim.network.take()).toEqual([]);
  });

  test("a listening URL matches exactly: localhost isn't 127.0.0.1", async () => {
    const sim = await newGame();
    const recorder = await startRecorder(
      sim,
      `const socket = new WebSocket("ws://localhost:12526");\nsocket.onclose = (event) => record(event.code);`,
    );
    await sim.advance(10);
    expect(await recorder.records()).toEqual([1006]);
  });
});

describe("errors, as a browser raises them", () => {
  test("send while connecting, bad close codes and reasons, bad URLs", async () => {
    const sim = await newGame();
    const recorder = await startRecorder(
      sim,
      `const recordOutcome = (label, action) => { try { action(); record({ [label]: "no error" }); } catch (error) { record({ [label]: error.name }); } };
       const socket = new WebSocket("${CONTROL_URL}");
       recordOutcome("sendWhileConnecting", () => socket.send("x"));
       recordOutcome("closeCode999", () => socket.close(999));
       recordOutcome("closeReasonTooLong", () => socket.close(1000, "x".repeat(124)));
       recordOutcome("httpUrl", () => new WebSocket("http://127.0.0.1:12526"));
       recordOutcome("notAUrl", () => new WebSocket("not a url"));`,
    );
    await sim.advance(10);
    expect(await recorder.records()).toEqual([
      { sendWhileConnecting: "InvalidStateError" },
      { closeCode999: "InvalidAccessError" },
      { closeReasonTooLong: "SyntaxError" },
      { httpUrl: "SyntaxError" },
      { notAUrl: "SyntaxError" },
    ]);
  });

  test("the parts neither the RFA client nor the Agent use fail fast", async () => {
    const sim = await newGame();
    const recorder = await startRecorder(
      sim,
      `const recordOutcome = (label, action) => { try { action(); record({ [label]: "no error" }); } catch (error) { record({ [label]: error.message }); } };
       recordOutcome("subProtocol", () => new WebSocket("${CONTROL_URL}", "chat"));
       const socket = new WebSocket("${CONTROL_URL}");
       recordOutcome("binaryType", () => { socket.binaryType = "arraybuffer"; });
       socket.onopen = () => recordOutcome("binaryFrame", () => socket.send(new Uint8Array(1)));`,
    );
    await sim.advance(10);
    const notSupported = "not supported in the simulator";
    const records = (await recorder.records()) as Record<string, string>[];
    expect(records.map((record) => Object.keys(record)[0])).toEqual(["subProtocol", "binaryType", "binaryFrame"]);
    for (const record of records) expect(Object.values(record)[0]).toContain(notSupported);
  });

  test("the parent can't address a connection that never existed", async () => {
    const sim = await newGame();
    await expect(sim.network.send(7, "x")).rejects.toThrow(/no connection 7/);
    await expect(sim.network.close(7)).rejects.toThrow(/no connection 7/);
  });
});

test("a socket outlives the script that opened it, as in a browser", async () => {
  const sim = await newGame();
  const opener = await startRecorder(
    sim,
    `const socket = new WebSocket("${CONTROL_URL}");
     socket.onmessage = (event) => { globalThis.lastFrame = event.data; };`,
  );
  await sim.advance(10);
  expect(await sim.kill(opener.pid)).toBe(true);
  expect(await sim.network.send(1, "after the script died")).toBe(true);
  await sim.advance(10);
  const reader = await startRecorder(sim, "record(globalThis.lastFrame);");
  await sim.advance(10);
  expect(await reader.records()).toEqual(["after the script died"]);
});

describe("determinism", () => {
  const CHATTY_SCRIPT = `const socket = new WebSocket("${CONTROL_URL}");
     let count = 0;
     socket.onopen = () => setInterval(() => socket.send("tick " + ++count), 100);
     socket.onmessage = (event) => record(event.data);`;

  async function runWithSteps(stepsMs: number[]): Promise<{ outbox: unknown[]; hash: string }> {
    const sim = await newGame();
    // The same name in every run: it's part of the save, so of the state hash.
    await startRecorder(sim, CHATTY_SCRIPT, "chatty.js");
    const outbox: unknown[] = [];
    for (const step of stepsMs) {
      await sim.advance(step);
      outbox.push(...(await sim.network.take()));
    }
    return { outbox, hash: await sim.stateHash() };
  }

  test("with nothing sent from the parent, step sizes don't matter", async () => {
    const totalMs = 3_000;
    const oneStep = await runWithSteps([totalMs]);
    const secondSteps = await runWithSteps(Array.from({ length: totalMs / 1_000 }, () => 1_000));
    const shortSteps = await runWithSteps(Array.from({ length: totalMs / 7 }, () => 7).concat([totalMs % 7]));
    expect(oneStep.outbox.length).toBeGreaterThan(25);
    expect(secondSteps).toEqual(oneStep);
    expect(shortSteps).toEqual(oneStep);
  });

  async function runEcho(realReplyDelayMs: number): Promise<{ outbox: unknown[]; hash: string }> {
    const sim = await newGame();
    await startRecorder(sim, CHATTY_SCRIPT, "chatty.js");
    const outbox: unknown[] = [];
    for (let step = 0; step < 20; step++) {
      await sim.advance(50);
      for (const entry of await sim.network.take()) {
        outbox.push(entry);
        if (entry.type !== "message") continue;
        if (realReplyDelayMs > 0) await realDelay(realReplyDelayMs);
        await sim.network.send(entry.connectionId, `echo ${entry.data}`);
      }
    }
    return { outbox, hash: await sim.stateHash() };
  }

  test("with the parent replying between steps, real time never matters", async () => {
    const prompt = await runEcho(0);
    const slow = await runEcho(20);
    expect(prompt.outbox.length).toBeGreaterThan(5);
    expect(slow).toEqual(prompt);
  });
});

describe("options", () => {
  test("listen URLs must be ws: or wss: URLs, and game settings known names with valid values", async () => {
    await expect(newGame({ network: { listenUrls: ["http://127.0.0.1:1"] } })).rejects.toThrow(/ws: or wss: URLs/);
    await expect(newGame({ network: { listenUrls: ["not a url"] } })).rejects.toThrow(/ws: or wss: URLs/);
    await expect(newGame({ gameSettings: { RemoteFileApiPort: 70_000 } })).rejects.toThrow(/port number/);
    await expect(newGame({ gameSettings: { RemoteFileApiReconnectionDelay: -1 } })).rejects.toThrow(/seconds/);
    await expect(
      newGame({ gameSettings: { AutosaveInterval: 60 } as unknown as SimulationOptions["gameSettings"] }),
    ).rejects.toThrow(/gameSettings has no AutosaveInterval/);
  });

  test("game settings are the game's own: autoexec set here runs when the save is loaded", async () => {
    const sim = await newGame({ gameSettings: { AutoexecScript: "autoexec.js" } });
    await sim.writeFile("home", "autoexec.js", "export async function main(ns) { await ns.asleep(60_000); }");
    const loaded = await start({ seed: 1, fixture: { kind: "save", bytes: await sim.save() } });
    expect((await loaded.ps("home")).map((process) => process.filename)).toEqual(["autoexec.js"]);
  });

  test("a parent close must use a code a server can send", async () => {
    const sim = await newGame();
    await startRecorder(sim, `new WebSocket("${CONTROL_URL}");`);
    await sim.advance(10);
    await expect(sim.network.close(1, 1006)).rejects.toThrow(/close code/);
  });
});

describe("the game's own RFA client", () => {
  const RFA_URL = "ws://127.0.0.1:12525";

  async function rfaGame(reconnectionDelaySeconds = 0): Promise<Simulation> {
    return newGame({
      network: { listenUrls: [RFA_URL] },
      gameSettings: {
        RemoteFileApiAddress: "127.0.0.1",
        RemoteFileApiPort: 12525,
        RemoteFileApiReconnectionDelay: reconnectionDelaySeconds,
      },
    });
  }

  async function request(sim: Simulation, connectionId: number, method: string, params: object): Promise<unknown> {
    await sim.network.send(connectionId, JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
    await sim.advance(1);
    const replies = (await sim.network.take()).filter((entry) => entry.type === "message");
    expect(replies).toHaveLength(1);
    return JSON.parse((replies[0] as { data: string }).data) as unknown;
  }

  test("connects 2 s after the page loads and answers real requests through the parent", async () => {
    const sim = await rfaGame();
    await sim.advance(1_999);
    expect(await sim.network.take()).toEqual([]);
    await sim.advance(1);
    const [connect] = await sim.network.take();
    expect(connect).toMatchObject({ type: "connect", url: `${RFA_URL}/`, connectionId: 1 });
    await sim.advance(1); // the open

    await sim.writeFile("home", "hello.js", "export async function main(ns) { ns.run('x.js'); }");
    expect(await request(sim, 1, "getFileNames", { server: "home" })).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: expect.arrayContaining(["hello.js"]),
    });
    expect(await request(sim, 1, "calculateRam", { server: "home", filename: "hello.js" })).toMatchObject({
      result: 2.6,
    });
  });

  test("with port 0, the default, nothing connects", async () => {
    const sim = await newGame({ network: { listenUrls: [RFA_URL] } });
    await sim.advance(5_000);
    expect(await sim.network.take()).toEqual([]);
  });

  test("reconnects after the reconnection delay when the parent closes it, through the game's own retry", async () => {
    const sim = await rfaGame(5);
    await sim.advance(2_001);
    expect((await sim.network.take()).map((entry) => entry.type)).toEqual(["connect"]);
    await sim.network.close(1, 1001, "brain restarting");
    await sim.advance(4_999);
    expect(await sim.network.take()).toEqual([]);
    await sim.advance(2);
    expect(await sim.network.take()).toMatchObject([{ type: "connect", connectionId: 2 }]);
  });
});
