# Factions, Augmentations, Companies, Work & Stat Growth — mechanics reference (Bitburner v3.0.1)

Source of truth: `vendor/bitburner-src` (VersionString "3.0.1", `src/Constants.ts:7`). All paths below are relative to `vendor/bitburner-src/`. "cycle" = one game tick = 200 ms (`src/Constants.ts:19`), i.e. 5 cycles/s. "BNmult.X" = `currentNodeMults.X` (`src/BitNode/BitNodeMultipliers.ts`), set per BitNode by `getBitNodeMultipliers(n, SFlvl+1)` (`src/BitNode/BitNode.tsx:570-1131`).

> **Most important constraint for automation:** every Singularity function (join faction, work, buy/install augs, apply to jobs, travel, gym/university, crime, donate, hospital) throws unless `bitNodeN === 4 || activeSourceFileLvl(4) > 0` (`src/Netscript/NetscriptHelpers.tsx:388-396`, `src/BitNode/BitNodeUtils.ts:17-19`). A fresh save in BN1 can do **none of this from scripts** — it is UI-only until SF4 is earned (or while inside BN4).

---

## 1. Factions

### 1.1 Invitation mechanics
- Invite conditions are re-evaluated every 10 cycles (2 s) (`src/engine.tsx:154,177-183`; `checkForFactionInvitations`, `src/PersonObjects/Player/PlayerObjectGeneralMethods.ts:453-466`). All conditions are evaluated on **current** state (money on hand, current city, current skill levels, current job).
- A faction is skipped if already member / already invited / banned. Joining a faction bans all its `enemies` and drops their pending invites (`src/Faction/FactionHelpers.tsx:35-52`).
- On augmentation install: every faction → `isMember=false, isBanned=false, alreadyInvited=false`, rep→0, favor += (see §2.3) (`src/Faction/Faction.ts:77-85`). Factions with `keepOnInstall` get their **invitation re-issued** automatically if you were a member or had a pending invite (`src/Prestige.ts:61-67,121-124`). keepOnInstall = the 9 megacorp factions, Fulcrum Secret Technologies, Church of the Machine God, Shadows of Anarchy.
- On BitNode end: favor also reset to 0 (`src/Faction/Faction.ts:68-75`).
- `haveAugmentations(n)` counts `Player.augmentations.length` = **installed** augs only (queued do not count); NeuroFlux Governor is a single entry regardless of level (`src/Faction/FactionJoinCondition.ts:116-132`, `src/Augmentation/AugmentationHelpers.ts:54-66`). Grafted augs and Stanek's Gift (via `acceptGift`) are pushed into `Player.augmentations` immediately and count.
- `haveKarma(n)` is `karma <= n` (karma is negative) (`FactionJoinCondition.ts:168-182`). `haveCombatSkills(n)` = str, def, dex, agi all ≥ n (`:158-166`). `haveSourceFile(n)` = in BN n OR SF n active (`:291-307`).
- Company rep conditions use `rep × 0.75` if the company's server is backdoored (`src/Company/utils.ts:15-19`, `CONSTANTS.CompanyRequiredReputationMultiplier` `src/Constants.ts:110`).
- Rumors (`rumorReqs`) are informational only; they never gate invites.

### 1.2 Join requirements (exact) — `src/Faction/FactionInfo.tsx`
Work types: H = hacking, F = field, S = security. Backdoor server hack levels are random in [min,max] per BitNode (`src/Server/data/servers.ts`).

| Faction (exact name) | Invite requirements (all must hold) | Work | Enemies | Line |
|---|---|---|---|---|
| CyberSec | backdoor `CSEC` (hack 51–60, 1 port) | H | — | 475-492 |
| Tian Di Hui | in Chongqing/New Tokyo/Ishima; hack ≥ 50; $1M | H S | — | 680-695 |
| Netburners | hack ≥ 80; Σ hacknet RAM ≥ 8, Σ cores ≥ 4, Σ levels ≥ 100 | H | — | 672-678 |
| NiteSec | backdoor `avmnite-02h` (202–220, 2 ports) | H | — | 426-473 |
| The Black Hand | backdoor `I.I.I.I` (340–365, 3 ports) | H F | — | 407-423 |
| BitRunners | backdoor `run4theh111z` (505–550, 4 ports) | H | — | 388-405 |
| Sector-12 | in Sector-12; $15M | H F S | Chongqing, New Tokyo, Ishima, Volhaven | 537-546 |
| Aevum | in Aevum; $40M | H F S | Chongqing, New Tokyo, Ishima, Volhaven | 495-504 |
| Chongqing | in Chongqing; $20M | H F S | Sector-12, Aevum, Volhaven | 505-514 |
| New Tokyo | in New Tokyo; $20M | H F S | Sector-12, Aevum, Volhaven | 527-536 |
| Ishima | in Ishima; $30M | H F S | Sector-12, Aevum, Volhaven | 515-526 |
| Volhaven | in Volhaven; $50M | H F S | all 5 other cities | 547-558 |
| Slum Snakes | combat ≥ 30; $1M; karma ≤ −9 | F S | — | 662-669 |
| Tetrads | in Chongqing/New Tokyo/Ishima; combat ≥ 75; karma ≤ −18 | F S | — | 645-660 |
| Silhouette | job = CTO, CFO or CEO (any company); $15M; karma ≤ −22 | H F | — | 623-643 |
| Speakers for the Dead | not employed by CIA or NSA; hack ≥ 100; combat ≥ 300; kills ≥ 30; karma ≤ −45 | H F S | — | 561-576 |
| The Dark Army | in Chongqing; not CIA/NSA; hack ≥ 300; combat ≥ 300; kills ≥ 5; karma ≤ −45 | H F | — | 578-599 |
| The Syndicate | in Aevum or Sector-12; not CIA/NSA; $10M; hack ≥ 200; combat ≥ 200; karma ≤ −90 | H F S | — | 601-621 |
| ECorp, MegaCorp, Bachman & Associates, Blade Industries, NWO, Clarke Incorporated, OmniTek Incorporated, Four Sigma, KuaiGong International | employed at same-named company AND company rep ≥ 400,000 (`CorpFactionRepRequirement`, `Constants.ts:25`; 300,000 if company server backdoored) | H F S | — | 182-361 |
| Fulcrum Secret Technologies | employed at Fulcrum Technologies; company rep ≥ 400k (300k w/ `fulcrumtech` backdoor); backdoor `fulcrumassets` (1100–1600, 5 ports) | H S | — | 363-385 |
| The Covenant | ≥ 20 installed augs; $75B; hack ≥ 850; combat ≥ 850 | H F | — | 151-179 |
| Daedalus | ≥ `BNmult.DaedalusAugsRequirement` installed augs (30 default; 35 in BN6/7; 20 in BN15; BN12: `floor(min(30+1.02^lvl, 40))`); $100B; (hack ≥ 2500 OR combat ≥ 1500) | H F | — | 138-149 |
| Illuminati | ≥ 30 installed augs (fixed); $150B; hack ≥ 1500; combat ≥ 1200 | H F | — | 118-136 |
| Bladeburners | (in BN6/7 or SF6/SF7) AND Bladeburner rank ≥ 25 (`src/Bladeburner/data/Constants.ts:42`) | none | — | 698-724 |
| Church of the Machine God | (in BN13 or SF13) AND no non-NFG aug installed **or queued** AND visit Chongqing church (UI) — or `ns.stanek.acceptGift()` from anywhere (`src/NetscriptFunctions/Stanek.ts:120-139`, `src/CotMG/Helper.tsx:59-74`) | none | — | 726-789 |
| Shadows of Anarchy | invited on completing any infiltration (`src/Infiltration/ui/Victory.tsx:89-94`) | none | — | 790-815 |

Notes
- City-faction compatibility classes: {Sector-12, Aevum}, {Chongqing, New Tokyo, Ishima}, {Volhaven}. Bans apply only after **joining**; you may hold invites to all simultaneously.
- Gang factions (`src/Gang/data/Constants.ts:18-26`): Slum Snakes, Tetrads, The Syndicate, The Dark Army, Speakers for the Dead, NiteSec, The Black Hand. Creating a gang zeroes that faction's rep (`PlayerObjectGangMethods.ts:56-68`); you can no longer work/donate there; rep = respect/75 (`GangRespectToReputationRatio`). Gang creation (`src/Gang/helpers.ts:6-26`, `PlayerObjectGangMethods.ts:12-30`): be a member of a gang faction AND (in BN2 → **no karma requirement**; else SF2 active AND karma ≤ −54,000). UI additionally hides the button until any SF is owned (`src/Faction/ui/GangCampaign.tsx`); `ns.gang.createGang` has no such check.
- No BN15-specific faction exists. In BN15 Daedalus does **not** sell The Red Pill (`FactionHelpers.tsx:204-207`); TRP comes from the darknet labyrinth instead (§3.6).
- Church: after any install outside BN13, if you are not a member and have any non-NFG aug installed, Church is permanently banned for that BitNode (`src/Prestige.ts:184-191`). If Stanek's Genesis is installed you are auto-joined every install.
- Covenant (BN10 only): sells extra sleeves, cost `10e12 × 10^k` for k = sleeves already bought, max 5 (`src/PersonObjects/Sleeve/SleeveCovenantPurchases.tsx:13-27`).
- Special factions (Bladeburners, Church, SoA) have no work, no donation, no passive rep. Their rep sources:
  - Bladeburners: `2 × Δrank × faction_rep × (1+favor/100)` (`src/Bladeburner/Formulas.ts:46-49`).
  - Church: per Stanek charge `faction_rep × threads^0.95 × (favor+100)/1000` (`src/CotMG/StaneksGift.ts:42`).
  - SoA: per infiltration `(secLvl/maxSecLvlOfAllLocs)×5000 × (0.8+0.05×(maxClearance−5)) × marketDemand × (WKS harmonizer ? 2 : 1) × (1+favor/100)` (`src/Infiltration/formulas/victory.ts:65-90`).

