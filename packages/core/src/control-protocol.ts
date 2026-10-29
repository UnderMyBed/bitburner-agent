/**
 * The control channel's messages (docs/bridge/protocol.md): text frames of JSON between the in-game Agent and the
 * brain. Shared by both sides, so it has no dependencies and uses neither Node nor the DOM. In-game code bundles it,
 * so its names must not collide with NS function names (packages/ingame/README.md, "RAM").
 */
import { isValidDeploymentId } from "./deploy-layout.ts";
import { type Intent, intentId, MAX_INTENTS, parseIntentRequest } from "./intents.ts";
import { parseWork, type Work } from "./work.ts";

export const CONTROL_PROTOCOL_VERSION = 1;

/** Snapshot tiers, slowest first (architecture §5.2). The fast snapshot is the heartbeat. */
export const SNAPSHOT_TIERS = ["static", "slow", "medium", "fast"] as const;
export type SnapshotTier = (typeof SNAPSHOT_TIERS)[number];
/**
 * How often each tier is sent, in game time (docs/bridge/protocol.md): the fast tier every round, the others every so
 * many rounds. The static tier is sent once per Agent start, and again after each welcome.
 */
export const SNAPSHOT_TIER_PERIOD_MS = { fast: 2_000, medium: 10_000, slow: 60_000 } as const;

/** `ns.ui.getGameInfo()`'s fields, reported for the version check against the pinned game (the deployer, #91). */
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
  /** The tier's contents: `StaticSnapshotData`, `SlowSnapshotData`, `MediumSnapshotData` or `FastSnapshotData`. */
  data: unknown;
}

export type AgentMessage = HelloMessage | SnapshotMessage;

/**
 * What the brain wants running in the game (architecture D2), whole each time: the Agent converges on the last one it
 * got: the hack loop (#134), and the intents (#141), one-shot actions done at most once (architecture §5.3).
 */
export interface DesiredState {
  /**
   * The hack loop: servers rooted where possible, and the loop running on `hosts` against `target` (null: none worth
   * hacking yet), and on `preparing.hosts` against `preparing.target`, the next target, weakened and grown until it's
   * ready to hack while the others earn (#184). Off, every loop stops, wherever it runs.
   */
  hackLoop: HackLoopState;
  /**
   * What to do, in order, each until the game shows it done: buying the TOR router, a program or home RAM (the brain's
   * purchase rules), and anything the owner queued (the dashboard). An intent that leaves the list isn't tried again.
   */
  intents: Intent[];
  /**
   * The work the player does, converged on when it changes and every 30 s (#151), or absent (null): the brain doesn't
   * manage work, and the Agent leaves whatever work there is alone.
   */
  work?: Work | null;
  /**
   * Safe mode (#160, architecture §5.4): with the brain gone, the Agent keeps converging on this state, minus its
   * intents, for this long after it was last connected to the brain that sent it, at most `MAX_SAFE_MODE_TTL_MS`. Absent
   * (an older brain) or 0: it isn't kept past the brain.
   */
  ttlMs?: number;
}

/** The desired state's hack loop. */
export interface HackLoopState {
  enabled: boolean;
  target: string | null;
  hosts: string[];
  /**
   * The next target and the hosts preparing it (#184), or absent (null): none. Never with the loop off or without a
   * target, its hosts never among `hosts`, and both lists together within `MAX_HACK_LOOP_HOSTS`. Absent is how an
   * older brain, and safe mode's file from one, says none.
   */
  preparing?: { target: string; hosts: string[] } | null;
}

/** The longest `ttlMs` taken: 7 days, so a time it makes is always one a date can show (#160). */
export const MAX_SAFE_MODE_TTL_MS = 604_800_000;

/** The most hosts a desired state names: a whole network is well under it. */
export const MAX_HACK_LOOP_HOSTS = 1_000;

