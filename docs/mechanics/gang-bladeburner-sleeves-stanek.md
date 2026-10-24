# Gangs, Bladeburner, Sleeves, Stanek's Gift: mechanics reference (Bitburner v3.0.1)

Source: `vendor/bitburner-src` (v3.0.1). All `file:line` refs are relative to `vendor/bitburner-src/src/`.
"Cycle" = one engine tick = 200 ms (`CONSTANTS.MilliPerCycle`). `rand()` = `Math.random()` in [0,1).
`addOffset(x,10)` = uniform in [0.9x, 1.1x] (`utils/helpers/addOffset.ts:13-21`).

---

## 0. Cross-cutting

### 0.1 Access gates

| Mechanic | Unlock condition | Source |
|---|---|---|
| Create gang | In BN2: always (no karma needed). Elsewhere: active SF2 ≥1 **and** karma ≤ −54,000. Must be a member of one of the 7 gang factions. Blocked by `bitNodeOptions.disableGang`. | `PersonObjects/Player/PlayerObjectGangMethods.ts:12-30`, `Gang/helpers.ts:6-26`, `Gang/data/Constants.ts:27` |
| Gang API | Only requires `Player.gang` to exist (no SF check beyond creation). | `NetscriptFunctions/Gang.ts:20-23` |
| Join Bladeburner | In BN6/BN7 or with SF6 or SF7 (active lvl >0); BN mult `BladeburnerRank ≠ 0` (BN8 = 0 → impossible); str/def/dex/agi ≥ 100. UI: Sector-12 NSA. API: `bladeburner.joinBladeburnerDivision()` works from anywhere. | `PlayerObjectBladeburnerMethods.ts:6-8`, `NetscriptFunctions/Bladeburner.ts:332-366`, `Locations/ui/SpecialLocation.tsx:62-116` |
| Bladeburner API | Same: BN6/BN7 or SF6 or SF7 (not only SF7). | `NetscriptFunctions/Bladeburner.ts:34-43` |
| Sleeves exist | `min(3, SF10lvl + (BN==10 ? 1 : 0)) + sleevesFromCovenant` (covenant max 5) → max 8. Uses **raw** `sourceFileLvl` (overrides ignored). | `PersonObjects/Sleeve/SleeveCovenantPurchases.tsx:58-73` |
| Sleeve API | BN10 or active SF10 >0. `purchaseSleeve`/`upgradeMemory` additionally require being **in BN10** and a member of The Covenant. | `NetscriptFunctions/Sleeve.ts:24-28,51-58,304-322`, `SleeveCovenantPurchases.tsx:29-56,86-113` |
| Accept Stanek's Gift | BN13 or SF13; **no augmentations installed or queued other than NeuroFlux**. UI: Chongqing church. API `stanek.acceptGift()` has **no location requirement**. | `CotMG/Helper.tsx:59-74`, `NetscriptFunctions/Stanek.ts:120-139`, `Locations/ui/SpecialLocation.tsx:274-330` |
| Stanek API (other fns) | Must have `Stanek's Gift - Genesis` installed. | `NetscriptFunctions/Stanek.ts:17-21` |
| CotMG ban | Outside BN13, installing augs while not having the gift (and owning any non-NFG aug) bans CotMG for the rest of the BN. | `Prestige.ts:184-191` |
| SF7.3 trap | With active SF7 ≥3, joining Bladeburner immediately grants `The Blade's Simulacrum` (a non-NFG aug) → you can no longer accept Stanek's Gift. UI warns; **API join does not**. | `PlayerObjectBladeburnerMethods.ts:10-20`, `SpecialLocation.tsx:77-96` |

### 0.2 Engine timing / bonus (offline) time

| System | Normal processing | With stored bonus cycles | Source |
|---|---|---|---|
| Gang | `process()` every cycle; acts when ≥10 stored cycles (2 s), processes `min(stored, 25)` | 25 cycles per engine cycle → **~25×** | `Gang/Gang.ts:99-121`, `Gang/data/Constants.ts:29-31`, `engine.tsx:106` |
| Gang territory/power | every 100 gang cycles (20 s) | ~every 0.8 s real | `Gang.ts:180-182`, `Constants.ts:12` |
| Bladeburner | `storeCycles` every cycle, `process()` every 5 cycles (1 s), ≤5 s per call | **5×** | `engine.tsx:118,157,200-202`, `Bladeburner.ts:1376-1380` |
| Sleeves | acts every 5 cycles; `min(stored,15)` per call | **~15×** | `Sleeve.ts:263-275` |
| Stanek charge | `chargeFragment` takes 1000 ms | 200 ms while ≥5 stored cycles (consumes 5 cycles) → 5× | `NetscriptFunctions/Stanek.ts:47-56`, `CotMG/StaneksGift.ts:46-62` |

`ns.gang.nextUpdate()` / `ns.bladeburner.nextUpdate()` (0 GB) resolve after each process with ms simulated (`Gang.ts:116-120`, `Bladeburner.ts:1424-1428`).

### 0.3 BitNode multipliers that matter here (`BitNode/BitNode.tsx:570-1120`)

| BN | GangSoftcap | GangUniqueAugs | BladeburnerRank | BladeburnerSkillCost | StaneksGiftPowerMultiplier | StaneksGiftExtraSize |
|---|---|---|---|---|---|---|
| 1 | 1 | 1 | 1 | 1 | 1 | 0 |
| 2 | 1 | 1 | 1 | 1 | 2 | −6 |
| 3 | 0.9 | 0.5 | 1 | 1 | 0.75 | −2 |
| 4 | 1 | 0.5 | 1 | 1 | 1.5 | 0 |
| 5 | 1 | 0.5 | 1 | 1 | 1.3 | 0 |
| 6 | 0.7 | 0.2 | 1 | 1 | 0.5 | +2 |
| 7 | 0.7 | 0.2 | 0.6 | 2 | 0.9 | −1 |
| 8 | **0** | 0 | **0 (BB disabled)** | 1 | 1 | −99 |
| 9 | 0.8 | 0.25 | 0.9 | 1.2 | 0.5 | +2 |
| 10 | 0.9 | 0.25 | 0.8 | 1 | 0.75 | −3 |
| 11 | 1 | 0.75 | 1 | 1 | 1 | 0 |
| 12 (lvl L) | 0.8 | 1/1.02^L | 1/1.02^L | 1.02^L | 1.02^L | 1.02^L |
| 13 | 0.3 | 0.1 | 0.45 | 2 | 2 | +1 |
| 14 | 0.7 | 0.4 | 0.6 | 2 | 0.5 | −1 |
| 15 | 1 | 0.3 | 0.2 | 3 | 0.7 | −2 |

