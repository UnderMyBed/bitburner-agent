# BitNode progression and the prestige loop (Bitburner v3.0.1)

All paths are relative to `vendor/bitburner-src/` unless they start with `scripts/`, which means the automation fork at `bitburner-scripts/`. Notes on 3.0.2 come from the dev branch `bitburner-src/` and are marked **[3.0.2]**.

Abbreviations: **BN** = BitNode, **SF** = Source-File, **WD** = the `w0r1d_d43m0n` server, **TRP** = The Red Pill, **HLM** = `HackingLevelMultiplier`, **WDD** = `WorldDaemonDifficulty`.

---

## 0. Most decision-relevant facts

1. **BitNode multipliers do not depend on level, except in BN12.** `initBitNodeMultipliers()` passes `lvl = activeSourceFileLvl(bn)+1` (`src/BitNode/BitNode.tsx:1129-1131`), but only `case 12` reads `lvl` (`BitNode.tsx:924-995`). BN n.2 and BN n.3 are exactly as hard as BN n.1, and you replay them stronger.
2. **BN12 difficulty uses the *active* SF12 level, but the reward uses the *real* level.** `sourceFileOverrides` (BitNode options) can set active SF12 to 0, which keeps BN12 at L=1 multipliers. `giveSourceFile` still increments the real `Player.sourceFiles` (`src/RedPill.tsx:25-34`). The validator has no lower bound (`src/BitNode/BitNodeUtils.ts:54-65`). See §9.
3. **Singularity RAM:** cost ×16 at SF4.1, ×4 at SF4.2, ×1 at SF4.3 or anywhere inside BN4 (`src/Netscript/RamCostGenerator.ts:82-96`). At SF4.1 a `joinFaction` helper script needs 49.6 GB and `installAugmentations` needs 81.6 GB, while the BN starts with 8/32/128 GB of home RAM. **SF4.1 is close to useless early in a BN.**
4. **Two win conditions, both reachable from NS with SF4:** `ns.singularity.destroyW0r1dD43m0n(nextBN, cbScript?, opts?)` succeeds if (hacking ≥ WD req **and** root on WD) **or** all 21 Black Ops are done (`src/NetscriptFunctions/Singularity.ts:1153-1194`). It needs no backdoor and no connection. The Bladeburner path needs no TRP.
5. **Without SF4, a BN can only be exited through the UI.** The options are the BitVerse portal click after a terminal `backdoor` or `hack` on WD, or the "Destroy w0r1d_d43m0n" button on the Black Ops page. Everything else in the core loop also needs the UI: joining factions, faction/company work, buying and installing augs, travel, TOR, programs and home upgrades. The game explicitly rewards DOM access that avoids the RAM cost: the `Bypass` SF-1 exploit is granted for doing it.
6. **The DOM RAM tax is a static identifier scan.** Any identifier `document` or `window` (including `x.document`) costs 25 GB each (`src/Script/RamCalculations.ts:185-192`, `:407-412`, `:436-439`). `eval("document")` and `globalThis["document"]` cost 0, and `scripts/casino.js:30` does exactly that.
7. **The casino cap resets on every install.** The cap is $10e9 measured against `moneySourceA.casino` (`src/Casino/Game.ts:4-19`), and `moneySourceA` is reset in `Player.prestigeAugmentation` (`src/PersonObjects/Player/PlayerObjectGeneralMethods.ts:128`). That is up to about $10b per aug install, but only through the UI (DOM).
8. **Effective WD difficulty** is `3000·WDD/HLM` in hacking-level terms, because HLM scales the level directly (§4.1). In order: BN14 37.5k, BN13 36k, BN2 18.75k, BN6/7/10 17.1k, BN9 12k, BN15 10k, BN4 9k, BN3/11 7.5k, BN5 4.5k, BN1/8 3k. BN13 and BN14 should be won through Bladeburner.
9. **There are TRP alternatives to Daedalus:** the gang faction in BN2, and the darknet labyrinth in every BN except BN8 (7th lab, cha 4000; in BN15 the 5th lab, cha 3000) (`src/DarkNet/effects/labyrinth.ts:403-473`).

---

## 1. Core model

| Concept | Definition | Source |
|---|---|---|
| Owned SF level | `Player.sourceFiles: Map<bn,lvl>` | `src/PersonObjects/Player/PlayerObject.ts:67` |
| Active SF level | `bitNodeOptions.sourceFileOverrides[n]`, otherwise the owned level | `PlayerObjectGeneralMethods.ts:615-620`; `PlayerObject.ts:93-95` |
| Feature access | `bitNodeN === n \|\| activeSourceFileLvl(n) > 0` | `src/BitNode/BitNodeUtils.ts:17-19` |
| BN "level" (display) | `min(activeSF(bn)+1, bn==12 ? ∞ : 3)` | `BitNodeUtils.ts:102-104` |
| Multipliers in force | `getBitNodeMultipliers(bitNodeN, activeSF(bitNodeN)+1)`, re-run on every install and BN entry | `BitNode.tsx:1129-1131`; `src/Prestige.ts:59,207` |
| SF passive bonuses | applied only for SFs you **own** (active > 0), never just because you are in that BN | `PlayerObjectGeneralMethods.ts:432-447` |
| Max SF level | 3, except SF12, which is unbounded | `src/RedPill.tsx:28` |

Consequences:
- Inside BN n you get BN n's *feature* (for example Singularity in BN4, Intelligence in BN5, Hacknet Servers in BN9, Sleeves in BN10). You do **not** get SF n's stat bonuses until you have destroyed BN n.
- `getOwnedSourceFiles()` and `getResetInfo().ownedSF` both report *active* levels, so overrides are visible to scripts (`src/NetscriptFunctions/Singularity.ts:93-99`, `src/NetscriptFunctions.ts:1491-1495`).

---

## 2. BitNode multipliers

### 2.1 Defaults (`src/BitNode/BitNodeMultipliers.ts:8-180`)

Every multiplier defaults to 1, except `DaedalusAugsRequirement = 30` and `StaneksGiftExtraSize = 0`. `DarknetLabyrinthRewardsTheRedPill = 1` is a boolean-like flag. Values pass through `clampNumber` (`:182-184`).

### 2.2 Non-default values per BN (identical at every level except BN12)

Source: `BitNode.tsx:570-1127`. Values not listed are 1. Key abbreviations: SMM = ServerMaxMoney, SSM = ServerStartingMoney, SSS = ServerStartingSecurity, SGR = ServerGrowthRate, SHM = ScriptHackMoney, CSS = CloudServerSoftcap, CWM = CompanyWorkMoney, CM = CrimeMoney, HNM = HacknetNodeMoney, HEG = HackExpGain, FWRG = FactionWorkRepGain, GUA = GangUniqueAugs, Stanek = StaneksGiftPowerMultiplier / StaneksGiftExtraSize, Corp = CorporationValuation / CorporationSoftcap / CorporationDivisions, BB = BladeburnerRank / BladeburnerSkillCost, 4S = FourSigmaMarketDataCost / FourSigmaMarketDataApiCost, DNM = DarknetMoneyMultiplier.

