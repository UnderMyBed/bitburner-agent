# 0008 — Work tracking and three-pass reviews

- **Status:** Accepted (2026-10-24)
- **Extends:** [0004](0004-merge-gate-and-testing.md)

## Context
After the design phase we went straight from the architecture to building. Decisions were recorded, but the *work* wasn't:
- Milestones were one table row each.
- Work lists sat inside reports.
- Deferred review findings and small owner decisions were scattered or lived only in conversation.

Reviewers also had nothing precise to check a PR against except the whole architecture. The build process is autonomous and the owner doesn't review PRs (ADR 0004), so specs must be explicit, trackable and checkable.

## Decision
- **Issues carry the specs.**
  - GitHub milestones (M1–M6) hold epics, and epics hold task sub-issues.
  - Each task carries its own design, implementation plan, acceptance criteria, test plan and docs list.
  - Every PR closes an issue. Open questions, deferred review findings and owner feedback are issues too.
  - A project board shows it all.
- **A planning step between design and building:**
  - Every milestone has epics from the start.
  - A milestone's tasks are written in full only when it becomes active ("rolling wave").
  - Those tasks are reviewed against the architecture before building starts.
  - Specs can change, but visibly: the issue (and the architecture or ADR) is updated in the same PR.
- **Three-pass review on every PR**, each pass by a separate reviewer that sees only the diff, the issue and the linked docs:
  1. Spec
  2. Correctness and tests
  3. Docs and maintainability

  Findings are recorded on the PR and resolved before merge.
- **Milestone close:** a milestone review against the exit criteria, then a tagged release.
- **Owner decisions** too small for an ADR go in a [log](owner-decisions.md).

The procedure itself (forms, labels, severities, where each review is recorded) lives in [CONTRIBUTING.md](../../CONTRIBUTING.md#how-work-flows), which is canonical.

## Why three passes, and why fresh context
A single reviewer checking everything tends to stop at the first category of problem it finds. Separate passes with one question each found different issues in practice, as in the PR #43 review. A reviewer that knows the author's reasoning tends to confirm it, so reviewers get the artefacts only.

## Consequences
- Every PR is checked against a written spec, and every decision and deferred item has a home.
- Planning costs time up front, kept proportionate by planning only the active milestone in detail. Chores and automated changes use a light form.
- Issue specs can drift from the architecture. The spec pass and the milestone review check that they agree.