Other mults that touch these systems: `FactionWorkRepGain`/`CompanyWorkRepGain`/`CrimeMoney`/`CrimeExpGain`/`*LevelMultiplier` (sleeve work, via shared work formulas), `AugmentationRepCost` (sleeve aug rep gate, Stanek Gift 2/3 rep).

---

## 1. Gangs

### 1.1 Creation

* Gang factions (`Gang/data/Constants.ts:18-26`): Slum Snakes, Tetrads, The Syndicate, The Dark Army, Speakers for the Dead (combat); **NiteSec, The Black Hand = hacking** (type fixed by faction, not chosen: `NetscriptFunctions/Gang.ts:49`, `Faction/ui/CreateGangModal.tsx:33-35`).
* Easiest faction invite: Slum Snakes = combat 30, $1m, karma ≤ −9 (`Faction/FactionInfo.tsx:662-669`).
* Creating sets that faction's rep to 0 (`PlayerObjectGangMethods.ts:56-68`).
* Gang faction: no faction work, no donations, **no passive rep** (`Faction/FactionHelpers.tsx:150-153`, `NetscriptFunctions/Singularity.ts:808-810,934-935`). Sleeves can't work it (`Sleeve/Work/SleeveFactionWork.ts:46`).
* Gang faction sells (almost) **every non-special augmentation**: all multi-faction augs + its own + each other single-faction aug kept with probability `GangUniqueAugs` using a seeded RNG `SFC32RNG("BN{n}.{SFlvl}")` → deterministic per BN/SF level. TRP only in BN2. (`FactionHelpers.tsx:172-202`)
* Karma: player crime success −`crime.karma`, failure −karma/4, × focus penalty (`Work/CrimeWork.ts:68-84`). Homicide: 3 s, karma 3 (`Crime/Crimes.ts:139-160`). Sleeve crime: −`karma × sync/100`, **success only** (`Sleeve/Work/SleeveCrimeWork.ts:44-49`). BB kill contract/op success −1, kill black op −15 (`Bladeburner.ts:970-972,1050-1052`). Darknet caches −(difficulty+1) (`DarkNet/effects/cacheFiles.ts:37-38`). Karma resets to 0 only on BN change (`PlayerObjectGeneralMethods.ts:146`).

### 1.2 Recruitment

* 3 free members; member n+1 (n ≥ 3 current) needs respect ≥ `5^(n−2)`: 4th=5, 5th=25, 6th=125 … 12th=5^9≈1.95e6. Max 12. (`Gang.ts:316-323`, `Constants.ts:6-11`)
* Threshold compares **current** respect (which drops on ascension/death).

### 1.3 Member stats

```
level = max(1, floor(mult * (32*ln(exp+534.5) - 200)))         GangMember.ts:70-72
mult  = equipmentMult(stat) * ascMult(stat)                       GangMember.ts:78-85
ascMult(points) = max(1, sqrt(points/2000))                       formulas.ts:79-81
exp gain/cycle (per stat) = (weight/1500) * difficulty^0.9
                            * ((equipMult-1)/4 + 1) * ascMult      GangMember.ts:141-210
```
Training tasks: Train Combat (25 each str/def/dex/agi, diff 100), Train Hacking (diff 45), Train Charisma (diff 8) (`Gang/data/tasks.ts:354-380`).

### 1.4 Task formulas (`Gang/formulas/formulas.ts`)

```
W(task) = Σ_s (weight_s/100) * memberStat_s
terrMult(f) = max(0.005, (territory*100)^f / 100)          // f = task.territory.{respect|money|wanted}
softcapExp = (0.2*territory + 0.8) * GangSoftcap
wantedPenalty = respect / (respect + wanted)                // :11-13

respect/cycle = (11*baseRespect*(W - 4*diff)*terrMult(f_r)*wantedPenalty)^softcapExp      if W-4*diff>0   :15-31
money/cycle   = (5*baseMoney  *(W - 3.2*diff)*terrMult(f_m)*wantedPenalty)^softcapExp      if >0           :56-73
wanted/cycle  = baseWanted>0 : min(100, 7*baseWanted / (3*(W-3.5*diff)*terrMult(f_w))^0.8)                 :33-54
                baseWanted<0 : 0.4*baseWanted*(W-3.5*diff)*terrMult(f_w)
```
Note wanted gain **falls** as stats rise. Money has no BN money mult other than `GangSoftcap`. Gang income source tag `"gang"`.

Per-process wanted update (every gang process, normally 2 s): `wanted = (wanted + Σgain*cycles) * (1 − 0.001*J)` where J = # members on negative-wanted tasks; floored at 1 (`Gang.ts:157-167`). Rep: `Δrep = faction_rep * Δrespect * (1+favor/100) / 75` (`Gang.ts:152-155`, `Constants.ts:10`).

Task table (`Gang/data/tasks.ts:31-395`; weights hack/str/def/dex/agi/cha; territory exponents money/respect/wanted, default 1/1/1):

| Task | Gang | baseRespect | baseWanted | baseMoney | diff | weights | terr (m/r/w) |
|---|---|---|---|---|---|---|---|
| Ransomware | H | 5e-5 | 1e-4 | 3 | 1 | 100 hack | – |
| Phishing | H | 8e-5 | 0.003 | 7.5 | 3.5 | 85h/15c | – |
| Identity Theft | H | 1e-4 | 0.075 | 18 | 5 | 80h/20c | – |
| DDoS Attacks | H | 4e-4 | 0.2 | 0 | 8 | 100h | – |
| Plant Virus | H | 6e-4 | 0.4 | 0 | 12 | 100h | – |
| Fraud & Counterfeiting | H | 4e-4 | 0.3 | 45 | 20 | 80h/20c | – |
| Money Laundering | H | 0.001 | 1.25 | 360 | 25 | 75h/25c | – |
| Cyberterrorism | H | 0.01 | 6 | 0 | 36 | 80h/20c | – |
| Ethical Hacking | H | 0 | −0.001 | 3 | 1 | 90h/10c | – |
| Mug People | C | 5e-5 | 5e-5 | 3.6 | 1 | 25s/25d/25x/10a/15c | – |
| Deal Drugs | C | 6e-5 | 0.002 | 15 | 3.5 | 20x/20a/60c | 1.2/1/1.15 |
| Strongarm Civilians | C | 4e-5 | 0.02 | 7.5 | 5 | 10h/25s/25d/20x/10a/10c | 1.6/1.1/1.5 |
| Run a Con | C | 1.2e-4 | 0.05 | 45 | 14 | 5s/5d/25a/25x/40c | – |
| Armed Robbery | C | 1.4e-4 | 0.1 | 114 | 20 | 20h/15s/15d/10a/20x/20c | – |
| Traffick Illegal Arms | C | 2e-4 | 0.24 | 174 | 32 | 15h/20s/20d/20x/25c | 1.4/1.3/1.25 |
| Threaten & Blackmail | C | 2e-4 | 0.125 | 72 | 28 | 25h/25s/25x/25c | – |
| Human Trafficking | C | 0.004 | 1.25 | 360 | 36 | 30h/5s/5d/30x/30c | 1.5/1.5/1.6 |
| Terrorism | C | 0.01 | 6 | 0 | 36 | 20h/20s/20d/20x/20c | 1/**2**/2 |
| Vigilante Justice | both | 0 | −0.001 | 0 | 1 | 20 each h,s,d,x,a | –/–/0.9 |
| Territory Warfare | both | 0 | 0 | 0 | 5 | 15h/20s/20d/20x/20a/5c | – |

