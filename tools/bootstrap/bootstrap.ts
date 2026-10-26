// npm run bootstrap: takes a clone of this repository to where the brain, the tests and the simulator run, in the repo
// only (owner decision 30, #122). Plain Node with no dependencies, since it runs before `npm ci`.

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

/** Runs a command in the repository, its output shown; resolves with its exit code. */
export type RunCommand = (command: string, args: string[]) => number;

/** Runs `steps` in order, saying each, and stops at the first that fails. Returns the exit code: 0 if all ran. */
export function bootstrap(steps: readonly BootstrapStep[], run: RunCommand, say: (line: string) => void): number {
  for (const [index, step] of steps.entries()) {
    say(`[${index + 1}/${steps.length}] ${step.description}: ${[step.command, ...step.args].join(" ")}`);
    const exitCode = run(step.command, step.args);
    if (exitCode !== 0) {
      say(
        `Stopped: "${[step.command, ...step.args].join(" ")}" exited with ${exitCode}. Fix that, then run this again.`,
      );
      return exitCode;
    }
  }
  say("Done. Run the brain with: npm run brain (docs/setup.md)");
  return 0;
}
