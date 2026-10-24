# Dark Net / BN15 "The Secrets of the Dark Net" / SF15 / `ns.dnet`: mechanics reference (Bitburner v3.0.1)

Source: `vendor/bitburner-src` (Steam v3.0.1). All `file:line` refs are relative to `vendor/bitburner-src/src/`.
"Cycle" = one engine tick = 200 ms (`CONSTANTS.MilliPerCycle`, `Constants.ts:19`). `rand()` = `Math.random()` in [0,1).
A "Changes in 3.0.2" section at the end summarizes the unreleased dev-branch (`bitburner-src`) differences.

---

## 1. What the Dark Net is, access, and generation

The Dark Net is a second server network layered under the normal game network. The legacy `darkweb` server is converted into a stationary `DarknetServer` that is the root (depth −1 / "row 0 above") and the only bridge to `home`. All other darknet servers are `DarknetServer` instances with a **password**, a **modelId** (puzzle type), **blockedRam**, **difficulty**, grid **depth/leftOffset**, and **requiredCharismaSkill**. They do **not** appear in `ns.scan` (filtered out, `NetscriptFunctions.ts:188`), do not use the hacking skill, and cannot be NUKE'd. You crack them by guessing passwords.

### 1.1 Access gates

| Gate | Condition | Source |
|---|---|---|
| `hasDarknetAccess()` (unlocks `ns.dnet` API + DarkNet UI + darknet population + engine processing) | `canAccessBitNodeFeature(15)` (in BN15, or active SF15 ≥1) **OR** player owns `DarkscapeNavigator.exe` | `utils/darknetAuthUtils.ts:6-8`, `BitNode/BitNodeUtils.ts:17-19` |
| `hasFullDarknetAccess()` (unlocks labyrinth, SF15-only puzzle models, offline-hostname reuse) | `Player.bitNodeN === 15` **OR** `Player.activeSourceFileLvl(15) > 0` | `effects/effects.ts:280` |
| Buy `DarkscapeNavigator.exe` | `buy DarkscapeNavigator.exe` in terminal after TOR router: **$50m** (`DarknetConstants.DarkscapeNavigatorPrice`). Or Chongqing "Shadowed Walkway" special location: **$30m** (`DarkscapeNavigatorDiscountedPrice`). | `Constants.ts:5-8`, `DarkWeb/DarkWebItems.ts:15-18`, `Locations/ui/SpecialLocation.tsx:342-390` |
| SF15 auto-grant | In BN15 (and permanently with SF15≥1), you start with TOR + `DarkscapeNavigator.exe` after every prestige. | `Prestige.ts:101,243` (`getDarkscapeNavigator()`), `effects/effects.ts:264-273` |

Buying the navigator / calling `getDarkscapeNavigator()` ensures TOR, pushes `darkscape` program onto home, and calls `populateDarknet()`. In BN15 the `darknet-handbook.lit` is auto-added to home and shown on first entry (`Prestige.ts:355-360`).

Difference between "has access" and "full access": with just the `.exe` on a non-SF15 BitNode you get the whole net **except** the labyrinth/lab-aug chain and the two SF15-only tier-3 puzzle models (KingOfTheHill, SpiceLevel). Mutation also runs at **half speed** on non-BN15 (`darknetNetworkUtils.ts:12`, `rateMultiplier = Player.bitNodeN !== 15 ? 2 : 1`).

### 1.2 Network topology and grid

Constants (`DarkNet/Enums.ts:4-11`, `DarkNet/Constants.ts`):

| Const | Value | Meaning |
|---|---|---|
| `NET_WIDTH` | 8 | columns (`leftOffset` 0..7) |
| `MAX_NET_DEPTH` | 40 | max rows in `DarknetState.Network` |
| `AIR_GAP_DEPTH` | 8 | every row `x` with `x>0 && x%8===0` is an impassable air gap (no servers placed there) |
| `HORIZONTAL_CONNECTION_CHANCE` | 0.5 | base chance of connecting to a same-row neighbor |
| `VERTICAL_CONNECTION_CHANCE` | 0.3 | base chance of connecting to a server one row up/down |
| `SERVER_DENSITY` | 0.6 | target movable-server count = `netDepth * 8 * 0.6` |
| `LOW_LEVEL_SERVER_DENSITY` | 0.7 | min fraction of first-4-rows slots that should be filled |
| `MS_PER_MUTATION_PER_ROW` | 30000 | base mutation cadence per net row |
| `MAX_PASSWORD_LENGTH` | 50 | cap |

`DarknetState.Network` is a `40 × 8` grid of `DarknetServer | null` (`models/DarknetState.ts:40`). `depth` = row index (0 = directly under darkweb), `leftOffset` = column. The grid is **not a tree**: it has loops, backtracks, and disconnected islands (`getIslands()` = movable servers with 0 connections). "Air gaps" at rows 8,16,24,32 can only be crossed by riding a server that migrates across them.

Effective net depth = `getNetDepth()` = current labyrinth's `depth` (`labyrinth.ts:393-396`), which grows as you clear labs (7→12→19→23→29→31→36). Before full access it's 5. So the reachable net deepens as you progress through the lab chain.

### 1.3 Connection rules during generation (`controllers/NetworkGenerator.ts`)

`populateDarknet()` (`NetworkGenerator.ts:91-111`): if movable servers already exist, `loadDarknet()`; else clear, add labyrinth, add `getNetDepth()*8*0.6 - 10` random servers, pad rows 0 and 1 to ≥5 servers, `balanceDarknetServers()`, then add `getNetDepth()` guaranteed connections.

`addRandomConnections(server)` (`:178-201`): for a server at `(x=depth, y=leftOffset)`:
- Lateral: each existing same-row neighbor (y±1) connects with prob `0.5 * (1.1 - depth*0.01)`.
- Vertical: each server one row above/below (within |Δcol|≤1 via `close` filter) connects with prob `0.3*(1.1-depth*0.01)/distance`.

`addGuaranteedConnection(server)` (`NetworkMovement.ts:323-334`): always connects to one random adjacent neighbor so no server floats (labyrinth servers excepted). Servers at depth 0 are force-connected to `darkweb` (`:219-224`); servers at `netDepth-1` connect to the labyrinth (`:225-231`).

`probe()` returns **shuffled** neighbor hostnames (via lodash `shuffle`) — deliberately order-randomized so topology can't be inferred from order (`NetscriptFunctions/Darknet.ts:331-333`).

### 1.4 Server stats (`models/DarknetServerOptions.ts:62-97`, `DnetServerBuilder`)

- `maxRam = getMaxRam(difficulty)` = `roundToTwo(max(16 * 2^floor(difficulty/6) * mutation, 16))`, mutation ∈ `[0.5,1,1,1.15,1.4]` uniformly (`:206-211`). → lots of RAM deep in the net (difficulty 24 → base 256 GB).
- `blockedRam = getRamBlock(maxRam)` unless `preventBlockedRam` (`ramblock.ts:97-110`): 16→`[0,1,2]` (index 0-1 only, i.e. 0 or 1), ≤32→`[0,2,4]` (0 or 2), ≤64→`[16,32,maxRam-8]`, else `[maxRam, maxRam-8, maxRam-64, maxRam/2]`. `ramUsed` starts = `blockedRam`.
- `logTrafficInterval = 1 + 30*0.9^difficulty` seconds — low-difficulty servers spam logs (~31 s), deep servers ~1 s. Labyrinth = `Number.MAX_SAFE_INTEGER` (no noise).
- `requiredCharismaSkill` (`:67-73`): `depthScaling = depth<2 ? depth*10 : (depth/labDepth)^1.5 * labCha * 0.85`; `levelVariance = (rand()*3-1)*depth`; `required = max(floor(depthScaling+levelVariance), 1)`. Here `depth` means `difficulty`. Used by heartbleed gate and slows authentication when under it.
- `difficulty` is the server's assigned level = roughly its spawn depth; drives puzzle selection, password length, RAM, cha requirement, XP, money.