Territory leverage: at 1/7 territory, terrMult(1)=0.143, terrMult(2)=2.04; at 100%: terrMult(1)=1, (1.5)=10, (2)=100, and softcapExp rises from 0.829 to 1.0 (×GangSoftcap). Example (combat member, all stats 1000, Terrorism, penalty≈1): ~78 respect/cycle at 1/7 territory vs ~9,400/cycle at 100%. **Full territory is a ~100× respect multiplier for Terrorism and ~10× money for Human Trafficking.** Hacking-gang tasks have no territory exponent ≠1, so territory matters less for them (their money/respect still scale linearly with territory via terrMult(1)).

### 1.5 Equipment (`Gang/data/upgrades.ts:34-227`)

* Cost = `baseCost / discount`, `discount = max(1, respect^0.01 + respect/5e6 + power^0.01 + power/1e6 − 1)` (`Gang.ts:407-434`).
* Weapons/armor/vehicles/rootkits (type w/a/v/r): $1m–$225m base, lost on ascension. Augmentations (type g): $5e9–$50e9 base, **kept through ascension** (`GangMember.ts:308-319`) and installs.
* Equipment mult also boosts exp gain by (mult−1)/4.
* Notable: Graphene Bone Lacings str/def ×1.7 ($50e9), Synthetic Heart str/agi ×1.5 ($25e9), BrachiBlades str/def ×1.4 ($20e9), Bionic Legs agi ×1.6, Neuralstimulator hack ×1.15.

### 1.6 Ascension

* Points gained per stat = `max(0, exp − 1000)`; requires any >0 (`formulas.ts:75-77`, `GangMember.ts:245-248`).
* Effect: asc points added; exp → 0; non-aug equipment removed; mults recomputed from augs; **gang respect −= member.earnedRespect** (lifetime since last ascend) (`GangMember.ts:298-341`, `Gang.ts:390-404`).
* Result ratio per stat = `sqrt((P+ΔP)/2000) / sqrt(P/2000)` (with the ≥1 floor) — `getAscensionResult` returns this (`NetscriptFunctions/Gang.ts:291-300`).
* On aug install: asc points ×0.95 (`Constants.ts:16`, `Prestige.ts:133-147`). Gang (members, equipment, respect, territory) otherwise persists across installs; reset only on BN change (`PlayerObjectGeneralMethods.ts:157-158`).

### 1.7 Territory, power, clashes (`Gang.ts:173-303`, `AllGangs.ts`)

Every 100 gang cycles:
1. **Player power** += `0.015 * max(0.002, territory) * Σ_{members on Territory Warfare} (hack+str+def+dex+agi+cha)/95` — accrues whether or not warfare is engaged (`Gang.ts:189`, `362-369`, `GangMember.ts:87-89`). Only members on TW **at the tick** count.
2. **NPC power**: 50%: `+min(0.85, 0.005*power)`; 50%: `+0.75*roll*territory*PowerMultiplier` (roll∈[0.5,1)); PowerMultiplier: Slum Snakes 1, Tetrads/Syndicate/Dark Army/NiteSec 2, Speakers/Black Hand 5 (`Gang.ts:191-205`, `Gang/data/power.ts`).
3. Clash chance: engaged → 1; else decays −0.01/tick to 0 (`Gang.ts:210-216`).
4. Each gang with territory>0 (plus player) picks a random other; if player involved, clash happens with prob `territoryClashChance`. Win prob = `P_this/(P_this+P_other)`. Territory moved = `min(loserTerr, max(1, 1+ln(Pw/Pl)/ln(50)) * 0.0001 * (rand+0.5))`; then all territories renormalized to sum 1. Winner vs NPC: loser power /1.01; player losing: player power /1.008 (`Gang.ts:174-178,219-268,281-286`).
   *Quirk*: `return` (not `continue`) when the loser has 0 territory aborts the rest of that tick's clashes (`Gang.ts:237,250`).
5. Deaths: per player clash, 35% chance to evaluate; each TW member dies with `p = (won ? 0.005 : 0.01) / def^0.6` (`Gang.ts:281-303`). Death costs `0.05*respect + member.earnedRespect` respect (`Gang.ts:371-388`).

Implications: ~2 player clashes/tick × ≈0.0001–0.0003 territory each → going from 14% to 100% needs thousands of ticks (order of 10 h real time at powerBonus≈2); bonus time accelerates 25×. No deaths possible while `territoryClashChance == 0`, so power can be farmed safely with warfare disengaged.
Initial state: all 7 gangs power 1, territory 1/7 (`AllGangs.ts:11-42`).

### 1.8 Randomness

NPC power gains, clash pairing/outcomes/territory amount, deaths, gang-aug filter (seeded, deterministic per BN+SF level).

### 1.9 Gang API (RAM; `Netscript/RamCostGenerator.ts:270-298`, base 4 GB)

| Fn | GB | Fn | GB |
|---|---|---|---|
| createGang | 1 | inGang, renameMember, getTaskNames, getEquipmentNames, getBonusTime, nextUpdate | 0 |
| getMemberNames, canRecruitMember, getRecruitsAvailable, respectForNextRecruit, getTaskStats | 1 | getGangInformation, getAllGangInformation, getMemberInformation, recruitMember, setMemberTask, getEquipmentCost/Type/Stats, getAscensionResult, getInstallResult, setTerritoryWarfare | 2 |
| purchaseEquipment, ascendMember, getChanceToWinClash | 4 | formulas.gang.* (wantedPenalty, respectGain, wantedLevelGain, moneyGain, ascensionPointsGain, ascensionMultiplier) | 0 (needs Formulas.exe) |

**`gang.getOtherGangInformation` was removed in 3.0.0 — calling it throws** (`NetscriptFunctions/Gang.ts:352-354`, `Netscript/APIWrapper.ts:120-134`). Use `getAllGangInformation` (includes own gang).
UI-only: nothing essential (everything is scriptable once in a gang; gang faction invite needs normal faction-join paths).

### 1.10 Optimal-play notes

