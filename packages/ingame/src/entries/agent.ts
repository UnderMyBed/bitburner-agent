// agent/<deploymentId>/agent.js: the always-running in-game Agent (architecture §5.1). It holds the control channel to
// the brain (docs/bridge/protocol.md): says hello, is welcomed or told to restart, and reconnects with backoff. While
// welcomed, it sends a round of snapshots every 2 s (../agent/snapshotter.ts), the slow one with the faction state
// (../agent/faction-state.ts, #197), converges the hack loop on the brain's
// desired state when that's due (../agent/hack-loop.ts, #134), does the brain's intents through their effectors
// (../agent/intent-runner.ts, #141), converges the work last (../agent/work.ts, #151), and sleeps in between. Before
// the hack loop, the intents and the work, it handles the game's routine dialogs (../agent/dialog-watcher.ts, #143).
// With no brain, while it keeps a desired state for safe mode (../agent/safe-mode.ts, #160), its rounds go on without
// snapshots or intents: the dialogs, the hack loop and the work, on the kept state, while it connects and waits.
//
// Two rules make it safe:
// - Socket handlers never call `ns`. While the script awaits `ns.sleep` (between rounds), the game kills it for any
//   `ns` call made from another callback (NetscriptHelpers.tsx:405-431). The handlers only queue events; the main loop
//   acts on them.
// - It keeps no state at module level (architecture R10): the game may or may not reuse a module.
//
// RAM: `run` (1.0 GB), `isRunning` (0.1 GB), `getScriptRam` (0.1 GB) and `getServerMaxRam` (0.05 GB) are the functions
// referenced that cost anything; the rest (`read` and `write` among them) are free (ram-budget.json).
import {
  AGENT_CONFIG_FILE_NAME,
  BOOT_SCRIPT,
  type BrainMessage,
  CONTROL_CLOSE_CODES,
  CONTROL_PROTOCOL_VERSION,
  CURRENT_DEPLOYMENT_FILE,
  deployedFilePath,
  deploymentIdOfPath,
  encodeControlMessage,
  gameDrift,
  isValidDeploymentId,
  MAX_REFUSED_REASON_LENGTH,
  parseAgentConfig,
  parseBrainMessage,
  type RefusedBrainMessage,
  TOKEN_FILE_NAME,
} from "@bitburner-agent/core";
import { createDialogWatcher } from "../agent/dialog-watcher.ts";
import { createEffectorRunner } from "../agent/effector-runner.ts";
import { createFactionStateReader } from "../agent/faction-state.ts";
import { createHackLoop } from "../agent/hack-loop.ts";
import { createIntentRunner } from "../agent/intent-runner.ts";
import { createWorkerRunner } from "../agent/run-worker.ts";
import { createSafeMode } from "../agent/safe-mode.ts";
import { createSnapshotter, SNAPSHOT_ROUND_MS } from "../agent/snapshotter.ts";
import { createWorkActivity } from "../agent/work.ts";
import type { NS } from "../ns.ts";

const FIRST_RECONNECT_DELAY_MS = 1_000;
const LONGEST_RECONNECT_DELAY_MS = 30_000;

/** What the socket's handlers tell the main loop. */
type SocketEvent =
  | { kind: "opened" }
  | { kind: "message"; message: BrainMessage }
  | { kind: "refused"; reason: string }
  | { kind: "closed"; code: number };

