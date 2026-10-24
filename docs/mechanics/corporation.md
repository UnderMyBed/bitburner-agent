# Corporation (BN3 / SF3): mechanics reference

Source: `vendor/bitburner-src` (Steam v3.0.1). Citations are `file:line` and are relative to `src/` unless they start with `test/`. Abbreviations: `Corporation/` is shortened to `C/`, `Division.ts` to `Div`, `Corporation.ts` to `Corp`, `OfficeSpace.ts` to `Off`, `Actions.ts` to `Act`, `helpers.ts` to `hlp`, and `NetscriptFunctions/Corporation.ts` to `NSC`.
"Cycle" means one **market cycle** (5 states, 10 game-seconds) unless it says "game cycle" (200 ms).
The game also ships community-written docs at `Documentation/doc/en/advanced/corporation/*.md`. They are useful hints, but where they disagree with the code, this document follows the code (see §13).

---

## 1. Access, creation, API

| Item | Rule | Cite |
|---|---|---|
| Can access corp | `bitNodeN === 3 \|\| SF3 level > 0`, and the advanced option `disableCorporation` is off | `PersonObjects/Player/PlayerObjectCorporationMethods.ts:8-10`, `BitNode/BitNodeUtils.ts:17-19` |
| BN disables corp | `CorporationSoftcap < 0.15` (only BN8, where it is 0) | `C/hlp:40-42` |
| Seed money (free, government takes 500e6 shares) | **BN3 only**. Outside BN3, `createCorporation(name, false)` *throws* | `C/hlp:37-39`, `C/Act:41-44` |
| Self-fund cost | 150e9 of player money. Restarting via the UI "Sell CEO position" costs 50e9 if the old corp was self-funded | `C/hlp:46-51`, `C/Act:53-62` |
| Restart (sell CEO) | UI only. NS `createCorporation` always passes `restart=false` | `NSC:629-639` |
| Starting funds | 150e9 (seed or self) | `C/Corp:41` |
| Shares | 1e9 total and 1e9 owned. Seed: total 1.5e9, investorShares 500e6 (you own 66.7%) | `C/Corp:48-49`, `PlayerObjectCorporationMethods.ts:26-29` |
| Warehouse API + Office API unlocks | Free if in BN3 **or** SF3 = 3. Otherwise 50e9 each, bought with corp funds | `PlayerObjectCorporationMethods.ts:21-24`, `C/data/CorporationUnlocks.ts:65-75` |
| Lifetime | Survives aug installs. Destroyed on BitNode change (`prestigeSourceFile`), along with the research trees | `PersonObjects/Player/PlayerObjectGeneralMethods.ts:159,169`, `Prestige.ts:334` |
| `createCorporation(name, selfFund=true)` | Default is self-fund | `NSC:631` |

**API gating.** Every corp function requires an existing corp (`checkAccess`). Warehouse-API functions also need the `Warehouse API` unlock, and Office-API functions need the `Office API` unlock (`NSC:157-163`). Further requirements: `setSmartSupply*` needs the Smart Supply unlock (`NSC:337,349`). `export*` needs the Export unlock (`NSC:401,417`). `set*MarketTA1/2` need that research in the division (`NSC:441,451,460,469`). `issueDividends` requires being public (`NSC:697`). Demand and competition fields return `undefined` unless the matching 5e9 unlock is owned (`NSC:244-245,264-265`).

**RAM** (`Netscript/RamCostGenerator.ts:13-14,466-532`). Every "info" getter costs **10 GB** and every action costs **20 GB**. These cost 0 GB: `hasCorporation`, `canCreateCorporation`, `getConstants`, `getBonusTime`, `nextUpdate`. The API has 20 info functions and 38 action functions, so a script that references all of them needs about **960 GB**. A bot running on early-BN3 home RAM must split the work into small single-purpose scripts.

**Not exposed by the API:** product `markup`, `creationJobFactors`, employee average int/cha/cre/eff, material `averagePrice`, corp `totalAssets`, and per-cycle valuation (`NSC:221-280,596-613,715-740`). They have to be inferred (see §7.5).

---

## 2. Time, states, and bonus time

- Engine: each 200 ms tick calls `corp.storeCycles(numCycles)` and then `corp.process()` (`engine.tsx:111-115`). Offline time is added to `storedCycles` (`engine.tsx:328-329`).
- `process()` runs **one state** if `storedCycles >= 10`, and consumes 10 game cycles when it does (`C/Corp:109-116`, `C/data/Constants.ts:52-54`). Normally that is 1 state per 2 s, so a market cycle takes 10 s. With bonus time it is 1 state per 200 ms tick, a **10× speed-up**: bonus time drains 9 game cycles per tick. `getBonusTime()` returns `storedCycles × 200` ms (`NSC:804-807`).
- Cooldowns (share sale and share issue) are decremented by 10 game cycles **per processed state** (`C/Corp:127-133`). Bonus time therefore shortens them in real time too.
- State order: `START → PURCHASE → PRODUCTION → EXPORT → SALE` (`C/data/Constants.ts:25`, `C/CorporationState.ts`). `nextUpdate()` resolves **after** a state is processed and returns that state's name (`C/Corp:180-185`, `NSC:808-813`).
- Inside one state, all divisions first `resetImports` (this only does anything at EXPORT), then each division processes in Map insertion order (`C/Corp:118-125`).

| State | What happens | Cite |
|---|---|---|
| START (division) | Store last cycle's revenue/expenses (÷10 → per-second rates). **Office processing**: auto-hire with HRBuddy, copy `employeeNextJobs → employeeJobs`, update energy/morale/XP/salary, recompute `employeeProductionByJob`. Material market random walk. Product demand↓/competition↑. Popularity −0.0001. **No production, no RP.** | `C/Div:162-201` |
| START (corp) | Apply funds += revenue×10 − expenses×10, then pay dividends, update total assets, cycle valuation, rolling valuation, and share price | `C/Corp:136-176` |
| PURCHASE | Buy materials (manual `buyAmount` and Smart Supply) | `C/Div:491-582` |
| PRODUCTION | Produce materials. Make progress on the **first** unfinished product. Produce finished products | `C/Div:583-713,820-944` |
| EXPORT | Run exports (FIFO per material) | `C/Div:722-807` |
| SALE | Sell materials and products | `C/Div:715-720,945-947` |
| every non-START state | **RP gain** and **salary charged again** (`expenses += office.totalSalary`) | `C/Div:476-485` |

Salary is therefore charged **5× per cycle**: once from `office.process` at START and once in each of the 4 other states. Employee production values are computed **only at START**, so job changes take effect from the next START.

---

## 3. Static data

### 3.1 Materials (`C/MaterialInfo.ts:4-137`)