| BN | Non-default multipliers (lines) |
|---|---|
| 1 | none (`:572-574`) |
| 2 | HLM 0.8, SGR 0.8, SMM 0.08, SSM 0.4, CSS 1.3, CM 3, **FactionPassiveRepGain 0**, FWRG 0.5, CorpSoftcap 0.9, CorpDiv 0.9, InfiltrationMoney 3, Stanek 2/−6, WDD 5 (`:575-598`) |
| 3 | HLM 0.8, SGR 0.2, SMM 0.04, SSM 0.2, HomeComputerRamCost 1.5, CloudServerCost 2, CSS 1.3, CWM 0.25, CM 0.25, HNM 0.25, SHM 0.2, FavorToDonateToFaction 0.5, AugMoney 3, AugRep 3, GangSoftcap 0.9, GUA 0.5, Stanek 0.75/−2, DNM 0.4, WDD 2 (`:599-632`) |
| 4 | SMM 0.1125, SSM 0.75, CSS 1.2, CWM 0.1, CM 0.2, HNM 0.05, SHM 0.2, ClassGymExp 0.5, CompanyWorkExp 0.5, CrimeExp 0.5, FactionWorkExp 0.5, HEG 0.4, FWRG 0.75, GUA 0.5, Stanek 1.5/0, DNM 0.4, WDD 3 (`:633-662`) |
| 5 | SSS 2, SSM 0.5, CSS 1.2, CM 0.5, HNM 0.2, SHM 0.15, HEG 0.5, AugMoney 2, InfiltrationMoney 1.5, InfiltrationRep 1.5, CorpVal 0.75, CorpDiv 0.75, GUA 0.5, Stanek 1.3/0, DNM 0.7, WDD 1.5 (`:663-693`) |
| 6 | HLM 0.35, SMM 0.2, SSM 0.5, SSS 1.5, CSS 2, CWM 0.5, CM 0.75, HNM 0.2, SHM 0.75, HEG 0.25, InfiltrationMoney 0.75, Corp 0.2/0.9/0.8, GangSoftcap 0.7, GUA 0.2, **DaedalusAugs 35**, Stanek 0.5/+2, WDD 2 (`:694-727`) |
| 7 | HLM 0.35, SMM 0.2, SSM 0.5, SSS 1.5, CSS 2, CWM 0.5, CM 0.75, HNM 0.2, SHM 0.5, HEG 0.25, AugMoney 3, InfiltrationMoney 0.75, 4S 2/2, Corp 0.2/0.9/0.8, BB 0.6/2, GangSoftcap 0.7, GUA 0.2, **DaedalusAugs 35**, Stanek 0.9/−1, WDD 2 (`:728-769`) |
| 8 | CSS 4, **CWM 0, CM 0, HNM 0, ManualHackMoney 0, SHM 0.3, ScriptHackMoneyGain 0, CodingContractMoney 0, FavorToDonate 0, InfiltrationMoney 0, Corp 0/0/0, BladeburnerRank 0, DarknetLabyrinthRewardsTheRedPill 0, DNM 0, GangSoftcap 0, GUA 0**, Stanek size −99. WDD stays at default 1 (`:770-800`) |
| 9 | HLM 0.5, Str/Def/Dex/Agi/Cha level 0.45, SMM 0.01, SSM 0.1, SSS 2.5, HomeComputerRamCost 5, **CloudServerLimit 0**, CM 0.5, SHM 0.1, **HEG 0.05**, 4S 5/4, Corp 0.5/0.75/0.8, BB 0.9/1.2, GangSoftcap 0.8, GUA 0.25, Stanek 0.5/+2, DNM 0.05, WDD 2 (`:801-843`) |
| 10 | HLM 0.35, Str..Cha level 0.4, HomeComputerRamCost 1.5, CloudServerCost 5, CSS 1.1, CloudServerLimit 0.6, CloudServerMaxRam 0.5, CWM/CM/HNM/ManualHack/SHM/CodingContract 0.5, **AugMoney 5, AugRep 2**, InfiltrationMoney 0.5, Corp 0.5/0.9/0.9, BB 0.8, GangSoftcap 0.9, GUA 0.25, Stanek 0.75/−3, DNM 0.4, WDD 2 (`:844-888`) |
| 11 | HLM 0.6, SGR 0.2, SMM 0.01, SSM 0.1, ServerWeakenRate 2, CSS 2, CWM 0.5, CM 3, HNM 0.1, CodingContract 0.25, HEG 0.5, AugMoney 2, InfiltrationMoney 2.5, InfiltrationRep 2.5, 4S 4/4, Corp 0.1/0.9/0.9, GUA 0.75, WDD 1.5 (`:889-923`) |
| 12 | see §2.3 (`:924-995`) |
| 13 | HLM 0.25, Str/Def/Dex/Agi level 0.7, CSS 1.6, SMM 0.3375, SSM 0.75, SSS 3, CWM/CM/HNM 0.4, SHM 0.2, CodingContract 0.4, ClassGym/CompanyWork/Crime/FactionWork Exp 0.5, **HEG 0.1**, FWRG 0.6, 4S 10/10, Corp 0.001/0.4/0.4, BB 0.45/2, GangSoftcap 0.3, GUA 0.1, Stanek 2/+1, DNM 0.1, WDD 3 (`:996-1043`) |
| 14 | GoPower 4, HLM 0.4, **HackingSpeedMultiplier 0.3**, SMM 0.7, SSM 0.5, SSS 1.5, CM 0.75, CrimeSuccessRate 0.4, HNM 0.25, SHM 0.3, Str/Dex/Agi/Def level 0.5, AugMoney 1.5, InfiltrationMoney 0.75, **FWRG 0.2, CompanyWorkRepGain 0.2**, Corp 0.4/0.9/0.8, BB 0.6/2, GangSoftcap 0.7, GUA 0.4, Stanek 0.5/−1, WDD 5 (`:1044-1087`) |
| 15 | HLM 0.6, HackingSpeedMultiplier 0.6, Str/Def/Dex/Agi level 0.7, Cha level 1.1, SMM 0.8, SSM 0.5, SSS 1.5, AugMoney 3, Corp 0.2/0.4/0.4, **DaedalusAugs 20**, BB 0.2/3, GUA 0.3, Stanek 0.7/−2, WDD 2 (`:1089-1122`) |

### 2.3 BN12 (The Recursion) as a function of L = activeSF12 + 1

`inc = 1.02^L`, `dec = 1/inc` (`BitNode.tsx:925-926`).

- **dec:** all six `*LevelMultiplier`, SGR, SSM, ServerWeakenRate, CloudServerLimit, CloudServerMaxRam, CWM, CM, HNM, ManualHackMoney, SHM, CodingContractMoney, DNM, all five `*ExpGain`, FactionPassiveRepGain, FWRG, InfiltrationMoney/Rep, CorpValuation, BladeburnerRank, GUA.
- **inc:** HomeComputerRamCost, CloudServerCost, CSS, FavorToDonateToFaction, AugMoney, AugRep, 4S/4S-API, BladeburnerSkillCost, Stanek power, Stanek *size* (a non-integer added to the grid size), WDD.
- **dec²:** SMM.
- **Fixed:** SSS 1.5, CorpSoftcap 0.8, CorpDivisions 0.5, GangSoftcap 0.8.
- `DaedalusAugsRequirement = floor(min(30 + inc, 40))`.

| L | inc | WD req (3000·inc) | effective (÷HLM = 3000·inc²) | Daedalus augs | SMM |
|---|---|---|---|---|---|
| 1 | 1.020 | 3,060 | 3,121 | 31 | 0.961 |
| 5 | 1.104 | 3,312 | 3,657 | 31 | 0.820 |
| 10 | 1.219 | 3,657 | 4,458 | 31 | 0.673 |
| 20 | 1.486 | 4,458 | 6,624 | 31 | 0.453 |
| 36 | 2.040 | 6,120 | 12,483 | 32 | 0.240 |
| 50 | 2.692 | 8,075 | 21,734 | 32 | 0.138 |
| 100 | 7.245 | 21,734 | 157,455 | 37 | 0.019 |
| 117 | 10.14 | 30,433 | 308,718 | 40 (cap) | 0.0097 |
| 200 | 52.48 | 157,455 | 8.26e6 | 40 | 0.0004 |

