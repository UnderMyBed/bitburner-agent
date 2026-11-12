// Levelling (#336, planner v0's first decision, owner decision 67): once The Red Pill is installed and w0r1d_d43m0n
// rooted, with only its hacking level missing (A8's path, ./world-daemon.ts: `worldDaemonPath`'s `daemon`), the
// planner chooses among the rules' three candidates by their estimated time to the level (core's levelling.ts): (a)
// batching for money as now, (b) levelling mode, grow or weaken loops on the server, and with the operation, earning the
// most experience a thread-second (the hack loop's hosts and home's RAM beyond what it keeps), (c) NeuroFlux Governor's
// levels the money buys (A6's count) and (#355) A6's set that adds to levelling, an install,
// w0r1d_d43m0n rooted again, then levelling mode. The least wins, with hysteresis (core's `chooseLevelling`).
// - The rates are fitted online (decision 67's "adapt on the fly"): (a) is the experience a second measured while
//   batching; (b) the formula's prediction for the RAM sent times the factor fitted from the rate measured in
//   levelling mode while its loop runs, 1 until measured (optimistic); (c) at (b)'s factor. Each measurement starts once
//   a mode has settled (the brain's first update too): the operations of the one before landed, and the first weaken
//   at the target's security. An install resets them all.
// - The choice goes to the controller (./desired-state.ts): money, the hack loop and the batcher as before; levelling,
//   the hack loop's `levelling` on the batcher's hosts, no batcher; the install, levelling meanwhile, and A6 commits the
//   install ("the hacking level", ./augmentations.ts), its irreversible gate as always. After the install the choice
//   starts again from money: w0r1d_d43m0n needs rooting again, so the money comes first, and the next install must pay
//   by the same score.
// - Each choice is a `levellingChosen` event and a log line, with the candidates' estimates: the run report's path
//   section shows them, and fails a brain that isn't on the shortest, or a chosen estimate past a computed bound
//   (./world-daemon-report.ts); with the World Daemon's switch off, warnings.
import {
  addsToLevelling,
  type BitNodeHackingMultipliers,
  chooseLevelling,
  chooseLevellingTarget,
  type HackingPlayer,
  type HackingTarget,
  hackingLevelOfExp,
  LEVEL_LOOP_RAM_GB,
  LEVELLING_CANDIDATES,
  type LevellingCandidate,
  type LevellingEstimates,
  type LevellingInputs,
  type LevellingOperation,
  type LevellingRate,
  levelLoopThreads,
  levellingEstimates,
  levellingInstallMultipliers,
  levellingPreparationMs,
  type MediumSnapshotData,
  operationTimeMs,
  type SlowSnapshotData,
  type StaticSnapshotData,
  threadsThatFit,
} from "@bitburner-agent/core";
import { batcherMultsOf, hackingPlayerOf } from "./batcher.ts";
import { describeEta } from "./factions.ts";
import { hackLoopHosts } from "./hack-loop.ts";
import { homeKeptGbOf, singularityRamMultiplierOf } from "./share.ts";
import { HACKING_EXP_GAP_MS, HACKING_EXP_WINDOW_MS, type WorldDaemonPath } from "./world-daemon.ts";

/** Stored as the choice changes (#336), for the run report. */
export const LEVELLING_CHOSEN_EVENT_KIND = "levellingChosen";

export type LevellingEvent = {
  type: typeof LEVELLING_CHOSEN_EVENT_KIND;
  atMs: number;
  mode: LevellingCandidate;
  from: LevellingCandidate;
  /** Each candidate's estimate, seconds, or null where it had none. */
  estimates: LevellingEstimates;
  target: string | null;
  /** (a)'s measured rate, at the level it was measured at, or null unmeasured. */
  money: LevellingRate | null;
  /** (b)'s fitted factor, or null unmeasured (1 taken). */
  factor: number | null;
  /** (c)'s NeuroFlux Governor levels, A6's count, or null with none offered. */
  neuroFluxLevels: number | null;
  /** (c)'s set (#355), A6's, or none: absent from a brain before #355. */
  installAugmentations?: string[];
  detail: string;
};

