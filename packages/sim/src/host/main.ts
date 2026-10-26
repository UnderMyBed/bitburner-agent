// Entry point of a simulation process (forked by Simulation.start). Waits for its options, sets up the host and
// boots the fixture, then answers requests one at a time.
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { writeSync } from "node:fs";
import process from "node:process";
import type { EngineApi } from "../engine/api.ts";
import {
  type HostFixture,
  type HostMessage,
  type HostOptions,
  type Method,
  type Params,
  type ParentMessage,
  type Result,
  validateAdvance,
  validateHomeRam,
  validateHostOptions,
  validateRun,
  validateRunUntil,
} from "../protocol.ts";
import { events } from "./events.ts";
import { installHost } from "./install.ts";
import { heapLimit, heapUsed, startProfile, stopProfile } from "./measure.ts";
import { pinnedLocale } from "./parity/locale.ts";
import { randomState, restoreRandomState } from "./random.ts";
import { runUntil, watchBitNodeEntries } from "./run-until.ts";

const send = (message: HostMessage) => process.send?.(message);
const errorText = (error: unknown) => (error instanceof Error ? (error.stack ?? error.message) : String(error));

type Handlers = { [M in Method]: (params: Params<M>) => Result<M> | Promise<Result<M>> };

function bootFixture(engine: EngineApi, fixture: HostFixture): Promise<void> {
  switch (fixture.kind) {
    case "new":
      return engine.bootNewGame(fixture.tutorial);
    case "bitnode":
      return engine.bootBitNode(fixture.n, fixture.sourceFiles);
    case "save":
      // The game takes gzip saves as bytes and the web export as its base64 text.
      return engine.bootSave(
        fixture.format === "gzip" ? new Uint8Array(Buffer.from(fixture.data, "base64")) : fixture.data,
      );
  }
}

/**
 * Serialising a save draws from Math.random (the game builds a throwaway PlayerObject), so anything that serialises
 * must undo those draws: observing the game must not change how the run turns out.
 */
async function withoutRandomDraws<T>(serialise: () => Promise<T>): Promise<T> {
  const random = randomState();
  try {
    return await serialise();
  } finally {
    restoreRandomState(random);
  }
}

interface Host {
  handlers: Handlers;
  /** Resolves once no script module is being imported (the import barrier). */
  quiescent(): Promise<void>;
  /** Runs after every request: a request can change the game too (e.g. entering a BitNode). */
  afterRequest(): void;
}

