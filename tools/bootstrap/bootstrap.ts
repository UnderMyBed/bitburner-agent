// npm run bootstrap: takes a clone of this repository to where the brain, the tests and the simulator run, in the repo
// only (owner decision 30, #122). Plain Node with no dependencies, since it runs before `npm ci`.
import { spawnSync } from "node:child_process";

export interface BootstrapStep {
  /** What it does, as printed. */
  description: string;
  command: string;
  args: string[];
}

export const BOOTSTRAP_STEPS: readonly BootstrapStep[] = [
  {
    description: "the game's source: the vendor/bitburner-src submodule, at the pinned commit",
    command: "git",
    args: ["submodule", "update", "--init"],
  },
  { description: "this repository's packages, from its lockfile", command: "npm", args: ["ci"] },
  {
    description: "the game's own dependencies, from its lockfile (the simulator and the brain's checks need them)",
    command: "npm",
    args: ["run", "setup:engine"],
  },
];

/** Runs a command in the repository, its output shown; returns its exit code. */
export type RunCommand = (command: string, args: string[]) => number;

/**
 * Runs commands in `directory`. On Windows through a shell, since npm is a .cmd script only a shell runs, given as one
 * line (the steps' fixed arguments, never user input); elsewhere directly. A command that can't start (git missing,
 * say) has no exit code: it says why and counts as 1.
 */
export function runCommandIn(directory: string): RunCommand {
  return (command, args) => {
    const result =
      process.platform === "win32"
        ? spawnSync([command, ...args].join(" "), { cwd: directory, stdio: "inherit", shell: true })
        : spawnSync(command, args, { cwd: directory, stdio: "inherit" });
    if (result.error) console.error(`${command}: ${result.error.message}`);
    return result.status ?? 1;
  };
}

/** Runs `steps` in order, saying each, and stops at the first that fails. Returns the exit code: 0 if all ran. */
export function bootstrap(
  steps: readonly BootstrapStep[],
  runCommand: RunCommand,
  printLine: (line: string) => void,
): number {
  for (const [index, step] of steps.entries()) {
    printLine(`[${index + 1}/${steps.length}] ${step.description}: ${[step.command, ...step.args].join(" ")}`);
    const exitCode = runCommand(step.command, step.args);
    if (exitCode !== 0) {
      printLine(
        `Stopped: "${[step.command, ...step.args].join(" ")}" exited with ${exitCode}. Fix that, then run this again.`,
      );
      return exitCode;
    }
  }
  printLine(
    "Done. Check the repo with: npm run check. To run the agent against Steam, follow docs/setup.md (npm run brain).",
  );
  return 0;
}
