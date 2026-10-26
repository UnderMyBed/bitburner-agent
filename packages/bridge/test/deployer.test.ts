// The deployer (#91): on every Remote File API connection it checks the game's version, then deploys the local build
// atomically (current.txt last, only after every file is pushed and within its RAM budget), and cleans up.
import { BOOT_SCRIPT, CURRENT_DEPLOYMENT_FILE, deployedFilePath, isValidDeploymentId } from "@bitburner-agent/core";
import { beforeEach, describe, expect, test } from "vitest";
import type { ConnectedAgent, ControlChannelEvent, DeploymentState } from "../src/control-channel.ts";
import { Deployer, type DeployerEvent, deploymentIdOf, type InGameBuild } from "../src/deployer.ts";
import { FakeRfaGame, ManualClock } from "./helpers/fakes.ts";

const PINNED_DEFINITIONS = "interface NS {\n  run(): number;\n}\n";
const PINNED_GAME_INFO = { version: "3.0.1", versionNumber: 51, commit: "1da7316ff", platform: "Steam" };
const TOKEN = "a".repeat(64);
const CONTROL_PORT = 12526;
const BUILD: InGameBuild = {
  scripts: {
    "agent.js": "// agent",
    "boot.js": "// boot",
    "snapshot-fast.js": "// fast",
  },
  // The fake game measures every script at 2.6 GB unless a test says otherwise.
  ramBudgets: { "agent.js": 3, "boot.js": 2.7, "snapshot-fast.js": 2.6 },
};