/**
 * What may go to an Agent while the brain holds (on hold, after a failed deploy, or once the game has drifted), or to
 * an outdated one: only a state that starts nothing new, given `lastSent`, what that Agent was last sent (null for
 * nothing yet). No intents. The hack loop off goes as it is (stopping our own loops is always safe); on, it stays as
 * last sent, and with nothing sent yet, nothing goes. So the intents' removal gets through a hold whatever the hack
 * loop does. No work either: the Agent leaves the work as it is (#151). `ttlMs` goes as the brain set it (#160): a held
 * state starts nothing new, so safe mode keeping it starts nothing new either.
 */
export function desiredStateWhileHolding(state: DesiredState, lastSent: DesiredState | null): DesiredState | null {
  const kept = state.ttlMs === undefined ? {} : { ttlMs: state.ttlMs };
  if (!state.hackLoop.enabled) return { hackLoop: state.hackLoop, intents: [], ...kept };
  return lastSent === null ? null : { hackLoop: lastSent.hackLoop, intents: [], ...kept };
}

export type BrainMessage =
  | { protocolVersion: typeof CONTROL_PROTOCOL_VERSION; type: "welcome" }
  /** The Agent isn't running the deployed deployment: it runs `agent/boot.js` and exits. */
  | { protocolVersion: typeof CONTROL_PROTOCOL_VERSION; type: "restart"; deploymentId: string }
  | ({ protocolVersion: typeof CONTROL_PROTOCOL_VERSION; type: "desiredState" } & DesiredState);

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

/** The longest identifier or version string accepted: tokens, ids and versions are far shorter. */
export const MAX_FIELD_LENGTH = 256;

type JsonObject = Record<string, unknown>;

/** How much of a bad value a rejection reason quotes: reasons are stored and logged, and frames can be 16 MiB. */
const MAX_QUOTED_VALUE_LENGTH = 64;

/** A value for a rejection reason: as JSON, cut short. */
function describeValue(value: unknown): string {
  const json = JSON.stringify(value) ?? String(value);
  return json.length <= MAX_QUOTED_VALUE_LENGTH ? json : `${json.slice(0, MAX_QUOTED_VALUE_LENGTH)}…`;
}
const isShortNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value !== "" && value.length <= MAX_FIELD_LENGTH;
export const isSafeIntegerAtLeast = (value: unknown, minimum: number): value is number =>
  Number.isSafeInteger(value) && (value as number) >= minimum;
const isDeploymentId = (value: unknown): value is string => isShortNonEmptyString(value) && isValidDeploymentId(value);

/** The envelope every message shares: an object of this protocol version, with a type. */
function parseEnvelope(text: string): ParsedMessage<JsonObject> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "not JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "not a JSON object" };
  }
  const { protocolVersion } = parsed as JsonObject;
  if (protocolVersion !== CONTROL_PROTOCOL_VERSION) {
    return {
      ok: false,
      reason: `protocol version ${describeValue(protocolVersion)}, not ${CONTROL_PROTOCOL_VERSION}`,
    };
  }
  return { ok: true, message: parsed as JsonObject };
}

function parseGameInfo(game: unknown): GameInfo | null {
  if (typeof game !== "object" || game === null) return null;
  const { version, versionNumber, commit, platform } = game as JsonObject;
  if (!isShortNonEmptyString(version) || !isShortNonEmptyString(commit) || !isShortNonEmptyString(platform))
    return null;
  if (!isSafeIntegerAtLeast(versionNumber, 0)) return null;
  return { version, versionNumber, commit, platform };
}

/**
 * What the brain accepts from the Agent; anything else is a reason to close (4002). The message is rebuilt from the
 * known fields, so nothing else the Agent sent comes along. `data` stays as sent: it's untrusted (#89, #90).
 */
