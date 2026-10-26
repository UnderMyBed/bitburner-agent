// The supervisor (#94, architecture §10.2, R9): keeps the game itself running for unattended play. It launches the game
// when it isn't running, and kills and relaunches it when the Agent has gone silent (a frozen page, or a dead Agent: a
// reload brings the Agent back through autoexec). At most 3 launches an hour, then it gives up until the owner resumes
// it, and never while paused (the dashboard's switch, src/supervision.ts).
//
// It judges by what it sees at each check, never by timestamps: a heartbeat counts as new only if it's a new snapshot,
// and every wait is a number of checks. So the clock stepping (time sync, waking from sleep) can't make a healthy game
// look silent, or hide a frozen one.
import type { Clock, TimerHandle } from "@bitburner-agent/bridge";
import { RELAUNCH_EVENT_KIND, readSupervisionSwitch, recordSupervisionGaveUp } from "./supervision.ts";
import type { Environment, RecordContext, TelemetryStore } from "./telemetry-store.ts";

/** How often the supervisor looks. */
export const SUPERVISION_CHECK_INTERVAL_MS = 30_000;
/** Checks with no new heartbeat (the fast snapshot, every 2 s) before a running game counts as silent: 5 minutes. */
export const SILENT_AFTER_CHECKS = 10;
/** Checks after the brain starts, a launch, or a resume, before silence counts: 5 minutes to boot. */
export const GRACE_CHECKS = 10;
/** Checks after a launch with nothing done at all, so Steam can start, log in or update: 5 minutes. */
export const LAUNCH_WAIT_CHECKS = 10;
/** Checks that fail in a row (a command that keeps failing) before the supervisor gives up: 5 minutes. */
export const MAX_FAILED_CHECKS = 10;
export const MAX_LAUNCHES_PER_HOUR = 3;
const HOUR_MS = 60 * 60_000;
const GAVE_UP_EVENT_KIND = "supervisionGaveUp";
const FAILED_EVENT_KIND = "supervisionFailed";

/** The game's process, as the supervisor sees it: on Windows, `WindowsGameProcess`; in tests, a fake. */
export interface GameProcess {
  isRunning(): Promise<boolean>;
  /** Starts it through Steam, as a player does. */
  launch(): Promise<void>;
  kill(): Promise<void>;
}

/**
 * Whether a brain supervises: only Steam's game (E0), only on Windows. A brain for a source build (E2) must never
 * launch or kill it; tests run the brain as E2 for that reason.
 */
export function shouldSupervise(environment: Environment, platform: NodeJS.Platform): boolean {
  return environment === "E0" && platform === "win32";
}

export interface SupervisorOptions {
  gameProcess: GameProcess;
  /** Holds the switch, the heartbeats it watches, and its events. */
  store: TelemetryStore;
  /** Its events' environment and release (the brain's, plus the deployment it deploys). */
  context: RecordContext;
  clock: Clock;
  /** An error the supervisor couldn't even record (the store closed, say): the brain logs it. It carries on. */
  onError(error: unknown): void;
}

type Cause = "notRunning" | "silent";

/** A check stopped because the switch changed while it ran: not a failure. */
class SwitchedOffError extends Error {}

export class Supervisor {
  readonly #options: SupervisorOptions;
  #timer: TimerHandle | null = null;
  #checking = false;
  /** Checks left in which nothing is done: after a launch. */
  #launchWaitChecks = 0;
  /** Checks left in which silence doesn't count: after the start, a launch, or a resume. */
  #graceChecks = GRACE_CHECKS;
  /** The newest heartbeat seen, and how many checks in a row it has stayed the newest. */
  #lastHeartbeat: string | null = null;
  #checksWithoutNewHeartbeat = 0;
  /** Whether the last check found supervision on, to notice a resume. */
  #wasActive = true;
  #failedChecksInARow = 0;

  /** Starts the checks; the first is one interval (30 s) from now. */
  constructor(options: SupervisorOptions) {
    this.#options = options;
    const everyInterval = () => {
      this.#check().catch(options.onError);
      this.#timer = options.clock.setTimeout(everyInterval, SUPERVISION_CHECK_INTERVAL_MS);
    };
    this.#timer = options.clock.setTimeout(everyInterval, SUPERVISION_CHECK_INTERVAL_MS);
  }