| Material | size | baseCost | demand base [range] | competition base [range] | maxVolatility | baseMarkup |
|---|---|---|---|---|---|---|
| Water | 0.05 | 1 500 | 75 [65,85] | 50 [40,60] | 0.2 | 6 |
| Ore | 0.01 | 500 | 50 [40,60] | 80 [65,95] | 0.2 | 6 |
| Minerals | 0.04 | 500 | 75 [60,90] | 80 [65,95] | 0.2 | 6 |
| Food | 0.03 | 5 000 | 80 [70,90] | 60 [35,85] | 1 | 3 |
| Plants | 0.05 | 3 000 | 70 [20,90] | 50 [30,70] | 0.6 | 3.75 |
| Metal | 0.1 | 2 650 | 80 [75,85] | 70 [60,80] | 1 | 6 |
| Hardware | 0.06 | 8 000 | 85 [80,90] | 80 [65,95] | 0.5 | 1 |
| Chemicals | 0.05 | 9 000 | 55 [40,70] | 60 [40,80] | 1.2 | 2 |
| Drugs | 0.02 | 40 000 | 60 [45,75] | 70 [40,99] | 1.6 | 1 |
| Robots | 0.5 | 75 000 | 90 [80,99] | 90 [80,99] | 0.5 | 1 |
| AI Cores | 0.1 | 15 000 | 90 [80,99] | 90 [80,99] | 0.8 | 0.5 |
| Real Estate | 0.005 | 80 000 | 50 [5,99] | 50 [25,75] | 1.5 | 1.5 |

Boost materials are Hardware, Robots, AI Cores, and Real Estate (`C/data/Constants.ts:34`). Every warehouse has its **own** Material object for every material, so prices, demand, and competition walk independently for each (division, city) pair (`C/Warehouse.ts:27`). A material is "relevant" to a division, meaning it can be bought, exported to, or have its market processed, if it is an input, an output, or a boost material (`C/ui/Helpers.tsx`, `C/Div:219-239`).

### 3.2 Industries (`C/data/IndustryData.ts:7-305`)

Factor columns: RE = realEstateFactor, Sci = scienceFactor, HW = hardwareFactor, Rob = robotFactor, AI = aiCoreFactor, Adv = advertisingFactor. A missing factor is 0.

| Industry (API name) | Cost | RE | Sci | HW | Rob | AI | Adv | Inputs (per unit) | Material outputs | Product |
|---|---|---|---|---|---|---|---|---|---|---|
| Agriculture | 40e9 | .72 | .5 | .2 | .3 | .3 | .04 | Water .5, Chemicals .2 | Plants, Food | – |
| Refinery | 50e9 | .3 | .5 | .5 | .4 | .3 | .04 | Ore 1 | Metal | – |
| Chemical | 70e9 | .25 | .75 | .2 | .25 | .2 | .07 | Plants 1, Water .5 | Chemicals | – |
| Computer Hardware | 500e9 | .2 | .62 | 0 | .36 | .19 | .17 | Metal 2 | Hardware | yes |
| Fishing | 80e9 | .15 | .35 | .35 | .5 | .2 | .08 | Plants .5 | Food | – |
| Restaurant | 10e9 | .05 | .12 | .15 | .3 | .25 | .25 | Food .5, Water .5 | – | yes |
| Healthcare | 750e9 | .1 | .75 | .1 | .1 | .1 | .11 | Robots 10, AI Cores 5, Drugs 5, Food 5 | – | yes |
| Mining | 300e9 | .3 | .26 | .4 | .45 | .45 | .06 | Hardware .1 | Ore, Minerals | – |
| Pharmaceutical | 200e9 | .05 | .8 | .15 | .25 | .2 | .16 | Chemicals 2, Water .5 | Drugs | yes |
| Real Estate | 600e9 | 0 | .05 | .05 | .6 | .6 | .25 | Metal 5, Plants 1, Water 2, Hardware 4 | Real Estate | yes |
| Robotics | 1e12 | .32 | .65 | .19 | 0 | .36 | .18 | Hardware 5, AI Cores 3 | Robots | yes |
| Software | 25e9 | .15 | .62 | .25 | .05 | .18 | .16 | Hardware .5 | AI Cores | yes |
| Tobacco | 20e9 | .15 | .75 | .15 | .2 | .15 | .2 | Plants 1 | – | yes |
| Water Utilities | 150e9 | .5 | .6 | 0 | .4 | .4 | .08 | Hardware .1 | Water | – |

Product rating weights (`IndustryData.ts`):

| Industry | quality | performance | durability | reliability | aesthetics | features |
|---|---|---|---|---|---|---|
| Computer Hardware | .15 | .25 | .25 | .2 | .05 | .1 |
| Restaurant | .7 | | .1 | | .2 | |
| Healthcare | .4 | .1 | .1 | .3 | | .1 |
| Pharmaceutical | .2 | .2 | .1 | .3 | | .2 |
| Real Estate | .2 | | .25 | .1 | .35 | .1 |
| Robotics | .1 | .2 | .2 | .2 | .1 | .2 |
| Software | .2 | .2 | .2 | .2 | | .2 |
| Tobacco | .7 | | .1 | | .2 | |

Product size is Σ(input qty × input size): Tobacco 0.05, Restaurant 0.04, Software 0.03, Pharmaceutical 0.125, Computer Hardware 0.2, Robotics 0.6, Real Estate 0.89, Healthcare 5.75 (`C/Product.ts:208-212`).

Notes:
- **Every** produced material receives the full `prod` amount. Agriculture makes `prod` Plants **and** `prod` Food from one set of inputs, and Mining makes Ore and Minerals the same way (`C/Div:668-699`).
- Material output and product output come from the same office productivity **independently**. One does not reduce the other, but they compete for inputs and warehouse space.
- Some industries consume or produce their own boost materials. Mining and Robotics consume Hardware, and Robotics also consumes AI Cores. Software produces AI Cores, which then boost its own production and quality. Stored inputs and outputs count toward the boost.

### 3.3 Corporation upgrades (leveled) (`C/data/CorporationUpgrades.ts:12-116`)

The multiplier is `1 + benefit × level` (`C/Corp:428-429`). Buying k levels starting from level L costs `base × mult^L × (mult^k − 1)/(mult − 1)` (`C/hlp:53-62`).

| Upgrade | base | mult | benefit/level | Effect |
|---|---|---|---|---|
| Smart Factories | 2e9 | 1.06 | +3% | production (all divisions) |
| Smart Storage | 2e9 | 1.06 | +10% | warehouse size |
| Wilson Analytics | 4e9 | **2** | +0.5% | advert effectiveness (not retroactive) |
| Nuoptimal Nootropic Injector Implants | 1e9 | 1.06 | +10% | creativity |
| Speech Processor Implants | 1e9 | 1.06 | +10% | charisma |
| Neural Accelerators | 1e9 | 1.06 | +10% | intelligence |
| FocusWires | 1e9 | 1.06 | +10% | efficiency |
| ABC SalesBots | 1e9 | 1.07 | +1% | sales volume |
| Project Insight | 5e9 | 1.07 | +5% | RP gain |