### 1.3 Augmentations sold, by faction (max rep = highest aug rep, before BN mult)
NFG is sold by every faction except SoA, Bladeburners, Church (`src/Augmentation/Augmentations.ts:1196-1201`) and **not** by a gang faction (it filters `isSpecial`). "*" = unique to that faction.

| Faction | Augs | Max rep |
|---|---|---|
| CyberSec | Neurotrainer I, Synaptic Enhancement, BitWire, CSP Gen I, CSP Gen II | 18.75k |
| Tian Di Hui | Wired Reflexes, Speech Enhancement, ADR-V1, Nuoptimal, SNA*, Speech Processor, Nanofiber Weave, Neuroreceptor Management* | 75k |
| Netburners | 5 Hacknet augs* | 12.5k |
| Sector-12 | Wired Reflexes, Targeting I, II, Speech Processor, CashRoot*, Neuralstimulator | 50k |
| Aevum | Neurotrainer I, Synaptic Enhancement, Wired Reflexes, Speech Processor, Neuralstimulator, PCMatrix* | 100k |
| Chongqing | Nuoptimal, Speech Processor, Neuralstimulator, Neuregen*, DataJack | 112.5k |
| New Tokyo | NutriGen*, Nuoptimal, Speech Processor, Neuralstimulator, DataJack | 112.5k |
| Ishima | Wired Reflexes, Targeting I, Combat Rib I, INFRARET*, Speech Processor, Neuralstimulator | 50k |
| Volhaven | Wired Reflexes, Combat Rib I, II, Nuoptimal, DermaForce*, Speech Processor, Neuralstimulator | 50k |
| NiteSec | BitWire, ASP, CSP I–III, Neurotrainer II, CRTX42-AA*, Neural-Retention*, DataJack, ENM | 112.5k |
| The Black Hand | ASP, CSP III, IV, DataJack, ENM, ENM Core, Enhanced Myelin, Neuralstimulator, Magnetism, The Black Hand* | 175k |
| BitRunners | Wit, Neurotrainer II, CSP III–V (V*), DataJack, ENM, ENM Core, ENM Core V2, Enhanced Myelin, Bio-neural Network, Neural Accelerator*, Neurolink* | 1M |
| Slum Snakes | LuminCloaking V1, V2, Wit, Targeting I, Combat Rib I, SmartSonar*, Wired Reflexes | 22.5k |
| Tetrads | LuminCloaking V1, V2, Bionic Arms*, Glib, HemoRecirculator, Power Recirculation | 62.5k |
| Silhouette | ADR-V2, Speech Processor, TITN-41* | 62.5k |
| Speakers for the Dead | Bionic Legs, Bionic Spine, Eloquence*, Golden Tongue*, Graphene BrachiBlades*, Nanofiber, Shadow's Simulacrum, Speech Enhancement, Synfibril, Synthetic Heart, Unstable Circadian Modulator*, Wired Reflexes | 750k |
| The Dark Army | Combat Rib I–III, Graphene Bionic Arms*, HemoRecirc, Magnetism, Nanofiber, Power Recirc, Primer, Shadow's Simulacrum, Targeting I–III, Wired Reflexes | 500k |
| The Syndicate | ADR-V1, Bionic Legs, Bionic Spine, BrachiBlades*, Combat Rib I–III, HemoRecirc, Nanofiber, Power Recirc, Primer, Shadow's Simulacrum, NEMEAN Subdermal, Targeting I–III, Wired Reflexes | 875k |
| ECorp | ENM, ENM Core, V2, V3, Analyze, DMA, Graphene Bionic Legs, Graphene Bionic Spine, HVMind*, PC DNI, PC DNI Optimizer, Social Dynamics | 1.75M |
| MegaCorp | ADR-V1, CordiARC*, ENM, Core, V2, V3, Analyze, DMA, Graphene Bionic Legs, Social Dynamics | 1.75M |
| Bachman & Associates | ADR-V2, Enhanced Social Interaction, FocusWire, Neuralstimulator, Nuoptimal, SmartJaw*, Speech Enhancement | 375k |
| Blade Industries | Bionic Legs, Spine, Combat Rib I–III, ENM, Core, V2, HyperSight, Nanofiber, Neotra*, PC DNI, PC DNI Optimizer, Synfibril, Targeting I–III | 562.5k |
| NWO | ADR-V1, ENM, Core, V2, V3, Analyze, DMA, Enhanced Social, Hydroflame*, Neurotrainer III, Power Recirc, Synfibril, Synthetic Heart, Xanipher* | 1.75M |
| Clarke Incorporated | ADR-V2, Enhanced Social, FocusWire, Neuralstimulator, Neuronal Densification*, Nuoptimal, nextSENS*, Speech Enhancement | 437.5k |
| OmniTek Incorporated | Bionic Legs, Spine, Combat Rib I–III, ENM Core V2, Enhanced Social, Nanofiber, OmniTek InfoLoad*, PC DNI, Social Dynamics, Targeting I–III | 1M |
| Four Sigma | ADR-V1, ADR-V2, Enhanced Social, FocusWire, Neuralstimulator, Neurotrainer III, Nuoptimal, PC DNI, Speech Enhancement | 375k |
| KuaiGong International | Bionic Legs, Spine, Combat Rib I–III, ENM Core V2, FocusWire, HyperSight, Photosynthetic Cells*, Speech Enhancement, Synfibril, Synthetic Heart, Targeting I–III | 1M |
| Fulcrum Secret Technologies | Bio-neural Network, ENM, Core, V2, V3, Analyze, DMA, Enhanced Myelin, Graphene Bionic Legs, Graphene Bionic Spine, Graphene Bone Lacings, Nanofiber, PC DNI Optimizer, PC DNI NeuroNet*, NEMEAN Subdermal, Synfibril, Synthetic Heart | 1.75M |
| The Covenant | Combat Rib III, ENM Analyze, V3, DMA, Graphene Bone Lacings, SPTN-97*, NEMEAN Subdermal, Synfibril, Synthetic Heart, Targeting III | 1.75M |
| Daedalus | ENM Analyze, V3, DMA, NEMEAN Subdermal, Synfibril, Synthetic Heart, **The Red Pill*** (2.5M) | 2.5M |
| Illuminati | ENM Analyze, V3, DMA, **QLink*** , NEMEAN Subdermal, Synfibril, Synthetic Heart | 1.875M |
| Bladeburners | 17 BB augs + Glib (§3.5) | 62.5k |
| Shadows of Anarchy | 9 SoA augs (§3.5) | 10k×1.3^n |
| Church of the Machine God | Stanek's Gift ×3 (+ Z.O.Ë. for sleeves) | 100M |

**Gang faction** (`FactionHelpers.tsx:172-202`): offers every non-special aug except violet Congruity Implant; augs sold by only one faction (and not already sold by the gang faction) are kept iff `rng() >= 1 − BNmult.GangUniqueAugs`, with `rng = SFC32RNG("BN{n}.{SFlvl(n)}")` — deterministic per (BitNode, SF level). GangUniqueAugs: 1 (BN1, BN2) → all uniques incl. QLink, HVMind, Hydroflame; 0.75 BN11; 0.5 BN3/4/5; 0.4 BN14; 0.3 BN15; 0.25 BN9/10; 0.2 BN6/7; 0.1 BN13; 0 BN8; 1/1.02^lvl BN12. **The Red Pill is added to the gang faction in BN2 only.**

---

## 2. Reputation, favor, donation

### 2.1 Faction work rep (per cycle) — `src/PersonObjects/formulas/reputation.ts`
```
favorMult(f) = (1 + f/100) × BNmult.FactionWorkRepGain                        // :8-14
intBonus     = 1 + int^0.8 / 600                                               // formulas/intelligence.ts:1-3
share        = 1 + ln(shareThreads)/25   (shareThreads ≥ 1)                    // NetworkShare/Share.ts
cha15(k)     = SF15 lvl ≥ 3 ? charisma × k : 0                                 // :54-59

hacking  = (hack + int/3 + cha15(0.1)) / 975 × faction_rep × intBonus × favorMult × share     // :16-24
security = 0.9×(str+def+dex+agi + cha15(0.3) + (hack+int)×share) / 975 / 4.5 × faction_rep × favorMult × intBonus   // :26-38
field    = 0.9×(str+def+dex+agi+cha + (hack+int+cha15(0.3))×share) / 975 / 5.5 × faction_rep × favorMult × intBonus  // :40-52
```
Then × focus factor (1 focused, 0.8 unfocused unless Neuroreceptor Management installed) (`src/Work/FactionWork.tsx:37-40`, `PlayerObjectGeneralMethods.ts:622-628`, `BaseFocusBonus` `Constants.ts:87`).
- No skill cap: rep is linear in skill level (975 is only the normaliser). Hacking work at hack 975 ≈ 1 rep/cycle = 5 rep/s × mults.
- Share bonus multiplies **all** of hacking work but only the (hack+int) term of field/security.
- With all six stats equal to S and share = 1: hacking ≈ S/975, security ≈ S/975, field ≈ 0.984·S/975 — equivalent; for a hacking build hacking work is ~5× security.
- Exp from faction work (per second, focus-scaled): hacking 2 hack-exp; field 1 each of all six; security 0.5 hack + 1.5 each combat; × exp mults × `BNmult.FactionWorkExpGain` (`src/Work/Formulas.ts:39-56,92-97`).

