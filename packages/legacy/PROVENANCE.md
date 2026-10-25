# Provenance of `fork/`

`fork/` is every file of the legacy fork's tree at one commit, copied byte for byte (the raw git blobs, line endings included):

| | |
|---|---|
| Source | [UnderMyBed/bitburner-scripts](https://github.com/UnderMyBed/bitburner-scripts), archived. It is a fork of [alainbryden/bitburner-scripts](https://github.com/alainbryden/bitburner-scripts). |
| Commit | `2705617f3908340ff8cb18fab38962e8caf6af84` (2026-10-24), "README: mark fork as archived and superseded by bitburner-agent" |
| License | MIT, © 2021 Alain Bryden: [`fork/LICENSE`](fork/LICENSE), kept with the files |
| Files | 55, each with its sha256 in [`manifest.json`](manifest.json) |

## Rules

- **Never edited in place.** The files stay exactly as recorded; `test/fork.test.ts` checks every file against the manifest. Git leaves their bytes alone: the root `.gitattributes` (and the fork's own) mark them `-text`.
- **A change is a patch.** If the baseline ever needs a file changed, the change goes in a separate patch file next to `fork/`, with the reason, and is applied when the files are written into a simulation. `fork/` itself doesn't change.
- **The fork's own `.gitignore` ignores `*.txt`**, so `fork/reserve.txt` was added with `git add -f`. It's tracked; the ignore rule only matters when adding files, which nobody should.

## How it was copied

```
git -C <bitburner-scripts clone> ls-tree -r --name-only 2705617f   # every file
git -C <bitburner-scripts clone> cat-file blob 2705617f:<file>     # its exact bytes
```

The manifest records each file's sha256 over those bytes.