### 3.4 Unlocks (one-time) (`C/data/CorporationUnlocks.ts:11-76`)

| Unlock | Price | Effect |
|---|---|---|
| Export | 20e9 | enables exports |
| Smart Supply | 25e9 | enables smart supply. Warehouses created **after** the unlock default to enabled (`C/Warehouse.ts:56-58`). Existing warehouses must be enabled by hand |
| Market Research - Demand | 5e9 | API shows demand |
| Market Data - Competition | 5e9 | API shows competition |
| Shady Accounting | 500e12 | tributeModifier −0.05 (`C/Corp:393-395`) |
| Government Partnership | 2e15 | tributeModifier −0.10 (`C/Corp:396-398`) |
| Warehouse API / Office API | 50e9 each | API access (free in BN3 or at SF3.3) |

### 3.5 Research (`C/ResearchMap.ts`, `C/data/BaseResearchTree.ts`)

The tree root is **Hi-Tech R&D Laboratory**, and every other research needs its parent (`C/Act:511-519`).

| Research | RP cost | Parent | Effect |
|---|---|---|---|
| Hi-Tech R&D Laboratory | 5 000 | – | RP ×1.1 |
| AutoBrew | 12 000 | Lab | energy is held at max permanently, no tea needed (`C/Off:72,90-91`) |
| AutoPartyManager | 15 000 | Lab | morale is held at max permanently (`C/Off:73,97-98`) |
| Automatic Drug Administration | 10 000 | Lab | prerequisite only |
| Go-Juice | 25 000 | Auto Drug | maxEnergy +10 |
| CPH4 Injections | 25 000 | Auto Drug | int/cha/cre/eff ×1.1 |
| Drones | 5 000 | Lab | prerequisite only |
| Drones - Assembly | 25 000 | Drones | production ×1.2 |
| Drones - Transport | 30 000 | Drones | storage ×1.5 |
| HRBuddy-Recruitment | 15 000 | Lab | auto-hire 1 employee per cycle per office |
| HRBuddy-Training | 20 000 | HR-Recruit | auto-hired employees become Interns |
| Market-TA.I | 20 000 | Lab | allows TA1 |
| Market-TA.II | 50 000 | TA.I | allows TA2 |
| Overclock | 15 000 | Lab | int, eff ×1.25 |
| Sti.mu | 30 000 | Overclock | maxMorale +10 |
| Self-Correcting Assemblers | 25 000 | Lab | production ×1.1 |
| uPgrade: Fulcrum *(product industries)* | 10 000 | Lab | product production ×1.05 |
| uPgrade: Capacity.I / .II | 20 000 / 30 000 | Fulcrum / Cap.I | +1 product slot each (3→4→5) (`C/Div:44-53`) |
| uPgrade: Dashboard | 5 000 | Fulcrum | UI only |

No research changes `salesMult` or `advertisingMult`, so both are always 1. Multipliers from researched nodes multiply together (`C/ResearchTree.ts:156-207`).

**Research trees are per industry type and corp-wide.** `IndustryResearchTrees[industry]` is shared. Buying a research gives it to every division of that industry (`C/Act:528-539`). A division of that industry created later **inherits** everything already researched, because the tree is reset only on new corp or prestige (`C/Div:1050-1058`, `C/data/IndustryData.ts:317-324`). The RP pool, however, is per division.

---

## 4. Offices and employees (`C/Off`)

### 4.1 Costs

| Item | Formula | Cite |
|---|---|---|
| New city office | 4e9 at size 3 (Sector-12 comes with the division) | `C/Act:121-134`, `C/data/Constants.ts:58-59` |
| Office size a → a+n | `(4e9/0.09) × 1.09^(a/3) × (1.09^(n/3) − 1)` | `C/hlp:64-71` (checked in `test/jest/Corporation.test.ts:121-140`) |
| Hire | **free**. There is no fire API | `C/Off:178-199` |
| Tea | 500e3 × employees, gives +2 energy at the next START. One pending at a time | `C/Off:218-228`, `C/Act:403-408` |
| Party | cost = c × employees, mult = 1 + c/1e7. One pending at a time | `C/Act:410-423`, `C/Off:230-236` |

### 4.2 Hiring

Each hire draws randInt(50,100) for each of int, cha, cre, eff, morale, and energy, and folds it into the office **averages**. It also adds randInt(50,100) to `totalExperience` (`C/Off:181-193`). Stats never change after that except for experience growth. Office stat averages are hidden from the API.

### 4.3 Processing at START (`C/Off:53-135`)

```
perfMult = 1.002                                   if N < 9
         = 1 + 0.002·9·min(1/9, interns/N − 1/9) − (funds<0 && div.lastRev<div.lastExp ? 0.001 : 0)   if N ≥ 9
energy = autoTea  ? maxEnergy : (energy − 0.002·rand)·perfMult + (tea ? 2 : 0)
morale = autoParty? maxMorale : ((morale − 0.002·rand)·perfMult + (partyMult−1)·10)·partyMult
clamp both to [10, max]          max = 100 (+10 with Go-Juice / Sti.mu)
totalExperience += 0.0015·(N − unassigned + 9·interns)
salary(per state) = 3·N·(avgInt + avgCha + avgCre + avgEff + totalExp/N)     // charged 5×/cycle (§2)
```

With N ≥ 9, morale and energy decay by ×0.998 per cycle unless at least 1/9 of employees are interns. At 2/9 interns they grow by ×1.002. Tea, parties, and AutoBrew/AutoParty also offset the decay.

### 4.4 Employee production (`C/Off:137-176`)

```
effInt = avgInt × NeuralAccel × research(Overclock 1.25, CPH4 1.1)    (same pattern for cha/cre/eff)
base   = morale × energy × 1e-4                                       // 1.0 at 100/100, 1.21 at 110/110
exp    = totalExp / N
Operations  = n·(0.6·Int + 0.1·Cha + exp + 0.5·Cre + Eff)·base
Engineer    = n·(Int + 0.1·Cha + 1.5·exp + Eff)·base
Business    = n·(0.4·Int + Cha + 0.5·exp)·base
Management  = n·(2·Cha + exp + 0.2·Cre + 0.7·Eff)·base
R&D         = n·(1.5·Int + 0.8·exp + Cre + 0.5·Eff)·base
Intern, Unassigned → 0
```

