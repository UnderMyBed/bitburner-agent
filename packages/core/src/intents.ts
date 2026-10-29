/**
 * Intents (#141, architecture §5.3): one-shot actions the brain wants done, each at most once, and their arguments.
 * Shared by the in-game code and the brain. The game's state is the first idempotency check: an intent the game shows
 * done is never done again.
 *
 * In-game code bundles this, and the game charges RAM for identifiers named like NS functions (packages/ingame/README.md,
 * "RAM"), so the actions are only ever strings here, never identifiers: `upgradeHomeRam` is a Singularity function.
 */
import { AUGMENTATION_NAMES, NEUROFLUX_GOVERNOR } from "./augmentations.ts";
import { isServerHostname } from "./backdoors.ts";
import { BITNODE_COUNT, isBitNodeNumber } from "./bitnodes.ts";
import {
  CLOUD_SERVER_MAX_RAM,
  isCloudServerHostname,
  isCloudServerRam,
  MAX_CLOUD_SERVER_HOSTNAME_LENGTH,
  WORLD_DAEMON,
} from "./cloud-servers.ts";
import { FACTION_ENEMIES, FACTION_NAMES } from "./factions.ts";
import { isUpgradableHomeRam } from "./home-ram.ts";
import { CITIES, TECH_VENDORS } from "./locations.ts";
import { PORT_OPENER_PROGRAMS } from "./programs.ts";

/** Each action and its arguments. */
export type IntentRequest =
  | { action: "buyTor"; args: { vendor: string } }
  | { action: "buyProgram"; args: { program: string } }
  | { action: "upgradeHomeRam"; args: { fromRam: number; vendor: string } }
  | { action: "travel"; args: { city: string } }
  | { action: "joinFaction"; args: { faction: string } }
  /** `level` is 1 but for NeuroFlux Governor, where it's the level bought: each level its own intent (#149). */
  | { action: "purchaseAugmentation"; args: { faction: string; augmentation: string; level: number } }
  /** A cloud server named `hostname` with `ram` GB (#159): done once the player has one of that name. */
  | { action: "buyServer"; args: { hostname: string; ram: number } }
  /** The player's cloud server `hostname` with at least `ram` GB (#194): done once it has. */
  | { action: "upgradeServer"; args: { hostname: string; ram: number } }
  /** A backdoor on `hostname`, through the terminal (#162): done once it's installed, the terminal not left on it. */
  | { action: "backdoor"; args: { hostname: string } }
  /** Installs every augmentation queued (#164): irreversible, and done once nothing is left to install. */
  | { action: "installAugmentations"; args: Record<string, never> }
  /**
   * Destroys the BitNode through w0r1d_d43m0n, then enters `nextBitNode` (#175): irreversible. The game can't show one
   * done (another can follow), so the brain's reset check takes it off its queue.
   */
  | { action: "destroyBitNode"; args: { nextBitNode: number } };

/** Each action, once: a `Record` over `ActionName`, so the compiler refuses a new action left out. */
const EVERY_ACTION: Record<ActionName, true> = {
  travel: true,
  buyTor: true,
  buyProgram: true,
  upgradeHomeRam: true,
  joinFaction: true,
  purchaseAugmentation: true,
  buyServer: true,
  upgradeServer: true,
  backdoor: true,
  installAugmentations: true,
  destroyBitNode: true,
};
/** Every action an intent can name: for the dashboard's queue form, which a test keeps in step (#147). */
export const INTENT_ACTIONS = Object.keys(EVERY_ACTION) as ActionName[];

/** An intent: an action, its arguments, and the id made from them (`intentId`). */
export type Intent = IntentRequest & { id: string };
export type ActionName = IntentRequest["action"];

/** The most intents a desired state carries. */
export const MAX_INTENTS = 100;

/** What an effector reports to the Agent, for an intent or the work: done (converged), and why not. */
export interface EffectorReport {
  /** Done afterwards, by the game's own state: now, or already. */
  done: boolean;
  /** Why it isn't done (the page wasn't as expected, say), or null. */
  problem: string | null;
}

