// What each of the batcher's operation scripts does (#204): lands its call at the moment the batcher named, then
// records the landing on the batcher's landing port. Arguments: the target, the landing time (the game's clock,
// `Date.now()`), the port and the batcher's id for this part. The call's time is fixed when it's called, from the
// target's security then (NetscriptHelpers.tsx:544; NetscriptFunctions.ts:277, :353), and the matching `get…Time`
// returns the same (NetscriptFunctions.ts:1263-1277): read in the same turn, it lands the call at the moment named,
// however late the script started or high the security is, by `additionalMsec` (NetscriptHelpers.tsx:362-368), as long
// as it started in time. If it didn't, the record says so: a hack then doesn't run (one landing out of order is what
// drains a target), a grow or weaken still does, late. The entry passes its own call and time, so each script is
// charged only its own (the game counts the functions a script's code names).
import type { LandingRecord } from "@bitburner-agent/core";
import type { NS } from "../ns.ts";

export async function landOperation(
  ns: NS,
  timeMsOf: (target: string) => number,
  call: (target: string, options: { additionalMsec: number }) => Promise<number>,
  { runLate }: { runLate: boolean },
): Promise<void> {
  ns.disableLog("ALL");
  const [target, landAt, port, id] = [String(ns.args[0]), Number(ns.args[1]), Number(ns.args[2]), String(ns.args[3])];
  const additionalMsec = landAt - Date.now() - timeMsOf(target);
  const late = additionalMsec < 0;
  const result = !late || runLate ? await call(target, { additionalMsec: Math.max(0, additionalMsec) }) : 0;
  const record: LandingRecord = { id, landAt, landedAt: Date.now(), result, late };
  ns.writePort(port, record);
}