export function parseAgentMessage(text: string): ParsedMessage<AgentMessage> {
  const envelope = parseEnvelope(text);
  if (!envelope.ok) return envelope;
  const fields = envelope.message;
  switch (fields.type) {
    case "hello": {
      const { token, deploymentId, agentSessionId } = fields;
      if (!isShortNonEmptyString(token)) return { ok: false, reason: "hello without a token" };
      if (!isDeploymentId(deploymentId)) return { ok: false, reason: "hello without a valid deploymentId" };
      if (!isShortNonEmptyString(agentSessionId)) return { ok: false, reason: "hello without an agentSessionId" };
      const game = parseGameInfo(fields.game);
      if (!game) return { ok: false, reason: "hello without game info (version, versionNumber, commit, platform)" };
      return {
        ok: true,
        message: {
          protocolVersion: CONTROL_PROTOCOL_VERSION,
          type: "hello",
          token,
          deploymentId,
          agentSessionId,
          game,
        },
      };
    }
    case "snapshot": {
      const { agentSessionId, tier, sequenceNumber, gameTimeMs } = fields;
      if (!isShortNonEmptyString(agentSessionId)) return { ok: false, reason: "snapshot without an agentSessionId" };
      if (!SNAPSHOT_TIERS.includes(tier as SnapshotTier)) {
        return { ok: false, reason: `snapshot of tier ${describeValue(tier)}` };
      }
      if (!isSafeIntegerAtLeast(sequenceNumber, 1)) {
        return { ok: false, reason: "snapshot sequenceNumber must be 1 or more" };
      }
      if (!isSafeIntegerAtLeast(gameTimeMs, 0)) return { ok: false, reason: "snapshot without gameTimeMs" };
      if (!("data" in fields)) return { ok: false, reason: "snapshot without data" };
      return {
        ok: true,
        message: {
          protocolVersion: CONTROL_PROTOCOL_VERSION,
          type: "snapshot",
          agentSessionId,
          tier: tier as SnapshotTier,
          sequenceNumber,
          gameTimeMs,
          data: fields.data,
        },
      };
    }
    default:
      return { ok: false, reason: `unknown message type ${describeValue(fields.type)}` };
  }
}

/** A desired state's `intents`: each valid, with its own id, none twice, at most `MAX_INTENTS`. */
function parseIntents(intents: unknown): ParsedMessage<Intent[]> {
  if (!Array.isArray(intents) || intents.length > MAX_INTENTS) {
    return { ok: false, reason: `desiredState's intents isn't a list of at most ${MAX_INTENTS}` };
  }
  const parsedIntents: Intent[] = [];
  for (const intent of intents) {
    const parsed = parseIntentRequest(intent);
    if (!parsed.ok) return { ok: false, reason: `desiredState's intent: ${parsed.reason}` };
    // An id is its action and args, so the Agent can tell intents apart by id alone.
    if ((intent as JsonObject).id !== intentId(parsed.message.action, parsed.message.args)) {
      return {
        ok: false,
        reason: `desiredState's intent ${describeValue((intent as JsonObject).id)} isn't its own id`,
      };
    }
    if (parsedIntents.some((each) => each.id === parsed.message.id)) {
      return { ok: false, reason: `desiredState's intent ${parsed.message.id} is there twice` };
    }
    parsedIntents.push(parsed.message);
  }
  return { ok: true, message: parsedIntents };
}
/**
 * A desired state's `hackLoop`: its known fields only, or why it isn't valid. Safe mode's file uses it too (#160).
 * `preparing` absent and null are the same (#184): only one with hosts to prepare on is carried.
 */