### 2.2 Passive & offline rep (often overlooked)
- **Passive** (`FactionHelpers.tsx:132-170`, every 5 cycles, `engine.tsx:185-189`): every joined faction except the one you are currently working for, special factions, and your gang gets per cycle `max(h,s,f work rate (no focus) × min(0.1, favor/1000 + 0.01), 1/120) × BNmult.FactionPassiveRepGain`. I.e. 1 % of best work rate at 0 favor, rising to the 10 % cap at favor 90; floor 1/120 rep/cycle (150 rep/h). Disabled in BN2 (`FactionPassiveRepGain: 0`).
- **Offline** (`engine.tsx:280-305`): if a work was active, it is processed for all offline cycles **as focused**; if no work, each joined working faction gets `max(h,s,f)/numFactions × cycles` (skipped in BN2). Passive also applied offline (`:318`).
- Coding contracts: rep reward `2500 × difficulty × scaling/3` to a random hacking-work faction, or split across all; company variant 4000×… (`PlayerObjectGeneralMethods.ts:501-570`). Infiltration trade rep: see `src/Infiltration/formulas/victory.ts:28-63` (not multiplied by faction_rep or favor; × `BNmult.InfiltrationRep`).
- `ns.share()` (2.4 GB/thread, `RamCostGenerator.ts:566`): for 10 s adds `threads × (1 + int^0.8/600·2) × (1+(cores−1)/16)` to `shareThreads`; `ns.getSharePower()` returns the current multiplier.

### 2.3 Favor (`src/Faction/formulas/favor.ts:7-24`)
```
favorToRep(f) = 25000 × (1.02^f − 1)
repToFavor(r) = log(1 + r/25000) / log(1.02)        // clamped to [0, 35331]
favor_after_install = repToFavor(favorToRep(favor_before) + rep_at_install)
```
Applied to every faction and every company at each install/soft-reset (`src/Prestige.ts:104-106`). Cumulative rep needed: favor 10 → 5,475; 25 → 16,015; 50 → 42,290; 75 → 85,396; 100 → 156,116; **150 → 462,490**. Rep 1M → 187.5 favor; 2.5M → 233 favor. Favor resets to 0 at BitNode end.

Favor effects: faction work rep ×(1+favor/100); passive rep %; company work rep ×(1+favor/100); company salary ×(1+favor/100) only with SF11 (`src/Work/Formulas.ts:130-132`); Bladeburner/Church/SoA rep ×(1+favor/100).

### 2.4 Donation (`src/Faction/formulas/donation.ts:8-18`)
- Unlock: `faction.favor ≥ floor(150 × BNmult.FavorToDonateToFaction)` (BN3 → 75, BN8 → 0 i.e. always, BN12 → 150×1.02^lvl).
- `rep = amount / 1e6 × faction_rep × BNmult.FactionWorkRepGain` — favor does **not** multiply donations.
- API (`Singularity.ts:925-964`) additionally rejects: not member, gang faction, factions offering no work (Bladeburners/Church/SoA). Rep is never spent by buying augs, so donated rep only needs to reach the threshold.
- TRP by donation: `2.5e6 × AugmentationRepCost × 1e6 / (faction_rep × FactionWorkRepGain)` dollars minus current rep (BN1, faction_rep 3 → ≈ $833B).

### 2.5 Company rep (per cycle) — `src/Work/Formulas.ts:124-159`, `src/Company/CompanyPosition.ts:156-172`
```
jobPerf = repMultiplier × Σ(eff_stat × skill_stat)/975/100 + int/975
rep     = jobPerf × company_rep × (1+companyFavor/100) × BNmult.CompanyWorkRepGain × focus
salary  = baseSalary × company.salaryMultiplier × (SF11 ? 1+favor/100 : 1) × BNmult.CompanyWorkMoney × work_money × sf15 × focus   ($/cycle)
exp     = position.xxxExpGain × xxx_exp mult × company.expMultiplier × BNmult.CompanyWorkExpGain × focus   (per cycle, NOT /5)
```
- focus = 1 for part-time jobs regardless (`src/Work/CompanyWork.tsx:35-39`).
- `sf15 = SF15 lvl ≥ 2 ? 1 + 0.5(1−e^(−0.0002·cha)) + 0.6(1−e^(−0.00004·cha))×1.5 : 1` (`src/DarkNet/effects/effects.ts:105-111`). Despite the SF comment, it only boosts **salary**: the rep field it multiplies is overwritten (`Formulas.ts:146-156`).
- Example: Head of Software (repMult 1.6, hack 75 %, cha 25 %), hack 1000, cha 300, no int → 1.35 rep/cycle = 6.8 rep/s → 400k company rep ≈ 16 h at mult 1 (12 h with backdoor threshold 300k).

---

## 3. Augmentations

### 3.1 Purchase rules (`src/Faction/FactionHelpers.tsx:60-130`)
Must be a member; aug in the faction's list; not already queued/installed (NFG exempt); every prereq owned **or queued** (`Person.hasAugmentation` includes queued, `src/PersonObjects/Person.ts:233-241`); money ≥ price (skipped when price is 0); faction rep ≥ rep requirement. Rep is **not consumed**. Bought augs go to `queuedAugmentations` and take effect on install.

### 3.2 Price formulas (`src/Augmentation/AugmentationHelpers.ts:29-37,127-161`)
```
base1.9   = 1.9 × [1, 0.96, 0.94, 0.93][SF11 level]          // 1.9, 1.824, 1.786, 1.767
q         = # queued augs that are NOT SoA augs (each queued NFG level counts)
normal:   money = baseCost × base1.9^q × BNmult.AugmentationMoneyCost
          rep   = baseRep × BNmult.AugmentationRepCost
NFG:      L = installed NFG level + # NFG queued    (Augmentation.ts:238-246)
          money = 750,000 × 1.14^L × BNmult.AugmentationMoneyCost × base1.9^q
          rep   = 500 × 1.14^L × BNmult.AugmentationRepCost
SoA:      n = # SoA augs owned or queued
          money = 1e6 × 7^n ; rep = 1e4 × 1.3^n     (no BN mults, no 1.9 escalation, do not raise q)
```
- The multiplier applies to the **next** purchase; buying in descending base price order minimises total spend. Total for k buys = Σ p(i)·1.9^(i−1); k equal-priced augs cost p×(1.9^k−1)/0.9 (10 → 680p).
- BN aug cost mults: Money ×3 (BN3, BN7, BN15), ×2 (BN5, BN11), ×5 (BN10), ×1.5 (BN14), ×1.02^lvl (BN12). Rep ×3 (BN3), ×2 (BN10), ×1.02^lvl (BN12).
- NFG effect per level: every listed mult ×(1.01 + 262/1e8) (`Augmentations.ts:9,1159-1202`), hacknet costs ÷ same. SF12 grants NFG levels = SF12 level at BitNode start (`Prestige.ts:265-270`).

### 3.3 Install (`AugmentationHelpers.ts:69-115`, `src/Prestige.ts:55-200`, `PlayerObjectGeneralMethods.ts:80-141`)
Kills all scripts; applies queued augs; resets: skills/exp (hack..cha) to level-1 exp, money to $1,262 (= 1000 + `Donations` 262) + Σ `startingMoney` of installed augs (CashRoot +$1M), jobs, factions, invites (except keepOnInstall), purchased servers, hacknet nodes, **numPeopleKilled → 0**, city → Sector-12, entropy re-applied. Keeps: karma, intelligence, favor (+gain), SFs, Bladeburner rank (action cancelled), gang (rejoins gang faction), corporation, sleeves (shock/sync handling). Grants programs from installed augs (CashRoot BruteSSH; PCMatrix DeepscanV1+AutoLink; Neurolink FTPCrack+relaySMTP; Formulas if SF5/BN5). `ns.singularity.softReset(cb)` does the same with zero queued augs (still banks favor).

### 3.4 Full aug table (non-special, purchasable), sorted by base money
Effects are multiplicative mults. Abbrev: hack, hexp, hch (hack chance), hspd, h$ (hack money), hgr (grow), str/def/dex/agi/cha, combat = str+def+dex+agi, cx = combat exp, allx = all six exp, frep/crep (faction/company rep), w$ (work money), c$ (crime money), csucc (crime success), hn (hacknet production). Factions with ≥6 sellers abbreviated "many" — see §1.3.