* BN2 needs no karma; elsewhere −54k karma is the gate. Fastest karma = homicide by player + sleeves (sleeve karma × sync, success-only).
* Rep for gang augs = respect/75: prioritize respect (Terrorism/Cyberterrorism), keep wanted penalty ≈1 with a few Vigilante/Ethical members; wanted gain shrinks with stats so it's self-correcting late.
* Power/territory trick: keep everyone on crimes, switch all to Territory Warfare for exactly the gang process that triggers the territory tick (every 10th normal update; track via `nextUpdate()` returned ms: tick when cumulative cycles crosses a multiple of 100), then switch back. Costs 10% of crime output for 100% of power gain.
* Engage warfare only when win prob vs every gang with territory is high; disengage → clash chance decays 0.01/tick (deaths still possible until it reaches 0).
* Ascend when the primary-stat ratio is large; ascension costs respect (=member.earnedRespect), which can drop you under recruit thresholds and raise wanted penalty.
* Buy gang-member *augmentations* (persist); temporary gear is wiped each ascension.

---

## 2. Bladeburner

### 2.1 Constants (`Bladeburner/data/Constants.ts:1-53`)

StaminaGainPerSecond 0.0085 · BaseStaminaLoss 0.285 · MaxStaminaToGainFactor 70000 · DifficultyToTimeFactor 10 · DiffMult = `d^0.28 + d/650` · EffAgi/Dex exp 0.04/0.035, linear 1e4 · BaseRecruitmentTimeNeeded 300 · PopulationThreshold 1e9, exponent 0.7 · ChaosThreshold 50 · BaseStatGain 1 · BaseIntGain 0.003 · ActionCountGrowthPeriod 480 s · RankToFactionRepFactor 2 · RankNeededForFaction 25 · Contract/Operation successes per level 3/2.5 · RanksPerSkillPoint 3 · ContractBaseMoneyGain 250k · HRC +2 HP, +1% stamina.

### 2.2 Success chance (`Bladeburner/Actions/Action.ts:169-196`)

```
competence = Σ_stat weight_s * effStat_s^decay_s          (effStat = stat * Reaper/Evasive/… skill mult; Bladeburner.ts:759-774)
           * (1 + 0.75*int^0.8/600)                          (PersonObjects/formulas/intelligence.ts:1-3)
           * min(1, stamina/(0.5*maxStamina))                (Bladeburner.ts:167-169; player's BB stamina, even for sleeves)
           * teamBonus                                       (ops & black ops: (teamCount+1)^0.05; Operation.ts:96-98)
           * (pop/1e9)^0.7                                   (black ops: 1; Action.ts:88-92, BlackOperation.ts:55-57)
           * SuccessChanceAll * [Contract|Operation mult] * [Stealth mult if isStealth] * [Kill mult if isKill]
           * person.mults.bladeburner_success_chance
difficulty = baseDifficulty * difficultyFac^(level-1)        (LevelableAction.ts:58-64)
           * (chaos>50 ? sqrt(1 + chaos - 50) : 1)           (black ops: 1; Action.ts:94-103)
chance = min(1, competence / difficulty)
```
* Raid: chance 0 and unavailable if city comms < 1 (`Operation.ts:63-68`, `Operations.ts:147-150`).
* The roll (`attempt`) uses the **true** population; `popEst` only feeds the displayed range. `getActionEstimatedSuccessChance` returns `[low, high]` built from est vs real (`Action.ts:144-167`). Population-estimate actions (Field Analysis, Investigation, Undercover, Tracking, Datamancer) therefore have **zero effect on outcomes**, only on information.
* City = the Bladeburner object's `city` (switchCity is free/instant via API: `NetscriptFunctions/Bladeburner.ts:316-321`). Sleeve BB actions also use the player's BB city.

### 2.3 Action time (`Action.ts:105-122`)

```
statFac = 0.5*(effAgi^0.04 + effDex^0.035 + effAgi/1e4 + effDex/1e4)
time_s  = ceil( max(1, (difficulty/10) * OverclockMult / statFac) * (blackOp ? 1.5 : 1) )
```
(difficulty here excludes chaos). General actions: Training 30, Field Analysis 30, Diplomacy 60, HRC 60, Incite Violence 60, Recruitment `max(10, round(300 − (effCha^0.81 + effCha/90)))` (`data/GeneralActions.ts`). Processing granularity 1 s; overflow carries to next action (`Bladeburner.ts:1296-1317`).

### 2.4 Rewards, losses, stamina (`Bladeburner.ts:891-1251`, `Formulas.ts`)

| Item | Formula | Source |
|---|---|---|
| Rank gain (contract/op success) | `addOffset(rankGain * rewardFac^(level-1) * BladeburnerRank, 10)` | `Formulas.ts:9-28`, `Bladeburner.ts:950-952` |
| Rank gain (black op) | `addOffset(rankGain * BladeburnerRank, 10)` | `Bladeburner.ts:1032-1035` |
| Rank loss (failure) | `addOffset(rankLoss * rewardFac^(level-1), 10)` (not BN-scaled) | `Formulas.ts:30-44` |
| HP loss (failure) | `ceil(addOffset(hpLoss * DiffMult, 10))` | `Bladeburner.ts:983-991` |
| Contract money | `250e3 * rewardFac^(level-1) * HandsOfMidas` (no BN mult) | `Bladeburner.ts:936-943` |
| Faction rep | `2 * rankGain * faction_rep * (1+favor/100)`, only if member of Bladeburners faction (rank ≥25, must `joinBladeburnerFaction` or auto-attempt on install) | `Formulas.ts:46-49`, `Bladeburner.ts:265-273,1277-1282` |
| Skill points | 1 per 3 **max** rank | `Bladeburner.ts:1284-1293` |
| Exp | `time * 1 * (success?1:0.5) * DiffMult * weight_s * Hyperdrive`; int `0.003×…` | `Bladeburner.ts:706-735` |
| Stamina cost (player contract/op/blackop) | `0.285 * DiffMult` (success or fail); sleeves pay nothing | `Bladeburner.ts:921-927,1020-1024` |
| Max stamina | `(effAgi^0.8 + staminaBonus) * CybersEdge * bladeburner_max_stamina` | `Bladeburner.ts:1329-1345` |
| Stamina regen /s | `(0.0085 + max/70000) * effAgi^0.17 * CybersEdge * bladeburner_stamina_gain` | `Bladeburner.ts:1319-1327` |
| Level up | maxLevel++ when successes ≥ `ceil(0.5*M*(2*b + M − 1))` (b=3 contracts, 2.5 ops); autoLevel sets level=maxLevel after each completion | `LevelableAction.ts:49-56`, `Bladeburner.ts:1006-1008` |
| Karma | −1 per kill contract/op success, −15 per kill black op | `Bladeburner.ts:970-972,1050-1052` |

Stamina 0 → action cancelled (`Bladeburner.ts:1371-1374`). Player BB action is cancelled by any other player work unless you own The Blade's Simulacrum (`Bladeburner.ts:178-180,1356-1368`).

