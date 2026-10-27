/**
 * The control channel's messages (docs/bridge/protocol.md): text frames of JSON between the in-game Agent and the
 * brain. Shared by both sides, so it has no dependencies and uses neither Node nor the DOM. In-game code bundles it,
 * so its names must not collide with NS function names (packages/ingame/README.md, "RAM").
 */
import { isValidDeploymentId } from "./deploy-layout.ts";
import { isUpgradableHomeRam } from "./home-ram.ts";
import { PORT_OPENER_PROGRAMS, TOR_ROUTER } from "./programs.ts";
import { TECH_VENDORS } from "./purchases.ts";

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
 * got. M3 adds an activity per slice: the hack loop (#134), the hacking programs (#136), home's RAM (#138). The brain
 * asks for one purchase at a time, of the programs and home's RAM.
 */
export interface DesiredState {
  /**
   * The hack loop: servers rooted where possible, and the loop running on `hosts` against `target` (null: none worth
   * hacking yet). Off, every loop stops, wherever it runs.
   */
  hackLoop: { enabled: boolean; target: string | null; hosts: string[] };
  /**
   * The hacking programs: the next one to buy, or null for none now. `vendor` names the tech vendor in the player's
   * city to buy the TOR router at, and is null for a program.
   */
  programs: { enabled: boolean; next: { item: string; vendor: string | null } | null };
  /**
   * Home's RAM: the next upgrade to buy, or null for none now. `fromRam` is home's RAM (GB) when the brain asked, so
   * the upgrade is done once home has more; `vendor` names the tech vendor in the player's city to buy it at.
   */
  homeRam: { enabled: boolean; next: { fromRam: number; vendor: string } | null };
}

/** The most hosts a desired state names: a whole network is well under it. */
export const MAX_HACK_LOOP_HOSTS = 1_000;

/**
 * What may go to an Agent while the brain holds (on hold, after a failed deploy, or once the game has drifted), or to
 * an outdated one: only a state that starts nothing new, given `lastSent`, what that Agent was last sent (null for
 * nothing yet). Nothing is bought. The hack loop off goes as it is (stopping our own loops is always safe); on, it
 * stays as last sent, and with nothing sent yet, nothing goes. So "Stop buying programs" gets through a hold whatever
 * the hack loop does.
 */
export function desiredStateWhileHolding(state: DesiredState, lastSent: DesiredState | null): DesiredState | null {
  const purchases = {
    programs: { enabled: state.programs.enabled, next: null },
    homeRam: { enabled: state.homeRam.enabled, next: null },
  };
  if (!state.hackLoop.enabled) return { hackLoop: state.hackLoop, ...purchases };
  return lastSent === null ? null : { hackLoop: lastSent.hackLoop, ...purchases };
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
const isSafeIntegerAtLeast = (value: unknown, minimum: number): value is number =>
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

/** A desired state's `programs`: the next item is TOR, at a named vendor, or a port opener, at none. */
function parsePrograms(programs: unknown): ParsedMessage<DesiredState["programs"]> {
  if (typeof programs !== "object" || programs === null) return { ok: false, reason: "desiredState without programs" };
  const { enabled, next } = programs as JsonObject;
  if (typeof enabled !== "boolean") return { ok: false, reason: "desiredState's programs.enabled isn't a boolean" };
  if (next === null) return { ok: true, message: { enabled, next: null } };
  if (typeof next !== "object") return { ok: false, reason: `desiredState's programs.next is ${describeValue(next)}` };
  const { item, vendor } = next as JsonObject;
  const isTor = item === TOR_ROUTER;
  if (!isTor && !PORT_OPENER_PROGRAMS.includes(item as string)) {
    return { ok: false, reason: `desiredState's programs.next.item is ${describeValue(item)}` };
  }
  if (isTor ? !isTechVendor(vendor) : vendor !== null) {
    return {
      ok: false,
      reason: "desiredState's programs.next.vendor must be a tech vendor for TOR, and null otherwise",
    };
  }
  return { ok: true, message: { enabled, next: { item: item as string, vendor: vendor as string | null } } };
}

const isTechVendor = (vendor: unknown): vendor is string => Object.values(TECH_VENDORS).includes(vendor as string);

/** A desired state's `homeRam`: the next upgrade is from a size home can be upgraded from, at a tech vendor. */
function parseHomeRam(homeRam: unknown): ParsedMessage<DesiredState["homeRam"]> {
  if (typeof homeRam !== "object" || homeRam === null) return { ok: false, reason: "desiredState without homeRam" };
  const { enabled, next } = homeRam as JsonObject;
  if (typeof enabled !== "boolean") return { ok: false, reason: "desiredState's homeRam.enabled isn't a boolean" };
  if (next === null) return { ok: true, message: { enabled, next: null } };
  if (typeof next !== "object") return { ok: false, reason: `desiredState's homeRam.next is ${describeValue(next)}` };
  const { fromRam, vendor } = next as JsonObject;
  if (!isUpgradableHomeRam(fromRam)) {
    return { ok: false, reason: `desiredState's homeRam.next.fromRam is ${describeValue(fromRam)}` };
  }
  if (!isTechVendor(vendor)) {
    return { ok: false, reason: `desiredState's homeRam.next.vendor is ${describeValue(vendor)}, not a tech vendor` };
  }
  return { ok: true, message: { enabled, next: { fromRam, vendor } } };
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
      if (!isDeploymentId(fields.deploymentId)) return { ok: false, reason: "restart without a valid deploymentId" };
      return {
        ok: true,
        message: { protocolVersion: CONTROL_PROTOCOL_VERSION, type: "restart", deploymentId: fields.deploymentId },
      };
    case "desiredState": {
      const hackLoop = fields.hackLoop;
      if (typeof hackLoop !== "object" || hackLoop === null) {
        return { ok: false, reason: "desiredState without a hackLoop" };
      }
      const { enabled, target, hosts } = hackLoop as JsonObject;
      if (typeof enabled !== "boolean") return { ok: false, reason: "desiredState's hackLoop.enabled isn't a boolean" };
      if (target !== null && !isShortNonEmptyString(target)) {
        return { ok: false, reason: `desiredState's hackLoop.target is ${describeValue(target)}` };
      }
      if (!Array.isArray(hosts) || hosts.length > MAX_HACK_LOOP_HOSTS || !hosts.every(isShortNonEmptyString)) {
        return { ok: false, reason: "desiredState's hackLoop.hosts isn't a list of hostnames" };
      }
      const programs = parsePrograms(fields.programs);
      if (!programs.ok) return programs;
      const homeRam = parseHomeRam(fields.homeRam);
      if (!homeRam.ok) return homeRam;
      return {
        ok: true,
        message: {
          protocolVersion: CONTROL_PROTOCOL_VERSION,
          type: "desiredState",
          hackLoop: { enabled, target, hosts: [...hosts] },
          programs: programs.message,
          homeRam: homeRam.message,
        },
      };
    }
    default:
      return { ok: false, reason: `unknown message type ${describeValue(fields.type)}` };
  }
}