async function start(options: HostOptions): Promise<Host> {
  validateHostOptions(options);
  const bootStarted = process.hrtime.bigint(); // real time: the virtual clock doesn't measure the host itself
  const { clock, engine, scripts, network, afterEveryTimer } = installHost(options);
  if (options.fixture) await bootFixture(engine, options.fixture);
  // Before the RFA client's timer fires (2 s after load), so it connects with these.
  if (options.gameSettings) engine.applyGameSettings(options.gameSettings);
  // From the booted game on, every BitNode entry is an event, whether a timer or a request caused it.
  const watch = options.fixture ? watchBitNodeEntries(engine) : () => {};
  watch();
  afterEveryTimer(watch);
  const bootMs = Math.round(Number(process.hrtime.bigint() - bootStarted) / 1e6);
  const booted = () => {
    if (!options.fixture) throw new Error("no game is booted: this simulation was started without a fixture");
  };

  const handlers: Handlers = {
    now: () => clock.now(),
    advance: async ({ ms }) => {
      validateAdvance(ms);
      await clock.advance(ms);
      return clock.now();
    },
    summary: () => {
      booted();
      return { virtualMs: clock.now() - options.epochMs, ...engine.gameSummary() };
    },
    stateHash: async () => {
      booted();
      // The random state and the router's pages are part of the hash: the save doesn't record them, and two equal
      // saves could still diverge (the page decides message delivery, isBusy, ns.spawn…).
      const random = randomState();
      const pages = engine.routerPages();
      const save = await withoutRandomDraws(() => engine.saveJson());
      return createHash("sha256").update(save).update(JSON.stringify({ random, pages })).digest("hex");
    },
    save: async () => {
      booted();
      return Buffer.from(await withoutRandomDraws(() => engine.saveBytes())).toString("base64");
    },
    events: ({ since }) => events(since),
    writeFile: ({ host, path, content }) => {
      booted();
      engine.writeFile(host, path, content);
    },
    staticRamUsage: ({ host, path }) => {
      booted();
      return engine.staticRamUsage(host, path);
    },
    run: ({ host, script, threads, args }) => {
      booted();
      validateRun({ threads, args });
      return engine.runScript(host, script, threads, args);
    },
    ps: ({ host }) => {
      booted();
      return engine.ps(host);
    },
    logs: ({ pid }) => {
      booted();
      return engine.scriptLogs(pid);
    },
    runUntil: (params) => {
      booted();
      validateRunUntil(params);
      return runUntil(params, { clock, engine, watch });
    },
    kill: ({ pid }) => {
      booted();
      return engine.killScript(pid);
    },
    "network.take": () => network.take(),
    "network.send": ({ connectionId, data }) => network.send(connectionId, data),
    "network.close": ({ connectionId, code, reason }) => network.close(connectionId, code, reason),
    "diagnostics.clock": () => ({
      engineLastUpdate: engine.engineLastUpdate(),
      engineDateNow: engine.dateNow(),
      enginePerformanceNow: engine.performanceNow(),
    }),
    "diagnostics.game": () => {
      booted();
      return {
        ...engine.gameDiagnostics(),
        bootMs,
        defaultLocale: new Intl.DateTimeFormat().resolvedOptions().locale,
        pinnedLocale: pinnedLocale() ?? null,
      };
    },
    "diagnostics.random": ({ count }) => ({
      math: Array.from({ length: count }, () => Math.random()),
      windowMath: Array.from({ length: count }, () => window.Math.random()),
      cryptoBytes: Array.from(crypto.getRandomValues(new Uint8Array(count))),
      windowCryptoBytes: Array.from(window.crypto.getRandomValues(new Uint8Array(count))),
      uuid: crypto.randomUUID(),
    }),
    "diagnostics.toPage": ({ page, flume }) => {
      booted();
      engine.toPage(page, flume ?? false);
    },
    "diagnostics.back": () => {
      booted();
      engine.routerBack();
    },
    "diagnostics.destroyBitNode": ({ n }) => {
      booted();
      engine.destroyBitNode(n);
    },
    "diagnostics.setHomeRam": ({ gb }) => {
      booted();
      validateHomeRam(gb);
      engine.setHomeRam(gb);
    },
    "diagnostics.bitNodeMultipliers": ({ n, level }) => engine.bitNodeMultipliers(n, level),
    "diagnostics.heap": () => heapUsed(),
    "diagnostics.heapLimit": () => heapLimit(),
    "diagnostics.profile": async ({ action }) => {
      if (action === "start") {
        await startProfile();
        return null;
      }
      return stopProfile();
    },
    "diagnostics.crash": ({ code, message }) => {
      writeSync(2, `${message}\n`);
      process.exit(code);
    },
  };
  return { handlers, quiescent: () => new Promise((resolve) => scripts.whenQuiescent(resolve)), afterRequest: watch };
}

let simHost: Host | undefined;
// Everything runs strictly one after another, and each request waits until no script module is being imported.
// Otherwise a request could observe (or change) the game part-way through an `advance`, or before a script that was
// just started has actually begun, at a point that depends on real timing: not deterministic.
let queue: Promise<void> = Promise.resolve();

process.on("message", (message: ParentMessage) => {
  queue = queue.then(async () => {
    if (message.type === "init") {
      try {
        simHost = await start(message.options);
        send({ type: "ready" });
      } catch (error) {
        send({ type: "fatal", error: errorText(error) });
        process.exit(1);
      }
      return;
    }
    const { id, method, params } = message;
    try {
      if (!simHost) throw new Error("the host is not initialised");
      await simHost.quiescent();
      const handler = simHost.handlers[method] as ((params: unknown) => unknown) | undefined;
      if (!handler) throw new Error(`unknown method ${method}`);
      let result: unknown;
      try {
        result = await handler(params);
      } finally {
        simHost.afterRequest(); // even if it threw part-way: it may still have changed the game
      }
      send({ type: "response", id, ok: true, result });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      send({
        type: "response",
        id,
        ok: false,
        error: { message: err.message, ...(err.stack ? { stack: err.stack } : {}) },
      });
    }
  });
});
