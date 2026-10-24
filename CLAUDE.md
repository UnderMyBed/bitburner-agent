# CLAUDE.md

Operating instructions for Claude Code sessions in this repo.

## Mission
Build an autonomous agent that takes Bitburner from a fresh save to every Source-File maxed: unattended, repeatable, as fast as wall-clock allows. Start with `README.md`, then `docs/plan.md`, `docs/architecture.md`, `docs/decisions/`.

## Working model
- **The owner designs and play-tests**; Claude builds, tests, documents and releases. Bring the owner design decisions, irreversible or outward-facing actions, and release notes. Don't bring routine implementation choices.
- **Never play the game directly.** Claude builds software that plays. It doesn't drive the owner's game itself.
- Keep everything **clear, simple, performant, well documented**. Simplicity beats cleverness.

## How work flows
Follow [CONTRIBUTING.md "How work flows"](CONTRIBUTING.md#how-work-flows). It's the canonical procedure: tracking, planning, three-pass review, merge, milestone close. ADR 0004 and ADR 0008 hold the reasons. Rules specific to you:
- **No code without an issue that carries the spec.** If the issue is wrong, fix it (and the architecture/ADR) in the same PR, visibly.
- **Reviewers are fresh agents.** Run one per pass, in parallel. Give each the PR number, the issue and the docs to check against, never your reasoning, and tell it to stay read-only. Post the findings table yourself.
- **Test first.** Write the failing test, make it pass, refactor. Prove gates aren't hollow (probe files) when you add or change one.
- When you create an issue, add it to the project board (`gh project item-add 3 --owner UnderMyBed --url <issue>`). Keep board statuses current as work moves.
- Run the heavy suites (simulator scenario/chaos, end-to-end) when touching the code they cover and before every release. No nightly runs.
- Behaviour changes update docs in the same PR. Design changes get a new ADR; owner decisions go in `docs/decisions/owner-decisions.md`.

## Rules of engagement (for the agent's runtime on the live game)
- **Allowed:** Netscript API; page DOM/React state reached from in-game scripts (e.g. `eval("document")`); seeded-RNG prediction from in-game state; official API options such as `sourceFileOverrides`.
- **Forbidden:** DevTools/CDP against the live game, save editing, modifying game code, the dev menu.
- Test harnesses on the simulator and source builds may use any tooling.
- **Vanilla-only dependency:** agent code must never rely on behaviour that doesn't exist in the unmodified pinned game version.
- **Saves flow one way:** Steam saves may become test fixtures. Nothing produced in test environments goes back into Steam.

## Game version
- `vendor/bitburner-src` is a submodule pinned to the commit Steam ships (currently v3.0.1, `1da7316ff`, VersionNumber 51). Treat it as read-only. See ADR 0003 for the patch strategy.
- Clone with `git submodule update --init` (shallow is configured).
- The mechanics docs in `docs/mechanics/` cite `file:line` into this submodule. Verify a claim against the source before depending on it, and back the dependency with a test.

## GitHub hygiene
- This repo: `UnderMyBed/bitburner-agent`. Always pass `-R UnderMyBed/bitburner-agent` (or confirm `gh repo set-default`) before `gh pr`/`gh issue` commands.
- Never open issues, PRs or comments on upstream repos (`bitburner-official/*`, `alainbryden/*`) unless the owner explicitly asks.
