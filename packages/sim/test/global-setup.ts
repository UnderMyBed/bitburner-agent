import { buildEngine } from "../src/engine/build.ts";

// Integration tests load dist/engine.cjs; build it first if its inputs changed.
export default async function setup(): Promise<void> {
  await buildEngine();
}