`calculateSkill` returns 1 if the multiplier is exactly 0, a comment notes this for very high SF12 (`src/PersonObjects/formulas/skill.ts:8-12`). The game prints "Saynt_Garmo is watching you" when SF12 > 100 (`Prestige.ts:319-321`).

### 2.4 Comparison table

The WD requirement is `3000 × WDD` (`src/Server/data/servers.ts:1536`, `src/Server/ServerHelpers.ts:383-385`). "Effective" is WD req ÷ HLM, i.e. the level you would need with HLM = 1 (§4.1).

| BN | Name | Unlocks (in-node) | HLM | HEG | WD req | Effective | SHM×SMM | AugMoney/Rep | Daedalus augs | Notable restrictions |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Source Genesis | — | 1 | 1 | 3,000 | 3,000 | 1 | 1/1 | 30 | none |
| 2 | Rise of the Underworld | Gang (no karma req), TRP from gang faction | 0.8 | 1 | 15,000 | 18,750 | 0.08 | 1/1 | 30 | no passive faction rep; FWRG 0.5 |
| 3 | Corporatocracy | Corp (seed funding only here, full API) | 0.8 | 1 | 6,000 | 7,500 | 0.008 | 3/3 | 30 | hacking nearly worthless |
| 4 | The Singularity | Singularity at 1× RAM | 1 | 0.4 | 9,000 | 9,000 | 0.0225 | 1/1 | 30 | exp ×0.5, money sources cut |
| 5 | Artificial Intelligence | Intelligence, Formulas.exe, getBitNodeMultipliers | 1 | 0.5 | 4,500 | 4,500 | 0.15 | 2/1 | 30 | SSS 2 |
| 6 | Bladeburners | Bladeburner | 0.35 | 0.25 | 6,000 | 17,143 | 0.15 | 1/1 | 35 | — |
| 7 | Bladeburners 2079 | Bladeburner + API | 0.35 | 0.25 | 6,000 | 17,143 | 0.1 | 3/1 | 35 | BB rank 0.6 |
| 8 | Ghost of Wall Street | WSE/TIX, shorts, limit orders | 1 | 1 | 3,000 | 3,000 | 0.3 (gain 0) | 1/1 | 30 | only stocks make money; BB, corp, gang disabled; TRP not in lab |
| 9 | Hacktocracy | Hacknet Servers (+ starter server) | 0.5 | 0.05 | 6,000 | 12,000 | 0.001 | 1/1 | 30 | **no cloud servers**; home RAM ×5 |
| 10 | Digital Carbon | Sleeves (buy and memory only here), Grafting | 0.35 | 1 | 6,000 | 17,143 | 0.5 | 5/2 | 30 | cloud servers 15 max, half RAM |
| 11 | The Big Crash | — | 0.6 | 0.5 | 4,500 | 7,500 | 0.01 | 2/1 | 30 | SGR 0.2 |
| 12 | The Recursion | — | 1.02^−L | 1.02^−L | 3000·1.02^L | 3000·1.02^2L | 1.02^−3L | 1.02^L both | 30+ | see §2.3 |
| 13 | They're Lunatics | Church of the Machine God / Stanek | 0.25 | 0.1 | 9,000 | 36,000 | 0.0675 | 1/1 | 30 | start money $200k |
| 14 | IPvGO Subnet Takeover | Go ×4 power, cheat API at 14.2 | 0.4 | 1 | 15,000 | 37,500 | 0.21 | 1.5/1 | 30 | hack speed 0.3; faction/company rep 0.2 |
| 15 | Secrets of the Dark Net | full darknet; Daedalus lacks TRP | 0.6 | 1 | 6,000 | 10,000 | 0.8 | 3/1 | 20 | hack speed 0.6 |

### 2.5 Non-multiplier per-BN rules

| BN | Rule | Source |
|---|---|---|
| 2 | Gang without SF2 and without the karma requirement; the gang faction sells TRP | `src/PersonObjects/Player/PlayerObjectGangMethods.ts:16-18`; `src/Faction/FactionHelpers.tsx:180-183` |
| 3 | Corp: Warehouse/Office API unlocks granted at creation; seed money only in BN3; handbook message | `src/PersonObjects/Player/PlayerObjectCorporationMethods.ts:21-24`; `src/Corporation/Actions.ts:41`; `Prestige.ts:150-153,282-291` |
| 4 | Singularity RAM ×1 regardless of SF4 | `RamCostGenerator.ts:84-86` |
| 5 | Intelligence exp accrues; Formulas.exe granted at every reset | `src/PersonObjects/Person.ts:185`; `Prestige.ts:93-95,277-279` |
| 6 | Bladeburner cinematic page on entry | `RedPill.tsx:88-89` |
| 8 | Money set to $250e6 at BN start **and at every install**; WSE + TIX given; Bladeburner hidden and its join API refused (rank mult 0) | `Prestige.ts:161-167,302-308`; `src/Locations/ui/SpecialLocation.tsx:106`; `src/NetscriptFunctions/Bladeburner.ts:341-344` |
| 9 | Hacknet Servers replace Nodes; a level-100 / 10-core / cache-5 server is given at BN entry (also in BN9 without SF9.3), lost at first install | `Prestige.ts:338-348`; `src/Hacknet/HacknetHelpers.tsx:35` |
| 10 | Sleeve purchase and memory APIs only work in BN10; on entering BN10 sleeve shock ≤ 25 and sync ≥ 25 | `src/NetscriptFunctions/Sleeve.ts:24-28,304-322`; `PlayerObjectGeneralMethods.ts:150-155` |
| 13 | Money = $200e3 at BN start | `Prestige.ts:350-352` |
| 13-related | Outside BN13, installing any non-NFG aug without having Stanek's Gift bans CotMG for the rest of the BN | `Prestige.ts:185-191` |
| 14 | With TRP installed, a hidden Go opponent "????" (WD) appears; it gives a hacking mult only and is **not** a win condition | `src/Go/Go.ts:25-33`; `src/Go/effects/effect.ts:95-97` |
| 15 | Daedalus does not sell TRP; TRP comes from the 5th darknet lab; Darknet Handbook | `FactionHelpers.tsx:204-207`; `labyrinth.ts:419-422,449-452`; `Prestige.ts:355-360` |

---

## 3. Source-File effects

`applySourceFile` (`src/SourceFile/applySourceFile.ts`) runs for every *active* SF on each install and BN entry (`PlayerObjectGeneralMethods.ts:432-447`). For the "percent" SFs the bonus is `m = Σ_{i<lvl} base/2^i`, giving base × (1, 1.5, 1.75).