### 1.5 Server naming (`models/DarknetServerOptions.ts:99-204`)

`generateDarknetServerName()`: 3% chance (only with full access, with offline set non-empty) to **reuse an offline hostname**; else `decorateName(getBaseName())`. Base names: 5% common-password word, 20% `loreNames` (faction/location names, lowercased, invalid chars→`_`), 30% `presetNames`, else `prefix+connector+suffix`. Decoration loops with l33t substitution (`a→4,e→3,i→1,l→1,o→0,s→5,t→7,b→🅱️`), 5% reverse, suffix/prefix adds, 5% `:NNNN` suffix, until unique. IPs are random and unique.

### 1.6 Server types the API encounters (from `Darknet.test.ts`)

`ns.dnet.*` methods behave differently by target class:
- **DarknetServer** (incl. darkweb): full behavior.
- **Normal / purchased / hacknet server / non-existent**: most methods throw `"X is not a darknet server"`, except `isDarknetServer` (false), `getBlockedRam`/`getDepth` return 0/−1 on offline, and the offline-tolerant path returns `ServiceUnavailable` for recently-offline darknet hosts (no throw).
- **darkweb** special-cases: always `hasAdminRights=true`; you're always authed to it and to your own script's server (`offlineServerHandling.ts:98-101`).

---

## 2. The engine loop, mutation, and instability

### 2.1 Processing (`controllers/NetworkMovement.ts:28-43`, `engine.tsx:123-126`)

Each engine cycle, if `hasDarknetAccess()`, `processDarknet(numCycles)` runs. It stores cycles, then if `storedCycles ≥ MinCyclesToProcess(1)`, processes `min(stored, MaxCyclesToProcess=3)`. When `cyclesSinceLastMutation > cyclesPerMutation`, resets counter and calls `mutateDarknet()`.

`cyclesPerMutation = getDarknetCyclesPerMutation()` = `(rateMult * (30000/200)) / netDepth` where `rateMult = 2` off-BN15 else `1` (`darknetNetworkUtils.ts:9-14`). On BN15 with netDepth 7 → `150/7 ≈ 21.4` cycles ≈ **4.3 s between mutation attempts**; deeper nets mutate faster.

Bonus/offline time: `storeDarknetCycles` accumulates offline cycles (`engine.tsx:336`). `hasDarknetBonusTime()` = `storedCycles > cyclesPerMutation*2` (`DarknetState.ts:163`) → multiplies cache money ×1.3, phishing money ×1.3, cha-xp ×1.5 (`cacheFiles.ts`/`phishing.ts`/`effects.ts:119`).

### 2.2 `mutateDarknet()` (`NetworkMovement.ts:45-134`) — the per-attempt random mutation

Guards: skipped if `mutationLock` set (webstorm in progress). Early-out `if (rand() > 16/netDepth)` → deeper nets mutate more often. Then a sequence of independent `rand()` gates (each may `return` early):
- 30%: move a random island server.
- 30%: `addLowLevelServersIfNeeded()`.
- 10%: delete `rand()*3+1` servers (**return**).
- 10%: add `rand()*3+1` servers (**return**).
- 10%: restart a random backdoored server (**return**).
- 5%: delete a random backdoored server (**return**).
- 20%: restart a random server.
- 30%: move 3 random servers.
- 50%: add connections to a random server (**return**).
- 50%: unlink all connections from a random server.
- 10%: `balanceDarknetServers()`.

`isImmutable(server)` (`:227-228`): a server that is `DarknetState.openServer` (open in UI), `isConnectedTo` (terminal is connected to it), or `hasStasisLink` — **cannot be moved, deleted, disconnected, or restarted**. This is the anchor for stability.

Effects of mutations on your scripts:
- **Move** (`moveDarknetServer`): disconnect, pick a new open position within `±3` rows of its difficulty, reconnect. Scripts survive but connections change.
- **Delete / go offline** (`deleteDarknetServer`): kills all scripts on it ("Server shut down."), adds its hostname+IP to `offlineServers`, deletes it. May come back later with same name, new password, cleaned.
- **Restart** (`restartServer`): kills scripts ("Server restarted."), clears backdoor, re-links. Server + password persist.

### 2.3 Webstorm (`effects/webstorm.ts`, `STORM_SEED.exe`)

A catastrophic scripted event. `STORM_SEED.exe` can spawn on a server after you clear all of its blocked RAM (15% chance if >30 min since last storm and no storm file already present, `ramblock.ts:50-66`). Running it (`ns.dnet.unleashStormSeed()` from a script on that server, or UI `run`) calls `launchWebstorm()`: sets `mutationLock` (freezes normal mutation), after 5 s deletes ~60% of servers + moves ~60% of the rest + restarts **all** movable servers, then over ~16 s adds `8, 16, 16` servers and rebalances. Extremely destructive; achievement `CHALLENGE_BN15` requires finishing BN15 **without calling heartbleed** (unrelated but tracked via `DarknetState.hasUsedHeartbleed`).

### 2.4 Instability / backdoor penalty (`offlineServerHandling.ts:151-154`, `effects.ts:92-99`)

Having too many backdoored darknet servers destabilizes the net:
- `getTimeoutChance()` = `clamp((backdooredCount − 2) * 0.03, 0, 0.5)`. The first 2 backdoors are free; each beyond adds 3% to the chance an `authenticate` call times out (`RequestTimeOut`, no result). (stasis-linked servers are excluded from the backdoor count in stable since `getBackdooredDarknetServers` filters `!hasStasisLink`.)
- `getBackdoorAuthTimeDebuff()` = `1.07^backdoorSurplus` where `surplus = max(0, backdooredCount − max(adminServerCount/24, 2))`. Multiplies all auth times.
- `ns.dnet.getDarknetInstability()` exposes `{authenticationDurationMultiplier, authenticationTimeoutChance}` (0 GB).

Backdoors (installed via terminal `backdoor` or `ns.singularity.installBackdoor()` after admin rights) let you `connect`/`exec` to a darknet server remotely; a **stasis link** sets a backdoor and does **not** count toward instability. So prefer stasis links over mass backdooring.

---

## 3. Authentication, passwords, and solvers

### 3.1 The authentication call path

`ns.dnet.authenticate(host, password, additionalMsec?)` → `Promise<DarknetResult & {data?}>` (`NetscriptFunctions/Darknet.ts:93-178`, 0.4 GB):
1. Validate; password length ≤ `MAX_PASSWORD_LENGTH*2`=100 else throw.
2. `checkDarknetServer(..., requireDirectConnection:true)` — must be a directly-connected darknet server.
3. `networkDelay = calculateAuthenticationTime(server, Player, threads, sharedChars) + additionalMsec`. `sharedChars = getSharedChars(password, serverPassword)` = count of leading characters that match.
4. `await netscriptDelay(networkDelay)` (real wall-clock delay via setTimeout).
5. Re-check connection; `if (rand() < getTimeoutChance()) → RequestTimeOut`.
6. `getAuthResult` → `checkPassword` → success grants admin + session + XP + chance of cache.

