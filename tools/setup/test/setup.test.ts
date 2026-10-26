// The setup scripts (#95), on Windows only (they're Windows scripts; CI runs Linux, so it skips them). Nothing here
// changes the machine: the installer runs only with -WhatIf (and a made-up data directory), and the restart loop runs
// a stand-in script, never the brain.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";

const SETUP_DIRECTORY = path.resolve(import.meta.dirname, "..");
const INSTALL_SCRIPT = path.join(SETUP_DIRECTORY, "install-brain-task.ps1");
const RUN_BRAIN_SCRIPT = path.join(SETUP_DIRECTORY, "run-brain.ps1");
const TASK_NAME = "bitburner-agent brain";
// Not the docs' D:\bitburner-agent: if a guard ever failed, a task registered here would point nowhere real.
const MADE_UP_DATA_DIRECTORY = "X:\\setup-test-data";
const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "setup-"));
afterAll(() => rmSync(temporaryDirectory, { recursive: true, force: true }));

function pwsh(
  script: string,
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
): { exitCode: number; stdout: string; stderr: string; output: string } {
  const result = spawnSync(powerShellPath(), ["-NoProfile", "-NonInteractive", "-File", script, ...args], {
    encoding: "utf8",
    env: environment,
    timeout: 60_000,
  });
  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
    output: `${result.stdout}${result.stderr}`,
  };
}

let cachedPowerShellPath: string | undefined;
/** The absolute path of pwsh, so a test can run it with a PATH that lacks node. */
function powerShellPath(): string {
  cachedPowerShellPath ??= execFileSync(
    "pwsh",
    ["-NoProfile", "-NonInteractive", "-Command", "(Get-Process -Id $PID).Path"],
    {
      encoding: "utf8",
    },
  ).trim();
  return cachedPowerShellPath;
}

/** Whether the task exists, read-only: so a test can show -WhatIf changed nothing. */
function taskExists(): boolean {
  const output = execFileSync(
    "pwsh",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `[bool](Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue)`,
    ],
    { encoding: "utf8" },
  );
  return output.trim() === "True";
}

function countOccurrences(text: string, literal: string): number {
  return text.split(literal).length - 1;
}

/** The value of a "Name: value" line in the installer's output. */
function outputLine(output: string, name: string): string {
  const line = output.split(/\r?\n/).find((candidate) => candidate.startsWith(`${name}: `));
  expect(line, `the installer prints "${name}:"`).toBeDefined();
  return (line as string).slice(name.length + 2);
}

describe.runIf(process.platform === "win32")("install-brain-task.ps1", () => {
  test("-WhatIf prints the task it would register, read back from the task, and changes nothing", () => {
    const before = taskExists();
    const { exitCode, output } = pwsh(INSTALL_SCRIPT, ["-DataDir", MADE_UP_DATA_DIRECTORY, "-WhatIf"]);
    expect(exitCode).toBe(0);
    expect(output).toContain(`Task: ${TASK_NAME}`);
    const taskUser = outputLine(output, "Trigger").replace("at logon of ", "");
    expect(taskUser).toMatch(/^\S+\\\S+$/);
    expect(outputLine(output, "Principal")).toBe(`${taskUser}, logon type Interactive, run level Limited`);
    expect(outputLine(output, "Action")).toBe(
      `${powerShellPath()} -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass ` +
        `-File "${RUN_BRAIN_SCRIPT}" -DataDir "${MADE_UP_DATA_DIRECTORY}"`,
    );
    expect(outputLine(output, "Working directory")).toBe(path.resolve(SETUP_DIRECTORY, "..", ".."));
    expect(outputLine(output, "Settings")).toBe(
      "time limit PT0S; priority 4; disallow start on battery False; stop on battery False; multiple instances IgnoreNew",
    );
    expect(output).toContain(
      `What if: Performing the operation "Register the scheduled task" on target "${TASK_NAME}"`,
    );
    expect(output).not.toContain("Registered.");
    expect(taskExists()).toBe(before);
  });

  test.each([
    ["X:\\setup-test-data\\", "X:\\setup-test-data\\"],
    ["X:\\", "X:\\"],
  ])("a data directory ending in a backslash (%s) reaches run-brain.ps1 intact", (dataDirectory, expected) => {
    const { output } = pwsh(INSTALL_SCRIPT, ["-DataDir", dataDirectory, "-WhatIf"]);
    // Run the task's command line exactly as Task Scheduler would, but with a script that prints -DataDir in place of
    // run-brain.ps1, and without -WindowStyle Hidden (which would hide this console).
    const echoScript = path.join(temporaryDirectory, "echo-data-dir.ps1");
    writeFileSync(echoScript, 'param([string] $DataDir) Write-Output "DataDir=[$DataDir]"\n');
    const taskArguments = outputLine(output, "Action")
      .slice(powerShellPath().length + 1)
      .replace(RUN_BRAIN_SCRIPT, echoScript)
      .replace("-WindowStyle Hidden ", "");
    const result = spawnSync(powerShellPath(), [taskArguments], {
      encoding: "utf8",
      windowsVerbatimArguments: true,
      argv0: `"${powerShellPath()}"`,
      timeout: 60_000,
    });
    expect(result.stdout.trim()).toBe(`DataDir=[${expected}]`);
  });

  test("a relative data directory is refused: the task runs from elsewhere", () => {
    const { exitCode, output } = pwsh(INSTALL_SCRIPT, ["-DataDir", "brain-data", "-WhatIf"]);
    expect(exitCode).not.toBe(0);
    expect(output).toContain("-DataDir must be an absolute path");
  });

  test("-Uninstall -WhatIf says it would stop and remove the task, and changes nothing", () => {
    const before = taskExists();
    const { exitCode, output } = pwsh(INSTALL_SCRIPT, ["-Uninstall", "-WhatIf"]);
    expect(exitCode).toBe(0);
    expect(output).toContain(
      `What if: Performing the operation "Stop and remove the scheduled task" on target "${TASK_NAME}"`,
    );
    expect(taskExists()).toBe(before);
  });

  test("without a data directory it refuses, saying what's needed", () => {
    const { exitCode, output } = pwsh(INSTALL_SCRIPT, ["-WhatIf"]);
    expect(exitCode).not.toBe(0);
    expect(output).toContain("-DataDir <dir> is required");
  });
});

