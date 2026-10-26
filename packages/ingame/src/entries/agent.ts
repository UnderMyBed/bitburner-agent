// agent/<deploymentId>/agent.js: the always-running in-game Agent (architecture §5.1). It holds the control channel to
// the brain (docs/bridge/protocol.md): says hello, is welcomed or told to restart, and reconnects with backoff.
// Snapshots come with #89.
//
// Two rules make it safe:
// - Socket handlers never call `ns`. While the script awaits `ns.sleep`, the game kills it for any `ns` call made from
//   another callback (NetscriptHelpers.tsx:405-431). The handlers only queue events; the main loop acts on them.
// - It keeps no state at module level (architecture R10): the game may or may not reuse a module.
//
// RAM: `run` (1.0 GB) is the one function referenced that costs anything; the rest are free (ram-budget.json).
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
  isValidDeploymentId,
  parseAgentConfig,
  parseBrainMessage,
  TOKEN_FILE_NAME,
} from "@bitburner-agent/core";
import type { NS } from "../ns.ts";

const FIRST_RECONNECT_DELAY_MS = 1_000;
const LONGEST_RECONNECT_DELAY_MS = 30_000;

/** What the socket's handlers tell the main loop. */
type SocketEvent = { kind: "opened" } | { kind: "message"; message: BrainMessage } | { kind: "closed"; code: number };

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

  // The game logs why a start failed (no RAM, a missing file) only with run's log on.
  ns.enableLog("run");
  /**
   * Starts `agent/boot.js`, which starts the deployed Agent; the caller then exits. Returns false if it couldn't (home
   * is full): this Agent carries on, so there is always one, and tries again at its next disconnect.
   */
  const startedBoot = (why: string): boolean => {
    // With this Agent's pid, boot.js waits for it to exit before starting the deployed one.
    const started = ns.run(BOOT_SCRIPT, 1, ns.pid) !== 0;
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
      if (parsed.ok) events.push({ kind: "message", message: parsed.message });
    };
    connection.onclose = (event) => events.push({ kind: "closed", code: event.code });

    let closeCode = 0;
    while (closeCode === 0) {
      const event = await events.next();
      if (event.kind === "opened") {
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
      } else if (event.kind === "message") {
        if (event.message.type === "welcome") {
          reconnectDelayMs = FIRST_RECONNECT_DELAY_MS;
          ns.print(`agent: welcomed (session ${agentSessionId})`);
        } else if (event.message.type === "restart") {
          if (startedBoot(`told to restart onto ${event.message.deploymentId}`)) return;
        }
      } else {
        closeCode = event.code;
      }
    }
    socket = null;

    // A newer Agent replaced this one: this one is stale, and must not come back (it would replace the new one).
    if (closeCode === CONTROL_CLOSE_CODES.replaced) {
      ns.print("agent: replaced by a newer Agent; exiting");
      return;
    }
    // Deployed again while disconnected (a new token or port means a new deployment): the new one takes over. Not
    // for an empty or invalid current.txt, which boot.js would refuse, leaving no Agent.
    const currentDeploymentId = ns.read(CURRENT_DEPLOYMENT_FILE).trim();
    const deployedElsewhere = isValidDeploymentId(currentDeploymentId) && currentDeploymentId !== deploymentId;
    if (deployedElsewhere && startedBoot(`${CURRENT_DEPLOYMENT_FILE} now names ${currentDeploymentId}`)) return;
    ns.print(`agent: disconnected (${closeCode}); reconnecting in ${reconnectDelayMs / 1000} s`);
    await ns.sleep(reconnectDelayMs);
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, LONGEST_RECONNECT_DELAY_MS);
  }
}