| Aug (exact name) | $ base | Rep | Prereq | Effects | Sold by |
|---|---|---|---|---|---|
| Wired Reflexes | 2.5M | 1.25k | | agi, dex 1.05 | many (TDH, Slum Snakes, S-12, Volhaven, Aevum, Ishima, Syndicate, Dark Army, Speakers) |
| NutriGen Implant | 2.5M | 6.25k | | cx 1.2 | New Tokyo |
| Neurotrainer I | 4M | 1k | | allx 1.1 | CyberSec, Aevum |
| Hacknet Node NIC Architecture Neural-Upload | 4.5M | 1.875k | | hn 1.1, purchase cost 0.9 | Netburners |
| LuminCloaking-V1 Skin Implant | 5M | 1.5k | | agi 1.05, cha 1.03, c$ 1.1 | Slum Snakes, Tetrads |
| Hacknet Node Cache Architecture Neural-Upload | 5.5M | 2.5k | | hn 1.1, level cost 0.85 | Netburners |
| Synaptic Enhancement Implant | 7.5M | 2k | | hspd 1.03 | CyberSec, Aevum |
| BitWire | 10M | 3.75k | | hack 1.05 | CyberSec, NiteSec |
| Neural Wit Amplifier | 10M | 5k | | cha 1.03, chax 1.05, crep 1.05 | Slum Snakes, BitRunners |
| Hacknet Node CPU Architecture Neural-Upload | 11M | 3.75k | | hn 1.15, purchase 0.85 | Netburners |
| Speech Enhancement | 12.5M | 2.5k | | crep 1.1, cha 1.1 | TDH, Speakers, 4Sigma, KuaiGong, Clarke, B&A |
| Augmented Targeting I | 15M | 5k | | dex 1.1 | many |
| ADR-V1 Pheromone Gene | 17.5M | 3.75k | | frep 1.1, crep 1.1, chax 1.05 | TDH, Syndicate, NWO, MegaCorp, 4Sigma |
| Nuoptimal Nootropic Injector Implant | 20M | 5k | | crep 1.2, cha 1.03 | TDH, Volhaven, New Tokyo, Chongqing, Clarke, 4Sigma, B&A |
| Combat Rib I | 23.75M | 7.5k | | str, def 1.1 | many |
| Social Negotiation Assistant (S.N.A) | 30M | 6.25k | | frep 1.15, crep 1.15, w$ 1.1, chax 1.15 | TDH |
| LuminCloaking-V2 Skin Implant | 30M | 5k | LC-V1 | agi, def 1.1, chax 1.1, c$ 1.25 | Slum Snakes, Tetrads |
| INFRARET Enhancement | 30M | 7.5k | | csucc 1.25, c$ 1.1, dex 1.1 | Ishima |
| Hacknet Node Kernel Direct-Neural Interface | 40M | 7.5k | | hn 1.25 | Netburners |
| Augmented Targeting II | 42.5M | 8.75k | Targ I | dex 1.2 | Dark Army, Syndicate, S-12, OmniTek, KuaiGong, Blade |
| HemoRecirculator | 45M | 10k | | combat, cha 1.08 | Tetrads, Dark Army, Syndicate |
| Neurotrainer II | 45M | 10k | | allx 1.15 | BitRunners, NiteSec |
| DermaForce Particle Barrier | 50M | 15k | | def 1.4, cha 1.05 | Volhaven |
| Speech Processor Implant | 50M | 7.5k | | cha 1.2 | all 6 cities, TDH, Silhouette |
| Hacknet Node Core Direct-Neural Interface | 60M | 12.5k | | hn 1.45 | Netburners |
| Combat Rib II | 65M | 18.75k | CR I | str, def 1.14 | Dark Army, Syndicate, Volhaven, OmniTek, KuaiGong, Blade |
| Cranial Signal Processors - Gen I | 70M | 10k | | hack 1.05, hspd 1.01 | CyberSec, NiteSec |
| SmartSonar Implant | 75M | 22.5k | | dex 1.1, dexx 1.15, c$ 1.25 | Slum Snakes |
| Artificial Synaptic Potentiation | 80M | 6.25k | | hspd 1.02, hch 1.05, hexp 1.05 | Black Hand, NiteSec |
| BrachiBlades | 90M | 12.5k | | str, def 1.15, csucc 1.1, c$ 1.15 | Syndicate |
| Augmented Targeting III | 115M | 27.5k | Targ II, I | dex 1.3 | Dark Army, Syndicate, OmniTek, KuaiGong, Blade, Covenant |
| Combat Rib III | 120M | 35k | CR II, I | str, def 1.18 | same as Targ III |
| CashRoot Starter Kit | 125M | 12.5k | | +$1M & BruteSSH.exe after each install | Sector-12 |
| Cranial Signal Processors - Gen II | 125M | 18.75k | CSP I | hack 1.07, hch 1.05, hspd 1.02 | CyberSec, NiteSec |
| Golden Tongue Module | 125M | 125k | | cha 1.1, chax 1.3 | Speakers |
| Bionic Spine | 125M | 45k | | combat 1.15 | Speakers, Syndicate, KuaiGong, OmniTek, Blade |
| Nanofiber Weave | 125M | 37.5k | | str, def 1.2, cha 1.05 | Dark Army, Syndicate, OmniTek, Blade, TDH, Speakers, Fulcrum |
| Neurotrainer III | 130M | 25k | | allx 1.2 | NWO, 4Sigma |
| Power Recirculation Core | 180M | 25k | | all six skills 1.05, allx 1.1 | Tetrads, Dark Army, Syndicate, NWO |
| TITN-41 Gene-Modification Injection | 190M | 25k | | cha, chax 1.15 | Silhouette |
| CRTX42-AA Gene Modification | 225M | 45k | | hack 1.08, hexp 1.15 | NiteSec |
| Neural-Retention Enhancement | 250M | 20k | | hexp 1.25 | NiteSec |
| Magnetism Amplifier | 250M | 15k | | cha 1.05, crep 1.1 | Black Hand, Dark Army |
| Eloquence Module | 250M | 25k | | cha 1.05, csucc 1.1, w$ 1.2 | Speakers |
| Embedded Netburner Module | 250M | 15k | | hack 1.08 | BitRunners, Black Hand, NiteSec, ECorp, MegaCorp, Fulcrum, NWO, Blade |
| Bionic Arms | 275M | 62.5k | | str, dex 1.3 | Tetrads |
| Bionic Legs | 375M | 150k | | agi 1.6 | Speakers, Syndicate, KuaiGong, OmniTek, Blade |
| Neuregen Gene Modification | 375M | 37.5k | | hexp 1.4 | Chongqing |
| The Shadow's Simulacrum | 400M | 37.5k | | frep 1.15, crep 1.15 | Syndicate, Dark Army, Speakers |
| DataJack | 450M | 112.5k | | h$ 1.25 | BitRunners, Black Hand, NiteSec, Chongqing, New Tokyo |
| Neuroreceptor Management Implant | 550M | 75k | | removes unfocused 0.8 penalty | TDH |
| Cranial Signal Processors - Gen III | 550M | 50k | CSP II, I | hack 1.09, h$ 1.15, hspd 1.02 | NiteSec, Black Hand, BitRunners |
| ADR-V2 Pheromone Gene | 550M | 62.5k | | frep 1.2, crep 1.2, cha 1.1 | Silhouette, 4Sigma, B&A, Clarke |
| The Black Hand | 550M | 100k | | hack 1.1, h$ 1.1, hspd 1.02, str, dex 1.15 | Black Hand |
| FocusWire | 900M | 75k | | allx 1.05, crep 1.1, w$ 1.2 | B&A, Clarke, 4Sigma, KuaiGong |
| Cranial Signal Processors - Gen IV | 1.1B | 125k | CSP III–I | h$ 1.2, hgr 1.25, hspd 1.02 | Black Hand, BitRunners |
| Synfibril Muscle | 1.125B | 437.5k | | str, def 1.3 | KuaiGong, Fulcrum, Speakers, NWO, Covenant, Daedalus, Illuminati, Blade |
| Social Dynamics Processor | 1.2B | 225k | | crep 1.3, cha 1.1 | MegaCorp, ECorp, OmniTek |
| Neuronal Densification | 1.375B | 187.5k | | hack 1.15, hexp 1.1, hspd 1.03 | Clarke |
| Enhanced Social Interaction Implant | 1.375B | 375k | | cha, chax 1.6 | B&A, NWO, Clarke, OmniTek, 4Sigma |
| Enhanced Myelin Sheathing | 1.375B | 100k | | hack 1.08, hexp 1.1, hspd 1.03 | Fulcrum, BitRunners, Black Hand |
| Neural Accelerator | 1.75B | 200k | | hack 1.1, hexp 1.15, h$ 1.2 | BitRunners |
| nextSENS Gene Modification | 1.925B | 437.5k | | all six skills 1.2 | Clarke |
| PCMatrix | 2B | 100k | | w$ 1.777; frep, crep, cha, chax, csucc, c$ 1.0777; DeepscanV1+AutoLink after install | Aevum |
| Cranial Signal Processors - Gen V | 2.25B | 250k | CSP IV–I | hack 1.3, h$ 1.25, hgr 1.75 | BitRunners |
| Embedded Netburner Module Core Implant | 2.5B | 175k | ENM | hack 1.07, hexp 1.07, h$ 1.1, hch 1.03, hspd 1.03 | BitRunners, Black Hand, ECorp, MegaCorp, Fulcrum, NWO, Blade |
| Glibness Enhancement | 2.5B | 40.5k | | chax 1.2, crep 1.1 | Tetrads, Bladeburners |
| Graphene BrachiBlades Upgrade | 2.5B | 225k | BrachiBlades | str, def 1.4, csucc 1.1, c$ 1.3 | Speakers |
| Photosynthetic Cells | 2.75B | 562.5k | | str, def, agi 1.4, cha 1.2 | KuaiGong |
| SmartJaw | 2.75B | 375k | | frep 1.25, crep 1.25, cha, chax 1.5 | B&A |
| HyperSight Corneal Implant | 2.75B | 150k | | dex 1.4, h$ 1.1, hspd 1.03, cha 1.03 | Blade, KuaiGong |
| Synthetic Heart | 2.875B | 750k | | str, agi 1.5, cha 1.3 | KuaiGong, Fulcrum, Speakers, NWO, Covenant, Daedalus, Illuminati |
| OmniTek InfoLoad | 2.875B | 625k | | hack 1.2, hexp 1.25 | OmniTek |
| Neotra | 2.875B | 562.5k | | str, def, cha 1.55 | Blade |
| Artificial Bio-neural Network Implant | 3B | 275k | | hack 1.12, h$ 1.15, hspd 1.03 | BitRunners, Fulcrum |
| Neuralstimulator | 3B | 50k | | hch 1.1, hexp 1.12, hspd 1.02 | Black Hand, all 6 cities, B&A, Clarke, 4Sigma |
| NEMEAN Subdermal Weave | 3.25B | 875k | | def 2.2 | Syndicate, Fulcrum, Illuminati, Daedalus, Covenant |
| The Illustrated Primer | 3.375B | 187.5k | | cha 1.1, chax 1.4 | Dark Army, Syndicate |
| PC Direct-Neural Interface | 3.75B | 375k | | crep 1.3, hack 1.08 | 4Sigma, OmniTek, ECorp, Blade |
| Graphene Bionic Arms Upgrade | 3.75B | 500k | Bionic Arms | str, dex 1.85 | Dark Army |
| Graphene Bone Lacings | 4.25B | 1.125M | | str, def 1.7 | Fulcrum, Covenant |
| Xanipher | 4.25B | 875k | | all six skills 1.2, allx 1.15 | NWO |
| BitRunners Neurolink | 4.375B | 875k | | hack 1.15, hexp 1.2, hch 1.1, hspd 1.05; FTPCrack+relaySMTP after install | BitRunners |
| Embedded Netburner Module Core V2 Upgrade | 4.5B | 1M | ENM Core, ENM | hack 1.08, hexp 1.15, h$ 1.3, hch 1.05, hspd 1.05 | BitRunners, ECorp, MegaCorp, Fulcrum, NWO, Blade, OmniTek, KuaiGong |
| PC Direct-Neural Interface Optimization Submodule | 4.5B | 500k | PC DNI | crep 1.75, hack 1.1 | Fulcrum, ECorp, Blade |
| Graphene Bionic Legs Upgrade | 4.5B | 750k | Bionic Legs | agi 2.5 | MegaCorp, ECorp, Fulcrum |
| SPTN-97 Gene Modification | 4.875B | 1.25M | | combat 1.75, hack 1.15 | Covenant |
| CordiARC Fusion Reactor | 5B | 1.125M | | combat 1.35, cx 1.35 | MegaCorp |
| Unstable Circadian Modulator | 5B | 362.5k | | one of 7 random bonus sets (below) | Speakers |
| ECorp HVMind Implant | 5.5B | 1.5M | | hgr 3 | ECorp |
| Embedded Netburner Module Analyze Engine | 6B | 625k | ENM | hspd 1.1 | ECorp, MegaCorp, Fulcrum, NWO, Daedalus, Covenant, Illuminati |
| Graphene Bionic Spine Upgrade | 6B | 1.625M | Bionic Spine | combat 1.6 | Fulcrum, ECorp |
| Embedded Netburner Module Direct Memory Access Upgrade | 7B | 1M | ENM | h$ 1.4, hch 1.2 | as Analyze Engine |
| Embedded Netburner Module Core V3 Upgrade | 7.5B | 1.75M | V2, Core, ENM | hack 1.1, hexp 1.25, h$ 1.4, hch 1.1, hspd 1.05 | as Analyze Engine |
| PC Direct-Neural Interface NeuroNet Injector | 7.5B | 1.5M | PC DNI | crep 2, hack 1.1, hspd 1.05 | Fulcrum |
| Hydroflame Left Arm | 2.5T | 1.25M | | str 2.8 | NWO |
| QLink | 25T | 1.875M | | hack 1.75, hspd 2, hch 2.5, h$ 4 | Illuminati |
| violet Congruity Implant | 50T | ∞ | | removes & blocks grafting entropy | no faction — graft only |