`setJobAssignment(div, city, job, n)` only moves employees between Unassigned and `job`, and it throws if there are not enough Unassigned. To reassign, first set every job to 0 and then set each target (`NSC:508-540`, `C/Off:201-216`). Changes apply at the next START.

---

## 5. Production, warehouse, boost materials

### 5.1 Warehouse

- `size = level × 100 × SmartStorage(1+0.1L) × research(DronesTransport 1.5)` (`C/Warehouse.ts:75-77`). A new warehouse is level 1 (size 100) and costs 5e9 (`C/Act:425-435`).
- Upgrading k levels from level L costs `Σ_{i=0}^{k-1} 1e9·1.07^(L+1+i)` (`C/Act:437-442`).
- `purchaseWarehouse` does **not** check that an office exists in that city (`C/Act:425-435`).

### 5.2 Division production multiplier (boost materials) (`C/Div:123-137`)

```
cityMult(c) = Π_m (1 + 0.002·stored_m(c))^{factor_m}       m ∈ {Real Estate, Hardware, Robots, AI Cores}
productionMult = max(1, Σ_{cities with warehouse} cityMult(c)^0.73)
```

The multiplier is a **division-wide sum** that is then applied to *each* city's production. With 6 cities, production scales with about 6× the per-city boost, and output with about 36×.

**Optimal allocation for a space budget S** in one city (Lagrange on `Σ c_i ln(1+0.002x_i)` subject to `Σ s_i x_i = S`):

```
space_i = s_i·x_i = (c_i / Σc)·(S + 500·Σs) − 500·s_i        (sums over the active set)
```

If any `space_i` comes out ≤ 0, drop that material and re-solve. When money is also a constraint (`Σ p_i x_i ≤ B`), the KKT condition becomes `x_i = c_i / (λ s_i + μ p_i) − 500`. Solve for λ and μ numerically.

Example for Agriculture (c = .72/.2/.3/.3, s = .005/.06/.5/.1) with S = 1000: about 125.7k Real Estate (≈10e9), 2.4k Hardware, 26 Robots, and 2.1k AI Cores. That gives cityMult ≈ 127, so cityMult^0.73 ≈ 34 per city. Real Estate dominates the money cost.

### 5.3 Office productivity (`C/Div:991-1015`)

```
T = Ops + Eng + Mgmt   (employee production values)
officeProd = 0.05 · (Ops^0.4 + Eng^0.3) · (1 + Mgmt/(1.2·T))      × 0.5 if for products
```

### 5.4 Material production per city at PRODUCTION (`C/Div:583-713`)

```
prod = officeProd · productionMult · SmartFactories(1+0.03L) · research(Assembly 1.2 · SelfCorrecting 1.1) · 10      // units/cycle
netSize = Σ size(outputs) − Σ qty·size(inputs);  if netSize>0: prod = min(prod, floor(free/netSize))
frac = min over inputs of stored/(qty·prod)  (≤1)
consume qty·prod·frac of each input; each output += min(prod·frac, productionLimit·10)
```

The production limit applies **only to outputs**. Inputs are consumed for the full `prod·frac` (`C/Div:668-675`).

**Output quality** (`C/Div:677-689`):

```
avgIn  = max(1, mean(input qualities))
temp   = EngProd/90 + RP^sciFactor + AICores_stored^aiFactor / 1e4
qOut   = min(temp, avgIn · max(1, sqrt(temp)))
stored quality = max(1, weighted mean(old stored, new output))
```

`RP` here is the division's **current, unspent** pool. Spending RP lowers future quality. Purchased materials have quality 1 (`C/Div:515,571`), and imports blend in at the source's quality (`C/Div:786-791`).

### 5.5 Product production per city per finished product (`C/Div:856-943`)

```
prod = officeProd(forProduct) · SmartFactories · productionMult · research(prod) · Fulcrum(1.05) · 10, capped by productionLimit
```

Product size equals the input size, so warehouse space never limits production directly; inputs do (`C/Div:876-886`). **Each product gets this full amount**, so production is not split between products. More product slots means more total output, as long as inputs, space, and sales keep up.

```
avgQlt = (1 + Σ input qualities) / nInputs            // quirk: the "+1" is folded into the mean
tempEffRat = min(rating, avgQlt · sqrt(rating))
effectiveRating(city) = weighted mean(stored, new)
```

To avoid the cap, input quality needs to be about `sqrt(rating)`. For a one-input product (Tobacco) the quirk works out to an effective quality of `1 + q_plants`.

---

## 6. Products

**Creation** (`C/Act:459-499`): you need an office in the city. Design and marketing investments are deducted immediately (source "product development"). The product limit counts unfinished products, and the name must be unique. Discontinuing a product deletes it and its stock immediately (`C/Div:971-973`).

**Development** happens only in PRODUCTION, using the creation city's office (`C/Div:826-841`, `C/Product.ts:109-133`):

```
progress/cycle = 0.01 · (Eng^0.34 + Ops^0.2) · (1 + Mgmt/(1.2·(Ops+Eng+Mgmt)))       // to 100
creationJobFactors[job] += prod[job] · progress/100        // ⇒ progress-weighted average of each job's production
```

**Quirk:** the loop `break`s at the first unfinished product (`C/Div:840`). Only one product develops at a time, in insertion order.

**Finishing** (`C/Product.ts:136-213`). The ratios below are each job's share of `creationJobFactors.total`.

```
designMult  = 1 + designInvest^0.1 / 100
balanceMult = 1.2·eng + 0.9·mgmt + 1.3·rnd + 1.5·ops + 1.0·bus      (ratios)
sciMult     = 1 + RP^sciFactor / 800                                  // RP pool at the finishing moment
totalMult   = balanceMult·designMult·sciMult
stat = totalMult · Σ_job w[stat][job]·F[job]   with w (Eng, Mgmt, R&D, Ops, Bus):
  quality    .10 .05 .05 .02 .02     performance .15 .02 .02 .02 .02
  durability .05 .02 .08 .05 .05     reliability .02 .08 .02 .05 .08
  aesthetics .00 .08 .05 .02 .10     features    .08 .05 .02 .05 .05
rating   = Σ industryWeight·stat
advMult  = 1 + marketingInvest^0.1 / 100
markup   = 100 / (advMult · (quality+0.001)^0.65 · max(bus+mgmt ratio, 1/F.total))
demand   = awareness==0 ? 20 : min(100, advMult·100·popularity/awareness)
competition = randInt(0,70)
```

Investment scales very weakly. 1e9 gives ×1.079 and 1e12 gives ×1.158. The RP pool at finish time and the (Business+Management) share during development are the big levers: the markup limit is **linear** in the bus+mgmt share.

