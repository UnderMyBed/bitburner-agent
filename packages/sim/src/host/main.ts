// Entry point of a simulation process (forked by Simulation.start). Sets up the host, then answers requests.
import { writeSync } from "node:fs";
import { HOST_OPTIONS_ENV, type HostMethods, type HostStatus, type Request, type Response } from "../protocol.ts";
import { type HostOptions, installHost } from "./install.ts";

const send = (message: Response | HostStatus) => process.send?.(message);

let host: ReturnType<typeof installHost>;
try {
  host = installHost(JSON.parse(process.env[HOST_OPTIONS_ENV] ?? "") as HostOptions);
} catch (error) {
  send({ fatal: error instanceof Error ? (error.stack ?? error.message) : String(error) });
  process.exit(1);
}
const { clock, engine } = host;

const handlers: { [M in keyof HostMethods]: (params: Parameters<HostMethods[M]>[0]) => unknown } = {
  now: () => clock.now(),
  advance: async ({ ms }) => {
    await clock.advance(ms);
    return clock.now();
  },
  "diagnostics.clock": () => ({
    engineLastUpdate: engine.engineLastUpdate(),
    engineDateNow: engine.dateNow(),
    enginePerformanceNow: engine.performanceNow(),
  }),
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

process.on("message", async ({ id, method, params }: Request) => {
  try {
    const handler = handlers[method] as (params: unknown) => unknown;
    send({ id, ok: true, result: await handler(params) });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    send({ id, ok: false, error: { message: err.message, ...(err.stack ? { stack: err.stack } : {}) } });
  }
});
send({ ready: true });