Unstable Circadian Modulator bonus (`src/Augmentation/CircadianModulator.ts:33-117`): picked by `WHRNG(floor(Date.now()/3.6e6))` stepped 5×; options: {hch 1.25, hspd 1.1, h$ 1.25, hgr 1.1} | {hack 1.15, hexp 2} | {combat 1.25, cx 2} | {cha 1.5, chax 2} | {hn 1.2, hn costs 0.85} | {crep 1.25, frep 1.15, w$ 1.7} | {csucc 2, c$ 2}. Re-rolled at each install (`Prestige.ts:119`) and at game load (module init) — the installed copy's effect follows the current hour bucket at those moments.

### 3.5 Special augs
| Aug | $ / rep | Notes |
|---|---|---|
| NeuroFlux Governor | 750k / 500 base, ×1.14^L | repeatable; §3.2 |
| The Red Pill | $0 / 2.5M | Daedalus only (gang faction in BN2; not in BN15 Daedalus). Installing links `w0r1d_d43m0n` ↔ `The-Cave` (`Prestige.ts:174-182`). Buy it **last** in a batch: it increments q. |
| Bladeburner (17, Bladeburners only; Glib also) | EsperTech Bladeburner Eyewear 165M/1.25k; EMS-4 Recombination 275M/2.5k; ORION-MKIV Shoulder 550M/6.25k; BLADE-51b Tesla Armor 1.375B/12.5k; …IPU Upgrade 1.1B/15k; …Power Cells Upgrade 2.75B/18.75k; Hyperion Plasma Cannon V1 2.75B/12.5k; Vangelis Virus 2.75B/18.75k; …Energy Shielding Upgrade 5.5B/21.25k; I.N.T.E.R.L.I.N.K.E.D 5.5B/25k; Hyperion Plasma Cannon V2 5.5B/25k; Blade's Runners 8.25B/20k; GOLEM Serum 11B/31.25k; Vangelis Virus 3.0 11B/37.5k; …Unibeam Upgrade 16.5B/31.25k; …Omnibeam Upgrade 27.5B/62.5k; The Blade's Simulacrum 150B/1.25k | normal cost formula. Blade's Simulacrum = do Bladeburner actions concurrently with other work. |
| Shadows of Anarchy (9) | SoA - Might of Ares, Wisdom of Athena, Trickery of Hermes, Beauty of Aphrodite (cha 1.1), Chaos of Dionysus, Flood of Poseidon, Hunt of Artemis, Knowledge of Apollo, phyzical WKS harmonizer | 1e6×7^n / 1e4×1.3^n; infiltration minigame helpers; WKS: infiltration $×1.5, trade rep ×1.2, SoA rep ×2 |
| Stanek's Gift - Genesis / Awakening / Serenity | 0 / 0, 1M, 100M | Church only. Genesis: all mults ×0.9; Awakening → ×0.95; Serenity → ×1.0 |
| Darknet lab augs: The W1ngs of Icarus → The B00ts of Perseus → The H4mmer of Daedalus → The St4ff of Asclepius → The L4w of Bayes → The B1ade of Solomonoff | from darknet labyrinths | `src/DarkNet/effects/labyrinth.ts:403-430` |
| Z.O.Ë. | $1T | sleeves only (Church) |
| BigD's Big ... Brain | ∞ | unobtainable in normal play |

### 3.6 Alternative Red Pill sources
`getLabAugReward` (`labyrinth.ts:403-430`): in **BN15**, the lab after The St4ff (5th) awards The Red Pill; in any BN with `DarknetLabyrinthRewardsTheRedPill = 1` (all except BN8), finishing all six lab augs awards The Red Pill. See the darknet doc for lab mechanics.

---

## 4. Companies

### 4.1 Mechanics
- Apply (`PlayerObjectGeneralMethods.ts:300-352`): must qualify for the requested position; then auto-climbs `nextPosition` while qualified and offered by the company. One job per company; multiple companies allowed. **No automatic promotion** — re-apply. `ns.singularity.applyToCompany(company, field)` always starts from the field's track entry (`Singularity.ts:719-737`), so tracks whose entry the company lacks (e.g. DefComm/Helios/AeroCorp CEO-only listings) are UI-only. No city check in API apply/work (UI requires being at the location).
- Requirements (`src/Company/CompanyPosition.ts:144-154`, `GetJobRequirements.ts:7-19`): each **non-zero** base stat req + company `jobStatReqOffset`; company rep req ×0.75 if company server backdoored.
- Track transitions: IT → Systems Administrator → Head of Engineering; Network Engineer → Network Administrator → Head of Engineering; Security Engineer → Head of Engineering.
- Company favor: same formula as factions (`src/Company/Company.ts:77-80`). Quitting keeps rep.

### 4.2 Positions (`src/Company/data/CompanyPositionsMetadata.ts`)
Salary in $/cycle (×5 for $/s) before company salaryMultiplier. Reqs listed as base (add offset). Eff = job-performance weights (sum 100). Exp per cycle before company expMultiplier.