| SF | Lvl 1 / 2 / 3 effect | Unlocks | Source |
|---|---|---|---|
| 1 | +16 / 24 / 28% to hacking_chance/speed/money/grow, all six stats and their exp, company_rep, faction_rep, crime_money/success, hacknet money, work_money; hacknet costs ÷(1+m) | home starts at 32 GB on BN entry | `applySourceFile.ts:14-49`; `Prestige.ts:246-252` |
| 2 | +24 / 36 / 42% crime_money, crime_success, charisma | Gang outside BN2 when karma ≤ −54000 | `:50-61`; `PlayerObjectGangMethods.ts:19-27`; `src/Gang/data/Constants.ts:27` |
| 3 | +8 / 12 / 14% charisma, work_money | Corp outside BN3; **3.3**: Warehouse + Office API unlocked when a corp is created | `:62-72`; `PlayerObjectCorporationMethods.ts:8-24` |
| 4 | none | Singularity API; RAM ×16 / ×4 / ×1 | `:73-77`; `RamCostGenerator.ts:82-96`; `src/Netscript/NetscriptHelpers.tsx:388-396` |
| 5 | +8 / 12 / 14% hacking_chance/speed/money/grow, hacking, hacking_exp | Intelligence; Formulas.exe at every reset; `ns.getBitNodeMultipliers` (4 GB); +300 int exp per BN destroy (not flume) | `:78-92`; `src/NetscriptFunctions.ts:914-927`; `Prestige.ts:362-365` |
| 6 | +8 / 12 / 14% str/def/dex/agi and their exp | Bladeburner and its API outside BN6/7 | `:93-109`; `src/PersonObjects/Player/PlayerObjectBladeburnerMethods.ts:6-8` |
| 7 | +8 / 12 / 14% bladeburner_max_stamina, stamina_gain, analysis, success_chance | Bladeburner and API; **7.3**: Blade's Simulacrum pushed into installed augs when joining BB (this blocks Stanek) | `:110-122`; `PlayerObjectBladeburnerMethods.ts:14-19`; `SpecialLocation.tsx:77-96` |
| 8 | +12 / 18 / 21% hacking_grow | **8.1** WSE + TIX at every reset; **8.2** shorts; **8.3** limit/stop orders | `:123-132`; `Prestige.ts:164-167`; `src/NetscriptFunctions/StockMarket.ts:151-204` |
| 9 | hacknet money ×(1+m) and hacknet costs ×(1−m), i.e. 0.88 / 0.82 / 0.79 (not 1/(1+m)) | **9.1** Hacknet Servers; **9.2** 128 GB home at BN entry; **9.3** starter Hacknet Server at BN entry only | `:133-147`; `Prestige.ts:246-252,338-348` |
| 10 | none | sleeves = `min(3, sf10 + (bn==10))` + Covenant purchases; sleeve and grafting API outside BN10 | `src/PersonObjects/Sleeve/SleeveCovenantPurchases.tsx:58-73`; `src/NetscriptFunctions/Sleeve.ts:30-41` |
| 11 | +32 / 48 / 56% work_money, company_rep; company favor also boosts salary (1 + favor/100) | aug price escalation `1.9 × [1, .96, .94, .93][lvl]` = 1.824 / 1.786 / 1.767 | `:153-163`; `src/Augmentation/AugmentationHelpers.ts:29-37`; `src/Work/Formulas.ts:131-138` |
| 12 | none | NFG at level = activeSF12, granted at BN entry only | `Prestige.ts:264-270` |
| 13 | none | CotMG in other BNs; Stanek base size `9 + StaneksGiftExtraSize + sf13`, with width `max(2, min(⌊s/2+1⌋, 25))` and height `max(3, min(⌊s/2+0.6⌋, 25))` | `src/CotMG/StaneksGift.ts:22-31`; `src/CotMG/data/Constants.ts:3-4` |
| 14 | none | Go effect ×2 (any level); win-streak favor cap 200k / 300k / 400k rep (base 100k), and each 2-win streak adds cap/200 rep (1000 / 1500 / 2000) as favor immediately; cheat API at **14.2** (or in BN14 with SF14.1); **14.3** +0.25 cheat success | `src/Go/effects/effect.ts:16-44`; `src/Go/effects/netscriptGoImplementation.ts:487-497,561-567`; `src/Go/boardAnalysis/scoring.ts:68-79` |
| 15 | none | **15.1** TOR + DarkscapeNavigator at every reset, full darknet. **15.2** company money and rep × `getMultiplierFromCharisma(1.5)`. **15.3** (code checks `>2`) darknet auth time ×0.8, charisma added to faction-work rep, cache money/xp ×1.5 | `Prestige.ts:100-102,242-244`; `Formulas.ts:133`; `src/DarkNet/effects/effects.ts:80,105-111`; `src/PersonObjects/formulas/reputation.ts:54-59`; `src/DarkNet/effects/cacheFiles.ts:91` |
| −1 | each distinct exploit gives ×1.001 to the SF1 mult set (hacknet costs ×0.999); 11 exploits, maximum ≈ ×1.011 | — | `src/Exploits/applyExploits.ts:4-44`; `src/Exploits/Exploit.ts:14-30` |

Code contradicts the in-game text in two places:
- **SF15:** the text says auth speed improves at L2 (`BitNode.tsx:555`), but the code applies it at L3 (`effects.ts:80`).
- **SF14.3:** the old autopilot comment "favor 100→120" is stale; the actual cap is in rep units.

### 3.1 Singularity RAM by SF4 level

Constants are Fn1 = 2, Fn2 = 3, Fn3 = 5 GB (`RamCostGenerator.ts:55-57`); the table is at `:157-221`. A helper script also pays the 1.6 GB base. Scripts are capped at 1024 GB (`src/Script/RamCalculations.ts:255-258`).

| Function(s) | Base | SF4.1 (×16) | SF4.2 (×4) | SF4.3 / in BN4 |
|---|---|---|---|---|
| travelToCity, purchaseTor, purchaseProgram, connect, manualHack, installBackdoor, universityCourse, gymWorkout | 2 | 32 | 8 | 2 |
| joinFaction, checkFactionInvitations, workForFaction, workForCompany, applyToCompany, upgradeHomeRam/Cores | 3 | 48 | 12 | 3 |
| getFactionRep/Favor, getCompanyRep | 1 | 16 | 4 | 1 |
| purchaseAugmentation, installAugmentations, softReset, getOwnedAugmentations, getOwnedSourceFiles, commitCrime, createProgram, donateToFaction, goToLocation | 5 | 80 | 20 | 5 |
| getAugmentationPrice/RepReq/BasePrice | 2.5 | 40 | 10 | 2.5 |
| getCurrentWork, isBusy | 0.5 | 8 | 2 | 0.5 |
| b1tflum3 | 16 | 256 | 64 | 16 |
| destroyW0r1dD43m0n | 32 | 512 | 128 | 32 |

Two oddities:
- `getOwnedSourceFiles` has **no** SF4 access check (`Singularity.ts:93-99`), but costs 80 GB without SF4.3. `ns.getResetInfo()` (1 GB, `RamCostGenerator.ts:653`) gives the same data.
- SF4 level 0 also computes ×16, but every other function throws `API ACCESS` first.

---

## 4. Win conditions and the destroy flow

### 4.1 WD requirement and why HLM matters

- `requiredHackingSkill = 3000 × WorldDaemonDifficulty` is set when servers are created (`ServerHelpers.ts:383-385`; base value `servers.ts:1532-1539`). WD has no `networkLayer`, so it is unreachable.
- **Installing** TRP links WD ↔ The-Cave on install (`Prestige.ts:174-182`). Until then NS functions cannot see it: `getServer` requires `serversOnNetwork.length > 0` (`NetscriptHelpers.tsx:504-516`; also `ServerHelpers.ts:312-315`).
- WD needs 5 open ports and NUKE (`servers.ts:1534`).
- Level formula: `level = floor(mult·HLM·(32·ln(exp+534.6) − 200))` (`skill.ts:7-15`; mult = player hacking mult). The exp needed is `exp((R/(m·HLM)+200)/32) − 534.6`, which is exponential in R/(m·HLM). Example: R = 3000 needs 2.7e43 exp at m = 1, 7.2e10 at m = 5, and 6.1e6 at m = 10.

### 4.2 All ways to end a BitNode

