import { execFileSync } from "node:child_process";
import path from "node:path";

/**
 * The brain's own release: `git describe` of the checkout it runs from (a tag on a release, e.g. "v0.2.0"; a commit and
 * "-dirty" otherwise), or "unknown" without git.
 */
export function brainRelease(): string {
  try {
    return execFileSync("git", ["describe", "--tags", "--always", "--dirty"], {
      cwd: path.resolve(import.meta.dirname, "../../.."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}
