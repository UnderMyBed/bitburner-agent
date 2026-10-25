# Provenance of `fork/`

`fork/` is every file of the legacy fork's tree at one commit, copied byte for byte (the raw git blobs, line endings included):

| | |
|---|---|
| Source | https://github.com/UnderMyBed/bitburner-scripts (archived), a fork of [alainbryden/bitburner-scripts](https://github.com/alainbryden/bitburner-scripts) |
| Commit | `2705617f3908340ff8cb18fab38962e8caf6af84` (2026-10-24), "README: mark fork as archived and superseded by bitburner-agent" |
| Tree | `3902f18b3d5b4b1af1fa2dc08dab1b7b1497de48`, that commit's tree |
| License | MIT, © 2021 Alain Bryden: [`fork/LICENSE`](fork/LICENSE), kept with the files |
| Files | 55, each with its sha256 in [`manifest.json`](manifest.json) |

[`manifest.json`](manifest.json) is the one record of these: `src/index.ts` reads the source and commit from it, and `test/fork.test.ts` checks the files against it and this page against it.

## Rules

- **Never edited in place.** The files stay exactly as recorded; `test/fork.test.ts` checks every file against the manifest, byte for byte. Git leaves their bytes alone: the root `.gitattributes` (and the fork's own) mark them `-text`.
- **A change would be a patch.** If the baseline ever needs a file changed, the change would go in `packages/legacy/patches/`, with its reason, applied when the files are written into a game. There are none.
- **`fork/README.md` and `fork/CLAUDE.md` are the fork's own docs.** They describe the archived fork as it was ("this repo", its remotes, its install steps), not this repository, and are kept only because the copy is exact. The repository's `.claude/settings.json` excludes `fork/CLAUDE.md` from Claude Code's memory (`claudeMdExcludes`), for sessions started at the repository root.
- **The fork's own `.gitignore` ignores `*.txt`**, so `fork/reserve.txt` was added with `git add -f`. It's tracked; the rule only matters when adding files, which nobody should.

## Checking it against the source

Git's tree id is a hash of every file's bytes and name, so one comparison checks the whole copy:

```
git rev-parse HEAD:packages/legacy/fork                    # here
git -C <bitburner-scripts clone> rev-parse 2705617f^{tree}  # the source
```

Both print `3902f18b3d5b4b1af1fa2dc08dab1b7b1497de48`.

## How it was copied

Each file's raw blob (`git cat-file blob 2705617f:<file>`), written from Node rather than a shell redirect (which can re-encode bytes, as PowerShell's does), with its sha256 recorded in the manifest.