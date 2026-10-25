# tools/upstream-watch

Watches the upstream game repository for changes coming our way, and keeps a tracking issue about them. It's the forward check against `dev` ([ADR 0005](../../docs/decisions/0005-forward-compat-dev-branch.md), [architecture §12.4](../../docs/architecture.md#124-version-management) point 4). It's advisory: nothing it finds blocks a merge.

## What it reports

It compares the pinned game (`vendor/bitburner-src`'s gitlink) with an upstream ref:

| Section | Source | What's listed |
|---|---|---|
| API surface | `src/ScriptEditor/NetscriptDefinitions.d.ts` | Declarations added, removed and changed. For interfaces and object types, the members added, removed and changed. Comments and formatting don't count. The raw diff follows, collapsed. |
| RAM costs | `src/Netscript/RamCostGenerator.ts` | Each function's cost under `ns` (`hack`, `singularity.cat`, `formulas.hacking.hackChance`), with the cost constants and arithmetic resolved. A changed constant shows up in every function that uses it. `(SF4)` marks a Singularity cost, which is multiplied without Source-File 4. |
| Watched source | [`watchlist.txt`](watchlist.txt) | Commits touching the watched paths: whole subsystems (BitNode, constants, darknet, corporation, Netscript), plus every game file our [mechanics docs](../../docs/mechanics/) cite. |
| Contract typecheck | — | Not applicable until an in-game package exists ([#42](https://github.com/UnderMyBed/bitburner-agent/issues/42)). |

Upstream commit titles are shown with their `#123` references and `@mentions` in code spans, so they don't link to our own issues or notify anyone upstream.

## Running it

It needs a clone of the game's repository. A blobless one is enough and quick to make:

```
git clone --filter=blob:none --no-checkout https://github.com/bitburner-official/bitburner-src.git ../game
node tools/upstream-watch/cli.ts report --game ../game --ref origin/dev [--out report.json]
```

`report` prints the Markdown. `--pinned <sha>` compares from another commit than the pinned one.

`publish` updates the tracking issue from a `report --out` file, through the `gh` CLI:

```
node tools/upstream-watch/cli.ts publish --report report.json --title "Upcoming game changes (upstream dev)" [--dry-run]
```

- It finds the watcher's issue by title prefix (`--prefix`, default the title) among issues labelled `upstream-watch`.
- **With changes:** it updates the open issue. If none is open, it reopens the latest closed one, so the history stays in one thread. If there's never been one, it creates one.
- **Without changes:** `--when-empty close` (the default) closes the open issue with a comment; `leave` leaves it.
- `--dry-run` prints the plan and the body and changes nothing.

## The workflow

[`.github/workflows/forward-check.yml`](../../.github/workflows/forward-check.yml) runs it weekly (Mondays 06:00 UTC) and on demand (Actions → "Forward check (upstream dev)" → Run workflow). It runs in two jobs:
- **`report`** reads upstream content with read-only access to this repository.
- **`publish`**, the only job that can write issues, runs `publish` on the finished report.

It never runs on pull requests and isn't a required check.

## Maintaining it

- **The watchlist** grows as activities, actions and estimators come to depend on more game source. A test checks that every path in it exists in the pinned game.
- **The extractors** (`src/declarations.ts`, `src/ram-costs.ts`) aren't general TypeScript parsers. They lex just enough (comments, strings, brackets) to take apart the game's own Prettier-formatted files. Tests run them on the real pinned files. If upstream reshapes a file, those tests or the workflow will fail rather than report nonsense:
  - an unbalanced bracket throws;
  - a cost that doesn't resolve to a number is shown as written;
  - a missing `RamCosts` object throws.
- **Layout:**

  | Path | What |
  |---|---|
  | `cli.ts` | The command line: `report` and `publish` |
  | `src/scan.ts` | Comments, strings, matching brackets, splitting at top level |
  | `src/declarations.ts` | Declarations and members of a `.d.ts`, and their diff |
  | `src/ram-costs.ts` | The RAM cost tree, flattened and resolved, and its diff |
  | `src/report.ts` | The Markdown report, kept under GitHub's issue size limit |
  | `src/issue.ts` | Which issue to create, update, reopen or close |
  | `src/git.ts` | Reading both versions from the game clone |
  | `watchlist.txt` | Watched game source paths |
  | `test/` | Unit tests, plus integration tests on a scratch git repository and the real pinned files |