  /** No more checks (the brain is stopping): nothing is launched while the game closes with the session. */
  stop(): void {
    if (this.#timer !== null) this.#options.clock.clearTimeout(this.#timer);
    this.#timer = null;
  }

  /** One check; one still running when the next is due (a slow tasklist) makes that one skip. */
  async #check(): Promise<void> {
    if (this.#checking) return;
    this.#checking = true;
    let cause: Cause | null = null;
    try {
      if (!this.#isActive()) {
        this.#wasActive = false;
        return;
      }
      if (!this.#wasActive) {
        // Resumed: the game may be booting again, so silence waits for a fresh grace.
        this.#wasActive = true;
        this.#graceChecks = GRACE_CHECKS;
        this.#launchWaitChecks = 0;
      }
      const running = await this.#options.gameProcess.isRunning();
      this.#watchHeartbeat();
      if (this.#launchWaitChecks > 0) {
        this.#launchWaitChecks--;
      } else if (!running) {
        cause = "notRunning";
      } else if (this.#graceChecks > 0) {
        this.#graceChecks--;
      } else if (this.#checksWithoutNewHeartbeat >= SILENT_AFTER_CHECKS) {
        cause = "silent";
      }
      if (cause) await this.#relaunch(cause);
      this.#failedChecksInARow = 0;
    } catch (error) {
      if (!(error instanceof SwitchedOffError)) this.#recordFailedCheck(cause, error);
    } finally {
      this.#checking = false;
    }
  }

  /** Not paused, not given up. Read afresh before anything is killed or launched, so a pause is never late. */
  #isActive(): boolean {
    const supervision = readSupervisionSwitch(this.#options.store);
    return !supervision.paused && supervision.gaveUpAtMs === null;
  }

  /** Counts the checks since the newest heartbeat changed: by which snapshot it is, not by its time. */
  #watchHeartbeat(): void {
    const { store, context } = this.#options;
    const latest = store.latestSnapshot({ environment: context.environment, tier: "fast" });
    const heartbeat = latest ? `${latest.agentSessionId}/${latest.sequenceNumber}` : null;
    if (heartbeat !== this.#lastHeartbeat) {
      this.#lastHeartbeat = heartbeat;
      this.#checksWithoutNewHeartbeat = 0;
    } else {
      this.#checksWithoutNewHeartbeat++;
    }
  }

  /** Kills first if silent; gives up instead if this would be one launch too many in the hour. */
  async #relaunch(cause: Cause): Promise<void> {
    const { gameProcess, store, clock } = this.#options;
    const launchesInLastHour = this.#launchesInLastHour();
    if (launchesInLastHour >= MAX_LAUNCHES_PER_HOUR) {
      this.#giveUp({ cause, launchesInLastHour });
      return;
    }
    if (cause === "silent") {
      this.#throwIfSwitchedOff();
      try {
        await gameProcess.kill();
      } catch (error) {
        // taskkill can report failure though the game is gone (it exited meanwhile): only a game still running stops
        // the launch.
        if (await gameProcess.isRunning()) throw error;
      }
    }
    this.#throwIfSwitchedOff();
    await gameProcess.launch();
    this.#launchWaitChecks = LAUNCH_WAIT_CHECKS;
    this.#graceChecks = GRACE_CHECKS;
    this.#checksWithoutNewHeartbeat = 0;
    store.recordEvent(this.#options.context, { atMs: clock.now(), kind: RELAUNCH_EVENT_KIND, detail: { cause } });
  }

  #throwIfSwitchedOff(): void {
    if (!this.#isActive()) throw new SwitchedOffError();
  }

  /**
   * Launches in the last hour, from the store, so a brain that restarts can't launch without limit. Only those after
   * the last give-up count, by order (whatever the clock did): resuming after a give-up starts afresh.
   */
  #launchesInLastHour(): number {
    const { store, context, clock } = this.#options;
    const environment = context.environment;
    const lastGaveUpId = store.latestEventId({ environment, kinds: [GAVE_UP_EVENT_KIND] });
    return store.countEvents({
      environment,
      kinds: [RELAUNCH_EVENT_KIND],
      afterEventId: lastGaveUpId,
      sinceMs: clock.now() - HOUR_MS,
    });
  }

  #giveUp(detail: Record<string, unknown>): void {
    const { store, context, clock } = this.#options;
    recordSupervisionGaveUp(store, clock.now());
    store.recordEvent(context, { atMs: clock.now(), kind: GAVE_UP_EVENT_KIND, detail });
  }

  /**
   * A check that failed (a command, or the store): recorded once per run of failures, so a command that keeps failing
   * doesn't fill the events. Too many in a row gives up, with the dashboard's alert.
   */
  #recordFailedCheck(cause: Cause | null, error: unknown): void {
    const failure = error instanceof Error ? error.message : String(error);
    this.#failedChecksInARow++;
    const { store, context, clock } = this.#options;
    try {
      if (this.#failedChecksInARow === 1) {
        store.recordEvent(context, { atMs: clock.now(), kind: FAILED_EVENT_KIND, detail: { cause, failure } });
      }
      if (this.#failedChecksInARow >= MAX_FAILED_CHECKS) {
        this.#giveUp({ failedChecksInARow: this.#failedChecksInARow, failure });
        this.#failedChecksInARow = 0;
      }
    } catch (recordingError) {
      this.#options.onError(recordingError);
    }
  }
}