/**
 * How long a mode settles before its rate is measured, beyond the weakens still landing (`settleMsOf`): 60 s, the
 * Agent's hack loop converging at once on a change and again every 30 s (ingame's agent/hack-loop.ts), twice.
 */
export const LEVELLING_SETTLE_MS = 60_000;

/** The candidates in the dashboard's and the report's words. */
export const LEVELLING_CANDIDATE_WORDS: Record<LevellingCandidate, string> = {
  money: "batching for money",
  level: "levelling mode",
  install: "augmentations, then an install",
};

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * Whether the hacking level is all that's between the brain and the destroy (#336): The Red Pill installed (A8's
 * `daemon`, null before it), w0r1d_d43m0n reachable and rooted, its requirement read, and the level short of it. In
 * BN1 the requirement is 3,000, in BN4 9,000 (3000 × `WorldDaemonDifficulty`, `Server/ServerHelpers.ts:383-385`).
 */
export function levelAllThatsLeft(path: WorldDaemonPath | null): boolean {
  const daemon = path?.daemon ?? null;
  return (
    daemon?.reachable === true &&
    daemon.rooted &&
    daemon.requiredHackingLevel !== null &&
    daemon.hackingLevel < daemon.requiredHackingLevel
  );
}

/** What levelling mode would run, from the snapshots: the target, the RAM, and the player's figures. */
export interface LevellingFigures {
  /**
   * The target, its operation's experience a thread-second at its minimum security, and the operation: the one sent, a
   * grow where the medium snapshot shows the target at its minimum security, whatever its money (core's
   * `chooseLevellingTarget`: one round fills it, the security rises once, a weaken round takes it back, then grow for
   * good).
   */
  target: {
    hostname: string;
    figures: HackingTarget;
    expPerThreadSecond: number;
    operation: LevellingOperation;
  } | null;
  /** (c)'s target, the best grow at its minimum security, as after the install's preparation; null with none. */
  afterInstall: { figures: HackingTarget; expPerThreadSecond: number } | null;
  /** The player's hacking figures now, for (c)'s preparation at the levels' speed. */
  player: HackingPlayer;
  /** The batcher's hosts (`hackLoopHosts`), their RAM, and home's RAM and what it keeps, GB. */
  hosts: string[];
  hostsGb: number;
  homeGb: number;
  homeKeptGb: number;
  /** Home's level loop threads, and all of them. */
  homeThreads: number;
  threads: number;
  level: number;
  exp: number;
  levelMult: number;
}

/**
 * Levelling mode's figures from the snapshots (#336), or null where they don't say (the player's hacking figures):
 * the target, the game's rooted servers' best by experience a thread-second at its minimum security (core's
 * `chooseLevellingTarget`: a weaken needs root only); the RAM it runs on, the hack loop's hosts (`hackLoopHosts`, the
 * batcher's), and home's beyond what it keeps (`homeKeptGbOf`, as the batcher's share threads leave it: the Agent's
 * reservation stays).
 */