| Position | Track next | Salary | repMult | Stat reqs (h/s/d/dx/a/c) | Rep req | Eff | Exp/cycle |
|---|---|---|---|---|---|---|---|
| Software Engineering Intern | Junior SE | 33 | 0.9 | h1 | — | h85 c15 | h.05 c.02 |
| Junior Software Engineer | Senior SE | 80 | 1.1 | h51 | 8k | h85 c15 | h.1 c.05 |
| Senior Software Engineer | Lead Dev | 165 | 1.3 | h251 c51 | 40k | h80 c20 | h.4 c.08 |
| Lead Software Developer | Head of Software | 500 | 1.5 | h401 c151 | 200k | h75 c25 | h.8 c.1 |
| Head of Software | Head of Eng | 800 | 1.6 | h501 c251 | 400k | h75 c25 | h1 c.5 |
| Head of Engineering | VP Tech | 1650 | 1.6 | h501 c251 | 800k | h75 c25 | h1.1 c.5 |
| Vice President of Technology | CTO | 2310 | 1.75 | h601 c401 | 1.6M | h70 c30 | h1.2 c.6 |
| Chief Technology Officer | — | 2640 | 2 | h751 c501 | 3.2M | h65 c35 | h1.5 c1 |
| IT Intern | IT Analyst | 26 | 0.9 | h1 | — | h90 c10 | h.04 c.01 |
| IT Analyst | IT Manager | 66 | 1.1 | h26 | 7k | h85 c15 | h.08 c.02 |
| IT Manager | Sys Admin | 132 | 1.3 | h151 c51 | 35k | h80 c20 | h.3 c.1 |
| Systems Administrator | Head of Eng | 410 | 1.4 | h251 c76 | 175k | h80 c20 | h.5 c.2 |
| Security Engineer (entry) | Head of Eng | 121 | 1.2 | h151 c26 | 35k | h85 c15 | h.4 c.05 |
| Network Engineer (entry) | Network Admin | 121 | 1.2 | h151 c26 | 35k | h85 c15 | h.4 c.05 |
| Network Administrator | Head of Eng | 410 | 1.3 | h251 c76 | 175k | h80 c20 | h.5 c.1 |
| Business Intern | Business Analyst | 46 | 0.9 | h1 c1 | — | h10 c90 | h.01 c.08 |
| Business Analyst | Business Manager | 100 | 1.1 | h6 c51 | 8k | h15 c85 | h.02 c.15 |
| Business Manager | Operations Manager | 200 | 1.3 | h51 c101 | 40k | h15 c85 | h.02 c.3 |
| Operations Manager | CFO | 660 | 1.5 | h51 c226 | 200k | h15 c85 | h.02 c.4 |
| Chief Financial Officer | CEO | 1950 | 1.6 | h76 c501 | 800k | h10 c90 | h.05 c1 |
| Chief Executive Officer | — | 3900 | 1.75 | h101 c751 | 3.2M | h10 c90 | h.05 c1.5 |
| Security Guard | Security Officer | 50 | 1 | s/d/dx/a 51, c1 | — | h5 combat 20 each c15 | h.01 combat .04 c.02 |
| Security Officer | Security Supervisor | 195 | 1.1 | h26 combat 151 c51 | 8k | h10 combat 20 c10 | h.02 combat .1 c.05 |
| Security Supervisor | Head of Security | 660 | 1.25 | h26 combat 251 c101 | 36k | h10 combat 15 c30 | h.02 combat .12 c.1 |
| Head of Security | — | 1320 | 1.4 | h51 combat 501 c151 | 144k | h10 combat 15 c30 | h.05 combat .15 c.15 |
| Field Agent | Secret Agent | 330 | 1 | all 101 | 8k | h10 s15 d15 dx20 a20 c20 | h.04 combat .08 c.05 |
| Secret Agent | Special Operative | 990 | 1.25 | h201 combat 251 c201 | 32k | h15 s15 d15 dx20 a20 c15 | h.1 combat .15 c.1 |
| Special Operative | — | 2000 | 1.5 | h251 combat 501 c251 | 162k | as above | h.15 combat .2 c.15 |
| Software Consultant | Senior SC | 66 | 1 | h51 | — | h80 c20 | h.08 c.03 |
| Senior Software Consultant | — | 132 | 1.2 | h251 c51 | — | h75 c25 | h.25 c.06 |
| Business Consultant | Senior BC | 66 | 1 | h6 c51 | — | h20 c80 | h.015 c.15 |
| Senior Business Consultant | — | 525 | 1.2 | h51 c226 | — | h15 c85 | h.015 c.3 |
| Waiter / Employee | — | 22 | 1 | — | — | s10 dx10 a10 c70 | combat .02, c .05/.04 |
| Part-time Waiter / Part-time Employee | — | 20 | 1 | — | — | same | combat .0075, c .04/.03; **no focus penalty** |

### 4.3 Companies (`src/Company/data/CompaniesMetadata.ts:21-319`, cities from `src/Locations/data/LocationsMetadata.ts`)
Tracks: T = Software+IT+Network Eng+Security Eng; B = Business; S = Security; A = Agent; SC/BC = consultants; "Sw≤HoE" = Software up to Head of Engineering. mult = salary = exp multiplier. Server = backdoor target for the ×0.75 rep discount.

| Company | City | mult | offset | Tracks | Faction | Server (hack) |
|---|---|---|---|---|---|---|
| ECorp | Aevum | 3 | 249 | T B S | ECorp | ecorp (1050–1400) |
| MegaCorp | Sector-12 | 3 | 249 | T B S | MegaCorp | megacorp (1100–1350) |
| NWO | Volhaven | 2.75 | 249 | T B S | NWO | nwo (950–1300) |
| Blade Industries | Sector-12 | 2.75 | 224 | T B S | Blade Industries | blade (900–1200) |
| Bachman & Associates | Aevum | 2.6 | 224 | T B S | B&A | b-and-a (900–1150) |
| Four Sigma | Sector-12 | 2.5 | 224 | T B S | Four Sigma | 4sigma (900–1250) |
| Clarke Incorporated | Aevum | 2.25 | 224 | T B S | Clarke | clarkinc (950–1250) |
| OmniTek Incorporated | Volhaven | 2.25 | 224 | T B S | OmniTek | omnitek (900–1100) |
| KuaiGong International | Chongqing | 2.2 | 224 | T B S | KuaiGong | kuai-gong (950–1300) |
| Fulcrum Technologies | Aevum | 2 | 224 | T B | Fulcrum Secret Technologies | fulcrumtech (950–1250) |
| Universal Energy | Sector-12 | 2 | 199 | T B SC | — | univ-energy (800–900) |
| Central Intelligence Agency | Sector-12 | 2 | 149 | Sw≤HoE, NetEng, SecEng, IT, S, A | (blocks crime factions) | — |
| National Security Agency | Sector-12 | 2 | 149 | same as CIA | (blocks crime factions) | — |
| Icarus Microsystems | Sector-12 | 1.9 | 199 | T B SC | — | icarus (850–925) |
| Galactic Cybersystems | Aevum | 1.9 | 199 | T B SC | — | galactic-cyber (825–875) |
| Storm Technologies | Ishima | 1.8 | 199 | T SC B | — | stormtech (875–1075) |
| Helios Labs | Volhaven | 1.8 | 199 | CEO, T, SC, BC | — | helios (800–900) |
| VitaLife | New Tokyo | 1.8 | 199 | T B SC | — (grafting lab) | vitalife (775–900) |
| Global Pharmaceuticals | New Tokyo | 1.8 | 224 | T B SC S | — | global-pharm (750–850) |
| DefComm | New Tokyo | 1.75 | 199 | CEO, T, SC, BC | — | defcomm (850–1050) |
| Nova Medical | Ishima | 1.75 | 199 | T B SC S | — | nova-med (775–850) |
| AeroCorp | Aevum | 1.7 | 199 | Ops Mgr, CEO, T, S, BC | — | aerocorp (850–925) |
| Omnia Cybersystems | Volhaven | 1.7 | 199 | Ops Mgr, CEO, T, S, BC | — | omnia (850–950) |
| Solaris Space Systems | Chongqing | 1.7 | 199 | Ops Mgr, CEO, T, S, BC | — | solaris (750–850) |
| DeltaOne | Sector-12 | 1.6 | 199 | Ops Mgr, CEO, T, S, BC | — | deltaone (800–900) |
| Watchdog Security | Aevum | 1.5 | 124 | Sw≤HoE, NetEng, IT, S, A, SC | — | — |
| Alpha Enterprises | Sector-12 | 1.5 | 99 | Sw≤Lead Dev, B≤Ops Mgr, SC | — | alpha-ent (500–600) |
| LexoCorp | Volhaven | 1.4 | 99 | T SC B S | — | lexo-corp (650–750) |
| Rho Construction | Aevum | 1.3 | 49 | Sw≤Lead Dev, B≤Ops Mgr | — | rho-construction (475–525) |
| Aevum Police Headquarters | Aevum | 1.3 | 99 | S, Sw≤Lead Dev | — | aevum-police (400–450) |
| SysCore Securities | Volhaven | 1.3 | 124 | T | — | syscore (550–650) |
| CompuTek | Volhaven | 1.2 | 74 | T | — | computek (300–400) |
| NetLink Technologies | Aevum | 1.2 | 99 | T | — | netlink (375–425) |
| Carmichael Security | Sector-12 | 1.2 | 74 | T SC A S | — | — |
| Omega Software | Ishima | 1.1 | 49 | Software (full), SC, IT | — | omega-net (180–220) |
| FoodNStuff | Sector-12 | 1 | 0 | Employee, PT Employee | — | foodnstuff (1) |
| Joe's Guns | Sector-12 | 1 | 0 | Employee, PT Employee | — | joesguns (10) |
| Noodle Bar | New Tokyo | 1 | 0 | Waiter, PT Waiter | — | n00dles (1) |

Company → faction: the ten above with a Faction column (400k / 300k company rep while employed there). Silhouette needs CTO/CFO/CEO anywhere. CIA/NSA employment blocks Speakers, Dark Army, Syndicate invites. Company work also moves stock prices (`influenceStockThroughCompanyWork`, `CompanyWork.tsx:49`).

---

## 5. Work & stat growth

### 5.1 Skill ↔ exp (`src/PersonObjects/formulas/skill.ts:7-34`)
```
level = max(1, floor(m × (32·ln(exp + 534.6) − 200)))      m = skill mult × BNmult.<Skill>LevelMultiplier
exp(L) = e^((L/m + 200)/32) − 534.6
```
Exp needed at m = 1: L10 173; L30 788; L50 1,937; L75 4,863; L100 11,264; L150 55,710; L200 267,800; L250 1.28e6; L300 6.11e6; L500 3.16e9; L750 7.82e12; L1000 1.93e16; L1500 1.18e23; L2500 4.40e36; L3000 2.69e43. Each +32×m levels ≈ ×e exp. Skill mults (augs) scale *level* linearly; exp mults scale *exp* (worth only +32·m·ln(k) levels). On install all exp reset; level-1 exp computed with new mults (`Prestige.ts:43-52`). HP max = floor(10 + def/10) (`Person.ts:96-98`). Intelligence: `1 + int^0.8/600` bonus factor; int only gained in BN5 or with SF5 (`Person.ts:176-190`).

