# Releasing

A release is a tag on `main` with notes. A milestone release closes a milestone ([CONTRIBUTING](../CONTRIBUTING.md#how-work-flows), step 5), and every release is something the owner play-tests ([plan](plan.md)). The GitHub releases page is the changelog: there is no CHANGELOG file.

## Versions

`0.<milestone>.<patch>` until the campaign starts:
- **`0.<n>.0`** closes milestone M\<n\>: v0.1.0 is M1, v0.2.0 is M2, and so on.
- **`0.<n>.<patch>`**, with patch 1 and up, fixes the last released milestone (n), for example after play-testing finds a bug.

The scheme moves to 1.x when the agent first plays the real campaign unattended. That change gets an ADR.

## A milestone release

Do these in order. All evidence goes on the milestone's review issue (the "M\<n\> reviews" issue, label `area:process`; for M1, [#44](https://github.com/UnderMyBed/bitburner-agent/issues/44)).

1. **Pick the candidate commit.** It's the `main` commit everything is checked against. Take it when the milestone's code is merged, and record it on the review issue:

   ```
   git fetch origin && git rev-parse origin/main
   gh run list -R UnderMyBed/bitburner-agent --workflow CI --commit <sha>   # must show success
   ```

2. **Run the heavy suites on it.** Check out the candidate commit, run each suite, and post its printed table on the review issue, naming the commit:
   - the workloads: `npm run sim -- packages/sim/scenarios/<name>.json` for each `.json` file there
   - the baselines: `npm run baseline -w @bitburner-agent/legacy` runs the legacy fork's BN1 baseline over its 8 seeds and prints its row: paste it into [`docs/sim/baselines.md`](sim/baselines.md), and explain any failed seed in its Failures section. It's heavy: by default it runs one seed at a time, prints progress on stderr, and stops each seed after 12 hours of real time, so 8 seeds take at most about 4 days. A seed stopped by that limit fails the run (exit 1): explain it in the Failures section, and treat it as a question of where the baseline runs, not of a longer limit ([running it](sim/baselines.md#running-it)). Where the 8 seeds run is still to be decided ([#33](https://github.com/UnderMyBed/bitburner-agent/issues/33))
   - the benchmarks, on the reference rig: `npm run bench -w @bitburner-agent/sim`, which appends a row to `docs/sim/benchmarks.md` ([benchmarks](sim/benchmarks.md)). Post the printed row. A regression (exit 1) isn't recorded. Find the cause before going on: fix it, or say on the review issue why it's accepted and record it with `-- --accept` ([regressions](sim/benchmarks.md#regressions)).
   - the upstream watchers ([ADR 0009](decisions/0009-upstream-watchers-on-demand.md), [`tools/upstream-watch`](../tools/upstream-watch/README.md)). They run on `main`, which is the candidate commit until the close-out:

     ```
     gh workflow run stable-watch.yml -R UnderMyBed/bitburner-agent
     gh workflow run forward-check.yml -R UnderMyBed/bitburner-agent
     gh run list -R UnderMyBed/bitburner-agent --limit 2        # wait for both: gh run watch <id> -R UnderMyBed/bitburner-agent
     gh issue list -R UnderMyBed/bitburner-agent --label upstream-watch --state all
     ```

     Post on the review issue:
     - **The stable watcher's result.** When `stable` hasn't moved, its run logs `moved false → none` and there's no issue; say so. When it has, link the "Upstream stable moved" issue and decide whether the bump goes in this release.
     - **The forward check's result.** Link the "Upcoming game changes (upstream dev)" issue it updated, or say it closed it because nothing changed.
   - once they exist: the end-to-end suite (E2, from M2) and the chaos suite (from M3)

3. **Review the milestone.** An independent reviewer (a fresh agent session, as for PR reviews) checks it, and the result is posted on the review issue in this form:

   | Exit criterion ([architecture §13](architecture.md#13-milestones)) | Evidence | Met? |
   |---|---|---|
   | … | a link: a test, a suite table from step 2, a doc | yes / no |

   | Issue | Closed, or moved to | Reason (if moved) |
   |---|---|---|

   It closes with a line on whether the docs match what was built. Every issue in the milestone is closed or moved with a reason, except the review issue and the release task, which close in step 6.

4. **Close out the docs, in one PR:**
   - the new rows and reports from step 2 (`docs/sim/benchmarks.md`, `docs/sim/baselines.md`)
   - the README's status and roadmap, and plan.md's status, showing the milestone done

   Only docs may change between the candidate commit and the tag. Check that with `git diff --stat <candidate> origin/main`: everything listed must be `docs/` or `*.md`. If code changed, go back to step 1.

5. **Draft the release.** Write the notes (below) in a file outside the repository, then create the release as a draft, tagging the merged close-out commit:

   ```
   gh release create v0.<n>.0 -R UnderMyBed/bitburner-agent --draft --target <full sha> \
     --title "v0.<n>.0 — <milestone title>" --notes-file <notes file>
   ```

   For example: `--title "v0.1.0 — M1 — Toolchain and simulator core"` (milestone titles already start with "M\<n\> — ").

6. **The owner reads the notes, then it's published.** Release notes go to the owner before anything is published (the working model in [CLAUDE.md](../CLAUDE.md)). Once they agree:

   ```
   gh release edit v0.<n>.0 -R UnderMyBed/bitburner-agent --draft=false
   ```

   Then link the release from the review issue, close the release task and the review issue, and close the milestone:

   ```
   gh api repos/UnderMyBed/bitburner-agent/milestones --jq '.[] | select(.title | startswith("M<n> ")) | .number'
   gh api -X PATCH repos/UnderMyBed/bitburner-agent/milestones/<number> -f state=closed
   ```

## A patch release

`0.<n>.<patch>`, for fixes after milestone n's release:
- The fixing PRs are merged as usual.
- Steps 1, 2 (the suites the fix touches, and always the workloads), 5 and 6 apply. There's no milestone review and no milestone to close.
- The title is `v0.<n>.<patch> — fix: <what it fixes>`, and the notes link the fixing PRs.

## Release notes

The title is the release's heading, so the notes start below it:

```markdown
Game version: v<version> (`<vendor/bitburner-src commit>`), as Steam ships it.

### What changed
- <what the milestone delivered, a line each, linking the PRs or epics>

### What to try
- <steps for the owner's play-test: what to run, what to look for>

### Known issues
- <every issue moved out of the milestone, and any other open issue that affects use, linked>
```

- **The game version** is `PINNED_GAME` in `packages/core/src/game-version.ts`, which a test keeps in step with the submodule.
- **What changed** is what a user of the project notices, not a commit list.
- **What to try** is written for the owner's play-test: concrete steps and what a good result looks like.

## After a release

The owner plays the release and files what they find with the Feedback form. Feedback is triaged into tasks, bugs or questions for the next milestone, or into a patch release.