Auth time (`effects.ts:60-90`, `calculateAuthenticationTime`):
```
baseDiff      = (difficulty+1)*100
skillFactor   = (5*chaReq + baseDiff) / (charisma + 150)
threadsFactor = 1 / (1 + 0.2*(threads-1))        // diminishing (linear=false)
backdoorFactor= 1.07^backdoorSurplus
underlev      = (charisma<=chaReq && depth>1) ? 1.5+(chaReq+50)/(charisma+50) : 1
bootsFactor   = hasAug(TheBoots) ? 0.8 : 1
sf15_2Factor  = activeSF15 > 2 ? 0.8 : 1          // NOTE stable: >2 (i.e. level 3); dev fixes to >=2
time = 850 * skillFactor * backdoorFactor * underlev * bootsFactor * sf15_2Factor * threadsFactor
time = time * calculateIntelligenceBonus(int,0.25) + sharedChars*50*threadsFactor   // TimingAttack adds the 2nd term
```
`calculateIntelligenceBonus(int,0.25) = 1 + 0.25*int^0.8/600` (`PersonObjects/formulas/intelligence.ts`). Stable multiplies time **by** the int bonus (so higher int makes it *slower* — a known bug; dev divides instead). More threads and more charisma = faster. Exposed by `ns.formulas.dnet.getAuthenticateTime(details, threads, player, correctChars)` (0 GB, requires Formulas.exe).

`getSharedChars` (`darknetAuthUtils.ts:27-34`): returns index of first mismatch = number of correct leading chars.

### 3.2 `checkPassword` dispatch (`effects/authentication.ts:19-150`)

