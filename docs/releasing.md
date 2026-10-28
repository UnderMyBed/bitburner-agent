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
   - the BN1 baseline, **only when it can change** (owner decision 32). It's deterministic: on the same code and Node version, it gives the same results.
     - **Its last run** is the Commit of the last rows in [`docs/sim/baselines.md`](sim/baselines.md), or of rows already on this release's review issue, which reach that file only at step 4. Drop a `-dirty` suffix.
     - **Check what it runs on** since then, docs and tests aside:

       ```
       git diff --stat <last run> <candidate> -- packages/sim packages/legacy packages/core vendor/bitburner-src package-lock.json tsconfig.json tsconfig.base.json tsconfig.node.json ':(exclude,glob)**/*.md' ':(exclude,glob)**/test/**'
       ```

       Also compare `node --version` with the last rows' Node column.
     - **Nothing changed:** don't run it. Post the empty output and the last rows' commit on the review issue.
     - **Something changed:** run it. Or, if a change can't reach the simulation (code the simulator never loads), say why on the review issue instead. To run it, `npm run baseline -w @bitburner-agent/legacy` plays the legacy fork's BN1 baseline over its 8 seeds, to 4, 8 and 12 virtual hours, and prints its rows. It takes about an hour on one core. A seed that hits its 60-minute limit has gone wrong ([running it](sim/baselines.md#running-it)). Explain any failed seed in the file's Failures section at step 4.
     - **At M4,** run it whatever the check says: the planner is compared with it then.
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
     - **The forward check's result.** Link the "Upcoming game changes (upstream dev)" issue it updated, or say it closed it because nothing changed. Either way, give its contract typecheck result: "None"; the type errors (each gets an issue, so the in-game code is ready before Steam ships the change); or that it couldn't run, which is a broken check to fix before the release ([what to do](../tools/upstream-watch/README.md#maintaining-it)).
   - the end-to-end suite (E2): `npm run e2:build`, then `npm run e2` (on a new machine, `npm run e2:install` once first; [`packages/e2`](../packages/e2/README.md)). Post Vitest's summary and the lines the tests log: the clock's speed-up, the reload time, the autoexec'd script's time, the RFA connection times, and the skeleton's cadence, reconnect and Q1 RAM lines. Also any warning starting `E2: the game didn't load within`, and the summary of retried loads the run prints at its end (`E2: … fixture load… needed a retry this run`), or that there was none: a retried load is a recurrence of [#120](https://github.com/UnderMyBed/bitburner-agent/issues/120), so report it there too;
   - a live run on Steam (from M2), which is the owner's: it runs on their game, and Claude never drives it. The candidate commit runs on Steam ([`docs/setup.md`](setup.md)), usually what the owner's check left running, for as long as it happens to run: there's no set length (owner decision 33). `<start>` is a time once the dashboard shows the Agent connected, after setup, written with a `Z` or an offset, like `2026-10-27T00:00:00Z`: a window that opens earlier counts the setup as a gap. Then, while it's still running, `npm run gaps -- --environment E0 --since <start>` (the window ends now) should exit 0 ("No gaps."). Post its output on the review issue: it includes the page heap's first, last, lowest and highest values over the window ([the gap report](../packages/brain/README.md#the-gap-report)). A gap is explained there, not necessarily rerun.
     - **From M3, the owner's smoke test** on the same commit: each effector once on Steam, and the decisions still open ([M3's](m3-smoke-test.md)). Its install resets the game, so it's best done before the live run's `<start>`. What held, and what didn't, goes on the slices' issues it names.
   - once it exists: the chaos suite (from M3)

3. **Review the milestone.** An independent reviewer (a fresh agent session, as for PR reviews) checks it, and the result is posted on the review issue in this form:

   | Exit criterion ([architecture §13](architecture.md#13-milestones)) | Evidence | Met? |
   |---|---|---|
   | … | a link: a test, a suite table from step 2, a doc | yes / no |

   | Issue | Closed, or moved to | Reason (if moved) |
   |---|---|---|

   It closes with a line on whether the docs match what was built. Every issue in the milestone is closed or moved with a reason, except the review issue, the release task, and any epic whose last criterion is the release, which close in step 6.

4. **Close out the docs, in one PR:**
   - the new rows and reports from step 2: `docs/sim/benchmarks.md`, and, if the baseline ran during this release, its last run's rows in `docs/sim/baselines.md`, under the commit it ran on
   - the README's status and roadmap, plan.md's status, and the status lines of the packages' READMEs, showing the milestone done
   - anything in the README that waited on the milestone, such as "Getting started"

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

   Then link the release from the review issue, close the release task, the review issue and any epic still open in the milestone (an epic whose last criterion is the release), and close the milestone:

   ```
   gh api repos/UnderMyBed/bitburner-agent/milestones --jq '.[] | select(.title | startswith("M<n> ")) | .number'
   gh api -X PATCH repos/UnderMyBed/bitburner-agent/milestones/<number> -f state=closed
   ```

## A patch release

`0.<n>.<patch>`, for fixes after milestone n's release:
- The fixing PRs are merged as usual.
- Steps 1, 2 (the suites the fix touches, and always the workloads), 5 and 6 apply. There's no milestone review and no milestone to close.
- The baseline follows step 2's check. If it runs, its rows go into `docs/sim/baselines.md` in a docs PR before the tag.
- The title is `v0.<n>.<patch> — fix: <what it fixes>`, and the notes link the fixing PRs.

## Release notes

The title is the release's heading, so the notes start below it:

```markdown
Game version: v<version>, as Steam ships it (pinned source: `<vendor/bitburner-src commit>`).

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