| Path | Preconditions | SF | Randomness | Result |
|---|---|---|---|---|
| Terminal `backdoor` on WD | connected to WD, root, hacking ≥ req; takes hackTime/4 | none | none | `backdoorInstalled = true`, routes to the BitVerse UI (`src/Terminal/Terminal.ts:373-387`) |
| Terminal `hack` on WD | same; a **successful** hack also sets the backdoor | none | `Math.random() < hackChance` (`Terminal.ts:266-276`) | routes to the BitVerse |
| `ns.singularity.installBackdoor()` while connected to WD | same | SF4 | none | routes to the BitVerse UI; **you still have to click a portal** (`Singularity.ts:518-559`) |
| `ns.singularity.destroyW0r1dD43m0n(nextBN, cb?, opts?)` | (hacking ≥ WD req **and** `wd.hasAdminRights`) **or** `bladeburner.numBlackOpsComplete ≥ 21` | SF4 (32–512 GB) | none | sets the backdoor, then `enterBitNode(false, …)`; no UI involved; `cb` runs 500 ms later (`Singularity.ts:1153-1194`) |
| Black Ops page "Destroy w0r1d_d43m0n" button | all 21 Black Ops done (`src/Bladeburner/data/BlackOperations.ts:735`; the last is Operation Daedalus at rank 400e3, `:704-711`) | BB access (SF6/7 or BN6/7) | Black Op success rolls | `finishBitNode()`, then the BitVerse UI (`src/Bladeburner/ui/BlackOpPage.tsx:39-52`) |
| `b1t_flume.exe` (terminal `run`), or `ns.singularity.b1tflum3(nextBN, cb?, opts?)` | the program needs any SF to create (hacking ≥ 1, 15 s base) (`src/Programs/Programs.ts:30-34,306-323`). The NS call does **not** check for the program | none (program) / SF4 (API) | none | `enterBitNode(true, …)`: **no SF**, no +300 int; any BN can be picked (`Singularity.ts:1139-1152`) |

If the game is reloaded while WD is backdoored, it boots straight into the BitVerse (`src/ui/GameRoot.tsx:160-164`).

### 4.3 BitVerse and `enterBitNode` (`src/RedPill.tsx:53-93`)

1. `prestigeWorkerScripts()` kills every script.
2. If this is not a flume, `giveSourceFile(destroyed)` runs: it sets `real lvl + 1`, capped at 3 except for BN12 (`:16-51`).
3. `Player.bitNodeN = newBN`, then `setBitNodeOptions(opts)`. Invalid options fall back to the defaults (`:69-75`).
4. `prestigeSourceFile(isFlume)` runs (`Prestige.ts:203-379`).
5. Route to Terminal (or the BN6 cinematic).

UI: the portal is an `IconButton` with `aria-label="BitNode-N: <Name>"`. It opens `PortalModal`, whose button is `aria-label="enter-bitnode-N"` (`src/BitNode/ui/BitverseRoot.tsx:99-106`; `src/BitNode/ui/PortalModal.tsx:117-131`). A non-quick entry first plays an auto cinematic (`BitverseRoot.tsx:209-256`). With `Settings.DisableASCIIArt` the portals render as text buttons (`BitverseRoot.tsx:92-97,269-290`), which are easier for DOM automation.

**[3.0.2]** `enterBitNode` throws on an invalid BN number.

---

## 5. Daedalus and The Red Pill

| Requirement | Value | Source |
|---|---|---|
| Installed augs | `Player.augmentations.length ≥ DaedalusAugsRequirement` (30; BN6/7 35; BN15 20; BN12 `floor(min(30+1.02^L, 40))`). **NFG counts once at any level.** Queued augs do not count. | `src/Faction/FactionInfo.tsx:142`; `src/Faction/FactionJoinCondition.ts:116-131`; NFG stored once in `AugmentationHelpers.ts:54-59` |
| Money | ≥ $100e9 cash on hand (stocks do not count) | `FactionInfo.tsx:143` |
| Stats | hacking ≥ 2500 **or** all four combat stats ≥ 1500 | `FactionInfo.tsx:144` |
| TRP cost | rep 2.5e6 × AugmentationRepCost, $0 (BN3 7.5M, BN10 5M, BN12 2.5M×1.02^L) | `src/Augmentation/Augmentations.ts:1946-1953`; `AugmentationHelpers.ts:156-158` |
| Rep by donation | allowed once favor ≥ `floor(150 × FavorToDonateToFaction)` (BN3 75, **BN8 0**, BN12 150×1.02^L); rep = $/1e6 × faction_rep × FWRG. Only factions that offer work show the option. | `src/NetscriptFunctions.ts:1414-1415`; `src/Faction/formulas/donation.ts:8-22`; `Singularity.ts:951`; `src/Faction/ui/FactionRoot.tsx:103-143` |
| Favor | `favor = log1p(rep/25000)/log(1.02)` (cap 35331), with rep accumulated across installs | `src/Faction/formulas/favor.ts:7-24` |

TRP must be **installed**, which takes a soft reset. Install and then `ns.scan("The-Cave")` shows WD (`Prestige.ts:174-182`).

Other sources of TRP:
- **BN2:** your gang faction offers TRP (`FactionHelpers.tsx:180-183`). Gang-faction augs outside BN2 are a seeded-random subset: `SFC32RNG("BN{n}.{activeSF}")`, keeping each unique aug if `rng ≥ 1−GangUniqueAugs` (`:185-199`). That is **deterministic per BN.level**.
- **Darknet labyrinth** (every BN except BN8). Lab augs must be *installed* in order: Broken Wings, Boots, Hammer, Staff, Law, Sword. TRP comes from `f1n4l_l4byr1nth` (depth 36, cha 4000) after all six. In BN15 it comes from `et3rn4l_l4byr1nth` (depth 29, cha 3000) after four (`labyrinth.ts:37-110,403-473`). The reward is *queued* (`cacheFiles.ts:173-180`). Access needs SF15 or DarkscapeNavigator.exe ($50e6 darkweb, or $30e6 discounted at a location; `src/DarkNet/Constants.ts:6-8`).

---

## 6. Reset semantics

`installAugmentations()` and `softReset()` call `installAugmentations(force)` (`AugmentationHelpers.ts:69-115`), which then calls `prestigeAugmentation()` (`Prestige.ts:55-200` + `PlayerObjectGeneralMethods.ts:80-141`). A BN destroy or flume calls `prestigeSourceFile(isFlume)` (`Prestige.ts:203-379` + `PlayerObjectGeneralMethods.ts:143-175`, which itself calls `Player.prestigeAugmentation()` first).

