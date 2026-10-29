// The brain's side of the batcher (#205, M4 phase A slice A7b): its dashboard switch, off by default, and a fixed plan
// while it's on: core's `batchPlan` (#204) on the hack loop's target and hosts, at the hacking level of the latest
// medium snapshot. The brain's own choice of target, share and spacing comes in #206; until then the batcher batches
// what the hack loop would hack, on the servers it would hack from, which the hack loop then leaves to it (it still
// roots). `DesiredStateController` (desired-state.ts) sends it.
import {
  BATCHER_RAM_BUDGET_GB,
  type BatcherHealth,
  type BatcherState,
  batchPlan,
  batchRamGb,
  type HackingPlayer,
  type HackingTarget,
  type MediumSnapshotData,
  type StaticSnapshotData,
} from "@bitburner-agent/core";
import { readSwitch } from "./switches.ts";
import type { TelemetryStore } from "./telemetry-store.ts";

export const BATCHER_ENABLED_SETTING = "batcher.enabled";

/** The dashboard's switch: off unless the owner turned it on (#205), as the hack loop stays the default until #206. */
export function readBatcherEnabled(store: TelemetryStore): boolean {
  return readSwitch(store, BATCHER_ENABLED_SETTING, false);
}

/**
 * What home keeps for the Agent and its workers, GB: a fresh save's 8, of which the Agent and its largest worker take
 * 7.65 (architecture §14, Q1). The batcher runs on home only with its budget free beyond it: home of 16 GB or more.
 */
export const HOME_KEPT_FOR_THE_AGENT_GB = 8;

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** The player's hacking figures from the medium snapshot (the Agent's word), or null if any is missing. */
function hackingPlayerOf(player: unknown): HackingPlayer | null {
  const { skills, mults } = (player ?? {}) as { skills?: Record<string, unknown>; mults?: Record<string, unknown> };
  const hacking = skills?.hacking;
  const intelligence = skills?.intelligence;
  const multNames = ["hacking_chance", "hacking_speed", "hacking_money", "hacking_grow"] as const;
  if (!isNumber(hacking) || !isNumber(intelligence) || !multNames.every((name) => isNumber(mults?.[name]))) return null;
  return {
    skills: { hacking, intelligence },
    mults: Object.fromEntries(multNames.map((name) => [name, mults?.[name] as number])) as HackingPlayer["mults"],
  };
}

/** A target's figures from the static snapshot, or null if any is missing. */
function figuresOf(staticData: StaticSnapshotData, target: string): HackingTarget | null {
  const server = staticData.servers.find((each) => each?.hostname === target);
  const { moneyMax, minDifficulty, requiredHackingSkill, serverGrowth } = server ?? {};
  if (![moneyMax, minDifficulty, requiredHackingSkill, serverGrowth].every(isNumber)) return null;
  return { moneyMax, minDifficulty, requiredHackingSkill, serverGrowth } as HackingTarget;
}

/**
 * The batcher's desired state (#205), on `target` and `hosts` (the hack loop's), or why there's none:
 * - **where it runs:** home, when its RAM in the medium snapshot leaves the batcher's budget (`BATCHER_RAM_BUDGET_GB`)
 *   beyond what home keeps for the Agent; otherwise the host with the most RAM, which then has that much less for
 *   operations;
 * - **its plan:** core's `batchPlan` on the hosts' RAM (`batchRamGb`), at the hacking level and multipliers of the
 *   medium snapshot. Its share and spacing go in the config; the batcher works out each batch's threads itself.
 */
export function planBatcher(
  staticData: StaticSnapshotData,
  mediumData: MediumSnapshotData,
  target: string,
  hosts: string[],
): { batcher: BatcherState } | { batcher: null; why: string } {
  const player = hackingPlayerOf(mediumData.player);
  if (player === null) return { batcher: null, why: "the medium snapshot has no hacking figures for the player" };
  const figures = figuresOf(staticData, target);
  if (figures === null) return { batcher: null, why: `the static snapshot has no figures for ${target}` };
  const ramOf = new Map(
    mediumData.servers
      .filter((server) => typeof server?.hostname === "string" && isNumber(server.maxRam))
      .map((server) => [server.hostname, server.maxRam]),
  );
  const hostsRam = hosts.map((host) => [host, ramOf.get(host) ?? 0] as const).filter(([, ram]) => ram > 0);
  if (hostsRam.length === 0) return { batcher: null, why: "no host with RAM" };
  const homeRam = ramOf.get("home") ?? 0;
  const onHome = homeRam - HOME_KEPT_FOR_THE_AGENT_GB >= BATCHER_RAM_BUDGET_GB;
  const largest = [...hostsRam].sort(([a, ramA], [b, ramB]) => ramB - ramA || (a < b ? -1 : 1))[0] as readonly [
    string,
    number,
  ];
  if (!onHome && largest[1] < BATCHER_RAM_BUDGET_GB) return { batcher: null, why: "no host holds the batcher" };
  const runOn = onHome ? "home" : largest[0];
  const operationsRam = hostsRam.map(([host, ram]) => (host === runOn ? ram - BATCHER_RAM_BUDGET_GB : ram));
  const plan = batchPlan(figures, player, batchRamGb(operationsRam));
  if (plan === null) return { batcher: null, why: `no batch on ${target} fits the hosts' RAM, or it can't be hacked` };
  return {
    batcher: {
      runOn,
      config: {
        target,
        figures,
        player: { intelligence: player.skills.intelligence, mults: player.mults },
        hosts: hostsRam.map(([host]) => host),
        hackShare: plan.hackShare,
        spacingMs: plan.spacingMs,
      },
    },
  };
}

/** The batcher on the dashboard (#205): the switch, what the brain sent, why nothing, and the health last reported. */
export interface BatcherView {
  enabled: boolean;
  /** Where it runs, its target and hosts, its share and spacing, as sent; null when none is. */
  sent: { runOn: string; target: string; hosts: number; hackShare: number; spacingMs: number } | null;
  /** Why none is sent while on (no snapshots yet, no target, no room), or null. */
  why: string | null;
  /** The batcher's health in the latest fast snapshot, or null. */
  health: BatcherHealth | null;
}

/** The view, from the switch, what was sent (or why not) and the latest fast snapshot's health. */
export function batcherViewOf(
  enabled: boolean,
  sent: BatcherState | null,
  why: string | null,
  health: BatcherHealth | null | undefined,
): BatcherView {
  return {
    enabled,
    sent:
      sent === null
        ? null
        : {
            runOn: sent.runOn,
            target: sent.config.target,
            hosts: sent.config.hosts.length,
            hackShare: sent.config.hackShare,
            spacingMs: sent.config.spacingMs,
          },
    why: enabled ? why : null,
    health: health ?? null,
  };
}
