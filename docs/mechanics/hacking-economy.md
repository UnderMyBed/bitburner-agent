# Hacking & Money Economy — Mechanics Reference (Bitburner v3.0.1)

Source of truth: `vendor/bitburner-src` (`src/Constants.ts:7` → `VersionString: "3.0.1"`). All `file:line` citations are relative to that repo. "3.0.2" notes come from the dev branch `bitburner-src` and are flagged explicitly.

Conventions: `sec` = server `hackDifficulty` (security), `minSec` = `minDifficulty`, `req` = `requiredHackingSkill`, `hack` = player hacking skill, `M` = `moneyMax`, `BN.X` = `currentNodeMults.X` (BitNode multiplier), `p.mults.X` = player multiplier (augs/SFs). `intBonus(w) = 1 + w·int^0.8/600` (`src/PersonObjects/formulas/intelligence.ts:1-3`).

---

## 1. Hack / Grow / Weaken formulas

### 1.1 Core formulas (`src/Hacking.ts`)

| Quantity | Formula | Cite |
|---|---|---|
| Hack chance | `0` if no root or `sec ≥ 100`; else `clamp( (S−req)/S · (100−sec)/100 · p.mults.hacking_chance · intBonus(1), 0, 1)` with `S = max(1.75·hack, 1)` | `Hacking.ts:9-24` |
| Hack fraction **per thread** | `0` if `sec ≥ 100`; else `clamp( (100−sec)/100 · (hack−(req−1))/hack · p.mults.hacking_money · BN.ScriptHackMoney / 240, 0, 1)` | `Hacking.ts:44-57` |
| Hack/grow/weaken XP per thread | `(3 + 0.3·baseDifficulty) · p.mults.hacking_exp · BN.HackExpGain` (`baseDifficulty` = server's *starting* security after BN mult; 0 → no XP) | `Hacking.ts:30-38` |
| Hack time (s) | `5 · (2.5·req·sec + 500) / (hack + 50) / (p.mults.hacking_speed · BN.HackingSpeedMultiplier · intBonus(1))` | `Hacking.ts:60-80` |
| Grow time | `3.2 × hackTime` | `Hacking.ts:83-87` |
| Weaken time | `4 × hackTime` | `Hacking.ts:90-94` |
| Darknet server hack time | fixed 16 s (only reachable via dnet APIs; `ns.hack` rejects non-`Server`) | `Hacking.ts:61` |

Note time is **linear in `req·sec`**: high-req, high-sec targets (ecorp: req ≈1225, minSec 33 → `2.5·req·sec ≈ 101k`) are ~200× slower than early targets at equal skill. Lowering `sec` is the strongest time lever.

### 1.2 Grow (`src/Server/formulas/grow.ts`, `src/Server/ServerHelpers.ts`)

```
adjGrowthLog = min( log1p(0.03 / sec), 0.00349388925425578 )        // cap = log1p(0.0035); reached when sec ≤ 8.571
k(threads=1) = adjGrowthLog · (serverGrowth/100) · BN.ServerGrowthRate · p.mults.hacking_grow · coreBonus(cores)
newMoney     = min( M, (money + threads) · exp(k · threads) )          // "+threads": $1/thread additive, works from $0
coreBonus(c) = 1 + (c − 1)/16                                          // ServerHelpers.ts:287-290
```
Cites: `grow.ts:8-29` (log), `grow.ts:38-58` (money incl. additive and cap), constants `src/Server/data/Constants.ts:7-8`.

Thread solvers:
- `growthAnalyze(host, mult, cores)` = `ln(mult)/k` — multiplicative only, **no** `+threads` term, fractional result, uses *current* sec (`ServerHelpers.ts:75-78`, `NetscriptFunctions.ts:311-324`).
- `formulas.hacking.growThreads(server, player, target, cores)` → `numCycleForGrowthCorrected`: exact integer solution of `target = (start + x)·e^{kx}` via Newton iteration (`ServerHelpers.ts:90-199`). Use this; it matches the in-game rounding.

### 1.3 Security deltas

| Action | Δsec | Notes | Cite |
|---|---|---|---|
| hack (success only) | `+0.002 · min(threads, ceil(1/hackFraction))` | Fail → no change. Thread cap = threads needed to drain 100% | `NetscriptHelpers.tsx:569-573, 613` |
| grow | `+0.004 · min(ceil(cyclesActuallyNeeded), threads)` — only if money changed | Over-provisioned grow threads (money capped at `M`) add **no** security; grow at `M` adds **zero** security | `ServerHelpers.ts:202-212` |
| weaken | `−0.05 · threads · coreBonus(hostCores) · BN.ServerWeakenRate` | Independent of target state; floored at `minSec` | `ServerHelpers.ts:292-295`, `Server.ts:91-104,143-146` |
| clamps | `minSec ≤ sec ≤ 100`, `sec ≥ 1` | | `Server.ts:91-104` |

Ratios (1 core, `ServerWeakenRate=1`): 1 weaken thread offsets 25 hack threads or 12.5 grow threads.

### 1.4 Execution semantics (what is evaluated when)

| | At call (t0) | At completion (t0 + duration) |
|---|---|---|
| `hack` | options validated; duration from **current** sec & skill; root + `req ≤ hack` check (`NetscriptHelpers.tsx:537-550`) | chance, fraction, XP computed from **end-time** sec/skill; `drained = money_end · fraction · threads` (≤ money); money × `BN.ScriptHackMoneyGain` credited; sec+; optional stock influence (`:561-636`) |
| `grow` | duration from current sec/skill; root check only (no skill req!) (`NetscriptFunctions.ts:266-286`) | growth from **end** sec, end money, **host cores at end**; XP always full per thread (`:286-309`) |
| `weaken` | duration; root check only (`:342-362`) | fixed reduction using host cores; XP always full (`:362-385`) |

- Duration is implemented with `window.setTimeout(duration_ms)` (`NetscriptHelpers.tsx:419-432`) → **wall-clock**, not game cycles.
- Killing the script before completion cancels the effect entirely (promise rejected with `ScriptDeath`).
- XP raises skill **immediately** (`src/PersonObjects/Person.ts:50-64`), so in-flight hacks land with a higher skill than at launch → larger fraction than planned.
- Hack XP: full on success, `1/4` on failure or when `drained == 0` (`NetscriptHelpers.tsx:564-587`). Grow/weaken XP is unconditional (even when no-op).
- `ns.hack` returns money gained; `grow` returns multiplier (0 if `M==0`); `weaken` returns actual reduction.

### 1.5 `BasicHGWOptions` (`NetscriptHelpers.tsx:346-385`)

| Option | Effect |
|---|---|
| `threads` | Any **positive number** ≤ script's thread count (non-integers accepted, e.g. `0.5`). Default = script threads. RAM is not refunded. |
| `additionalMsec` | Added to the timer: duration = formula time + `additionalMsec` ms. Must be `0 ≤ x ≤ 1e9`. Not applied to `weaken` effect, only delay. |
| `stock` | `hack`/`grow` only: influence linked stock's second-order forecast (§8.4). |

### 1.6 Terminal / manual variants (UI or SF4)

| Action | Time | Effect | Cite |
|---|---|---|---|
| terminal `hack` | `hackTime/4` (game-cycle timer) | 1 thread; `ManualHackMoney`; **success also sets `backdoorInstalled = true`**; int XP | `Terminal.ts:203-212, 256-324` |
| terminal `grow` | `growTime/16` | 25 threads with **target's** cores | `Terminal.ts:214-222, 326-348` |
| terminal `weaken` | `weakenTime/16` | 1 thread, target's cores | `Terminal.ts:223-231, 350-371` |
| terminal `backdoor` | `hackTime/4` | sets backdoor | `Terminal.ts:233-243, 373-395` |
| `singularity.manualHack()` | full `hackTime` (setTimeout) | as `ns.hack` with `ManualHackMoney`, **success sets backdoor** | `Singularity.ts:513-517`, `NetscriptHelpers.tsx:595-621` |
| `singularity.installBackdoor()` | `hackTime/4` (setTimeout) | sets backdoor; WD → BitVerse | `Singularity.ts:518-559` |

Terminal actions tick on game cycles (`Terminal.ts:165-168`).

### 1.7 NS API surface — hacking

| Function | RAM (GB) | Req | Notes |
|---|---|---|---|
| `hack` / `grow` / `weaken` | 0.10 / 0.15 / 0.15 | root | |
| `hackAnalyze`, `hackAnalyzeChance`, `hackAnalyzeThreads`, `hackAnalyzeSecurity` | 1.0 each | – | current state only |
| `growthAnalyze`, `growthAnalyzeSecurity` | 1.0 each | – | `growthAnalyzeSecurity` = `0.004·min(threads, threadsToMax)` |
| `weakenAnalyze(threads, cores)` | 1.0 | – | |
| `getHackTime`/`getGrowTime`/`getWeakenTime` | 0.05 | – | ms, current state |
| `getServer` | 2.0 | – | full object |
| `getServerMoneyAvailable`, `…SecurityLevel`, `…MinSecurityLevel`, `…MaxMoney`, `…Growth`, `…RequiredHackingLevel`, `…NumPortsRequired`, `serverExists` | 0.1 | – | |
| `nuke`, `brutessh`, `ftpcrack`, `relaysmtp`, `httpworm`, `sqlinject` | 0.05 | program on **home** | |
| `formulas.hacking.*` | 0 | `Formulas.exe` on home | §11 |
| `singularity.manualHack` / `installBackdoor` | 2 ×(16/4/1 by SF4 lvl) | SF4 or BN4 | `RamCostGenerator.ts:82-96,169-170` |

RAM costs: `src/Netscript/RamCostGenerator.ts:10-80, 556-667`.

---

## 2. Server model

### 2.1 Construction (`src/Server/ServerHelpers.ts:342-413`, `src/Server/Server.ts:59-88`)

Per-server values are drawn **once per BitNode/aug-install** (servers are rebuilt on every `prestigeAugmentation`, `src/Prestige.ts:74,98`) using `getRandomIntInclusive` on each `{min,max}` range in `src/Server/data/servers.ts` (`ServerHelpers.ts:350-370`):

| Field | Formula |
|---|---|
| `moneyAvailable` (start) | `base · BN.ServerStartingMoney` (`Server.ts:74-75`) |
| `moneyMax` | `25 · base · BN.ServerMaxMoney` (`Server.ts:76`) |
| `hackDifficulty`, `baseDifficulty` | `min(baseSec · BN.ServerStartingSecurity, 100)`; if metadata sec is 0/absent → 1 (`Server.ts:79-82`) |
| `minDifficulty` | `min(max(1, round(baseSec·BN.ServerStartingSecurity / 3)), 100)` — computed from **uncapped** value (`Server.ts:83`) |
| `serverGrowth` | metadata (not BN-scaled; BN applies in formula); absent/0 → 1 |
| `maxRam` | `2^exponent` |
| `cpuCores` | `randInt(ceil(layer/2), layer)` (`ServerHelpers.ts:374-377`) |
| WD `req` | `3000 · BN.WorldDaemonDifficulty` (`ServerHelpers.ts:383-385`) |
| Topology | 15 layers; each server links to a random server of the previous layer; layer 1 → home (`ServerHelpers.ts:392-406`). Hostnames fixed, IPs random. |

Consequence: in high-`ServerStartingSecurity` nodes (BN9 ×2.5, BN13 ×3) the top servers get `minSec` 83–99 → hack fraction factor `(100−sec)/100` of 0.17–0.01, and starting sec capped at 100 = **chance 0 until weakened**.

### 2.2 Server table (BN1 values, mult = 1; ranges are uniform-int draws)

`moneyMax` = 25 × base; `minSec` derived; `*` = metadata 0 → defaults (sec 1, growth 1, no money).

| host | layer | ports | reqHack | baseSec | minSec | moneyMax | growth | RAM GB | cores |
|---|---|---|---|---|---|---|---|---|---|
| n00dles | 1 | 0 | 1 | 1 | 1 | 1.75m | 3000 | 4 | 1 |
| foodnstuff | 1 | 0 | 1 | 10 | 3 | 50m | 5 | 16 | 1 |
| sigma-cosmetics | 1 | 0 | 5 | 10 | 3 | 57.5m | 10 | 16 | 1 |
| joesguns | 1 | 0 | 10 | 15 | 5 | 62.5m | 20 | 16 | 1 |
| hong-fang-tea | 1 | 0 | 30 | 15 | 5 | 75m | 20 | 16 | 1 |
| harakiri-sushi | 1 | 0 | 40 | 15 | 5 | 100m | 40 | 16 | 1 |
| iron-gym | 1 | 1 | 100 | 30 | 10 | 500m | 20 | 32 | 1 |
| nectar-net | 2 | 0 | 20 | 20 | 7 | 68.8m | 25 | 16 | 1–2 |
| CSEC | 2 | 1 | 51–60 | 1* | 1* | 0 | 1* | 8 | 1–2 |
| zer0 | 2 | 1 | 75 | 25 | 8 | 188m | 40 | 32 | 1–2 |
| max-hardware | 2 | 1 | 80 | 15 | 5 | 250m | 30 | 32 | 1–2 |
| neo-net | 3 | 1 | 50 | 25 | 8 | 125m | 25 | 32 | 2–3 |
| phantasy | 3 | 2 | 100 | 20 | 7 | 600m | 35 | 32 | 2–3 |
| silver-helix | 3 | 2 | 150 | 30 | 10 | 1.13b | 30 | 64 | 2–3 |
| omega-net | 3 | 2 | 180–220 | 25–35 | 8–12 | 1.5b–1.75b | 30–40 | 32 | 2–3 |
| avmnite-02h | 4 | 2 | 202–220 | 1* | 1* | 0 | 1* | 16–128 | 2–4 |
| crush-fitness | 4 | 2 | 225–275 | 35–45 | 12–15 | 1b–1.5b | 27–33 | 0 | 2–4 |
| johnson-ortho | 4 | 2 | 250–300 | 35–65 | 12–22 | 1.75b–2.13b | 35–65 | 0 | 2–4 |
| the-hub | 4 | 2 | 275–325 | 35–45 | 12–15 | 3.75b–5b | 45–55 | 8–64 | 2–4 |
| computek | 4 | 3 | 300–400 | 55–65 | 18–22 | 5.5b–6.25b | 45–65 | 0 | 2–4 |
| netlink | 4 | 3 | 375–425 | 60–80 | 20–27 | 6.88b | 45–75 | 16–128 | 2–4 |
| I.I.I.I | 5 | 3 | 340–365 | 1* | 1* | 0 | 1* | 16–256 | 3–5 |
| rothman-uni | 5 | 3 | 370–430 | 45–55 | 15–18 | 4.38b–6.25b | 35–45 | 16–128 | 3–5 |
| catalyst | 5 | 3 | 400–450 | 60–70 | 20–23 | 7.5b–13.8b | 25–55 | 16–128 | 3–5 |
| summit-uni | 5 | 3 | 425–475 | 45–65 | 15–22 | 5b–8.75b | 40–60 | 16–64 | 3–5 |
| syscore | 5 | 4 | 550–650 | 60–80 | 20–27 | 10b–15b | 60–70 | 0 | 3–5 |
| zb-institute | 5 | 5 | 725–775 | 65–85 | 22–28 | 20b–27.5b | 75–85 | 16–128 | 3–5 |
| aevum-police | 6 | 4 | 400–450 | 70–80 | 23–27 | 5b–10b | 30–50 | 16–64 | 3–6 |
| rho-construction | 6 | 3 | 475–525 | 40–60 | 13–20 | 12.5b–17.5b | 40–60 | 16–64 | 3–6 |
| millenium-fitness | 6 | 3 | 475–525 | 45–55 | 15–18 | 6.25b | 25–45 | 16–256 | 3–6 |
| alpha-ent | 6 | 4 | 500–600 | 50–70 | 17–23 | 15b–18.8b | 50–60 | 16–128 | 3–6 |
| lexo-corp | 6 | 4 | 650–750 | 60–80 | 20–27 | 17.5b–20b | 55–65 | 16–128 | 3–6 |
| snap-fitness | 7 | 4 | 675–800 | 40–60 | 13–20 | 11.3b | 40–60 | 0 | 4–7 |
| global-pharm | 7 | 4 | 750–850 | 75–85 | 25–28 | 37.5b–43.8b | 80–90 | 8–64 | 4–7 |
| galactic-cyber | 7 | 5 | 825–875 | 55–65 | 18–22 | 18.8b–21.3b | 70–90 | 0 | 4–7 |
| aerocorp | 7 | 5 | 850–925 | 80–90 | 27–30 | 25b–30b | 55–65 | 0 | 4–7 |
| unitalife | 8 | 4 | 775–825 | 70–80 | 23–27 | 25b–27.5b | 70–80 | 16–64 | 4–8 |
| deltaone | 8 | 5 | 800–900 | 75–85 | 25–28 | 32.5b–42.5b | 50–70 | 0 | 4–8 |
| omnia | 8 | 5 | 850–950 | 85–95 | 28–32 | 22.5b–25b | 60–70 | 16–64 | 4–8 |
| solaris | 9 | 5 | 750–850 | 70–80 | 23–27 | 17.5b–22.5b | 70–80 | 16–128 | 5–9 |
| univ-energy | 9 | 4 | 800–900 | 80–90 | 27–30 | 27.5b–30b | 80–90 | 16–128 | 5–9 |
| zeus-med | 9 | 5 | 800–850 | 70–90 | 23–30 | 32.5b–37.5b | 70–80 | 0 | 5–9 |
| defcomm | 9 | 5 | 850–1050 | 84–96 | 28–32 | 20b–23.8b | 47–73 | 0 | 5–9 |
| icarus | 9 | 5 | 850–925 | 85–95 | 28–32 | 22.5b–25b | 85–95 | 0 | 5–9 |
| zb-def | 10 | 4 | 775–825 | 55–65 | 18–22 | 22.5b–27.5b | 65–75 | 0 | 5–10 |
| nova-med | 10 | 4 | 775–850 | 60–80 | 20–27 | 27.5b–31.3b | 65–85 | 0 | 5–10 |
| taiyang-digital | 10 | 5 | 850–950 | 70–80 | 23–27 | 20b–22.5b | 70–80 | 0 | 5–10 |
| infocomm | 10 | 5 | 875–950 | 70–90 | 23–30 | 15b–22.5b | 35–75 | 0 | 5–10 |
| run4theh111z | 11 | 4 | 505–550 | 1* | 1* | 0 | 1* | 32–512 | 6–11 |
| applied-energetics | 11 | 4 | 775–850 | 60–80 | 20–27 | 17.5b–25b | 70–75 | 0 | 6–11 |
| titan-labs | 11 | 5 | 800–875 | 70–80 | 23–27 | 18.8b–22.5b | 60–80 | 16–128 | 6–11 |
| microdyne | 11 | 5 | 800–875 | 65–75 | 22–25 | 12.5b–17.5b | 70–90 | 16–64 | 6–11 |
| vitalife | 12 | 5 | 775–900 | 80–90 | 27–30 | 17.5b–20b | 60–80 | 16–128 | 6–12 |
| helios | 12 | 5 | 800–900 | 85–95 | 28–32 | 13.8b–18.8b | 70–80 | 32–256 | 6–12 |
| stormtech | 12 | 5 | 875–1075 | 78–92 | 26–31 | 25b–30b | 68–92 | 0 | 6–12 |
| fulcrumtech | 12 | 5 | 950–1250 | 83–97 | 28–32 | 35b–45b | 80–99 | 128–2048 | 6–12 |
| . | 13 | 4 | 505–550 | 1* | 1* | 0 | 1* | 16 | 7–13 |
| omnitek | 13 | 5 | 900–1100 | 90–99 | 30–33 | 325b–550b | 95–99 | 128–512 | 7–13 |
| 4sigma | 13 | 5 | 900–1250 | 55–75 | 18–25 | 375b–625b | 75–99 | 0 | 7–13 |
| kuai-gong | 13 | 5 | 950–1300 | 95–99 | 32–33 | 500b–750b | 90–99 | 0 | 7–13 |
| b-and-a | 14 | 5 | 900–1150 | 72–88 | 24–29 | 375b–750b | 60–80 | 0 | 7–14 |
| blade | 14 | 5 | 900–1200 | 88–97 | 29–32 | 250b–1t | 55–85 | 32–512 | 7–14 |
| nwo | 14 | 5 | 950–1300 | 99 | 33 | 500b–1t | 65–95 | 0 | 7–14 |
| clarkinc | 14 | 5 | 950–1250 | 45–65 | 15–22 | 375b–625b | 45–75 | 0 | 7–14 |
| powerhouse-fitness | 14 | 5 | 950–1100 | 55–65 | 18–22 | 22.5b | 50–60 | 16–64 | 7–14 |
| The-Cave | 15 | 5 | 925 | 1* | 1* | 0 | 1* | 0 | 8–15 |
| ecorp | 15 | 5 | 1050–1400 | 99 | 33 | 750b–1.75t | 99 | 0 | 8–15 |
| megacorp | 15 | 5 | 1100–1350 | 99 | 33 | 1t–1.5t | 99 | 0 | 8–15 |
| fulcrumassets | 15 | 5 | 1100–1600 | 99 | 33 | 25m | 1 | 0 | 8–15 |
| w0r1d_d43m0n | – | 5 | 3000×WD | 1* | 1* | 0 | 1* | 0 | 1 |

(Generated by evaluating `src/Server/data/servers.ts` directly. `w0r1d_d43m0n` is only linked after The Red Pill — `Prestige.ts:175-182`.)

Notable: `clarkinc` and `4sigma` have half of ecorp's money but ~half the min security → comparable money/thread-second with better growth rate per thread (lower sec → bigger `adjGrowthLog`). Target choice must be computed per BN.

Special/owned servers: `home` (8 GB start, 32 with SF1, 128 with SF9.2; `Prestige.ts:246-253`), `darkweb` (a `DarknetServer`, 16 GB, linked to home after TOR; `DarkNet/controllers/NetworkGenerator.ts:83`), cloud servers (§4.2), hacknet servers (§7.2). Owned servers cannot be hacked/grown/weakened (`Hacking/netscriptCanHack.ts:15-20`).

### 2.3 Ports / root

- `numOpenPortsRequired` 0–5; `nuke` succeeds iff `openPortCount ≥ numOpenPortsRequired` (`NetscriptFunctions.ts:531-548`). Each opener needs its `.exe` on **home** (`PlayerObjectGeneralMethods.ts:203-206`), increments `openPortCount` once (`:549-623`). **No skill requirement for root**; skill only gates `hack` and backdoor.
- `exec` onto a normal server needs only root — no adjacency/connection (`NetscriptWorker.ts:280-285`); `scp` to a normal server needs **neither root nor adjacency** (the darknet check returns early for non-darknet hosts, `DarkNet/effects/offlineServerHandling.ts:65-71`, `NetscriptFunctions.ts:766-816`).

### 2.4 Backdoors — what they grant

| Grant | Where |
|---|---|
| Faction invites: CSEC→CyberSec, avmnite-02h→NiteSec, I.I.I.I→The Black Hand, run4theh111z→BitRunners, fulcrumassets→Fulcrum Secret Technologies (plus rep req) | `Faction/FactionInfo.tsx:379-489` |
| Company server backdoor → company rep requirements ×0.75 (`CONSTANTS.CompanyRequiredReputationMultiplier`) | `Company/utils.ts:15-19`, `Constants.ts:110` |
| Gym/university server backdoor → class cost ×0.9 | `Work/Formulas.ts:100-105` |
| Direct `connect` from anywhere (terminal / `singularity.connect`) | `Terminal/commands/connect.ts:40-49`, `Singularity.ts:505-508` |
| `w0r1d_d43m0n` → BitNode completion | `Singularity.ts:552-554` |

Installing: terminal `backdoor` (UI) or `singularity.installBackdoor` (SF4), must be **connected** to the server, needs root + `req ≤ hack`, time `hackTime/4`. Quirk: a *successful terminal `hack` or `singularity.manualHack`* also sets the backdoor (§1.6). Backdoors are lost on aug install (servers rebuilt).

---

## 3. Script execution model

### 3.1 RAM cost (static analysis) — `src/Script/RamCalculations.ts`

- Base cost 1.6 GB per script (`:163-164`); cap 1024 GB (`:255-258`, `RamCostConstants.Max`).
- Walks the AST (incl. imported modules) and adds the cost of **every identifier whose name equals an NS function name anywhere in the RAM tree**, once per name (`:215-253`, `findFunc`). Matching is by bare identifier/property name: a local variable or object property named `hack`, `getServer`, `purchaseServer` etc. is charged. Name lookups resolve to the first match (top-level before namespaces).
- `document` / `window` identifiers: +25 GB each (`:185-192`).
- Static override: first statement of `main` = `ns.ramOverride(<numeric literal ≥ 1.6>)` replaces the whole calculation (`:174-183, 352-401`). Runtime override: `RunOptions.ramOverride` (≥1.6, rounded to 0.01) (`NetscriptHelpers.tsx:245-256`).
- Dynamic check: each NS call charges its cost on first use per function **key name** to `dynamicRamUsage` (starts 1.6); if it exceeds the allocated per-thread RAM the script is killed (`NetscriptHelpers.tsx:435-476`, `APIWrapper.ts:78-83`, `WorkerScript.ts:49`). Non-NS globals (`globalThis`, `eval`) are not charged dynamically.
- Minimal workers: hack-only 1.70 GB, grow-only 1.75, weaken-only 1.75, share-only 4.0 (2.4 + 1.6).
- RAM usage of a run = `roundToTwo(ramPerThread · threads)`; launch fails if `> free + 0.001` (`NetscriptWorker.ts:110-122, 287-303`).

### 3.2 Threads, processes, scheduling

- Threads multiply effect of hack/grow/weaken/share only; one process with N threads ≈ cost of one process. `exec/run/spawn` threads must be positive integers (`NetscriptHelpers.tsx:225-258`).
- All scripts run as async ES modules on the **renderer main thread** (no workers). Concurrency = awaiting promises; one NS promise per script at a time (`checkEnvFlags`, `NetscriptHelpers.tsx:399-416`) except `asleep`.
- `ns.sleep(ms)` = `setTimeout` via `netscriptDelay` (`NetscriptFunctions.ts:250-258`); `ns.asleep` = raw `setTimeout` (`:259-265`). Granularity: ms (browser timer), jitter = event-loop load.
- PIDs: incrementing from 1, reset on aug install; search cap 1e6 attempts (`Netscript/Pid.ts`). No hard limit on concurrent scripts; practical limit is main-thread CPU (each exec does script lookup, cached RAM calc, module instantiation, log buffers of `MaxLogCapacity`=50).
- `spawn` default delay 10 s, kills caller (`NetscriptFunctions.ts:653-690`, `NetscriptHelpers.tsx:260-272`).
- Steam/Electron: `backgroundThrottling: false` (`electron/gameWindow.js:26,63`) → minimized window keeps full timer rate.

### 3.3 Game loop

| Item | Value | Cite |
|---|---|---|
| Cycle | `CONSTANTS.MilliPerCycle = 200` ms | `Constants.ts:19` |
| Loop | `Engine.start` re-arms `setTimeout(200 − offset)`; computes elapsed cycles from `Date` and calls `updateGame(diff)` (catch-up in one call) | `engine.tsx:415-442` |
| `updateGame(n)` order | playtime += n·200; Terminal.process; Player.processWork; stock prices; gang; Stanek; corp; bladeburner (store); sleeves; darknet; script online-time; **hacknet earnings**; counters | `engine.tsx:81-139` |
| Counters (cycles) | faction invites 10, passive rep 5, messages 150, bladeburner 5, contracts 3000 (10 min, `tryGeneratingRandomContract(3)`), autosave `AutosaveInterval·5` | `engine.tsx:146-236` |

What is wall-clock vs cycle-based:

| Wall-clock `setTimeout` | Game cycles (200 ms) |
|---|---|
| hack/grow/weaken, `sleep`, `share` (10 s), `installBackdoor`, `manualHack`, spawn delay, dnet actions, port `nextWrite` | hacknet production, terminal hack/grow/weaken/backdoor, player work (crime, faction, company, program creation, study), stock ticks (with extra wall-clock gate, §8.2), gang/corp/bladeburner/sleeves/darknet (via stored cycles) |

### 3.4 Offline progress (`engine.tsx:239-379`, `Script/ScriptHelpers.ts:14-92`)

On load with `t_off = now − Player.lastUpdate`:
- **Money from hacking:** `moneySourceA.hacking / playtimeSinceLastAug · t_off · 0.75` (`engine.tsx:270-275`, `OfflineHackingIncome` `Constants.ts:22`) — the **average hacking income since last aug install**, not per-script rates.
- Per script: hack XP `= min(1, onlineRunningTime/14400) · onlineExpGained/onlineRunningTime · t_off`; grow applied as one big grow of `round(0.5·growCalls·t_off/onlineTime)` threads; weaken similarly (`ScriptHelpers.ts:34-91`).
- **All scripts restart from `main()`** with their saved args (`NetscriptWorker.ts:218-264`); in-flight HGW are lost. `RunOptions.temporary` scripts are not saved.
- Hacknet: full `processHacknetEarnings(numCyclesOffline)` (`engine.tsx:308`). Stocks/corp/gang/bladeburner/darknet get stored "bonus" cycles.
- If `currentWork` exists it is processed for all offline cycles with focus forced on (`engine.tsx:280-282`); otherwise passive faction rep.

### 3.5 Ports / IPC (`src/NetscriptPort.ts`)

- Global ports `1..MAX_SAFE_INTEGER` (`Constants.ts:38`), FIFO, capacity `Settings.MaxPortCapacity` = 50 by default (`Settings/Settings.ts:41`); `write` drops+returns oldest on overflow, `tryWrite` refuses. Objects are `structuredClone`d (no functions/NS). `nextWrite()` promise for event-driven waits. All port functions cost 0 GB (`RamCostGenerator.ts:623-656`). Cleared on aug install (`NetscriptWorker.ts:40-46`).
- Alternatives: text files (`read`/`write` 0 GB), or shared JS state through `globalThis`/module scope (same realm; not RAM-charged).

### 3.6 NS process API RAM

`run` 1.0, `exec` 1.3, `spawn` 2.0, `scp` 0.6, `rm` 0.6, `kill`/`killall` 0.5, `ps`/`ls`/`scan` 0.2, `isRunning`/`fileExists` 0.1, `getServerMaxRam`/`UsedRam` 0.05, `getScriptRam` 0.1, `getRunningScript` 0.3, `getPlayer` 0.5, `getBitNodeMultipliers` 4 (SF5), `getMoneySources` 1, `getResetInfo` 1 (`RamCostGenerator.ts:556-667`).

---

## 4. Home, cloud servers, TOR, programs

### 4.1 Home

| | Formula | Limits | API |
|---|---|---|---|
| RAM upgrade (×2) | `R · 32000 · 1.58^{log2 R} · BN.HomeComputerRamCost`, R = current RAM (`PlayerObjectServerMethods.ts:30-40`) | max 2^30 GB (`Server/data/Constants.ts:6`); 128 GB if `restrictHomePCUpgrade` | UI (tech vendors) or `singularity.upgradeHomeRam` (3 GB×SF4 factor) |
| Cores (+1) | `1e9 · 7.5^{cores}` — **no BN mult** (`:42-44`) | max 8 (`Singularity.ts:600`) | UI or `singularity.upgradeHomeCores` |
| Persistence | RAM & cores kept on aug install; reset on BN change to 8/32/128 GB, 1 core (`Prestige.ts:246-253`) | | |

Reference costs (BN1): 8→16 GB $1.01m; 32→64 $10.1m; 1 TB→2 TB $3.2b; 1 PB→2 PB $3.2e14; last doubling to 1 EB ≈ $9.9e18. Cores: 1→2 $7.5b … 7→8 $1.33e15. Home cores (≤8 → ×1.4375) boost grow/weaken/share on home only.

### 4.2 Cloud ("purchased") servers — `src/Server/ServerPurchases.ts`, `src/NetscriptFunctions/Cloud.ts`

```
cost(ram) = ram · 55000 · BN.CloudServerCost · BN.CloudServerSoftcap^{max(0, log2(ram) − 6)}   // ram: power of 2, ≤ maxRam
upgradeCost(host, newRam) = cost(newRam) − cost(currentRam)                                   // no penalty for stepwise upgrades
limit  = round(25 · BN.CloudServerLimit)            maxRam = 2^floor(log2(round(2^20 · BN.CloudServerMaxRam)))
```
(`ServerPurchases.ts:23-42, 44-63, 96-105`). 1 core each. Deleting refunds nothing and requires no running scripts (`Cloud.ts:127-194`). Lost on aug install (`PlayerObjectGeneralMethods.ts:109`). BN9: limit 0.

API (3.0 moved to `ns.cloud`; old names throw, `NetscriptFunctions.ts:1577-1612`): `getServerLimit`/`getRamLimit` 0.05, `getServerCost` 0.25, `getServerUpgradeCost` 0.1, `upgradeServer` 0.25, `getServerNames` 1.05, `purchaseServer` 2.25, `deleteServer` 2.25, `renameServer` 0. No SF needed.

BN1 reference: 1 PB server = $57.7b; 25×1 PB = $1.44t.

### 4.3 TOR, darkweb, programs

TOR router $200k (`Constants.ts:44`) — UI (City tech store) or `singularity.purchaseTor` (SF4). Lost on aug install unless darknet access (SF15 or DarkscapeNavigator, `ServerHelpers.ts:408-412`, `DarkNet/utils/darknetAuthUtils.ts`). Programs persist only until aug install (home programs wiped except NUKE/BitFlume; SF5 re-grants Formulas.exe) (`ServerHelpers.ts:224-235`, `Prestige.ts:93-95`).

| Program | Darkweb $ (`DarkWeb/DarkWebItems.ts:5-21`) | Create: hack lvl / base time (`Programs/Programs.ts`) |
|---|---|---|
| BruteSSH.exe | 500k | 50 / 10 min |
| FTPCrack.exe | 1.5m | 100 / 30 min |
| relaySMTP.exe | 5m | 250 / 2 h |
| HTTPWorm.exe | 30m | 500 / 4 h |
| SQLInject.exe | 250m | 750 / 8 h |
| ServerProfiler.exe | 500k | 75 / 30 min |
| DeepscanV1 / V2 | 500k / 25m | 75 / 15 min; 400 / 2 h |
| AutoLink.exe | 1m | 25 / 15 min |
| Formulas.exe | 5b | 1000 / 4 h |
| DarkscapeNavigator.exe | 50m (30m at Shadowed Walkway) | not creatable |

Prices have no BN multiplier. Effective create req = `max(1, level − int/2)` (`Programs.ts:26-28`). Create speed: `rate = 200 ms/cycle · (1 + (hack/req·intBonus(3) − 1)/5) · focusPenalty` vs `time` units (`Work/CreateProgramWork.ts:58-72`) — game-cycle based. Buying: terminal `buy` (UI) or `singularity.purchaseProgram` (SF4). Creating: UI or `singularity.createProgram` (SF4).

---

## 5. Hacknet Nodes (pre-SF9) — `src/Hacknet/formulas/HacknetNodes.ts`, `data/Constants.ts`

```
$/s = level·1.5 · 1.035^(ram−1) · (cores+5)/6 · p.mults.hacknet_node_money · BN.HacknetNodeMoney
nodeCost(n)    = 1000 · 1.85^(n−1) · p.mults.hacknet_node_purchase_cost          // n = 1-based index of new node
levelCost      = 500 · Σ_{i=L−1}^{L+k−2} 1.04^i · p.mults.hacknet_node_level_cost   // max level 200
ramCost        = Σ R·30000 · 1.28^{log2 R} (doubling each step) · ram_cost mult    // max 64 GB
coreCost       = Σ 500000 · 1.48^{c−1} · core_cost mult                             // max 16
```
Max node: 300·8.734·3.5 ≈ **$9,171/s** × mults. Production per game cycle (`HacknetNode.ts:76-88`), offline-complete. Unlimited count. Lost on aug install. API `ns.hacknet.*` 0.5 GB each, no SF (`RamCostGenerator.ts:99-121`).

## 6. Hacknet Servers (BN9 / SF9) — `formulas/HacknetServers.ts`, `HacknetServer.ts`, `HashManager.ts`

Available iff `bitNodeN==9 || SF9≥1` and not `disableHacknetServer` (`HacknetHelpers.tsx:34-36`). **Replaces** nodes everywhere afterwards.

```
hashes/s = 0.001·level · 1.07^{log2 maxRam} · (1 + (cores−1)/5) · (1 − ramUsed/maxRam) · p.mults.hacknet_node_money · BN.HacknetNodeMoney
serverCost(n) = 50000 · 3.2^(n−1) · purchase mult         (max 20 servers)
levelCost     = 500000 · Σ_{i=L}^{L+k−1} 1.1^i · level mult  (max 300)
ramCost       = Σ R·200000 · 1.4^{log2 R} · ram mult         (max 8192 GB, starts 1 GB)
coreCost      = 1e6 · Σ 1.55^{c−1} · core mult               (max 128)
cacheCost     = 10e6 · Σ 1.85^{c−1}  (no mult)               (max 15); capacity = 32·2^cache hashes
```
(`HacknetServers.ts:4-118`, `HacknetServer.ts:121-135`, `data/Constants.ts:32-52`.)

- Max server ≈ 0.3·2.41·26.4 ≈ **19.1 h/s** (= $4.77m/s via selling) × mults, *only with zero RAM in use*.
- Hacknet servers are real script hosts with `cpuCores = cores` (≤128 → grow/weaken `coreBonus` up to **8.94×**) but scripts reduce hash rate proportionally to RAM used (`HacknetServer.ts:100,116-119`).
- Overflow above capacity is **auto-sold at the "Sell for Money" rate** (`HacknetHelpers.tsx:419-429`) → capacity never wastes money.
- SF9.3 (or entering BN9): free server lvl 100 / 10 cores / cache 5 at BN start (`Prestige.ts:338-348`).

### 6.1 Hash upgrades (`data/HashUpgradesMetadata.tsx`, `HashUpgrade.ts:72-82`, effects `HacknetHelpers.tsx:466-576`)

Cost for buying `count` at current level L: `costPerLevel · count·(count + 2L + 1)/2` (i.e. level L costs `costPerLevel·(L+1)`); flat-cost upgrades ignore level. **Levels are global per upgrade type, not per target server**, and reset on aug install (`HashManager.ts:80-88`).

| Upgrade | Cost | Effect |
|---|---|---|
| Sell for Money | flat 4 | +$1m (not BN-scaled) |
| Sell for Corporation Funds | 100/lvl | +$1b corp funds |
| Reduce Minimum Security | 50/lvl | target `minSec ×= 0.98^count` (floor 1); persists until aug install |
| Increase Maximum Money | 50/lvl | target `M ×= 1.02` per count; above $10t: `n = 1 + 0.02/ln(M−10t)/ln 8` soft cap (`Server.ts:126-134`) |
| Improve Studying / Gym Training | 50/lvl | +20%/lvl class exp |
| Exchange for Corporation Research | 200/lvl | +1000 RP every division |
| Exchange for Bladeburner Rank / SP | 250/lvl | +100 rank / +10 SP |
| Generate Coding Contract | 25/lvl | random contract |
| Company Favor | 200/lvl | +5 favor (persists until BN end) |

API: `hacknet.numHashes/hashCapacity/hashCost/spendHashes/getHashUpgrades/getHashUpgradeLevel/getStudyMult/getTrainingMult` 0.5 GB; `maxNumNodes()` = 20 (servers) or ∞ (nodes) (`NetscriptFunctions/Hacknet.ts:57-62`).

---

## 7. Stock market — `src/StockMarket/*`

### 7.1 Access & costs (`data/Constants.ts`, `StockMarketCosts.ts`, `NetscriptFunctions/StockMarket.ts`)

| Item | Cost | Needed for | Buy via |
|---|---|---|---|
| WSE account | $200m | UI trading; starts market simulation | UI or `stock.purchaseWseAccount()` (2.5 GB, **no SF**) |
| TIX API | $5b | every `ns.stock` data/trade call (`:40-44`) | UI or `stock.purchaseTixApi()` |
| 4S Market Data | $1b · `BN.FourSigmaMarketDataCost` | forecast in UI | `stock.purchase4SMarketData()` |
| 4S TIX API | $25b · `BN.FourSigmaMarketDataApiCost` | `getForecast`, `getVolatility` | `stock.purchase4SMarketDataTixApi()` |
| Commission | $100k per transaction | | |

- Market only simulates (and only exists) once WSE or TIX is owned (`StockMarket.ts:167-169`, `engine.tsx:101-103`).
- Access flags survive aug installs, reset on new BN (`PlayerObjectGeneralMethods.ts:162-166`); SF8 (or BN8) grants WSE+TIX free each reset (`Prestige.ts:164-167, 305-308`). Stocks (prices **and positions**) are re-initialized on aug install (`Prestige.ts:169-172`) — irrelevant since money resets too.
- Shorts: BN8 or SF8.2; limit/stop orders: BN8 or SF8.3 (`NetscriptFunctions/StockMarket.ts:147-227`).
- RAM: getters 2.0, trades/orders/forecast/volatility/purchases 2.5, `has*` 0.05, `getConstants`/`getBonusTime`/`nextUpdate` 0 (`RamCostGenerator.ts:124-154`).

### 7.2 Tick model (`StockMarket.ts:219-323`)

Tick cadence: `storedCycles += numCycles`; a tick runs when `storedCycles ≥ 30` (6 s) **and** `Date.now() − lastUpdate ≥ 4000` ms; each tick consumes 30 cycles. ⇒ nominal 6 s/tick; stored (offline) cycles replay at most 1 tick / 4 s wall-clock. `stock.nextUpdate()` resolves after each tick.

Per tick:
1. `ticksUntilCycle--`; at 0 → **market cycle** (all stocks at once): each stock with p=0.45 flips `b` and sets `otlkMagForecast = 100 − otlkMagForecast`; reset counter to 75; darknet promotion charges ×0.4 (`:219-232`). Initial counter `randInt(1,75)` (`:204`).
2. `v = Math.random()` — **one draw shared by all stocks**.
3. Per stock: `vol = mv · darknetVolMult(sym)`; `av = v·vol/100`; `pUp = (50 ± otlkMag)/100` (+ if bull `b`); if `price ≥ cap`: `pUp = 0.1, b = false`.
4. Up with prob `pUp`: `price ×= (1+av)`, else `price /= (1+av)`; then process limit/stop orders against the new price (fills at market via normal buy/sell) (`OrderProcessing.tsx:60-96`).
5. `Δ = otlkMag·av` (if `otlkMag ≤ 1` → `Δ=1`; if `<5` → `Δ·=10`); `cycleForecast(Δ)`: with prob `(50 + clamp(otlkMagForecast − absForecast, −45, 45))/100` the absolute forecast moves Δ *toward* `otlkMagForecast`, else away; `otlkMag` capped at 50, negative → flip `b` (`Stock.ts:174-196, 235-239`).
6. `cycleForecastForecast(Δ/2)`: `otlkMagForecast ± Δ/2` with 50/50, clamped [0,100] (`Stock.ts:202-208`).
7. `shareTxUntilMovement = min(+10, shareTxForMovement)`.

Visible forecast (`getForecast`) = `(50 ± otlkMag)/100` = exact P(up) this tick. Volatility (`getVolatility`) = `vol/100` = max fractional move.

Expected log-return per tick ≈ `(2·pUp − 1) · ln(1 + E[v]·vol/100)`, `E[v]=0.5`.

### 7.3 Stock parameters (`data/InitStockMetadata.ts`; ranges uniform-int, `/divisor`)

`cap = randInt(1e3·price, 25e3·price)`; `totalShares = round(marketCap/price / 1e5)·1e5`; **`maxShares` = round(0.2·totalShares/1e5)·1e5** (long+short combined) (`Stock.ts:126-151`).

| sym | org (=server org) | b | otlkMag | initPrice | mv % | spread % | shareTxForMovement | marketCap |
|---|---|---|---|---|---|---|---|---|
| ECP | ECorp | bull | 19 | 17k–28k | 0.4–0.5 | 0.1–0.5 | 30k–90k | 2.4e12 |
| MGCP | MegaCorp | bull | 19 | 24k–34k | 0.4–0.5 | 0.1–0.5 | 30k–90k | 2.4e12 |
| BLD | Blade Industries | bull | 13 | 12k–25k | 0.7–0.8 | 0.1–0.6 | 30k–90k | 1.6e12 |
| CLRK | Clarke Incorporated | bull | 12 | 10k–25k | 0.65–0.75 | 0.1–0.5 | 30k–90k | 1.5e12 |
| OMTK | OmniTek Incorporated | bull | 12 | 32k–43k | 0.6–0.7 | 0.1–0.6 | 30k–90k | 1.8e12 |
| FSIG | Four Sigma | bull | 17 | 50k–80k | 1–1.1 | 0.1–1 | 30k–90k | 2.0e12 |
| KGI | KuaiGong International | bull | 10 | 16k–28k | 0.75–0.85 | 0.1–0.7 | 30k–90k | 1.9e12 |
| FLCM | Fulcrum Technologies | bull | 16 | 29k–36k | 1.2–1.3 | 0.1–1 | 30k–90k | 2.0e12 |
| STM | Storm Technologies | bull | 7 | 20k–25k | 0.8–0.9 | 0.2–1 | 36k–108k | 1.2e12 |
| DCOMM | DefComm | bull | 10 | 6k–19k | 0.6–0.7 | 0.2–1 | 36k–108k | 9.0e11 |
| HLS | Helios Labs | bull | 9 | 10k–18k | 0.55–0.65 | 0.2–1 | 36k–108k | 8.25e11 |
| VITA | VitaLife | bull | 7 | 8k–14k | 0.7–0.8 | 0.2–1 | 36k–108k | 1.0e12 |
| ICRS | Icarus Microsystems | bull | 7.5 | 12k–24k | 0.6–0.7 | 0.3–1 | 36k–108k | 8.0e11 |
| UNV | Universal Energy | bull | 10 | 16k–29k | 0.5–0.6 | 0.2–1 | 36k–108k | 9.0e11 |
| AERO | AeroCorp | bull | 6 | 8k–17k | 0.55–0.65 | 0.3–1 | 42k–126k | 6.4e11 |
| OMN | Omnia Cybersystems | bull | 4.5 | 6k–15k | 0.65–0.75 | 0.4–1.1 | 42k–126k | 6.0e11 |
| SLRS | Solaris Space Systems | bull | 8.5 | 14k–28k | 0.7–0.8 | 0.4–1.2 | 42k–126k | 7.05e11 |
| GPH | Global Pharmaceuticals | bull | 10.5 | 12k–30k | 0.55–0.65 | 0.4–1 | 42k–126k | 6.95e11 |
| NVMD | Nova Medical | bull | 5 | 15k–27k | 0.7–0.8 | 0.4–1.1 | 42k–126k | 6.0e11 |
| WDS | Watchdog Security | bull | 1.5 | 4k–8.5k | 2.4–2.6 | 0.5–1.2 | 12k–54k | 4.5e11 |
| LXO | LexoCorp | bull | 6 | 4.5k–8k | 1.15–1.35 | 0.5–1.2 | 36k–108k | 3.0e11 |
| RHOC | Rho Construction | bull | 1 | 2k–7k | 0.5–0.7 | 0.3–1 | 60k–126k | 1.8e11 |
| APHE | Alpha Enterprises | bull | 10 | 4k–8.5k | 1.75–2.05 | 0.5–1.6 | 30k–90k | 2.4e11 |
| SYSC | SysCore Securities | bull | 3 | 3k–8k | 1.5–1.7 | 0.5–1.2 | 15k–90k | 2.0e11 |
| CTK | CompuTek | bull | 4 | 1k–6k | 0.8–1 | 0.4–1.2 | 60k–126k | 1.85e11 |
| NTLK | NetLink Technologies | bull | 1 | 1k–5k | 2–4 | 0.5–2 | 18k–54k | 5.8e10 |
| OMGA | Omega Software | bull | 0.5 | 1k–8k | 0.9–1.1 | 0.4–1.3 | 30k–90k | 6.0e10 |
| FNS | FoodNStuff | bear | 1 | 500–4.5k | 0.7–0.8 | 0.6–1 | 60k–180k | 4.5e10 |
| SGC | Sigma Cosmetics | bull | 0 | 1.5k–3.5k | 1–2.75 | 0.6–1.4 | 20k–70k | 3.0e10 |
| JGN | Joe's Guns | bull | 1 | 250–1.5k | 2–3.5 | 0.6–1.4 | 15k–52k | 4.2e10 |
| CTYS | Catalyst Ventures | bull | 13.5 | 250–1.5k | 1.2–1.75 | 0.5–1.4 | 24k–72k | 1.0e11 |
| MDYN | Microdyne Technologies | bull | 8 | 15k–30k | 0.7–0.8 | 0.3–1 | 90k–216k | 3.6e11 |
| TITN | Titan Laboratories | bull | 11 | 12k–24k | 0.5–0.7 | 0.2–1 | 90k–216k | 4.2e11 |

### 7.4 Trading mechanics (`BuyingAndSelling.tsx`, `StockMarketHelpers.ts`)

| | Price used | Cost/gain |
|---|---|---|
| Buy long | ask = `price·(1+spread/100)` | `shares·ask + 100k` |
| Sell long | bid = `price·(1−spread/100)` | `shares·bid − 100k` |
| Open short | bid | `shares·bid + 100k` |
| Close short | ask | `shares·avgShortPx + (avgShortPx − ask)·shares − 100k` |

- **Trades never move the price.** They only erode the forecast: every `shareTxForMovement` shares (counter regenerates +10/tick) → `otlkMag −= 0.006` (floor 5) and `otlkMagForecast` moves 0.006·mv/100 toward 50 (`StockMarketHelpers.ts:70-109`, `Stock.ts:246-265`).
- Share sale profits from scripts count toward script income stats but not `moneySourceA.hacking` (offline income).

### 7.5 Influence from hacking / work (`PlayerInfluencing.ts`)

With `{stock: true}`, for servers whose `organizationName` equals a stock's org name:
- hack: with prob `drained/M` → `otlkMagForecast −= 0.1`
- grow: with prob `grown/M` → `otlkMagForecast += 0.1`
- Company work: prob `0.002·cycles` → `+0.001·performance`.

This moves the *target* of the forecast random walk, not price directly. BN8: `ScriptHackMoneyGain = 0` (no hack income) but draining still works → manipulation is the hacking use-case there.

Darknet `dnet.promoteStock` adds charges `threads·(500+cha)/500`; volatility multiplier `1 + (1−e^{−0.001c}) + 2(1−e^{−0.00015c})` (≤ 4×), charges ×0.4 each market cycle (`DarkNet/effects/effects.ts:197-209`, `NetscriptFunctions/Darknet.ts:590-598`).

### 7.6 Predictability

- With 4S TIX API the per-tick up-probability is known exactly; optimal policy ≈ hold long when `forecast > 0.5 + ε`, short when `< 0.5 − ε` (SF8.2), exit on sign change. Forecast flips are synchronized across all stocks every 75 ticks (7.5 min) with p=0.45 each.
- Without 4S: estimate `pUp` from the up/down sequence (price moves are exactly ±`av` multiplicative with a shared `v`, so direction is observable each tick). Rolling-window frequency estimators work; the shared cycle boundary can be inferred from simultaneous regime changes. `getVolatility` is 4S-only but realized |log-return|/E[v] estimates `mv`.
- RNG is `Math.random` (unseeded, not exposed); no deterministic exploit, but the model is fully known.
- Capacity limit: `maxShares` per stock (e.g. ECP ≈ 2.4e12/22k·0.2 ≈ 21.8m shares ≈ $480b), and forecast erosion per traded block.

---

## 8. `ns.share()` — faction reputation (`src/NetworkShare/Share.ts`)

- RAM 2.4 GB (script ≥4.0 GB/thread). Each call holds for `ShareBonusTime = 10 s` (wall-clock) (`NetscriptFunctions.ts:394-403`).
- `effThreads = threads · intBonus(2) · coreBonus(hostCores)`; global `shareThreads = 1 + Σ active effThreads`; **bonus = 1 + ln(shareThreads)/25** (`Share.ts:22-49`).
- Applied as a multiplier on faction **work** rep only: fully on hacking contracts; on field/security work only the `(hack+int)` term (`PersonObjects/formulas/reputation.ts:16-52`). Not company rep, not passive rep.
- UI alternative: Faction page "share" (home RAM, 4 GB/thread) (`Faction/ui/ShareOption.tsx`).
- `getSharePower` 0.2 GB; `formulas.reputation.sharePower(threads, cores)` 0 GB.
- Scale: 1k threads → ×1.28; 10k → ×1.37; 1m → ×1.55 (log-scaling; diminishing).

---

## 9. Formulas API (`src/NetscriptFunctions/Formulas.ts`)

All `ns.formulas.*` cost **0 GB** (`RamCostGenerator.ts:669-738`) but throw unless `Formulas.exe` is on home (`Formulas.ts:61-65`). Source: buy $5b, create at hack 1000, or SF5 (granted every reset, `Prestige.ts:93-95,277-279`). Inputs are arbitrary `Server`/`Person` objects (use `mockServer()`/`mockPlayer()` to model hypothetical states).

| Namespace | Functions |
|---|---|
| `hacking` | `hackChance, hackExp, hackPercent, growPercent (multiplier), growThreads (exact, incl. +threads), growAmount, hackTime, growTime, weakenTime (ms), weakenEffect(threads, cores)` (`:167-246`) |
| `hacknetNodes` | `moneyGainRate, levelUpgradeCost, ramUpgradeCost, coreUpgradeCost, hacknetNodeCost, constants` |
| `hacknetServers` | `hashGainRate, level/ram/core/cacheUpgradeCost, hashUpgradeCost, hacknetServerCost, constants` |
| `reputation` | `calculateFavorToRep, calculateRepToFavor, repFromDonation, donationForRep, sharePower` |
| `skills` | `calculateSkill(exp, mult)`, `calculateExp(skill, mult)` — skill = `floor(mult·(32·ln(exp+534.6) − 200))` (`PersonObjects/formulas/skill.ts`) |
| `work` | `crimeSuccessChance, crimeGains, gymGains, universityGains, factionGains, companyGains` |
| `gang`, `bladeburner`, `dnet` | (out of scope) |

Gaps: no stock formulas; `hackTime` etc. take the server's *current* `hackDifficulty` from the object you pass.

---

## 10. BitNode multipliers affecting this domain

Values from `getBitNodeMultipliers(n, SF12+1)` (`BitNode/BitNode.tsx:570-1128`; current node: `:1130`). BN12 shown at lvl 1 (`inc = 1.02^lvl`, `dec = 1/inc`; `ServerMaxMoney = dec²`).

| field | BN1 | BN2 | BN3 | BN4 | BN5 | BN6 | BN7 | BN8 | BN9 | BN10 | BN11 | BN12 | BN13 | BN14 | BN15 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| HackingLevelMultiplier | 1 | 0.8 | 0.8 | 1 | 1 | 0.35 | 0.35 | 1 | 0.5 | 0.35 | 0.6 | dec | 0.25 | 0.4 | 0.6 |
| HackingSpeedMultiplier | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 0.3 | 0.6 |
| HackExpGain | 1 | 1 | 1 | 0.4 | 0.5 | 0.25 | 0.25 | 1 | 0.05 | 1 | 0.5 | dec | 0.1 | 1 | 1 |
| ScriptHackMoney | 1 | 1 | 0.2 | 0.2 | 0.15 | 0.75 | 0.5 | 0.3 | 0.1 | 0.5 | 1 | dec | 0.2 | 0.3 | 1 |
| ScriptHackMoneyGain | 1 | 1 | 1 | 1 | 1 | 1 | 1 | **0** | 1 | 1 | 1 | 1 | 1 | 1 | 1 |
| ManualHackMoney | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 0 | 1 | 0.5 | 1 | dec | 1 | 1 | 1 |
| ServerMaxMoney | 1 | 0.08 | 0.04 | 0.1125 | 1 | 0.2 | 0.2 | 1 | 0.01 | 1 | 0.01 | dec² | 0.3375 | 0.7 | 0.8 |
| ServerStartingMoney | 1 | 0.4 | 0.2 | 0.75 | 0.5 | 0.5 | 0.5 | 1 | 0.1 | 1 | 0.1 | dec | 0.75 | 0.5 | 0.5 |
| ServerGrowthRate | 1 | 0.8 | 0.2 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 0.2 | dec | 1 | 1 | 1 |
| ServerStartingSecurity | 1 | 1 | 1 | 1 | 2 | 1.5 | 1.5 | 1 | 2.5 | 1 | 1 | 1.5 | 3 | 1.5 | 1.5 |
| ServerWeakenRate | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 2 | dec | 1 | 1 | 1 |
| HomeComputerRamCost | 1 | 1 | 1.5 | 1 | 1 | 1 | 1 | 1 | 5 | 1.5 | 1 | inc | 1 | 1 | 1 |
| CloudServerCost | 1 | 1 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 5 | 1 | inc | 1 | 1 | 1 |
| CloudServerSoftcap | 1 | 1.3 | 1.3 | 1.2 | 1.2 | 2 | 2 | 4 | 1 | 1.1 | 2 | inc | 1.6 | 1 | 1 |
| CloudServerLimit | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | **0** | 0.6 | 1 | dec | 1 | 1 | 1 |
| CloudServerMaxRam | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 0.5 | 1 | dec | 1 | 1 | 1 |
| HacknetNodeMoney | 1 | 1 | 0.25 | 0.05 | 0.2 | 0.2 | 0.2 | **0** | 1 | 0.5 | 0.1 | dec | 0.4 | 0.25 | 1 |
| FourSigmaMarketDataCost | 1 | 1 | 1 | 1 | 1 | 1 | 2 | 1 | 5 | 1 | 4 | inc | 10 | 1 | 1 |
| FourSigmaMarketDataApiCost | 1 | 1 | 1 | 1 | 1 | 1 | 2 | 1 | 4 | 1 | 4 | inc | 10 | 1 | 1 |
| CodingContractMoney | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 0 | 1 | 0.5 | 0.25 | dec | 0.4 | 1 | 1 |
| CrimeMoney | 1 | 3 | 0.25 | 0.2 | 0.5 | 0.75 | 0.75 | 0 | 0.5 | 0.5 | 3 | dec | 0.4 | 0.75 | 1 |
| WorldDaemonDifficulty | 1 | 5 | 2 | 3 | 1.5 | 2 | 2 | 1 | 2 | 2 | 1.5 | inc | 3 | 5 | 2 |
| DarknetMoneyMultiplier | 1 | 1 | 0.4 | 0.4 | 0.7 | 1 | 1 | 0 | 0.05 | 0.4 | 1 | dec | 0.1 | 1 | 1 |

Mechanic → multiplier map: hack chance (none), hack fraction (`ScriptHackMoney`), hack credit (`ScriptHackMoneyGain`/`ManualHackMoney`), time (`HackingSpeedMultiplier`), XP (`HackExpGain`; skill via `HackingLevelMultiplier`), grow (`ServerGrowthRate`), weaken (`ServerWeakenRate`), server init (`ServerMaxMoney`, `ServerStartingMoney`, `ServerStartingSecurity`, `WorldDaemonDifficulty`), purchases (`HomeComputerRamCost`, `CloudServer*`), hacknet (`HacknetNodeMoney` — applies to hashes too), stocks (`FourSigma*`). `getBitNodeMultipliers()` needs SF5 (4 GB).

## 11. Randomness inventory

| Where | RNG |
|---|---|
| Server stats, cores, network links, IPs | per BN start / aug install (`ServerHelpers.ts:342-406`) |
| Hack success | `Math.random() < chance` at completion (`NetscriptHelpers.tsx:562-566`) |
| Stocks | init params, cap, initial cycle counter; per tick: shared `v`, per-stock direction, forecast walk, cycle flips; hack/grow influence rolls |
| Coding contracts | every 10 min (3000 cycles) + offline (`engine.tsx:210-213, 267`) |
| Everything else here (grow, weaken, hacknet, costs) | deterministic |

## 12. Other money sources (pointers only)

- Crime: `src/Crime/Crimes.ts`, `BN.CrimeMoney`; `formulas.work.crimeGains`.
- Coding contracts: `CONSTANTS.CodingContractBaseMoneyGain = 75e6` × difficulty × `BN.CodingContractMoney` (`PlayerObjectGeneralMethods.ts:560`); separate agent covers.
- Darknet (3.0 new: caches, phishing, labyrinth): `src/DarkNet/*`, `BN.DarknetMoneyMultiplier`.
- Infiltration (`BN.InfiltrationMoney`), corporation dividends, gang income, company salary — other docs.
- Starting money: $1,262 (`1000 + CONSTANTS.Donations`, `PlayerObjectGeneralMethods.ts:102`); BN8: $250m (`Prestige.ts:38`).

---

## 13. Implications for automation

### 13.1 HWGW batch arithmetic (exact)

At target state (sec = minSec, money = M), host cores `c`, `w = 0.05·coreBonus(c)·BN.ServerWeakenRate`:
```
p   = formulas.hacking.hackPercent(server@min, player)          // per thread
H   = floor(f / p)                                             // f = desired drain fraction
W1  = ceil(0.002·H / w)
G   = formulas.hacking.growThreads(server{money: M·(1−f·χ)}, player, M, cGrow)   // χ>1 buffer for skill drift
W2  = ceil(0.004·G / w)
Th = hackTime(server@min); Tg = 3.2·Th; Tw = 4·Th
```
Landing order H → W1 → G → W2 (or H→G→W combined). RAM·time per batch (JIT launch): `1.7·H·Th + 1.75·G·3.2Th + 1.75·(W1+W2)·4Th`; with all jobs launched at once and padded via `additionalMsec`, every job costs `4·Th`.

For small `f`: `G ≈ f/k`, `H = f/p` ⇒ income per GB·s ≈ `chance·M·p / (Th·(1.98 + 6.16·p/k))` (1 core) — **independent of f**; large `f` costs extra grow (`ln(1/(1−f)) > f`). So: RAM-bound → any small f is fine; scheduler-bound → raise f.

### 13.2 What limits throughput

1. **RAM** (home ≤ 1 EB, 25 cloud × 1 PB, foreign servers ~ few TB, hacknet servers ≤ 20 × 8 TB with hash loss).
2. **Event loop**: all jobs share the renderer thread; timers are ms-granular with load-dependent jitter. Practical spacing between landings ≈ 5–20 ms ⇒ ≤ ~50–200 batches/s across all targets. Fewer, fatter scripts (many threads per process) are far cheaper than many small processes.
3. **Per-target money**: income ≤ `f·M·chance / δ` per target; spread across targets once one target saturates the scheduler.
4. **Skill drift**: XP from landed jobs raises skill instantly → later hacks steal more (fraction evaluated at landing) and later launches are shorter. Mitigate with grow buffer (grow over-provision is free security-wise, §1.3) or periodic re-calibration.
5. **Launch-time security**: duration is fixed from security at launch. Robust approach: compute the *actual* duration with `formulas.hacking.*Time` on the live server object and set `additionalMsec = targetLand − now − actual` (must be ≥ 0). This removes the classic "launch only in safe windows" constraint.

### 13.3 Leverage points

- **Lowering min security is the biggest single lever**: time ∝ `2.5·req·sec + 500`; fraction ∝ `100 − sec`; growth rate maxes once `sec ≤ 8.57`. With SF9, "Reduce Minimum Security" (0.98×/purchase, global level cost 50·(L+1)) takes ecorp 33→1 in ~173 purchases (~7.5e5 hashes) for ~28× faster cycles (req≈1225). Pair with "Increase Maximum Money" (1.02×, soft cap above $10t). Both reset on aug install; level cost is global so concentrate on one target.
- **Cores for grow/weaken**: hacknet servers (cores ≤ 128 → ×8.94), home (≤ 8 → ×1.44), deep foreign servers (≤ 15 → ×1.875). Hack is core-independent → put H on 1-core cloud servers and G/W on high-core hosts.
- **Cloud upgrades** cost only the price difference → buy small early, upgrade in place; nothing refunded on delete.
- **Hacknet hash overflow auto-sells** → no need to babysit capacity for money; spend hashes only on better-than-$250k/hash upgrades.
- **Share** is logarithmic: a few thousand threads gives most of the benefit (×1.3–1.4); idle RAM in faction-grinding phases.
- **Stock (BN8 / post-4S)**: 4S TIX API gives exact `pUp`; the market is a solvable Markov model. `{stock:true}` hack/grow nudges second-order forecast (±0.1 per event) — useful in BN8 where hacking pays nothing.

### 13.4 Exploitable quirks (by-design or sloppy)

| Quirk | Use |
|---|---|
| Grow on a server at `M`: full XP, **zero** security change, duration 3.2·Th (vs weaken 4·Th) | Best pure XP farm: maximize `(3+0.3·baseSec)/(2.5·req·minSec+500)` — joesguns ≈ foodnstuff early (≈1.8× n00dles) |
| Grow security uses only threads actually needed; hack security capped at threads to drain 100% | Over-provision G freely; overkill H doesn't spike security |
| `threads` option accepts fractional values ≤ script threads | Fine-grained hack amounts from one long-lived worker |
| Successful terminal `hack` / `manualHack` installs a backdoor | Alternative backdoor path |
| RAM analysis keys on identifier *names*; dynamic check only covers NS calls | Avoid naming locals after NS functions; DOM/`globalThis` access through computed names is free (UI automation pre-SF4) |
| Offline money = 0.75 × average hacking income since last install | Closing the game after a long high-income period is "paid"; restart-safe daemons required (scripts restart from `main`) |
| Hacknet server `cpuCores = cores` | Weaken/grow host with up to 8.94× efficiency |
| `stock.purchaseWseAccount/TixApi/4S*` need no SF | Fully scriptable stock access from BN1 |
| Stock trades don't move price | Only forecast erosion limits size; `maxShares` is the hard cap |

### 13.5 Pre-SF4 UI dependencies

Without SF4 (or the free `document` trick), these require UI: TOR purchase, darkweb `buy`, program creation, home RAM/core upgrades, backdoors (terminal), faction joins, aug purchase/install. Scriptable without any SF: hack/grow/weaken, nuke/port openers, cloud servers, hacknet (nodes/servers/hashes), stock market (incl. purchases), share, formulas (if Formulas.exe present).

### 13.6 Headless / time-accelerated simulator notes

- Two clocks: (a) `setTimeout` ms for script-driven actions (HGW, sleep, share, backdoor via singularity, dnet), (b) 200 ms game cycles for passive systems (hacknet, terminal actions, work incl. crime/rep/program creation, stocks, gang/corp/bladeburner/sleeves). A discrete-event sim can model (a) as events at `t + duration_ms` and (b) as `floor(Δt/200)` cycles.
- Hidden wall-clock gates: stock ticks need ≥ 4000 ms real `Date.now()` spacing (`StockMarket.ts:247-248`); `Engine.start` uses `Date` diffs; offline uses `Date`. If running real game code under fake timers, mock `Date`, `performance.now` (TimeCompression exploit detector: 15 s timer, <500 ms ⇒ grants SF-1 "TimeCompression", harmless), and `window.setTimeout`.
- Deterministic pieces to port verbatim: §1 formulas, `numCycleForGrowthCorrected`, hacknet formulas, costs. Stochastic: hack success, stock walk (port §7.2 exactly incl. shared `v`), server init draws (use ranges or sample).
- Order-of-evaluation matters: HGW effects read state at completion; durations read state at launch; skill updates immediately on XP.
- Aug install resets: servers (rebuilt + re-randomized), cloud servers, hacknet + hash upgrades, TOR, programs, ports, PIDs, stocks (positions), money→$1,262; keeps home RAM/cores and stock access flags.

### 13.7 Open questions

- Actual sustainable job landing spacing in the Steam/Electron build under load (needs measurement; determines scheduler-bound income).
- Optimal hash allocation between "Reduce Minimum Security", "Increase Maximum Money" and "Sell for Money" per BN (computable via §1 + §6 formulas; not yet modeled).
- Darknet money/stock-volatility interaction (`promoteStock`) for stock strategies — needs the darknet doc.
- Offline income fidelity: per-script grow/weaken offline replay over-counts weaken by a factor of `threads` (`ScriptHelpers.ts:87-90` uses thread-weighted counts × `threads`) — benign (sec floors at min) but worth noting for a simulator.

### 13.8 Changes in 3.0.2 (dev branch, `bitburner-src`)

No changes to `Hacking.ts`, `grow.ts`, hacknet formulas/constants, share, or stock tick math. Relevant diffs: stock `otlkMag` cap now applied after the sign flip (`Stock.ts` cycleForecast) and a 10-entry `priceHistory` per stock; home port flags reset on aug install; servers may carry "discoverable scripts"; new `isFullPort/isEmptyPort` (0 GB); BN mult tweaks limited to Darknet/charisma fields.
