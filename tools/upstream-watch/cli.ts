// The upstream watchers' command line (tools/upstream-watch/README.md).
//
//   node tools/upstream-watch/cli.ts report --game <clone> --ref <ref> [--watcher dev|stable] [--pinned <sha>]
//       [--out report.json]
//     Compares the pinned game with <ref> in a clone of the game's repository and prints the report as Markdown, in
//     the dev forward check's form (the default) or the stable watcher's, which leads with the bump steps.
//     --out also writes it as JSON for `publish`: { changes, moved, pinned, upstream, markdown }.
//
//   node tools/upstream-watch/cli.ts publish --report report.json --title <title> [--prefix <prefix>]
//       [--on changes|moved] [--when-empty close|leave] [--repo owner/name] [--dry-run]
//     Updates the watcher's one tracking issue (found by title prefix, default the title) through the gh CLI:
//     creates, updates or reopens it when there's something to report; closes it, or leaves it, when there isn't.
//     Something to report is listed changes (`--on changes`, the default) or any move of the ref (`--on moved`).
//     The title may use {version} and {sha}, filled from the upstream commit.
//     --repo defaults to $GITHUB_REPOSITORY, then this repository. --dry-run prints the plan and the body only.
//
// Exits 0 on success and 2 on bad usage or failure.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { buildReport, pinnedCommit } from "./src/git.ts";
import { type ExistingIssue, fillTitle, hasNews, planIssue } from "./src/issue.ts";
import { type ReportFile, reportFile } from "./src/report.ts";
import { readWatchlist } from "./src/watchlist.ts";

const USAGE = `usage:
  node tools/upstream-watch/cli.ts report --game <clone> --ref <ref> [--watcher dev|stable] [--pinned <sha>]
      [--out report.json]
  node tools/upstream-watch/cli.ts publish --report report.json --title <title> [--prefix <prefix>]
      [--on changes|moved] [--when-empty close|leave] [--repo owner/name] [--dry-run]`;
const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const WATCHLIST = path.join(import.meta.dirname, "watchlist.txt");
const LABEL = "upstream-watch";

type Values = Record<string, string | boolean | undefined>;

/** A branch, tag or commit name, never something git could read as an option. */
const isRef = (ref: string) => /^[\w./^~-]+$/.test(ref) && !ref.startsWith("-");

function report(values: Values): void {
  if (typeof values.game !== "string" || typeof values.ref !== "string") {
    throw new RangeError("report needs --game and --ref");
  }
  if (!isRef(values.ref)) throw new RangeError(`--ref: a branch, tag or commit, got "${values.ref}"`);
  const watcher = values.watcher ?? "dev";
  if (watcher !== "dev" && watcher !== "stable") throw new RangeError("--watcher: dev or stable");
  const pinned = typeof values.pinned === "string" ? values.pinned : pinnedCommit(REPO_ROOT);
  const result = buildReport(values.game, pinned, values.ref, readWatchlist(WATCHLIST));
  const file = reportFile(result, watcher);
  console.log(file.markdown);
  if (typeof values.out === "string") writeFileSync(values.out, `${JSON.stringify(file, null, 2)}\n`);
}

function publish(values: Values): void {
  if (typeof values.report !== "string" || typeof values.title !== "string") {
    throw new RangeError("publish needs --report and --title");
  }
  const whenEmpty = values["when-empty"] ?? "close";
  if (whenEmpty !== "close" && whenEmpty !== "leave") throw new RangeError("--when-empty: close or leave");
  const on = values.on ?? "changes";
  if (on !== "changes" && on !== "moved") throw new RangeError("--on: changes or moved");
  const repo =
    typeof values.repo === "string" ? values.repo : (process.env.GITHUB_REPOSITORY ?? "UnderMyBed/bitburner-agent");
  const file = JSON.parse(readFileSync(values.report, "utf8")) as ReportFile;
  const { changes, moved, upstream, markdown } = file;
  if (/\{(version|sha)\}/.test(values.title) && typeof values.prefix !== "string") {
    throw new RangeError(
      "--prefix is needed when --title has {version} or {sha}: the filled title changes between runs",
    );
  }
  const title = fillTitle(values.title, upstream);
  const gh = (...args: string[]) => execFileSync("gh", [...args, "--repo", repo], { encoding: "utf8" });
  const issues = JSON.parse(
    gh("issue", "list", "--label", LABEL, "--state", "all", "--limit", "200", "--json", "number,state,title"),
  ) as ExistingIssue[];
  const prefix = typeof values.prefix === "string" ? values.prefix : title;
  const action = planIssue(issues, prefix, { news: hasNews(file, on), whenEmpty });
  console.log(`${changes} change(s), moved ${moved} → ${action.kind}${"number" in action ? ` #${action.number}` : ""}`);
  if (values["dry-run"]) {
    console.log(`\n--- title: ${title}\n${markdown}`);
    return;
  }
  const bodyFile = path.join(path.dirname(path.resolve(values.report)), "issue-body.md");
  writeFileSync(bodyFile, markdown);
  const edit = (number: number) => gh("issue", "edit", String(number), "--title", title, "--body-file", bodyFile);
  switch (action.kind) {
    case "create":
      gh("issue", "create", "--title", title, "--label", LABEL, "--body-file", bodyFile);
      break;
    case "reopen":
      // If the edit fails after the reopen, the issue is open with its old body until the next run updates it.
      gh("issue", "reopen", String(action.number));
      edit(action.number);
      break;
    case "update":
      edit(action.number);
      break;
    case "close":
      gh("issue", "edit", String(action.number), "--body-file", bodyFile);
      gh(
        "issue",
        "close",
        String(action.number),
        "--comment",
        "No changes any more. A later run reopens this if that changes.",
      );
      break;
    case "none":
      break;
  }
}

try {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      game: { type: "string" },
      ref: { type: "string" },
      pinned: { type: "string" },
      out: { type: "string" },
      report: { type: "string" },
      title: { type: "string" },
      prefix: { type: "string" },
      watcher: { type: "string" },
      on: { type: "string" },
      "when-empty": { type: "string" },
      repo: { type: "string" },
      "dry-run": { type: "boolean" },
    },
  });
  const [command] = positionals;
  if (positionals.length !== 1 || (command !== "report" && command !== "publish")) throw new RangeError(USAGE);
  if (command === "report") report(values);
  else publish(values);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
