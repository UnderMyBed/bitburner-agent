# Plan

## Goal
**Max every Source-File**: SF1–11 and SF13–15 at level 3, plus SF12 to a target (50 = the CHALLENGE_BN12 achievement). SF-1 (exploits) is excluded: it's worth ×1.011 and isn't required for the BN_DESTROYER achievement.

## Constraints
- **Fresh save**: start at BN1.1 with no Source-Files, so no Singularity API until SF4.
- **Platform**: Steam (Electron), Bitburner **v3.0.1** (VersionNumber 51), pinned at `vendor/bitburner-src`.
- **Rules of engagement**: see the README. In short, in-game API and page state only.

## Working model
- **The owner** designs the system and uses it: plays the Steam campaign with each release and brings back feedback and iteration requests.
- **The build process** (Claude) builds, tests, documents and releases. It works autonomously behind the merge gate in [`CONTRIBUTING.md`](../CONTRIBUTING.md).
- Each large session ends in a tagged release with notes on what changed, what to try, and known issues.

## Phases
| Phase | Content | Status |
|---|---|---|
| 0 | Baseline: legacy script audit against 3.0.1 ([`legacy/scripts-compat-audit.md`](legacy/scripts-compat-audit.md)); retire the legacy fork | ✅ audit; retirement in progress |
| 1 | First-principles mechanics reference ([`mechanics/`](mechanics/)) and [`synthesis.md`](synthesis.md) | ✅ |
| 1b | Community research ([`research/`](research/)) | ⏳ |
| — | Architecture ([`architecture.md`](architecture.md)) and decision records ([`decisions/`](decisions/)) | ✅ draft |
| M1–M6 | Build milestones, see architecture §13 | M1 next |

## Legacy baseline
The legacy fork ([UnderMyBed/bitburner-scripts](https://github.com/UnderMyBed/bitburner-scripts)) gets the upstream compatibility fixes merged and is then archived. It is only kept running long enough to play BN1.1 while M1–M4 are built. Its owner clicks the faction/aug/install actions by hand, since there's no Singularity API before SF4.
