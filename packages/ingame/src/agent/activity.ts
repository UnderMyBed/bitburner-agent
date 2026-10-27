// What the Agent's activities share (#134, #136): when the next try is due, counted in rounds so a clock that steps
// doesn't skew it, and a log that notes only changes, so a steady activity doesn't fill it.
import type { NS } from "../ns.ts";

export function createRoundSchedule() {
  /** 0: due this round. */
  let roundsUntilDue = 0;
  return {
    /** Whether it's due this round; a round that isn't counts toward the next. */
    takeRound(): boolean {
      if (roundsUntilDue === 0) return true;
      roundsUntilDue -= 1;
      return false;
    },
    dueNow(): void {
      roundsUntilDue = 0;
    },
    /** Due again `rounds` rounds from this one. */
    dueAfter(rounds: number): void {
      roundsUntilDue = rounds - 1;
    },
    /** Not due until `dueNow`. */
    never(): void {
      roundsUntilDue = Number.POSITIVE_INFINITY;
    },
  };
}

/** Logs `agent: <name>: <line>` when the line differs from the last one. */
export function createChangeLog(ns: NS, name: string): (line: string) => void {
  let lastLine = "";
  return (line) => {
    if (line !== lastLine) ns.print(`agent: ${name}: ${line}`);
    lastLine = line;
  };
}
