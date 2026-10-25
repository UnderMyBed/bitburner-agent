# 0011 — The simulator compares at checkpoints; full-length runs are occasional

- **Status:** Accepted (2026-10-25)
- **Amends:** [0007](0007-headless-engine-simulator.md) (what the simulator is used for), and the M1 and M4 exit criteria in [architecture §13](../architecture.md#13-milestones)

## Context
The simulator runs the real game, so it pays for the real game's work. Waiting costs nothing in virtual time, but computing costs what it would in a browser. Running the legacy fork's BN1 baseline showed what that means over a whole BitNode ([#33](https://github.com/UnderMyBed/bitburner-agent/issues/33), [#74](https://github.com/UnderMyBed/bitburner-agent/issues/74)). Seed 1, on the reference rig, after #73, #74 and #80:
- **The first 2 virtual hours:** 600–830× real time.
- **To about 14 virtual hours:** about 100×, held there by the fork's constant IPvGO play.
- **From about 15 virtual hours:** once the fork has the RAM, it runs tens of thousands of batch scripts (28,339 at 16 h), and the speed falls to single digits (7× at 16 h). Most of that is the game's own work per script on every cycle, which a browser at 1× has time for.

So the first 12 virtual hours cost about 6 real minutes per seed (54 minutes for 8 seeds, measured), and a full run to a destroy costs roughly 5–15 real hours per seed. The fixes found along the way (#73, #74, #80) were real defects. This cost isn't one: it's the price of fidelity, and an agent that ran as many scripts would pay it too.

ADR 0007 and §13 assumed full-length runs were cheap enough to repeat. M1 recorded the fork's time-to-destroy over 8 seeds on every release, and M4 gated on the agent destroying BN1 at least as fast as the fork, over N seeds.

## Decision
- **The simulator is for correctness and comparison at checkpoints.** It runs regression tests, scenario suites of minutes to hours of virtual time, calibration windows for the fast model (§4.3), and comparisons at fixed virtual times. Long-horizon search stays on the fast model, as before.
- **Baselines compare at checkpoints.** The fork baseline records its progress at **4, 8 and 12 virtual hours**, over seeds 1–8: money, hacking level, augmentations installed, and home RAM. That fits before the script explosion, at about 6 real minutes a seed.
- **Full-length runs are occasional measurements**, run when a question needs one (for example the first time the agent destroys BN1 in the simulator), not on every release. When one runs, its cost is stated up front, and it runs one seed at a time under the CLI's real-time limit.
- **The agent is designed with the cost in mind:** fewer, larger batch jobs rather than tens of thousands of small ones. That's cheaper in the real game too.

## Consequences
- **M1** records the fork baseline at checkpoints, not its time-to-destroy. The release check (`docs/releasing.md` step 2) takes about an hour on one core.
- **M4** compares the agent with the fork at the same checkpoints over the same seeds: the agent must be at least as far along at each. The agent must also destroy BN1 autonomously in the simulator at least once, as a measured full-length run, before the campaign starts on Steam.
- Comparisons can only rank strategies over the first half-day of a BitNode. Longer-horizon quality is judged by the fast model, by the occasional full-length run, and on Steam.
- The work that remains on simulator speed is overhead the simulator itself adds, where a profile shows any. The game's own work isn't ours to remove.
