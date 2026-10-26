// The watchers' report: what changed between the pinned game and an upstream ref, as Markdown for an issue body.
import type { ContractTypecheckResult } from "./contract-typecheck.ts";
import type { DeclarationDiff } from "./declarations.ts";
import type { RamCostChange } from "./ram-costs.ts";

/** The game files the report compares, relative to the game repository. */
export const DEFINITIONS = "src/ScriptEditor/NetscriptDefinitions.d.ts";
export const RAM_COSTS = "src/Netscript/RamCostGenerator.ts";

export interface WatchReport {
  pinned: { sha: string; version: string };
  /** `ahead`: a later commit than the pinned one, with it in its history (not a rewind, a side branch or the same). */
  upstream: { ref: string; sha: string; version: string; date: string; ahead: boolean };
  api: DeclarationDiff;
  /** The definitions file's unified diff. */
  rawApiDiff: string;
  ram: RamCostChange[];
  /** Commits touching the watchlist, newest first. */
  commits: { sha: string; title: string }[];
  /** The in-game code typechecked against the ref's definitions (#42). */
  contractTypecheck: ContractTypecheckResult;
}

/**
 * Which watcher the report is for. "dev" is the forward check (ADR 0005): what's coming further ahead. "stable" is the
 * stable watcher (ADR 0003, 0010): a move there means a Steam update is coming, so its report leads with the bump steps.
 */
export type Watcher = "dev" | "stable";

/** GitHub refuses issue bodies over 65,536 characters; this leaves room. */
export const BODY_LIMIT = 60_000;
/** Longer lists are cut, saying how many more there are: the issue is a pointer, the tool has the rest. */
const LIST_LIMIT = 150;
// Links into this repository: the report is about this project, whichever repository its issue is published to.
const REPO = "https://github.com/UnderMyBed/bitburner-agent/blob/main";
const FORWARD_ADR = `${REPO}/docs/decisions/0005-forward-compat-dev-branch.md`;
const PINNING_ADR = `${REPO}/docs/decisions/0003-game-version-pinning.md`;
const STABLE_ADR = `${REPO}/docs/decisions/0010-stable-watcher-opens-an-issue.md`;
const WATCHLIST = `${REPO}/tools/upstream-watch/watchlist.txt`;
const CUT = "\n\nCut short to fit in an issue. Run the tool locally for the whole report.";

/** Whether the upstream ref is another commit than the pinned one. */
const moved = (report: WatchReport) => report.upstream.sha !== report.pinned.sha;

export function changeCount(report: WatchReport): number {
  const { added, removed, changed } = report.api;
  return added.length + removed.length + changed.length + report.ram.length + report.commits.length;
}

/**
 * `text` as a code span, fenced with more backticks than any run inside it. Upstream text (commit titles, names) goes
 * in one, so its `#123` references, `@mentions`, links and HTML render as plain text in our issue.
 */
