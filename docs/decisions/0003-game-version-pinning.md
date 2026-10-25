# 0003 — Game version pinning and Steam patch strategy

- **Status:** Accepted (2026-10-24). Amended by [0009](0009-upstream-watchers-on-demand.md) and [0010](0010-stable-watcher-opens-an-issue.md).

## Context
The campaign is played on Steam, which updates the game whenever it chooses. The simulator, the source builds and the in-game code's types all depend on an exact game version. A silent update could break the agent mid-campaign.

## Decision
- The game source is a git submodule at `vendor/bitburner-src`, tracking upstream `stable` and pinned to the commit Steam ships (v3.0.1 = `1da7316ff`).
- **See patches coming:** a scheduled CI workflow watches upstream `stable`. When it moves, the workflow bumps the submodule on a branch, runs the full suite (including a diff of the API definitions), and opens a PR with a compatibility report. Steam ships from `stable`, so breakage is normally known, and fixed, before Steam updates.
- **Hold at runtime:** on every connect, the brain compares the live `VersionNumber` and `getDefinitionFile` output with the pinned build. On a mismatch it enters **hold**: reflexes keep running, no intents are issued, and an alert is raised.
- **Save backups:** the bridge pulls rotating save backups through the Remote File API.
- **Not done:** we don't try to block Steam updates or keep an alternative game binary as a fallback.

## Consequences
- Worst case after an unexpected patch is degraded (holding, still earning), never broken.
- Upgrading the pinned version is a normal PR that goes through the merge gate.
