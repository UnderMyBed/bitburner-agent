// Which issue a watcher run touches. Each watcher keeps one tracking issue, found by its title prefix.

export interface ExistingIssue {
  number: number;
  state: "OPEN" | "CLOSED";
  title: string;
}

export type IssueAction =
  | { kind: "create" }
  | { kind: "update"; number: number }
  /** Reopen it, then update it as for "update". */
  | { kind: "reopen"; number: number }
  | { kind: "close"; number: number }
  | { kind: "none" };

/**
 * With news (see `hasNews`), the open tracking issue is updated. If none is open, the latest closed one is reopened, so the history
 * stays in one thread, and one is created only if there's never been one. Without news, the open one is closed
 * (`whenEmpty: "close"`) or left as it is ("leave").
 */
export function planIssue(
  issues: ExistingIssue[],
  titlePrefix: string,
  { news, whenEmpty }: { news: boolean; whenEmpty: "close" | "leave" },
): IssueAction {
  const ours = issues.filter((i) => i.title.startsWith(titlePrefix)).sort((a, b) => b.number - a.number);
  const open = ours.find((i) => i.state === "OPEN");
  if (!news) return open && whenEmpty === "close" ? { kind: "close", number: open.number } : { kind: "none" };
  if (open) return { kind: "update", number: open.number };
  const latest = ours[0];
  return latest ? { kind: "reopen", number: latest.number } : { kind: "create" };
}

/** A title template with `{version}` and `{sha}` (the first 10 characters) filled in from the upstream commit. */
export function fillTitle(template: string, upstream: { version: string; sha: string }): string {
  // Replacer functions: upstream text goes in as is, with no `$&`-style patterns.
  return template.replaceAll("{version}", () => upstream.version).replaceAll("{sha}", () => upstream.sha.slice(0, 10));
}

/** Whether a report has something to publish: listed changes (`on: "changes"`), or any move of the ref (`"moved"`). */
export function hasNews(report: { changes: number; moved: boolean }, on: "changes" | "moved"): boolean {
  return on === "moved" ? report.moved : report.changes > 0;
}