export function levellingFiguresOf(
  staticData: StaticSnapshotData | null,
  mediumData: MediumSnapshotData | null,
  slowData: SlowSnapshotData | null,
  hacking: BitNodeHackingMultipliers,
): LevellingFigures | null {
  if (staticData === null || mediumData === null) return null;
  const player = hackingPlayerOf(mediumData.player, hacking);
  const mults = batcherMultsOf(mediumData.player, hacking);
  const exp = (mediumData.player as { exp?: { hacking?: unknown } } | undefined)?.exp?.hacking;
  const levelMult = mults?.hacking;
  const hackingExp = mults?.hacking_exp;
  if (player === null || !isFiniteNumber(levelMult) || !isFiniteNumber(hackingExp) || !isFiniteNumber(exp)) return null;
  if (!Array.isArray(staticData.servers)) return null;
  const rooted = new Set(
    (Array.isArray(mediumData.servers) ? mediumData.servers : [])
      .filter((server) => server?.hasAdminRights === true)
      .map((server) => server.hostname),
  );
  const targets: { hostname: string; figures: HackingTarget }[] = [];
  for (const server of staticData.servers) {
    const { hostname, minDifficulty, requiredHackingSkill, baseDifficulty } = server ?? {};
    if (typeof hostname !== "string" || server.purchasedByPlayer !== false || !rooted.has(hostname)) continue;
    if (![minDifficulty, requiredHackingSkill, baseDifficulty].every(isFiniteNumber)) continue;
    targets.push({
      hostname,
      figures: {
        moneyMax: isFiniteNumber(server.moneyMax) ? server.moneyMax : 0,
        minDifficulty: minDifficulty as number,
        requiredHackingSkill: requiredHackingSkill as number,
        serverGrowth: isFiniteNumber(server.serverGrowth) ? server.serverGrowth : 0,
        baseDifficulty: baseDifficulty as number,
      },
    });
  }
  const hosts = hackLoopHosts(staticData, mediumData);
  const homeGb = mediumData.servers.find((server) => server?.hostname === "home")?.maxRam;
  const homeKeptGb = homeKeptGbOf(singularityRamMultiplierOf(slowData));
  const homeThreads = isFiniteNumber(homeGb) ? threadsThatFit(Math.max(0, homeGb - homeKeptGb), LEVEL_LOOP_RAM_GB) : 0;
  // The grow at the target's minimum security, whatever its money (#339's third pass): the weaken first, then a flip or
  // two at most (core's `chooseLevellingTarget`).
  const now = new Map(mediumData.servers.map((server) => [server?.hostname, server]));
  const mayGrow = ({ hostname, figures }: { hostname: string; figures: HackingTarget }) => {
    const server = now.get(hostname);
    return (
      figures.moneyMax > 0 && isFiniteNumber(server?.hackDifficulty) && server.hackDifficulty <= figures.minDifficulty
    );
  };
  const afterInstall = chooseLevellingTarget(
    targets.filter((target) => target.figures.moneyMax > 0),
    player,
    hackingExp,
  );
  return {
    target: chooseLevellingTarget(targets, player, hackingExp, mayGrow),
    afterInstall:
      afterInstall === null
        ? null
        : { figures: afterInstall.figures, expPerThreadSecond: afterInstall.expPerThreadSecond },
    player,
    hosts: hosts.map(({ hostname }) => hostname),
    hostsGb: hosts.reduce((total, { ram }) => total + ram, 0),
    homeGb: isFiniteNumber(homeGb) ? homeGb : 0,
    homeKeptGb,
    homeThreads,
    threads: levelLoopThreads(hosts.map(({ ram }) => ram)) + homeThreads,
    level: player.skills.hacking,
    exp,
    levelMult,
  };
}

/**
 * The candidates' inputs (core's `LevellingInputs`) from levelling mode's figures, w0r1d_d43m0n's requirement, (a)'s
 * measured rate, (b)'s fitted factor, and (c)'s levels (A6's count, null with none offered) and (#355) its set
 * (A6's, none absent). (c) is offered with a level, or a set that adds to levelling (core's
 * `addsToLevelling`).
 */
