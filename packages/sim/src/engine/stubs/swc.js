// Stand-in for @swc/wasm-web, which the game uses only to transpile .ts/.jsx player scripts. Our in-game bundles are
// plain JS; TS/JSX player scripts are a documented parity gap (docs/sim/parity.md).
export function transformSync() {
  throw new Error("The headless simulator does not support .ts/.jsx player scripts");
}
export default function init() {}
