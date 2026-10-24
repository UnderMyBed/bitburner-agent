# 0008 — Work tracking and three-pass reviews

- **Status:** Accepted (2026-10-24)
- **Extends:** [0004](0004-merge-gate-and-testing.md)

## Context
After the design phase we went straight from the architecture to building. Decisions were recorded in ADRs and in the architecture, but the *work* wasn't:
- Milestones were one table row each.
- Work lists sat inside reports.
- Deferred review findings and small owner decisions were scattered or lived only in conversation.

A reviewer also had nothing precise to check a PR against except the architecture as a whole. The build process is autonomous and the owner doesn't review every PR (ADR 0004), so the specs have to be explicit, trackable and checkable.

## Decision

### Tracking: GitHub issues carry the specs
- **Milestones** (M1–M6) are GitHub milestones, each with the exit criteria from architecture §13.
- **Epics** are issues labelled `type:epic`. Each one holds the goal, design summary (with links to architecture sections and ADRs), scope, exit criteria and risks. Its tasks are GitHub **sub-issues**.
- **Tasks** are issues labelled `type:task`, each one PR-sized. A task carries its own **design, implementation plan, acceptance criteria, test plan and docs-to-update**, using the task issue form. Every PR closes a task (`Closes #n`).
- **Questions** (architecture §15) are `type:question` issues. They are answered with evidence, and the answer is written back into the docs.
- **Deferred review findings** become issues labelled `from-review`, so nothing deferred is lost.
- A **project board** gives the cross-milestone view.
- **Owner decisions** that don't need a full ADR go in the [owner decisions log](owner-decisions.md), with the date and where each one is reflected.

### Planning: a step between design and building
- **Rolling wave:**
  - Every milestone has its epics from the start.
  - When a milestone becomes active, its tasks are written in full (design, plan, acceptance criteria).
  - Before any of those tasks is built, the plan gets a **plan review** against the architecture: is it complete, consistent, and does it meet the milestone's exit criteria?
- **Specs can change, but visibly.** If building shows the design is wrong, the issue (and the architecture or ADR, if affected) is updated in the same PR, and the review checks the change.

### Review: three passes on every PR
Each pass is a separate reviewer with fresh context. It sees the diff, the task issue and the linked docs, never the author's reasoning.

| Pass | Checks against | Looks for |
|---|---|---|
| 1. Spec | The task issue (design, plan, acceptance criteria), linked architecture sections and ADRs | Every acceptance criterion met, with evidence; deviations justified and the spec updated; nothing missing; no scope creep |
| 2. Correctness and tests | The code and its tests | Bugs, edge cases, failure modes, determinism, performance; whether the tests would actually catch a regression |
| 3. Docs and maintainability | Docs and code quality | Docs updated or created where behaviour changed; clarity, simplicity, consistency with conventions; fit with the architecture |

- The three passes run in parallel.
- Their findings are recorded in **one PR comment**: a table of finding, severity and resolution.
- Every finding is fixed, answered, or deferred to a `from-review` issue before merge.
- A trivial change (typo, version bump) may combine the passes into one, and the PR says so.

### Milestone close
- A milestone closes with a **milestone review**: every exit criterion verified, all its issues closed or explicitly moved, and docs consistent with what was built.
- Then a tagged release, with notes for the owner.

## Consequences
- Every PR can be checked against a written spec, and every decision and deferred item has a home.
- Planning costs time up front, kept proportionate by planning only the active milestone in detail.
- Issue specs and the architecture can drift apart. The spec pass and the milestone review check that they agree.
