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
| 0 | Baseline: legacy script audit against 3.0.1 ([`legacy/scripts-compat-audit.md`](legacy/scripts-compat-audit.md)); retire the legacy fork | ✅ |
| 1 | First-principles mechanics reference ([`mechanics/`](mechanics/)) and [`synthesis.md`](synthesis.md) | ✅ |
| 1b | Community research ([`research/`](research/)) | ✅ |
| — | Architecture ([`architecture.md`](architecture.md)) and decision records ([`decisions/`](decisions/)) | ✅ draft |
| S1, M1–M6 | Simulator spike, then build milestones; see architecture §13 | S1 passed; M1 next |

## Campaign start
The agent plays from the very first BitNode. The campaign starts on Steam with a **fresh save at BN1.1** as soon as M4 passes its simulator exit criteria. BN1.1 has no Singularity API, so it's played through the `ui` effector backend, which puts milestone M3 on the critical path. There is no manual phase.

## Legacy fork
[UnderMyBed/bitburner-scripts](https://github.com/UnderMyBed/bitburner-scripts) is retired: upstream fixes merged, then archived. It doesn't play the campaign. Its proven managers run under the agent as legacy reflexes, and the whole fork runs in the simulator as the baseline the planner must beat (architecture §12.3).