export function levellingInputsOf(
  figures: LevellingFigures,
  required: number,
  money: LevellingRate | null,
  factor: number | null,
  neuroFluxLevels: number | null,
  augmentations: readonly string[] = [],
): LevellingInputs {
  const { target, level } = figures;
  const perThread = target === null ? null : { expPerSecond: target.expPerThreadSecond, atLevel: level };
  const after = figures.afterInstall;
  const afterInstall = after === null ? null : { expPerSecond: after.expPerThreadSecond, atLevel: level };
  // The preparation at the level and speed the levels and the set give from 0 experience (core's
  // `levellingPreparationMs`).
  const preparationMs = (levels: number) => {
    if (after === null) return 0;
    const gain = levellingInstallMultipliers(levels, augmentations);
    const player = figures.player;
    const afterPlayer = {
      skills: { ...player.skills, hacking: hackingLevelOfExp(0, figures.levelMult * gain.hacking) },
      mults: { ...player.mults, hacking_speed: player.mults.hacking_speed * gain.hackingSpeed },
    };
    return levellingPreparationMs(after.figures, afterPlayer, figures.homeThreads);
  };
  const levels = neuroFluxLevels !== null && neuroFluxLevels > 0 ? neuroFluxLevels : 0;
  const offered = levels > 0 || (neuroFluxLevels !== null && addsToLevelling(augmentations));
  return {
    exp: figures.exp,
    level,
    required,
    levelMult: figures.levelMult,
    money,
    levelling:
      perThread === null
        ? null
        : { predicted: { expPerSecond: perThread.expPerSecond * figures.threads, atLevel: level }, factor },
    install:
      afterInstall === null || !offered
        ? null
        : {
            levels,
            ...(augmentations.length === 0 ? {} : { augmentations }),
            homeThreads: figures.homeThreads,
            perThread: afterInstall,
            preparationMs: preparationMs(levels),
          },
  };
}

/** "about 2,873.4 h", "about 41 min", "about 1.28e+193 h" (3 figures past a million hours), "none". */
export function describeEstimate(seconds: number | null): string {
  if (seconds === null) return "none";
  if (!Number.isFinite(seconds)) return "never";
  if (seconds / 3600 >= 1e6) return `about ${(seconds / 3600).toPrecision(3)} h`;
  return `about ${describeEta(seconds)}`;
}

/** "batching for money about 2,500.0 h, levelling mode about 1.2 h, augmentations, then an install none". */
export function describeEstimates(estimates: LevellingEstimates): string {
  return LEVELLING_CANDIDATES.map(
    (candidate) => `${LEVELLING_CANDIDATE_WORDS[candidate]} ${describeEstimate(estimates[candidate])}`,
  ).join(", ");
}

/** Medium snapshots' experience and level, for a measured rate: a gap, an install or the clock set back restart it. */
export class LevellingRateWindow {
  #samples: { atMs: number; exp: number; level: number }[] = [];

  add(atMs: number, exp: number, level: number): void {
    const last = this.#samples.at(-1);
    if (last !== undefined && (atMs <= last.atMs || atMs - last.atMs > HACKING_EXP_GAP_MS || exp < last.exp)) {
      this.#samples = [];
    }
    this.#samples.push({ atMs, exp, level });
    const old = this.#samples.findLastIndex((sample) => atMs - sample.atMs >= HACKING_EXP_WINDOW_MS);
    if (old > 0) this.#samples = this.#samples.slice(old);
  }

  clear(): void {
    this.#samples = [];
  }

  /**
   * The rate over the samples once they span a minute, at the level its rate scales from (core's `level + 50`): the
   * mean of each interval's, weighted by its length; null before.
   */
  measured(): LevellingRate | null {
    const first = this.#samples[0];
    const last = this.#samples.at(-1);
    if (first === undefined || last === undefined || last.atMs - first.atMs < 60_000) return null;
    let weighted = 0;
    for (let index = 1; index < this.#samples.length; index++) {
      const before = this.#samples[index - 1] as { atMs: number; level: number };
      const after = this.#samples[index] as { atMs: number; level: number };
      weighted += ((before.level + after.level) / 2) * (after.atMs - before.atMs);
    }
    return {
      expPerSecond: ((last.exp - first.exp) / (last.atMs - first.atMs)) * 1000,
      atLevel: weighted / (last.atMs - first.atMs),
    };
  }
}

/**
 * The time a mode takes to settle before its rate is measured (#336): `LEVELLING_SETTLE_MS`, and the longest of the
 * weakens still landing: the levelling target's at its security now (the first lands at it, `Hacking.ts:89-94`), and
 * the batcher's last target's at its security now (its waves out land within one).
 */
