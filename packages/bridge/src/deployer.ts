// The deployer (#91, architecture §6): on every Remote File API connection it checks the game is the pinned version,
// then deploys the local build to home, atomically. Each deployment gets its own folder, `agent/<deploymentId>/`, and
// the shared paths (`agent/boot.js`, then `agent/current.txt`) change only after every file is pushed and every script
// is within its RAM budget, measured with the game's own calculator. A connected Agent from another deployment is then
// told to restart (the control channel), which it does through boot.js.
import { createHash } from "node:crypto";
import {
  AGENT_CONFIG_FILE_NAME,
  AGENT_SCRIPT_NAME,
  type AgentConfig,
  BOOT_SCRIPT,
  CURRENT_DEPLOYMENT_FILE,
  deployedFilePath,
  deploymentIdOfPath,
  isValidDeploymentId,
  TOKEN_FILE_NAME,
} from "@bitburner-agent/core";
import type { Clock } from "./clock.ts";
import type { Connection } from "./connection.ts";
import type { ControlChannel, DeploymentState } from "./control-channel.ts";
import { EventListeners } from "./event-listeners.ts";
import { RfaClient, RfaError } from "./rfa-client.ts";

const BOOT_SCRIPT_NAME = "boot.js";
/** The calculator's figures are rounded to hundredths; a budget is met at its exact figure. */
const RAM_TOLERANCE_GB = 1e-9;

/** The in-game build to deploy (packages/ingame). */
export interface InGameBuild {
  /** Each in-game script by file name: `boot.js`, `agent.js` and the workers. */
  scripts: Record<string, string>;
  /** Each script's RAM budget in GB (`ram-budget.json`). */
  ramBudgets: Record<string, number>;
}

/**
 * A deployment is a build plus its configuration, so a new token or port is a new deployment (#85): a short hash of
 * every script and both, which is also a valid folder name.
 */
