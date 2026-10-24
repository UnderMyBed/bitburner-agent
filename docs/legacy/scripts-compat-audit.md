# bitburner-scripts vs. Bitburner 3.0.1: compatibility audit (Phase 0 baseline)

- **Scripts audited:** `bitburner-scripts` @ `main` = `c0dc5d7` (fork of alainbryden, last commit 2026-03-31)
- **Game source:** `vendor/bitburner-src` @ `1da7316ff` ("Fix stable version name"), `VersionString "3.0.1"`, `VersionNumber 51` (`src/Constants.ts:7,10`)
- **Method:** static analysis only. I diffed every `ns.*` reference (direct code and the string commands passed to `getNsDataThroughFile`/`runCommand`, including dynamically built names) against `src/ScriptEditor/NetscriptDefinitions.d.ts`. I also checked the 3.0.0/3.0.1 breaking-change lists (`src/utils/APIBreaks/3.0.0.ts`, `3.0.1.ts`, `src/Documentation/doc/en/changelog.md`) and the NS implementations under `src/NetscriptFunctions/` and `src/Netscript/`. **Nothing was run in-game.** Items marked *(verify)* need a runtime check.

---

## 1. Verdict

**Mostly usable on 3.0.1, but not as-is. Merge upstream first.**

- The API surface is in good shape. The scripts already target the v3 API (`ns.cloud.*`, `ns.ui.*Tail`, `hasTixApiAccess`, `FavorToDonateToFaction` and so on). Across the 236 distinct `ns.*` references plus all dynamically built ones, **only two names don't exist in 3.0.1**:
  - `ns.gang.getOtherGangInformation`, which crashes gangs.js
  - `ns.ui.time`, which is cosmetic
- 3.0.0 also changed behavior in ways that break **coding contracts** (stricter answer string-conversion, plus 2 new contract types). It made **TOR detection** stale (`darkweb` is no longer returned by `ns.scan`), and it raised **hacknet RAM costs**.
- Nothing I found statically crashes the **fresh BN1.1** path (autopilot → daemon → remote HGW scripts, no SF4).
- The **overall goal (max every SF) is blocked** in two places:
  1. **gangs.js crash-loops** in v3 (BN2 is 5th in the BN order). Upstream has already fixed this.
  2. **BN15 can't be completed.** It isn't in `defaultBnOrder`, there is no Dark Net (`ns.dnet`) code at all, and in BN15 The Red Pill is not sold by Daedalus: it comes from the darknet labyrinth. Autopilot's only path to finishing BN15 would be a Bladeburner win.
- **Upstream merge: recommended.** It has 3 relevant commits (gang API rename, two new 3.0 contract solvers, contract answers returned as arrays). `git merge-tree main upstream/main` returns a clean tree (exit 0, no conflicts).

---

## 2. Upstream status (`git fetch upstream`, then `git log main..upstream/main`)

Merge base: `e0f19b1` (2026-03-11, "Merge pull request #487 … fixes-to-work-on-3.0"). The fork has 33 commits on top of it. Upstream has 6 new commits on `main` (3 PRs):

