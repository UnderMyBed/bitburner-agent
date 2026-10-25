// Entry point of a simulation process (forked by Simulation.start). Waits for its options, sets up the host and
// boots the fixture, then answers requests one at a time.
import { createHash } from "node:crypto";
import { writeSync } from "node:fs";
import {
  type HostMessage,
  type HostOptions,
  type Method,
  type Params,
  type ParentMessage,
  type Result,
  validateAdvance,
  validateHostOptions,
} from "../protocol.ts";
import { installHost } from "./install.ts";
import { pinnedLocale } from "./locale.ts";

const send = (message: HostMessage) => process.send?.(message);
const errorText = (error: unknown) => (error instanceof Error ? (error.stack ?? error.message) : String(error));

type Handlers = { [M in Method]: (params: Params<M>) => Result<M> | Promise<Result<M>> };

async function start(options: HostOptions): Promise<Handlers> {
  validateHostOptions(options);
  const { clock, engine } = installHost(options);
  if (options.fixture) await engine.bootNewGame(options.fixture.tutorial);
  const booted = () => {
    if (!options.fixture) throw new Error("no game is booted: this simulation was started without a fixture");
  };

  return {
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
      return createHash("sha256")
        .update(await engine.saveJson())
        .digest("hex");
    },
    "diagnostics.clock": () => ({
      engineLastUpdate: engine.engineLastUpdate(),
      engineDateNow: engine.dateNow(),
      enginePerformanceNow: engine.performanceNow(),
    }),
    "diagnostics.game": () => {
      booted();
      return {
        tutorialRunning: engine.tutorialRunning(),
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
    "diagnostics.crash": ({ code, message }) => {
      writeSync(2, `${message}\n`);
      process.exit(code);
    },
  };
}

let handlers: Handlers | undefined;
// Everything runs strictly one after another. A request that arrived during an `advance` would otherwise observe (or
// change) the game part-way through it, at a point that depends on real IPC timing: not deterministic.
let queue: Promise<void> = Promise.resolve();

process.on("message", (message: ParentMessage) => {
  queue = queue.then(async () => {
    if (message.type === "init") {
      try {
        handlers = await start(message.options);
        send({ type: "ready" });
      } catch (error) {
        send({ type: "fatal", error: errorText(error) });
        process.exit(1);
      }
      return;
    }
    const { id, method, params } = message;
    try {
      const handler = handlers?.[method] as ((params: unknown) => unknown) | undefined;
      if (!handler) throw new Error(handlers ? `unknown method ${method}` : "the host is not initialised");
      send({ type: "response", id, ok: true, result: await handler(params) });
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
