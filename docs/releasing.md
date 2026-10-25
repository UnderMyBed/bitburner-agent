# Releasing

A release is a tag on `main` with notes. It marks a milestone closed ([CONTRIBUTING](../CONTRIBUTING.md#how-work-flows), step 5), and it's what the owner play-tests ([plan](plan.md)). The GitHub releases page is the changelog: there is no CHANGELOG file.

## Versions

`0.<milestone>.<patch>` until the campaign starts:
- **`0.<milestone>.0`** closes milestone M\<milestone\>: v0.1.0 is M1, v0.2.0 is M2, and so on.
- **`0.<milestone>.<patch>`**, with patch 1 and up, is a fix released between milestones (for example, after play-testing finds a bug).

The scheme moves to 1.x when the agent first plays the real campaign unattended. That change gets an ADR.

## Before a release

Every item is checked, and the result is linked from the milestone's review issue:

1. **The milestone review is recorded** on the milestone's review issue (for M1, #44):
   - every exit criterion in [architecture §13](architecture.md#13-milestones) is verified, with evidence
   - every issue in the milestone is closed, or moved with a reason
   - the docs match what was built
2. **The heavy suites have run** on the commit being released, and their output is linked:
   - the simulator's scenarios: `npm run sim -- <scenario>` for each workload in `packages/sim/scenarios/` and each baseline, with the seeds the scenario names
   - the benchmarks: `npm run bench -w @bitburner-agent/sim` ([#31](https://github.com/UnderMyBed/bitburner-agent/issues/31)), with the new row in `docs/sim/benchmarks.md`
   - the chaos and end-to-end suites, once they exist (M2 onwards)
3. **`main` is green:** CI passes on the commit being tagged.

## Release notes

```markdown
## vX.Y.Z — M<n>: <milestone title>

Game version: v3.0.1 (`1da7316ff`), as Steam ships it.

### What changed
- <what the milestone delivered, a line each, linking the PRs or epics>

### What to try
- <steps for the owner's play-test: what to run, what to look for>

### Known issues
- <open issues and deferred findings that affect use, linked>
```

- **What changed** is what a user of the project notices, not a commit list.
- **What to try** is written for the owner's play-test: concrete steps and what a good result looks like.
- **Known issues** include anything moved out of the milestone.

## Commands

```
git switch main && git pull
gh release create vX.Y.Z --target main --title "vX.Y.Z — M<n>: <title>" --notes-file notes.md
```

Then link the release from the milestone's review issue and close the milestone (`gh api -X PATCH repos/UnderMyBed/bitburner-agent/milestones/<number> -f state=closed`).

## After a release

The owner plays the release and files what they find with the Feedback form. Feedback is triaged into tasks, bugs or questions for the next milestone, or into a patch release.
