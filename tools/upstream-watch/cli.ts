// The upstream watchers' command line (tools/upstream-watch/README.md).
//
//   node tools/upstream-watch/cli.ts report --game <clone> --ref <ref> [--pinned <sha>] [--out report.json]
//     Compares the pinned game with <ref> in a clone of the game's repository and prints the report as Markdown.
//     --out also writes { changes, markdown } for `publish`.
//
//   node tools/upstream-watch/cli.ts publish --report report.json --title <title> [--prefix <prefix>]
//       [--when-empty close|leave] [--repo owner/name] [--dry-run]
//     Updates the watcher's one tracking issue (found by title prefix, default the title) through the gh CLI:
//     creates, updates or reopens it when there are changes; closes it, or leaves it, when there are none.
//     --dry-run prints what it would do and the body, and touches nothing.
//
// Exits 0 on success and 2 on bad usage or failure.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { buildReport, pinnedCommit, readWatchlist } from "./src/git.ts";
import { type ExistingIssue, planIssue } from "./src/issue.ts";
import { changeCount, renderReport } from "./src/report.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const WATCHLIST = path.join(import.meta.dirname, "watchlist.txt");
const LABEL = "upstream-watch";

interface ReportFile {
  changes: number;
  markdown: string;
}

function report(values: Record<string, string | boolean | undefined>): void {
  if (typeof values.game !== "string" || typeof values.ref !== "string")
    throw new RangeError("report needs --game and --ref");
  const pinned = typeof values.pinned === "string" ? values.pinned : pinnedCommit(REPO_ROOT);
  const result = buildReport(values.game, pinned, values.ref, readWatchlist(WATCHLIST));
  const file: ReportFile = { changes: changeCount(result), markdown: renderReport(result) };
  console.log(file.markdown);
  if (typeof values.out === "string") writeFileSync(values.out, `${JSON.stringify(file, null, 2)}\n`);
}

function publish(values: Record<string, string | boolean | undefined>): void {
  if (typeof values.report !== "string" || typeof values.title !== "string") {
    throw new RangeError("publish needs --report and --title");
  }
  const whenEmpty = values["when-empty"] ?? "close";
  if (whenEmpty !== "close" && whenEmpty !== "leave") throw new RangeError("--when-empty: close or leave");
  const repo =
    typeof values.repo === "string" ? values.repo : (process.env.GITHUB_REPOSITORY ?? "UnderMyBed/bitburner-agent");
  const { changes, markdown } = JSON.parse(readFileSync(values.report, "utf8")) as ReportFile;
  const gh = (...args: string[]) => execFileSync("gh", [...args, "--repo", repo], { encoding: "utf8" });
  const issues = JSON.parse(
    gh("issue", "list", "--label", LABEL, "--state", "all", "--limit", "200", "--json", "number,state,title"),
  ) as ExistingIssue[];
  const prefix = typeof values.prefix === "string" ? values.prefix : values.title;
  const action = planIssue(issues, prefix, { changes: changes > 0, whenEmpty });
  console.log(`${changes} change(s): ${action.kind}${"number" in action ? ` #${action.number}` : ""}`);
  if (values["dry-run"]) {
    console.log(`\n--- title: ${values.title}\n${markdown}`);
    return;
  }
  const bodyFile = path.join(path.dirname(path.resolve(values.report)), "issue-body.md");
  writeFileSync(bodyFile, markdown);
  switch (action.kind) {
    case "create":
      gh("issue", "create", "--title", values.title, "--label", LABEL, "--body-file", bodyFile);
      break;
    case "reopen":
      gh("issue", "reopen", String(action.number));
      gh("issue", "edit", String(action.number), "--title", values.title, "--body-file", bodyFile);
      break;
    case "update":
      gh("issue", "edit", String(action.number), "--title", values.title, "--body-file", bodyFile);
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
      "when-empty": { type: "string" },
      repo: { type: "string" },
      "dry-run": { type: "boolean" },
    },
  });
  const [command] = positionals;
  if (positionals.length !== 1 || (command !== "report" && command !== "publish")) {
    throw new RangeError("usage: cli.ts report … | cli.ts publish … (see the comment at the top of cli.ts)");
  }
  if (command === "report") report(values);
  else publish(values);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