**Product market drift** (every START): `change = randInt(0,3)·0.0004`, tripled for Pharmaceutical, Software, and Robotics. Demand −change (floor 0.001), competition +change (cap 99.99) (`C/Div:242-261`).

---

## 7. Selling (SALE state, `C/Div:263-466`)

### 7.1 Inputs

| Term | Material | Product |
|---|---|---|
| marketPrice (MP) | `material.marketPrice` | `productionCost = 5 · Σ qty·MP(input, this warehouse)` (`C/Div:280-285`) |
| markupLimit (ML) | `quality / baseMarkup` (`C/Material.ts:85-87`) | `max(effRating,0.001) / product.markup` |
| itemFactor | `quality + 0.001` | `0.5 · effRating^0.65` |

### 7.2 Volume (units/s)

```
maxSell = itemFactor · marketFactor · markupMult · businessFactor · SalesBots(1+0.01L) · advertFactor · 1
marketFactor   = max(0.1, demand·(100−competition)/100)                                  (C/Div:1041-1043)
businessFactor = (1+BusProd)^0.26 + (1+BusProd)/1e4                                       (C/Div:1018-1022)
advertFactor   = ((aw+1)^adv · (pop+1)^adv · ratio)^0.85,  ratio = aw==0 ? 0.01 : max(0.01,(pop+0.001)/aw)   (C/Div:1027-1038)
markupMult     = price ≤ 0 → 1e12 ;  0<price≤MP → MP/price ;  MP<price≤MP+ML → 1 ;  else (ML/(price−MP))^2   (C/hlp:133-154)
sold/cycle = min(maxSell, desiredAmount) · 10, capped by stored                         (C/Div:439-441)
```

The desired amount is an expression in `MAX` (= stored/10), `PROD` (production per second), `INV` (stored), and arithmetic. Price is an expression in `MP` (`C/Div:335-355,392-415`, `C/Act:210-287`). The default amount is 0 and the default price is "", which means **no sales** until you set them.

### 7.3 Advertising (`C/Div:975-988`)

Cost of the n-th ad is `1e9·1.06^n`. With `m = Wilson(1+0.005L)`:

```
awareness  = (aw + 3m)·1.005m
popularity = (pop + m)·(1 + randInt(1,3)/200)·m
```

Both are capped at `Number.MAX_VALUE`. Popularity decays by −0.0001 per cycle.

**With zero ads, `ratio = 0.01`, so advertFactor ≈ 0.02.** One ad lifts the ratio to about 0.33 and advertFactor to about 0.42, a ~21× sales increase. Wilson is not retroactive: it scales only future ads, compounding about `1.005m` per ad.

### 7.4 Pricing modes

- **TA1:** `price = MP + ML` (`C/Div:390-391`).
- **TA2:** `price = MP + ML·sqrt(P/S)`, where P is `maxSell` without markupMult and S is the desired sell amount per second (`C/Div:363-389`). This clears exactly S when P > S. **Quirk:** when P < S, TA2 prices *below* MP+ML with no extra volume, because markupMult is 1 on (MP, MP+ML]. `max(TA1, TA2)` is strictly better.
- In the penalty region, revenue `p·P·ML²/(p−MP)²` falls as p rises. Clearing the stock at the TA2 price is therefore revenue-optimal per cycle.
- Steady-state revenue per city per second ≈ `S·MP + ML·sqrt(S·P)`. For products the ML term dominates, so revenue ∝ effRating^1.325 · advMult · q^0.65 · (bus+mgmt) · sqrt(S · marketFactor · businessFactor · advertFactor · SalesBots).
- A price of exactly 0 discards stock: markupMult is 1e12 and the revenue is 0. A negative price sells nothing, because the sale requires `sCost >= 0` (`C/Div:454`), and for materials a numeric negative price returns early (`C/Div:275`).

### 7.5 Inferring hidden values

To get the product markup, set a price far above MP+ML so that sold < maxSell, wait one cycle, then compute `ML = (price − MP)·sqrt(actualSold / P)`. Markup is constant per product. Employee average stats can be solved from `employeeProductionByJob` when at least 4 jobs are staffed (linear in int/cha/cre/eff given known exp and base).

---

## 8. Purchasing, Smart Supply, exports

- **`buyMaterial(rate)`**: buys `rate·10` units at PURCHASE, at the local MP, capped by free space. There is **no funds check**: it is charged as expenses at the next START, so funds can go negative (`C/Div:505-521`, `C/Act:320-330`). The only penalty for negative funds is morale/energy −0.001 per cycle, and only when the division is also unprofitable (§4.3).
- **`bulkPurchase(amt)`**: immediate. It needs funds and space, and its funds source is "materials" (`C/Act:332-365`).
- **Smart Supply** (`C/Div:497-503,524-580`): for each input, `want = qty × smartSupplyStore × 10`, where `smartSupplyStore` is the total units produced in the **previous** PRODUCTION (materials plus every product), so it lags one cycle. All inputs are then aligned to the scarcest one and scaled to fit free space. Finally the option is applied: `leftovers` (default) subtracts what is stored, `imports` subtracts the last import rate × 10, and `none` buys the full amount.
- **Exports** (`C/Div:722-807`, `C/Act:543-593`): processed at EXPORT in FIFO order per material. The amount expression can use `MAX` (stored/10), `EPROD`/`IPROD` (exporter/importer production per second; consumption is negative), and `EINV`/`IINV`. It is multiplied by 10, then capped by source stock and by target free space. Quality blends into the target. The target's `averagePrice` is set to the **target warehouse's** MP. The usual "fill demand" string is `(IPROD+IINV/10)*(-1)`. Selling happens after EXPORT.
- **Material market random walk** (each START, each relevant material, in each warehouse) (`C/Material.ts:90-129`): competition and demand each move ×(1±U·vol/100) inside their ranges. Price moves ×(1+U·vol/300)^±1 **twice**, with direction tied to the competition and demand coin flips. **Price is an unbounded symmetric log-random-walk with no mean reversion**, independent per (division, city).

---

## 9. Research points

```
RP per office per non-START state = 0.004 · sqrt(R&DProd) · ProjectInsight(1+0.05L) · research(Lab 1.1)    (C/Div:476-482)
⇒ per cycle = 0.016·sqrt(R&DProd)·mults per office.  Science factor does NOT affect RP gain.
```

RP is generated even in offices without a warehouse. Hash upgrade "Exchange for Corporation Research" adds +1000 RP to **every** division. Its cost is 200 × the level being bought, and the price rises with each purchase (`Hacknet/HacknetHelpers.tsx:529-535`, `Hacknet/data/HashUpgradesMetadata.tsx:82-84`, `Hacknet/HashUpgrade.ts:72-82`).

---

## 10. Finance

