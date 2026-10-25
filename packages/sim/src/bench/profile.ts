// Summarising a CPU profile: where the time went, by function.

import { withoutMachinePaths } from "../host/paths.ts";
import type { CpuProfile } from "../protocol.ts";

export interface SelfTime {
  /** "function (file:line)", with repository paths as `<repo>/…`; just the name for native code and the VM's own entries. */
  function: string;
  ms: number;
  /** Share of all sampled time. */
  share: number;
}

/**
 * Self time per function: each sample's time goes to the function that was running, not its callers. Functions are
 * keyed by name, file and line, so the same function reached through different call paths adds up.
 */
export function topSelfTime(profile: CpuProfile, count = 15): SelfTime[] {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const micros = new Map<string, number>();
  let total = 0;
  profile.samples.forEach((id, i) => {
    const frame = nodes.get(id)?.callFrame;
    const delta = profile.timeDeltas[i] ?? 0;
    if (!frame) return;
    const where = frame.url ? ` (${withoutMachinePaths(frame.url)}:${frame.lineNumber + 1})` : "";
    const name = `${frame.functionName || "(anonymous)"}${where}`;
    micros.set(name, (micros.get(name) ?? 0) + delta);
    total += delta;
  });
  return [...micros.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([name, us]) => ({ function: name, ms: us / 1000, share: total > 0 ? us / total : 0 }));
}
