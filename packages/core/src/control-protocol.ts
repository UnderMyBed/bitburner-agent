/**
 * The control channel's messages (docs/bridge/protocol.md): text frames of JSON between the in-game Agent and the
 * brain. Shared by both sides, so it has no dependencies and uses neither Node nor the DOM. In-game code bundles it,
 * so its names must not collide with NS function names (packages/ingame/README.md, "RAM").
 */
import { isValidDeploymentId } from "./deploy-layout.ts";

export const CONTROL_PROTOCOL_VERSION = 1;

/** Snapshot tiers, slowest first (architecture §5.2). The fast snapshot is the heartbeat. */
export const SNAPSHOT_TIERS = ["static", "slow", "medium", "fast"] as const;
export type SnapshotTier = (typeof SNAPSHOT_TIERS)[number];

/** `ns.ui.getGameInfo()`'s fields the brain checks against the pinned version. */
export interface GameInfo {
  version: string;
  versionNumber: number;
  commit: string;
  platform: string;
}

export interface HelloMessage {
  protocolVersion: typeof CONTROL_PROTOCOL_VERSION;
  type: "hello";
  token: string;
  /** The deployment the Agent runs from. */
  deploymentId: string;
  /** New each time the Agent starts; sequence numbers count per session and tier. */
  agentSessionId: string;
  game: GameInfo;
}

export interface SnapshotMessage {
  protocolVersion: typeof CONTROL_PROTOCOL_VERSION;
  type: "snapshot";
  agentSessionId: string;
  tier: SnapshotTier;
  /** 1, 2, 3… per session and tier. */
  sequenceNumber: number;
  /** The game's `Date.now()` when the snapshot was taken. */
  gameTimeMs: number;
  /** The tier's contents (#89); `null` only when the Agent has nothing for it. */
  data: unknown;
}

export type AgentMessage = HelloMessage | SnapshotMessage;

export type BrainMessage =
  | { protocolVersion: typeof CONTROL_PROTOCOL_VERSION; type: "welcome" }
  /** The Agent isn't running the deployed deployment: it runs `agent/boot.js` and exits. */
  | { protocolVersion: typeof CONTROL_PROTOCOL_VERSION; type: "restart"; deploymentId: string };

export type ParsedMessage<Message> = { ok: true; message: Message } | { ok: false; reason: string };

/** Close codes the brain uses (application codes are 4000-4999). */
export const CONTROL_CLOSE_CODES = {
  /** A newer Agent connection replaced this one. */
  replaced: 4000,
  /** No valid hello within the time allowed. */
  helloTimeout: 4001,
  /** A message that doesn't parse, has another protocol version, or comes out of order. */
  badMessage: 4002,
  /** The hello's token is wrong. */
  wrongToken: 4003,
} as const;

export function encodeControlMessage(message: AgentMessage | BrainMessage): string {
  return JSON.stringify(message);
}

type Fields = Record<string, unknown>;
const isText = (value: unknown): value is string => typeof value === "string" && value !== "";
const isWholeNumber = (value: unknown, least: number): value is number =>
  Number.isSafeInteger(value) && (value as number) >= least;

/** The envelope every message shares: an object of this protocol version, with a type. */
function parseEnvelope(text: string): ParsedMessage<Fields & { type: unknown }> {
  let fields: unknown;
  try {
    fields = JSON.parse(text);
  } catch {
    return { ok: false, reason: "not JSON" };
  }
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) {
    return { ok: false, reason: "not a JSON object" };
  }
  const { protocolVersion } = fields as Fields;
  if (protocolVersion !== CONTROL_PROTOCOL_VERSION) {
    return {
      ok: false,
      reason: `protocol version ${JSON.stringify(protocolVersion)}, not ${CONTROL_PROTOCOL_VERSION}`,
    };
  }
  return { ok: true, message: fields as Fields & { type: unknown } };
}

function gameInfoProblem(game: unknown): string | null {
  if (typeof game !== "object" || game === null) return "game info missing";
  const { version, versionNumber, commit, platform } = game as Fields;
  if (!isText(version) || !isText(commit) || !isText(platform)) return "game info needs version, commit and platform";
  if (!isWholeNumber(versionNumber, 0)) return "game info's versionNumber must be a whole number";
  return null;
}

/** What the brain accepts from the Agent; anything else is a reason to close (4002). */
export function parseAgentMessage(text: string): ParsedMessage<AgentMessage> {
  const envelope = parseEnvelope(text);
  if (!envelope.ok) return envelope;
  const fields = envelope.message;
  switch (fields.type) {
    case "hello": {
      if (!isText(fields.token)) return { ok: false, reason: "hello without a token" };
      if (!isText(fields.deploymentId) || !isValidDeploymentId(fields.deploymentId)) {
        return { ok: false, reason: "hello without a valid deploymentId" };
      }
      if (!isText(fields.agentSessionId)) return { ok: false, reason: "hello without an agentSessionId" };
      const problem = gameInfoProblem(fields.game);
      if (problem) return { ok: false, reason: `hello: ${problem}` };
      return { ok: true, message: fields as unknown as HelloMessage };
    }
    case "snapshot": {
      if (!isText(fields.agentSessionId)) return { ok: false, reason: "snapshot without an agentSessionId" };
      if (!SNAPSHOT_TIERS.includes(fields.tier as SnapshotTier)) {
        return { ok: false, reason: `snapshot of tier ${JSON.stringify(fields.tier)}` };
      }
      if (!isWholeNumber(fields.sequenceNumber, 1))
        return { ok: false, reason: "snapshot sequenceNumber must be 1 or more" };
      if (!isWholeNumber(fields.gameTimeMs, 0)) return { ok: false, reason: "snapshot without gameTimeMs" };
      if (!("data" in fields)) return { ok: false, reason: "snapshot without data" };
      return { ok: true, message: fields as unknown as SnapshotMessage };
    }
    default:
      return { ok: false, reason: `unknown message type ${JSON.stringify(fields.type)}` };
  }
}

/** What the Agent accepts from the brain. */
export function parseBrainMessage(text: string): ParsedMessage<BrainMessage> {
  const envelope = parseEnvelope(text);
  if (!envelope.ok) return envelope;
  const fields = envelope.message;
  switch (fields.type) {
    case "welcome":
      return { ok: true, message: { protocolVersion: CONTROL_PROTOCOL_VERSION, type: "welcome" } };
    case "restart":
      if (!isText(fields.deploymentId) || !isValidDeploymentId(fields.deploymentId)) {
        return { ok: false, reason: "restart without a valid deploymentId" };
      }
      return {
        ok: true,
        message: { protocolVersion: CONTROL_PROTOCOL_VERSION, type: "restart", deploymentId: fields.deploymentId },
      };
    default:
      return { ok: false, reason: `unknown message type ${JSON.stringify(fields.type)}` };
  }
}
