/**
 * One connection from the game's page, whatever carries it: a WebSocket live and on E2, the simulator's network under
 * the lockstep driver (#90). The session logic (`ControlChannel`) only ever sees this.
 */
export interface Connection {
  /** Sends a text frame. Ignored once the connection is closing or closed. */
  send(text: string): void;
  /** Closes the connection with an application close code (4000-4999) or 1000. */
  close(code: number, reason: string): void;
  /** Called for each text frame, in order. */
  onMessage(listener: (text: string) => void): void;
  /** Called once, when the connection has closed, from either side. */
  onClose(listener: () => void): void;
}
