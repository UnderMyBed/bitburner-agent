/**
 * Sharing spare RAM for faction reputation (#224, M4 phase A): the game's share bonus, and where a round of the
 * batcher's share threads goes. `ns.share()` holds its script's threads for 10 s (`ShareBonusTime`,
 * `NetworkShare/Share.ts:8`), during which they raise the reputation every faction work earns: all of hacking work's,
 * and the (hacking + intelligence) term of field and security work's (`PersonObjects/formulas/reputation.ts:16-52`).
 * Pure, so the in-game batcher (`entries/batcher.ts`), which launches the threads, and the brain, which counts the
 * bonus in its faction work rate, use the same functions. Never `share` as a name in code the batcher runs: the game
 * would charge `share`'s 2.4 GB for it (Script/RamCalculations.ts:407-440).
 */
import { BATCH_RAM_RELEASE_MS, type RamHold, threadsThatFit } from "./batcher.ts";
import { coreBonus } from "./hacking-ceiling.ts";

/** The share script, beside the batcher in its folder: one `await ns.share()`, then it exits (legacy's share.js). */
export const SHARE_SCRIPT_NAME = "batch-share.js";
/** Its RAM a thread, GB: 1.6 base + `share` 2.4 (RamCostGenerator.ts:566). ram-budget.json's, which a test measures. */
export const SHARE_RAM_GB = 4;
/** How long a call holds its threads, ms (`ShareBonusTime`, `NetworkShare/Share.ts:8`). */
export const SHARE_TIME_MS = 10_000;
/**
 * The batcher starts a round of share at most this often, ms: legacy daemon.js's `share-cooldown`, and half a call's
 * `SHARE_TIME_MS`, so a round's half of the share starts as the half before the last ends (#242: `shareRoundThreads`).
 */
export const SHARE_ROUND_MS = 5_000;
/**
 * The most of the batches' hosts' RAM in use, share included, a round may take it to: legacy's `share-max-utilization`.
 * Home, beside them, isn't counted (#242).
 */
export const SHARE_MOST_USE = 0.8;
/**
 * The margin on the batches' peak in the reserve the brain sends (`shareReserveGb`): the batcher replans each batch at
 * the live hacking level, and a batch's leads grow with the largest still landing (core's `batchHoldsMs`), so the peak
 * moves a little from the plan's. The reserve comes off the RAM free, which the batches in flight already hold, so it
 * is counted twice: the share can only ever be short, never the batches. A half of the share costs its bonus ln 2/25,
 * 0.028.
 */
export const SHARE_RESERVE_MARGIN = 0.25;

/**
 * What the share threads on one host add to the game's `shareThreads` (`calculateEffectiveSharedThreads`,
 * `NetworkShare/Share.ts:22-25`): its threads × the intelligence bonus at weight 2 (`formulas/intelligence.ts:1-3`)
 * × the host's core bonus (`getCoreBonus`, `Server/ServerHelpers.ts:287-290`).
 */
export function effectiveShareThreads(threads: number, cores: number, intelligence: number): number {
  return threads * (1 + (2 * intelligence ** 0.8) / 600) * coreBonus(cores);
}

/**
 * The game's share bonus for `power`, its `shareThreads` (`calculateShareBonus`, `NetworkShare/Share.ts:43-49`):
 * 1 + ln(power)/25, and 1 where that isn't finite.
 */
export function shareBonusOfPower(power: number): number {
  const bonus = 1 + Math.log(power) / 25;
  return Number.isFinite(bonus) ? bonus : 1;
}

/**
 * The share bonus while `parts` share at once (#224): the game's `shareThreads` is 1 plus each call's effective
 * threads (`startSharing`, `NetworkShare/Share.ts:6`, `:27-41`), so with none it's 1.
 */
export function shareBonus(parts: readonly { threads: number; cores: number }[], intelligence: number): number {
  let power = 1;
  for (const { threads, cores } of parts) power += effectiveShareThreads(threads, cores, intelligence);
  return shareBonusOfPower(power);
}

/**
 * A host a round may use, its RAM in GB as `getServerMaxRam` and `getServerUsedRam` give it, and whether the batches
 * run there: home, where they don't (the hack loop's hosts never include it), shares beside them, outside the reserve.
 */
export interface HostRamUse {
  host: string;
  maxGb: number;
  usedGb: number;
  /** The batches' host, whose free RAM the reserve is kept on; absent, it is. */
  batches?: boolean;
}

/**
 * Where a round of share threads goes (#224), and the room it had: the free RAM of the batches' hosts less `reserveGb`
 * (theirs and the next target's, `shareReserveGb`), no more than takes their use to `SHARE_MOST_USE` of their RAM; and
 * that of any other host (home, beside them), less `homeKeptGb` on home (the Agent's and its workers'). The cap counts
 * the batches' hosts alone (#242): it leaves the batches room on their own hosts, and home's share can't take theirs
 * (#230). Counted over all the hosts, it let run #3's batches on 82% of 26.2 PB of cloud servers leave 1 PB of home
 * idle for 51 minutes. At most `mostThreads` threads (a round takes half of what the share may hold, #242). The other
 * hosts first, then the batches' hosts with the least free first, so the large keep room for whole batch operations
 * (`placeThreads`), never more on them than their room; whole threads (`threadsThatFit`). None when the room holds no
 * thread.
 */