/** A queue the socket's handlers fill and the main loop drains, waiting on a plain promise (no `ns` call). */
function createEventQueue() {
  const pending: SocketEvent[] = [];
  let wakeMainLoop: (() => void) | null = null;
  return {
    push(event: SocketEvent): void {
      pending.push(event);
      wakeMainLoop?.();
      wakeMainLoop = null;
    },
    async next(): Promise<SocketEvent> {
      while (pending.length === 0) await new Promise<void>((resolve) => (wakeMainLoop = resolve));
      return pending.shift() as SocketEvent;
    },
    /** The next event if there is one, without waiting. */
    takeIfAny(): SocketEvent | undefined {
      return pending.shift();
    },
  };
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  // To the terminal for whoever is watching, and to the script's log for later.
  const reportCantStart = (problem: string) => {
    ns.print(`agent: can't start: ${problem}`);
    ns.tprint(`agent: can't start: ${problem}`);
  };
  const ownDeploymentId = deploymentIdOfPath(ns.getScriptName());
  if (!ownDeploymentId) {
    return reportCantStart(`${ns.getScriptName()} isn't in a deployment folder (agent/<deploymentId>/)`);
  }
  const configText = ns.read(deployedFilePath(ownDeploymentId, AGENT_CONFIG_FILE_NAME));
  if (configText === "") return reportCantStart("config.json is missing or empty");
  const parsedConfig = parseAgentConfig(configText);
  if (!parsedConfig.ok) return reportCantStart(`config.json isn't valid (${parsedConfig.reason})`);
  const { deploymentId, controlPort } = parsedConfig.config;
  if (deploymentId !== ownDeploymentId) {
    return reportCantStart(`config.json names deployment ${deploymentId}, not its folder's ${ownDeploymentId}`);
  }
  const token = ns.read(deployedFilePath(ownDeploymentId, TOKEN_FILE_NAME)).trim();
  if (token === "") return reportCantStart("token.txt is missing or empty");
  const agentSessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const game = ns.ui.getGameInfo();
  // One runner for every home worker, so they run one at a time, and never two copies of one.
  const workerRunner = createWorkerRunner(ns);
  // Created first, as the snapshotter reports how its intents and work went; it asks the snapshotter whether
  // Singularity is in.
  let singularityAvailable = () => false;
  const effectorRunner = createEffectorRunner(ns, {
    deploymentId,
    workerRunner,
    singularityAvailable: () => singularityAvailable(),
  });
  const intentRunner = createIntentRunner(ns, { effectorRunner });
  const workActivity = createWorkActivity(ns, { effectorRunner });
  const dialogWatcher = createDialogWatcher(ns);
  /** The brain's last message refused, until a desired state is taken again, and the count this connection (#194). */
  let refused: RefusedBrainMessage | null = null;
  let refusedCount = 0;
  const factionStateReader = createFactionStateReader(ns, {
    effectorRunner,
    handleDialogs: (deadlineMs) => dialogWatcher.handle(deadlineMs),
    invitationsAnswered: () => dialogWatcher.invitationsAnswered(),
    augmentationsBought: () => intentRunner.augmentationsBought(),
  });
  const snapshotter = createSnapshotter(ns, {
    deploymentId,
    agentSessionId,
    workerRunner,
    intentOutcomes: () => intentRunner.outcomes(),
    workOutcome: () => workActivity.outcome(),
    dialogReport: () => dialogWatcher.takeReport(),
    refusedMessage: () => refused,
    readFactions: (deadlineMs) => factionStateReader.read(deadlineMs),
    factionsUnread: (problem) => factionStateReader.unread(problem),
  });
  singularityAvailable = () => snapshotter.singularityAvailable();
  const hackLoop = createHackLoop(ns, { deploymentId, workerRunner });
  // The last desired state, from agent/desired-state.json if a brain sent one before this Agent started.
  // On a game other than the pinned release, only what a hold would send: no work (architecture §12.4).
  const safeMode = createSafeMode(ns, {
    gameDrift: gameDrift({
      version: game.version,
      versionNumber: game.versionNumber,
      commit: game.commit,
      platform: game.platform,
    }),
  });

  /**
   * One round: with a brain (`connection`), its snapshots; without, safe mode's kept state for the hack loop and the
   * work, and no snapshots (the slow worker once, unsent, for the reset check). Then, in what's left of the round, the
   * game's dialogs first, so the intents' page work finds none of them in the way; the hack loop; the intents (none
   * without a brain: forgotten at the disconnect); the work last, after the intents' page work, so it's left as wanted,
   * focused or not (#151). Then it sleeps until the next round.
   */
  const takeRound = async (connection: WebSocket | null): Promise<void> => {
    const roundStartedAtMs = Date.now();
    const roundEndsAtMs = roundStartedAtMs + SNAPSHOT_ROUND_MS;
    if (connection !== null) {
      await snapshotter.takeRound((message) => connection.send(encodeControlMessage(message)));
      safeMode.connectedRound(Date.now(), snapshotter.lastAugReset());
    } else {
      await snapshotter.readSlowTierIfNone(roundEndsAtMs);
      const kept = safeMode.toConverge(Date.now(), snapshotter.lastAugReset());
      if (kept === null) {
        hackLoop.forget();
        workActivity.forget();
      } else {
        hackLoop.desire(kept.hackLoop);
        workActivity.desire(kept.work);
      }
    }
    await dialogWatcher.handle(roundEndsAtMs);
    await hackLoop.convergeIfDue(roundEndsAtMs);
    await intentRunner.runDue(roundEndsAtMs);
    await workActivity.convergeIfDue(roundEndsAtMs);
    // Clamped, so a clock that steps back can't stretch the sleep.
    const untilNextRoundMs = roundEndsAtMs - Date.now();
    await ns.sleep(Math.min(Math.max(0, untilNextRoundMs), SNAPSHOT_ROUND_MS));
  };

  /**
   * Starts `agent/boot.js`, which starts the deployed Agent; the caller then exits. Returns false if it couldn't (home
   * is full): this Agent carries on, so there is always one, and tries again at its next disconnect.
   */
  const startedBoot = (why: string): boolean => {
    // The game logs why a start failed (no RAM, a missing file) only with run's log on. Off again after, or every
    // worker start would be logged.
    ns.enableLog("run");
    // With this Agent's pid, boot.js waits for it to exit before starting the deployed one.
    const started = ns.run(BOOT_SCRIPT, 1, ns.pid) !== 0;
    ns.disableLog("run");
    ns.print(`agent: ${why}; ${started ? "handed over to" : "carrying on: couldn't start"} ${BOOT_SCRIPT}`);
    return started;
  };

  let socket: WebSocket | null = null;
  // However it ends (returning, or killed), the Agent must not leave its socket open: sockets outlive scripts.
  ns.atExit(() => socket?.close(1000, "agent exiting"));

  let reconnectDelayMs = FIRST_RECONNECT_DELAY_MS;
  for (;;) {
    const events = createEventQueue();
    const connection = new WebSocket(`ws://127.0.0.1:${controlPort}`);
    socket = connection;
    connection.onopen = () => events.push({ kind: "opened" });
    connection.onmessage = (event) => {
      const parsed = parseBrainMessage(String(event.data));
      // A message that isn't valid is refused, loudly (#194's review): logged, and reported in the fast snapshot until
      // a desired state is taken again, so the brain alerts. The Agent goes on with the last state it took.
      events.push(
        parsed.ok ? { kind: "message", message: parsed.message } : { kind: "refused", reason: parsed.reason },
      );
    };
    connection.onclose = (event) => events.push({ kind: "closed", code: event.code });

    let closeCode = 0;
    let welcomed = false;
    // Counted per connection: a new brain starts from none.
    refusedCount = 0;
    refused = null;
    while (closeCode === 0) {
      // Welcomed, or connecting while safe mode keeps a state: rounds go on, and socket events queue meanwhile.
      const event = welcomed || safeMode.keepsState() ? events.takeIfAny() : await events.next();
      if (event === undefined) {
        // Nothing to act on: a round (with snapshots once welcomed), then sleep until the next.
        await takeRound(welcomed ? connection : null);
      } else if (event.kind === "opened") {
        connection.send(
          encodeControlMessage({
            protocolVersion: CONTROL_PROTOCOL_VERSION,
            type: "hello",
            token,
            deploymentId,
            agentSessionId,
            game: {
              version: game.version,
              versionNumber: game.versionNumber,
              commit: game.commit,
              platform: game.platform,
            },
          }),
        );
      } else if (event.kind === "refused") {
        refusedCount += 1;
        refused = { reason: event.reason.slice(0, MAX_REFUSED_REASON_LENGTH), count: refusedCount };
        ns.print(`agent: refused a message from the brain (${refusedCount} so far): ${refused.reason}`);
      } else if (event.kind === "message") {
        if (event.message.type === "welcome") {
          reconnectDelayMs = FIRST_RECONNECT_DELAY_MS;
          welcomed = true;
          snapshotter.welcomed();
          // Instructions come only from the brain it's connected to (#134): safe mode's kept state waits for the next
          // disconnect, and this brain sends its own.
          hackLoop.forget();
          workActivity.forget();
          ns.print(`agent: welcomed (session ${agentSessionId})`);
        } else if (event.message.type === "restart") {
          if (startedBoot(`told to restart onto ${event.message.deploymentId}`)) return;
        } else if (event.message.type === "desiredState") {
          if (refused !== null) ns.print("agent: took the brain's desired state again");
          refused = null;
          hackLoop.desire(event.message.hackLoop);
          intentRunner.desire(event.message.intents);
          workActivity.desire(event.message.work ?? null);
          safeMode.heard(event.message, Date.now(), snapshotter.lastAugReset());
        }
      } else {
        closeCode = event.code;
      }
    }
    socket = null;
    // One-shot actions need the brain: the next one sends its own. The hack loop and the work go on in safe mode, on
    // the last state, its clock stopping here; with none kept, they wait for the next brain.
    intentRunner.forget();

    // A newer Agent replaced this one: this one is stale, and must not come back (it would replace the new one), nor
    // write the file over the newer one's.
    if (closeCode === CONTROL_CLOSE_CODES.replaced) {
      ns.print("agent: replaced by a newer Agent; exiting");
      return;
    }
    safeMode.disconnected(Date.now());
    // Deployed again while disconnected (a new token or port means a new deployment): the new one takes over. Not
    // for an empty or invalid current.txt, which boot.js would refuse, leaving no Agent.
    const currentDeploymentId = ns.read(CURRENT_DEPLOYMENT_FILE).trim();
    const deployedElsewhere = isValidDeploymentId(currentDeploymentId) && currentDeploymentId !== deploymentId;
    if (deployedElsewhere && startedBoot(`${CURRENT_DEPLOYMENT_FILE} now names ${currentDeploymentId}`)) return;
    ns.print(`agent: disconnected (${closeCode}); reconnecting in ${reconnectDelayMs / 1000} s`);
    // The wait: in safe mode's rounds while it keeps a state, counted so a clock that steps back can't stretch it; else
    // asleep, for what's left of it.
    let roundsLeft = Math.ceil(reconnectDelayMs / SNAPSHOT_ROUND_MS);
    for (; roundsLeft > 0 && safeMode.keepsState(); roundsLeft -= 1) await takeRound(null);
    if (roundsLeft > 0) await ns.sleep(Math.min(roundsLeft * SNAPSHOT_ROUND_MS, reconnectDelayMs));
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, LONGEST_RECONNECT_DELAY_MS);
  }
}
