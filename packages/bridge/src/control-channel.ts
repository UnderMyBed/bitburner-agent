// The control channel's session logic (docs/bridge/protocol.md): authenticates the in-game Agent, keeps one at a time,
// passes its snapshots on in order, tells it to restart onto the deployed deployment, never in a loop, and gives it the
// brain's desired state (#134).
import {
  type BrainMessage,
  CONTROL_CLOSE_CODES,
  CONTROL_PROTOCOL_VERSION,
  type DesiredState,
  desiredStateWhileHolding,
  encodeControlMessage,
  type GameInfo,
  gameDrift,
  type HelloMessage,
  parseAgentMessage,
  type SnapshotMessage,
} from "@bitburner-agent/core";
import type { Clock, TimerHandle } from "./clock.ts";
import type { Connection } from "./connection.ts";
import { raiseAsUncaught } from "./event-listeners.ts";

/** How long a new connection has to send a valid hello. */
export const HELLO_TIMEOUT_MS = 5_000;
/**
 * How many Agent sessions keep their sequence numbering: the current one and a few before it, so a 24/7 run with many
 * restarts doesn't grow without limit. A session older than that which came back would count from scratch.
 */
export const REMEMBERED_SESSIONS = 4;

export type ConnectionRejectedReason = "helloTimeout" | "wrongToken" | "badMessage" | "origin";

/** What the channel reports; every `atMs` comes from its clock. */
export type ControlChannelEvent =
  | { type: "agentConnected"; atMs: number; agentSessionId: string; deploymentId: string; game: GameInfo }
  | { type: "agentDisconnected"; atMs: number; agentSessionId: string }
  /** `missedBefore`: sequence numbers skipped since the last snapshot passed on for this session and tier. */
  | { type: "snapshotReceived"; atMs: number; snapshot: SnapshotMessage; missedBefore: number }
  | { type: "connectionRejected"; atMs: number; reason: ConnectionRejectedReason; detail: string }
  /** An Agent reported a game other than the pinned one: the channel holds, and never sends `restart` again. */
  | { type: "versionDrift"; atMs: number; detail: string };

/**
 * What the deployer knows (#91): the deployment `agent/current.txt` names, as last read or written over the Remote File
 * API (null until known), whether the brain is on hold (the game's definition file isn't the pinned one), and whether the last
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
  /**
   * Where a listener's error goes, once the channel's state is settled. Default: raised as an uncaught exception (fail
   * fast: the brain stops and is restarted, rather than carry on without its store).
   */
  onListenerError?: (error: unknown) => void;
}

/** The Agent connected now. The deployer keeps its deployment when it tidies old ones (#91). */
export interface ConnectedAgent {
  agentSessionId: string;
  deploymentId: string;
  game: GameInfo;
}

interface AgentSession extends ConnectedAgent {
  connection: Connection;
  /** Sent `welcome` (not `restart`): it may be given the desired state. */
  welcomed: boolean;
  /** The desired state last sent to it, as encoded, or null. */
  sentDesiredState: string | null;
}

export class ControlChannel {
  readonly #token: string;
  readonly #clock: Clock;
  readonly #onListenerError: (error: unknown) => void;
  readonly #listeners = new Set<(event: ControlChannelEvent) => void>();
  #currentSession: AgentSession | null = null;
  #deploymentState: DeploymentState = { deployedId: null, hold: false, deployFailed: false };
  /**
   * An Agent reported a game the brain wasn't built for (architecture §12.4). Kept for the brain's life: only a brain
   * built for the new version may deploy to it.
   */
  #gameDrifted = false;
  /**
   * Deployments a restart was already sent from, for the deployed id now. Cleared when that id changes, so each
   * outdated deployment is told to restart once per thing the deployer learns. If its Agent comes back anyway (the
   * game reloaded a save that still names it), it's welcomed instead, and the deployer sees it (`agentConnected`).
   */
  readonly #restartsSentFrom = new Set<string>();
  /** The last sequence number passed on, by session and tier, for the most recent sessions (oldest first). */
  readonly #lastPassedOnBySession = new Map<string, Map<string, number>>();
  /** What the brain wants running in the game (#134), or null until it says. */
  #desiredState: DesiredState | null = null;

  constructor({ token, clock, onListenerError = raiseAsUncaught }: ControlChannelOptions) {
    if (token === "") throw new Error("the control channel needs a token");
    this.#token = token;
    this.#clock = clock;
    this.#onListenerError = onListenerError;
  }

