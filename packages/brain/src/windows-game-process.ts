// The game's process on Windows (#94): found with tasklist, started through Steam (as a player does), ended with
// taskkill. Process management only: nothing touches the game's code or its save (architecture §10.2).
import { execFile } from "node:child_process";
import type { GameProcess } from "./supervisor.ts";

/** A command can't hang the supervisor's checks. */
const COMMAND_TIMEOUT_MS = 30_000;

/** Runs a program with arguments (never through a shell's parsing), resolving with its output. */
export type RunCommand = (command: string, args: string[]) => Promise<string>;

export interface WindowsGameProcessOptions {
  /** Bitburner on Steam: 1812820 (verified on the reference rig, #94). */
  steamAppId: number;
  /** The game's executable name, as tasklist shows it: `bitburner.exe`. */
  gameExecutable: string;
  runCommand?: RunCommand;
}

const runWindowsCommand: RunCommand = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, timeout: COMMAND_TIMEOUT_MS }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${command} failed: ${stderr.trim() || error.message}`));
      else resolve(stdout);
    });
  });

export class WindowsGameProcess implements GameProcess {
  readonly #options: Required<WindowsGameProcessOptions>;

  constructor({ runCommand = runWindowsCommand, ...options }: WindowsGameProcessOptions) {
    this.#options = { ...options, runCommand };
  }

  async isRunning(): Promise<boolean> {
    const { gameExecutable, runCommand } = this.#options;
    const output = await runCommand("tasklist", ["/FI", `IMAGENAME eq ${gameExecutable}`, "/FO", "CSV", "/NH"]);
    return tasklistShowsImage(output, gameExecutable);
  }

  /** `start ""` (an empty window title) opens the `steam://` link with Steam, which starts the game. */
  async launch(): Promise<void> {
    await this.#options.runCommand("cmd", ["/c", "start", "", `steam://rungameid/${this.#options.steamAppId}`]);
  }

  /** The game and its child processes (Electron's renderers). */
  async kill(): Promise<void> {
    await this.#options.runCommand("taskkill", ["/IM", this.#options.gameExecutable, "/T", "/F"]);
  }
}

/**
 * Whether tasklist's CSV output (`/FO CSV /NH`) lists the image. Each process is a line whose first field is its image
 * name, in quotes. When nothing matches, tasklist prints an `INFO:` line instead, worded in the system's language, so
 * only the image name is trusted.
 */
export function tasklistShowsImage(output: string, imageName: string): boolean {
  const wanted = `"${imageName.toLowerCase()}"`;
  return output.split(/\r?\n/).some((line) => line.toLowerCase().startsWith(`${wanted},`));
}
