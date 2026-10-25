# tools/upstream-watch

Watches the upstream game repository for changes coming our way, and keeps a tracking issue about them. It's the forward check against `dev` ([ADR 0005](../../docs/decisions/0005-forward-compat-dev-branch.md), [architecture §12.4](../../docs/architecture.md#124-version-management) point 4). It's advisory: nothing it finds blocks a merge. It runs on demand and at every release ([ADR 0009](../../docs/decisions/0009-upstream-watchers-on-demand.md)).

## What it reports

It compares the pinned game (`vendor/bitburner-src`'s gitlink) with an upstream ref:

| Section | Source | What's listed |
|---|---|---|
| API surface | `src/ScriptEditor/NetscriptDefinitions.d.ts` | Declarations added, removed and changed. For interfaces, classes, enums and object types, the members added, removed and changed. If one side isn't an object type (say it became an intersection), the declaration is listed as changed with no member breakdown. Comments and formatting don't count. The raw diff follows, collapsed. |
| RAM costs | `src/Netscript/RamCostGenerator.ts` | Each function's cost under `ns` (`hack`, `singularity.cat`, `formulas.hacking.hackChance`), with the cost constants and arithmetic resolved, so a changed constant shows up in every function that uses it. `(SF4)` marks a Singularity cost, which is multiplied without Source-File 4. |
| Watched source | [`watchlist.txt`](watchlist.txt) | Commits touching the watched paths: whole subsystems (BitNode, constants, corporation, darknet, the Netscript runtime and every `ns` function), plus every game file our [mechanics docs](../../docs/mechanics/) cite. |
| Contract typecheck | — | Not applicable until an in-game package exists ([#42](https://github.com/UnderMyBed/bitburner-agent/issues/42)). |

- **Upstream text is shown in code spans:** each commit title whole, and names and costs too. Its `#123` references, `@mentions`, links and HTML therefore don't link to our own issues, notify anyone upstream or change the page.
- **Long lists are capped** at 150 entries with "…and N more". The raw diff is cut first, so the body stays under GitHub's limit.

## Running it

It needs a clone of the game's repository. A blobless one is enough and quick to make; fetch it again before a later run:

```
git clone --filter=blob:none --no-checkout https://github.com/bitburner-official/bitburner-src.git ../game
git -C ../game fetch          # later runs
node tools/upstream-watch/cli.ts report --game ../game --ref origin/dev [--out report.json]
```

`report` prints the Markdown.
- `--ref` is a branch (`origin/<name>`), a tag or a commit.
- `--pinned <sha>` compares from another commit than the pinned one.
- `--out` also writes the report as JSON for `publish`: `{ changes, moved, pinned, upstream, markdown }`. `moved` says whether the ref is another commit than the pinned one, whether or not anything listed changed.

`publish` updates the tracking issue from that file, through the `gh` CLI:

```
node tools/upstream-watch/cli.ts publish --report report.json --title "Upcoming game changes (upstream dev)" [--dry-run]
```

- It finds the watcher's issue by title prefix (`--prefix`, default the title) among issues labelled `upstream-watch`. The label must exist; it's in [CONTRIBUTING](../../CONTRIBUTING.md)'s label list.
- **With changes:** it updates the open issue. If none is open, it reopens the latest closed one, so the history stays in one thread. If there's never been one, it creates one.
- **Without changes:** `--when-empty close` (the default) closes the open issue with a comment; `leave` leaves it.
- `--repo owner/name` picks the repository: by default `$GITHUB_REPOSITORY`, then this one.
- `--dry-run` prints the plan and the body and changes nothing.

Both commands exit 0 on success and 2 on bad usage or any failure: a git or gh error, or a file the extractors can't take apart.

## The workflow

[`.github/workflows/forward-check.yml`](../../.github/workflows/forward-check.yml) runs it on demand: Actions → "Forward check (upstream dev)" → Run workflow, or `gh workflow run forward-check.yml`. Its `ref` input defaults to `origin/dev`. Every release runs it ([releasing](../../docs/releasing.md) step 2). It runs in two jobs:
- **`report`** reads upstream content, with read-only access to this repository.
- **`publish`**, the only job that can write issues, runs `publish` on the finished report.

It never runs on pull requests and isn't a required check.

## Maintaining it

- **The watchlist:**
  - Add a path when an activity, action or estimator comes to depend on more game source.
  - A test checks that every path exists in the pinned game, and that every game file the mechanics docs cite is covered. A doc citing a new file fails that test until the file is listed.
- **The extractors** (`src/declarations.ts`, `src/ram-costs.ts`) aren't general TypeScript parsers. They lex just enough (comments, strings, brackets, generics) to take apart the game's own Prettier-formatted files. Tests run them on the real pinned files, so a reshaped upstream file shows up only when the tool reads it:
  - An unbalanced bracket or a missing `RamCosts` object makes the run fail.
  - A cost expression that doesn't work out to a number is shown as written.
- **Layout:**

  | Path | What |
  |---|---|
  | `cli.ts` | The command line: `report` and `publish` |
  | `src/scan.ts` | Comments, strings, matching brackets, top-level search and splitting, normalising whitespace |
  | `src/declarations.ts` | Declarations and members of a `.d.ts`, and their diff |
  | `src/ram-costs.ts` | The RAM cost tree, flattened and resolved, and its diff |
  | `src/report.ts` | The report's shape and its Markdown, kept under GitHub's issue size limit |
  | `src/git.ts` | `buildReport`: both versions read from the game clone and compared; the pinned commit |
  | `src/issue.ts` | Which issue to create, update, reopen or close |
  | `src/watchlist.ts` | Reading the watchlist, and the game files a doc cites |
  | `watchlist.txt` | Watched game source paths |
  | `test/` | Unit tests, plus integration tests on a scratch git repository, the real pinned files and the docs |