  /**
   * Calls `listener` with every event from now on; returns a function that stops it. A listener that throws doesn't
   * disturb the channel or the other listeners: its error goes to `onListenerError` afterwards.
   */
  subscribe(listener: (event: ControlChannelEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  connectedAgent(): ConnectedAgent | null {
    if (!this.#currentSession) return null;
    const { agentSessionId, deploymentId, game } = this.#currentSession;
    return { agentSessionId, deploymentId, game };
  }

  /** The transport refused a connection from this origin before it reached the channel. */
  reportRejectedOrigin(origin: string): void {
    this.#emit([{ type: "connectionRejected", atMs: this.#clock.now(), reason: "origin", detail: origin }]);
  }

  /** The deployer's view changed: a connected Agent from another deployment may now be told to restart. */
  setDeploymentState(state: DeploymentState): void {
    if (state.deployedId !== this.#deploymentState.deployedId) this.#restartsSentFrom.clear();
    this.#deploymentState = { ...state };
    if (this.#currentSession) {
      if (this.#restartIfOutdated(this.#currentSession)) this.#currentSession.welcomed = false;
      this.#sendDesiredStateIfDue(this.#currentSession);
    }
  }

  /**
   * What the brain wants running in the game (architecture D2, #134), whole, or null to send nothing new. The brain's
   * controller sets it, and sets it again for each newly connected Agent once it knows that Agent's game, so a stale
   * state never goes out with a welcome. Each connection is sent a state once, then again only when it changes. It's
   * sent whole only to a welcomed Agent running the deployed deployment while the brain doesn't hold. Otherwise (on hold,
   * after a failed deploy, once the game has drifted, or to an outdated Agent) only what starts nothing new goes out,
   * to any connected Agent: `desiredStateWhileHolding`. A new connection clears it.
   */
  setDesiredState(state: DesiredState | null): void {
    this.#desiredState = structuredClone(state);
    if (this.#currentSession) this.#sendDesiredStateIfDue(this.#currentSession);
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
      closedByChannel = true;
      connection.close(code, reason);
      this.#emit([{ type: "connectionRejected", atMs: this.#clock.now(), reason, detail }]);
    };

    connection.onClose(() => {
      this.#clock.clearTimeout(helloTimer);
      if (session && this.#currentSession === session) {
        this.#currentSession = null;
        this.#emit([{ type: "agentDisconnected", atMs: this.#clock.now(), agentSessionId: session.agentSessionId }]);
      }
    });

    connection.onMessage((text) => {
      if (closedByChannel) return;
      // A replaced connection's frames no longer count.
      if (session && this.#currentSession !== session) return;
      const parsed = parseAgentMessage(text);
      if (!parsed.ok) return reject("badMessage", CONTROL_CLOSE_CODES.badMessage, parsed.reason);
      const message = parsed.message;
      if (!session) {
        if (message.type !== "hello") return reject("badMessage", CONTROL_CLOSE_CODES.badMessage, "no hello first");
        if (message.token !== this.#token) return reject("wrongToken", CONTROL_CLOSE_CODES.wrongToken, "");
        this.#clock.clearTimeout(helloTimer);
        session = this.#startSession(connection, message);
        return;
      }
      if (message.type === "hello") return reject("badMessage", CONTROL_CLOSE_CODES.badMessage, "a second hello");
      if (message.agentSessionId !== session.agentSessionId) {
        return reject("badMessage", CONTROL_CLOSE_CODES.badMessage, "a snapshot from another session");
      }
      this.#passOn(message);
    });
  }

  /** An accepted hello: this Agent replaces any other, and is welcomed or told to restart. */
  #startSession(connection: Connection, hello: HelloMessage): AgentSession {
    const previous = this.#currentSession;
    const session: AgentSession = {
      connection,
      agentSessionId: hello.agentSessionId,
      deploymentId: hello.deploymentId,
      game: hello.game,
      welcomed: false,
      sentDesiredState: null,
    };
    this.#currentSession = session;
    this.#rememberSession(session.agentSessionId);
    // Whatever was wanted for the last Agent isn't for this one: the controller sets it afresh (#134).
    this.#desiredState = null;
    previous?.connection.close(CONTROL_CLOSE_CODES.replaced, "replaced");
    // Before the restart decision, so a drifted game is never sent one. Reported once: it holds for the brain's run.
    const drift = gameDrift(hello.game);
    const newlyDrifted = drift !== null && !this.#gameDrifted;
    if (drift !== null) this.#gameDrifted = true;
    if (!this.#restartIfOutdated(session)) {
      this.#send(session, { protocolVersion: CONTROL_PROTOCOL_VERSION, type: "welcome" });
      session.welcomed = true;
    }
    const atMs = this.#clock.now();
    // versionDrift after agentConnected, so it's recorded against the Agent that reported it.
    this.#emit([
      ...(previous ? [{ type: "agentDisconnected" as const, atMs, agentSessionId: previous.agentSessionId }] : []),
      {
        type: "agentConnected",
        atMs,
        agentSessionId: session.agentSessionId,
        deploymentId: session.deploymentId,
        game: session.game,
      },
      ...(newlyDrifted ? [{ type: "versionDrift" as const, atMs, detail: `the Agent's game: ${drift}` }] : []),
    ]);
    return session;
  }

  /**
   * Tells the Agent to restart onto the deployed deployment when that is known, the brain isn't on hold, the last
   * deploy didn't fail, and the Agent runs another one, once per outdated deployment (see `#restartsSentFrom`).
   * Returns whether it did.
   */
  #restartIfOutdated(session: AgentSession): boolean {
    const { deployedId } = this.#deploymentState;
    if (deployedId === null || this.#holding() || session.deploymentId === deployedId) return false;
    if (this.#restartsSentFrom.has(session.deploymentId)) return false;
    this.#restartsSentFrom.add(session.deploymentId);
    this.#send(session, { protocolVersion: CONTROL_PROTOCOL_VERSION, type: "restart", deploymentId: deployedId });
    return true;
  }

  /** On hold, after a failed deploy, or once the game has drifted: the brain deploys and restarts nothing. */
  #holding(): boolean {
    const { hold, deployFailed } = this.#deploymentState;
    return hold || deployFailed || this.#gameDrifted;
  }

  /** Sends the desired state if the brain has one this welcomed Agent may have and hasn't had yet. */
  #sendDesiredStateIfDue(session: AgentSession): void {
    if (this.#desiredState === null) return;
    const trusted = session.welcomed && session.deploymentId === this.#deploymentState.deployedId && !this.#holding();
    // Otherwise only what starts nothing new goes (the hack loop off, nothing bought), and to any connected Agent,
    // whatever the brain knows: it only stops our own loops, and an Agent too old to know it ignores it. After a Steam
    // update the brain holds before it ever learns the deployed id.
    const state = trusted ? this.#desiredState : desiredStateWhileHolding(this.#desiredState);
    if (state === null) return;
    const message: BrainMessage = { protocolVersion: CONTROL_PROTOCOL_VERSION, type: "desiredState", ...state };
    const encoded = encodeControlMessage(message);
    if (encoded === session.sentDesiredState) return;
    session.sentDesiredState = encoded;
    session.connection.send(encoded);
  }

  /** Keeps the numbering of the most recent sessions only. */
  #rememberSession(agentSessionId: string): void {
    const tiers = this.#lastPassedOnBySession.get(agentSessionId) ?? new Map<string, number>();
    this.#lastPassedOnBySession.delete(agentSessionId);
    this.#lastPassedOnBySession.set(agentSessionId, tiers);
    for (const oldest of this.#lastPassedOnBySession.keys()) {
      if (this.#lastPassedOnBySession.size <= REMEMBERED_SESSIONS) break;
      this.#lastPassedOnBySession.delete(oldest);
    }
  }

  #passOn(snapshot: SnapshotMessage): void {
    const tiers = this.#lastPassedOnBySession.get(snapshot.agentSessionId);
    if (!tiers) return;
    const lastPassedOn = tiers.get(snapshot.tier) ?? 0;
    // A duplicate, or one that arrived after a later one: dropped.
    if (snapshot.sequenceNumber <= lastPassedOn) return;
    tiers.set(snapshot.tier, snapshot.sequenceNumber);
    this.#emit([
      {
        type: "snapshotReceived",
        atMs: this.#clock.now(),
        snapshot,
        missedBefore: snapshot.sequenceNumber - lastPassedOn - 1,
      },
    ]);
  }

  #send(session: AgentSession, message: BrainMessage): void {
    session.connection.send(encodeControlMessage(message));
  }

  /**
   * Reports events once the channel's state is settled. Every listener hears every event; one that throws can't stop
   * the others or leave the channel half-changed.
   */
  #emit(events: ControlChannelEvent[]): void {
    const listeners = [...this.#listeners];
    const errors: unknown[] = [];
    for (const event of events) {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch (error) {
          errors.push(error);
        }
      }
    }
    for (const error of errors) this.#onListenerError(error);
  }
}
