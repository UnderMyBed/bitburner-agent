// The setup scripts (#95), on Windows only (they're Windows scripts; CI runs Linux, so it skips them). Nothing here
// changes the machine: the installer runs only with -WhatIf, and the restart loop runs a stand-in command, never the
// brain.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";

const SETUP_DIRECTORY = path.resolve(import.meta.dirname, "..");
const INSTALL_SCRIPT = path.join(SETUP_DIRECTORY, "install-brain-task.ps1");
const RUN_BRAIN_SCRIPT = path.join(SETUP_DIRECTORY, "run-brain.ps1");
const TASK_NAME = "bitburner-agent brain";
const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "setup-"));
afterAll(() => rmSync(temporaryDirectory, { recursive: true, force: true }));

function pwsh(script: string, args: string[]): { exitCode: number; output: string } {
  const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", script, ...args], {
    encoding: "utf8",
    timeout: 60_000,
  });
  return { exitCode: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
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

describe.runIf(process.platform === "win32")("install-brain-task.ps1", () => {
  test("-WhatIf prints the task it would register (at logon, run-brain.ps1 with the data directory) and changes nothing", () => {
    const before = taskExists();
    const { exitCode, output } = pwsh(INSTALL_SCRIPT, ["-DataDir", "D:\\bitburner-agent", "-WhatIf"]);
    expect(exitCode).toBe(0);
    expect(output).toContain(`Task: ${TASK_NAME}`);
    expect(output).toMatch(/Trigger: at logon of \S+/);
    expect(output).toContain(`-File "${RUN_BRAIN_SCRIPT}" -DataDir "D:\\bitburner-agent"`);
    expect(output).toContain("Settings: no time limit; runs on battery; one instance at a time");
    expect(output).toContain(
      `What if: Performing the operation "Register the scheduled task" on target "${TASK_NAME}"`,
    );
    expect(taskExists()).toBe(before);
  });

  test("a relative data directory is made absolute: the task runs from elsewhere", () => {
    const { output } = pwsh(INSTALL_SCRIPT, ["-DataDir", "brain-data", "-WhatIf"]);
    expect(output).toContain(`-DataDir "${path.resolve("brain-data")}"`);
  });

  test("-Uninstall -WhatIf says it would remove the task, and changes nothing", () => {
    const before = taskExists();
    const { exitCode, output } = pwsh(INSTALL_SCRIPT, ["-Uninstall", "-WhatIf"]);
    expect(exitCode).toBe(0);
    expect(output).toContain(`What if: Performing the operation "Remove the scheduled task" on target "${TASK_NAME}"`);
    expect(taskExists()).toBe(before);
  });

  test("without a data directory it refuses, saying what's needed", () => {
    const { exitCode, output } = pwsh(INSTALL_SCRIPT, ["-WhatIf"]);
    expect(exitCode).not.toBe(0);
    expect(output).toContain("-DataDir <dir> is required");
  });
});

describe.runIf(process.platform === "win32")("run-brain.ps1", () => {
  test("whatever the brain does, it's restarted after it exits, each restart logged", () => {
    const dataDirectory = path.join(temporaryDirectory, "data");
    // A stand-in for the brain: prints its arguments and exits with code 3 at once. Run three times.
    const standIn = path.join(temporaryDirectory, "stand-in-brain.mjs");
    writeFileSync(standIn, "console.log('stand-in brain', process.argv.slice(2).join(' ')); process.exit(3);\n");
    const { exitCode } = pwsh(RUN_BRAIN_SCRIPT, [
      "-DataDir",
      dataDirectory,
      "-RestartDelaySeconds",
      "0",
      "-MaxRuns",
      "3",
      "-BrainScript",
      standIn,
    ]);
    expect(exitCode).toBe(0);
    const log = readFileSync(path.join(dataDirectory, "brain.log"), "utf8");
    // The brain is given the data directory.
    expect(
      log.match(new RegExp(`stand-in brain --data-dir ${dataDirectory.replaceAll("\\", "\\\\")}`, "g")),
    ).toHaveLength(3);
    expect(log.match(/run-brain: the brain exited with code 3; restarting in 0 s/g)).toHaveLength(3);
  });
});