| Thing | Aug install / soft reset | BN destroy / flume |
|---|---|---|
| Running scripts | killed (`Prestige.ts:57`) | killed |
| Scripts and text files on home | **kept** | **kept** (RAM usage recomputed, `:236-237`) |
| Programs on home | wiped except NUKE + b1t_flume, then aug-granted programs, Formulas (SF5/BN5), Darkscape (SF15/BN15) (`src/Server/ServerHelpers.ts:224-237`; `Prestige.ts:85-102`) | same |
| .lit/.msg | wiped; Hacker's handbook added (BN3 corp handbook) | same |
| Home RAM / cores | **kept** | reset to 8 / 32 (SF1) / 128 (SF9.2) GB, 1 core (`:246-253`) |
| Other servers, cloud servers, TOR link | deleted and re-randomized (`src/Server/AllServers.ts:136-138`); TOR only kept with SF15/BN15 (`ServerHelpers.ts:408-412`) | same |
| Darknet state | reset (`src/DarkNet/models/DarknetState.ts:84-101`) | reset + heartbleed flag |
| Money | 1000 + 262 = **$1,262** + Σ aug `startingMoney` (CashRoot +$1e6); BN8 $250e6 (`PlayerObjectGeneralMethods.ts:102`; `src/Constants.ts:107`; `Prestige.ts:86-92,161-163`) | $1,262; BN8 $250e6; BN13 $200e3 |
| Stats / exp | level 1 (exp set so level = 1) (`Prestige.ts:43-52`) | same |
| Intelligence | persistent (`overrideIntelligence`) | persistent; +300 exp if SF5 and not a flume |
| Installed augs | kept, plus the queued ones added | **cleared**; SF12 NFG re-added (`PlayerObjectGeneralMethods.ts:174`; `Prestige.ts:265-270`) |
| Queued (purchased) augs | installed | **lost** |
| Faction rep | converted to favor, then 0 (`src/Faction/Faction.ts:77-85`) | 0, favor 0 (`:68-75`) |
| Faction membership / invites | lost, except invites for `keepOnInstall` factions (10 megacorps, CotMG, Shadows of Anarchy) (`Prestige.ts:61-67,121-124`; `FactionInfo.tsx:196…811`) | all lost |
| Company rep / jobs | rep → favor; jobs lost (`src/Company/Company.ts:77-80`) | favor 0 |
| Karma | **kept** | 0 |
| People killed | 0 | 0 |
| City | Sector-12 | Sector-12 |
| Hacknet nodes/servers + hashes + hash upgrades | **lost** (`PlayerObjectGeneralMethods.ts:130-131`; `src/Hacknet/HashManager.ts:80-88`) | lost (SF9.3/BN9 starter server given) |
| Stocks | WSE/TIX/4S flags **kept**; market re-initialized, so **positions vanish with no refund** (`Prestige.ts:169-172`; `src/StockMarket/StockMarket.ts:183-206`) | flags cleared (SF8 re-grants WSE+TIX) |
| Gang | kept; gang faction rejoined; member ascension points ×0.95 (`Prestige.ts:133-147`; `src/Gang/GangMember.ts:287-296`; `src/Gang/data/Constants.ts:16`) | deleted |
| Corporation | **kept** | deleted |
| Bladeburner | kept; action cancelled; BB faction rejoined if rank ≥ 25 (`src/Bladeburner/Bladeburner.ts:259-273`) | deleted |
| Sleeves | kept (augs, stats, memory); set to synchronize or shock recovery (`PlayerObjectGeneralMethods.ts:118-120`) | count kept; augs, exp and shock reset; memory kept (`src/PersonObjects/Sleeve/Sleeve.ts:228-256`) |
| Stanek | fragments kept, charge cleared (`StaneksGift.ts:229-231`); CotMG rejoined | cleared |
| IPvGO | wins, node power and streaks reset, so **Go mults are lost**; favor already granted stays (`src/Go/Go.ts:25-48`) | everything reset (`:49-55`) |
| Entropy (grafting) | kept, re-applied | 0 |
| BN multipliers | recomputed (same values) | recomputed for the new BN |
| BitNode options | kept | replaced by the new options |
| `moneySourceA` (casino cap) / `moneySourceB` | A reset / B kept | both reset |
| SF-1 exploits, achievements, playtime, `sleevesFromCovenant` | kept | kept |

Notes on `softReset`:
- It is an install with zero augs: it still resets everything above (`AugmentationHelpers.ts:69-73`).
- `ns.singularity.installAugmentations` gives 15 int exp, and refuses (returns false) when nothing is queued (`Singularity.ts:196-211`).

**[3.0.2]** An install with no WSE/TIX access deletes the stock market. The CotMG ban moves to aug *purchase* time.

---

## 7. Intelligence

| Aspect | Detail | Source |
|---|---|---|
| Unlock | gained only if you own SF5 (real level) or are in BN5; otherwise reset to 0 on install | `src/PersonObjects/Person.ts:149-159,176-190` |
| Persistence | `persistentIntelligenceData.exp` survives everything; capped per BN by `intelligenceOverride` | `Person.ts:160-174` |
| Skill | `floor(32·ln(exp+534.6) − 200)`, mult 1 | `skill.ts:13` |
| Bonus function | `1 + weight·int^0.8/600` | `src/PersonObjects/formulas/intelligence.ts:1-3` |

Sources of int exp:

| Source | Amount | Source |
|---|---|---|
| BN destroy with SF5 (not a flume) | 300 | `Prestige.ts:362-365` |
| `singularity.purchaseAugmentation` | 15 | `Singularity.ts:182` |
| `singularity.installAugmentations` | 15 | `:207` |
| `singularity.joinFaction` | 7.5 | `:795` |
| `upgradeHomeRam` / `upgradeHomeCores` | 3 | `:614,648` |
| `purchaseTor` | 0.003 | `:416` |
| `purchaseProgram` | 0.0003 | `:456` |
| travel / goToLocation | tiny | `:232,394` |
| Terminal `hack` success | 4·log10(exp) | `Terminal.ts:303-305` |
| `singularity.manualHack` success | 0.005 | `NetscriptHelpers.tsx:604` |
| Crimes | 7.5–130 × 0.05 | `src/Crime/Crimes.ts` |
| Classes | 0.01/s × location | `src/Work/ClassWork.tsx:26-51` |
| Program creation | `0.1·cycles·200/1000` | `src/Work/CreateProgramWork.ts:79-81` |
| Grafting | similar formula | `src/Work/GraftingWork.tsx:87-89` |
| Bladeburner | 0.003·time·weight | `src/Bladeburner/Bladeburner.ts:721,731,1139` |

UI joins do **not** grant int. Only the Singularity call does. The fork's `scripts/farm-intelligence.js` loops `joinFaction` on all keep-on-install invites, then calls `softReset`.

Effects of intelligence:

| Effect | Formula | Source |
|---|---|---|
| Hack chance | ×bonus(1) | `src/Hacking.ts:22` |
| Hack/grow/weaken time | ÷bonus(1) | `Hacking.ts:77` |
| Faction work rep | ×bonus(1), plus int/3 to hacking rep (int × share bonus to field/security) | `src/PersonObjects/formulas/reputation.ts:16-52` |
| Company rep | +int/975 | `src/Company/CompanyPosition.ts:170` |
| Crime success | +0.025·int, ×bonus(1) | `src/Crime/Crime.ts:128-133` |
| Program creation | speed ×bonus(3); level requirement −int/2 | `CreateProgramWork.ts:62`; `Programs.ts:27` |
| Grafting speed | ×bonus(1) | `src/PersonObjects/Grafting/GraftingHelpers.ts:24` |
| Share power | ×bonus(2) | `src/NetworkShare/Share.ts:24` |
| Bladeburner competence | ×bonus(0.75); Field Analysis | `src/Bladeburner/Actions/Action.ts:175`; `Bladeburner.ts:1128` |
| Sleeve shock / sync | rates | `src/PersonObjects/Sleeve/Work/SleeveRecoveryWork.ts:15`; `src/PersonObjects/Sleeve/Work/SleeveSynchroWork.ts:16` |
| Infiltration difficulty | −int/1600 | `src/Infiltration/formulas/game.ts:42` |
| Darknet auth time | **×**bonus(0.25), i.e. higher int makes auth slower as written | `effects.ts:89` |

---

## 8. BitNode options (Advanced options in the BitVerse)

Fields: `sourceFileOverrides: Map<bn,lvl>`, `intelligenceOverride?: int`, and the booleans `restrictHomePCUpgrade` (max 128 GB, 1 core), `disableGang`, `disableCorporation`, `disableBladeburner`, `disable4SData`, `disableHacknetServer`, `disableSleeveExpAndAugmentation` (`BitNodeUtils.ts:30-42`; UI `src/BitNode/ui/BitNodeAdvancedOptions.tsx:342-430`).

