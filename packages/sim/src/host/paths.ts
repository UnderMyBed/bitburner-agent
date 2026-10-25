import path from "node:path";
import { pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The repository's root as a path (either separator) or a file URL (percent-encoded), followed by the end of a path
 * component, then the rest of the path. Windows paths compare case-insensitively (`C:` and `c:`).
 */
const REPO_PATH = new RegExp(
  `(?:${[pathToFileURL(REPO_ROOT).href, REPO_ROOT, REPO_ROOT.replaceAll("\\", "/")].map(escapeRegExp).join("|")})` +
    `(?=[\\\\/\\s:()"']|$)([\\\\/][^\\s:()"']*)?`,
  process.platform === "win32" ? "gi" : "g",
);

/**
 * Stack traces and messages name files on this machine; this makes them read the same everywhere:
 * `<repo>/path/to/file`, with forward slashes, whatever the machine's root and separator.
 */
export function withoutMachinePaths(message: string): string {
  return message.replace(
    REPO_PATH,
    (_match, rest: string | undefined) => `<repo>${(rest ?? "").replaceAll("\\", "/")}`,
  );
}