### 2.5 Action catalogue

Contracts (`data/Contracts.ts`): growth/s = `U{5..75}/10 / 480` (avg ≈30/h each); initial count `U[min,150]`.

| Contract | baseDiff | diffFac | rewardFac | rankGain | hpLoss | type | minCount | main weights |
|---|---|---|---|---|---|---|---|---|
| Tracking | 125 | 1.02 | 1.041 | 0.3 | 0.5 | stealth | 25 | dex .35 agi .35 |
| Bounty Hunter | 250 | 1.04 | 1.085 | 0.9 | 1 | kill | 5 | dex/agi .25, str/def .15 |
| Retirement | 200 | 1.03 | 1.065 | 0.6 | 1 | kill | 5 | combat .2 each |

Operations (`data/Operations.ts`; maxCount default 150, Investigation/Undercover 100):

| Op | baseDiff | diffFac | rewardFac | rankGain | rankLoss | hpLoss | type | growth (÷10 per 480 s) | side effects (`Bladeburner.ts:793-866`) |
|---|---|---|---|---|---|---|---|---|---|
| Investigation | 400 | 1.03 | 1.07 | 2.2 | 0.2 | 0 | stealth | U{10..40} (≈19/h) | +est accuracy |
| Undercover Operation | 500 | 1.04 | 1.09 | 4.4 | 0.4 | 2 | stealth | U{10..40} | +est accuracy |
| Sting Operation | 650 | 1.04 | 1.095 | 5.5 | 0.5 | 2.5 | stealth | U{3..40} | pop −0.1% on success; chaos +0.1 |
| Raid | 800 | 1.045 | 1.1 | 55 | 2.5 | 50 | kill | U{2..40} | success: pop −1%, comms −1; chaos ×(1+U{1..5}%) |
| Stealth Retirement Operation | 1000 | 1.05 | 1.11 | 22 | 2 | 10 | stealth+kill | U{1..20} (≈7.9/h) | pop −0.5%; chaos ×(1−U{1..3}%) |
| Assassination | 1500 | 1.06 | 1.14 | 44 | 4 | 5 | stealth+kill | U{1..20} (≈7.9/h) | pop −1; chaos ×(1+U{−5..5}%) |

General actions (`Bladeburner.ts:1092-1237`):

| Action | Effect |
|---|---|
| Training (30 s) | +30 exp ×mult to each combat stat, staminaBonus +0.04×CybersEdge, costs 0.1425 stamina |
| Field Analysis (30 s) | rank +0.1×BladeburnerRank; pop-est improvement `(0.04*hack^0.3 + 0.04*int^0.9 + 0.02*cha^0.3) * bladeburner_analysis`%; 20 hack/cha exp |
| Recruitment | success `cha^0.45 / (humanTeam+1)`; +1 team; cha exp `60*(1−exp(−(chaExp/216000)^1.3))` per s (min 1) |
| Diplomacy (60 s) | city chaos ×(1 − (cha^0.045 + cha/1000)/100) |
| Hyperbolic Regeneration Chamber (60 s) | +2 HP, +1% max stamina |
| Incite Violence (60 s) | every contract/op count += `0.375 * growthFunction()`; every city chaos += 10 then += chaos/log10(chaos) |

Black ops (`data/BlackOperations.ts`; must be done in order, `BlackOperation.ts:44-49`; min 1 team casualty if teamCount>0):

| # | Name | reqRank | baseDiff | rankGain | rankLoss | hpLoss | type |
|---|---|---|---|---|---|---|---|
| 0 | Typhoon | 2.5k | 2000 | 50 | 10 | 100 | kill |
| 1 | Zero | 5k | 2500 | 60 | 15 | 50 | stealth |
| 2 | X | 7.5k | 3000 | 75 | 15 | 100 | kill |
| 3 | Titan | 10k | 4000 | 100 | 20 | 100 | kill |
| 4 | Ares | 12.5k | 5000 | 125 | 20 | 200 | kill |
| 5 | Archangel | 15k | 7500 | 200 | 20 | 25 | kill |
| 6 | Juggernaut | 20k | 10k | 300 | 40 | 300 | kill |
| 7 | Red Dragon | 25k | 12.5k | 500 | 50 | 500 | kill |
| 8 | K | 30k | 15k | 750 | 60 | 1000 | kill |
| 9 | Deckard | 40k | 20k | 1000 | 75 | 200 | kill |
| 10 | Tyrell | 50k | 25k | 1500 | 100 | 500 | kill |
| 11 | Wallace | 75k | 30k | 2000 | 150 | 1500 | kill |
| 12 | Shoulder of Orion | 100k | 35k | 2500 | 500 | 1500 | stealth |
| 13 | Hyron | 125k | 40k | 3000 | 1000 | 500 | kill |
| 14 | Morpheus | 150k | 45k | 4000 | 1000 | 100 | stealth |
| 15 | Ion Storm | 175k | 50k | 5000 | 1000 | 5000 | kill |
| 16 | Annihilus | 200k | 55k | 7500 | 1000 | 10k | kill |
| 17 | Ultron | 250k | 60k | 10k | 2000 | 10k | kill |
| 18 | Centurion | 300k | 70k | 15k | 5000 | 10k | – |
| 19 | Vindictus | 350k | 75k | 20k | 20k | 20k | – |
| 20 | **Daedalus** | **400k** | **80k** | 40k | 10k | 100k | – |

Daedalus weights: str/def/dex/agi 0.2 (decay 0.8), hack 0.1 (0.6), int 0.1 (0.75), cha 0 (`BlackOperations.ts:704-731`). Black-op rank gains #0–19 sum to 73,660×BladeburnerRank — most of the 400k must come from contracts/ops. Black op time = 1.5× (`BlackOperation.ts:51-53`).

### 2.6 Team & casualties (`Actions/TeamCasualties.ts:29-62`)

Losses = `randInt(min, max)`, min 0 (ops) / 1 (black ops), max = success ? ceil(0.5·team) : floor(team). If losses exceed human members, supporting sleeves are "killed" (= +0.5 shock, HP reset). Team bonus is only `(n+1)^0.05` (100 members → ×1.26).

### 2.7 Skills (`data/Skills.ts`, `Skill.ts:76-80`, `Bladeburner.ts:776-786`)

Cost of `count` levels from level L: `round(count * BladeburnerSkillCost * (base + inc*(L + (count−1)/2)))`. Effect per skill: `mult = 1 + perLevel% * level/100` (linear in level; multiple skills on the same mult multiply).

