# Community research: tooling, benchmarks, strategy priors, pitfalls

Research pass done 2026-10-24. Target is Steam v3.0.1, released 2026-05-17; v3.0.0 released 2026-05-01.

**Method.** Most of this comes from the GitHub API through `gh`: repo metadata, commit dates, issues and PRs. The rest comes from npm registry metadata, the Steam Web API, Steam discussions and the in-game docs, read from the local copy at `bitburner-src-stable/src/Documentation` and from `dev`.

**Citations.** Each claim carries a source and a date. **[STALE?]** marks anything written against a version older than v2.x/v3.x, or written before v3 changed the relevant mechanic.

**What this pass could not reach.** Reddit returned 403 to both the API and the fetcher, and Discord can't be read without an account. Those are the two places most community knowledge lives, so the benchmark coverage is thin.

---

## 0. TL;DR: decision-relevant findings

| # | Finding | Impact on our plan |
|---|---|---|
| 1 | **d0sboots/bitburner** has three useful pieces: `lib/formulas.js`, a RAM-free drop-in replacement for `ns.formulas` copied from source "as of f4c4b17 (2026-04-30)" and updated for 3.0; `hacksim.ts`, an event-driven HWGW simulator added 2026-10-14; and `stubcall.js`, a RAM-dodge helper. It is Apache-2.0, and the author is a core maintainer. | Reuse it for brain-side formulas and for unit-testing the batcher without booting the whole engine. Our full-engine simulator remains the source of truth. |
| 2 | **catloversg/bitburner-scripts** (MIT, last push 2025-08-29; the author is the lead maintainer) contains a complete corporation bot with an optimizer (`corporationOptimizer.ts`, Ceres.js, Alglib). It also has precalculated round options with actual offer numbers (see §3.3), an RFA WebSocket server (`remote.mjs`), and an Electron wrapper (`electron/main.mjs`) that loads the game with `backgroundThrottling:false`. | It's the best starting point for our "corp bot (NEW)". It already uses `ns.format.*` (the v3 API), but still needs a v3.0.1 compatibility pass. |
| 3 | **cyguin/bitburner-scripts** (MIT, created 2026-07, last push 2026-08-16) is a v3 fork of alainbryden. It adds a hands-off BN12 recursion loop, Stanek handling, BN13/BN14 notes, and a BN15 darknet worm with solvers for "all 21 server models" plus a BFS labyrinth solver. Its README cites BN12.335. | It overlaps our fork plan almost exactly. Diff it before writing the dnet bot or the BN12 loop. |
| 4 | **No usable external-brain framework exists.** The "AI plays Bitburner" repos are thin. `Scrattlebeard/bitburner-mcp` and `MeioNeiz/bitburner-autopilot` are RFA-to-MCP/HTTP relays. `chrispyroberts/bitburner-ai-api` is a planning-only fork. `Subzero121800/BitBurner-AI` is an Ollama loop. | No reusable brain exists. Our architecture (brain + RFA + in-game agent) matches what others converged on, and nobody has published results. |
| 5 | **No headless simulator project exists** in the community; searches for headless, simulator, puppeteer and playwright all came up empty. The closest is d0sboots' `hacksim.ts`, which covers hacking only. | Our engine-backed simulator is novel work. Budget for it accordingly. |
| 6 | **The RFA build tooling is fine to reuse, but don't build on it.** For deployment we only need about 150 lines of JSON-RPC over `ws`, as in `remote.mjs`. For bundling, `esbuild-bitburner-plugin` (MIT, commits 2026-04-21) is the most active and has plugin hooks that expose the RFA. | Write our own small RFA server (we need the control channel anyway) and use esbuild for bundles. Skip viteburner (no code commits since 2023-03) and typescript-template (last commit 2023-10). |
| 7 | **The Steam build accepts `--remote-debugging-port=9222`** as a launch option (CDP), according to the esbuild-bitburner-plugin README. | This is a powerful route for E2E tests and the UI driver, but it bears on open decision #2 (DevTools). Allow it for tests only. |
| 8 | **Unreleased `dev` changes will land in the next Steam patch:** the BN12 darknet Red Pill is **removed** (#3025), corp passive popularity decay is removed (#2932), `destroyW0r1dD43m0n` can go to the BitVerse (#2857), a new darknet "Thread of Ariadne" aug arrives (#2827), and `promoteStock` will need TIX (#2973). Steam allows reverting through "Game Versions and Betas". | Pin v3.0.1 through the Steam betas branch when the next patch ships, or plan for these changes. Any BN12 plan that uses the darknet Red Pill dies at the next patch. |
| 9 | **Practical benchmarks are scarce.** The best v3 data comes from **boycepoleonjr/bitburner**, a hacking-only automation built with Claude Code: BN4.1 took about 158 h, BN5.1 about 58 h to ready, and BN1.1 about 20 h in its agent-run stretch (start date unknown). Older anecdotes report a corp script beating BN1 in 1h20m (v2.2-era) and human-scripted BN2/BN3 runs of 2 to 3 days. | Use these as the bar to beat (§2). |
| 10 | **The Steam global achievement rates make a useful difficulty yardstick:** SF1.1 4.9%, FAST_BN (any BitNode in under 2 days) 2.4%, CHALLENGE_BN12 (BN12 level 50) 1.2%. | §2 |
| 11 | **Known v3.0.1 automation hazards:** a stale RAM cache for importing scripts (#2907, open), static-RAM false positives on identifiers that match NS names (by design), unbounded RFA bulk calls (#3061), recurring "Save data exists, but its type is invalid" corruption (#2809, open), the darknet memory leak (#2853, fixed in dev), and darknet server orphaning (#2740, open). | §5 |
| 12 | **Bladeburner can win BN15 (intentional)**, and SF15.1 makes the darknet Red Pill available in all BitNodes except BN8. In dev, BN12 is also excluded. | Strategy option for BN15 (§3.8). |
| 13 | **The community recommends BN1.2/1.3 before BN4,** because BN4's multipliers are "a bit harsh, especially if you only have SF1". | Challenges our draft order, which puts BN4×3 at step 2 (§3.1). |

---

## 1. Existing tooling

### 1.1 Build, sync and RFA tools

The RFA protocol is JSON-RPC 2.0 over WebSocket, with the **game acting as the client** and our tool as the server. Its methods are `pushFile`, `getFile`, `getFileMetadata`, `deleteFile`, `getFileNames`, `getAllFiles`, `getAllFileMetadata`, `calculateRam`, `getDefinitionFile`, `getSaveFile` and `getAllServers`. Sources: the local `remote_api.md` for v3.0.1, and the [dev remote_api.md](https://github.com/bitburner-official/bitburner-src/blob/dev/src/Documentation/doc/en/programming/remote_api.md) (2026-07-10, #2976).

| Tool | URL | Last code commit | v3? | License | What it'd save us | Verdict |
|---|---|---|---|---|---|---|
| esbuild-bitburner-plugin (+ bb-external-editor template) | https://github.com/shyguy1412/esbuild-bitburner-plugin, https://github.com/shyguy1412/bb-external-editor | 2026-04-21 (plugin; npm 1.7.9 on 2025-10-17); template 2025-07-04 | Protocol unchanged in v3, so it works | MIT | Bundling TS/JSX; folder-to-server mapping (`servers/<host>/...`); mirror and distribute modes; **extension hooks that receive the live RFA object** (`afterConnect(remoteAPI)`); remote debugging docs; uses the in-game React | **Best candidate for the bundling step.** We could even host our control channel as an extension, though a separate server is cleaner. |
| bitburner-filesync (official) | https://github.com/bitburner-official/bitburner-filesync | Repo 2026-07-08 (#38 `removeExportFromDeclarations`); **npm stuck at 1.2.0-beta4 (2023-08-29)** | Yes | Unlicense | Reference RFA server implementation; ws ping (2025-08) | Read it for reference, don't depend on it. Install from git if used. |
| typescript-template (official) | https://github.com/bitburner-official/typescript-template | 2023-10-21 | Works, but stale | none stated | tsc + filesync starter | Skip. |
| viteburner | https://github.com/Tanimodori/viteburner | Default branch 2023-03-14 (0.5.3); `pushed_at` 2026-10-23 is non-default-branch noise | Probably works (ficocelliguy used it through v3 dev) | MIT | Vite transform, RAM monitoring | Skip: the code is dormant. |
| BitburnerGoFilesync | https://github.com/CTNOriginals/BitburnerGoFilesync | 2026-07-01 | Yes (listed in v3 docs) | BSD-3 | Single binary; can download NetscriptDefinitions | Not needed. |
| bitburner-connect | https://github.com/HamishWHC/bitburner-connect (npm 0.2.2, 2026-06-25) | 2026-06 | Yes | MIT (npm) | Ships `bitburner-connect/types` (NS types as a package); glob server targets; pluggable builders | Possible source for a **types package** pinned to a version. |
| VS Code File Sync Plugin | https://github.com/ficocelliguy/bitburner-file-sync-plugin | 2026-08-28 (v0.1.7) | Yes (in dev docs) | Apache-2.0 | Editor convenience | Optional, for humans. |
| catloversg `remote.mjs` / `watch.mjs` | https://github.com/catloversg/bitburner-scripts | 2025-08-29 | Yes (uses `ns.format`) | MIT | A minimal RFA server using `ws`, a 3 s ping/terminate keepalive, and `getDefinitionFile` on connect | **Copy the pattern** for our bridge. |
| bitburner-bridge, bitburner-studio, sync-bitburner, bitburner-sync | npm | 2022–2026 | Mixed | Mixed | — | Nothing over the above. |

**NS type definitions.** No maintained versioned `@types`-style package exists. Everyone pulls `NetscriptDefinitions.d.ts` live through RFA `getDefinitionFile`, or copies `src/ScriptEditor/NetscriptDefinitions.d.ts` from source. bitburner-connect ships a copy (npm 2026-06-25). **Recommendation:** vendor the `.d.ts` from `bitburner-src-stable` at the v3.0.1 tag, and diff it against `getDefinitionFile` on every connect to detect drift. This is already in architecture.md §6.

### 1.2 RAM dodging

| Approach / lib | Source | Status |
|---|---|---|
| d0sboots `lib/stubcall.js` and `lib/stub.js`: exec a tiny stub that calls one NS function and returns the result through `globalThis` | https://github.com/d0sboots/bitburner (Apache-2.0, last commit 2026-10-14) | Maintained by a core dev. |
| d0sboots `lib/formulas.js`: a full `ns.formulas` replacement that costs 0 GB beyond `getResetInfo`; it includes BN multiplier tables for every BN/SF12 level and `MaxFavor` | Same repo; header says "current as of f4c4b17 (2026-04-30)", "Update formulas for 3.0" 2026-05-06 | **High value** for both in-game and brain use. |
| alainbryden `getNsDataThroughFile` (temp script that writes a file) | known | Already in our fork. |
| RamDodger3000 / ramdodger-extension (shyguy1412) | npm 2024-02 and 2024-06 | **GitHub repos are now 404**; treat as abandoned. |
| `ns.ramOverride()` (dynamic RAM) | in-game API | The native way. Note the cache bug #2907 (§5). |
| Static RAM calculator false positives | #2961 (2026-07-07) and #2855, closed as duplicates of #2801/#2758 | A **variable named like an NS function, such as `attempt`, is charged.** Bundlers and minifiers can create such names, so check every bundle with RFA `calculateRam`. |

### 1.3 "External brain", automation and AI frameworks (v3-era)

| Repo | Created → last push | What it is | Useful bits |
|---|---|---|---|
| [Scrattlebeard/bitburner-mcp](https://github.com/Scrattlebeard/bitburner-mcp) | 2026-01 → 2026-06-02 | An MCP server that wraps the RFA methods one-to-one, plus `scripts/v3/` darknet helpers | Confirms RFA is enough for an LLM to deploy code. No control channel. |
| [MeioNeiz/bitburner-autopilot](https://github.com/MeioNeiz/bitburner-autopilot) | 2026-05-07 | A Bun HTTP bridge (:3074) plus an in-game `bridge.js` that **polls** for commands (`eval`, `ns` call), with watchdog, supervisor (15 s reconcile), HWGW shotgun batcher with auto-tuner, and dnet daemons | Same shape as our D1/D2. Its in-game bridge uses HTTP polling, not WS. No license. |
| [chrispyroberts/bitburner-ai-api](https://github.com/chrispyroberts/bitburner-ai-api) | 2026-02-19 | A **fork of the game** that embeds an MCP server (planning docs only) | Not usable; modifying game code violates our rules. |
| [Subzero121800/BitBurner-AI](https://github.com/Subzero121800/BitBurner-AI) | 2026-05 → 2026-05-18 | An Ollama/Claude player with "guard-railed" self-modifying file surface | Anti-pattern reference only. |
| [boycepoleonjr/bitburner](https://github.com/boycepoleonjr/bitburner) | 2026-09-27 → 2026-10-22 | A Claude-Code-driven hacking-only autopilot with telemetry and **logged run history** | **The best v3 benchmark source** (§2). Also an all-SF roadmap PR #16 (2026-10-11), with estimated hours. |
| [cyguin/bitburner-scripts](https://github.com/cyguin/bitburner-scripts) | 2026-07-21 → 2026-08-16 | An alainbryden fork for v3: BN12 loop, BN15 worm, BN13/14 handling | See §4. |

### 1.4 Simulator, headless and debugging

| Item | Source | Notes |
|---|---|---|
| d0sboots `hacksim.ts` and `testsim.ts` | https://github.com/d0sboots/bitburner, 2026-10-14 | Min-heap event sim of H/G/W tasks and player level-ups; takes a Formulas instance (real or `lib/formulas.js`); assumes RAM is fine. Good for batcher regression tests. |
| d0sboots `RunInBackground.js` | Same repo | An AudioContext "hum" keeps a **browser tab** from being throttled. It also shows how to grab `WorkerScript` for RAM-free internal calls (rules question). Not needed on Steam (see §5). |
| d0sboots `benchmark_save.js` | Same repo | Hooks `React.createElement` to grab the internal save function. This is a useful pattern for an in-game "force save" without UI clicks. |
| catloversg `corporationTestingTools.ts` and `corporationFormulas.ts` | catloversg repo | Corp formula reimplementation and test harness. |
| Engine headless | — | No community project found. The upstream Jest suite, with the "save/load system tests" added in #3088 (2026-09-08), is the closest model for booting the engine in Node. |
| Electron flags (source, `electron/main.js`) | local v3.0.1 | `--no-scripts`, `--export-save`, `--dev` (DevTools). Dev adds a flag to disable Steam integration (#2958, 2026-07-07). |

---

## 2. Benchmarks

There is **no speedrun.com page**; the speedrun.com API returns an empty list for "bitburner" (checked 2026-10-24). No public leaderboard exists. Discord, which we couldn't read, is where any speedrun culture lives.

| Benchmark | Value | Version / date | Source |
|---|---|---|---|
| Hacking-only autopilot, **BN4.1** | About 6.6 days (158 h) from entry to destroy; 17 auto-installs; Red Pill at about 101 h; another ~57 h to reach hacking 9000 | v3, Sept–Oct 2026 | [boycepoleonjr PR #16 notes](https://github.com/boycepoleonjr/bitburner/pull/16) (2026-10-11) |
| Same project, **BN5.1** | About 58 h to "READY" (7.96 days to destroy, including 5.5 days waiting on a human); ~14.5 h bootstrap under 16× Singularity RAM | v3, 2026-10 | Same |
| Same project, **BN1.1** | About 20 h agent-run stretch, 4 manual installs (start unknown) | v3 | Same |
| Same project's estimates per run | BN1 1–2 d; BN4 3–5 d; BN5 1.5–2.5 d; BN2 <2 d with a gang; BN10 5–10 d; BN6/7 4–12 d via BB; BN13/BN9 1–2 weeks; BN12 L1 ~1.5 d | Estimates, not measurements | Same |
| Corp-script BN1, fully automated | **1 h 20 m** | ~v2.2 (Mar 2023) **[STALE?]** | Moderator Deicide, [Steam thread](https://steamcommunity.com/app/1812820/discussions/0/3783625016031272612) (2023-03-07) |
| BN9 with an infiltration script | **9 min**, fresh | ~v2.2 (2023) **[STALE?]**: infiltration was nerfed in v3 (#2210: stat requirements plus a 0–15% reward penalty per infil in the last 30 min) | Same thread |
| Human with own scripts, BN1 and BN2 | <2 days each; BN3 "a little over 3 days" (y0_lex: ~2 days, using gangs not corp) | v2.5 (Nov–Dec 2023) **[STALE?]** | [Steam thread](https://steamcommunity.com/app/1812820/discussions/0/3975051032846139530/) |
| BN12 at level 13 via Bladeburner | About 24 h per run | 2023 **[STALE?]** | Same |
| BN15 via Bladeburner while developing darknet scripts | Completed; author says the recursive node took "over 24 hours" per run even at INT 250+ | v3.0.x, 2026-06 | [#2859](https://github.com/bitburner-official/bitburner-src/issues/2859) |
| Deep BN12 recursion | README references **BN12.335** (WD requirement ~2.28M) for an autopilot-driven loop | v3, 2026-08 | [cyguin README](https://github.com/cyguin/bitburner-scripts) |
| "Speed demon" achievement | Destroy a BitNode in **<48 h** playtime (`playtimeSinceLastBitnode`) | Source | local `Achievements.ts` |
| Steam global achievement % (all players) | SF1.1 4.9; INSTALL_1 18.9; DAEDALUS 5.4; SF2.1 3.0; SF4.1/SF5.1 2.6; FAST_BN 2.4; SF3.1 2.3; SF6/9/10.1 2.0; SF7/8/11/12.1 1.7; INSTALL_100 1.8; SLEEVE_8 1.5; NEUROFLUX_255 1.5; INTELLIGENCE_255 1.5; CHALLENGE_BN1 1.4; CHALLENGE_BN2/6–13 1.2 (SF13–15 entries are not returned by the API) | Live, 2026-10-24 | `api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?gameid=1812820` |

**Suggested bars, our inference.** Per-node clear time under 48 h, which earns the FAST_BN achievement, is a "good" bar for easy and mid nodes. Beating boycepoleonjr's 158 h on BN4.1 and 58 h on BN5 by a wide margin is the minimum. "1h20m BN1 via corp" is the aspirational ceiling for an optimised late-campaign BN1 rerun.

---

## 3. Strategy priors

### 3.1 BitNode order

Primary source: the in-game "BitNode recommendation" guides, local `bitnode_recommendation_comprehensive_guide.md` and `..._short_guide.md`, current for v3.0.1 and maintained by the devs.

| Claim | Planner prior |
|---|---|
| "Doing BitNodes in chronological order is a classic mistake." Repeat BN1 first: L2 alone is "equivalent to 8 levels of NFG"; "most people complete this BitNode in one go and get SF1.3". | BN1×3 early. |
| BN4: "multipliers are a bit harsh, especially if you only have SF1. Keep this in mind if you choose it as the second BitNode." You must take it to 4.3, or else pay ×4/×16 RAM. | Our draft (BN1.1 → BN4×3) conflicts with this. Either do BN1.2–1.3 before BN4, or accept a slower BN4. The boycepoleonjr data (BN4.1 = 158 h with hacking only) supports doing BN1.2 first. Their roadmap independently ranks BN1.2 above BN4.2. |
| BN2: don't create the gang too soon in BN2 (income matters early); enable territory clashes "soon, but not too soon". | Gang gating rule. |
| BN3: "If you have a good corporation script, you can ignore all other mechanics and speedrun most BitNodes." | Corp is the speed engine once built. |
| BN6/7: Bladeburner is "rarely nerfed", so use it for BN9 and BN13. SF7.3 auto-grants Blade's Simulacrum, so accept Stanek first. | Matches synthesis. |
| BN10: "Most people complete this BitNode in one go to get 8 sleeves"; the last Covenant sleeve costs 100q, so you need a batcher or corp first. | Matches "visit BN10 when rich". |
| BN11: "harsh, rewards mediocre; only do it at the end". | Put BN11 late. |
| BN14: "even a slightly improved version of the tutorial script will help you complete this BitNode." | A cheap IPvGO bot is enough; don't over-invest. |
| BN15: you *can* finish it "with a simple script that only solves a few basic puzzle types", but it is much slower. SF15.1 allows the darknet Red Pill in every BitNode except BN8. | Darknet is a universal alternative Red Pill route after SF15.1. Dev #3025 also removes it in BN12. |
| BN12: "Thinking outside the box and exploiting oversights in the interaction of mechanics are the keys". Do it after unlocking everything. | Matches the draft. |

### 3.2 Batcher designs (community taxonomy)

Sources: dev `hackingalgorithms.md` (updated 2026-10-04, #3132) and the [DarkTechnomancer batching guide](https://darktechnomancer.github.io/) (repo created 2023-05, last edit 2025-07). The guide self-flags its "collision wall" and "stalefish" sections as outdated because they predate `additionalMsec` and `nextWrite`.

| Design | Community numbers / advice |
|---|---|
| Proto-batcher (one batch at a time) | Starter only. |
| Shotgun (fill RAM with batches, aligned by `additionalMsec`) | "Limit the number of parallel batches to around **100 000**", or the game soft-crashes into a "black screen" (official doc, 2026). |
| Periodic / continuous | Depth ≈ `weakenTime / (4 × spacer)`. Timing ratios are weaken = 4× hack and grow = 3.2× hack. |
| JIT | Leave **5–50 ms** between batch steps (official doc). The guide targets a 5 ms gap (10–20 ms on slow machines) with landings within 1–2 ms. Workers adapt their delay to drift. |
| Greed / targets | The guide suggests about 80% greed at first, then loot the top 10–20 servers at ~50% per batch. Target servers whose required level is at most half yours, scored by maxMoney / minSec. Keep each task on one host; don't split threads. |
| Timing reliability | `additionalMsec` is only as precise as `setTimeout`; there are no guarantees ([#3109](https://github.com/bitburner-official/bitburner-src/issues/3109), closed 2026-09-16). Design for slip. |
| Grow padding | About 10% grow-thread padding when money drifts (Reddit, 2025-03, via search snippet). |

### 3.3 Corporation: round-by-round with numbers

Sources: in-game corp docs (local `advanced/corporation/*.md`, written by catloversg, current) and **catloversg `src/corporation.ts`** (2025-08-29, v3 API).

| Round | Setup (docs + script) | Wait-for / accept threshold (script) |
|---|---|---|
| 1 | Agriculture in 6 cities with 6 warehouses. Office 3→4 (script OPTION2 = 4). All 4 staff on R&D until **RP ≥ 55**, then Ops/Eng/Bus/Mgmt 1/1/1/1. Smart Storage and warehouse upgrades, 2 Advert levels. Boost materials at the optimal ratio (0.86 of free space for OPTION2), bought per second rather than in bulk. Build your own Smart Supply instead of paying 25b. | `waitForOffer(…, 490e9)`. Comments record the precalculated outcomes: OPTION1–4 offers of **487.5e9–557.1e9**, about 1,441–1,649 s. |
| 2 | Buy Export (20e9). Agriculture office 8 (3-1-1-3), Advert to ~8. Chemical division as minimal support with 1 warehouse upgrade. Focus Smart Storage, Smart Factories and the Agriculture warehouse. **Wait for RP**: docs say 700/390 (Agri/Chem); script options range from 302/148 to 903/516. | Accept at **≥ 11e12**; precalculated options give **10.9e12–15.3e12**. |
| 3 | Tobacco product division; export Plants to Tobacco first (exports are FIFO). Max 1 product before accepting. Wilson then Advert (≥20% of funds). Market-TA2 once ~150e3 RP is banked (it costs 75e3). 1 main and 5 support offices. Tea and party every cycle. Dummy divisions raise the offer. | Accept at **≥ 1e16** (script). |
| 4 | Max 2 products before accepting. | Accept at **≥ 1e20** (script). |
| After | `thresholdOfFocusingOnAdvert = 1e18`. Tobacco "endgame" is around **1e98/s** profit (docs). | — |
| Notes | Take all 4 rounds (FAQ). Bribery is unlocked at valuation ≥ 100e12, at 1e9 per rep point. Outside BN3 a corp needs 150b (self-funded); selling the CEO position leaves 50b for the next one. Dev #2932 (unreleased) removes passive popularity decay. | — |

**Community counterpoint.** In 2023, players said gangs beat corp in BN3 because the corp is slow to set up. Moderators said a well-scripted corp wins. [Steam thread](https://steamcommunity.com/app/1812820/discussions/0/3975051032846139530/), 2023 **[STALE?]**.

### 3.4 Early-game openers

| Opener | Source / status |
|---|---|
| Casino coin-flip/roulette for $10B per install cycle | Common practice ([Steam 2023](https://steamcommunity.com/app/1812820/discussions/0/3783625016031272612) **[STALE?]**). Also used by SCHWARM (2026-09: "casino once per augmentation cycle", reloads the game on loss), alainbryden `casino.js`, megaburn "Rouletteburn", and d0sboots `roulette.js`/`coinflip.js`. **Pitfall:** alainbryden casino.js takes 9 h when the browser tab is unfocused ([#457](https://github.com/alainbryden/bitburner-scripts/issues/457), 2025-02). |
| Infiltration for money and rep | Nerfed in v3.0.0 ([PR #2210](https://github.com/bitburner-official/bitburner-src/pull/2210), merged 2025-07-20): stat requirements added, and each infiltration in the last 30 min cuts later rewards by 0–15%. **2023-era "infiltrate to win" strategies are stale.** |
| Home RAM before cloud servers | boycepoleonjr lost hours in BN5 when "cash went to idle pserv upgrades" instead of home RAM (2026-10). |

### 3.5 Gang

| Prior | Source |
|---|---|
| Ascend when the primary-stat multiplier gain is >1.05×, with members spaced 0.05 apart; train 5% of the time; at least 10 training ticks after ascend or recruit | alainbryden `gangs.js` args (we have this) |
| Territory warfare power ticks about every 20 s. Switch members to Warfare only around ticks; enable clashes only once win chance is high. Clashes kill members even when you win. | r/Bitburner (2024-04-16, via search snippet); in-game `gang.md` |
| Combat gangs need high Hacking, not Agility, for top crimes (open balance issue) | [#2906](https://github.com/bitburner-official/bitburner-src/issues/2906) (2026-06-20) |
| v3 rename: `getOtherGangInformation` → `getAllGangInformation` (#2635); creating a gang now **cancels** faction work (#2726, 3.0.1) | changelog |

### 3.6 Bladeburner

| Prior | Source |
|---|---|
| Pick the best action with min success ≥ 0.99. Run Stealth Retirement when chaos ≥ 50, Diplomacy when chaos > 100 everywhere. Stamina hysteresis 50%/60%. Reserve 200 ops for chaos/pop. | alainbryden `bladeburner.js` (we have this) |
| Sleeves on "Infiltrate Synthoids" generate contracts and ops (the main time-gate). Sleeve BB training drains the **player's** stamina (open). | dev `bladeburners.md`; [#3134](https://github.com/bitburner-official/bitburner-src/issues/3134) (2026-10-03) |
| Failed BB actions no longer cost reputation (3.0.1 #2768). `getActionRepGain` semantics changed in v3 (#2186). | changelog |
| BB win is intentionally allowed in BN15 ("mults pretty bad… an option if you really don't like the darknet", ficocelliguy) | [#2859](https://github.com/bitburner-official/bitburner-src/issues/2859) (2026-06-07) |

### 3.7 IPvGO

| Prior | Source |
|---|---|
| A prioritised move list beats most factions: capture (opponent network at 1 liberty), defend (avoid leaving self-atari), smother, expand, encircle. Then look for eyes (two separate inner empty points make a network unkillable) and skip-a-point or knight's-move jumps on big boards. Each faction has fixed habits; for example, The Black Hand always captures if possible. | local `programming/go_algorithms.md` (dev-maintained) |
| "Ipfish" (stockfish-like engine) in progress | [paulcdejean/megaburn](https://github.com/paulcdejean/megaburn) (MIT, 2026-05-30) |
| Rust Go engine (wasm?) | [G4mingJon4s/bitburner-ipvgo-rust](https://github.com/G4mingJon4s/bitburner-ipvgo-rust) (2025-03); the author also wrote the v3 `ns.format` refactor |
| v3.0.0 rebalanced favour from wins (#2131) | changelog |

### 3.8 Darknet / BN15 (very new; little community material)

| Item | Source |
|---|---|
| **The designer's own worm:** `dn_core.js` (597 lines: probe → reuse known password → `serverSolver` → spread), plus `dn_phish.js` (loop `phishingAttack` + `openCache`), `dn_stasis.js`, and `labTest.js` (random-walk labyrinth with `setStasisLink`) | [ficocelliguy/BitburnerScripts](https://github.com/ficocelliguy/BitburnerScripts) (MIT; dnet scripts updated 2026-05-24; repo pushed 2026-10-23). ficocelliguy designed both darknet and IPvGO. |
| A worm with solvers for "all 21 server models", with notes: AccountsManager binary search with persisted lo/hi, NIL positional feedback, heartbleed clue extraction, buffer overflow, factorisation, CRT modulo, three-phase hill climbing. Worm cut to 25 KB / 6.5 GB so it fits on **16 GB depth 0–5 servers**. Interactive solvers take 5–10 s per server. **Exec needs direct adjacency at the moment `exec` fires**, though SCP works at any distance with a session. At high game speed, mutation outruns authentication. Rare `DarknetState` save corruption is fixed only by an aug install. Labyrinth servers may need more charisma. | [cyguin README](https://github.com/cyguin/bitburner-scripts) (2026-08). The author says reliability at scale is untested. |
| Red Pill sits in the EternalLab at depth ~29 and needs charisma ≥ 3,000 | boycepoleonjr roadmap notes (2026-10), read from v3 source |
| `dnet.authenticate()` suppressed random log noise; fixed in dev (#3037) | [#3030](https://github.com/bitburner-official/bitburner-src/issues/3030) (2026-08) |
| Unreleased dev changes: bonus lab grows with completions, plus a new repeatable "Thread of Ariadne" aug (+1% all stats, additive) (#2827, 2026-10-18); `formulas.dnet.getExpectedMigrationCharge` (#3146); lab depth and migration progress exposed (#3034); INT no longer slows authentication (#2982); SF15.2 auth bonus fixed (#3059); **no Red Pill from the darknet in BN12** (#3025) | dev commits |
| Other v3 dnet repos worth skimming: SphyxOS (bundle, darknet fixes 2026-09), Mark-Broadhurst `Darknet/crawler.ts`, SalarymanDev `src/darknet/pwn.ts`, charlesgael `src/lib/dnet/auth.ts`, KaoSDlanor `src/lib/darknet.ts` | GitHub code search, 2026-10-24 |

---

## 4. Notable automation repos (beyond alainbryden)

| Repo | License | Activity | Coverage | Does better / note |
|---|---|---|---|---|
| [cyguin/bitburner-scripts](https://github.com/cyguin/bitburner-scripts) | MIT | 2026-07 → 08 | alainbryden fork plus BN12 recursion loop, Stanek accept-first, BN13/14 notes, BN15 worm and labyrinth | The **closest thing to "all BitNodes automated" on v3**. Lessons: in BN12, an empty aug queue should mean "rejoin" (the loop used to stall); sleeves should use `--training-reserve 0` in BN12. |
| [Here0001/Bitburner-Scripte](https://github.com/Here0001/Bitburner-Scripte) "SCHWARM" | NOASSERTION (custom) | 2026-09-25 → 09-29 | Hacking, money, augs, gang, corp, BB, stocks, darknet, IPvGO, Stanek; ends a BitNode only with explicit permission; casino with reload-on-loss | Broad v3 coverage and CI checks. Brand-new and unproven. |
| [Sphyxis/SphyxOS](https://github.com/Sphyxis/SphyxOS) | none | 2026-04 → 2026-10-15 | "All-in-one dashboard with a script for every game mechanic" (distributed as a JSON bundle) | Used by real players into BN13.3 (#2853 save). Its darknet use surfaced the memory leak. Code is bundled, so harder to read. |
| [ame824/autoDoIt](https://github.com/ame824/autoDoIt) | Custom (all rights reserved; personal use and forks with attribution allowed) | 2026-07 → 09 | "Modular full automation for v3, early game through BitNode progression"; separate <16 GB starter | **License blocks reuse**; read only for ideas. |
| [catloversg/bitburner-scripts](https://github.com/catloversg/bitburner-scripts) | MIT | 2025-08 | Corp (optimizer), daemon, batch controllers, stock trader with history recorder, casino, contracts, custom HUD | The best corp code available (§3.3). |
| [d0sboots/bitburner](https://github.com/d0sboots/bitburner) | Apache-2.0 | 2026-10-14 | Formulas, hacksim, stubcall, stocker, contracts, casino | §1. |
| [ficocelliguy/BitburnerScripts](https://github.com/ficocelliguy/BitburnerScripts) | MIT | 2026-10-23 | Darknet reference worm, Go, hack manager, infiltrate | §3.8. |
| [paulcdejean/megaburn](https://github.com/paulcdejean/megaburn) | MIT | 2026-05-30 | Roulette cheat UI, quick HWGW, "Ipfish" Go engine, `crashdark` dnet | Go engine idea. |
| [skeesler/bitburner-commander](https://github.com/skeesler/bitburner-commander) | Unlicense | 2026-10-10 | v3 HWGW rig with reactive fallback | Small. |
| [Snarling/bitburner-scripts](https://github.com/Snarling/bitburner-scripts) | GPL-3.0 | 2026-10-06 | Snarling is a dev; "pending major rewrites" | Mostly WIP. |
| [kamukrass/Bitburner](https://github.com/kamukrass/Bitburner), [chrisrabe/bitburner-automation](https://github.com/chrisrabe/bitburner-automation), [Jrpl/Bitburner-Scripts](https://github.com/Jrpl/Bitburner-Scripts) | various | 2024 | Popular v2 suites | **[STALE?]** for v3 (API breaks). |

None of these publishes completion times or claims to automate all of SF1–15×3.

---

## 5. Pitfalls

### 5.1 Steam / Electron

| Pitfall | Source |
|---|---|
| The Steam build disables background throttling (`backgroundThrottling:false`), so minimising the window doesn't slow it. **The browser build throttles unfocused tabs**: casino.js went from minutes to 9 h ([alainbryden #457](https://github.com/alainbryden/bitburner-scripts/issues/457)). Any browser or headless-browser run needs `--disable-background-timer-throttling` or the d0sboots audio hack. | local `electron/gameWindow.js`; d0sboots `RunInBackground.js` |
| Rolling back is supported: Steam → Properties → **"Game Versions and Betas"** (3.0.0 news). A `previous_release` branch existed at the 3.0.0 launch. | [Steam news](https://steamcommunity.com/app/1812820/allnews/) (2026-05-01/02); [#2719](https://github.com/bitburner-official/bitburner-src/issues/2719) |
| Linux: the native v3.0.0 build would not launch (fixed with launcher options); Electron UI slowdowns on SteamOS (fix: use a specific Proton/compat tool) | #2719 (2026-05-02); [#2912](https://github.com/bitburner-official/bitburner-src/issues/2912) (2026-06, open) |
| "Save data exists, but its type is invalid" after crashes or reboots; still recurring on 3.0.1 despite the #2755 hardening. The recovery screen auto-exports a save. **Keep our own `getSaveFile` backups.** | [#2809](https://github.com/bitburner-official/bitburner-src/issues/2809) (open), #3125, #3067, #2996 |
| A script can silently brick the save, for example by overriding `JSON.stringify`, or through `__proto__` misuse. Never monkey-patch globals in the agent. | [#2735](https://github.com/bitburner-official/bitburner-src/issues/2735) (2026-05-06) |
| Long synchronous loops hang the game; one example is a solver that hit about 1000 contracts without a sleep. Add `await ns.sleep(0)` yields. | [#2821](https://github.com/bitburner-official/bitburner-src/issues/2821) (2026-05) |
| CDP: Steam launch option `--remote-debugging-port=9222` (and Chrome for web) | esbuild-bitburner-plugin README (2026) |

### 5.2 RFA / bridge

| Pitfall | Source |
|---|---|
| The **game is the WS client.** Sleep or hibernate drops the connection; antivirus or ad-blockers can block it. Auto-reconnect exists via the `RemoteFileApiReconnectionDelay` setting (0 disables it), and there's an "auto-connect on start" setting. | `remote_api.md`; local `Remote.ts` |
| `getAllFiles` and other bulk methods have **no paging or limit**, and unknown params are silently ignored. | [#3061](https://github.com/bitburner-official/bitburner-src/issues/3061) (closed 2026-08-29, won't change) |
| The "Connect" button doesn't disconnect; reworked in dev (#3050) | [#3018](https://github.com/bitburner-official/bitburner-src/issues/3018) |
| RFA metadata will gain file size (dev #3065); message types tightened (dev #2976) | dev commits |
| The old Electron HTTP "API server" was **removed in v3.0.0** (#2084). RFA is the only external channel. | changelog |

### 5.3 RAM / script engine

| Pitfall | Source |
|---|---|
| **Stale RAM cache:** editing an *imported* module doesn't refresh the importer's cached RAM, so `run` fails with "insufficient dynamic RAM". After pushing a lib, re-push or touch every entry script that imports it, and re-check with `calculateRam`. | [#2907](https://github.com/bitburner-official/bitburner-src/issues/2907) (open, 2026-06-22) |
| Static RAM charges identifiers that match NS names (by design); angle-bracket casts were miscounted (fixed in 3.0.1) | #2961, #2855, #2750 |
| Killing a script parked on `nextWrite()` doesn't stop it until its next NS call (by design). `nextWrite` promises are shared and mutable. | [#2728](https://github.com/bitburner-official/bitburner-src/issues/2728), [#3161](https://github.com/bitburner-official/bitburner-src/issues/3161) |
| Price-string parsing used `eval` and leaked memory (fixed in dev #2826); moduleCache weakRef removed (#2843) | dev commits |
| Darknet memory leak with heavy dnet scripting (SphyxOS) | [#2853](https://github.com/bitburner-official/bitburner-src/issues/2853), fixed 2026-06-06 (dev) |

### 5.4 v2 → v3 migration (what breaks old community code)

Source: [v3.0.0 changelog](https://github.com/bitburner-official/bitburner-src/releases) and [#2148](https://github.com/bitburner-official/bitburner-src/issues/2148). The game writes `APIBreakInfo-3.0.0.txt` to home.

- `darkweb` is now a darknet server and is gone from `ns.scan`; discover it via `ns.dnet.probe()`.
- Formatting moved to `ns.format.*`.
- Purchased servers moved to `ns.cloud.*`; names are used as provided.
- Stock APIs were renamed; TIX access no longer depends on the WSE account.
- `nuke` and the port crackers return false instead of throwing.
- Fuzzy param matching was removed.
- Tail APIs moved to `ns.ui`.
- Hacknet RAM is charged per function.
- `getOtherGangInformation` became `getAllGangInformation`.
- `setAutoJobAssignment` became `setJobAssignment`.
- The Spring Water industry was removed.
- NS1 was removed.
- The `nextCompletion` promises were standardised.
- 3.0.1 changed the `getServer` return type and renamed `getServerAuthDetails`.
- **Planned for v4:** `Division.type` becomes `Division.industry` ([#2927](https://github.com/bitburner-official/bitburner-src/issues/2927)).

### 5.5 Version drift (unreleased in `dev` since 3.0.1, as of 2026-10-18)

Gameplay-relevant changes:

| PR | Change |
|---|---|
| #3025 | No darknet Red Pill in BN12 |
| #2827 | Bonus lab / new aug |
| #2932 | Corp popularity decay removed |
| #2973 | `promoteStock` needs TIX |
| #2857 / #2871 | `destroyW0r1dD43m0n` can go to the BitVerse; it now validates BN options early |
| #2978 | Home ports close on prestige |
| #2995 | `scan-analyze -a` less powerful |
| #2986 | `singularity.exportGameBonus` renamed |
| #3089 / #3095 | `BladeburnerCurAction` and `SleeveBladeburnerTask` type changes |
| #2968 | Stock market reset fix |
| #3094 | Grafting crash fix |

The full list is in `gh api repos/bitburner-official/bitburner-src/commits?sha=dev&since=2026-05-17`. **Recommendation:** pin Steam to 3.0.1 through the betas branch once the next version ships, and keep our `.d.ts` drift check.

---

## 6. Where the community lives

| Venue | URL | Freshness | Notes |
|---|---|---|---|
| **Official Discord** (main hub; devs answer there; channels such as #external-editors) | https://discord.gg/TFc3hKD | Active (devs cite Discord threads in 2026 PRs) | Not readable without an account. Most strategy, corp numbers and speedrun talk live here. **Worth a human joining** to ask about benchmarks. |
| GitHub issues (bitburner-src) | https://github.com/bitburner-official/bitburner-src/issues | Very active (≈150 issues since 2026-05-01) | GitHub Discussions are **disabled**. |
| In-game docs (source of truth; strategy guides for corp, BN order, batching, Go, darknet) | `src/Documentation/doc/en/**` in the repo; the in-game Documentation tab | Current: dev updated 2026-10 | The corp docs and the BN guide are written by maintainers. |
| API markdown | https://github.com/bitburner-official/bitburner-src/tree/dev/markdown | Current | — |
| Web build (dev branch) | https://bitburner-official.github.io/ (stable); `/bitburner-src/` (dev) | Current | — |
| readthedocs (bitburner.readthedocs.io, bitburner-fork-oddiz…) | — | **[STALE]**: abandoned; `.readthedocs.yaml` deleted 2026-08-31 (#3073). Content is v1.x/v2.x. | Ignore. |
| r/Bitburner | https://www.reddit.com/r/Bitburner/ | Active (search snippets show 2024–2025 posts) | Blocked from this environment. |
| Steam discussions | https://steamcommunity.com/app/1812820/discussions/ | Moderately active; most useful threads date from 2023 | Moderator Deicide is an experienced source. |
| Steam news | https://steamcommunity.com/app/1812820/allnews/ | Last post 2026-05-16 (3.0.1) | — |
| Key people | catloversg (corp docs, lead maintainer), d0sboots (core; formulas and sim), ficocelliguy (darknet and IPvGO designer), Snarling, gmcew | — | Their personal repos are the highest-signal code. |
