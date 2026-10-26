// The supervisor (#94, architecture §10.2, R9): keeps the game itself running for unattended play. It launches the game
// when it isn't running, and kills and relaunches it when the Agent has gone silent (a frozen page, or a dead Agent: a
// reload brings the Agent back through autoexec). At most 3 times an hour, then it gives up until the owner resumes it,
// and never while paused (the dashboard's switch, src/supervision.ts).
import type { Clock } from "@bitburner-agent/bridge";
import { RELAUNCH_EVENT_KIND, readSupervisionSwitch, recordSupervisionGaveUp } from "./supervision.ts";
import type { RecordContext, TelemetryStore } from "./telemetry-store.ts";

/** How often the supervisor looks. */
export const SUPERVISION_CHECK_INTERVAL_MS = 30_000;
/** A running game with no fast snapshot (the heartbeat, every 2 s) for longer than this is silent. */
export const SUPERVISION_SILENT_AFTER_MS = 5 * 60_000;
/** After the brain starts or a launch, the game has this long to load and the Agent to boot before silence counts. */
export const SUPERVISION_GRACE_MS = 5 * 60_000;
export const MAX_RELAUNCHES_PER_HOUR = 3;
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

export interface SupervisorOptions {
  gameProcess: GameProcess;
  /** Holds the switch, the heartbeats it watches, and its events. */
  store: TelemetryStore;
  /** Its events' environment and release (the brain's, plus the deployment it deploys). */
  context: RecordContext;
  clock: Clock;
}

type Cause = "notRunning" | "silent";

export class Supervisor {
  readonly #options: SupervisorOptions;
  /** The grace runs from here: the brain's start, then each launch. */
  #graceFromMs: number;
  #checking = false;

  /** Starts checking at once: the first check is one interval from now. */
  constructor(options: SupervisorOptions) {
    this.#options = options;
    this.#graceFromMs = options.clock.now();
    const everyInterval = () => {
      void this.#check();
      options.clock.setTimeout(everyInterval, SUPERVISION_CHECK_INTERVAL_MS);
    };
    options.clock.setTimeout(everyInterval, SUPERVISION_CHECK_INTERVAL_MS);
  }

  /** One check; a check still running when the next is due (a slow tasklist) makes that one skip. */
  async #check(): Promise<void> {
    if (this.#checking) return;
    const { store } = this.#options;
    const supervision = readSupervisionSwitch(store);
    if (supervision.paused || supervision.gaveUpAtMs !== null) return;
    this.#checking = true;
    let cause: Cause | null = null;
    try {
      if (!(await this.#options.gameProcess.isRunning())) cause = "notRunning";
      else if (this.#isSilent()) cause = "silent";
      if (cause) await this.#relaunch(cause);
    } catch (error) {
      // A command that failed (Steam missing, say): recorded, and the next check tries again.
      this.#record(FAILED_EVENT_KIND, { cause, failure: error instanceof Error ? error.message : String(error) });
    } finally {
      this.#checking = false;
    }
  }

  /** Past the grace, with no heartbeat for too long. */
  #isSilent(): boolean {
    const nowMs = this.#options.clock.now();
    if (nowMs - this.#graceFromMs < SUPERVISION_GRACE_MS) return false;
    const lastHeartbeat = this.#options.store.latestSnapshot({
      environment: this.#options.context.environment,
      tier: "fast",
    });
    return lastHeartbeat === null || nowMs - lastHeartbeat.receivedAtMs > SUPERVISION_SILENT_AFTER_MS;
  }

  /** Kills first if the game is running; gives up instead if this would be one too many in the hour. */
  async #relaunch(cause: Cause): Promise<void> {
    const { gameProcess, clock } = this.#options;
    const relaunchesInLastHour = this.#relaunchesInLastHour();
    if (relaunchesInLastHour >= MAX_RELAUNCHES_PER_HOUR) {
      recordSupervisionGaveUp(this.#options.store, clock.now());
      this.#record(GAVE_UP_EVENT_KIND, { relaunchesInLastHour });
      return;
    }
    if (cause === "silent") await gameProcess.kill();
    await gameProcess.launch();
    this.#graceFromMs = clock.now();
    this.#record(RELAUNCH_EVENT_KIND, { cause });
  }

  /**
   * Relaunches in the last hour, from the store, so a brain that restarts can't relaunch without limit. Those before
   * the last give-up don't count: resuming starts afresh.
   */
  #relaunchesInLastHour(): number {
    const { store, context, clock } = this.#options;
    const lastGaveUp = store.recentEvents({
      environment: context.environment,
      limit: 1,
      kinds: [GAVE_UP_EVENT_KIND],
    })[0];
    const countFromMs = Math.max(clock.now() - HOUR_MS, lastGaveUp ? lastGaveUp.atMs + 1 : -Infinity);
    return store
      .recentEvents({ environment: context.environment, limit: MAX_RELAUNCHES_PER_HOUR, kinds: [RELAUNCH_EVENT_KIND] })
      .filter((event) => event.atMs >= countFromMs).length;
  }

  #record(kind: string, detail: unknown): void {
    this.#options.store.recordEvent(this.#options.context, { atMs: this.#options.clock.now(), kind, detail });
  }
}