| Skill | base | inc | per level | max |
|---|---|---|---|---|
| Blade's Intuition | 3 | 2.1 | +3% all success | – |
| Cloak | 2 | **1.1** | +5.5% stealth success | – |
| Short-Circuit | 2 | 2.1 | +5.5% kill success | – |
| Digital Observer | 2 | 2.1 | +4% op & black-op success | – |
| Tracer | 2 | 2.1 | +4% contract success | – |
| Overclock | 3 | 1.4 | −1% action time | 90 (→ ×0.10) |
| Reaper | 2 | 2.1 | +2% eff str/def/dex/agi | – |
| Evasive System | 2 | 2.1 | +4% eff dex/agi | – |
| Datamancer | 3 | 1 | +5% estimate improvement | – |
| Cyber's Edge | 1 | 3 | +2% max stamina (& regen, training bonus) | – |
| Hands of Midas | 2 | 2.5 | +10% contract money | – |
| Hyperdrive | 1 | 2.5 | +10% BB exp | – |

Optimal SP allocation: success multipliers compose multiplicatively, so buy the level with highest `ln(1+p(n+1)) − ln(1+pn)` per SP. Eff-stat skills (Reaper/Evasive) are damped by decay exponents (≈0.8–0.91). Overclock is pure throughput until 90. Hash upgrades: "Exchange for Bladeburner Rank" +100 rank (not BN-scaled; also yields SP and rep), "…SP" +10 SP; cost `250 × (level+1)` hashes, increasing (`Hacknet/data/HashUpgradesMetadata.tsx:90-107`, `HashUpgrade.ts:72-82`).

### 2.8 Cities, population, chaos, communities (`City.ts`, `Bladeburner.ts:564-699,1395-1410`)

* Start per city: pop `U[1e9, 1.5e9]`, popEst `pop*(rand+0.5)`, comms `U{5..150}`, chaos 0.
* Chaos decays −0.0001/s per city. Percent-based chaos changes do nothing at chaos 0.
* Random event every `U{240..600}` s, random city: 5% new community (+10–20% pop), 5% community migration, 20% +8–24% pop, 20% pop migration, 20% riot (chaos +1 then ×(1+U{5..20}%)), 20% −8–20% pop, 10% nothing.
* Failure of Investigation/Undercover may trigger migration (10%/15%).

### 2.9 Bladeburner BN multipliers & SFs

* `BladeburnerRank` scales rank gains (not losses, not hash rank); `BladeburnerSkillCost` scales SP cost (table §0.3).
* SF6: +8%/+4%/+2% (cumulative 8, 12, 14%) combat stats & exp. SF7: same series on bladeburner max stamina, stamina gain, analysis, success (`SourceFile/applySourceFile.ts:93-122`). SF7.3: free Blade's Simulacrum on join.
* Rank/skills/action levels persist across aug installs; reset on BN change (`Prestige.ts:155-158`, `PlayerObjectGeneralMethods.ts:160`).

### 2.10 Win route

After Daedalus succeeds (`numBlackOpsComplete ≥ 21`), the BlackOps page shows "Destroy w0r1d_d43m0n" (UI, `Bladeburner/ui/BlackOpPage.tsx:39-52`) and `singularity.destroyW0r1dD43m0n()` accepts BB completion in place of the hacking requirement (`NetscriptFunctions/Singularity.ts:1176-1190`; needs SF4). No TRP, no hacking level required. Works in any BN with BB access except BN8.

