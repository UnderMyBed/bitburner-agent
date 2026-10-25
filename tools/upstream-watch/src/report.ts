// The forward-check report: what changed between the pinned game and an upstream ref, as Markdown for an issue body.
import type { DeclarationDiff } from "./declarations.ts";
import type { RamCostChange } from "./ram-costs.ts";

/** The game files the report compares, relative to the game repository. */
export const DEFINITIONS = "src/ScriptEditor/NetscriptDefinitions.d.ts";
export const RAM_COSTS = "src/Netscript/RamCostGenerator.ts";

export interface ForwardReport {
  pinned: { sha: string; version: string };
  upstream: { ref: string; sha: string; version: string; date: string };
  api: DeclarationDiff;
  /** The definitions file's unified diff. */
  rawApiDiff: string;
  ram: RamCostChange[];
  /** Commits touching the watchlist, newest first. */
  commits: { sha: string; title: string }[];
}

/** GitHub refuses issue bodies over 65,536 characters; this leaves room. */
export const BODY_LIMIT = 60_000;
/** Longer lists are cut, saying how many more there are: the issue is a pointer, the tool has the rest. */
const LIST_LIMIT = 150;
// Links into this repository: the report is about this project, whichever repository its issue is published to.
const ADR = "https://github.com/UnderMyBed/bitburner-agent/blob/main/docs/decisions/0005-forward-compat-dev-branch.md";
const WATCHLIST = "https://github.com/UnderMyBed/bitburner-agent/blob/main/tools/upstream-watch/watchlist.txt";
const CUT = "\n\nCut short to fit in an issue. Run the tool locally for the whole report.";

export function changeCount(report: ForwardReport): number {
  const { added, removed, changed } = report.api;
  return added.length + removed.length + changed.length + report.ram.length + report.commits.length;
}

/**
 * `text` as a code span, fenced with more backticks than any run inside it. Upstream text (commit titles, names) goes
 * in one, so its `#123` references, `@mentions`, links and HTML render as plain text in our issue.
 */
export function codeSpan(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map(([run]) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

const short = (sha: string) => sha.slice(0, 10);
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const code = (names: string[]) => names.map(codeSpan).join(", ");
const cell = (text: string | null) => (text === null ? "–" : codeSpan(text).replaceAll("|", "\\|"));

/** The first LIST_LIMIT items rendered, and a line saying how many more there are. */
function capped<T>(items: T[], render: (item: T) => string, noun: string): string[] {
  const lines = items.slice(0, LIST_LIMIT).map(render);
  const more = items.length - LIST_LIMIT;
  return more > 0 ? [...lines, "", `…and ${count(more, `more ${noun}`)}.`] : lines;
}

function apiSection(report: ForwardReport): string[] {
  const { added, removed, changed } = report.api;
  if (added.length + removed.length + changed.length === 0) return ["No changes."];
  const lines: string[] = [];
  const list = (names: string[]) =>
    code(names.slice(0, LIST_LIMIT)) + (names.length > LIST_LIMIT ? `, …and ${names.length - LIST_LIMIT} more` : "");
  if (added.length > 0) lines.push(`- **Added:** ${list(added)}`);
  if (removed.length > 0) lines.push(`- **Removed:** ${list(removed)}`);
  if (changed.length > 0) {
    lines.push("- **Changed:**");
    const describe = (c: DeclarationDiff["changed"][number]) => {
      const parts = [
        c.added.length > 0 ? `added ${code(c.added)}` : "",
        c.removed.length > 0 ? `removed ${code(c.removed)}` : "",
        c.changed.length > 0 ? `changed ${code(c.changed)}` : "",
      ].filter((part) => part !== "");
      return `  - ${codeSpan(c.key)}${parts.length > 0 ? `: ${parts.join("; ")}` : ""}`;
    };
    lines.push(...capped(changed, describe, "changed declaration"));
  }
  return lines;
}

function ramSection(report: ForwardReport): string[] {
  if (report.ram.length === 0) return ["No changes."];
  return [
    `| Function | Pinned | ${codeSpan(report.upstream.ref)} |`,
    "|---|---|---|",
    ...capped(report.ram, (c) => `| ${cell(c.path)} | ${cell(c.before)} | ${cell(c.after)} |`, "RAM cost"),
    "",
    "GB. (SF4) marks a Singularity cost, which is ×16 without Source-File 4 or at SF4.1, ×4 at SF4.2, and as shown at SF4.3 or in BitNode 4.",
  ];
}

/** The rawest part, the diff, is cut first to keep the body under the limit. */
function rawDiff(diff: string, room: number): string[] {
  if (diff === "") return [];
  const note = "\n\nThe raw diff is cut short to fit in an issue. Run the tool locally for all of it.";
  const fence = (body: string) => [
    "<details><summary>Raw diff</summary>",
    "",
    "```diff",
    body,
    "```",
    "",
    "</details>",
  ];
  const whole = fence(diff.trimEnd());
  if (whole.join("\n").length <= room) return whole;
  const cut = diff.slice(0, Math.max(0, room - fence("").join("\n").length - note.length));
  return [...fence(cut.slice(0, cut.lastIndexOf("\n") + 1).trimEnd()), note.trim()];
}

export function renderReport(report: ForwardReport): string {
  const { pinned, upstream } = report;
  const total = changeCount(report);
  const declarations = report.api.added.length + report.api.removed.length + report.api.changed.length;
  const summary =
    total === 0
      ? "**No changes.**"
      : `**${count(total, "change")}:** ${count(declarations, "API declaration")}, ${count(report.ram.length, "RAM cost")}, ${count(report.commits.length, "watched-source commit")}.`;
  const head = [
    `Compared the pinned game, v${pinned.version} (\`${short(pinned.sha)}\`), with upstream ${codeSpan(upstream.ref)}, v${upstream.version} (\`${short(upstream.sha)}\`, committed ${upstream.date}). Generated by \`tools/upstream-watch\`; advisory only ([ADR 0005](${ADR})).`,
    "",
    summary,
    "",
    "## API surface",
    "",
    `\`${DEFINITIONS}\`, by declaration and member. Comments and formatting don't count.`,
    "",
    ...apiSection(report),
    "",
  ];
  const tail = [
    "",
    "## RAM costs",
    "",
    `\`${RAM_COSTS}\`, by function under \`ns\`.`,
    "",
    ...ramSection(report),
    "",
    "## Watched source",
    "",
    report.commits.length === 0
      ? `No commits touch the [watchlist](${WATCHLIST}).`
      : `${count(report.commits.length, "commit")} touching the [watchlist](${WATCHLIST}), newest first:`,
    "",
    ...capped(report.commits, (c) => `- \`${short(c.sha)}\` ${codeSpan(c.title)}`, "commit"),
    "",
    "## Contract typecheck",
    "",
    "Not applicable yet: there's no in-game package to typecheck against the upstream definitions (#42).",
    "",
  ];
  const fixed = head.join("\n").length + tail.join("\n").length + 2;
  const body = [...head, ...rawDiff(report.rawApiDiff, BODY_LIMIT - fixed), ...tail].join("\n");
  // Lists are capped by count, so a few very long entries could still overflow: then cut at the limit, on a line break.
  if (body.length <= BODY_LIMIT) return body;
  const cut = body.slice(0, BODY_LIMIT - CUT.length);
  return cut.slice(0, cut.lastIndexOf("\n")).trimEnd() + CUT;
}