/** The parts of the control channel the deployer uses, recording what it's told. */
class RecordingChannel {
  readonly states: DeploymentState[] = [];
  readonly #listeners: ((event: ControlChannelEvent) => void)[] = [];
  connected: ConnectedAgent | null = null;
  connectedAgent(): ConnectedAgent | null {
    return this.connected;
  }
  setDeploymentState(state: DeploymentState): void {
    this.states.push({ ...state });
  }
  subscribe(listener: (event: ControlChannelEvent) => void): () => void {
    this.#listeners.push(listener);
    return () => {};
  }
  emit(event: ControlChannelEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}

let clock: ManualClock;
let channel: RecordingChannel;
let events: DeployerEvent[];

beforeEach(() => {
  clock = new ManualClock();
  channel = new RecordingChannel();
  events = [];
});

function createDeployer(
  changes: { build?: InGameBuild; token?: string; onListenerError?: (error: unknown) => void } = {},
): Deployer {
  const deployer = new Deployer({
    build: changes.build ?? BUILD,
    controlPort: CONTROL_PORT,
    token: changes.token ?? TOKEN,
    pinnedDefinitions: PINNED_DEFINITIONS,
    channel,
    clock,
    ...(changes.onListenerError ? { onListenerError: changes.onListenerError } : {}),
  });
  deployer.subscribe((event) => events.push(event));
  return deployer;
}

function newGame(): FakeRfaGame {
  const game = new FakeRfaGame();
  game.definitionFile = PINNED_DEFINITIONS;
  return game;
}

const idOf = (changes: { build?: InGameBuild; token?: string } = {}) =>
  deploymentIdOf(changes.build ?? BUILD, { controlPort: CONTROL_PORT, token: changes.token ?? TOKEN });

describe("the deployment id", () => {
  test("is a folder name, the same for the same build and configuration", () => {
    expect(isValidDeploymentId(idOf())).toBe(true);
    expect(idOf()).toBe(idOf());
    expect(idOf()).toMatch(/^[0-9a-f]{12}$/);
  });

  test("changes with any script, the token or the control port", () => {
    const changedScript = { ...BUILD, scripts: { ...BUILD.scripts, "agent.js": "// agent 2" } };
    expect(idOf({ build: changedScript })).not.toBe(idOf());
    expect(idOf({ token: "b".repeat(64) })).not.toBe(idOf());
    expect(deploymentIdOf(BUILD, { controlPort: 1, token: TOKEN })).not.toBe(idOf());
  });
});

describe("a deploy", () => {
  test("pushes the deployment, checks every script's RAM, then switches boot.js and current.txt, last", async () => {
    const game = newGame();
    const id = idOf();
    await createDeployer().accept(game);
    const folder = (name: string) => deployedFilePath(id, name);
    expect(game.requests).toEqual([
      "getDefinitionFile",
      `getFile ${CURRENT_DEPLOYMENT_FILE}`,
      `pushFile ${folder("agent.js")}`,
      `pushFile ${folder("boot.js")}`,
      `pushFile ${folder("snapshot-fast.js")}`,
      `pushFile ${folder("config.json")}`,
      `pushFile ${folder("token.txt")}`,
      `calculateRam ${folder("agent.js")}`,
      `calculateRam ${folder("boot.js")}`,
      `calculateRam ${folder("snapshot-fast.js")}`,
      `getFile ${BOOT_SCRIPT}`,
      `pushFile ${BOOT_SCRIPT}`,
      `pushFile ${CURRENT_DEPLOYMENT_FILE}`,
      "getFileNames",
    ]);
    expect(JSON.parse(game.files.get(folder("config.json")) as string)).toEqual({
      deploymentId: id,
      controlPort: CONTROL_PORT,
    });
    expect(game.files.get(folder("token.txt"))).toBe(TOKEN);
    expect(game.files.get(BOOT_SCRIPT)).toBe("// boot");
    expect(game.files.get(CURRENT_DEPLOYMENT_FILE)).toBe(id);
    expect(channel.states).toEqual([
      { deployedId: null, hold: false, deployFailed: false },
      { deployedId: id, hold: false, deployFailed: false },
    ]);
    expect(events).toEqual([{ type: "deployed", atMs: clock.now(), deploymentId: id, replacedDeploymentId: null }]);
  });

  test("nothing to do when current.txt already names it: the channel is told, nothing is pushed, and it's recorded", async () => {
    const game = newGame();
    game.files.set(CURRENT_DEPLOYMENT_FILE, `${idOf()}\n`);
    await createDeployer().accept(game);
    expect(game.requests).toEqual(["getDefinitionFile", `getFile ${CURRENT_DEPLOYMENT_FILE}`]);
    expect(channel.states).toEqual([{ deployedId: idOf(), hold: false, deployFailed: false }]);
    // So a deploy that failed earlier (say, the reply to its last push lost) shows as resolved.
    expect(events).toEqual([{ type: "deploymentCurrent", atMs: clock.now(), deploymentId: idOf() }]);
  });

  test("boot.js isn't pushed when it's already the same", async () => {
    const game = newGame();
    game.files.set(BOOT_SCRIPT, "// boot");
    await createDeployer().accept(game);
    expect(game.requests.filter((request) => request === `pushFile ${BOOT_SCRIPT}`)).toEqual([]);
    expect(game.files.get(CURRENT_DEPLOYMENT_FILE)).toBe(idOf());
  });

  test("a new token is a new deployment, which replaces the one current.txt named", async () => {
    const game = newGame();
    await createDeployer().accept(game);
    events.length = 0;
    await createDeployer({ token: "b".repeat(64) }).accept(game);
    const newId = idOf({ token: "b".repeat(64) });
    expect(game.files.get(CURRENT_DEPLOYMENT_FILE)).toBe(newId);
    expect(game.files.get(deployedFilePath(newId, "token.txt"))).toBe("b".repeat(64));
    expect(events).toEqual([expect.objectContaining({ type: "deployed", replacedDeploymentId: idOf() })]);
  });
});

describe("over a RAM budget", () => {
  test("the deploy stops before boot.js and current.txt: it fails, and no Agent is restarted", async () => {
    const game = newGame();
    game.files.set(BOOT_SCRIPT, "// old boot");
    game.files.set(CURRENT_DEPLOYMENT_FILE, "old-deployment");
    game.ramOf = (filename) => (filename.endsWith("/agent.js") ? 3.05 : 1.6);
    await createDeployer().accept(game);
    expect(game.files.get(CURRENT_DEPLOYMENT_FILE)).toBe("old-deployment");
    expect(game.files.get(BOOT_SCRIPT)).toBe("// old boot");
    expect(game.requests.at(-1)).toBe(`calculateRam ${deployedFilePath(idOf(), "agent.js")}`);
    expect(events).toEqual([
      {
        type: "deployFailed",
        atMs: clock.now(),
        deploymentId: idOf(),
        reason: "agent.js needs 3.05 GB, over its budget of 3 GB",
      },
    ]);
    expect(channel.states.at(-1)).toEqual({ deployedId: "old-deployment", hold: false, deployFailed: true });
  });
});

describe("the version check", () => {
  test("definitions that differ only in line endings pass", async () => {
    const game = newGame();
    game.definitionFile = PINNED_DEFINITIONS.replaceAll("\n", "\r\n");
    await createDeployer().accept(game);
    expect(game.files.get(CURRENT_DEPLOYMENT_FILE)).toBe(idOf());
  });

  test("a changed line puts the brain on hold for good: nothing is deployed, and the channel never restarts", async () => {
    const deployer = createDeployer();
    const game = newGame();
    game.definitionFile = "interface NS {\n  run(): void;\n}\n";
    await deployer.accept(game);
    expect(game.requests).toEqual(["getDefinitionFile"]);
    expect(events).toEqual([
      {
        type: "versionDrift",
        atMs: clock.now(),
        detail: "the game's NetscriptDefinitions.d.ts differs from the pinned one, from line 2",
      },
    ]);
    expect(channel.states).toEqual([{ deployedId: null, hold: true, deployFailed: false }]);
    // The next connection, even from a game with the pinned definitions, deploys nothing.
    const next = newGame();
    await deployer.accept(next);
    expect(next.requests).toEqual([]);
  });

  test("an Agent on another game version (the channel's versionDrift) puts the deployer on hold too", async () => {
    const deployer = createDeployer();
    channel.emit({ type: "versionDrift", atMs: clock.now(), detail: "the Agent's game: versionNumber 52, pinned 51" });
    const game = newGame();
    await deployer.accept(game);
    expect(game.requests).toEqual([]);
  });

  test("a drift reported mid-deploy stops it before anything shared changes", async () => {
    const deployer = createDeployer();
    const game = newGame();
    game.files.set(CURRENT_DEPLOYMENT_FILE, "aaaaaaaaaaaa");
    // The Agent's hello arrives while the deployer measures the scripts.
    game.ramOf = () => {
      channel.emit({
        type: "versionDrift",
        atMs: clock.now(),
        detail: "the Agent's game: versionNumber 52, pinned 51",
      });
      return 2.6;
    };
    await deployer.accept(game);
    expect(game.files.get(CURRENT_DEPLOYMENT_FILE)).toBe("aaaaaaaaaaaa");
    expect(game.files.has(BOOT_SCRIPT)).toBe(false);
    expect(events).toEqual([]);
  });
});

describe("cleaning up", () => {
  const PREVIOUS = "aaaaaaaaaaaa";
  const OLDER = "bbbbbbbbbbbb";
  const RUNNING_ELSEWHERE = "cccccccccccc";
  const CONNECTED = "dddddddddddd";
  const deploymentFiles = (id: string) =>
    ["agent.js", "config.json", "token.txt"].map((name) => deployedFilePath(id, name));

  test("deletes the deployer's other folders, keeping the replaced one, the connected Agent's, and a player's", async () => {
    const game = newGame();
    game.files.set(CURRENT_DEPLOYMENT_FILE, PREVIOUS);
    for (const id of [PREVIOUS, OLDER, RUNNING_ELSEWHERE, CONNECTED]) {
      for (const file of deploymentFiles(id)) game.files.set(file, "// old");
    }
    game.files.set("agent/utils/helper.js", "// the player's own, in a folder that isn't a deployment");
    game.runningScripts.add(deployedFilePath(RUNNING_ELSEWHERE, "agent.js"));
    channel.connected = { agentSessionId: "s", deploymentId: CONNECTED, game: PINNED_GAME_INFO };
    await createDeployer().accept(game);
    const remaining = [...game.files.keys()].filter((name) => name.startsWith("agent/"));
    expect(remaining.sort()).toEqual(
      [
        BOOT_SCRIPT,
        CURRENT_DEPLOYMENT_FILE,
        "agent/utils/helper.js",
        ...deploymentFiles(PREVIOUS),
        ...deploymentFiles(CONNECTED),
        // A running script's folder keeps its config and token, which that Agent reads.
        ...deploymentFiles(RUNNING_ELSEWHERE),
        ...["agent.js", "boot.js", "config.json", "snapshot-fast.js", "token.txt"].map((name) =>
          deployedFilePath(idOf(), name),
        ),
      ].sort(),
    );
    expect(game.files.has(deployedFilePath(OLDER, "agent.js"))).toBe(false);
  });

  test("a connection that drops while tidying up doesn't make the deploy a failure", async () => {
    const game = newGame();
    // Request 14 is getFileNames, after current.txt (request 13).
    game.dropAtRequest = 14;
    await createDeployer().accept(game);
    expect(game.requests.at(-1)).toBe("getFileNames");
    expect(events.map((event) => event.type)).toEqual(["deployed"]);
    expect(channel.states.at(-1)).toEqual({ deployedId: idOf(), hold: false, deployFailed: false });
  });
});

describe("connections", () => {
  test("one that drops mid-deploy leaves current.txt as it was, and the deploy failed", async () => {
    const game = newGame();
    game.dropAtRequest = 5;
    await createDeployer().accept(game);
    expect(game.files.has(CURRENT_DEPLOYMENT_FILE)).toBe(false);
    expect(events).toEqual([
      expect.objectContaining({ type: "deployFailed", reason: expect.stringMatching(/closed/) }),
    ]);
  });

  test("a newer one replaces the older, which is closed, and nothing the older learns afterwards counts", async () => {
    const deployer = createDeployer();
    const first = newGame();
    // As ws reports it: after the closing handshake, so the older deploy fails late.
    first.closeReportedLate = true;
    const second = newGame();
    const firstDeploy = deployer.accept(first);
    await deployer.accept(second);
    await firstDeploy;
    expect(first.closedWith).toEqual({ code: 1000, reason: "replaced by a newer connection" });
    expect(second.files.get(CURRENT_DEPLOYMENT_FILE)).toBe(idOf());
    expect(events.map((event) => event.type)).toEqual(["deployed"]);
    expect(channel.states.at(-1)).toEqual({ deployedId: idOf(), hold: false, deployFailed: false });
  });

  test("a request the game never answers fails the deploy after 30 s, and the connection is closed to retry", async () => {
    const game = newGame();
    game.silentAtRequest = 2;
    const deploy = createDeployer().accept(game);
    await new Promise((resolve) => setTimeout(resolve, 0));
    clock.advance(30_000);
    await deploy;
    expect(events).toEqual([
      expect.objectContaining({
        type: "deployFailed",
        reason: `getFile ${CURRENT_DEPLOYMENT_FILE}: no reply within 30 s`,
      }),
    ]);
    expect(game.closedWith).toEqual({ code: 1000, reason: "no reply in time" });
  });

  test("an over-budget deploy leaves the connection open: retrying the same build would fail the same way", async () => {
    const game = newGame();
    game.ramOf = () => 9;
    await createDeployer().accept(game);
    expect(events.map((event) => event.type)).toEqual(["deployFailed"]);
    expect(game.closedWith).toBeNull();
  });
});

test("a listener that throws can't stop the others, or the deploy's tidying up", async () => {
  const errors: unknown[] = [];
  const deployer = createDeployer({ onListenerError: (error) => errors.push(error) });
  deployer.subscribe(() => {
    throw new Error("the store is full");
  });
  const after: string[] = [];
  deployer.subscribe((event) => after.push(event.type));
  const game = newGame();
  game.files.set(deployedFilePath("bbbbbbbbbbbb", "agent.js"), "// old");
  await deployer.accept(game);
  expect(errors).toEqual([new Error("the store is full")]);
  expect(after).toEqual(["deployed"]);
  expect(game.files.has(deployedFilePath("bbbbbbbbbbbb", "agent.js"))).toBe(false);
});

test("a build without boot.js or agent.js, or a script without a budget, is refused at once", () => {
  const { "boot.js": _boot, ...withoutBoot } = BUILD.scripts;
  expect(() => createDeployer({ build: { ...BUILD, scripts: withoutBoot } })).toThrow("the build has no boot.js");
  const unbudgeted = { ...BUILD, scripts: { ...BUILD.scripts, "extra.js": "// extra" } };
  expect(() => createDeployer({ build: unbudgeted })).toThrow("extra.js has no RAM budget");
});