export function settleMsOf(
  mediumData: MediumSnapshotData,
  hacking: BitNodeHackingMultipliers,
  targets: { hostname: string; figures: HackingTarget }[],
): number {
  const player = hackingPlayerOf(mediumData.player, hacking);
  if (player === null) return LEVELLING_SETTLE_MS;
  const weakens = targets.map(({ hostname, figures }) => {
    const security = mediumData.servers.find((server) => server?.hostname === hostname)?.hackDifficulty;
    return operationTimeMs("weaken1", figures, player, isFiniteNumber(security) ? security : figures.minDifficulty);
  });
  return LEVELLING_SETTLE_MS + Math.max(0, ...weakens.filter(isFiniteNumber));
}

/** What the controller hands the rule each update. */
export interface LevellingRuleInputs {
  /** A8's path, as its last update read it, or null. */
  path: WorldDaemonPath | null;
  /** The World Daemon's switch: off, no destroy is wanted, so the level isn't between the brain and it. */
  enabled: boolean;
  staticData: StaticSnapshotData | null;
  mediumData: MediumSnapshotData | null;
  mediumGameTimeMs: number | null;
  slowData: SlowSnapshotData | null;
  hacking: BitNodeHackingMultipliers;
  /** A6's offer (#336): NeuroFlux Governor's levels the money buys, donations included; null with none. */
  neuroFluxLevels: number | null;
  /**
   * A6's offer's set (#355): what it would buy first that adds to levelling, while every install is held for the
   * destroy. Absent, none.
   */
  installAugmentations?: readonly string[];
  /** A6 committed to an install (the levelling one, once chosen). */
  installCommitted: boolean;
  /**
   * Whether the level loop runs (#336's review): the state last sent has the hack loop on and levelling, and the fast
   * snapshot's home processes show levelling mode's loop's threads (`homeThreads`), where home has room for them. Only
   * then is levelling's rate measured: a fit of a loop that isn't running would be about 0, and lock the choice on money.
   */
  levelLoop: { sent: boolean; homeThreads: number };
  /** The batcher's last target and figures, whose waves land as a mode settles; null with none sent. */
  batcherTarget: { hostname: string; figures: HackingTarget } | null;
  nowMs: number | null;
}

/** The rule's plan: the mode, and levelling mode's target and home's kept RAM while it levels. */
export interface LevellingPlan {
  mode: LevellingCandidate;
  levelling: { target: string; hosts: string[]; homeKeptGb: number; operation: LevellingOperation } | null;
}

/** What the dashboard shows (#336): whether the choice is on, the candidates, the choice and the fitted factor. */
export interface LevellingView {
  applies: boolean;
  mode: LevellingCandidate;
  estimates: LevellingEstimates | null;
  target: string | null;
  /** (b)'s factor: its measured rate against the formula's, or null unmeasured. */
  fit: { measured: number; predicted: number; factor: number } | null;
  /** The view in words, for the dashboard. */
  lines: string[];
}

/** The levelling rule (#336), as the controller runs it. */
export class LevellingRule {
  readonly #log: (line: string) => void;
  readonly #emit: (event: LevellingEvent) => void;
  #mode: LevellingCandidate = "money";
  /** The mode's rate, measured once it has settled (the game's time it may start from). */
  readonly #window = new LevellingRateWindow();
  #settledAtGameMs: number | null = null;
  /** (a)'s last measured rate, and (b)'s last fit. */
  #money: LevellingRate | null = null;
  #fit: { measured: number; predicted: number; factor: number } | null = null;
  #lastAugReset: number | null = null;
  /** The first update with a medium snapshot is past (it settles too: a restarted brain's loops still land). */
  #started = false;
  /** The level loop ran at the last update. */
  #levelLoopRan = false;
  #view: LevellingView = { applies: false, mode: "money", estimates: null, target: null, fit: null, lines: [] };

  constructor({
    log = () => {},
    emit = () => {},
  }: { log?: (line: string) => void; emit?: (event: LevellingEvent) => void }) {
    this.#log = log;
    this.#emit = emit;
  }

  view(): LevellingView {
    return this.#view;
  }

  /** The mode now: what the controller sends, and whether A6 is to commit the install. */
  mode(): LevellingCandidate {
    return this.#mode;
  }

