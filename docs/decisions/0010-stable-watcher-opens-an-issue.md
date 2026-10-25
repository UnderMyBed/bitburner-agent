# 0010 — The stable watcher opens an issue, not a pull request

- **Status:** Accepted (2026-10-24)
- **Amends:** [0003](0003-game-version-pinning.md) (what the `stable` watcher does when upstream moves)

## Context
ADR 0003 has the `stable` watcher bump the submodule on a branch, run the full suite and open a PR with a compatibility report. A workflow can only open that PR with credentials:
- **With the workflow's own `GITHUB_TOKEN`:** the PR doesn't trigger CI, so the required `check` never runs on it and it can't merge.
- **With a personal access token:** CI would run, but the token is a standing secret with write access, for a job that runs rarely.

A bump also isn't mechanical. It means re-auditing the simulator's browser parity, running the heavy suites, and updating the mechanics docs, and those go through the merge gate and the three-pass review like any other change (ADR 0004, 0008).

## Decision
- When `stable` has moved ahead of the pinned commit, the watcher keeps **one issue**: "Upstream stable moved: v\<version\> (\<sha\>)", labelled `upstream-watch`. It holds the **bump steps**, then the same compatibility report the `dev` forward check makes ([`tools/upstream-watch`](../../tools/upstream-watch/README.md)): API surface, RAM costs and watched-source commits.
- The watcher itself no longer bumps the submodule or runs the suite. The bump is a **normal PR**, made by the build process: it runs CI, gets the three-pass review, and closes the issue.
- If `stable` differs from the pinned commit without being ahead of it (a rewound branch), the issue says so instead of listing bump steps.
- When `stable` is the pinned commit, the watcher does nothing. An open issue stays open until the bump PR closes it.
- It runs on demand and at every release, like the forward check (ADR 0009).

## Consequences
- No new credentials: the workflow writes issues with its own token, in a job that only runs our CLI on a finished report.
- A Steam update means an issue to act on, not a ready PR. The report and the bump steps make that quick.
