// Stand-in for @swc/wasm-web, which the game uses only to transpile .ts/.jsx player scripts. Our in-game code is
// plain JS, so TS/JSX player scripts are a known gap of the headless simulator (packages/sim/README.md).
export function transformSync() {
  throw new Error("The headless simulator does not support .ts/.jsx player scripts");
}
export default function init() {}
