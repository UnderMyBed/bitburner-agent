// The control channel's session logic (docs/bridge/protocol.md): authenticates the in-game Agent, keeps one at a time,
// passes its snapshots on in order, and tells it to restart onto the deployed deployment, never in a loop.
import {
  type BrainMessage,
  CONTROL_CLOSE_CODES,
  CONTROL_PROTOCOL_VERSION,
  encodeControlMessage,
  type GameInfo,
  type HelloMessage,
  parseAgentMessage,
  type SnapshotMessage,
} from "@bitburner-agent/core";
import type { Clock, TimerHandle } from "./clock.ts";
import type { Connection } from "./connection.ts";

/** How long a new connection has to send a valid hello. */
export const HELLO_TIMEOUT_MS = 5_000;

export type ConnectionRejectedReason = "helloTimeout" | "wrongToken" | "badMessage" | "origin";

/** What the channel reports; every `atMs` comes from its clock. */
export type ControlChannelEvent =
  | { type: "agentConnected"; atMs: number; agentSessionId: string; deploymentId: string; game: GameInfo }
  | { type: "agentDisconnected"; atMs: number; agentSessionId: string }
  /** `missedBefore`: sequence numbers skipped since the last snapshot passed on for this session and tier. */
  | { type: "snapshotReceived"; atMs: number; snapshot: SnapshotMessage; missedBefore: number }
  | { type: "connectionRejected"; atMs: number; reason: ConnectionRejectedReason; detail: string };

/**
 * What the deployer knows (#91): the deployment `agent/current.txt` names, as last read or written over the Remote File
 * API (null until known), whether the brain is on hold (a game version it wasn't built for), and whether the last
 * deploy failed.
 */
export interface DeploymentState {
  deployedId: string | null;
  hold: boolean;
  deployFailed: boolean;
}

export interface ControlChannelOptions {
  /** The shared secret the deployer gives the Agent (`token.txt`). */
  token: string;
  clock: Clock;
}

export interface ConnectedAgent {
  agentSessionId: string;
  deploymentId: string;
  game: GameInfo;
}

interface AgentSession extends ConnectedAgent {
  connection: Connection;
  /** The deployment a restart was sent for, so it's sent once. */
  restartSentFor: string | null;
}

export class ControlChannel {
  readonly #token: string;
  readonly #clock: Clock;
  readonly #listeners = new Set<(event: ControlChannelEvent) => void>();
  #current: AgentSession | null = null;
  #deploymentState: DeploymentState = { deployedId: null, hold: false, deployFailed: false };
  /** The last sequence number passed on, by session and tier. */
  readonly #lastPassedOn = new Map<string, number>();

  constructor({ token, clock }: ControlChannelOptions) {
    if (token === "") throw new Error("the control channel needs a token");
    this.#token = token;
    this.#clock = clock;
  }

