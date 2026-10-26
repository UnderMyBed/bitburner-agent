# 0006 — Tech stack and compute strategy

- **Status:** Accepted (2026-10-24)

## Context
In-game code must be JavaScript. Out-of-game code can be anything. The question is whether the brain should use a high-performance language to make full use of the available hardware.

Reference machine (the owner's rig, which runs the game 24/7):
- Ryzen 7 9800X3D (8 cores / 16 threads, 96 MB L3)
- 64 GB DDR5
- RTX 5090 (32 GB, Blackwell)
- NVMe storage
- Windows 11 with WSL2 and Docker Desktop

Where the compute goes:
| Workload | Load | Language-bound? |
|---|---|---|
| Live control (planning tick every ~30 s) | Trivial | No |
| Simulator (thousands of seeded runs) | Heavy, CPU | No. It *is* the game's TypeScript engine, whatever the brain is written in. |
| Search/optimisation (rollouts, corp optimiser, Go search) | Potentially heavy | Yes |
| ML / local LLM | Heavy, GPU | Yes (Python/CUDA ecosystem) |

## Decision
**Polyglot by workload, with TypeScript at the core.**
- **TypeScript on Node** for the brain, bridge, simulator, dashboard and in-game code. That's one language across every boundary, and it lets us import the game's own formula code, so estimates are exact by construction.
- **Scale out, not up:**
  - The simulator runs as a **pool of worker processes**, one engine instance per process, each seeded.
  - Pool size defaults to `availableParallelism() − reserve`, where the reserve keeps cores free for the live game, the brain and the OS. On the reference rig that's about 12–14 workers. Size it by measurement.
- **A swappable fast model:** the planner's fast game model sits behind one pure interface, so rollouts can later move to native code or the GPU without changing callers.
- **Rust (napi-rs native addons)** only for hot spots that profiling proves are bottlenecks. Likely candidates: Go search, the corp optimiser, rollouts.
- **Python services on the GPU** (Phase 4) for ML and a local LLM supervisor. They run as local services behind an HTTP API, preferably in Docker with GPU passthrough. Python is managed with `uv`.
  - Blackwell requires CUDA 12.8+ builds of PyTorch and llama.cpp.
- **Heavy test suites run locally** on the reference rig through one command. CI uses GitHub-hosted runners for the fast tiers only.
  - **No self-hosted runner:** the repo is public, and fork PRs must never execute on the owner's machine.
- Bulk local data (simulator artifacts, telemetry, save backups) goes in a configurable data directory, by default on a non-system drive.
  - *Note, 2026-10-26:* the data directory is the repository's gitignored `.data/` by default, so nothing goes outside the repo (owner decision 30, [#122](https://github.com/UnderMyBed/bitburner-agent/issues/122)). `--data-dir` picks another. This replaces "on a non-system drive", and an earlier note saying the owner must pick one.

## Consequences
- No formula re-implementation, so no drift between the game and our model.
- Native code and Python enter only with evidence (a profile) or a Phase 4 decision. The stack stays single-language until then.
- Simulator throughput scales with cores. The 5090 stays idle until Phase 4 unless batched rollouts justify it earlier.