  update(inputs: LevellingRuleInputs): LevellingPlan {
    const { mediumData, mediumGameTimeMs, slowData } = inputs;
    const lastAugReset = slowData?.resetInfo?.lastAugReset;
    const figures = levellingFiguresOf(inputs.staticData, mediumData, slowData, inputs.hacking);
    // An install (or a destroy): a new game, back to money (w0r1d_d43m0n to root again), each rate and fit afresh.
    if (isFiniteNumber(lastAugReset)) {
      if (this.#lastAugReset !== null && lastAugReset !== this.#lastAugReset) {
        if (this.#mode !== "money") this.#switch("money", inputs, null, figures, "an install reset the game");
        this.#money = null;
        this.#fit = null;
        this.#window.clear();
        this.#settledAtGameMs = null;
      }
      this.#lastAugReset = lastAugReset;
    }
    // The first update settles as a switch does: a restarted brain's level loops, or the batcher's waves, still land.
    if (!this.#started && mediumData !== null && isFiniteNumber(mediumGameTimeMs)) {
      this.#started = true;
      this.#settledAtGameMs = mediumGameTimeMs + this.#settleMs(inputs, figures);
    }
    // Levelling's rate only while the level loop runs (#336's review): no sample otherwise, and its start settles again.
    const levelLoopRuns =
      inputs.levelLoop.sent && (figures === null || figures.homeThreads === 0 || inputs.levelLoop.homeThreads > 0);
    if (this.#mode !== "money" && levelLoopRuns && !this.#levelLoopRan && isFiniteNumber(mediumGameTimeMs)) {
      this.#window.clear();
      this.#settledAtGameMs = mediumGameTimeMs + this.#settleMs(inputs, figures);
    }
    this.#levelLoopRan = levelLoopRuns;
    const measuring = this.#mode === "money" || levelLoopRuns;
    if (
      measuring &&
      figures !== null &&
      isFiniteNumber(mediumGameTimeMs) &&
      mediumGameTimeMs >= (this.#settledAtGameMs ?? 0)
    ) {
      this.#window.add(mediumGameTimeMs, figures.exp, figures.level);
    }
    const applies = inputs.enabled && levelAllThatsLeft(inputs.path);
    const required = inputs.path?.daemon?.requiredHackingLevel ?? null;
    if (!applies || figures === null || required === null) {
      if (this.#mode !== "money") {
        this.#switch("money", inputs, null, figures, `the hacking level is no longer all that's left`);
      }
      this.#view = { applies: false, mode: "money", estimates: null, target: null, fit: this.#fit, lines: [] };
      return { mode: "money", levelling: null };
    }
    // The rate measured in the mode, fitted: (a)'s, or (b)'s against the formula's for the RAM sent.
    const measured = this.#window.measured();
    const target = figures.target;
    if (measured !== null && this.#mode === "money") this.#money = measured;
    if (measured !== null && this.#mode === "level" && target !== null) {
      // For the threads running (#339's re-review): the hosts' as sent, home's as the fast snapshot shows them.
      const running = figures.threads - figures.homeThreads + inputs.levelLoop.homeThreads;
      const predicted = target.expPerThreadSecond * running * ((measured.atLevel + 50) / (figures.level + 50));
      if (predicted > 0)
        this.#fit = { measured: measured.expPerSecond, predicted, factor: measured.expPerSecond / predicted };
    }
    const augmentations = inputs.installAugmentations ?? [];
    const estimates = levellingEstimates(
      levellingInputsOf(
        figures,
        required,
        this.#money,
        this.#fit?.factor ?? null,
        inputs.neuroFluxLevels,
        augmentations,
      ),
    );
    // The install chosen stays chosen while A6 commits it; a choice that A6 can no longer commit (no levels to buy, no
    // set that adds to levelling, and not committed) is chosen afresh.
    const onOffer =
      (inputs.neuroFluxLevels ?? 0) > 0 || (inputs.neuroFluxLevels !== null && addsToLevelling(augmentations));
    const installHeld = this.#mode === "install" && (inputs.installCommitted || onOffer);
    const choice = installHeld ? "install" : chooseLevelling(estimates, this.#mode);
    if (choice !== this.#mode) this.#switch(choice, inputs, estimates, figures, null);
    this.#view = {
      applies: true,
      mode: this.#mode,
      estimates,
      target: target?.hostname ?? null,
      fit: this.#fit,
      lines: this.#lines(estimates, target?.hostname ?? null, figures, inputs),
    };
    return {
      mode: this.#mode,
      levelling:
        this.#mode === "money" || target === null
          ? null
          : {
              target: target.hostname,
              hosts: figures.hosts,
              homeKeptGb: figures.homeKeptGb,
              operation: target.operation,
            },
    };
  }

  /** How long a mode settles from now (`settleMsOf`): the levelling target's and the batcher's weakens still landing. */
  #settleMs(inputs: LevellingRuleInputs, figures: LevellingFigures | null): number {
    if (inputs.mediumData === null) return LEVELLING_SETTLE_MS;
    const settling = [
      ...(figures?.target ? [figures.target] : []),
      ...(inputs.batcherTarget === null ? [] : [inputs.batcherTarget]),
    ];
    return settleMsOf(inputs.mediumData, inputs.hacking, settling);
  }

  #lines(
    estimates: LevellingEstimates,
    target: string | null,
    figures: LevellingFigures,
    inputs: LevellingRuleInputs,
  ): string[] {
    const fit = this.#fit;
    const augmentations = inputs.installAugmentations ?? [];
    return [
      `levelling (the hacking level all that's left, #336): ${describeEstimates(estimates)}`,
      `  chosen: ${LEVELLING_CANDIDATE_WORDS[this.#mode]}` +
        (this.#mode === "money" || target === null
          ? ""
          : ` on ${target}, ${figures.target?.operation === "grow" ? "growing" : "weakening"} it (the operation sent) ` +
            `(${Math.floor(figures.threads).toLocaleString("en-US")} threads, home's beyond ` +
            `${Math.round(figures.homeKeptGb).toLocaleString("en-US")} GB among them)`) +
        "; levelling's fitted factor " +
        (fit === null
          ? "not measured yet (1 taken, optimistic)"
          : `${fit.factor.toFixed(2)} (measured ${fit.measured.toExponential(2)}/s, the formula ` +
            `${fit.predicted.toExponential(2)}/s)`),
      ...(estimates.install === null
        ? []
        : [
            `  the install's augmentations: NeuroFlux Governor ×${inputs.neuroFluxLevels ?? 0}` +
              (augmentations.length === 0 ? "" : `; the set's ${augmentations.join(", ")}`),
          ]),
    ];
  }

  #switch(
    mode: LevellingCandidate,
    inputs: LevellingRuleInputs,
    estimates: LevellingEstimates | null,
    figures: LevellingFigures | null,
    why: string | null,
  ): void {
    const from = this.#mode;
    this.#mode = mode;
    this.#window.clear();
    const { mediumGameTimeMs } = inputs;
    this.#settledAtGameMs = !isFiniteNumber(mediumGameTimeMs)
      ? null
      : mediumGameTimeMs + this.#settleMs(inputs, figures);
    const detail =
      `${LEVELLING_CANDIDATE_WORDS[from]} to ${LEVELLING_CANDIDATE_WORDS[mode]}` +
      (why !== null ? `: ${why}` : estimates === null ? "" : `: ${describeEstimates(estimates)}`);
    this.#log(`levelling: ${detail}`);
    this.#emit({
      type: LEVELLING_CHOSEN_EVENT_KIND,
      atMs: inputs.nowMs ?? 0,
      mode,
      from,
      estimates: estimates ?? { money: null, level: null, install: null },
      target: figures?.target?.hostname ?? null,
      money: this.#money,
      factor: this.#fit?.factor ?? null,
      neuroFluxLevels: inputs.neuroFluxLevels,
      installAugmentations: [...(inputs.installAugmentations ?? [])],
      detail,
    });
  }
}