/**
 * The ways the Agent can carry out an intent or converge the work (#145, #151, architecture §5.6). `ui` is a home
 * worker without Singularity: the page's, or NS calls alone where the API needs no Singularity (`buyServer`, #159;
 * `upgradeServer`, #194).
 */
export const EFFECTOR_BACKENDS = ["sim", "singularity", "ui"] as const;
export type EffectorBackend = (typeof EFFECTOR_BACKENDS)[number];

/** What the Agent reports of each intent it holds, in the fast snapshot: the brain's view of how it went (R2). */
export interface IntentOutcome {
  id: string;
  /** Its worker reported it done. */
  done: boolean;
  /** Its worker's runs, done or not, reported or not. */
  tries: number;
  /** The last problem: the worker's, or why it didn't run. Null for none. */
  problem: string | null;
  /** The backend of the last try (#145), or null before the first. */
  backend: EffectorBackend | null;
}

/** An intent's id: its action and its arguments' values, in their fixed order ("upgradeHomeRam(8, CompuTek)"). */
export function intentId<Request extends IntentRequest>(action: Request["action"], args: Request["args"]): string {
  return `${action}(${Object.values(args).join(", ")})`;
}

type Parsed<Value> = { ok: true; message: Value } | { ok: false; reason: string };
type JsonObject = Record<string, unknown>;

const isTechVendor = (vendor: unknown): vendor is string => Object.values(TECH_VENDORS).includes(vendor as string);

/** The args of `action`, rebuilt from the known fields in their fixed order, or why they aren't valid. */
function parseArgs(action: unknown, args: JsonObject): Parsed<IntentRequest> | null {
  switch (action) {
    case "buyTor":
      if (!isTechVendor(args.vendor)) return { ok: false, reason: "buyTor's vendor isn't a tech vendor" };
      return { ok: true, message: { action, args: { vendor: args.vendor } } };
    case "buyProgram":
      if (!PORT_OPENER_PROGRAMS.includes(args.program as string)) {
        return { ok: false, reason: "buyProgram's program isn't a port opener" };
      }
      return { ok: true, message: { action, args: { program: args.program as string } } };
    case "upgradeHomeRam":
      if (!isUpgradableHomeRam(args.fromRam)) {
        return { ok: false, reason: "upgradeHomeRam's fromRam isn't a power of two GB below the limit" };
      }
      if (!isTechVendor(args.vendor)) return { ok: false, reason: "upgradeHomeRam's vendor isn't a tech vendor" };
      return { ok: true, message: { action, args: { fromRam: args.fromRam, vendor: args.vendor } } };
    case "travel":
      if (!CITIES.includes(args.city as string)) return { ok: false, reason: "travel's city isn't one of the six" };
      return { ok: true, message: { action, args: { city: args.city as string } } };
    case "joinFaction":
      if (!FACTION_NAMES.includes(args.faction as string)) {
        return { ok: false, reason: "joinFaction's faction isn't one of the game's" };
      }
      return { ok: true, message: { action, args: { faction: args.faction as string } } };
    case "purchaseAugmentation": {
      if (!FACTION_NAMES.includes(args.faction as string)) {
        return { ok: false, reason: "purchaseAugmentation's faction isn't one of the game's" };
      }
      if (!AUGMENTATION_NAMES.includes(args.augmentation as string)) {
        return { ok: false, reason: "purchaseAugmentation's augmentation isn't one of the game's" };
      }
      const level = args.level;
      if (!Number.isInteger(level) || (level as number) < 1) {
        return { ok: false, reason: "purchaseAugmentation's level isn't a whole number from 1" };
      }
      if (args.augmentation !== NEUROFLUX_GOVERNOR && level !== 1) {
        return { ok: false, reason: "purchaseAugmentation's level is 1 for any augmentation but NeuroFlux Governor" };
      }
      return {
        ok: true,
        message: {
          action,
          args: { faction: args.faction as string, augmentation: args.augmentation as string, level: level as number },
        },
      };
    }
    case "buyServer":
      if (!isCloudServerHostname(args.hostname)) {
        return {
          ok: false,
          reason:
            `buyServer's hostname isn't 1 to ${MAX_CLOUD_SERVER_HOSTNAME_LENGTH} letters, digits, '.', '_' or '-' ` +
            `(not an IP address, hacknet-…, nor ${WORLD_DAEMON})`,
        };
      }
      if (!isCloudServerRam(args.ram)) {
        return { ok: false, reason: `buyServer's ram isn't a power of two GB from 1 to ${CLOUD_SERVER_MAX_RAM}` };
      }
      return { ok: true, message: { action, args: { hostname: args.hostname, ram: args.ram } } };
    case "upgradeServer":
      // Any name `buyServer` takes: the worker checks it's one of the player's cloud servers.
      if (!isCloudServerHostname(args.hostname)) {
        return {
          ok: false,
          reason:
            `upgradeServer's hostname isn't 1 to ${MAX_CLOUD_SERVER_HOSTNAME_LENGTH} letters, digits, '.', '_' or ` +
            `'-' (not an IP address, hacknet-…, nor ${WORLD_DAEMON})`,
        };
      }
      // 1 GB is the least a server has, so never an upgrade.
      if (!isCloudServerRam(args.ram) || args.ram < 2) {
        return { ok: false, reason: `upgradeServer's ram isn't a power of two GB from 2 to ${CLOUD_SERVER_MAX_RAM}` };
      }
      return { ok: true, message: { action, args: { hostname: args.hostname, ram: args.ram } } };
    case "backdoor":
      if (!isServerHostname(args.hostname)) {
        return {
          ok: false,
          reason:
            `backdoor's hostname isn't 1 to ${MAX_CLOUD_SERVER_HOSTNAME_LENGTH} letters, digits, '.', '_' or '-' ` +
            "(not an IP address)",
        };
      }
      if (args.hostname === WORLD_DAEMON) {
        return { ok: false, reason: `a backdoor on ${WORLD_DAEMON} ends the BitNode: that's not a backdoor intent` };
      }
      return { ok: true, message: { action, args: { hostname: args.hostname } } };
    case "installAugmentations":
      return { ok: true, message: { action, args: {} } };
    case "destroyBitNode":
      if (!isBitNodeNumber(args.nextBitNode)) {
        return { ok: false, reason: `destroyBitNode's nextBitNode isn't a whole number from 1 to ${BITNODE_COUNT}` };
      }
      return { ok: true, message: { action, args: { nextBitNode: args.nextBitNode } } };
    default:
      return null;
  }
}

