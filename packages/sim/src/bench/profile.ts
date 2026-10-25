// Summarising a CPU profile: where the time went, by function.

import { withoutMachinePaths } from "../host/paths.ts";
import type { CpuProfile } from "../protocol.ts";

export interface SelfTime {
  /**
   * "function (file:line:column)", with repository paths as `<repo>/…`; just the name for native code and the VM's own
   * entries.
   */
  function: string;
  ms: number;
  /** Share of all sampled time. */
  share: number;
}

/**
 * Self time per function: each sample's time goes to the function that was running, not its callers. A sample's time
 * runs to the next sample (the last one's to the profile's end), as DevTools counts it. Functions are keyed by name
 * and position, so the same function reached through different call paths adds up.
 */
export function topSelfTime(profile: CpuProfile, count = 15): SelfTime[] {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const times: number[] = [];
  let at = profile.startTime;
  for (const delta of profile.timeDeltas) {
    at += delta;
    times.push(at);
  }
  const micros = new Map<string, number>();
  let total = 0;
  profile.samples.forEach((id, i) => {
    const frame = nodes.get(id)?.callFrame;
    if (!frame) return;
    const duration = (times[i + 1] ?? profile.endTime) - (times[i] as number);
    const where = frame.url
      ? ` (${withoutMachinePaths(frame.url)}:${frame.lineNumber + 1}:${frame.columnNumber + 1})`
      : "";
    const name = `${frame.functionName || "(anonymous)"}${where}`;
    micros.set(name, (micros.get(name) ?? 0) + duration);
    total += duration;
  });
  return [...micros.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([name, us]) => ({ function: name, ms: us / 1000, share: total > 0 ? us / total : 0 }));
}