### 10.1 Revenue, expenses, funds

Division `thisCycleRevenue` (sales) and `thisCycleExpenses` (5× salary + PURCHASE buys) roll into per-second `lastCycle*` at START (`C/Div:173-176`). The corp then does `funds += 10·(Σrev − Σexp)` (`C/Corp:157-161`). Everything else (upgrades, ads, tea, bulk buys, offices) is debited from funds **immediately** and does not appear in revenue or expenses.

### 10.2 Total assets and the funds-source accounting quirk

```
totalAssets(START) = funds + Σ_div[ recoupable + Σ_warehouses(Σ mat.stored·mat.averagePrice + Σ prod.stored·prod.productionCost) ]   (C/Corp:234-249)
recoupable = (industry startingCost + Σ_{non-Sector-12 offices}(4e9 + (warehouse? 5e9 : 0))) / 2                                       (C/Div:139-148)
assetDelta = (totalAssets − previousTotalAssets) / 10                                                                                    (C/Corp:199-200)
```

`gainFunds`/`loseFunds` with a **long-term** source do `totalAssets += |amt|`, using the **absolute value** (`C/Corp:82-95`). The game's own doc says `+= amt`, which is wrong for 3.0.1, and the dev branch is unchanged. The long-term sources are `product development`, `office`, `warehouse`, `upgrades`, `bribery`, `public equity`, `private equity`, `hacknet`, and `force majeure` (`C/data/FundsSource.ts:3-13`).

| Action (source) | Effect on next assetDelta×10 |
|---|---|
| Accept offer / IPO / issue shares / hashes→funds (+F, long-term) | 0 (neutral) |
| `levelUpgrade`, `purchaseUnlock` (upgrades), `upgradeOfficeSize` (office), `upgradeWarehouse` (warehouse), `makeProduct` investment, bribe (−X, long-term) | **−2X** (double-counted) |
| New division, new office, new warehouse ("division", short-term) | −X/2 (half is recoupable) |
| Ads, tea, parties ("advert", "tea", "parties", short-term) | −X |
| Boost/bulk material buys ("materials", short-term) and `buyMaterial` | ≈ 0 (stock is valued at purchase price) |
| Producing materials | + output × MP(at production) − input cost |
| Producing products | + output × 5·Σ input MP − input cost, **even if unsold** |
| Selling stock | + (sale price − carried value) |

### 10.3 Valuation (`C/Corp:198-232`)

```
officeMult = 1.1^(numberOfOfficesAndWarehouses/12)            // division +2, each office/warehouse +1 (C/Act:94,133,434)
private:  v = (10e9 + funds/3 + 315e3·max(0, assetDelta)) · officeMult, floored to 1e6
public:   v = max(0, (funds + 85e3·assetDelta·(1−dividendRate)) · officeMult)
v = max(v, 10e9) · CorporationValuation(BN)
valuation = mean of the last 10 cycle values   (the list starts as [0], so the first 9 cycles are diluted)
```

Post-IPO, dividends reduce the delta twice: once by paying them out of funds and again through the `(1−rate)` factor.

### 10.4 Investment rounds (`C/Corp:333-354`, `C/Act:190-208`)

There is one deterministic offer per round, `valuation × shareFrac × mult`, and it can be accepted at any time while private. Accepting moves `floor(1e9·shareFrac)` of your shares to investors.

| Round | shareFrac | mult | Offer | Investor shares | You own after (self-funded / seed) |
|---|---|---|---|---|---|
| 1 | 0.10 | 3 | 0.3 V | 100e6 | 90% / 60% |
| 2 | 0.35 | 2 | 0.7 V | 350e6 | 55% / 36.7% |
| 3 | 0.25 | 2 | 0.5 V | 250e6 | 30% / 20% |
| 4 | 0.20 | 1.5 | 0.3 V | 200e6 | 10% / 6.7% |

Sensitivity: each $1/s of sustained asset growth adds $315k to V, which is +94.5k on a round-1 offer and +220k on round 2. Each 1e9 of unspent funds adds 0.33e9 to V.

### 10.5 Going public and shares

| Action | Rule | Cite |
|---|---|---|
| `goPublic(n)` | Allowed any time while private. Ends investor rounds. IPO price = target price at ownership `(own−n)/total`. Corp funds += n·price ("public equity"). The API accepts n = 0, and n = all your shares | `C/Act:144-159`, `NSC:776-783` |
| Target share price | `V·(0.5 + sqrt(own/total))/total` | `C/Corp:251-262` |
| Share price drift | Each START, ×(1 ± U·1%) toward the target. It lags fast valuation growth | `C/Corp:264-274` |
| `sellShares(n)` | Requires public, a positive integer n < owned, n ≤ 1e14, and no cooldown. Proceeds go to **player money**. Processed in 1e6 batches: after each batch the price moves ×1.005 if ≤ target(own − sold), else ×0.995. Cooldown 18e3 game cycles (1 h; 6 min with bonus time). No BN multiplier or tribute applies | `C/Corp:285-325`, `C/Act:367-380`, `C/hlp:94-103` |
| Proceeds estimate | if the price tracks the target: `≈ V·[0.5f + (2/3)(o^1.5 − (o−f)^1.5)]` for fraction f sold from ownership o | derived |
| `buyBackShares(n)` | Player money at 1.1× the batch-walked price. Only `issuedShares` can be bought back; investor and government shares cannot. **No cooldown** | `C/Corp:327-331`, `C/Act:382-394`, `C/hlp:106-116` |
| `issueNewShares(n)` | Public only. n must be a multiple of 10e6 (it throws otherwise, despite the docstring saying "rounded") and ≤ 20% of total. Funds += n·(price + newPrice)/2. `newPrice` uses ownership after dilution but the **old** total in the denominator, so it is overstated by up to 1.2×. The price is set to `newPrice`. Cooldown 72e3·total/1e9 game cycles (4 h × total/1e9). Of the new shares, randInt(0, n/2·investor fraction) (rounded to 10e6) go to investors and the rest are issued | `C/Act:161-188`, `C/hlp:119-131`, `C/Corp:276-280` |
| Dividends | `issueDividends(r∈[0,1])`, public only. Paid at START when cycle profit > 0. Corp loses r·profit·10. Player gets `(own/total · r·profit·10)^(1−τ)` per cycle | `C/Corp:162-171,189-196` |
| Tribute τ | `1.15 − CorporationSoftcap`, fixed at creation. −0.05 with Shady Accounting, −0.10 with Gov Partnership. In BN3 with both unlocks τ ≈ 0, so dividends are linear | `C/Corp:54` |
| Bribe | Requires valuation ≥ 100e12 (after the BN multiplier). Corp funds → faction rep at 1e9 per rep, added directly. The faction must offer work and you must be a member | `C/Act:633-675`, `C/data/Constants.ts:61-62` |
| Hashes | "Sell for Corporation Funds" gives +1e9 corp funds per level. Cost is 100 × the level being bought, rising with each purchase. Valuation-neutral except for the funds term | `Hacknet/HacknetHelpers.tsx:474-480` |
| Sell division | Refunds `recoupable`. Its stock is lost. Exports pointing to it are removed | `C/Act:98-119` |
| Divisions cap | `20 × CorporationDivisions` (not floored) | `C/Corp:38` |