- Pass them as the third argument of `destroyW0r1dD43m0n` / `b1tflum3`. They are validated by `validateBitNodeOptions` (`NetscriptHelpers.tsx:871-914`), and `sourceFileOverrides` **must be a `Map`** (`:881-883`).
- Overrides must be finite and **≤ owned level**. There is no lower-bound or integer check (`BitNodeUtils.ts:54-65`).
- The options persist for the entire BN, including across installs. They are only replaced at the next BN entry.
- They are pure handicaps: no reward, achievement gating or SF bonus is attached to them in the code.
- Some effects deliberately use the *real* level so overrides cannot remove them: the sleeve count (`SleeveCovenantPurchases.tsx:59-63`), sleeve API access (`src/NetscriptFunctions/Sleeve.ts:32-35`) and int gain (`Person.ts:181-185`).

---

## 9. BN12 farming via `sourceFileOverrides`

- `initBitNodeMultipliers` uses `activeSourceFileLvl(12)+1` (`BitNode.tsx:1130`), while `giveSourceFile` uses `Player.sourceFileLvl(12)` (`RedPill.tsx:25`).
- Entering BN12 with `{sourceFileOverrides: new Map([[12, 0]])}` therefore puts you in **BN12 at L = 1** (WD 3,060, HLM 0.98), and destroying it raises the real SF12 by 1. Repeat.
- **Cost:** you lose the SF12 free NFG levels, because `activeSourceFileLvl(12) > 0` is now false (`Prestige.ts:265`).
- **Negative overrides pass validation.** `[[12, -1]]` would give L = 0: inc = 1, so every BN12 multiplier is 1 except SSS 1.5, CorpSoftcap 0.8, CorpDivisions 0.5, GangSoftcap 0.8, and Daedalus 31. This is untested. Do **not** apply a negative override to SF11: `[…][-1]` gives `undefined`, so aug prices would become NaN (`AugmentationHelpers.ts:30`).
- The display level (`getBitNodeLevel`) and the gang aug seed also follow the active level.

---

## 10. The fresh-start problem (BN1.1, zero SFs)

### 10.1 What can and cannot be scripted without SFs

| Action | NS API without SF | API with SF | Without SF4 |
|---|---|---|---|
| hack/grow/weaken, scan, port openers, nuke, run/exec, files | core `ns.*` | — | — |
| Buy or upgrade cloud servers | `ns.cloud.*` (BN9: limit 0) | — | — |
| Hacknet | `ns.hacknet.*` | — | — |
| Stocks: buy WSE/TIX/4S, trade | `ns.stock.*`; shorts need 8.2, limit orders 8.3 | SF8 | — |
| Coding contracts | `ns.codingcontract.*` | — | — |
| IPvGO | `ns.go.*` (no SF gate found); cheats need 14.2 | SF14 | — |
| Formulas | `ns.formulas.*` if Formulas.exe is on home | SF5 grants it | creating it needs UI; buying it needs the terminal `buy` |
| Read SF state | `ns.getResetInfo()` 1 GB | — | — |
| **Join faction** | none | `singularity.joinFaction` | invite modal or Factions page "Join" |
| **Work for faction/company, crime, gym, university** | none | `singularity.*` | UI pages |
| **Apply for job** | none | `applyToCompany` | Company page |
| **Travel** | none | `travelToCity` | Travel page (needs $200e3, `src/Constants.ts:28`) |
| **Buy TOR** | none | `purchaseTor` ($200e3, `Constants.ts:44`) | tech store location page |
| **Buy programs** | none | `purchaseProgram` | terminal `buy X.exe` (needs TOR) |
| **Create programs** | none | `createProgram` | Create Program page |
| **Home RAM/cores** | none | `upgradeHomeRam/Cores` | tech store |
| **Buy augs / install / soft reset** | none | `purchaseAugmentation`, `installAugmentations`, `softReset` | Faction aug page; Augmentations page "Install" |
| **Donate to faction** | none | `donateToFaction` | Faction page |
| **Connect / backdoor** | none | `connect`, `installBackdoor` | terminal `connect` / `backdoor` |
| **Exit BN** | none | `destroyW0r1dD43m0n`, `b1tflum3` | BitVerse portal click (§4.3) |
| Gang | `ns.gang.createGang` (needs SF2/BN2 + faction membership) | SF2 | — |
| Bladeburner | `ns.bladeburner.joinBladeburnerDivision` (needs combat 100) | SF6/7 or BN6/7 | — |
| Corporation | `ns.corporation.*` | SF3/BN3 | — |
| Stanek | `ns.stanek.acceptGift` (no location check) | SF13/BN13 | — |
| Sleeves / grafting | `ns.sleeve` (buy and memory in BN10 only), `ns.grafting` | SF10/BN10 | — |
| **Infiltration, casino** | **none at any SF** (`ns.infiltration` is read-only) | — | UI only |

### 10.2 Driving the UI from a script

- **DOM access cost.** Static identifiers `document` and `window` cost 25 GB **each** (`RamCostConstants.Dom = 25`, `RamCostGenerator.ts:12`; detection `src/Script/RamCalculations.ts:185-192`). Detection is an acorn walk over **Identifier nodes**, including non-computed member properties (`:407-412,436-439`). String forms such as `eval("document")`, `globalThis["doc"+"ument"]` or `globalThis["window"]` are invisible to it. No dynamic RAM check covers DOM objects, because the dynamic check only covers `ns` functions.
- **The game's position: the Bypass exploit.** `ns.bypass(doc)` (0 GB) grants SF-1 "Bypass" if `doc` is the real `document` **and** the script's RAM is exactly 1.6 GB (`src/NetscriptFunctions/Extra.ts:21-37`). Example: `ns.bypass(eval("document"))`. The source comments ("You are the captain of your own ship", `Exploit.ts:25-28`) treat this as sanctioned.
- **Click technique used by the fork** (`scripts/casino.js:479-504`):
  - Find elements by XPath: `doc.evaluate(xpath, doc, …)` (`:524`).
  - Click by calling the React props handler `el[Object.keys(el)[1]].onClick({isTrusted:true})` (`__reactProps$…`).
  - Set inputs with `.onChange({isTrusted:true, target:{value}})`.
  - Save with `//button[@aria-label='save game']` (`:130`).
  - Reload without saving: `win.onbeforeunload=null; win.location = win.location` (`:407-425`).
  - Travel: sidebar "Travel", then the city glyph, then confirm (`:166-170`). Casino: "City", then `//span[@aria-label='Iker Molina Casino']` (`:181-183`).