| Commit | Date | What it does | Relevance |
|---|---|---|---|
| `e0fbed1` / merge `e1b6f68` (#491) | 2026-04-26 | `gangs.js:196,521` `getOtherGangInformation` → `getAllGangInformation`. `helpers.js` v2 back-compat adds `.replaceAll("getAllGangInformation","getOtherGangInformation")`. | **Fixes P0-1** |
| `cf1f6f6` / merge `7a8951a` (#496) | 2026-05-04 | Contract solver: adds **"Largest Rectangle in a Matrix"** and **"Total Number of Primes"** (new in 3.0.0). Exports `codingContractTypesMetadata`. | **Fixes P1-2** |
| `7a0dec0` / merge `40df649` (#490) | 2026-04-26 | Contract solver returns native arrays/numbers instead of strings: removes `convert2DArrayToString`, `ret.toString()` (Generate IP Addresses), `.toString()` on stock-trader answers, and `"[]"` for an odd-cycle 2-coloring. | **Fixes P1-1** (IP contract always wrong in v3) |

Diff size: `Tasks/contractor.js.solver.js` +122/−20, `gangs.js` ±2, `helpers.js` +1. The fork also touched `gangs.js` and `helpers.js`, but in other hunks, so the merge is clean.

Upstream has **no** work on Dark Net/BN15, corporations, infiltration, or sleeve memory/purchase. The other upstream branches are stale and not worth merging:
- `side-projects` (2022)
- `sleeves-bladeburner` (2022)
- `469-ignore-go-favor-boosts` (2025-07)
- `alainbryden-patch-1` and `355-…`: already merged, 0 commits ahead

**Recommendation:** `git merge upstream/main` (fast, conflict-free). Then apply the remaining fixes below.

---

## 3. NS API audit against 3.0.1

### 3.1 Coverage

**Namespaces referenced by scripts:**
- top-level `ns.*`
- `singularity`, `gang`, `bladeburner`, `sleeve`, `stanek`
- `go`, `go.analysis`, `go.cheat`
- `hacknet`, `stock`
- `formulas`, `formulas.hacking`, `formulas.hacknetServers`
- `cloud`, `codingcontract`, `ui`, `enums`, `heart`

**Namespaces never referenced:** `corporation`, `dnet`, `grafting`, `infiltration`, `format` (helpers.js has its own formatters).

**Dynamically built calls I resolved and checked:**
- bladeburner.js `getBBInfo/getBBDict` names (24 functions)
- gangs.js `getGangInfoDict` (`getEquipmentType/Cost/Stats`, `getTaskStats`, `getMemberInformation`, `getAscensionResult`)
- faction-manager.js `getSingularityDict` (`getAugmentationsFromFaction/RepReq/Price/Stats/Prereq`)
- stockmaster.js `getStockInfoDict`/`checkAccess`/`tryBuy` (`getMaxShares/AskPrice/BidPrice/Volatility/Forecast/Position`, `has*`, `purchase*`, `buy/sell*`)
- daemon.js `getServersDict` (`getServerRequiredHackingLevel/NumPortsRequired/Growth/MaxRam/MinSecurityLevel/MaxMoney`, `getServer`)
- contractor.js (`getContractType`, `getData`)

All of these exist in 3.0.1.

### 3.2 Removed or renamed functions still referenced

| Reference | Location | 3.0.1 status | Impact |
|---|---|---|---|
| `ns.gang.getOtherGangInformation()` | `gangs.js:196`, `gangs.js:521` | **Removed** (renamed to `getAllGangInformation`, #2635) | **P0.** `initialize()` → `onTerritoryTick` (`gangs.js:185`) → `enableOrDisableWarfare` (`:248`) → the temp script returns `ERROR: … is not a function` → `autoRetry` throws. `initialize` isn't wrapped in try/catch, so gangs.js dies on every launch. Autopilot relaunches it every ~10s (`autopilot.js:733-734`) and it crash-loops. |
| `ns.ui.time(...)` | `helpers.js:958` (`formatTime`) | **Never existed.** The v3 function is `ns.format.time`. | P2. Only reached from `go.js:1316,1333` under `--logtime` (off by default). |
| `ns.tFormat(...)` | `helpers.js:960` | Removed in 3.0 (moved to `ns.format.time`) | None. This is the v2 branch, unreachable on 3.0.1. Costs 0 RAM because unknown names are ignored by the RAM calculator. |

Every other referenced function exists with a compatible signature. Spot-checks:
- `hack/grow/weaken(host, {stock, additionalMsec})`
- `cloud.purchaseServer(name, ram)` (still dedupes names via `-N`)
- `stanek.placeFragment(x,y,rot,id)`
- `go.makeMove/passTurn/opponentNextTurn` returning `{type,x,y}`
- `go.resetBoardState(opponent, size)`
- `formulas.hacking.*(server, person)`
- `formulas.hacknetServers.hashGainRate(level, ramUsed, maxRam, cores, mult)`
- `sleeve.setToBladeburnerAction(i, action, contract)`
- `singularity.destroyW0r1dD43m0n(n, cb, {sourceFileOverrides: new Map()})`
- `bladeburner.getActionEstimatedSuccessChance` returning `[min,max]`

The extra 4th argument `{ returnReward: true }` passed to `codingcontract.attempt` (`Tasks/contractor.js.solver.js:44`) is ignored. `attempt()` now always returns the reward string, or `""` on failure.

### 3.3 Changed return shapes and behavior that matter

| Change (3.0.0 unless noted) | Script impact |
|---|---|
| **"darkweb" is now a darknet server and no longer appears in `ns.scan()`** (`APIBreaks/3.0.0.ts:535-543`) | `Tasks/tor-manager.js:12` uses `hasTor = () => ns.scan("home").includes("darkweb")`, which is now always false. `daemon.js:407` gates tor-manager on `!allHostNames.includes("darkweb")`, which is now always true. Result: tor-manager is spawned every 25s for the whole BN and calls `purchaseTor()` each time. That call is idempotent (returns true if TOR is already owned) but costs SF4-scaled RAM: 2 GB × 16 at SF4.1 = 32 GB temp. **Fix:** use `ns.hasTorRouter()` (0.05 GB, new top-level function). → **P1-3** |
| **Coding-contract string conversion made strict** (#2608, `APIBreaks/3.0.0.ts:585-626`; `src/CodingContract/ContractTypes.ts parseArrayString`) | `contractor.js.solver.js:303` returns `ret.toString()` for **Generate IP Addresses**, e.g. `"1.1.1.1,2.2.2.2"`. v3 parses this as `JSON.parse("[1.1.1.1,…]")`, which fails, so the answer is wrong. Every IP contract fails and burns tries, and the contract self-destructs. Merge Overlapping (`:276`), stock traders (`:315,325,341`) and 2-coloring `"[]"` (`:715`) still convert correctly, but upstream switches them all to native values anyway. → **P1-1** |
| **New contract types:** "Total Number of Primes" (#2116), "Largest Rectangle in a Matrix" (#2519) | No solver, so these contracts are skipped ("No solver available" warning) and their rewards are lost. → **P1-2** |
| **Hacknet namespace RAM:** each function now costs 0.5 GB instead of a flat 4 GB namespace cost (#2502, `RamCostGenerator.ts:99-121`) | `hacknet-upgrade-manager.js` references 14 hacknet functions, so ~7 GB of hacknet calls on top of the 1.6 GB base. That's roughly 9.5-10 GB, up from about 6.1 GB in v2 (the figure in the `daemon.js:370` comment). `spend-hacknet-hashes.js` references 10, so about 5 GB of hacknet calls. In **BN1.1 with an 8 GB home**, hacknet-upgrade-manager no longer fits on home, while `daemon.js:368-371` still gates it on `reqRam(min(64, reserved+6.1))`. Early hacknet investment stalls or misfires *(verify with `mem hacknet-upgrade-manager.js`)*. → **P1-4** |
| **`ns.getServer*`, `getHack/Grow/WeakenTime`, `hackAnalyze*` throw on non-"normal" servers** (hacknet or darknet) instead of returning defaults (`NetscriptHelpers.tsx:521-536 getNormalServer`) | `daemon.js:1037-1040` `getServersDict` runs `getServerRequiredHackingLevel/NumPortsRequired/Growth/MinSecurityLevel/MaxMoney` over `allHostNames`. Hacknet servers are filtered out by default (`daemon.js:2204-2205`), but with `-n` / `--use-hacknet-servers` they're included, and daemon startup throws. home and cloud servers are still `Server` instances, so they're fine. `analyze-hack.js:130` filters on `moneyMax > 0`, which also excludes hacknet servers. → **P1-5** (only with that flag) |
| **TIX API access no longer requires a WSE account.** `purchase4SMarketData` (the UI data, not the API) *does* require WSE (#2342). | `stockmaster.js:601-615` still buys a WSE account ($200m) before TIX, and `stockmaster.js:556-575` buys **4S Market Data (UI, $1b × mult)** before the 4S TIX API. Neither is needed by scripts. `ascend.js:133-137` does the same on every install. Wasted money, no breakage. → **P2-3** |
| `getCurrentWork()` and `sleeve.getTask()` tasks always carry a `nextCompletion` Promise (#2687) | Harmless. A Promise serialises to `{}` through `getNsDataThroughFile`, and no script uses `.completion`. |
| Fuzzy matching removed for crime, faction work, class, gym, job field, bladeburner, and stock enums (#2091) | **All literals checked are exact:**<br>- crimes: `crime.js:4`, `work-for-factions.js:619-637`, `sleeve.js:307,355`<br>- university/course: `work-for-factions.js:516-518,673,676`, `daemon.js:529-535` (via `ns.enums`), `sleeve.js:242-243,257,273`<br>- gym `trainStat.slice(0,3)` → `"str"`… (`sleeve.js:261`)<br>- faction work `security/field/hacking` (`sleeve.js:34`, `work-for-factions.js:1053` via enum)<br>- job fields `IT/Software/Security` (`work-for-factions.js:1177-1199`)<br>- BB types `Contracts/Operations/Black Operations/General`, BB general actions, sleeve BB actions (`sleeve.js:313-318`)<br>- gang tasks (`gangs.js:29-30,128,181,209`) match `src/Gang/data/tasks.ts`<br>- hash upgrades (`spend-hacknet-hashes.js:18-20`) match `HacknetServerHashUpgrade` |
| Nuke and port crackers return `false` instead of throwing | `Tasks/crack-host.js` wraps each call in try/catch and ignores the result. Fine. |
| Gang equipment renamed (Glock 18C → Malorian-3516 and so on) | Not hard-coded anywhere; gangs.js reads names from `getEquipmentNames()`. Fine. |
| `Player` lost `bitNodeN` / `playtimeSince*`; `Multipliers` gained `dnet_money` | No script reads the removed fields; they use `getResetInfo()`. `faction-manager.js:71-74 stat_multis` doesn't know `dnet_money` → **P2-5** (aug valuation ignores the new mult). |
| 3.0.1: `getServer` return type now `Server & {isOnline?}`; `dnet.getServerAuthDetails` → `getServerDetails` | No impact (no dnet code). |
| `sleeve.travel()` now cancels the current task | sleeve.js travels and then assigns a task in the same pass (`sleeve.js:252-261, 268-278`). Fine. |
| **New APIs that close CLAUDE.md "gaps":** `sleeve.purchaseSleeve()`, `sleeve.upgradeMemory(i, amt)`, `getSleeveCost()`, `getMemoryUpgradeCost()` (BN10 only, 4 GB each); `infiltration.getPossibleLocations/getInfiltration` (read-only); `hasTorRouter()` | Not used yet. The "Sleeve memory purchases — Blocked/no API" gap in `CLAUDE.md:118` is **no longer true** on 3.0.1. |

### 3.4 Enums, constants, and names I verified unchanged
- **Cities, locations, companies, factions:** all literals match the `NetscriptDefinitions.d.ts` enums (lines 9305-9507).
- **Server hostnames:** these all exist in `src/Server/data/servers.ts` / `SpecialServers.ts`:
  - `harakiri-sushi` (`daemon.js:100`, 16 GB, 0 ports)
  - `The-Cave`, `w0r1d_d43m0n` (`autopilot.js:408-419`)
  - stock↔server map (`daemon.js:2097-2101`, including `vitalife`)
  - `fulcrumassets`
- **Augmentation names:** none of the hard-coded aug-name literals mismatch `src/Augmentation/Enums.ts`.
- **Stock constants:** WSE $200m, TIX $5b, 4S $1b, 4S TIX $25b, commission $100k (`src/StockMarket/data/Constants.ts`) match the hard-coded values in `stockmaster.js:558-559,603-604` and `autopilot.js:1032`.
- **Company job tracks:** IT and Software requirements in `work-for-factions.js:45-60` match `src/Company/data/JobTracks.ts`.
- **Home RAM:** max 2^30 (`Tasks/ram-manager.js:3`) matches `ServerConstants.HomeComputerMaxRam`. Fresh home RAM is 8 GB (`PlayerObjectGeneralMethods.ts:70`).
- **Bladeburner skill name:** **mismatch.** `bladeburner.js:13` uses `"Evasive Systems"`, but the game's name is `"Evasive System"` (`d.ts:3390`). The cost tweak silently doesn't apply. → **P2-4**
- **RAM costs:** `getPlayer` 0.5, `getResetInfo` 1, `getServer` 2, singularity costs (SF4 ×16/×4/×1, ×1 in BN4) and `codingcontract.attempt` 10 are all unchanged from v2. `cloud.*` costs are as `host-manager.js` assumes (`purchaseServer` 2.25). The only regression is hacknet (above).

---

## 4. `helpers.js` `checkBackwardsCompatibility()` / `isV3()` vs. VersionNumber 51

- `isV3(ns)` (`helpers.js:952-954`) returns `ns.ui.getGameInfo().versionNumber >= 44`.
  - **On 3.0.1 (51) it returns true**, and `checkBackwardsCompatibility` (`:169-207`) returns the command unchanged. **This is correct.**
  - `versionNumber` was added to `getGameInfo()` in v3 (#2155), so on 2.x it's `undefined` and the function returns false. Correct.
  - From `git log` of `src/Constants.ts`: 2.8.1 = 43; 3.0.0dev went 43→49; 3.0.0 = 50; 3.0.1 = 51. Only the 3.0.0dev builds numbered 43 would be misdetected, which doesn't matter.
- **The v2 downgrade table lacks `getAllGangInformation → getOtherGangInformation`.** Upstream adds it. Only matters on v2.
- `formatTime` (`helpers.js:956-961`) uses `ns.ui.time` on v3, which is wrong (see 3.2). Use `ns.format.time`.
- The `ns.getPlayer()` property-stripping workaround (`:196-204`) only runs on the v2 path. Fine.
- **Related staleness:**
  - `tryGetBitNodeMultipliers_Custom` (`:657-661`) maps 2.x property names. Harmless.
  - **`getHardCodedBitNodeMultipliers` (`:675-735`) only has 14 columns.** For BN15 (and any BN ≥15) `values[bn-1]` is `undefined`, so every multiplier is `undefined`, which produces NaN/false comparisons in autopilot/daemon. This only applies before SF5 is owned, and the BN order gets SF5.1 third, so it's low risk. → **P2-6**. I spot-checked the BN4 column against `src/BitNode/BitNode.tsx` `case 4` and it matches.

---

## 5. `autopilot.js`: BitNode order and BN15

- `defaultBnOrder` (`autopilot.js:47-81`) contains 4.3, 1.2, 5.1, 1.3, 2.1, 10.1, 8.2, 13.1, 7.1, 9.1, 14.2, 2.3, 5.3, 11.3, 14.3, 13.3, 9.2, 9.3, 10.3, 6.3, 7.3, 8.3, 3.3, 12.9999. **There is no 15.x.**
- `nextRecommendedSf` (`:203`) is the first entry not yet reached, and `nextBn` falls back to it (`:205`). Once everything up to 3.3 is done, the order ends at 12.9999, so autopilot will **never route into BN15**. That leaves SF15.1-3 unobtainable without `--next-bn 15`.
- `bnStrategies` (`:87-96`) has no key 15, so BN15 gets the generic strategy.
- **If you're in BN15** (via `--next-bn 15` or manually):
  - The win check (`:405-438`) needs `w0r1d_d43m0n` under `The-Cave` (that only happens once The Red Pill is installed) or Bladeburner `Operation Daedalus` done.
  - In BN15 **Daedalus does not sell The Red Pill** (`src/Faction/FactionHelpers.tsx:204-207`). TRP is the reward of the BN15-only lab `et3rn4l_l4byr1nth`, which comes after Normal, Cruel, Merciless and Uber (`src/DarkNet/effects/labyrinth.ts:403-457`; the source comment calls it "the fourth lab"). There is zero `ns.dnet` code, so the hacking win is impossible.
  - Autopilot will still:
    1. reserve and liquidate to $100b to join Daedalus (`:310-399`), which is pointless in BN15
    2. never satisfy `install-for-augs: ["The Red Pill"]` (`:12`, `:917`)
    3. keep doing count-based installs forever
  - The only automated way out is the Bladeburner black-ops win. bladeburner.js runs if SF7 is owned and `BladeburnerRank != 0`; BN15 has `BladeburnerRank: 0.2` and `BladeburnerSkillCost: 3`, so it's slow.
  - If SF5 isn't owned, the hard-coded mults are `undefined` (§4).
- **SF3 (BN3, corporations):** BN3 is only reached at 3.3 near the end. BN3 is winnable by hacking (no corp needed), but with severe hack-income nerfs. No corp code exists. This is a performance gap, not a blocker.

---

## 6. Other hard-coded assumptions that are wrong or stale in 3.0.1

| Location | Assumption | Reality in 3.0.1 |
|---|---|---|
| `Tasks/tor-manager.js:12`, `daemon.js:407` | TOR is owned iff `scan("home")` includes `"darkweb"` | darkweb is a darknet server and never appears in `scan`. Use `ns.hasTorRouter()`. |
| `daemon.js:370` (comment and gate `+6.1`) | hacknet-upgrade-manager costs 6.1 GB | ~9.5-10 GB in v3 *(verify with `mem`)* |
| `helpers.js:682-733` | 14 BitNodes | 15 BitNodes |
| `autopilot.js:47-81` | 14 BNs to play (BN15 doesn't exist) | BN15 exists; SF15 has 3 levels |
| `autopilot.js:56,71` comments; `CLAUDE.md:118` | "Buying/upgrading sleeve memory has no API" | `ns.sleeve.purchaseSleeve()` and `upgradeMemory()` exist (BN10 only) |
| `stockmaster.js:601-615`, `ascend.js:133` | TIX needs WSE | TIX is independent of WSE |
| `stockmaster.js:566-571`, `ascend.js:136` | 4S UI data must be bought before the 4S TIX API | Not required; it just wastes $1b × mult |
| `bladeburner.js:13` | Skill named "Evasive Systems" | "Evasive System" |
| `faction-manager.js:71-74` | Full list of aug multipliers | Missing `dnet_money` |
| `Tasks/contractor.js.solver.js` | 28 contract types | 30 types; 3.0 adds "Total Number of Primes" and "Largest Rectangle in a Matrix" |

---

## 7. Prioritized fix list

### P0: crashes or blocks progress

P0 means it blocks progress toward "max every SF". None of these triggers in BN1.1 itself.

| # | File:line | Problem | Suggested fix |
|---|---|---|---|
| P0-1 | `gangs.js:196`, `gangs.js:521` (crash path `gangs.js:185` → `:248` → `:521`) | `ns.gang.getOtherGangInformation` was removed in 3.0, so gangs.js throws in `initialize()` and crash-loops under autopilot (`autopilot.js:733`). Gangs are dead in BN2 (5th in the order) and wherever SF2 is used. | **Merge upstream** (`e0fbed1`): rename to `getAllGangInformation`. The own-gang skip at `gangs.js:525` already exists. Also wrap `initialize()` in retry/try-catch so one bad call can't kill the manager. |
| P0-2 | `autopilot.js:47-81` (no 15.x), `:87-96` (no BN15 strategy), `:405-438` (win detection) | BN15/SF15 is unreachable and unwinnable. TRP isn't sold by Daedalus in BN15 (`FactionHelpers.tsx:204-207`); it comes from the BN15-only darknet lab `et3rn4l_l4byr1nth`, reached after the first 4 labs (`src/DarkNet/effects/labyrinth.ts:403-457`, `getLabAugReward`/`getCurrentLabName`). There is no `ns.dnet` automation. | New work (Phase 1+): (a) add `15.1/15.2/15.3` to `defaultBnOrder`; (b) add `bnStrategies[15]` that disables the Daedalus $100b reserve and TRP-install logic and launches a new `darknet.js`; (c) write `darknet.js` (`dnet.probe/authenticate/connectToSession/heartbleed/openCache/labradar/labreport`, self-propagating scripts) that reaches the labyrinth for TRP; (d) after TRP, the normal WD path works. Interim: a Bladeburner-win BN15 strategy if SF6/7 is owned. |

**BN1.1 fresh-start P0s: none found statically.** autopilot.js, daemon.js, Remote/*.js, crack-host.js, analyze-hack.js and helpers.js use only v3-valid APIs, with the BN1.1 code paths gated on SF4 or RAM. This still needs confirmation in-game (see §8).

### P1: wrong behavior or serious loss

| # | File:line | Problem | Suggested fix |
|---|---|---|---|
| P1-1 | `Tasks/contractor.js.solver.js:303` (also `:276`, `:315`, `:325`, `:341`, `:715`) | "Generate IP Addresses" returns `ret.toString()` (`"a,b"`, no quotes). v3's strict parser fails it, so every IP contract is answered wrongly and tries are burned. Coding contracts are a key early source of rep and money, especially pre-SF4. | **Merge upstream** `7a0dec0` (return native arrays and numbers). |
| P1-2 | `Tasks/contractor.js.solver.js` (array ends `:944`) | No solvers for "Total Number of Primes" or "Largest Rectangle in a Matrix" (new in 3.0.0), so those rewards are lost. | **Merge upstream** `cf1f6f6`. |
| P1-3 | `Tasks/tor-manager.js:12`, `daemon.js:407` | TOR detection via `scan("home").includes("darkweb")` is always false in v3. tor-manager respawns every 25s for the whole BN, costing 2-32 GB of temp RAM each time depending on SF4 level. | `tor-manager.js`: `const hasTor = () => ns.hasTorRouter();`. `daemon.js:407`: replace the `allHostNames` check with a cached `await getNsDataThroughFile(ns,'ns.hasTorRouter()')`, or check `ownedCracks`/a flag file. |
| P1-4 | `hacknet-upgrade-manager.js` (14 direct `ns.hacknet.*` refs), `spend-hacknet-hashes.js` (10 refs), `daemon.js:368-371` | v3 bills 0.5 GB per hacknet function, so the script grows from ~6.1 to ~9.5-10 GB. On an 8 GB BN1.1 home it can't run, but daemon still gates it at 6.1 GB. Early hacknet growth stalls *(verify with `mem`)*. | Ram-dodge the per-call functions through `getNsDataThroughFile`, or batch them into one temp script per pass. Alternatively add `ns.ramOverride()` and update the 6.1 GB gate to the measured value. |
| P1-5 | `daemon.js:1037-1040`, `:1056-1061`, `:1079-1080` with `-n` (`:2204-2205`) | With `--use-hacknet-servers`, `getServersDict` calls `getServerRequiredHackingLevel` and similar on hacknet servers, which now **throw**. Daemon startup fails. | In `getServersDict`, filter `allHostNames` to non-hacknet names, or guard per host (`try { … } catch { null }` inside the temp-script map). |
| P1-6 | `autopilot.js` BN routing (see P0-2), `autopilot.js:310-399` | Gives no warning when in BN15, and burns time and money reserving $100b for a useless Daedalus invite. | Short-term: if `resetInfo.currentNode == 15`, skip `checkOnDaedalusStatus`, log loudly that BN15 needs darknet/TRP-from-lab, and default `preferBladeburnerWin`. |
| P1-7 | `CLAUDE.md:110,116-122` and `autopilot.js:56,71` comments | Docs are wrong for 3.0.1: sleeve memory now has an API, `ns.infiltration` exists (read-only), BN15/Dark Net isn't listed as a gap, and the isV3 note doesn't mention 3.0.1 = 51. Wrong docs mislead future agents. | Update the "Known Gaps" table: add a row for Dark Net/BN15, mark sleeve purchase/memory as API-available (BN10 only), and note the `ns.infiltration` read-only API. |

### P2: cosmetic, performance, or minor waste

| # | File:line | Problem | Suggested fix |
|---|---|---|---|
| P2-1 | `helpers.js:958` | `ns.ui.time` doesn't exist, so `formatTime` throws on v3. Only reached through `go.js:1316,1333` with `--logtime`. | `return ns.format.time(milliseconds, milliPrecision);` |
| P2-2 | `helpers.js:960` | Dead v2 branch `ns.tFormat`. | Keep for v2, or drop v2 support. |
| P2-3 | `stockmaster.js:601-615`, `:566-571`; `ascend.js:133,136` | Buys an unnecessary WSE account ($200m) and 4S UI data ($1b × mult). | Skip `purchaseWseAccount` before `purchaseTixApi`. Drop the `purchase4SMarketData` (UI) step and buy only `purchase4SMarketDataTixApi`. Remove the 4S-data cost from the `totalCost` budgets at `stockmaster.js:561` and `autopilot.js:1032-1033`. |
| P2-4 | `bladeburner.js:13` | `"Evasive Systems"` should be `"Evasive System"`, so the priority tweak is ignored. | Fix the string. |
| P2-5 | `faction-manager.js:71-75` | `stat_multis` lacks `dnet_money`. | Add it if darknet becomes an income source. |
| P2-6 | `helpers.js:682-733` | Hard-coded BN mults table has no BN15 column, so values are `undefined` without SF5. | Add a 15th column from `BitNode.tsx case 15` (Hacking 0.6, HackingSpeed 0.6, combat 0.7, Cha 1.1, ServerMaxMoney 0.8, ServerStartingMoney 0.5, ServerStartingSecurity 1.5, AugMoneyCost 3, Corp 0.2/0.4/0.4, DaedalusAugs 20, BBRank 0.2, BBSkillCost 3, GangUniqueAugs 0.3, Stanek 0.7/−2, WD 2, rest 1). Default missing values to 1. |
| P2-7 | `autopilot.js:192` | `if (unlockedSFs[4] \|\| 0 == 3)` is an operator-precedence bug: it rethrows whenever any SF4 is owned. | `if ((unlockedSFs[4] \|\| 0) == 3)` |
| P2-8 | `git-pull.js:103` | Fallback listing uses undefined `f` (`name => … f.endsWith(ext)`), so it throws when the GitHub API rate limit is hit. | `ext => name.endsWith(ext)` |
| P2-9 | `sleeve.js:182` | `i < i` is always false (meant to exclude sleeves 0-3 from follow-player when in BB). | Intended `i < 4` / `i > 3` logic. |
| P2-10 | `work-for-factions.js:1183-1203` (fork addition) | On each promotion check it applies to "Security", measures, then re-applies to the hack role. That causes job churn and wasted ticks. | Only probe Security when combat stats exceed hack/cha requirements, and cache the result per company. |
| P2-11 | `daemon.js:376-377,409,426` | Hard-coded `minRamReq` / `reqRam` values (go.js 20.2, contractor 14.2, host-manager 6.55, 64 GB gates) weren't re-measured for v3. | Replace with `ns.getScriptRam` at startup (daemon already does this for tools at `:2402`). |

---

## 8. Not verifiable statically (verify in-game, BN1.1 fresh save)

1. `mem daemon.js`, `mem autopilot.js`, `mem hacknet-upgrade-manager.js`, `mem spend-hacknet-hashes.js`. Confirm that autopilot and daemon co-exist on an 8 GB home, and confirm the hacknet RAM jump (P1-4).
2. **casino.js** DOM automation. It relies on React-props `onClick({isTrusted:true})` (`casino.js:479-503`) and on XPaths for "Start", "Hit", "Stay", "Count:", "Iker Molina Casino", "Play blackjack". The labels still exist in `src/Casino/Blackjack.tsx` / `CasinoLocation.tsx`, and blackjack still checks `event.isTrusted`. BetInput was rewritten (#1694) but still uses `onChange(event.target.value)`. This probably works but needs a runtime test.
3. stats.js and stockmaster HUD hooks (`overview-extra-hook-0/1`). These still exist in `src/ui/React/CharacterOverview.tsx:160-170`.
4. daemon early-game targeting with the v3 3.0.1 `getServer` return shape (normal servers unchanged).
5. Whether daemon places `hacknet-upgrade-manager.js` on a non-home host when home is too small (P1-4 severity).

---

## 9. Recommended next steps

1. `git merge upstream/main` (clean): fixes P0-1, P1-1, P1-2.
2. Fix P1-3 (tor), P1-4 (hacknet RAM), P1-5, P2-1, P2-7 and P2-8: all small edits.
3. Run §8 checks on a fresh BN1.1 save.
4. Plan the Phase-1 features the goal needs:
   - Dark Net automation and a BN15 strategy (P0-2)
   - corporation automation (BN3 speed; not a hard blocker)
   - sleeve purchase/memory via the new API in BN10
   - add 15.x and corp-aware ordering to `defaultBnOrder`