export function codeSpan(text: string): string {
  const fence = "`".repeat(longestBacktickRun(text) + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

const short = (sha: string) => sha.slice(0, 10);
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const code = (names: string[]) => names.map(codeSpan).join(", ");
const cell = (text: string | null) => (text === null ? "–" : codeSpan(text).replaceAll("|", "\\|"));

/** The longest run of backticks in `text`, so a fence around it can be longer. */
const longestBacktickRun = (text: string) => Math.max(0, ...[...text.matchAll(/`+/g)].map(([run]) => run.length));

/** The first `limit` items rendered, and a line saying how many more there are. */
function capped<T>(items: T[], render: (item: T) => string, noun: string, limit = LIST_LIMIT): string[] {
  const lines = items.slice(0, limit).map(render);
  const more = items.length - limit;
  return more > 0 ? [...lines, "", `…and ${count(more, `more ${noun}`)}.`] : lines;
}

function apiSection(report: WatchReport): string[] {
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

function ramSection(report: WatchReport): string[] {
  if (report.ram.length === 0) return ["No changes."];
  return [
    `| Function | Pinned | ${codeSpan(report.upstream.ref)} |`,
    "|---|---|---|",
    ...capped(report.ram, (c) => `| ${cell(c.path)} | ${cell(c.before)} | ${cell(c.after)} |`, "RAM cost"),
    "",
    "GB. (SF4) marks a Singularity cost, which is ×16 without Source-File 4 or at SF4.1, ×4 at SF4.2, and as shown at SF4.3 or in BitNode 4.",
  ];
}

/** The compiler's output when the typecheck couldn't run is cut to this, on a line break. */
const TYPECHECK_REASON_LIMIT = 3_000;
/** Type errors listed, and each message's length: the issue points at them; `report` locally has them all. */
const TYPE_ERROR_LIST_LIMIT = 50;
const TYPE_ERROR_MESSAGE_LIMIT = 300;
const CONTRACT_TYPECHECK_DOCS = `${REPO}/tools/upstream-watch/README.md#maintaining-it`;

/** `text` in a fenced block, fenced with more backticks than any run inside it. */
function fencedBlock(text: string): string[] {
  const fence = "`".repeat(Math.max(3, longestBacktickRun(text) + 1));
  return [`${fence}text`, text, fence];
}

/** `text` cut to `limit` characters, at a line break if there's one, marked with "…". */
function cutText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const lineBreak = text.lastIndexOf("\n", limit);
  return `${text.slice(0, lineBreak > 0 ? lineBreak : limit)}${lineBreak > 0 ? "\n" : ""}…`;
}

/** One line for the summary when the typecheck found errors or couldn't run; nothing when it's clean. */
function typecheckSummary(report: WatchReport): string[] {
  const { contractTypecheck } = report;
  if (!contractTypecheck.ran) return ["**Contract typecheck:** couldn't run (below).", ""];
  if (contractTypecheck.errors.length === 0) return [];
  const errors = count(contractTypecheck.errors.length, "type error");
  return [`**Contract typecheck:** ${errors} against ${codeSpan(report.upstream.ref)}'s definitions (below).`, ""];
}

function typecheckSection(report: WatchReport): string[] {
  const { contractTypecheck } = report;
  const intro = `\`packages/ingame\` typechecked against ${codeSpan(report.upstream.ref)}'s \`${DEFINITIONS}\` instead of the pinned one.`;
  if (!contractTypecheck.ran) {
    return [
      intro,
      "",
      `**It couldn't run**, so this report says nothing about whether the in-game code still compiles ([what to do](${CONTRACT_TYPECHECK_DOCS})). Its output:`,
      "",
      ...fencedBlock(cutText(contractTypecheck.reason, TYPECHECK_REASON_LIMIT)),
    ];
  }
  if (contractTypecheck.errors.length === 0) return [intro, "", "**None:** no type errors."];
  return [
    intro,
    "",
    `**${count(contractTypecheck.errors.length, "type error")}:**`,
    "",
    "| File | Line:column | Message |",
    "|---|---|---|",
    ...capped(
      contractTypecheck.errors,
      (error) =>
        `| ${cell(error.file)} | ${error.line}:${error.column} | ${cell(cutText(error.message, TYPE_ERROR_MESSAGE_LIMIT))} |`,
      "type error",
      TYPE_ERROR_LIST_LIMIT,
    ),
  ];
}
/** What to do to move the pinned game to the upstream commit: the stable watcher's issue tracks these. */
function bumpSteps(report: WatchReport): string[] {
  const { sha } = report.upstream;
  // Docs write the pinned commit as 9 characters (`1da7316ff`).
  const old = [report.pinned.version, report.pinned.sha.slice(0, 9)];
  return [
    "## Bump steps",
    "",
    // The submodule is a shallow clone: a plain `fetch origin stable` pulls in years of history behind it.
    `1. Point the submodule at it: \`git -C vendor/bitburner-src fetch --depth 1 origin ${sha}\`, then \`git -C vendor/bitburner-src checkout FETCH_HEAD\`, and commit the new gitlink.`,
    "2. Update `PINNED_GAME` in `packages/core/src/game-version.ts` (version string, `VersionNumber`, commit). Its contract test checks it against the submodule.",
    "3. Run `npm run setup:engine` (the game's lockfile may have changed), then `npm run check`.",
    `4. Re-audit the simulator's browser parity: [the checklist](${REPO}/docs/sim/parity.md#re-auditing-after-a-version-bump).`,
    `5. Run the heavy suites ([releasing](${REPO}/docs/releasing.md) step 2) and, once they exist, the smoke checks.`,
    "6. Update the mechanics docs that the API, RAM cost and watched-source sections below touch.",
    `7. Update the other mentions of the pinned version: search the repository for \`${old[0]}\` and \`${old[1]}\` (the README, CLAUDE.md, the architecture and mechanics docs).`,
    "8. Open the bump PR as a normal PR (CI and the three-pass review), closing this issue.",
    "",
  ];
}

/** The opening paragraph: what was compared, and what it means for this watcher. */
function intro(report: WatchReport, watcher: Watcher): string {
  const { pinned, upstream } = report;
  const theirs = `v${upstream.version} (\`${short(upstream.sha)}\`, committed ${upstream.date})`;
  const ours = `v${pinned.version} (\`${short(pinned.sha)}\`)`;
  if (watcher === "dev") {
    return `Compared the pinned game, ${ours}, with upstream ${codeSpan(upstream.ref)}, ${theirs}. Generated by \`tools/upstream-watch\`; advisory only ([ADR 0005](${FORWARD_ADR})).`;
  }
  const generated = "Generated by `tools/upstream-watch`.";
  if (!moved(report))
    return `Upstream ${codeSpan(upstream.ref)} is the pinned commit, ${ours}: nothing to do. ${generated}`;
  if (!upstream.ahead) {
    return `Upstream ${codeSpan(upstream.ref)} differs from the pinned game, ${ours}, but isn't ahead of it: ${theirs} doesn't have the pinned commit in its history. A rewound branch or a test ref, not a release to bump to: check before acting on it. ${generated}`;
  }
  return `Upstream ${codeSpan(upstream.ref)} has moved ahead of the pinned game, ${ours}, to ${theirs}. Steam ships from \`stable\`, so a Steam update is coming. This issue tracks bumping the pinned game ([ADR 0003](${PINNING_ADR}), [ADR 0010](${STABLE_ADR})). ${generated}`;
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

export function renderReport(report: WatchReport, watcher: Watcher = "dev"): string {
  const total = changeCount(report);
  const declarations = report.api.added.length + report.api.removed.length + report.api.changed.length;
  const summary =
    total === 0
      ? "**No changes.**"
      : `**${count(total, "change")}:** ${count(declarations, "API declaration")}, ${count(report.ram.length, "RAM cost")}, ${count(report.commits.length, "watched-source commit")}.`;
  const head = [
    intro(report, watcher),
    "",
    summary,
    "",
    ...typecheckSummary(report),
    ...(watcher === "stable" && report.upstream.ahead ? bumpSteps(report) : []),
    "## API surface",
    "",
    `\`${DEFINITIONS}\`, by declaration and member. Comments and formatting don't count.`,
    "",
    ...apiSection(report),
    "",
  ];
  // The typecheck first after the raw diff: cutting a body that's still too long takes the sections after it first.
  const tail = [
    "",
    "## Contract typecheck",
    "",
    ...typecheckSection(report),
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
  ];
  const fixed = head.join("\n").length + tail.join("\n").length + 2;
  const body = [...head, ...rawDiff(report.rawApiDiff, BODY_LIMIT - fixed), ...tail].join("\n");
  // Lists are capped by count, so a few very long entries could still overflow: then cut at the limit, on a line break.
  if (body.length <= BODY_LIMIT) return body;
  const cut = body.slice(0, BODY_LIMIT - CUT.length);
  return cut.slice(0, cut.lastIndexOf("\n")).trimEnd() + CUT;
}

/** The report as `report --out` writes it, for `publish`. */
export interface ReportFile {
  /** Changed declarations, RAM costs and watched commits. */
  changes: number;
  /** Whether the ref is another commit than the pinned one, changes or not. */
  moved: boolean;
  /** Whether it's ahead of the pinned one: see `WatchReport.upstream.ahead`. */
  ahead: boolean;
  /** Whether the contract typecheck ran. One that couldn't is news for the forward check: the tool needs fixing. */
  contractTypecheckRan: boolean;
  pinned: { sha: string; version: string };
  upstream: { ref: string; sha: string; version: string };
  markdown: string;
}

export function reportFile(report: WatchReport, watcher: Watcher = "dev"): ReportFile {
  const { ref, sha, version, ahead } = report.upstream;
  return {
    changes: changeCount(report),
    moved: moved(report),
    ahead,
    contractTypecheckRan: report.contractTypecheck.ran,
    pinned: report.pinned,
    upstream: { ref, sha, version },
    markdown: renderReport(report, watcher),
  };
}
