export type Sfc32State = [number, number, number, number];

/** A seeded random-number function, like Math.random, whose position can be saved and restored. */
export interface Rng {
  (): number;
  state(): Sfc32State;
  setState(state: Sfc32State): void;
}

/**
 * sfc32 ("small fast chaotic", from PractRand), seeded through splitmix32 and warmed up by 12 rounds.
 * Returns floats in [0, 1), like Math.random. Every seeded scenario depends on this exact stream.
 */
export function sfc32(seed: number): Rng {
  let s = seed >>> 0;
  const splitmix32 = () => {
    s = (s + 0x9e3779b9) | 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    return (z ^ (z >>> 15)) >>> 0;
  };
  let a = splitmix32();
  let b = splitmix32();
  let c = splitmix32();
  let d = splitmix32();
  const next = () => {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 12; i++) next();
  return Object.assign(next, {
    state: (): Sfc32State => [a, b, c, d],
    setState: (state: Sfc32State) => {
      [a, b, c, d] = state;
    },
  });
}