describe.runIf(process.platform === "win32")("run-brain.ps1", () => {
  function runBrain(dataDirectory: string, environment?: NodeJS.ProcessEnv) {
    // A stand-in for the brain: prints its arguments on stdout, non-ASCII text on stderr, and exits with code 3.
    const standIn = path.join(temporaryDirectory, "stand-in-brain.mjs");
    writeFileSync(
      standIn,
      "console.log('stand-in brain', process.argv.slice(2).join(' '));\n" +
        "console.error('stand-in brain stderr: café … ✓');\n" +
        "process.exit(3);\n",
    );
    return pwsh(
      RUN_BRAIN_SCRIPT,
      ["-DataDir", dataDirectory, "-RestartDelaySeconds", "0", "-MaxRuns", "3", "-BrainScript", standIn],
      environment,
    );
  }

  test("whatever the brain does, it's restarted after it exits, both its streams and each restart logged", () => {
    const dataDirectory = path.join(temporaryDirectory, "data");
    const { exitCode } = runBrain(dataDirectory);
    expect(exitCode).toBe(0);
    const log = readFileSync(path.join(dataDirectory, "brain.log"), "utf8");
    // The brain is given the data directory.
    expect(countOccurrences(log, `stand-in brain --data-dir ${dataDirectory}`)).toBe(3);
    expect(countOccurrences(log, "stand-in brain stderr: café … ✓")).toBe(3);
    expect(countOccurrences(log, "run-brain: starting the brain (run 3, node ")).toBe(1);
    expect(countOccurrences(log, "run-brain: the brain exited with code 3; restarting in 0 s")).toBe(3);
  });

  test("when node can't be found, it keeps trying rather than ending", () => {
    const dataDirectory = path.join(temporaryDirectory, "no-node");
    const environmentWithoutNode = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "PATH"),
    );
    environmentWithoutNode.Path = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32");
    const { exitCode } = runBrain(dataDirectory, environmentWithoutNode);
    expect(exitCode).toBe(0);
    const log = readFileSync(path.join(dataDirectory, "brain.log"), "utf8");
    expect(countOccurrences(log, "run-brain: couldn't run the brain: ")).toBe(3);
    expect(countOccurrences(log, "run-brain: the brain exited with code -1; restarting in 0 s")).toBe(3);
  });

  test("when the data directory can't be made or logged to, it keeps trying rather than ending", () => {
    // A file where the data directory should be: the directory can't be made, nor the log written.
    const notADirectory = path.join(temporaryDirectory, "a-file");
    writeFileSync(notADirectory, "");
    const { exitCode, stderr } = runBrain(notADirectory);
    expect(exitCode).toBe(0);
    expect(countOccurrences(stderr, "run-brain: couldn't run the brain: ")).toBe(3);
    expect(countOccurrences(stderr, "run-brain: the brain exited with code -1; restarting in 0 s")).toBe(3);
  });
});