/**
 * An intent from `{ action, args }` (the brain's manual queue, or a desired state's intent without its id), with its
 * id, or why it isn't valid. Only the known fields come through.
 */
export function parseIntentRequest(value: unknown): Parsed<Intent> {
  if (typeof value !== "object" || value === null) return { ok: false, reason: "an intent isn't an object" };
  const { action, args } = value as JsonObject;
  if (typeof args !== "object" || args === null) return { ok: false, reason: "an intent without args" };
  const parsed = parseArgs(action, args as JsonObject);
  if (parsed === null) {
    // The action comes from outside (the dashboard, the store): quoted, never converted, and cut short.
    return {
      ok: false,
      reason: `an intent of an unknown action (${(JSON.stringify(action) ?? typeof action).slice(0, 64)})`,
    };
  }
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    message: { ...parsed.message, id: intentId(parsed.message.action, parsed.message.args) } as Intent,
  };
}

/**
 * Whether doing `intent` can't be undone (R2, R8; #147): the brain then sends it only once its guard has held on two
 * consecutive snapshots and a save backup has been taken: joining a faction with enemies, which bans them, and the
 * intents that reset the game (`resetsTheGame`).
 */
export function isIrreversibleIntent(intent: Intent): boolean {
  if (resetsTheGame(intent)) return true;
  return intent.action === "joinFaction" && FACTION_ENEMIES[intent.args.faction] !== undefined;
}

/**
 * Whether `intent` resets the game, killing every script, the Agent too: installing augmentations (#164), and
 * destroying the BitNode (#175). What's queued after one waits for it, and the brain sees it done by the reset.
 */
export function resetsTheGame(intent: Intent): boolean {
  return intent.action === "installAugmentations" || intent.action === "destroyBitNode";
}