### 5.2 Gyms & universities (`src/Work/ClassWork.tsx:22-73`, `src/Work/Formulas.ts:100-121`)
Per second: exp = base × location.expMult × hashMult (hacknet study/training upgrades) × skill exp mult; cost = base$ × location.costMult × (0.9 if the location's server is backdoored).

| Class | base exp/s | base $/s |
|---|---|---|
| Computer Science | hack 0.5 | 0 |
| Data Structures | hack 1 | 40 |
| Networks | hack 2 | 80 |
| Algorithms | hack 4 | 320 |
| Management | cha 2 | 160 |
| Leadership | cha 4 | 320 |
| Gym (str/def/dex/agi, each separately) | 1 | 120 |
University classes also give 0.01 int exp/s base.

| Location | City | expMult | costMult | Server (hack) |
|---|---|---|---|---|
| Rothman University | Sector-12 | 2 | 3 | rothman-uni (370–430) |
| Summit University | Aevum | 3 | 4 | summit-uni (425–475) |
| ZB Institute of Technology | Volhaven | 4 | 5 | zb-institute (725–775) |
| Iron Gym | Sector-12 | 1 | 1 | iron-gym (100) |
| Powerhouse Gym | Sector-12 | 10 | 20 | powerhouse-fitness (950–1100) |
| Crush Fitness Gym | Aevum | 2 | 3 | crush-fitness (225–275) |
| Snap Fitness Gym | Aevum | 5 | 10 | snap-fitness (675–800) |
| Millenium Fitness Gym | Volhaven | 4 | 7 | millenium-fitness (475–525) |

Quirks: **class work has no focus penalty** (`ClassWork.tsx:105-111` uses no focus factor) and **`BNmult.ClassGymExpGain` is never read** anywhere in v3.0.1 (only defined/displayed) — so BN4/BN12/BN13 class nerfs are not applied. Best rates: ZB Algorithms 16 hack-exp/s for $1,600/s; Powerhouse 10/s per stat for $2,400/s.

### 5.3 Crimes (`src/Crime/Crimes.ts:5-261`, `src/Crime/Crime.ts:120-136`, `src/Work/CrimeWork.ts:35-86`)
```
chance = min(1, (Σ weight_s × skill_s + 0.025×int) / 975 / difficulty × crime_success × BNmult.CrimeSuccessRate × (1 + int^0.8/600))
success: money = base × crime_money × BNmult.CrimeMoney (NOT focus-scaled); exp = base × exp mult × BNmult.CrimeExpGain × focus;
         kills += crime.kills; karma −= karma × focus; int exp gained
failure: exp × 0.25, karma/4 × focus, no money, no kills
```
Randomness: `Math.random() <= chance` per attempt (`src/Crime/CrimeHelpers.ts:7-11`). Crimes auto-repeat; offline catch-up capped at 30 days of cycles. Karma persists through installs (reset only at BN end); kills reset on install.

| Crime | Time | $ | Diff | Karma | Kills | Success weights | Exp per success | 100 % at (all relevant stats = S, mults 1) | $/s | karma/s |
|---|---|---|---|---|---|---|---|---|---|---|
| Shoplift | 2 s | 15k | 1/20 | 0.1 | | dex 1, agi 1 | dex 2, agi 2 | S ≥ 24.4 | 7.5k | 0.05 |
| Rob Store | 60 s | 400k | 1/5 | 0.5 | | hack .5, dex 2, agi 1 | hack 30, dex 45, agi 45; int .375 | S ≥ 55.7 | 6.7k | 0.008 |
| Mug | 4 s | 36k | 1/5 | 0.25 | | str 1.5, def .5, dex 1.5, agi .5 | combat 3 each | S ≥ 48.8 | 9k | 0.0625 |
| Larceny | 90 s | 800k | 1/3 | 1.5 | | hack .5, dex 1, agi 1 | hack 45, dex 60, agi 60; int .75 | S ≥ 130 | 8.9k | 0.017 |
| Deal Drugs | 10 s | 120k | 1 | 0.5 | | cha 3, dex 2, agi 1 | dex 5, agi 5, cha 10 | S ≥ 162.5 | 12k | 0.05 |
| Bond Forgery | 300 s | 4.5M | 1/2 | 0.1 | | hack .05, dex 1.25 | hack 100, dex 150, cha 15; int 3 | S ≥ 375 | 15k | 0.0003 |
| Traffick Arms | 40 s | 600k | 2 | 1 | | cha, str, def, dex, agi 1 | combat 20 each, cha 40 | S ≥ 390 | 15k | 0.025 |
| Homicide | 3 s | 45k | 1 | 3 | 1 | str 2, def 2, dex .5, agi .5 | combat 2 each | S ≥ 195 | 15k | **1.0** |
| Grand Theft Auto | 80 s | 1.6M | 8 | 5 | | hack 1, str 1, dex 4, agi 2, cha 2 | str/def/dex 20, agi 80, cha 40; int .8 | S ≥ 780 | 20k | 0.0625 |
| Kidnap | 120 s | 3.6M | 5 | 6 | | cha, str, dex, agi 1 | combat 80 each, cha 80; int 1.3 | S ≥ 1219 | 30k | 0.05 |
| Assassination | 300 s | 12M | 8 | 10 | 1 | str 1, dex 2, agi 1 | combat 300 each; int 3.25 | S ≥ 1950 | 40k | 0.033 |
| Heist | 600 s | 120M | 18 | 15 | | all six 1 | all six 450; int 6.5 | S ≥ 2925 | 200k | 0.025 |

Gang karma target −54,000 (`src/Gang/data/Constants.ts:27`): Homicide at 100 % focused = 54,000 s = 15 h (18.75 h unfocused without Neuroreceptor). Sleeves doing crime add karma `× syncBonus` with no focus penalty (`src/PersonObjects/Sleeve/Work/SleeveCrimeWork.ts:44-47`).

### 5.4 Multiplier stack summary
Player mults = Π(installed aug mults, NFG per level) × SF bonuses (`src/SourceFile/applySourceFile.ts`) × entropy 0.98^stacks (`src/PersonObjects/Grafting/EntropyAccumulation.ts`). Relevant SF bonuses: SF1 all mults (+16/24/28 %), SF2 crime money/success, cha (+24/36/42 %), SF3 cha & work money (+8/12/14 %), SF5 hacking mults, SF6 combat skill/exp, SF11 work money & company rep (+32/48/56 %) and aug price base (§3.2), SF15 cha-based bonuses.

| Mechanic | BitNode mults that apply |
|---|---|
| Faction work rep | FactionWorkRepGain |
| Passive faction rep | FactionPassiveRepGain (× above via work rate) |
| Donation | FavorToDonateToFaction (threshold), FactionWorkRepGain |
| Faction work exp | FactionWorkExpGain |
| Company rep / $ / exp | CompanyWorkRepGain / CompanyWorkMoney / CompanyWorkExpGain |
| Crime | CrimeSuccessRate, CrimeMoney, CrimeExpGain |
| Class/gym | (ClassGymExpGain defined but unused) |
| Skill levels | Hacking/Strength/Defense/Dexterity/Agility/CharismaLevelMultiplier |
| Aug price | AugmentationMoneyCost, AugmentationRepCost (not SoA; not grafting) |
| Daedalus invite | DaedalusAugsRequirement |
| Gang faction augs | GangUniqueAugs |
| Infiltration rewards | InfiltrationMoney, InfiltrationRep |
| Red Pill via lab | DarknetLabyrinthRewardsTheRedPill (0 only in BN8) |

Randomness: crime success; backdoor-server hack levels (per-BN ranges); Unstable Circadian bonus (hour-seeded); gang unique augs (seeded, deterministic); coding-contract reward faction choice; infiltration games.

### 5.5 Travel & hospital
- Travel: $200,000 flat (`Constants.ts:28`, `Person.ts:243-252`); `travelToCity` API, no time cost.
- Hospital: cost `min(10 % of money, missingHP × $100,000)`, 0 if money < 0 (`src/Hospital/Hospital.ts:4-10`). Auto-triggered when HP ≤ 0 (`takeDamage`), or `ns.singularity.hospitalize()`.

### 5.6 Focus
`focusPenalty = NeuroreceptorManager installed ? 1 : (focus ? 1 : 0.8)` (`PlayerObjectGeneralMethods.ts:622-628`). Applies to: faction work (rep+exp), company work (rep+$+exp, not part-time), crime (exp+karma, not money), create-program, grafting speed. Not to classes. Leaving the Work page clears focus (`src/ui/GameRoot.tsx:270-275`). API work calls default `focus=true`.

---

## 6. Grafting (BN10 / SF10) — `src/PersonObjects/Grafting/*`, `src/Work/GraftingWork.tsx`, `src/NetscriptFunctions/Grafting.ts`
- Access: in BN10 or SF10 (`canAccessGrafting`). Must be in New Tokyo (API check; UI at VitaLife). Does **not** need SF4.
- Graftable: every aug with `isSpecial = false` not already installed/queued (so excludes NFG, TRP, SoA, Stanek, Bladeburner augs, lab augs, Z.O.Ë.); Bladeburner augs become graftable while a Bladeburners member (`GraftingHelpers.ts:8-21`). Includes QLink, HVMind, Hydroflame, Unstable Circadian, violet Congruity Implant. Prereqs must be owned or queued. No faction/rep needed.
- Cost: `baseCost × 3`, paid up front, non-refundable on cancel (`GraftableAugmentation.ts:20-22`). **No BN AugmentationMoneyCost, no 1.9^q escalation.** (In BN10 normal purchases are ×5 × 1.9^q.)
- Time (ms): `(3,600,000 × log2(max(1, Σ mults≠1)) + 1,800,000) / 2`, divided by `1 + int^0.8/600`, progress per cycle × focus factor (`GraftableAugmentation.ts:24-30`, `GraftingWork.tsx:40-46`). E.g. single 1.1 mult ≈ 19 min; QLink (Σ = 10.25) ≈ 1.93 h.
- Effect: applied **immediately** to `Player.augmentations` (no install; counts toward Daedalus/Illuminati/Covenant aug counts). Removes the aug from the queue if queued. Grants int exp `cycles × 0.001`.
- Entropy: each graft +1 stack unless Congruity Implant installed; all player mults ×0.98^stacks (hacknet costs ÷), persists through installs, cleared at BitNode end or by grafting violet Congruity Implant ($150T).
- API: `getAugmentationGraftPrice` 3.75 GB, `getAugmentationGraftTime` 3.75, `getGraftableAugmentations` 5, `graftAugmentation(name, focus)` 7.5, `waitForOngoingGrafting` 0 (`RamCostGenerator.ts:457-463`).

---

## 7. API vs UI

RAM: Singularity base costs Fn1 = 2, Fn2 = 3, Fn3 = 5 GB (`RamCostGenerator.ts:55-57`). Multiplier: in BN4 or SF4.3 → ×1; SF4.2 → ×4; SF4.1 → ×16 (`:82-96`). Without SF4 outside BN4 every function throws.

| Action | API (base RAM) | Notes / UI-only aspects |
|---|---|---|
| Faction invites list / join | `checkFactionInvitations` 3, `joinFaction` 3, `getFactionInviteRequirements` 3 (structured JSON), `getFactionEnemies` 3 | `getPlayer()` (0.5, no SF) exposes `factions`, `jobs`, `karma`, `numPeopleKilled`, `city`, `mults` |
| Faction work | `workForFaction(f, type, focus)` 3, `getFactionWorkTypes` 1, `getFactionRep`/`Favor` 1, `getFactionFavorGain` 0.75 | gang faction rejected |
| Donate | `donateToFaction` 5 | |
| Augs | `getAugmentationsFromFaction` 5, `getAugmentationFactions` 5, `getAugmentationPrereq` 5, `getAugmentationStats` 5, `getAugmentationPrice` 2.5 (current, incl. 1.9^q), `getAugmentationRepReq` 2.5, `getAugmentationBasePrice` 2.5, `getOwnedAugmentations(purchased)` 5, `purchaseAugmentation` 5 | `getResetInfo()` (1 GB, no SF) gives installed augs+levels |
| Install / soft reset | `installAugmentations(cb)` 5, `softReset(cb)` 5 | cb script started 500 ms later with 1 thread if RAM allows |
| Company | `applyToCompany(c, field)` 3, `workForCompany` 3, `quitJob` 3, `getCompanyRep`/`Favor` 1, `getCompanyPositions` 2, `getCompanyPositionInfo` 2 | API apply starts at track entry; UI can apply to any listed qualified position |
| Gym/University | `gymWorkout` 2, `universityCourse` 2 | must be in the city |
| Crime | `commitCrime(type, focus)` 5, `getCrimeChance` 5, `getCrimeStats` 5 | |
| Travel / hospital | `travelToCity` 2, `hospitalize` 0.5 | |
| Work control | `getCurrentWork` 0.5, `stopAction` 1, `isBusy` 0.5, `isFocused`/`setFocus` 0.1 | |
| Grafting | §6 (no SF4 needed) | |
| Formulas (Formulas.exe, $5B on darkweb, or SF5) | `formulas.reputation.*`, `formulas.work.factionGains/companyGains/crimeGains/crimeSuccessChance/gymGains/universityGains` (0 GB) | |
| Gang create | `ns.gang.createGang` (SF2/BN2) | |
| Church join | `ns.stanek.acceptGift()` (SF13/BN13) | UI: visit Chongqing church |
| Bladeburners faction | Bladeburner API | |
| Infiltration / SoA rep | **UI only** | |
| Share | `ns.share()` 2.4/thread, `getSharePower` 0.2 | |

---

## 8. Implications for automation

### 8.1 Critical path: fresh reset → The Red Pill (BN1, SF none)
1. **No Singularity in BN1 without SF4.** Either drive the UI (DOM) for join/work/buy/install, or accept a human-in-the-loop for the first node. Strongly consider making BN4 the second node so later runs are fully scriptable (SF4.1 ×16 RAM; SF4.3 removes the penalty).
2. Money + hack level come from hacking scripts (other doc). Early faction unlocks are backdoor-gated on hack level/ports: CSEC 51–60 → avmnite-02h 202–220 → I.I.I.I 340–365 → run4theh111z 505–550. TDH needs only hack 50 + $1M + travel ($200k). One city group (Sector-12+Aevum *or* Chongqing+New Tokyo+Ishima *or* Volhaven).
3. Daedalus needs **30 distinct installed augs** (NFG = 1), $100B on hand, hack 2500. Cheap distinct augs from early factions (CyberSec, TDH, Netburners, city factions, NiteSec, Black Hand, BitRunners, Slum Snakes/Tetrads) easily exceed 30; schedule ~3–5 installs, each buying the 6–12 most valuable affordable augs in descending price (1.9^q escalation).
4. In Daedalus: TRP requires 2.5M rep (× AugmentationRepCost). Hacking work ≈ `(hack/975) × faction_rep × (1+favor/100)` rep/cycle. At hack 3000, faction_rep 2.5, favor 0 → ~38 rep/s → ~18 h; favor 150 → ~7 h. Alternative: reach ≥ 462.5k Daedalus rep, soft-reset/install to bank favor 150, then **donate** ~$1M/(faction_rep) per rep.
5. After installing TRP: backdoor/hack `w0r1d_d43m0n` (hack 3000 × WorldDaemonDifficulty). Hack ≥ 2500 for Daedalus usually sets this up anyway.

### 8.2 Most valuable augs per $/rep for a speedrun
- **Faction rep mults (cheap, compound every rep source):** SNA (TDH, $30M/6.25k, frep 1.15), ADR-V1 ($17.5M/3.75k, 1.1), Shadow's Simulacrum ($400M/37.5k, 1.15), ADR-V2 ($550M/62.5k, 1.2), SmartJaw ($2.75B/375k, 1.25), PCMatrix ($2B/100k, 1.0777 + w$ 1.777).
- **Hack skill (drives both income and rep linearly):** BitWire, CSP I–V, ENM + Core + V2/V3, Neural Accelerator, Bio-neural Network, Neurolink, The Black Hand, Neuronal Densification, OmniTek InfoLoad, Xanipher, nextSENS, CRTX42-AA. Exp mults (Neuregen 1.4, NRE 1.25, Neurotrainers) are weaker than skill mults (+32·ln k levels).
- **Quality-of-life:** CashRoot (BruteSSH + $1M each install); Neurolink (FTPCrack+relaySMTP); PCMatrix (DeepscanV1, AutoLink).
- **Neuroreceptor Management** only matters if the bot cannot keep `focus=true` (e.g. UI-driven bot needing other pages, or doing work while using the Terminal).
- QLink is the strongest single hacking aug but needs Illuminati ($150B, 30 augs, hack 1500, combat 1200) and $25T × q; usually not worth it for a TRP sprint.

### 8.3 Leverage points
- Backdoor a company's server before grinding it: corp faction threshold 400k → 300k and all promotion rep ×0.75.
- Megacorp/Fulcrum invites persist across installs (keepOnInstall) — the 300–400k company grind is once per BitNode.
- Favor banking: every install/softReset converts rep → favor for **all** factions and companies; favor multiplies work rep linearly and unlocks donation at 150. `softReset` banks favor without buying anything (API only).
- Passive rep keeps accruing on every joined non-special faction you are not working for (1–10 % of work rate).
- Offline progress treats ongoing work as focused.
- Classes: no focus penalty and no BN exp nerf → train unfocused while scripting.
- Crime money ignores focus; karma uses it.
- Grafting (BN10/SF10): 3× base, no 1.9^q, no BN cost mult, no rep, applied instantly → cheap way to reach aug counts and to get faction-locked augs; cost: 2 % all-mult entropy per graft for the rest of the BitNode.
- Gang faction (BN2/SF2): sells nearly every aug with unlimited rep from respect; in BN2 it sells TRP and gang creation needs **no karma**.
- SoA augs never raise the 1.9 counter.
- Prereqs can be queued in the same batch; order purchases desc-by-price with prereqs inserted just before their dependents; TRP last.

### 8.4 Exploitable quirks (v3.0.1)
1. `BNmult.ClassGymExpGain` is never applied (grep shows only definitions/UI).
2. SF15.2 "company rep" bonus multiplies a field that is then overwritten → it only boosts salary (`Formulas.ts:146-156`).
3. Unstable Circadian Modulator's bonus is re-rolled by wall-clock hour at install and at game load.
4. API `applyToCompany` / `workForCompany` / `commitCrime` / `workForFaction` have no city requirement.
5. `ns.stanek.acceptGift()` joins the Church from any city.
6. Grafting a queued aug removes it from the queue → lowers q for remaining purchases.
7. BN8: `FavorToDonateToFaction = 0` → donation available from 0 favor (but BN8 money is stock-only).

### 8.5 Open questions
- Whether to build a DOM/UI driver for the SF4-less first node, or take BN1 manually. Decision needed before any code.
- Exact gang-faction unique-aug sets per (BN, SF level): reproducible by re-implementing `SFC32RNG` (`src/Casino/RNG.ts`); not computed here.
- Darknet-lab Red Pill route (BN15, and 6-lab route elsewhere): effort vs. Daedalus — see darknet doc.
- Sleeves (SF10) as parallel rep/karma sources: one sleeve per faction/company (sleeve-vs-sleeve check only, `NetscriptFunctions/Sleeve.ts:125-164`); whether a sleeve and the player can work the same faction simultaneously was not verified.
- Optimal Daedalus strategy (work vs. bank-favor-then-donate) depends on income curve — needs simulation.

### 8.6 Changes in 3.0.2 (dev branch, unreleased)
- New darknet lab aug "The Thread" (repeatable like NFG); lab augs excluded from the 1.9^q counter; `applyAugmentation` refactored (level handling). Work classes refactored to a new serializer (no formula changes found in `Work/Formulas.ts`, crimes, grafting, reputation). Otherwise mostly UI/text changes.