Fastest path (derived):
1. Hit 100 in all combat stats → join (API, any city). Join faction at rank 25 for rep.
2. Early: contracts (cheap, also money) → ops. Keep player stamina ≥50% of max (otherwise success scales down linearly).
3. Rank is **count-limited**: Assassination/Stealth Retirement regenerate only ≈7.9/h each. Sleeves on "Infiltrate Synthoids" add `n^−0.5/2` counts per sleeve per 60 s to **every** contract and op → total `√n/2` per minute per action type (8 sleeves ≈ 85/h each, ~10× natural) (`Bladeburner.ts:1253-1265`, `SleeveInfiltrateWork.ts:7,20-28`).
4. Higher levels: rank ×rewardFac/level vs time ×diffFac/level (Assassination 1.14 vs 1.06) → always run the highest level with ~100% success; leveling itself needs ~0.5·M·(M+4) successes of that op.
5. Overclock to 90 early (10× throughput); success skills to keep high-level ops at ~100%.
6. Daedalus at 400k rank needs competence ≥80k: e.g. 5k combat stats → base competence ≈800, so ≈×100 from skills/augs/team/int (Blade's Intuition + Digital Observer at ~250 each ≈ ×93). SP from 400k rank ≈133k.
7. Randomness: success rolls, ±10% rank/HP offsets, growth increments, casualties, random city events, initial counts/pop/comms.

### 2.11 Bladeburner API (RAM; `RamCostGenerator.ts:333-376`, base 4 GB)

0 GB: inBladeburner, getContractNames, getOperationNames, getBlackOpNames, getGeneralActionNames, getSkillNames, getBonusTime, nextUpdate, formulas.bladeburner.skillMaxUpgradeCount. 1 GB: getCurrentAction. 2 GB: getNextBlackOp, getBlackOpRank, stopBladeburnerAction. 4 GB: everything else (startAction, getActionTime, getActionEstimatedSuccessChance(type,name,sleeve?), getAction{Rep,Rank}Gain/RankLoss, counts, levels, autolevel, rank, SP, skills, team, city info, switchCity, getStamina, joinBladeburnerFaction, joinBladeburnerDivision).
UI-only: none essential. Console `automate` (stamina-threshold switching, `Bladeburner.ts:428-526`) is UI-only but redundant. Final "Destroy w0r1d_d43m0n" without SF4 is UI-only.

---

## 3. Sleeves (BN10 / SF10)

### 3.1 Count, purchase, memory

| Item | Value | Source |
|---|---|---|
| Base sleeves | `min(3, SF10 + [BN10])` | `SleeveCovenantPurchases.tsx:62-63` |
| Covenant sleeves | max 5, cost `10e12 * 10^k` (k = already bought): 1e13, 1e14, 1e15, 1e16, 1e17; BN10 only; **permanent across BNs** | `:13-27,29-56,75-84` |
| Memory | 1–100; cost for n points from m: `1e12 * Σ_{i=m-1}^{m+n-2} 1.02^i` (1→100 ≈ $3.05e14); BN10 + Covenant only; persists | `Sleeve.ts:198-213,402-404`, `:86-123` |
| API | `sleeve.purchaseSleeve()`, `sleeve.upgradeMemory(i,n)`, `getSleeveCost()`, `getMemoryUpgradeCost(i,n)` — **all scriptable in 3.0.1** (4 GB each) | `NetscriptFunctions/Sleeve.ts:304-333` |

### 3.2 Shock & sync

* New BN: shock 100, sync = max(memory,1), augs/exp/mults wiped (`Sleeve.ts:228-256`). Entering BN10: shock ≤25, sync ≥25 (`PlayerObjectGeneralMethods.ts:150-155`). Aug install keeps sleeve stats/augs; re-queues recovery (if shock>0) or sync (`:120`).
* Passive while **any** task is assigned: shock −0.0001×intBonus/cycle (`Sleeve.ts:269-272`); Shock Recovery task adds −0.0002×intBonus/cycle (total 0.0015/s → 100→0 ≈ 18.5 h; ≈55.6 h passively). Idle sleeves don't recover. `intBonus = 1+0.75*int^0.8/600`.
* Synchronize: +0.0002×(1+0.5*playerInt^0.8/600)/cycle (≈27.5 h from 1→100) (`SleeveSynchroWork.ts:13-19`).
* What shock affects (`shockBonus = 1 − shock/100`): exp and rep (faction, company) — **not money**. What sync affects: exp shared to player (×sync) and to other sleeves (×sync×theirShockBonus), and **crime karma**. Rep, money, BB rank are **not** sync-scaled. (`Work/Work.ts:17-25`, `WorkStats.ts:49-62`)

### 3.3 Tasks vs player efficiency

| Task | Sleeve output | vs player | Source |
|---|---|---|---|
| Faction work | player formula on sleeve's own stats/mults × shockBonus; one sleeve per faction (may share with the player); not the gang faction | player unfocused ×0.8 (no Neuroreceptor); sleeve has no focus penalty | `SleeveFactionWork.ts:31-52`, `NetscriptFunctions/Sleeve.ts:141-174` |
| Company work | same formula; rep ×shock; money unscaled; one sleeve per company | same | `SleeveCompanyWork.ts:31-48` |
| Crime | crime money (unscaled by shock), exp ×shock; success roll on sleeve stats; failure: ×0.25 exp, **0 karma, 0 money** | player failure still gives karma/4 | `SleeveCrimeWork.ts:29-54` |
| Class/gym | sleeve-local class rates ×shock; costs money; must be in the right city | – | `SleeveClassWork.ts:31-42`, `Sleeve.ts:288-485` |
| BB General (Training, Field Analysis, Recruitment, Diplomacy, HRC) | runs the player's BB action logic with sleeve as `person`; **Training drains the player's BB stamina** and raises player max stamina; HRC restores player BB stamina; Diplomacy/Field Analysis act on the BB's current city | – | `SleeveBladeburnerWork.ts:34-61`, `Bladeburner.ts:1094-1220` |
| BB contracts ("Take on contracts") | full contract (rank, money, count consumed), sleeve stats, **player's stamina penalty**, no stamina cost; one sleeve per contract type | – | `SleeveBladeburnerWork.ts`, `NetscriptFunctions/Sleeve.ts:281-301` |
| Infiltrate Synthoids | every 60 s: +`n^−0.5/2` to all contract & op counts (n = sleeves infiltrating) | unique to sleeves | `SleeveInfiltrateWork.ts` |
| Support main sleeve | +1 BB teamSize while assigned; can be "killed" in casualties (+0.5 shock) | – | `SleeveSupportWork.ts:10-19`, `TeamCasualties.ts:52-57` |

Sleeves cannot do operations or black ops. `getActionEstimatedSuccessChance(type,name,sleeveNo)` works only for General/Contracts.

### 3.4 Sleeve augmentations

* Requires shock == 0 and money ≥ **`aug.baseCost` (raw; no BN `AugmentationMoneyCost`, no queued-aug price inflation)**. Installed immediately and resets that sleeve's exp (`Sleeve.ts:215-225,366-400`).
* Eligible: non-special augs with at least one of hacking/combat/cha (+exp), company_rep, faction_rep, crime_money, crime_success, work_money ≠1; rep gate `faction rep > repCost` (BN `AugmentationRepCost` applies) in any joined faction except Bladeburners/Netburners, or the gang faction's full list (`Sleeve.ts:90-171`).
* ZOË (sleeve Stanek receiver): $1e12, CotMG member; each ZOË sleeve gets Stanek mults scaled by `3/(nZoe+2)` (`Sleeve.ts:164-168`, `CotMG/StaneksGift.ts:206-227`, `Augmentation/Augmentations.ts:2070-2082`).
* Sleeve augs are wiped on BN change.

### 3.5 Sleeve API

All 4 GB (`RamCostGenerator.ts:395-419`). UI-only: nothing (memory/sleeve purchase are API in 3.0.1). Randomness: crime success, BB rolls.

---

## 4. Stanek's Gift / Church of the Machine God (BN13 / SF13)

### 4.1 Acceptance & side effects

* Genesis aug: all stats/exp/rep/crime/work money ×0.9, hacknet costs ×1.1 (`Augmentations.ts:1592-1629`). Gift 2 (Awakening, CotMG rep 1e6, $0): penalty → 0.95. Gift 3 (Serenity, CotMG rep 1e8, $0): penalty removed (`:1630-1676`). Rep costs scale with `AugmentationRepCost`.
* After acceptance, each install auto-rejoins CotMG (`Prestige.ts:185-186`). Charges clear on every aug install; layout clears on BN change (`StaneksGift.ts:229-236`, `Prestige.ts:128,353`).

### 4.2 Grid size (`StaneksGift.ts:22-31`, `CotMG/data/Constants.ts`)

```
base = 9 + StaneksGiftExtraSize + activeSF13
width  = clamp(floor(base/2 + 1),   2, 25)
height = clamp(floor(base/2 + 0.6), 3, 25)
```
| base | 3 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| W×H | 2×3 | 4×3 | 4×4 | 5×4 | 5×5 | 6×5 | 6×6 | 7×6 | 7×7 | 8×7 | 8×8 |

BN13 first run (SF13=0): 6×5; SF13.3 in BN13: 7×7; SF13.3 in a 0-extra BN: 7×6; BN6/BN9 (+2) with SF13.3: 8×7.

### 4.3 Fragments (`CotMG/Fragment.ts:93-375`, `Shapes.ts`)

All stat fragments limit 1 (per id); boosters limit 99, can't be charged.

| id | shape | type → mults | power |
|---|---|---|---|
| 0 | S | Hacking (hacking, hacking_exp) | 1 |
| 1 | Z | Hacking | 1 |
| 5 | T | HackingSpeed | 1.3 |
| 6 | I | HackingMoney | 2 |
| 7 | J | HackingGrow | 0.5 |
| 10 | T | Strength (+exp) | 2 |
| 12 | L | Defense | 2 |
| 14 | L | Dexterity | 2 |
| 16 | S | Agility | 2 |
| 18 | S | Charisma | 3 |
| 20 | I | HacknetMoney | 1 |
| 21 | O | HacknetCost (divides costs) | 2 |
| 25 | J | Rep (company_rep, faction_rep) | 0.5 |
| 27 | J | WorkMoney | 10 |
| 28 | L | Crime (success, money) | 2 |
| 30 | S | Bladeburner (max stamina, stamina gain, analysis, success) | 0.4 |
| 100–107 | 5-cell pentomino-like shapes | Booster ×1.1 to adjacent stat fragments | 1.1 |

Shapes: O 2×2; I 1×4; L/J/S/Z/T 2×3 (4 cells). Rotation 0–3 (`Fragment.ts:24-51`).

### 4.4 Charging & effect

```
chargeFragment by a script with T threads on a server with C cores: t = T * (1 + (C-1)/16)
  if t > highest: numCharge = highest*numCharge/t + 1; highest = t
  else:           numCharge += t/highest                                   StaneksGift.ts:33-44
CotMG rep += faction_rep * t^0.95 * (favor+100)/1000 per call               StaneksGift.ts:41-42
effect = 1 + ln(highest+1)/60 * ((numCharge+1)/5)^0.07 * power * Π(adjacent distinct boosters 1.1) * StaneksGiftPowerMultiplier
                                                                            formulas/effect.ts:3-12, StaneksGift.ts:64-81
```
* 1 s per call (200 ms in bonus time). RAM: 1.6 + 0.4 = **2.0 GB per thread** (`RamCostGenerator.ts:63-65`, `ServerHelpers.ts:287-290`).
* `highest` = largest single-call thread×core product → run charges on the single biggest-RAM, most-cores host; extra parallel smaller charges still add fractional numCharge.
* Diminishing returns: effect ∝ ln(peak threads) and numCharge^0.07 (100→1000 charges ≈ +16% of the bonus).
* Example: peak 50k threads, 100 charges, power 2, no boosters, mult 1 → +44.5%; BN13 (mult 2) → +89%.
* Adjacency: a booster counts once per neighbouring fragment regardless of shared edges (`StaneksGift.ts:66-79`); boosters don't boost boosters.
* Mults are recomputed after any charge (applyEntropy → updateMults) (`StaneksGift.ts:57-60`, `PlayerObjectAugmentationMethods.ts:17`).

### 4.5 Stanek API (`RamCostGenerator.ts:63-73,422-434`)

giftWidth/giftHeight/chargeFragment 0.4 · fragmentDefinitions 0 · activeFragments 5 · clearGift 0 · canPlaceFragment 0.5 · placeFragment 5 · getFragment 2 · removeFragment 0.15 · acceptGift 2. Everything is scriptable; acceptance via API skips the Chongqing trip.

### 4.6 Layout considerations

Objective = maximize Σ ln(effect_i) weighted by what the BN needs; choose which stat fragments to place (each id once), then pack boosters so each important fragment touches as many distinct boosters as possible. Grid ≤8×8 → exact search (ILP/DLX/beam) is feasible. Randomness: none.

---

## 5. Changes in 3.0.2 (dev branch, `bitburner-src`) for these systems

Mostly refactors (serialization, NS API signature style `(ctx, ...args)`, Gang task name enum). Behavioural: `stanek.acceptGift()` returns true early if already accepted; sleeve BB work type excludes Incite Violence; `Skill.calculateMaxUpgradeCount` lost its fp-precision guard. No formula changes found in Gang/Bladeburner/Sleeve/CotMG.

---

## 6. Implications for automation

### Gangs (`bitburner-scripts/gangs.js`)
* Does: territory-tick detection by polling power, swaps all members to Territory Warfare just before each tick (correct exploit), greedy+shuffled task assignment with wanted tolerance, staggered ascension thresholds (1.05…1.6), budgeted equipment buys, engage when average win chance ≥60%.
* **Bug on 3.0.1**: calls `ns.gang.getOtherGangInformation()` (gangs.js:196,521), removed in 3.0.0 → throws. Replace with `getAllGangInformation()` (filter own faction).
* Tick timing: use `ns.gang.nextUpdate()` cycle accounting (100-cycle tick) instead of 200 ms polling; bonus-time tick spacing is ~1/25, not 1/5 (gangs.js:224).
* Engage rule should use the **minimum** win chance among gangs with territory (and clash-chance decay) rather than the average; deaths only occur while clash chance > 0.
* Not modelled: territory exponent payoff (full territory ≈100× Terrorism respect), ascension respect cost (earnedRespect), GangSoftcap 0.3 in BN13 / 0 in BN8 (gang ≈ useless).

### Bladeburner (`bladeburner.js`)
* Does: picks highest-value action with min (pessimistic) success ≥99%, chaos handling via Stealth Retirement/Diplomacy, Incite Violence when out of counts, cost-weighted skill buying, hash spending for rank/SP. Never recruits.
* Leverage: population estimates don't affect real success — only spend time on Field Analysis when the range straddles the threshold. `switchCity` is free; pick cities by (pop/1e9)^0.7 and chaos.
* Skill buying is "cheapest next" with fudge factors; a log-marginal-gain/SP optimizer is better, and Overclock→90 early.
* Autopilot only detects the BB win; for BN6/7 (and as an alt-win elsewhere) actively drive to 400k rank + Daedalus with sleeves on Infiltrate Synthoids.

### Sleeves (`sleeve.js`)
* Always syncs to 100 first (sleeve.js:224): ~27 h idle per BN outside BN10 when memory=1. Sync only matters for karma and exp sharing; rep/money/BB rank ignore it → skip sync for rep/BB roles.
* "Even a failed homicide generates more karma" (sleeve.js:307) is false for sleeves (failure = 0 karma); pick crime by `karma × P(success) / time`.
* CLAUDE.md's "sleeve memory purchases blocked, no API" is outdated: `sleeve.upgradeMemory` and `sleeve.purchaseSleeve` exist (BN10 + Covenant). Buying memory (and the 5 Covenant sleeves) in BN10 is a permanent investment across all later BNs.
* Sleeve augs cost raw baseCost (no price inflation) — buy aggressively once shock=0; prioritize shock recovery early for that reason.

### Stanek (`stanek.js`, `optimize-stanek.js`)
* stanek.js charges each placed fragment with max threads on one host, stops at 120 charges or continues for Gift 2/3 rep. Correct direction; add core-count awareness (charge from highest-core host) and use bonus time.
* Accept via `stanek.acceptGift()` at BN start before any aug purchase and **before joining Bladeburner when SF7≥3**; outside BN13, not accepting before the first install bans CotMG for the BN.
* optimize-stanek.js references a nonexistent fragment type 2 (HackingChance) — harmless. Layouts should be BN-specific (BB fragment in BB runs, Rep/Hacking in faction-grind runs).

### Open questions
* Exact expected territory gain rate vs NPC growth needs simulation (random pairing, renormalization, `return` quirk).
* Optimal ascension timing given respect cost — needs a model of respect regained per hour.
* Value of Support/Recruitment team vs casualties is small ((n+1)^0.05); probably never worth it.