**Money paths to the player:** share sales and dividends are the only routes. Corp funds can also become faction reputation via bribes. Nothing transfers corp funds to player money directly.

---

## 11. BitNode multipliers

Fields (`BitNode/BitNodeMultipliers.ts:42-49`):
- `CorporationValuation` scales valuation, which drives offers, share price, IPO and issuance proceeds, and the bribe threshold.
- `CorporationSoftcap` sets the tribute. It affects dividends only. Below 0.15, corp creation is disabled.
- `CorporationDivisions` caps the number of divisions.

**Operating profit is never scaled by any BN multiplier.** A low valuation multiplier slows the bootstrap through smaller offers and scales down share-sale extraction. The production and sales engine itself is BN-independent.

| BN | Valuation | Softcap → τ (→ with both unlocks) | Max divisions | Cite (`BitNode/BitNode.tsx`) |
|---|---|---|---|---|
| 1, 3, 4 | 1 | 1 → .15 (→0) | 20 | defaults |
| 2 | 1 | .9 → .25 (.10) | 18 | 590-591 |
| 5 | 0.75 | 1 → .15 (0) | 15 | 681-682 |
| 6, 7 | 0.2 | .9 → .25 (.10) | 16 | 713-715, 752-754 |
| 8 | 0 | 0 → **disabled** | 0 | 786-788 |
| 9 | 0.5 | .75 → .40 (.25) | 16 | 826-828 |
| 10 | 0.5 | .9 → .25 (.10) | 18 | 872-874 |
| 11 | 0.1 | .9 → .25 (.10) | 18 | 915-917 |
| 12 | 1/1.02^lvl | .8 → .35 (.20) | 10 | 925-926, 980-982 |
| 13 | **0.001** | .4 → .75 (.60) | 8 | 1027-1029 |
| 14 | 0.4 | .9 → .25 (.10) | 16 | 1072-1074 |
| 15 | 0.2 | .4 → .75 (.60) | 8 | 1106-1108 |

The corp is strong in BN1–5 (BN5 at 0.75), middling in BN9, BN10, BN12 (low levels), and BN14, weak in BN6, BN7, BN11, and BN15, nearly useless in BN13, and off in BN8. Outside BN3, seed money is not allowed (150e9 player money), and below SF3.3 the two API unlocks cost 100e9 of the starting 150e9.

---

## 12. Where randomness enters

| Source | Distribution | Cite |
|---|---|---|
| Hire stats (int/cha/cre/eff/morale/energy) and +XP | randInt(50,100) each | `C/Off:181-193` |
| Energy/morale flat decay | 0.002·U per cycle | `C/Off:94,102` |
| Material price, demand, competition | §8 random walk | `C/Material.ts:93-128` |
| Product demand/competition drift | randInt(0,3)·0.0004 (×3 for Pharma/Software/Robotics) | `C/Div:245` |
| New product competition | randInt(0,70) | `C/Product.ts:205` |
| Advert popularity | ×(1 + randInt(1,3)/200) | `C/Div:984` |
| Share price drift | ×(1 ± U·0.01) | `C/Corp:267-269` |
| Private share take on issuance | randInt(0, max) | `C/Act:178` |

Everything else is deterministic: production, quality, rating, markup, valuation, offers, and share-sale batches.

---

## 13. Doc/code discrepancies and 3.0.2 notes

- In-game docs say long-term funds sources do `totalAssets += amt`. In 3.0.1 the code does `+= Math.abs(amt)` (§10.2).
- The `issueNewShares` docstring says the amount is "rounded to nearest 10M". The code throws unless n is a multiple of 10e6 (`C/hlp:121`).
- **3.0.2 (dev branch)**: popularity decay is removed. `eval` of sell, price, and export strings is replaced by a restricted expression parser (`+ - * /` and parentheses, with the same placeholders). A production limit of 0 now skips output blending. Internal `maxSellPerCycle`/`maxSellAmount` fields are removed. Save loading sanitizes NaN assets and effective ratings. Apart from these, no formula, constant, or API/RAM changes were found in `Corporation/`, `NetscriptFunctions/Corporation.ts`, or the RAM table; the NS changes are a refactor only.

---

## 14. Implications for automation

### 14.1 Architecture

- Each 10 GB / 20 GB per function adds up to about 960 GB for the full API (§1). Run a **thin orchestrator** that uses the 0 GB functions (`nextUpdate`, `getBonusTime`, `getConstants`), and dispatch to per-phase or per-function worker scripts. Cache static data from `getConstants()`, `getIndustryData()`, and `getMaterialData()`.
- Synchronize on `nextUpdate()`. Do purchases and boost changes **before PURCHASE** (after START returns), set job changes before START, and read sales **after SALE**.
- Avoid tea and parties until offices reach 9 employees. After that, either keep at least 1/9 interns, buy tea and parties each cycle, or buy AutoBrew and AutoPartyManager (27k RP) so the bot has no morale loop to manage.
- Error handling differs by call, so check state after each one.
  - **Silent no-ops** when funds are short: `upgradeOfficeSize`, `purchaseWarehouse`, `upgradeWarehouse`, and `hireAdVert` (`C/Act:396-457`). `throwParty` and `buyTea` return 0/false instead.
  - **Throw** on failure: `expandCity`, `expandIndustry`, `levelUpgrade`, `purchaseUnlock`, `makeProduct`, and `research` (when the parent research is missing or RP is short).
  - `research` on an unknown node returns silently (`C/Act:508-510`).
- Build a deterministic simulator from §§4–10. The only stochastic parts are market walks and hiring (§12). Use it to drive both the boost/office optimizer and the round-acceptance policy.

### 14.2 Investment-round strategy (sketch derived from the mechanics; validate in the simulator)

