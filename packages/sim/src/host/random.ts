import { type Rng, type Sfc32State, sfc32 } from "./rng.ts";

const INTEGER_ARRAYS = [
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  BigInt64Array,
  BigUint64Array,
];
/** Web Crypto's per-call limit. */
const MAX_BYTES = 65536;

/**
 * Replaces every source of randomness the game can reach with seeded streams: Math.random (jsdom's window shares
 * Node's Math) and Web Crypto's getRandomValues/randomUUID (window.crypto follows the global, see installDom).
 * Crypto gets its own stream, so code that draws crypto bytes doesn't shift the Math.random sequence.
 */
let streams: { math: Rng; crypto: Rng } | undefined;

/** Where both seeded streams are; restoring it undoes every draw made since. */
export interface RandomState {
  math: Sfc32State;
  crypto: Sfc32State;
}

export function randomState(): RandomState {
  if (!streams) throw new Error("seeded randomness is not installed");
  return { math: streams.math.state(), crypto: streams.crypto.state() };
}

export function restoreRandomState(state: RandomState): void {
  if (!streams) throw new Error("seeded randomness is not installed");
  streams.math.setState(state.math);
  streams.crypto.setState(state.crypto);
}

export function installSeededRandom(seed: number): void {
  const math = sfc32(seed);
  const byte = sfc32((seed ^ 0x5bd1e995) >>> 0);
  streams = { math, crypto: byte };
  Math.random = math;

  // Same contract as Web Crypto's getRandomValues, including its errors.
  const getRandomValues = <T extends ArrayBufferView | null>(array: T): T => {
    if (!array || !INTEGER_ARRAYS.some((type) => array instanceof type)) {
      throw new DOMException("getRandomValues() only accepts integer typed arrays", "TypeMismatchError");
    }
    if (array.byteLength > MAX_BYTES) {
      throw new DOMException(`getRandomValues() can't generate more than ${MAX_BYTES} bytes`, "QuotaExceededError");
    }
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(byte() * 256);
    return array;
  };
  const randomUUID = (): `${string}-${string}-${string}-${string}-${string}` => {
    const b = getRandomValues(new Uint8Array(16));
    b[6] = ((b[6] ?? 0) & 0x0f) | 0x40; // version 4
    b[8] = ((b[8] ?? 0) & 0x3f) | 0x80; // RFC 4122 variant
    const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  for (const [name, value] of Object.entries({ getRandomValues, randomUUID })) {
    Object.defineProperty(globalThis.crypto, name, { configurable: true, writable: true, value });
  }
}