- **Terminal injection.** The input has a stable hook, `id="terminal-input"`, commented "for players to hook in" (`src/Terminal/ui/TerminalInput.tsx:449-450`). Calling its React `onChange` and then `onKeyDown({key:"Enter", preventDefault(){}})` runs `Terminal.executeCommands` (`:238-252`). That gives `connect`, `backdoor`, `buy`, `run b1t_flume.exe`, and `run <script>` (to restart automation).
- **Restarting after a UI install or BN entry.** Every script is killed and no callback exists without SF4.
  - Autoexec (`Settings.AutoexecScript`) only fires on **game load** (`src/NetscriptWorker.ts:185-212,251-256`).
  - Options: (a) save, then reload the page so autoexec relaunches; (b) a `window.setTimeout` registered by the dying script, which survives because `prestigeWorkerScripts` kills NS workers, not page timers, and then injects `run /agent/boot.js` into the terminal. E2 verified it on the browser build (#167, Q5): the agent uses (b), with (a) as its fallback; Steam (Electron) is still to be confirmed.
  - Note `spawn` is suppressed while on the BitVerse page (`src/NetscriptFunctions.ts:659-663`).
- **What the fork automates through the DOM:** only `casino.js` (blackjack with save-scumming). `scripts/autopilot.js:173-185` prints a manual checklist when SF4 is missing, and refuses to auto-destroy without SF4 (`:482-486`). `scripts/stats.js` and `scripts/scan.js` use `eval("document")` for HUDs.
- **Total game access (out of bounds, decision needed).** `scripts/dev-console.js` hooks `webpackChunkbitburner` to obtain `webpack_require`, then routes to the Dev page. That page can grant SFs and gives the SF-1 "YoureNotMeantToAccessThis" (`src/DevMenu.tsx:43-44`). `ns.openDevMenu()` itself only shows an April-Fools popup (`Extra.ts:19`; `src/ui/Apr1.tsx:41-61`).

---

## 11. Where randomness enters

| Where | What is random |
|---|---|
| Every install / BN entry | Server stats from ranges, network topology, and cpuCores (`ServerHelpers.ts:350-406`). WD's required level is fixed. |
| Terminal `hack` on WD | Roll against hack chance. `backdoor` and `destroyW0r1dD43m0n` are deterministic. |
| Black Ops | Success rolls; a failure costs rank and HP. |
| Gang faction aug list | Seeded per `"BN{n}.{activeSF}"`, so reproducible (`FactionHelpers.tsx:185`). |
| Go cheats | `WHRNG(Player.totalPlaytime)`, deterministic given playtime (`netscriptGoImplementation.ts:512`). |
| Other | Casino (save-scummable), stock ticks (initial `ticksUntilCycle`), coding contract spawns, darknet. |

---

## 12. Changes in 3.0.2 (dev branch, brief)

- `enterBitNode` validates the BN number (`bitburner-src/src/RedPill.tsx:60-62`).
- An install without stock access deletes the market (`bitburner-src/src/Prestige.ts:169-170`).
- The CotMG ban moves to `queueAugmentation`. A new repeatable aug "The Thread" is added, and queueing uses `getAugLevel` (`bitburner-src/src/PersonObjects/Player/PlayerObjectGeneralMethods.ts:466-479`).
- Exploits also multiply `dnet_money`.
- New singularity call `hasExportGameBonus`.
- BN definitions and multipliers, SF effects, `SF4Cost`, `RamCalculations` and the Casino are unchanged.

---

## 13. Implications for automation

### 13.1 Leverage points

- **Order nodes by how much each SF speeds up the remaining ~40 destroys.** BN difficulty is flat across levels (§0.1), so the only reason to space repeats is that other SFs make the replay faster.
- **SF4 → 4.3.** This is the gate for reliable automation. Inside BN4 Singularity is already 1× with zero SF4 (`RamCostGenerator.ts:84`), so all three BN4 runs are fully scriptable. SF4.1/4.2 elsewhere cost 16×/4× RAM, which is impractical at BN start. Doing **4.1→4.2→4.3 back-to-back** is the natural plan. BN4 penalties to plan around: WD 9000, HEG 0.4, money ÷5–10.
- **SF1 (start RAM 32 GB, +16–28% to everything) and SF9.2 (128 GB start)** cut early-reset time in every later node.
- **SF5.** Intelligence is permanent and compounding: hack time and chance, all rep, program creation. Every later BN destroy adds +300 int exp, and the Singularity int-farming loop needs SF4. SF5 also gives `getBitNodeMultipliers` and free Formulas.exe.
- **SF2.** A gang in any BN gives near-total aug access from one faction and skips faction grinds. It needs karma −54000, and karma persists across installs.
- **SF6/SF7.** These open the **Bladeburner win** in nodes where WD is extreme: BN13 (36k eff.), BN14 (37.5k), BN2, BN10, BN9, BN15. The BB path needs no TRP, no 30 augs and no $100b. It does not work in BN8 (BladeburnerRank 0). SF7.3 auto-installs Blade's Simulacrum, which then blocks Stanek's Gift. So accept the gift (`ns.stanek.acceptGift`) before joining BB.
- **SF11** lowers aug price escalation (1.9→1.767 per aug). At SF11.3 the 10th aug of a reset costs (1.9/1.767)^9 ≈ 1.9× less. The favor→salary effect is all-or-nothing at SF11.1 (`Formulas.ts:132`).
- **SF10** sleeves are permanent. Covenant sleeves (10e12 × 10^k, 5 max) and memory can **only** be bought in BN10, via `ns.sleeve.purchaseSleeve` / `upgradeMemory` (`Sleeve.ts:304-322`). Those APIs exist in 3.0.1, so the fork's "no API" note is stale. Buy them before leaving any BN10 run.
- **BN12 target:** use the active-SF12 override (§9). Each BN12 run then costs about as much as BN12.1.
- **The casino** gives $10b per install via DOM. The cap resets with `moneySourceA` on install. Combined with stocks, this bootstraps BN8. BN8 itself: `FavorToDonate 0` means rep (including Daedalus' 2.5M) can be bought with stock money from 0 favor.

### 13.2 Bottlenecks

- **BN1.1 needs the UI for the entire loop**: joining factions, working, buying, installing, TOR/programs, and the BitVerse. A robust DOM layer (XPath + React-props click, terminal injection, save/reload/autoexec restart) is a prerequisite until SF4. The fork does not provide it beyond the casino.
- **The Daedalus gate** (30/35/20 installed augs, $100b cash, hack 2500) plus TRP rep (2.5M × AugRep), then an install. Only after that does WD exist. The hack exp needed to reach `3000·WDD` at HLM < 0.5 grows exponentially (§4.1).
- **TOR and programs are lost every install** (unless SF15), so port openers must be re-bought each reset. NUKE plus aug-granted programs survive.
- **Stocks vanish on install** with no refund (§6), so always liquidate first. **Go mults and hacknet servers are also lost on install.**

### 13.3 Ordering considerations

1. BN1.1 → (exit through the BitVerse UI) → BN4 ×3. Alternatively 1.2/1.3 first, if the DOM layer is solid and the +RAM/+mults are preferred before BN4's penalties.
2. Early: SF5.1, SF1.3, SF2.1 or SF2.3 (gangs), and SF9.2 (start RAM). Get SF6/SF7 before BN13/14.
3. Put BN10 where you can afford Covenant purchases; once owned they are permanent.
4. BN8: stocks + casino + donation. There is no WD-difficulty penalty (WDD 1, HLM 1), but ScriptHackMoneyGain 0.
5. BN12 last, with the override trick, until the target is reached.

### 13.4 Exploitable quirks

- `destroyW0r1dD43m0n` needs **neither a backdoor nor a connection**: only hack level + root, or the Black Ops count.
- `b1tflum3` does not check that b1t_flume.exe exists.
- The terminal `hack` path to WD is a random roll but also counts as a win.
- `getOwnedSourceFiles` skips the SF4 check.
- Keep-on-install invites (megacorps, CotMG, SoA) survive soft resets, which enables the int farm.
- The `sourceFileOverrides` validator has no lower bound (§9).
- WD becomes visible via `ns.scan("The-Cave")` after TRP is installed. The fork uses this to detect TRP without SF4 (`scripts/autopilot.js:314-316,407-410`).

### 13.5 Open questions to test in-game (Steam 3.0.1)

- Does a negative SF12 override work end-to-end, and does the UI accept it? (The API path should.)
- ~~Do `window.setTimeout` callbacks survive `prestigeWorkerScripts` reliably enough to restart automation after UI installs?~~ Yes on the browser build: E2 (#167, Q5). Still open: the same, and a page reload, under Electron (Steam).
- Does `DisableASCIIArt` plus the `aria-label` selectors survive the BitVerse cinematic timing? How long does the auto cinematic take?
- Black Ops page "Destroy" button: it uses `CorruptibleText`, so locate it structurally rather than by text.
- Is DOM clicking of faction "Join" and aug "Purchase" reliable when dialogs (`dialogBoxCreate`) pop up after every purchase? `Settings.SuppressBuyAugmentationConfirmation` / `SuppressFactionInvites` exist (`FactionHelpers.tsx:30,122`).