1. **Creation.** In BN3, use seed money: it is free, but costs 1/3 equity permanently. Elsewhere you need 150e9 of player money. Reaching **SF3.3 first** makes off-BN3 corps viable, because otherwise the APIs eat 100e9 of the 150e9 starting funds.
2. **Round 1.** Start with **Agriculture**: highest RE factor (.72) on the smallest boost material (.005), two outputs per input set, and cheap inputs.
   - Expand to all 6 cities with warehouses. This makes the production multiplier ×6 and adds 12 facilities, for valuation ×1.1.
   - Buy **≥1 Advert**. Zero ads means a ratio of 0.01 and roughly 20× fewer sales (§7.3).
   - Spend on Smart Storage and warehouse levels, then fill space with boosts using §5.2's money-and-space-constrained optimizer.
   - Use small offices weighted toward Ops/Eng, with some R&D early for quality.
   - **Valuation only measures asset growth.** Unsold output is counted at market price, so during the 10-cycle window production (and warehouse headroom) matters more than sales capacity.
3. **Before accepting any round:**
   - Do all long-term capex (upgrades, unlocks, office and warehouse size, product investments) **immediately after the previous acceptance**, because each counts −2X in its cycle (§10.2).
   - Then run at least 10 clean cycles at peak production so the 10-entry average holds no zero or penalized entries.
   - Accept at a local maximum of `getInvestmentOffer()`. Expansion (offices, warehouses, divisions) costs only −X/2.
4. **Round 2.** Buy Export, add Chemical (high Sci .75) as a Plants↔Chemicals quality loop, and keep upgrading Agriculture production. Accept round 2 (0.7V; still 55% owned self-funded).
5. **Round 3+.** Add **Tobacco**, the product industry: one input (Plants) from Agriculture, Sci .75, Adv .2, starting cost 20e9.
   - Develop products continuously in a large main office.
   - Hold RP unspent until each product finishes: `sciMult` uses the pool.
   - Give Business and Management a meaningful share during development, since the markup limit is linear in it.
   - Feed high-quality Plants (≈ sqrt(rating)).
   - Buy Wilson before Ads, then Ads.
   - Implement the custom `max(TA1, TA2)` pricing yourself rather than spending 70k RP on the TA research.
6. **Rounds 3 and 4 versus IPO.** Investors pay `mult × V_private` per 100% of the company: 3, 2, 2, and 1.5. The public market pays `(0.5+√o) × V_public`, which is ≤ 1.5 V, and V_public weights profit at 85e3 instead of 315e3. **Investors are therefore always the cheaper funding**, and the real cost of a round is equity: round 4 takes 2/3 of your remaining 30%. Accept round 3. Accept round 4 only if the simulator says the time saved beats losing 67% of future share-sale proceeds.
7. **Dummy divisions for valuation.** Restaurant costs 10e9 (+2 facilities), plus 5 offices at 4e9 and 5 warehouses at 5e9: 55e9 buys ×1.1 valuation. That applies to offers **and** post-IPO share price, and the effect compounds up to the division cap (1.1^20 ≈ 6.7× in BN3). There are no running costs if nobody is hired.

### 14.3 Turning the corp into player progress

- **Reputation:** once valuation reaches 1e14, bribe factions with corp funds (1e9 per rep). There is no equity loss and no tribute, so this is the cheapest route to aug rep (and Red Pill rep) in BN3, where rep costs are ×3.
- **Money:** go public with `goPublic(0)` (or with some shares if the corp needs funds), then `sellShares` once per cooldown. One hour real time, or 6 minutes on bonus time.
  - Proceeds ≈ `V·Δ(0.5o + (2/3)o^1.5)` (§10.5). They bypass both tribute and BN money multipliers.
  - Sell after valuation jumps: the in-sale batch walk lifts a lagging price toward the target at +0.5% per 1e6 shares.
- **Dividends:** worthwhile only after Shady Accounting and Gov Partnership (2.0005e15 total) bring τ to 0 in BN3. Before that the per-cycle power `^(1−τ)` crushes large payouts. Selling a fraction f of the shares returns roughly 85e3·f·(0.5+√o) seconds of total profit at once, versus `f·profit` per second from dividends. Dividends overtake only on runs that last more than about a day after the IPO, and they also depress valuation by (1−r)².
- **Off-BN3:** the same engine works anywhere the corp is enabled. Prioritize it in BN1, BN2, BN4, and BN5. In BN6, BN7, BN11, BN13, and BN15 it is a slow bootstrap (offers at ×0.2 down to ×0.001) and is probably not worth it unless the run is long.

### 14.4 Leverage points (ranked by the formulas)

1. The production multiplier from boosts across 6 cities (§5.2).
2. The first Advert, then Wilson-scaled ads (the advertFactor ratio floor).
3. RP pool and engineer production. These drive material quality and `sciMult`, and through `effRating^1.325` they drive product revenue.
4. Product markup limit: linear in effRating, advMult, q^0.65, and the (bus+mgmt) share.
5. Valuation-window hygiene (§10.2), plus dummy divisions.
6. More product slots, since each product gets the full production rate.

### 14.5 Exploitable quirks

- The `|amt|` long-term accounting (−2X): schedule capex right after accepting an offer.
- Unsold products count at 5× input cost in total assets, and materials at their market price. That inflates assetDelta when sales are capped.
- The share-sale batch bug (`C/Corp:302-321`). If `shareSalesUntilPriceUpdate` is u < 1e6, a sale of n with u ≤ n < 1e6 is **paid for 1e6 shares**. Selling 999,999 shares sets u = 1; the next sale of 1 share then pays 1e6 × price. Each two cooldowns therefore earns about 1e6 free shares' worth (small next to the ~1e9 shares outstanding).
- `issueNewShares` uses the old total as the denominator, which inflates `newPrice` and the funds raised by up to about 10%. The share price is then set to that inflated `newPrice` and decays about 0.5% per cycle afterward.
- Research inherits across divisions of the same industry, even after you sell and recreate the division.
- `buyMaterial` has no funds check. Running into debt only affects morale, and only when the division is also unprofitable.
- Market prices are independent unbounded random walks per (division, city). Buy boosts and inputs where they are cheapest and Export them, and sell materials where MP is highest. The effect grows with run length.
- `max(TA1, TA2)` beats the built-in TA2 when demand-limited.
- Only the first unfinished product develops (insertion order), so never queue two.
- Bonus time speeds up the corp and its share-sale and share-issue cooldowns by 10×.

### 14.6 Open questions

- Is the `Math.abs` in `gainFunds` an intended "capex penalty" or a bug? It is identical in dev 3.0.2, so treat it as stable behavior.
- Optimal office job splits (for raw production, product progress, profit, and markup) need numeric optimization against the full formulas, because no closed form exists.
- When exactly to IPO, and whether to take round 4, depends on run length and how much player money and rep are needed. This needs simulation per BN.
- Whether the player's charisma or other stats affect the corp: no reference was found in `Corporation/`. Player stats do not affect it.
- Steam v3.0.1 is assumed to match `vendor/bitburner-src` exactly. A one-time in-game check of a few constants via `getConstants()` is advisable.
