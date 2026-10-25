# Architecture Decision Records

Each significant design or process decision gets a short record: context, decision, consequences. Records are immutable once accepted. To change one, add a new record that supersedes, amends or extends it. The only edit allowed to an accepted record is a link in its status header ("Superseded by", "Amended by", "Extended by"), so readers find the newer record.

| ADR | Title | Status |
|---|---|---|
| [0001](0001-brain-outside-game.md) | The planning brain runs outside the game | Accepted |
| [0002](0002-desired-state-reconciliation.md) | Desired-state reconciliation instead of command streams | Accepted |
| [0003](0003-game-version-pinning.md) | Game version pinning and Steam patch strategy | Accepted |
| [0004](0004-merge-gate-and-testing.md) | Merge gate and test regime | Accepted |
| [0005](0005-forward-compat-dev-branch.md) | Forward-compatibility checks against upstream `dev` | Accepted |
| [0006](0006-tech-stack-and-compute.md) | Tech stack and compute strategy | Accepted |
| [0007](0007-headless-engine-simulator.md) | Simulator: the real engine, headless, on a virtual clock | Accepted |
| [0008](0008-work-tracking-and-reviews.md) | Work tracking and three-pass reviews | Accepted |
| [0009](0009-upstream-watchers-on-demand.md) | The upstream watchers run on demand | Accepted |

Smaller decisions by the project owner are in the [owner decisions log](owner-decisions.md).

Template: copy an existing record. Keep it under a page.