  /** Calls `listener` with every event from now on; returns a function that stops it. */
  subscribe(listener: (event: ControlChannelEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The Agent connected now, if any. */
  connectedAgent(): ConnectedAgent | null {
    if (!this.#current) return null;
    const { agentSessionId, deploymentId, game } = this.#current;
    return { agentSessionId, deploymentId, game };
  }

  /** The transport refused a connection from this origin before it reached the channel. */
  reportRejectedOrigin(origin: string): void {
    this.#emit({ type: "connectionRejected", atMs: this.#clock.now(), reason: "origin", detail: origin });
  }

  /** The deployer's view changed: a connected Agent from another deployment may now be told to restart. */
  setDeploymentState(state: DeploymentState): void {
    this.#deploymentState = { ...state };
    if (this.#current) this.#restartIfOutdated(this.#current);
  }

  /** Takes a new connection from the game's page: it has `HELLO_TIMEOUT_MS` to say a valid hello. */
  accept(connection: Connection): void {
    let session: AgentSession | null = null;
    let closedByChannel = false;
    const helloTimer: TimerHandle = this.#clock.setTimeout(
      () => reject("helloTimeout", CONTROL_CLOSE_CODES.helloTimeout, ""),
      HELLO_TIMEOUT_MS,
    );
    const reject = (reason: ConnectionRejectedReason, code: number, detail: string) => {
      this.#clock.clearTimeout(helloTimer);
      this.#emit({ type: "connectionRejected", atMs: this.#clock.now(), reason, detail });
      closedByChannel = true;
      connection.close(code, reason);
    };

    connection.onClose(() => {
      this.#clock.clearTimeout(helloTimer);
      if (session && this.#current === session) {
        this.#current = null;
        this.#emit({ type: "agentDisconnected", atMs: this.#clock.now(), agentSessionId: session.agentSessionId });
      }
    });

    connection.onMessage((text) => {
      if (closedByChannel) return;
      // A replaced connection's frames no longer count.
      if (session && this.#current !== session) return;
      const parsed = parseAgentMessage(text);
      if (!parsed.ok) return reject("badMessage", CONTROL_CLOSE_CODES.badMessage, parsed.reason);
      const message = parsed.message;
      if (!session) {
        if (message.type !== "hello") return reject("badMessage", CONTROL_CLOSE_CODES.badMessage, "no hello first");
        if (message.token !== this.#token) return reject("wrongToken", CONTROL_CLOSE_CODES.wrongToken, "");
        this.#clock.clearTimeout(helloTimer);
        session = this.#welcome(connection, message);
        return;
      }
      if (message.type === "hello") return reject("badMessage", CONTROL_CLOSE_CODES.badMessage, "a second hello");
      if (message.agentSessionId !== session.agentSessionId) {
        return reject("badMessage", CONTROL_CLOSE_CODES.badMessage, "a snapshot from another session");
      }
      this.#passOn(message);
    });
  }

  #welcome(connection: Connection, hello: HelloMessage): AgentSession {
    const previous = this.#current;
    const session: AgentSession = {
      connection,
      agentSessionId: hello.agentSessionId,
      deploymentId: hello.deploymentId,
      game: hello.game,
      restartSentFor: null,
    };
    this.#current = session;
    if (previous) {
      this.#emit({ type: "agentDisconnected", atMs: this.#clock.now(), agentSessionId: previous.agentSessionId });
      previous.connection.close(CONTROL_CLOSE_CODES.replaced, "replaced");
    }
    this.#emit({
      type: "agentConnected",
      atMs: this.#clock.now(),
      agentSessionId: session.agentSessionId,
      deploymentId: session.deploymentId,
      game: session.game,
    });
    if (!this.#restartIfOutdated(session))
      this.#send(session, { protocolVersion: CONTROL_PROTOCOL_VERSION, type: "welcome" });
    return session;
  }

  /**
   * Tells the Agent to restart onto the deployed deployment when that is known, the brain isn't on hold, the last
   * deploy didn't fail, and the Agent runs another one; once per deployment. Returns whether it did.
   */
  #restartIfOutdated(session: AgentSession): boolean {
    const { deployedId, hold, deployFailed } = this.#deploymentState;
    if (deployedId === null || hold || deployFailed || session.deploymentId === deployedId) return false;
    if (session.restartSentFor === deployedId) return false;
    session.restartSentFor = deployedId;
    this.#send(session, { protocolVersion: CONTROL_PROTOCOL_VERSION, type: "restart", deploymentId: deployedId });
    return true;
  }

  #passOn(snapshot: SnapshotMessage): void {
    const key = `${snapshot.agentSessionId}\u0000${snapshot.tier}`;
    const lastPassedOn = this.#lastPassedOn.get(key) ?? 0;
    // A duplicate, or one that arrived after a later one: dropped.
    if (snapshot.sequenceNumber <= lastPassedOn) return;
    this.#lastPassedOn.set(key, snapshot.sequenceNumber);
    this.#emit({
      type: "snapshotReceived",
      atMs: this.#clock.now(),
      snapshot,
      missedBefore: snapshot.sequenceNumber - lastPassedOn - 1,
    });
  }

  #send(session: AgentSession, message: BrainMessage): void {
    session.connection.send(encodeControlMessage(message));
  }

  #emit(event: ControlChannelEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}