export function shareRound(
  hosts: readonly HostRamUse[],
  reserveGb: number,
  homeKeptGb: number,
  mostThreads = Number.POSITIVE_INFINITY,
): { placed: { host: string; threads: number }[]; roomGb: number } {
  const freeOf = (each: HostRamUse) =>
    Math.max(0, each.maxGb - each.usedGb - (each.host === "home" ? Math.max(0, homeKeptGb) : 0));
  const forBatches = (each: HostRamUse) => each.batches !== false;
  let batchesTotalGb = 0;
  let batchesUsedGb = 0;
  let batchesFreeGb = 0;
  let otherFreeGb = 0;
  for (const each of hosts) {
    if (forBatches(each)) {
      batchesTotalGb += each.maxGb;
      batchesUsedGb += each.usedGb;
      batchesFreeGb += freeOf(each);
    } else {
      otherFreeGb += freeOf(each);
    }
  }
  const batchesRoomGb = Math.max(
    0,
    Math.min(batchesFreeGb - Math.max(0, reserveGb), SHARE_MOST_USE * batchesTotalGb - batchesUsedGb),
  );
  const roomGb = batchesRoomGb + otherFreeGb;
  const placed: { host: string; threads: number }[] = [];
  let left = Math.min(Math.max(0, Math.floor(mostThreads)), Math.floor(roomGb / SHARE_RAM_GB + 1e-9));
  let leftOnBatches = Math.floor(batchesRoomGb / SHARE_RAM_GB + 1e-9);
  const order = [...hosts].sort(
    (a, b) => Number(forBatches(a)) - Number(forBatches(b)) || freeOf(a) - freeOf(b) || (a.host < b.host ? -1 : 1),
  );
  for (const each of order) {
    if (left === 0) break;
    const most = forBatches(each) ? Math.min(left, leftOnBatches) : left;
    const threads = Math.min(most, threadsThatFit(freeOf(each), SHARE_RAM_GB));
    if (threads === 0) continue;
    placed.push({ host: each.host, threads });
    left -= threads;
    if (forBatches(each)) leftOnBatches -= threads;
  }
  return { placed, roomGb };
}

/**
 * How many threads a round of share may start (#242): half of all the share may hold (`heldThreads`, its threads whose
 * RAM isn't yet released, and `roomThreads`, the room's), rounded up, and no more than the room. Rounds start
 * `SHARE_ROUND_MS` apart, half a call's time, so the threads run in two halves: as one ends, the other still holds, and
 * the bonus never falls to ×1.0 while the RAM it held comes back (run #3: ×1.0 in up to 39% of an hour's fast
 * snapshots), only to half its threads' (ln 2/25, 0.028, less). A round on all the room, as before, left nothing
 * sharing from its threads' end until the next round could take their RAM.
 */
export function shareRoundThreads(heldThreads: number, roomThreads: number): number {
  const room = Math.max(0, Math.floor(roomThreads));
  return Math.min(room, Math.ceil((Math.max(0, heldThreads) + room) / 2));
}

/**
 * The reserve the brain sends the batcher for sharing (#224), GB: the batches' peak on its plan (core's
 * `batchPeakRamGb`) with `SHARE_RESERVE_MARGIN`, plus the next target's RAM, if any (the batcher prepares it beside the
 * batches), rounded up to a whole GB.
 */
export function shareReserveGb(batchesPeakGb: number, nextRamGb: number): number {
  return Math.max(
    0,
    Math.ceil(Math.max(0, batchesPeakGb) * (1 + SHARE_RESERVE_MARGIN) + Math.max(0, nextRamGb) - 1e-9),
  );
}

/**
 * When a share part's script has ended and freed its RAM (#232's review): its call ends at `endsAt`, the script a
 * moment later, as an operation's does after its landing (`BATCH_RAM_RELEASE_MS`). Until then `getServerUsedRam`
 * counts it (killWorkerScript.ts:124), so it's still the batcher's own, never anyone else's.
 */
export function shareReleasedAt(part: { endsAt: number }): number {
  return part.endsAt + BATCH_RAM_RELEASE_MS;
}

/** The share parts' RAM not yet released at `nowMs`, by host, GB (#232's review). */
export function shareRamByHost(
  parts: readonly { host: string; threads: number; endsAt: number }[],
  nowMs: number,
): Map<string, number> {
  const byHost = new Map<string, number>();
  for (const part of parts) {
    if (shareReleasedAt(part) > nowMs)
      byHost.set(part.host, (byHost.get(part.host) ?? 0) + part.threads * SHARE_RAM_GB);
  }
  return byHost;
}

/** The share parts' RAM on `hosts` not yet released at `nowMs`, as held from then until their release (#232). */
export function shareRamHolds(
  parts: readonly { host: string; threads: number; endsAt: number }[],
  hosts: readonly string[],
  nowMs: number,
): RamHold[] {
  return parts
    .filter((part) => shareReleasedAt(part) > nowMs && hosts.includes(part.host))
    .map((part) => ({ gb: part.threads * SHARE_RAM_GB, fromMs: nowMs, untilMs: shareReleasedAt(part) }));
}