export function deploymentIdOf(build: InGameBuild, { controlPort, token }: { controlPort: number; token: string }) {
  const scripts = Object.entries(build.scripts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256").update(JSON.stringify({ scripts, controlPort, token })).digest("hex").slice(0, 12);
}

export type DeployerEvent =
  /** The game's definition file isn't the pinned one: the deployer holds for good. */
  | { type: "versionDrift"; atMs: number; detail: string }
  | { type: "deployed"; atMs: number; deploymentId: string; replacedDeploymentId: string | null }
  | { type: "deployFailed"; atMs: number; deploymentId: string; reason: string };

export interface DeployerOptions {
  build: InGameBuild;
  controlPort: number;
  token: string;
  /** The pinned game's `NetscriptDefinitions.d.ts`. */
  pinnedDefinitions: string;
  channel: Pick<ControlChannel, "setDeploymentState" | "subscribe" | "connectedAgent">;
  clock: Clock;
  /** Where a listener's error goes. Default: raised as an uncaught exception, so the brain fails fast. */
  onListenerError?: (error: unknown) => void;
}

/** The ids `deploymentIdOf` makes. Cleaning up touches only these folders. */
const GENERATED_DEPLOYMENT_ID = /^[0-9a-f]{12}$/;

export class Deployer {
  readonly deploymentId: string;
  readonly #options: DeployerOptions;
  readonly #listeners: EventListeners<DeployerEvent>;
  readonly #folderFiles: Record<string, string>;
  /** Kept for the brain's life: only a brain built for the new game version may deploy to it. */
  #hold = false;
  #state: DeploymentState = { deployedId: null, hold: false, deployFailed: false };
  #connection: Connection | null = null;

  constructor(options: DeployerOptions) {
    const { scripts, ramBudgets } = options.build;
    for (const required of [BOOT_SCRIPT_NAME, AGENT_SCRIPT_NAME]) {
      if (!(required in scripts)) throw new Error(`the build has no ${required}`);
    }
    for (const name of Object.keys(scripts)) {
      if (typeof ramBudgets[name] !== "number") throw new Error(`${name} has no RAM budget`);
    }
    this.#options = options;
    this.#listeners = new EventListeners(options.onListenerError);
    this.deploymentId = deploymentIdOf(options.build, options);
    const config: AgentConfig = { deploymentId: this.deploymentId, controlPort: options.controlPort };
    // Every script goes into the folder, boot.js included: its RAM is checked there before agent/boot.js changes.
    this.#folderFiles = {
      ...scripts,
      [AGENT_CONFIG_FILE_NAME]: JSON.stringify(config),
      [TOKEN_FILE_NAME]: options.token,
    };
    options.channel.subscribe((event) => {
      if (event.type === "versionDrift") this.#hold = true;
    });
  }

  /** Calls `listener` with every event from now on; returns a function that stops it. */
  subscribe(listener: (event: DeployerEvent) => void): () => void {
    return this.#listeners.subscribe(listener);
  }

  /**
   * Takes a new Remote File API connection from the game, closing any older one (the newest wins), and deploys over
   * it. The promise settles when that's done. A failed deploy is a `deployFailed` event; the promise rejects only on a
   * bug, which then crashes the brain (fail fast).
   */
  accept(connection: Connection): Promise<void> {
    this.#connection?.close(1000, "replaced by a newer connection");
    this.#connection = connection;
    // A replaced connection's deploy may still be finishing: from then on, nothing it learns counts.
    const isNewest = () => this.#connection === connection;
    return this.#deployOver(new RfaClient(connection, this.#options.clock), connection, isNewest);
  }

  async #deployOver(client: RfaClient, connection: Connection, isNewest: () => boolean): Promise<void> {
    if (this.#hold) return;
    try {
      const drift = definitionDrift(await client.getDefinitionFile(), this.#options.pinnedDefinitions);
      if (!isNewest()) return;
      if (drift !== null) {
        this.#hold = true;
        this.#tell({ hold: true });
        this.#emit({ type: "versionDrift", atMs: this.#options.clock.now(), detail: drift });
        return;
      }
      const current = (await client.getFile(CURRENT_DEPLOYMENT_FILE))?.trim() ?? "";
      if (!isNewest()) return;
      const currentId = isValidDeploymentId(current) ? current : null;
      this.#tell({ deployedId: currentId, deployFailed: false });
      if (currentId === this.deploymentId) return;
      await this.#deploy(client, currentId, isNewest);
    } catch (error) {
      if (!(error instanceof RfaError || error instanceof OverBudgetError)) throw error;
      if (!isNewest()) return;
      this.#tell({ deployFailed: true });
      this.#emit({
        type: "deployFailed",
        atMs: this.#options.clock.now(),
        deploymentId: this.deploymentId,
        reason: error.message,
      });
      // The game never answered: close, so it reconnects after its reconnection delay and the deploy is tried again.
      if (error instanceof RfaError && error.kind === "timeout") connection.close(1000, "no reply in time");
    }
  }

  async #deploy(client: RfaClient, currentId: string | null, isNewest: () => boolean): Promise<void> {
    const { scripts, ramBudgets } = this.#options.build;
    for (const [name, content] of Object.entries(this.#folderFiles)) {
      await client.pushFile(deployedFilePath(this.deploymentId, name), content);
    }
    for (const name of Object.keys(scripts)) {
      const ramGb = await client.calculateRam(deployedFilePath(this.deploymentId, name));
      const budgetGb = ramBudgets[name] as number;
      if (ramGb > budgetGb + RAM_TOLERANCE_GB) {
        throw new OverBudgetError(`${name} needs ${ramGb} GB, over its budget of ${budgetGb} GB`);
      }
    }
    // Checked again before anything shared changes: an Agent's hello may have reported another game version since.
    if (this.#hold || !isNewest()) return;
    const bootScript = scripts[BOOT_SCRIPT_NAME] as string;
    if ((await client.getFile(BOOT_SCRIPT)) !== bootScript) await client.pushFile(BOOT_SCRIPT, bootScript);
    // The switch-over: until now, a restart or a load finds the old deployment.
    await client.pushFile(CURRENT_DEPLOYMENT_FILE, this.deploymentId);
    if (!isNewest()) return;
    this.#tell({ deployedId: this.deploymentId, deployFailed: false });
    this.#emit({
      type: "deployed",
      atMs: this.#options.clock.now(),
      deploymentId: this.deploymentId,
      replacedDeploymentId: currentId,
    });
    // Tidying only: the deploy has succeeded whatever happens here, and the next one tidies again.
    const kept = new Set([this.deploymentId, currentId, this.#options.channel.connectedAgent()?.deploymentId]);
    await this.#removeOldDeployments(client, kept).catch((error: unknown) => {
      if (!(error instanceof RfaError)) throw error;
    });
  }

  /**
   * Deletes the files of every deployment folder but those kept. Only folders the deployer makes count (12 hex digits),
   * never a player's own `agent/<name>/`. Scripts go first: the game refuses to delete a running one, and then the rest
   * of that folder (its config and token, which a running Agent reads) is left for a later tidy.
   */
  async #removeOldDeployments(client: RfaClient, kept: Set<string | null | undefined>): Promise<void> {
    const folders = new Map<string, string[]>();
    for (const name of await client.getFileNames()) {
      const deploymentId = deploymentIdOfPath(name);
      if (deploymentId === null || !GENERATED_DEPLOYMENT_ID.test(deploymentId) || kept.has(deploymentId)) continue;
      folders.set(deploymentId, [...(folders.get(deploymentId) ?? []), name]);
    }
    for (const names of folders.values()) {
      const scriptsFirst = [...names.filter(isScript), ...names.filter((name) => !isScript(name))];
      for (const name of scriptsFirst) {
        try {
          await client.deleteFile(name);
        } catch (error) {
          if (error instanceof RfaError && error.kind === "game") break;
          throw error;
        }
      }
    }
  }

  #tell(changes: Partial<DeploymentState>): void {
    this.#state = { ...this.#state, ...changes, hold: this.#hold };
    this.#options.channel.setDeploymentState(this.#state);
  }

  /** A listener that throws can't stop the others, or the deploy: its error goes to `onListenerError`. */
  #emit(event: DeployerEvent): void {
    this.#listeners.emit(event);
  }
}

const isScript = (name: string) => name.endsWith(".js");

class OverBudgetError extends Error {}

/** Null if the definition files match, ignoring line endings; otherwise where they first differ. */
function definitionDrift(gameDefinitions: string, pinnedDefinitions: string): string | null {
  const gameLines = gameDefinitions.replaceAll("\r\n", "\n").split("\n");
  const pinnedLines = pinnedDefinitions.replaceAll("\r\n", "\n").split("\n");
  const lineCount = Math.max(gameLines.length, pinnedLines.length);
  for (let index = 0; index < lineCount; index++) {
    if (gameLines[index] !== pinnedLines[index]) {
      return `the game's NetscriptDefinitions.d.ts differs from the pinned one, from line ${index + 1}`;
    }
  }
  return null;
}