If exact `server.password === attempted` → success (every model). Else per-model feedback is produced and returned as a failure `data` string (visible in the returned object `data` field for a few models, and always logged to the server's logs → readable via heartbleed). The dispatch is the key to solvers.

### 3.3 Model catalog and solvers

ModelIds (`Enums.ts:15-41`) map internal keys to player-facing `modelId` strings (shown by `getServerDetails().modelId`). Tier assignment by difficulty (`ServerGenerator.ts:18-62`):
- **diff ≤2**: tier0+tier1
- **diff ≤4**: tier0+tier1(×2)+tier2+tier3
- **diff ≤8**: tier1+tier2+tier3
- **diff ≤18**: tier2+tier3+tier4
- **diff >18**: tier3+tier4

tier0 = NoPassword. tier1 = EchoVuln, DefaultPassword, Captcha. tier2 = DogNames, Yesn_t, BufferOverflow. tier3 = SortedEchoVuln, MastermindHint, RomanNumeral, GuessNumber, ConvertToBase10, DivisibilityTest, PacketSniffer, **(+KingOfTheHill, SpiceLevel only with full access)**. tier4 = LargestPrimeFactor, LargeDictionary, EUCountryDictionary, TimingAttack, BinaryEncoded, ParseArithmetic(MathML), XorMask, TripleModulo.

`getServerDetails()` exposes: `modelId`, `passwordHint` (=`staticPasswordHint`), `data` (=`passwordHintData`), `passwordLength`, `passwordFormat` ("numeric"|"alphabetic"|"alphanumeric"|"ASCII"|"unicode"), `difficulty`, `requiredCharismaSkill`, `depth`, `logTrafficInterval`, `isStationary`, `blockedRam`, `hasSession`, `isConnectedToCurrentServer`, `isOnline`. The `modelId` string is the discriminator for all solvers below.

**Password generation** `getPassword(length, allowLetters)` (`ServerGenerator.ts:564-579`): random digits (+ a–z A–Z if `allowLetters`), length clamped [1,50]; numeric passwords are `Number(password).toString()` (strip leading zeros, truncate to 15 digits if > MAX_SAFE_INTEGER). So numeric passwords have no leading zeros.

| modelId (`modelId` string) | Key / tier | Password gen | Hint exposed | Solver |
|---|---|---|---|---|
| `ZeroLogon` (NoPassword) | t0 | `""` | "no password set"-type text | Submit `""`. |
| `DeskMemo_3.1` (EchoVuln) | t1 | 3 digits | `staticPasswordHint` = "The password is `<pw>`" (contains plaintext) | Extract trailing token from `passwordHint`. |
| `FreshInstall_1.0` (DefaultPassword) | t1 | from `defaultSettingsDictionary` = `["admin","password","0000","12345"]` | "default password" text | Try all 4 dictionary entries. |
| `CloudBlare(tm)` (Captcha) | t1 | `getPassword(difficulty/2+3)` digits; `passwordHintData` = password with 1–3 random `filler` chars (`/[]╬╸.-()*~:;><#\`) inserted after each char except last | "Type the numbers to prove you are human"; `data` = the filled string | Strip non-digits from `data`: `data.split("").filter(c=>!isNaN(+c)).join("")`. |
| `Laika4` (DogNames) | t2 | from `["fido","spot","rover","max"]` | "my dog's name" | Try all 4. |
| `NIL` (Yesn_t) | t2 | `getPassword(3+diff/2, diff>8)` | "you are one who's'nt authorized"; per-attempt `data` = CSV of "yes"/"yesn't" per position (yes = char matches that index) | Oracle: brute each position independently. For each index i and each candidate char, submit a probe and read which positions flip to "yes". Reconstruct char by char. |
| `Pr0verFl0` (BufferOverflow) | t2 | `getPassword(4+rand()*4 len, alphanumeric)` | `staticPasswordHint` = "Warning: password buffer is N bytes" (N = password length) | **Submit any string of length ≥ 2*N** (e.g. `"A".repeat(2N)`). The overflow makes received buffer == expected buffer → success. N is in the hint. |
| `DeepGreen` (MastermindHint) | t3 | `getPassword(len, alphanumeric)`, len≈`min((alnum?-1:2)+diff/5,10)`; alnum if diff>16 & 30% | "Only a true master may pass"; per-attempt `data` = `"exact,misplaced"` (Mastermind/Wordle counts) | Mastermind solver using exact+misplaced counts (`getMastermindResponse`). Charset = digits (or digits+letters). Standard constraint-propagation / minimax guessing. |
| `2G_cellular` (TimingAttack) | t4 | `getPassword(len, alnum)`, len≈`min((alnum?0:3)+diff/4,8)` | per-attempt `data`="Response time: Nms"; message "Found a mismatch...(i)" where i = index of first mismatch | Side-channel: auth time increases by `50ms*threadsFactor` per correct **leading** char (`sharedChars`). Measure response time (or read the "(i)" index in logs) to learn how many leading chars are right; greedily extend the prefix char by char. |
| `PrimeTime 2` (LargestPrimeFactor) | t4 | password = a prime from `largePrimes` (83 values 1069..9859); `passwordHintData`/target = that prime × `1 + min(5,floor(diff/3))` small primes | "largest prime factor of `<target>`"; `data` = target number | Factor target; largest prime factor = password. (Or: `largePrimes.filter(p=>target%p==0).sort().last`.) |
| `AccountsManager_4.2` (GuessNumber) | t3 | `floor(rand()*10*(diff+3)/3)` | "number between 0 and 10^len"; per-attempt `data` = "Higher"/"Lower" | Binary search on [0, 10^passwordLength]; "Higher" = password > guess. |
| `TopPass` (CommonPasswordDictionary) | t4 | from `commonPasswordDictionary` (93 entries, `dictionaryData.ts:61-155`) | "It's a common password" | Try all 93 (ordered by passwordLength/format filter from `getServerDetails` to prune). |
| `EuroZone Free` (EUCountryDictionary) | t4 | from `EUCountries` (27 names) | "My favorite EU country" | Try all 27. |
| `BellaCuore` (RomanNumeral) | t3 | integer `floor(rand()*10*10*(diff+1))`; diff<8 → `data` = roman string; diff≥8 → `data` = "`min`,`max`" roman range | "value of roman `<X>`" or "between min and max"; per-attempt `data`="ALTUS NIMIS"(too high)/"PARUM BREVIS"(too low) | diff<8: `romanNumeralDecoder(data)` (`ServerGenerator.ts:628-656`). diff≥8: decode min/max, binary-search using the high/low oracle. |
| `OctantVoxel` (ConvertToBase10) | t3 | integer `ceil(rand()*99*(diff+1))`; encoded in base ∈[2..16]\{10}; diff>12 adds a fractional base (e.g. 5.5) | "base N number `<X>` in base 10"; `data` = "`base`,`encoded`" | `parseBaseNNumberString(encoded, base)` (`ServerGenerator.ts:438-456`) handles fractional bases; integer bases also `parseInt(encoded, base)`. Success via `isCloseToCorrectPassword` (tolerates float error). |
| `MathML` (parsedExpression) | t4 | expression evaluated = password; diff>12 replaces `* / + -` with unicode `ҳ ÷ ➕ ➖`; diff>16 (30%) or 1% chance appends a **code-injection** string; diff>20 (30%) may prefix `(ns.exit(),` into a paren | "evaluate this expression"; `data` = the expression | `parseSimpleArithmeticExpression(data)` (`ServerGenerator.ts:459-513`) — a safe custom parser (handles parens, precedence, unicode ops via `cleanArithmeticExpression`, and strips the injection via `.split(",")[0]` + `ns.exit(),`-removal). **Never `eval()` the expression** — the generator plants a string that opens the dev menu / alerts if you do. Submit the numeric result; `isCloseToCorrectPassword` tolerates float error. |
| `Factori-Os` (divisibilityTest) | t3 | `getPasswordMadeUpOfPrimesProduct(diff)` — product of small/large primes (`ServerGenerator.ts:685-706`) | "divisible by 1 ;)"; per-attempt `data` = "true"/"false" (is password divisible by your guess) | Divisibility oracle: trial-divide. For each candidate divisor d, submit d; "true" means d | password. Recover the prime factorization, multiply back to the password. (passwordLength known.) |
| `BigMo%od` (tripleModulo) | t4 | `getPassword(3+diff/5)` digits | "(password % n) % (n % 32)"; per-attempt `data` = `(pw % guess) % ((guess-1)%32 + 1)` | Modular oracle. Query residues for cleverly chosen moduli and CRT / search; passwordLength bounds the search. In practice: for guess g just below pw you get `pw%g = pw-g`; binary-search region then use residues. Nontrivial but deterministic. |
| `KingOfTheHill` (globalMaxima) | t3, **full-access only** | `getPassword(min(1+diff/6,10))` digits | "Ascend the highest mountain!"; per-attempt `data` = altitude (meters), peak 10000 | Hill-climb. `getKingOfTheHillAltitude` (`authentication.ts:215-243`) is a sum of Gaussian hills seeded by `WHRNG(password)`; the true password is the global max (10000 m) and within 3% only the main hill is scored. Gradient-ascend / sample toward higher altitude; near password it's a clean single Gaussian of width `10^max(len-2,0)+1`. |
| `RateMyPix.Auth` (SpiceLevel) | t3, **full-access only** | `getPassword(3+diff/3, diff>8)` | "!!🌶️!!"; per-attempt `data` = `🌶️`×(#exact-position chars) + "/" + len | Per-position correctness oracle (like SpiceLevel = count of exact positional matches). Brute each position: vary index i, count peppers; when pepper count rises you found char i. |
| `OpenWebAccessPoint` (packetSniffer) | t3 | `getPassword(3+rand()*6, diff>8)` | "(I'm busy browsing social media...)"; per-attempt `data` = `capturePackets(server)` — a long noisy string that **contains the plaintext password** (`packetSniffing.ts:16-24`): diff≤16 wrapped as ` hostname:password `, diff>16 bare password inside random data | Parse the packet dump. diff≤16: regex `hostname:(\S+)` or find ` host:pw `. diff>16: harder (bare password in alnum noise) — but logs/heartbleed also leak it. |
| `110100100` (BinaryEncodedFeedback) | t4 | `getPassword(2+diff/5, diff>8)`; `passwordHintData` = each char as 8-bit binary, space-separated | "beep boop"; `data` = binary string | `data.split(" ").map(b=>parseInt(b,2)).map(String.fromCharCode).join("")`. |
| `PHP 5.4` (SortedEchoVuln) | t3 | `getPassword(min(2+diff/7,9))` digits; `passwordHintData` = **sorted** chars of password | "password is shuffled/sorted: `<sorted>`"; per-attempt data appends "; RMS Deviation:X" if len≥5 and attempt length matches | You know the multiset of digits (sorted). Find the permutation. For len≥5 the RMS-deviation oracle (`sqrt(mean((a_i−p_i)^2))`) lets you solve positions: it's an assignment problem — permute the known digits to minimize RMSD to 0. For len<5 it only gives static sorted hint (brute permutations of ≤4 digits, trivial). |
| `OrdoXenos` (encryptedPassword / XorMask) | t4 | `getPassword(3+rand()*3, alnum)`; each char XORed with a random 5-bit mask | `staticPasswordHint` shows the XORed string; `data` = "`xored`;`mask1 mask2 ...`" (masks as 8-bit binary) | `[enc,maskStr]=data.split(";"); mask=maskStr.split(" ").map(b=>parseInt(b,2)); pw = enc.split("").map((c,i)=>String.fromCharCode(c.charCodeAt(0)^mask[i])).join("")`. |
| `(The Labyrinth)` (labyrinth) | special | fixed `!!the:masterwork:of:daedalus<salt>!!` | maze | See §5. |

`isCloseToCorrectPassword(correct, attemptedNumber)` (`authentication.ts:152-164`): accepts if `|diff| < 0.01` OR `diff/correct < 0.005` — used for ConvertToBase10 and MathML so float rounding is OK.

### 3.4 Feedback channels

- **`authenticate` return `data`**: labyrinth only returns `data` in the NS result; for other models the NS result returns only `success/code/message` (generic). So most per-attempt hints are **not** in the direct NS return — you must read them from logs.
- **Server logs** (`models/packetSniffing.ts`): every auth attempt is logged as a `PasswordResponse` with its `data`. Logs also accumulate **noise** every `logTrafficInterval` seconds, which can leak: neighbor passwords (`--pw--`, `Connecting to host:pw`), "chars in right place" hints, common-password lists, etc. `getMostRecentAuthLog(hostname)` returns the latest password-response log.
- **`heartbleed(host, {peek, logsToCapture, additionalMsec})`** (`Darknet.ts:223-291`, 0.6 GB): the way a **script** reads a connected server's logs. Delay = `calculateAuthenticationTime*1.5 + additionalMsec`. Requires `charisma ≥ requiredCharismaSkill` else `NotEnoughCharisma`. Returns `{logs: string[]}` (removes them unless `peek:true`). Sets `DarknetState.hasUsedHeartbleed=true` (forfeits the no-heartbleed achievement).
- **BufferOverflow log quirk**: beyond-length chars overwrite the logged response code; the log stores `passwordAttempted`/`passwordExpected` split (`packetSniffing.ts:97-119`).

### 3.5 UI manual auth (`ui/PasswordPrompt.tsx`)

Clicking a server in the DarkNet UI opens the password prompt. Manual submit counts as **2 threads** (`getAuthResult(server, pw, 2, responseTime)`), waits `500 + sharedChars*150` ms for TimingAttack realism. Feedback (`success/message/code`) shown inline. Labyrinths that are non-`manual` can't be solved in the UI at all ("make your own tools") — you must script them.

---

## 4. The rest of `ns.dnet` — full API table

All require `DarkscapeNavigator.exe`/SF15 access via `expectDarknetAccess` unless noted. RAM from `RamCostGenerator.ts:237-260`.

| Function | RAM (GB) | Sync/Async | Requires | Effect / notes | Source |
|---|---|---|---|---|---|
| `authenticate(host, pw, addMs?)` | 0.4 | async | direct connection | Guess password; success → admin + session (this pid) + XP + cache chance. Delay = auth time. See §3. | `Darknet.ts:93` |
| `connectToSession(host, pw)` | 0.05 | sync | admin rights on target | If `pw` passes `checkPassword`, grants this pid a session **at any distance** (needed for `scp`; `exec` still needs direct/backdoor/stasis). | `Darknet.ts:179` |
| `heartbleed(host, opts?)` | 0.6 | async | direct connection, cha ≥ req | Read/remove latest logs. `{peek,logsToCapture,additionalMsec}`. Delay = authTime×1.5. Sets `hasUsedHeartbleed`. | `Darknet.ts:223` |
| `openCache(filename, suppressToast?)` | 2 | sync | **running on** that darknet server, file present | Consume a `.cache` file → reward (money/stock/program/data/cct/aug). Costs karma = difficulty+1. Returns `{success,message,karmaLoss}`. | `Darknet.ts:292` |
| `probe(returnByIP?)` | 0.2 (`Scan`) | sync | — (works even without TOR? requires access) | Shuffled list of darknet neighbor hostnames of current server. | `Darknet.ts:314` |
| `setStasisLink(shouldLink?)` | 12 | async | on the target server (current) | Apply/remove stasis link on current server. Delay = `(1000/(cha+1000))*30000` ms (~≤30 s). Sets backdoor too. Fails if at limit. | `Darknet.ts:335`, `effects.ts:218-243` |
| `getStasisLinkLimit()` | 0 | sync | access | `1 + (TheBrokenWings?1:0)+(TheHammer?1:0)+(TheStaff?1:0)` → base 1, max 4. | `effects.ts:211-216` |
| `getStasisLinkedServers(returnByIP?)` | 0 | sync | access | Hostnames of all stasis-linked servers. | `Darknet.ts:373` |
| `getServerDetails(host?)` | 0.1 (`GetServer`) | sync | — | Full detail object (§3.3). Offline → dummy with `isOnline:false`. | `Darknet.ts:382` |
| `induceServerMigration(host)` | 4 | async | direct connection, non-stationary, not self | Charge target toward migration; at charge≥1 it moves (`moveDarknetServer(server,2,4)`), charge reset. Delay 6 s (0 in tests). Stacks across scripts targeting same server. | `Darknet.ts:413`, `effects.ts:245-262` |
| `unleashStormSeed()` | 0.1 | sync | `STORM_SEED.exe` on current server | Launch webstorm (§2.3). | `Darknet.ts:475` |
| `isDarknetServer(host?)` | 0.1 | sync | **no access needed** | True if server is a DarknetServer (false if offline/missing). | `Darknet.ts:498` |
| `memoryReallocation(host?)` | 1 | async | direct connection + admin | Free some blockedRam. Delay = `max(8000*(500/(500+cha)),200)`. Reward on full clear: cache + maybe STORM_SEED. | `Darknet.ts:509`, `ramblock.ts:21-66` |
| `getBlockedRam(host?)` | 0 | sync | — | Blocked RAM (0 if offline). | `Darknet.ts:562` |
| `getDepth(host?)` | 0.1 | sync | — | Server depth, −1 if offline. | `Darknet.ts:572` |
| `promoteStock(sym)` | 2 | async | running on darknet server | Increase stock volatility. Delay=`max(8000*(600/(600+cha)),200)`. Adds `threads*((500+cha)/500)` charges. **Stable: no TIX requirement** (dev adds one). | `Darknet.ts:582`, `effects.ts:197-209` |
| `phishingAttack()` | 2 | async | running on darknet server | Money + cha XP + rare cache. Delay=`max(10000*(400/(400+cha)),200)`. See §6. | `Darknet.ts:611`, `phishing.ts` |
| `getDarknetInstability()` | 0 | sync | access | `{authenticationDurationMultiplier, authenticationTimeoutChance}`. | `Darknet.ts:620` |
| `nextMutation()` | 0 (`CycleTiming`) | async | access | Resolves on next net mutation (`DarknetState.nextMutation`). | `Darknet.ts:627` |
| `getServerRequiredCharismaLevel(host)` | 0.1 | sync | — | Required charisma (−1 if offline). | `Darknet.ts:631` |
| `labreport()` | 0 | async | running on darknet server, directly connected to current lab | `{coords, north,east,south,west}` passability around this pid's lab position. Delay = authTime. | `Darknet.ts:641`, §5 |
| `labradar()` | 0 | async | same | `{message}` = 7×7 ASCII view centered on this pid, with `@` (self) and `X` (end). Delay = authTime. | `Darknet.ts:671` |

Formulas API (`ns.formulas.dnet.*`, 0 GB each, needs Formulas.exe): `getAuthenticateTime(details, threads?, player?, correctChars?)`, `getHeartbleedTime(details, threads?, player?)` = authTime×1.5, `getExpectedRamBlockRemoved(details, threads?, person?)` (`Formulas.ts:482-507`).

### 4.1 exec / scp / connect rules for darknet

- **scp to a darknet server** (`NetscriptFunctions.ts:766-772`): requires `requireAdminRights + requireSession` on destination. Session at any distance (via `connectToSession`). scp **from** a darknet server is always allowed.
- **exec on a darknet server** (`NetscriptFunctions.ts:634-644`): requires admin + session + **direct connection, OR backdoor/stasis** (`backdoorBypasses:true`). So to run scripts remotely you need a backdoor or stasis link on the target.
- **Terminal `connect`** (`Terminal/commands/connect.ts`): only to adjacent servers, or ones with `backdoorInstalled` (stasis sets this) or `purchasedByPlayer`. So stasis/backdoor allow terminal teleport.
- **`backdoor`** on a darknet server: requires admin rights; no hacking-skill gate for DarknetServer in the terminal path (`backdoor.ts:12-39`). `ns.singularity.installBackdoor()` also works; install time = `calculateHackingTime/4`, and `calculateHackingTime` for a DarknetServer is hard-coded **16 s** (`Hacking.ts:61`) → backdoor ≈ 4 s.
- `ns.getServer(darknetHost)` returns server data + `{isOnline:true}` plus deprecated darknet props; offline returns dummy `{isOnline:false}` (no throw).

---

## 5. The Labyrinth (lab chain, maze, Red Pill)

Lab servers are stationary special darknet servers at the bottom of the net. There is exactly **one** active lab at a time, determined by which lab augs you own (`getCurrentLabName`, `labyrinth.ts:434-473`). Hostnames and specs (`labyrinth.ts:37-110`, `SpecialServers.ts:13-20`):

| Lab | hostname | depth | cha req | maze W×H | manual? | offsetEnds? | aug reward (order) |
|---|---|---|---|---|---|---|---|
| Normal | `th3_l4byr1nth` | 7 | 300 | 20×14 | yes | no | TheBrokenWings |
| Cruel | `cru3l_l4byr1nth` | 12 | 600 | 30×20 | yes | no | TheBoots |
| Merciless | `m3rc1l3ss_l4byr1nth` | 19 | 1500 | 40×26 | no | no | TheHammer |
| Uber | `ub3r_l4byr1nth` | 23 | 2500 | 60×40 | no | yes | TheStaff |
| Eternal | `et3rn4l_l4byr1nth` | 29 | 3000 | 60×40 | no | yes | TheLaw / (BN15: **Red Pill**) |
| Endless | `end13ss_l4byr1nth` | 31 | 3500 | 60×40 | no | yes | TheLaw/TheSword |
| Final | `f1n4l_l4byr1nth` | 36 | 4000 | 60×40 | no | yes | TheSword / Red Pill |
| Bonus | `b0nus_l4byr1nth` | 36 | 4000 | 60×40 | no | yes | NeuroFlux (stable) |

Aug reward order (`getLabAugReward`, `labyrinth.ts:403-430`): BrokenWings, Boots, Hammer, Staff, Law, Sword. **In BN15**, when the next aug would be TheLaw and you lack Red Pill, the **Eternal lab yields The Red Pill** instead (`:420-421`). On BNs where `DarknetLabyrinthRewardsTheRedPill` mult allows it (default 1; 0 in BN8/BN12), the 6th lab (after Sword) yields Red Pill. Once all six + Red Pill owned → NeuroFluxGovernor.

**Lab augs** (`Augmentations.ts:1850-1945`, all `isSpecial`, rep 1e4 / money 1e6, `factions:[]` — only obtainable from the lab):
- TheBrokenWings ("The W1ngs of Icarus"): +stasis limit, cha×1.05, agi×1.10, dnet_money×1.30.
- TheBoots ("The B00ts of Perseus"): auth/heartbleed ×0.8 speed, cha×1.06, dex×1.06.
- TheHammer ("The H4mmer of Daedalus"): +stasis limit, cha×1.07, str×1.10, dnet_money×1.10.
- TheStaff ("The St4ff of Asclepius"): +stasis limit, cha_exp×1.10, def×1.10, dnet_money×1.10.
- TheLaw ("The L4w of Bayes"): cha×1.09, company_rep×1.05, dnet_money×1.15.
- TheSword ("The B1ade of Solomonoff"): cha×1.10, hacking×1.10, company_rep×1.10, dnet_money×1.10.

Max stasis limit = 4 (base 1 + BrokenWings + Hammer + Staff). BN15 removes Red Pill from Daedalus's aug list (`FactionHelpers.tsx:205-208`) — the **only** way to get Red Pill in BN15 is the labyrinth.

### 5.1 Maze mechanics (`labyrinth.ts:112-186, 236-382`)

- `generateMaze(W,H)`: below MULTI_MAZE_THRESHOLD(5) one iterative-backtracker maze; else 4 quarter-mazes stitched with random wall gaps. Odd-dimension-normalized. `█`=wall, ` `=path, cells on odd coords.
- Password cannot be used to skip — submitting the lab's literal password is explicitly rejected ("find the end, not skip it"). Navigation is via movement words.
- `handleLabyrinthPassword(input, server, pid)`: if `charisma < labCha` → `NotEnoughCharisma` failure (can't move). Direction parsed from `input` via `getDirectionFromInput` — accepts `n/north/up`, `e/east/right`, `s/south/down`, `w/west/left` (case-insensitive). Movement is **2 cells** per step (`newLoc = pos + dir*2`); wall-check at `pos+dir*1`. On wall: "cannot go that way". On valid move: updates `labLocations[pid]`, returns new surroundings. On reaching `labEndpoint`: admin rights granted, cha XP (as 32 threads), adds `LAB_CACHE_NAME` ("the_great_work") cache(s) → open it for the aug.
- Each **pid** has its own position (`DarknetState.labLocations[pid]`), start `[1+offX, 1+offY]`. `offsetStartAndEnd` labs randomize start/end by `rand()*3*2`. Non-manual labs must be driven by a script (each script pid walks independently); the UI can only "follow" a pid.
- `labreport()` → passability booleans around pid; `labradar()` → 7×7 ASCII view with `@`/`X`. Both delay by `calculateAuthenticationTime`. Solve = BFS/DFS of the maze using radar/report, moving 2 cells at a time, avoiding walls, to reach `X`.
- Reaching the Bonus lab end grants **3** caches in stable (`labyrinth.ts:311`), others 1.

---

## 6. Rewards and formulas

### 6.1 Cache files (`effects/cacheFiles.ts`)

`.cache` files spawn on servers: 
- On successful first auth: chance `0.1 * 1.05^difficulty` (`effects.ts:42-45`).
- On full RAM-block clear: always 1 (`ramblock.ts:50-53`).
- From phishing: rare `.d.cache` (phishing-only, can contain CCTs).
- Lab end: `the_great_work` cache(s).

`openCache` (`ns.dnet.openCache` or terminal `run x.cache`) → `getRewardFromCache` (`cacheFiles.ts:35-74`). Karma loss = `difficulty+1`. For lab caches → the queued lab aug. Otherwise picks **uniformly at random** from a reward pool:
- `getProgramAndStockMarketRelatedRewards`: grants (first missing, in order) ServerProfiler, BruteSSH, DeepScanV1, FTPCrack, AutoLink, RelaySMTP, DeepScanV2, HTTPWorm, SQLInject, Formulas; then WSE account, TIX API, 4S Data; else money.
- `getStockReward`: `min(floor(1+diff*5+rand()*10), maxNewShares)` shares of a random stock (falls back to money if fully owned).
- `getDataFileReward`: adds 2 clues; if none added, money.
- `getCCTReward` (**only for `.d.cache`**): if ≥10 min since last CCT, `min(floor(min(20,diff)*0.1 - 1.5 + rand()*3), 3)` contracts at half reward; else money.
- `getMoneyReward` (**only if BN's `DarknetMoneyMultiplier ≠ 0`**): 
  ```
  reward = 1.2^difficulty * 1e7 * ((200+cha)/200) * sf15_3Factor * mults.crime_money * mults.dnet_money * nodeMults.DarknetMoneyMultiplier
  sf15_3Factor = activeSF15 >= 3 ? 1.5 : 1
  ```

### 6.2 Phishing (`effects/phishing.ts`)

Delay `max(10000*(400/(400+cha)),200)`. XP = `mults.charisma_exp*threads*50`.
- Cache: if ≥3 min since last phishing-cache and `rand() < 0.005*crime_success*threads*((400+cha)/400)` → `.d.cache`.
- Else money: if `rand() < 0.05*crime_success*((200+cha)/200)`:
  ```
  money = 500 * crime_money * dnet_money * (0.1+depth*0.05) * threads * ((400+cha)/400) * bonusTimeFactor * rand[0.9,1.2] * DarknetMoneyMultiplier
  ```
- Else: nothing (quarter XP).

### 6.3 Memory reallocation (`effects/ramblock.ts`)

`getRamBlockRemoved = roundToTwo(clamp(0.02 * (2*0.92^(diff+1)) * threads * (1+cha/100), 0, remaining))`. XP = `charisma_exp*threads*10*1.1^(diff+1)`. Clearing all blocked RAM → cache + 30% extra clue + 15% STORM_SEED spawn (gated by 30 min since last storm).

### 6.4 Stock promotion / volatility (`effects.ts:197-209`, `StockMarket.ts`)

`getDarknetVolatilityMult(sym) = 1 + (1 - e^(-0.001*charges)) + 2*(1 - e^(-0.00015*charges))` → caps ~4×. Applied to `stock.mv` in price updates (`StockMarket.ts:264`), in `ns.stock.getVolatility`, and the ticker. Does **not** change forecast. Charges **decay** ×0.4 each full market cycle (`stockMarketCycle`, every `TicksPerCycle=75` updates; `scaleDarknetVolatilityIncreases(0.4)`). `promoteStock` adds `threads*((500+cha)/500)` charges per call.

### 6.5 Charisma / SF15 passive effects

- Charisma skill: `calculateSkill(exp, mult) = floor(mult*(32*ln(exp+534.6)-200))`, clamp≥1 (`formulas/skill.ts`). BN15 `CharismaLevelMultiplier = 1.1`.
- **SF15.1**: permanent TOR + DarkscapeNavigator + full dark web on all BNs.
- **SF15.2** (`activeSF15 > 1`): charisma boosts job salary & company rep via `getMultiplierFromCharisma(1.5)` (`Work/Formulas.ts:133`). Also auth speed ×0.8 — but stable gates this on `activeSF15 > 2` (a bug; see Changes). `getMultiplierFromCharisma(s) = 1 + 0.5*(1-e^(-0.0002*cha)) + 0.6*(1-e^(-0.0002*0.2*cha))*s` (~1.2 at 2000 cha, ~1.6 at 10000, cap ~2.1).
- **SF15.3** (`activeSF15 >= 3`): charisma adds to **faction work** rep gain (`reputation.ts:54-59`, `getDarknetCharismaBonus`: hacking-contract scalar 0.1, security/field 0.3) and cache money/XP ×1.5.

### 6.6 Multipliers / aug mult `dnet_money`

`Player.mults.dnet_money` (`PersonObjects/Multipliers.ts`) multiplies cache and phishing money; raised by lab augs (BrokenWings 1.3, Law 1.15, Hammer/Staff/Sword 1.1). Grafting entropy nerfs it (`EntropyAccumulation.ts:33`).

---

## 7. BN15 win condition & BitNode multipliers

- **Win**: install **The Red Pill**, then install a backdoor on `w0r1d_d43m0n` (WorldDaemon) — same as BN2/standard. In BN15 the Red Pill is **not** sold by Daedalus; it must be looted from the Eternal labyrinth deep in the dark net. WorldDaemon requires hacking 3000 × `WorldDaemonDifficulty` (BN15 = **2** → 6000 effective) (`servers.ts:1536`, `ServerHelpers.ts:384`). Milestone text: "Find The Red Pill somewhere in the dark net" (`Milestones.ts:96`).
- **BN15 multipliers** (`BitNode.tsx:1089-1122`): HackingLevel 0.6, HackingSpeed 0.6, Str/Def/Dex/Agi 0.7, **Charisma 1.1**, ServerMaxMoney 0.8, ServerStartingMoney 0.5, ServerStartingSecurity 1.5, AugmentationMoneyCost 3, Corp Valuation 0.2 / Softcap 0.4 / Divisions 0.4, **DaedalusAugsRequirement 20**, BladeburnerRank 0.2, BladeburnerSkillCost 3, GangUniqueAugs 0.3, StaneksGiftPower 0.7 / Size −2, WorldDaemonDifficulty 2. `DarknetMoneyMultiplier` defaults to **1** in BN15.
- `DarknetMoneyMultiplier` by BN (`BitNode.tsx`): BN3/4 0.4, BN5 0.7, BN8 **0** (no money from darknet, and `DarknetLabyrinthRewardsTheRedPill` 0 → no TRP from lab), BN9 0.05, BN10 0.4, BN12 `dec=1.02^-lvl`, BN13 0.1, all others (incl. BN15) 1. `DarknetLabyrinthRewardsTheRedPill` default 1, 0 only in BN8.
- **SF15 effect per level** (`BitNode.tsx:546-563`): L1 permanent TOR+DarkscapeNavigator+full dark web everywhere; L2 charisma→salary & rep + auth speed +20%; L3 charisma→faction work rep + cache XP/money +50%.
- Daedalus still appears; BN15 sets `DaedalusAugsRequirement=20` (`FactionHelpers`), and strips Red Pill from its list.

---

## 8. Risks, penalties, timing, interaction with normal hacking

- **Scripts die constantly**: servers move/restart/go offline randomly. Any script's state (incl. discovered passwords) is lost unless persisted. Store passwords in files (home) or via a durable store.
- **Sessions are per-pid**: each running script instance must `authenticate` or `connectToSession` individually.
- **Offline servers list is volatile**: cleared on prestige and on game reload (`prestigeDarknetState` clears `offlineServers`). Don't rely on reuse.
- **Instability**: >2 backdoored servers ramps auth timeout chance (up to 50%) and auth-time ×1.07 per surplus. Use **stasis links** instead (don't count), but you only get up to 4.
- **Karma cost**: each cache open loses `difficulty+1` karma (relevant if chasing gangs; toast hidden until gang-aware).
- **MathML injection trap**: evaluating puzzle expressions with `eval` triggers a planted payload (`getCodeInjection`, `ServerGenerator.ts:560-562`) opening the dev menu. Always use the provided `parseSimpleArithmeticExpression`.
- **Webstorm**: one `unleashStormSeed` wipes most of the net. STORM_SEED can appear automatically on cleared-RAM servers — don't blindly `run` unknown `.exe` on darknet servers.
- **Normal hacking interaction**: darknet servers can't be hacked for money (hacking time hard-coded 16 s, `ns.hack` targets `Server` only). They provide **RAM** (lots, deep in net) for running your own scripts, and the money comes from caches/phishing/stock. `calculateHackingTime` returns 16 for DarknetServer (used only for backdoor timing). Charisma is the governing stat, not hacking.
- **No achievement with heartbleed**: `CHALLENGE_BN15` requires finishing BN15 without ever calling `heartbleed` (`DarknetState.hasUsedHeartbleed`, which only resets on SF prestige). Non-goal for a max-SF run but note it.
- **Bug: `lastCctRewardTime` is never reset** on prestige (`prestigeDarknetState` omits it, `DarknetState.ts:84-101`) and is **never set** anywhere after cache CCT reward (the code checks `cctCooldownReached` but never updates `lastCctRewardTime`). So CCT caches are effectively always on cooldown-cleared after the first 10 min of real time since app start — minor.

---

## 9. Where randomness enters, and predictability

- **All generation uses `Math.random()`** (server type, password, RAM, connections, names, mutations, maze, rewards). `Math.random()` is **not seeded** and not predictable/manipulable from NS (no exposed seed). You cannot precompute a password.
- **Exception — KingOfTheHill altitude** uses `WHRNG(password)` (`authentication.ts:218`), a Wichmann–Hill PRNG seeded by the (unknown) numeric password. Given the password you could reproduce the hill layout, but since you're solving *for* the password that's only useful for understanding the landscape (single clean Gaussian within 3%).
- **Everything else is oracle-solvable**: puzzles expose enough per-attempt feedback (or plaintext) that the password is recoverable deterministically without guessing randomness. Passwords themselves are random but the puzzles leak them.
- `probe` order is deliberately shuffled (lodash) to hide topology — no info leak there.
- Maze layout is random per lab instantiation but fully observable via radar/report → solvable by standard maze search.

---

## 10. Implications for automation (BN15)

### Proposed architecture
1. **Bootstrap (home)**: ensure TOR + `DarkscapeNavigator.exe` (auto in BN15). Maintain a persistent **password store** on `home` (a JSON file). Passwords recur: an offline hostname can come back with a *new* password, so verify a stored password with `connectToSession` before trusting it, and re-solve on failure.
2. **Spreading worker**: a self-replicating script (the doc's example in `programming/darknet.md` is the template). It `probe()`s neighbors, solves each by `modelId`, `authenticate`s, then `scp`s itself + `exec`s on the newly-cracked server (direct connection satisfies exec). It recurses outward. Because `exec` needs a direct connection (or backdoor/stasis), the worker must physically live on each frontier server — hence self-replication.
3. **Solver module**: a `switch(modelId)` dispatching to per-type solvers (§3.3). Most are pure functions of `getServerDetails().data`/`passwordHint`; a few (Yesn_t, SpiceLevel, Mastermind, TimingAttack, GuessNumber/RomanNumeral-range, Divisibility, TripleModulo, KingOfTheHill, SortedEchoVuln) are **interactive oracles** — submit probes, read feedback from the returned `data` or from `heartbleed` logs, iterate.
4. **Persistence/recovery supervisor** (home): watches for killed workers (server moved/restarted/offline), re-seeds frontier servers it can still reach, and re-pathing to detached islands. Use `nextMutation()` to wake on net changes.
5. **Stability layer**: place **stasis links** (≤4) on key hub servers / near the lab to pin them (prevents move/offline, enables remote `exec`/`connect`). Avoid backdooring many servers (instability). Use `induceServerMigration` to ferry a worker across air gaps (ride a server as it migrates deeper).
6. **Economy layer**: on cracked servers with lots of free RAM (after `memoryReallocation`), run `phishingAttack` (money+cha) and `promoteStock` (on held stocks); open `.cache` files for money/programs/augs/stock. Charisma is the master resource — it speeds auth, heartbleed, stasis, migration, phishing, and gates labs.
7. **Lab chain driver**: once cha ≥ lab requirement and a worker reaches the active lab (connected), drive it with `labradar`/`labreport` + `authenticate("go <dir>")`, running a maze-search (BFS to the `X`). Each lab end gives the next lab aug via its `the_great_work` cache. Progress Normal→…→Eternal; in BN15 Eternal yields **Red Pill**. Then install Red Pill and backdoor WorldDaemon to win.

### Puzzle difficulty for automation
- **Trivial / one-shot** (read the hint, no iteration): ZeroLogon, EchoVuln (plaintext in hint), DefaultPassword (4 tries), DogNames (4), Captcha (strip non-digits), BinaryEncoded (binary→ASCII), XorMask (XOR), RomanNumeral<8 (decode), ConvertToBase10 (base parse), MathML (safe parser — **never eval**), LargestPrimeFactor (factor), CommonPassword/EUCountry (small dictionaries, prunable by length/format), PacketSniffer diff≤16 (regex the plaintext out).
- **Easy interactive** (few probes): GuessNumber & RomanNumeral≥8 (binary search), SpiceLevel/Yesn_t (per-position oracle), TimingAttack (prefix-extension via response time or the mismatch-index in logs), Divisibility (trial division), SortedEchoVuln<5 (permute ≤4 known digits).
- **Harder but deterministic**: Mastermind (constraint solver over exact/misplaced), SortedEchoVuln≥5 (assignment to zero RMSD), TripleModulo (modular reconstruction), KingOfTheHill (hill-climb a Gaussian landscape), PacketSniffer diff>16 (bare password buried in alnum noise — but still leaked via neighbor-log noise/heartbleed).
- **Not really a "puzzle"**: BufferOverflow (submit `≥2N` chars) — effectively trivial once you read the buffer size from the hint.
- **Would benefit from an LLM?** Essentially **none** need one — every type is a closed-form or classic-algorithm oracle. The only places fuzzy reasoning *could* help: (a) scraping the noisy PacketSniffer/heartbleed log stream for the leaked plaintext when it's bare (diff>16) — but a few regexes/heuristics suffice; (b) choosing high-information Mastermind guesses — but a minimax/entropy heuristic is standard. Recommendation: pure algorithmic solvers; no LLM in the hot loop.

### Leverage points & exploitable quirks
- **BufferOverflow**: the "puzzle" is defeated by length alone — always just send `"A".repeat(2*passwordLength)`.
- **PacketSniffer / heartbleed noise**: logs leak **neighbors'** passwords (`--pw--`, `host:pw`) and partial-char hints for free — harvest every heartbleed into the password store; you often learn passwords for servers you haven't reached yet.
- **Charisma snowball**: failed auths still grant cha XP; deep servers grant exponentially more. Early grinding on cheap servers (and uni in Chongqing before dnet, per `Bladeburner.ts:1156`) bootstraps charisma, which then accelerates everything.
- **Stasis over backdoor**: pin hubs with stasis links (no instability, remote exec/connect, terminal teleport) rather than mass-backdooring.
- **Threads**: auth/heartbleed/ram/phishing/promote/migration all scale with thread count (auth with diminishing returns `1/(1+0.2(t-1))`; ram/phishing/promote linearly). Deep servers' big RAM lets you throw many threads at hard puzzles.
- **`induceServerMigration` stacks** across scripts → coordinate several workers to force a specific server across an air gap quickly.
- **Int-bonus bug (stable)**: high intelligence *slows* darknet auth in 3.0.1 (multiplied, not divided). Don't over-invest int expecting faster auth until 3.0.2.

### Open questions / things to verify empirically
- Exact convergence/iteration bounds for TripleModulo and KingOfTheHill solvers at high difficulty (passwords up to ~10+ digits).
- Real-world mutation/offline rate vs. worker crack rate at each net depth — whether workers can out-run deletion deep in the net without heavy stasis use.
- Whether SortedEchoVuln≥5 RMSD assignment is always uniquely solvable or needs multiple probes.
- Precise RAM budget of a self-replicating solver (must include every `ns.dnet.*` function's RAM in §4 it uses; authenticate 0.4 + heartbleed 0.6 + probe 0.2 + getServerDetails 0.1 + scp/exec from base are the core cost).

---

## 11. Changes in 3.0.2 (unreleased dev branch `bitburner-src`)

Summarized from a diff of `src/DarkNet`, `NetscriptFunctions/Darknet.ts`, `Formulas.ts`, `BitNode.tsx`, `Augmentations.ts`, and the `.d.ts`. These are the important gameplay/API differences an automation author should expect when 3.0.2 ships.

**New augmentation — "The Thr3ad of Ariadne" (`AugmentationName.TheThread`)**: replaces NeuroFluxGovernor as the repeatable Bonus-lab reward and the fallback lab aug (`cacheFiles.ts`, `labyrinth.ts`). Stackable like NFG (+1% all stats per spool, `getThreadAugmentMults`). Prereq TheSword. Its installed **level drives the Bonus lab**: more Thread spools → larger Bonus-lab maze (`generateMaze(mazeW+bonusSize, mazeH+bonusSize)`, `bonusSize=min(level*4,900)`) and larger random start/end offsets. Bonus-lab cache count tapers: 3 caches for first three completions (Thread<9), 2 for next three (<15), then 1. So BN12-target / post-win grinding of Thread is deeper.

**`ns.dnet.freezeServer(host)` (NEW, 2 GB)**: a "stasis for testing" that overloads a directly-connected server, setting `maxRam=0` and `isStationary=true` — the server stops moving/going offline but becomes unusable (frozen). Frozen servers **add to instability** (`getTimeoutChance` now counts frozen servers plus `max(backdoored−2,0)`; `offlineServerHandling.ts`). Webstorm deletes all frozen servers. Frozen servers are excluded from neighbor/row queries (`darknetNetworkUtils` now `.filter(n=>n.maxRam)`).

**`induceServerMigration` now returns `progress`**: `Promise<DarknetResult & {progress:number}>` giving total migration charge in [0,1]; success logging fixed (#3169). New `ns.formulas.dnet.getExpectedMigrationCharge(details, player, threads?)` (0 GB).

**`CacheResult` is now structured**: `openCache` returns `{success,message,karmaLoss, wseAccount,tixApiAccess,fourSigmaData, money?,programName?,stockSymbol?,stockShares?,dataFilePaths?,contractFilePaths?,augmentationName?}` (new `CacheReward` type). Caches no longer spawn on frozen (`maxRam===0`) servers; `addClue` returns the created file paths; data-file cache names are listed in the message.

**SF15.2 auth-speed bug fixed**: the −20% authentication speed now applies at **level ≥2** (`activeSF15 >= 2`), not `>2`. Matches the documented "Level 2" effect.

**Intelligence bug fixed**: `calculateAuthenticationTime` now **divides** by the intelligence bonus (so higher int = faster auth) instead of multiplying (`effects.ts`). Plan int differently for 3.0.2.

**`promoteStock` now requires TIX API access** (`Darknet.ts`) and throws otherwise.

**`getServerDetails().depth` for labyrinth servers** now reports the lab's configured depth (`labData[host].depth`) instead of the live grid depth.

**BitNode mult tweaks**: BN12 now sets `DarknetLabyrinthRewardsTheRedPill: 0` at all levels (no TRP from lab in BN12). BN13 adds `CharismaLevelMultiplier: 0.7`. `heartbleed` error message fixed (was `requiredHackingSkill`, now `requiredCharismaSkill`).

**Maze gap-generation fix** (`generateMaze`) corrects swapped width/height in the 4-maze stitch gaps (cosmetic/topology correctness; mazes still solvable the same way).

**Labyrinth/darkweb robustness**: only the single active lab server is instantiated (`addLabyrinth` uses `getLabyrinthDetails().name` instead of all names); darkweb drops its home connection when TOR is absent; disconnect logic protects labyrinth neighbors; log handling rewritten to mutate arrays in place (no behavior change for scripts). Save loading now uses the `Reviver`.

No change to: the puzzle model set and their solver algorithms, password generation, `authenticate`/`connectToSession`/`heartbleed`/`probe` semantics, stasis-link limits, the win condition, or SF15.1/15.3 effects.
