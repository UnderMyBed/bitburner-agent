// The request/response protocol between a Simulation (parent) and its host process (child), over Node IPC.

export interface ClockDiagnostics {
  /** `Engine._lastUpdate`, which the engine reads from Date when its module loads. */
  engineLastUpdate: number;
  /** `Date.now()` and `performance.now()` as seen from inside the engine bundle. */
  engineDateNow: number;
  enginePerformanceNow: number;
}

export interface RandomSample {
  math: number[];
  /** Drawn through jsdom's window, whose Math and crypto are separate objects from Node's. */
  windowMath: number[];
  cryptoBytes: number[];
  windowCryptoBytes: number[];
  uuid: string;
}

/** Every method the host answers. Diagnostics exist for tests and troubleshooting. */
export interface HostMethods {
  now(params: Record<string, never>): number;
  /** Advances virtual time; returns the new virtual now. */
  advance(params: { ms: number }): number;
  "diagnostics.clock"(params: Record<string, never>): ClockDiagnostics;
  "diagnostics.random"(params: { count: number }): RandomSample;
  /** Writes `message` to stderr and exits with `code`. */
  "diagnostics.crash"(params: { code: number; message: string }): never;
}

export type Method = keyof HostMethods;
export type Params<M extends Method> = Parameters<HostMethods[M]>[0];
export type Result<M extends Method> = ReturnType<HostMethods[M]>;

export interface Request {
  id: number;
  method: Method;
  params: unknown;
}

export type Response =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { message: string; stack?: string } };

/** Sent once by the host after setup: `ready`, or the error that stopped it. */
export type HostStatus = { ready: true } | { fatal: string };

/** Passed to the host process in the SIM_HOST_OPTIONS environment variable. */
export const HOST_OPTIONS_ENV = "SIM_HOST_OPTIONS";