export function parseHackLoop(hackLoop: unknown): ParsedMessage<HackLoopState> {
  if (typeof hackLoop !== "object" || hackLoop === null) return { ok: false, reason: "hackLoop isn't an object" };
  const { enabled, target, hosts, preparing } = hackLoop as JsonObject;
  if (typeof enabled !== "boolean") return { ok: false, reason: "hackLoop.enabled isn't a boolean" };
  if (target !== null && !isShortNonEmptyString(target)) {
    return { ok: false, reason: `hackLoop.target is ${describeValue(target)}` };
  }
  if (!isHostList(hosts)) return { ok: false, reason: "hackLoop.hosts isn't a list of hostnames" };
  if (preparing === undefined || preparing === null) {
    return { ok: true, message: { enabled, target, hosts: [...hosts] } };
  }
  if (typeof preparing !== "object") return { ok: false, reason: "hackLoop.preparing isn't an object" };
  const { target: preparingTarget, hosts: preparingHosts } = preparing as JsonObject;
  if (!enabled || target === null) return { ok: false, reason: "hackLoop.preparing with the loop off or no target" };
  if (!isShortNonEmptyString(preparingTarget)) {
    return { ok: false, reason: `hackLoop.preparing.target is ${describeValue(preparingTarget)}` };
  }
  if (!isHostList(preparingHosts) || hosts.length + preparingHosts.length > MAX_HACK_LOOP_HOSTS) {
    return { ok: false, reason: "hackLoop.preparing.hosts isn't a list of hostnames" };
  }
  // One target per host: the deploy worker would otherwise start one and stop it on the next round.
  const earningHosts = new Set(hosts);
  if (preparingHosts.some((host) => earningHosts.has(host))) {
    return { ok: false, reason: "hackLoop.preparing.hosts names a host of hackLoop.hosts" };
  }
  if (preparingHosts.length === 0) return { ok: true, message: { enabled, target, hosts: [...hosts] } };
  return {
    ok: true,
    message: { enabled, target, hosts: [...hosts], preparing: { target: preparingTarget, hosts: [...preparingHosts] } },
  };
}

const isHostList = (hosts: unknown): hosts is string[] =>
  Array.isArray(hosts) && hosts.length <= MAX_HACK_LOOP_HOSTS && hosts.every(isShortNonEmptyString);

/** What the Agent accepts from the brain. */
export function parseBrainMessage(text: string): ParsedMessage<BrainMessage> {
  const envelope = parseEnvelope(text);
  if (!envelope.ok) return envelope;
  const fields = envelope.message;
  switch (fields.type) {
    case "welcome":
      return { ok: true, message: { protocolVersion: CONTROL_PROTOCOL_VERSION, type: "welcome" } };
    case "restart":
      if (!isDeploymentId(fields.deploymentId)) return { ok: false, reason: "restart without a valid deploymentId" };
      return {
        ok: true,
        message: { protocolVersion: CONTROL_PROTOCOL_VERSION, type: "restart", deploymentId: fields.deploymentId },
      };
    case "desiredState": {
      const hackLoop = parseHackLoop(fields.hackLoop);
      if (!hackLoop.ok) return { ok: false, reason: `desiredState's ${hackLoop.reason}` };
      const intents = parseIntents(fields.intents);
      if (!intents.ok) return intents;
      const work = parseWork(fields.work);
      if (!work.ok) return { ok: false, reason: `desiredState's ${work.reason}` };
      const { ttlMs } = fields;
      if (ttlMs !== undefined && (!isSafeIntegerAtLeast(ttlMs, 0) || ttlMs > MAX_SAFE_MODE_TTL_MS)) {
        return { ok: false, reason: `desiredState's ttlMs is ${describeValue(ttlMs)}` };
      }
      return {
        ok: true,
        message: {
          protocolVersion: CONTROL_PROTOCOL_VERSION,
          type: "desiredState",
          hackLoop: hackLoop.message,
          intents: intents.message,
          // Absent and null are the same: no work managed. Only a work to do is carried.
          ...(work.message === null ? {} : { work: work.message }),
          // Absent and 0 are the same: not kept past the brain (#160).
          ...(ttlMs === undefined || ttlMs === 0 ? {} : { ttlMs }),
        },
      };
    }
    default:
      return { ok: false, reason: `unknown message type ${describeValue(fields.type)}` };
  }
}
