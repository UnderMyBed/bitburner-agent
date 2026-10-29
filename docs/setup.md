# Setup

How to run the agent against Bitburner on Steam, from a clone of this repository ([#95](https://github.com/UnderMyBed/bitburner-agent/issues/95), [#122](https://github.com/UnderMyBed/bitburner-agent/issues/122); architecture §10.1, §10.2). The brain runs from the repo, in a terminal, and is started again if it crashes. It launches the game, deploys the in-game Agent, and keeps both going while it runs.

**Nothing is installed.** There's no service, no scheduled task and no standalone binary (owner decision 30). Everything the brain writes goes in the repo's gitignored `.data/`: its config (with the control channel's token), the store, the in-game build and the save backups, unless you give it another data directory (below). npm's own download cache is the one exception. To stop it, stop the brain. To remove it, delete the clone, after copying out any save backups in `.data/saves/` you want to keep.

**You run these steps yourself.** They act on your game. Claude builds the agent but never drives your game or your system.

## Before you start

- Windows, with Steam and Bitburner installed (Steam app 1812820).
- [Node.js 24](https://nodejs.org/) and git.
- **One brain, one game.** The brain serves one game on the fixed ports 12525–12527: run one brain at a time, and don't point a second game at it.

## 1. Clone and bootstrap

Only tagged releases go to Steam (architecture §6). Clone the repository and check out the newest release tag. `v0.3.0` is the example below (`v0.2.0` was the first with these steps).

For a release's live run on Steam ([releasing](releasing.md) step 2), check out the candidate commit instead. It's recorded on the milestone's review issue. Then follow [this page as it is on `main`](https://github.com/UnderMyBed/bitburner-agent/blob/main/docs/setup.md), not the copy in your checkout: docs fixed after the candidate are only there.

**Already have a clone?** Use it. Stop its brain if it's running, then follow [Upgrading to a new release](#upgrading-to-a-new-release) with the tag or commit you want. That ends with step 2's `npm run brain`, so carry on at step 3. Its `.data/`, if it has one, carries over: the config, the store and the save backups.

```
git clone https://github.com/UnderMyBed/bitburner-agent.git
cd bitburner-agent
git checkout v0.3.0
npm run bootstrap
```

`npm run bootstrap` fetches the game's source (the `vendor/bitburner-src` submodule), installs this repository's packages, then the game's own dependencies. It says each step, stops at the first that fails, and can be run again. The brain needs the submodule: it checks the game's version against it, and stops at start if it's missing.

## 2. Start the brain

```
npm run brain
```

It runs in that terminal until you stop it (Ctrl+C) or close the terminal.
- **If the brain crashes, it's started again** after 5 s, then 10, 30 and 60 s if it keeps crashing; a run of 5 minutes or more starts that over. Each restart is a `brain runner:` line.
- **After a reboot**, run `npm run brain` again: nothing is installed to do it for you.

**What happens next.** The brain:
- builds the in-game code (a few seconds);
- creates `.data/config.json` in the repo, the first time;
- serves the dashboard at **http://127.0.0.1:12527/**;
- **launches Bitburner through Steam about 30 s later**.

The brain's output is its log: deploys, connections, save backups, errors. If it stops at start, the last lines say why. A `config.json` it doesn't accept names the field and what it should be.

**A config from an earlier brain** may lack fields added since: `saveBackupIntervalMinutes`, `saveBackupsKept`, `steamAppId`, `gameExecutable`. Add them with their defaults ([the brain's README](../packages/brain/README.md#the-data-directory)), or move `.data/` aside and start fresh.

## 3. Pause supervision while you set up

**Wait for the game to open, then open http://127.0.0.1:12527/ and click "Pause supervision".** If it has been more than a minute and the game hasn't opened, start it from Steam yourself. While supervision runs, the brain kills and relaunches a game that has no Agent reporting for about 5 minutes. Until you've finished step 4, no Agent reports.

An `agentSilent` alert is expected until step 4.4.

## 4. Set the game up

1. **A brand-new save:** click "Exit Tutorial" first, in the tutorial's panel. While the tutorial runs, the game's terminal runs only the tutorial's commands, so step 4.4's `run agent/boot.js` would be refused, and the agent can't end it for you ([architecture §5.7](architecture.md#57-bootstrap-and-restart-c5)).
2. **Options → Remote API:**
   - Hostname `127.0.0.1` (not the default `localhost`: the brain listens on 127.0.0.1 only);
   - Port `12525`;
   - Reconnection delay `5` (above 0, so the game reconnects when the brain restarts);
   - "Use wss" off;
   - then click **Connect**. Changing the settings alone doesn't connect.

   The dashboard's **Recent events** should show `deployed` (or `deploymentCurrent`) and a `saveBackup` within a few seconds.

   **If it doesn't connect** and the dashboard's events show `connectionRejected`, the game's page sent an origin the brain doesn't allow. The brain allows `file://`, Steam's page, by default.
   - Copy the origin from the event, without the ` (Remote File API)` the brain adds after it, into `allowedOrigins` in `.data/config.json`. Never add `(none)`: that's a connection with no origin at all, not a page.
   - Then restart the brain: Ctrl+C, and `npm run brain` again.
3. **Options → System:** set "Autoexec Script + Args" to `agent/boot.js`. Autoexec runs on every load of a saved game, so after this the Agent starts by itself.
4. **First start of the Agent:** in the game's terminal, type `run agent/boot.js` once. Autoexec can't do this first start: it ran when the game loaded, before the brain had deployed.

   The dashboard's **Agent** table shows "Connected: yes" with the deployment, and the tiers start arriving.
5. **Save the game** (Options → Save Game), or wait for an autosave. The game keeps its settings in the save, so settings changed after the last save are lost if the game is relaunched.

## 5. Resume supervision

Click **"Resume supervision"**. From now on, while the brain runs, it relaunches the game if it closes, or if the Agent goes silent for 5 minutes. It does so at most 3 times an hour; after that it stops and shows an alert.

The skeleton now runs as long as the brain does. After a reboot, run `npm run brain` again: the brain launches the game, and autoexec starts the Agent.

## Day to day

- **The hack loop** (since v0.3.0) is on by default (owner decision 34). Once the Agent connects, it roots the servers it can and runs a loop on the game's servers against the target the brain picks; the dashboard's "Hack loop" line names it. When a better target comes within reach, the largest servers prepare it while the rest keep earning, and the line names that too ("preparing zer0 on 7 servers"); all move to it once it's ready. Each server hacks with only so many threads that, together, they never take more of a target's money than it grows back quickly, so money keeps rising: the line says how many ("hacking with at most 48 threads", #187). It never runs on home or on your purchased or Hacknet servers, and never touches your own scripts ([the hack loop](../packages/ingame/README.md#the-hack-loop)).
  - **It fills the free RAM** on the servers it runs on, so a script you start there later may not fit. A loop you kill comes back within about 30 s. To use those servers yourself, stop the loop first.
  - **Money flat for 10 minutes** with the loop on is the dashboard's `incomeStalled` alert, with how long, the money and the target, and a line in the brain's window as it starts and ends. A purchase lowers money, which doesn't count as a rise. It shouldn't happen: if it does, `npm run report` names the stall, and it's worth an issue.
  - **To stop it,** click **"Stop the hack loop"** on the dashboard: every loop stops within a few seconds, and it stays off, across brain restarts, until you start it again.
- **Buying the hacking programs** (since v0.3.0) is on by default too. When you can afford the next one, the Agent buys the TOR router at your city's tech vendor, then BruteSSH.exe, FTPCrack.exe, relaySMTP.exe, HTTPWorm.exe and SQLInject.exe through the terminal, so the hack loop can root more servers ([the hacking programs](../packages/ingame/README.md#the-hacking-programs)).
  - **It uses the game's page, as you would:** a few times a session you'll see the page switch to the City and back, or a `buy` typed into the terminal. However it goes, it ends on the Terminal, or, if you were focused on work, focused on it again.
  - **Keep the sidebar's Hacking, Character and World sections open:** they hold the Terminal, Factions, City and Job. With one collapsed, what goes through it (buying, joining a faction, buying an augmentation, starting work at a faction or a company) waits until it's open again.
  - **The faction state** (from M4, #197): with each slow snapshot, once a minute, while you've joined a faction or have an invitation, the Agent opens the Factions page (and the Augmentations page while anything is queued) to read each faction's reputation and favour, the invitations and the augmentations bought but not installed, then puts the page back: the Terminal, or your work focused again. Opening Factions clears the sidebar's badge for new invitations, as looking yourself does. The dashboard's **Factions** section shows what it read; if it can't read them, it says why there, the `factionStateUnread` alert holds, and the run report fails. With Singularity (SF4) and room on home, none of this touches the page.
  - **The game's own dialogs are handled for you** (owner decision 35): the Agent closes the game's alerts ("Offline for…" after a load, purchase and travel notices), and answers a faction invitation with "Decide later", so it waits on the Factions page. What each said is on the dashboard's recent events (`gameDialog`). Any other dialog (a script's `ns.prompt` or `ns.alert`, or one you opened) is yours: nothing is done on the page while it's open, and the dashboard's `dialogBlocking` alert quotes it. Nothing is typed into the terminal while you've a line typed there either.
  - **Chongqing and New Tokyo have no tech vendor:** in either, the TOR router waits until you travel, and the dashboard says so.
  - **Nothing is bought while the brain holds** (after a Steam update, a failed deploy, or a game version it wasn't built for).
  - **To stop it,** click **"Stop buying programs"** on the dashboard; **"Start buying programs"** turns it back on.
- **Upgrading home's RAM** (since v0.3.0) is on by default too. When you can afford it, the Agent doubles home's RAM at your city's tech vendor, the same way: the page switches to the City and back to the Terminal once per upgrade ([home RAM](../packages/ingame/README.md#home-ram)).
  - **One purchase at a time, the cheaper first:** with buying programs on too, the upgrades and the programs take turns by price (16 GB comes after BruteSSH.exe and before FTPCrack.exe), and the dashboard says which one waits for which. So while an upgrade can't be made (World collapsed), the next program waits for it too.
  - **BN1 only, for now:** other BitNodes change the price, so there it waits, and the dashboard says so.
  - The same as for the programs: keep the World section open, close your own dialogs (and your scripts'), travel from Chongqing or New Tokyo, and nothing while the brain holds.
  - **To stop it,** click **"Stop upgrading home RAM"** on the dashboard; **"Start upgrading home RAM"** turns it back on.
- **Backdoors for the hacker factions** (from M4, on `main` until it's released): once the hack loop has rooted CSEC and your hacking level reaches its requirement (51 to 60, depending on the game), the brain has the Agent backdoor it, so CyberSec invites you; then avmnite-02h (NiteSec, about level 210), I.I.I.I (The Black Hand, about 350) and run4theh111z (BitRunners, about 530), one at a time ([backdoors](../packages/brain/README.md#backdoors-for-the-hacker-factions)). You'll see `home`, a few `connect`s and `backdoor` typed into the terminal, a few seconds' wait, and `home` again; if you were focused on work, it's unfocused for that and focused again after. The invitation's dialog is answered "Decide later", as for any invitation; the brain then joins it (below). The brain's window says "backdoor: asking for CSEC …" and "backdoor: CSEC backdoored …". There's no switch: a backdoor costs nothing. After an install the game removes them, and they're done again. If one is due for 5 minutes without being done, the dashboard's `backdoorOverdue` alert says so, and the run report fails ("backdoor overdue"); one that fails raises "intent stuck" after 5 tries, like any intent.
- **Doing something once** (since v0.3.0): the dashboard's **Intents** section queues a one-shot action, the action and its arguments as JSON, for example `travel` with `{"city": "Aevum"}`. The Agent does it through the game's page, as for the purchases, and it leaves the queue once the Agent reports it done; **Cancel** takes it off sooner. The queue holds 97. The section also lists the purchases, the backdoors and the joins the brain sends, and how each went. Anything can be queued, with no confirmation (owner decision 36), so check the arguments: a travel costs $200k. Joining one of the six city factions (`joinFaction`) can't be undone, since it bans the faction's enemies, so the brain holds it until two snapshots show it's still allowed and a save backup has been taken; the section says what it's waiting for. `purchaseAugmentation` takes `{"faction": "CyberSec", "augmentation": "Neurotrainer I", "level": 1}`; for NeuroFlux Governor, `level` is the level to buy next. `installAugmentations` takes `{}` and installs every augmentation you've bought, which resets the game: like a city faction's join, it waits for two snapshots and a save backup, and also until everything queued before it is done; whatever you queue after it waits until it's done, for the game after the reset. With Singularity (SF4), where its worker fits home beside the Agent (16 GB or more at SF4.3), the game starts the Agent again itself. Otherwise it goes through the page: you'll see the Augmentations page, the install's confirmation and alert, then `run /agent/boot.js` typed into the terminal, which brings the Agent back. A line you've left typed in the terminal is never typed over: then the game saves and reloads instead (through Options' "Force kill all active scripts"), and autoexec brings the Agent back. Keep the sidebar's Character and Help sections open: they hold Augmentations and Options. `buyServer` takes `{"hostname": "pserv-0", "ram": 8}`: a cloud server (8 GB costs $440k in BN1), bought with the game's API, not the page. A name one of the player's cloud servers already has is done without buying, and one of the game's own servers (`n00dles`, `home`, `w0r1d_d43m0n`) is refused. `backdoor` takes `{"hostname": "CSEC"}`: the Agent types `home`, a `connect` for each hop and `backdoor` into the terminal, and goes back `home` once it's installed. The server needs root and your hacking level; the intent says which is missing. A backdoor takes a quarter of the server's hacking time, and the terminal is busy meanwhile: a purchase that types `buy` waits ("terminal busy") and is tried again 30 s later. A backdoor longer than about 2 minutes may raise the "intent stuck" alert until it ends, for itself and for a purchase waiting behind it. `w0r1d_d43m0n` is refused: its backdoor ends the BitNode, which is `destroyBitNode`'s. `destroyBitNode` takes `{"nextBitNode": 2}` (1 to 15): it destroys the BitNode and enters that one, which resets the game more than an install does (no augmentations, a new BitNode, the Source-File raised). Like an install it waits for two snapshots, a save backup and everything queued before it, and holds what's queued after it for the next BitNode; it also waits, saying which, for The Red Pill installed, root on `w0r1d_d43m0n` and your hacking level at its requirement. With Singularity, where its 33.9 GB worker fits home beside the Agent (a 64 GB home at SF4.3), the game starts the Agent again in the next BitNode. Otherwise it goes through the page: you'll see the terminal's `connect`s and `backdoor`, the BitVerse's cinematic and map, the next BitNode's portal and its "Enter", then `run /agent/boot.js` typed into the terminal, and the Agent closing the Source-File's dialog. A line you've left in the terminal makes it save and reload instead, as for an install (keep the sidebar's Help section open: Options is there). If the BitVerse's portal or the next BitNode's Terminal never comes, it gives up rather than reload from a page with no sidebar: the brain's supervisor relaunches the silent game, or you can reload yourself; the brain counts the destroy only once the game shows it. An intent tried 5 times without success raises an "intent stuck" alert with its last problem ([intents](../packages/brain/README.md#intents)).
- **Factions and their work** (from M4, on `main` until it's released): the brain joins every faction that invites you, but the six city factions (Sector-12, Aevum, …), whose join bans others for the run: those it leaves to you, saying on the dashboard's **Factions** section and in its window what joining each would ban (queue `joinFaction` yourself if you want one). With no work set by you, it then works for the faction whose next augmentation worth having for hacking is nearest, by the game's own reputation formulas: hacking work for CyberSec, for Neurotrainer I first, then the next ([factions and their work](../packages/brain/README.md#factions-and-their-work)). The **Factions** section says what it chose and why ("hacking for CyberSec, for Neurotrainer I (reputation 2 of 1,000, 0.32/s: about 52 min)"), and the **Work** row says "The brain's: …". Work you set always wins; **Stop the brain's faction work** turns it off (kept across restarts of the brain). The work is focused (decision 37), as yours would be, so the game shows the Work page; the hack loop carries on. If its faction's reputation rises under half the work's rate for 10 minutes, the dashboard's `factionWorkStalled` alert says so, the brain logs "faction work STALLED", and the run report fails; a join that fails raises "intent stuck" after 5 tries.
- **Work** (since v0.3.0): the dashboard's **Work** section sets the work the player does: a faction, and hacking, field or security work, or a company and a job field (Waiter, Software, …), or a crime (Shoplift, Mug, …: the Slums are in every city), or a class (a university and a course, or a gym and a stat). To apply for the job, or to start a class, the player must be in the company's, university's or gym's city (queue a travel first); a job already held is worked from anywhere. A paid class is started only with 10 minutes of its cost in hand (the game would let the money go negative); one under way is kept. The Agent applies for the job if need be, starts it and keeps it, focused for full gains (unfocused once the Neuroreceptor Management Implant is installed, and for part-time jobs and classes, which gain nothing from focus), and an action that needs the page unfocuses and refocuses around it. At a company it takes any promotion the game offers in that field (owner decision 44): when the work starts and every 10 minutes it opens the sidebar's Job page for a moment, from any city, and clicks the next title's "Apply" once you qualify; the Work row then says "promoted from … to …", and the brain logs it. **Stop managing work** clears yours: then the brain's faction work goes, if its switch is on, or else the game's work is left as it is. Doing something else yourself is undone within 30 s while the brain manages work.
- **The dashboard** at http://127.0.0.1:12527/ shows the Agent, the snapshots, gaps over the last 24 h, alerts and recent events ([packages/brain](../packages/brain/README.md#the-dashboard)).
  - **Hacking ceiling** (#196): the most the hack loop's servers' RAM could earn a second by hacking at your hacking level now, from the game's formulas: first a batcher's best (the score the coming batcher is judged on) and the target it would be earned on, then any hacker's best, and last the same on all the RAM you've rooted, home's and your own servers' included. Nothing reaches them. **Hacking income** is what hacking actually earned a second over the last 10 minutes, and its part of each ceiling. The hack loop reaches a few percent ([the hacking ceiling](../packages/brain/README.md#the-hacking-ceiling)).
- **Closing the game on purpose?** Pause supervision first, or it's relaunched within 30 s. A pause lasts until you resume it, even across brain restarts, so resume when you're done.
- **Stopping:** Ctrl+C in the brain's terminal stops it for good (no restart). The game keeps running without it; close it yourself if you like. The hack loops keep running too: they're the game's own scripts. Stop the hack loop on the dashboard first if you want them gone.
- **Without the brain (safe mode, since v0.3.0):** whether it's stopped or has crashed, the Agent keeps doing what the brain last asked, for 12 hours from when it was last connected to it, through reloads and new deployments: the hack loop is kept running and the work kept up (refocused within 30 s), and the game's routine dialogs closed. Nothing one-shot happens (no purchases, travel, joins or augmentations), and an install or a new BitNode ends it. On a game version other than the pinned one (after a Steam update), only the hack loop goes on, not the work. The Agent's log says when it starts and until when. **To play by hand,** the easy way is before stopping the brain: click **Stop the brain's faction work** and **Stop managing work** on the dashboard (and stop the hack loop if you want it gone), so that's what the Agent keeps. With the brain already stopped, stop the Agent first: in the game's terminal, `rm agent/desired-state.json`, then `kill` the Agent (`ps` shows it, `agent/<id>/agent.js`). A `kill` alone isn't enough: on the next load autoexec's Agent would carry on from the file. Starting the brain again takes over as usual.
- **Don't run `git clean -x` in this clone:** it deletes `.data/`, with the store and the save backups.
- **Gaps over a window:** `npm run gaps -- --since 2026-10-27T00:00:00Z` ([the gap report](../packages/brain/README.md#the-gap-report)). It also prints the page's heap over the window. For everything else a run did, see [the run report](#after-a-run-the-run-report).
- **Save backups** are in `.data/saves/E0/`: one every 30 minutes and one each time the game connects (on load and on reconnecting), the newest 96 kept. To restore one, follow [the steps](../packages/brain/README.md#save-backups). Stop the brain first, or copy the backup out. Backups are personal data: `.data/` is gitignored, keep it that way.
- **Another data directory:** `npm run brain -- --data-dir <dir>` (or `BITBURNER_AGENT_DATA_DIR`), if you'd rather keep the data elsewhere.

## Upgrading to a new release

Stop the brain, then:

```
git fetch --tags
git checkout v0.3.0                 # or the candidate commit, for a live run
npm run bootstrap
npm run brain
```

The brain builds the new in-game code at start and deploys it when the game connects. The running Agent hands over to the new one by itself. Release notes say if `config.json` needs new fields.

## After a run: the run report

After a live run (or during one), `npm run report` says what the run did and what went wrong, from the brain's store alone, so nobody has to dig through SQLite by hand (owner decision 45). It reads; it never changes anything, so it's safe while the brain runs.

```
npm run report                                                  # from the newest brain start to now
npm run report -- --since 2026-10-28T21:26:00Z --until 2026-10-28T22:40:00Z
```

Times need a `Z` or an offset. **The default window starts at the brain's newest start,** which includes the brain runner's own restart after a crash: the part of the run before it is left out, and the rest can PASS on its own. Section 1 notes an earlier brain start in the day before the window. For a run that spans a restart, give `--since` the run's start.

It prints five sections, then a verdict:

1. **The window:** the brain's starts, the game's relaunches, the deploys and failed deploys, version drift, the Agent's connections and disconnections (with each session's deployment), the save backups and their failures, and the supervisor's failed checks and give-ups, in order.
2. **Progress, first snapshot → last:** money, hacking and the other skills, home RAM and how much of it is in use, the TOR router and port openers, the game's servers rooted, city, factions, jobs, installed augmentations, the BitNode, the Source-Files and the purchased servers; each faction's reputation and favour, first reading → last, the invitations as first seen, and the augmentations queued (#197). Then the hack loop's target over time: inferred from which of the game's servers' money and security moved, so your own scripts would show there too.
3. **Actions:** each intent the Agent was given (the purchases, the backdoors, the joins, your queue), done or not, with its tries, backend and last problem; the work as it changed; promotions; the game's dialogs the Agent closed, with their first words; and the hacker factions' servers (CSEC, avmnite-02h, I.I.I.I, run4theh111z): whether each was backdoored at the start, when it was backdoored, and the faction's invitation the Agent answered after it ("no invitation from CyberSec seen" if none was); and the factions: those joined and when, the invitations left to you, each choice of the brain's faction work with why (its target, reputation and ETA), and the reputation each faction gained while the brain's work was on it.
4. **Health:** the heartbeat's gaps over 6 s (as `npm run gaps`, but from the first heartbeat to the run's last record: the game starting and the run stopping aren't gaps), the page heap, income stalls (money not rising for 10 minutes or more once it first rose; a purchase isn't a rise; one over a heartbeat gap says so), intents tried 5 times or more and not done, backdoors overdue (one of the four rooted, at your level and not backdoored for 5 minutes or more) or asked for again (on a server already backdoored), the brain's faction work stalled (its faction's reputation rising under half the work's rate for 10 minutes or more), dialogs left blocking the page, the faction state unread (each stretch of slow snapshots whose faction state couldn't be read, with why), Agent disconnects with no reconnect within 60 s, and `deployFailed`, `versionDrift` and `supervisionGaveUp` events. A gap or a disconnect names what was recorded during it (a brain start, a relaunch, the Agent reconnecting) and an install or a destroy the Agent was doing before it: a restart in the middle of a run is still a FAIL, but says why. With the hack loop switched off on the dashboard, stalls are shown but don't count: money needn't rise then.
5. **Hacking** (#196): what hacking earned a second (from the game's own count, `getMoneySources`; a relaunch, which loads an older count, earns nothing, and an install starts it again), against the ceilings (the most the hack loop's servers' RAM could earn at the hacking level then, from the game's formulas: a batcher's, and any hacker's). First the best 10 minutes against the batcher's, the figure the coming batcher is judged on; then the window and each hour against both; and the ceilings now, with the target and the RAM they count. Hacking that earned more than any hacker could with all the RAM you've rooted is a failure: the formula (or the count) is wrong, and it's worth an issue. Money the game's servers held at the start, hacked and not grown back, is allowed for.

**The verdict** is `PASS`, or `FAIL` and one line per failure from sections 4 and 5. It exits 0 on PASS, 1 on FAIL, and 2 when it couldn't run (no store, no brain start to begin from, a window that ends before it starts, or nothing recorded in the window). **On a FAIL,** each line has its times: look at that stretch in section 1 (what the brain and the Agent did then) and section 3 (what the Agent was trying), and at the brain's terminal for those times. An income stall usually means the hack loop's target changed or the loop stopped: section 2's target line shows which. Put the report's output on the issue for the run ([packages/brain](../packages/brain/README.md#the-run-report)). **A PASS** means nothing in sections 4 and 5 went wrong while something was recorded. Silence after the run's last record isn't counted (the run stopping looks the same), so an Agent that hung with its connection still open would show only as the heartbeat line's time from the last record to the window's end.

## When something's wrong

- **The dashboard says "Brain unreachable", or doesn't load:** the brain isn't running. If its terminal shows `brain runner:` restart lines, it's crashing at start: the lines before them say why. If the terminal was closed, start it again.
- **A `deployFailed` alert:** the brain couldn't deploy to the game. The alert and the brain's output say why. It retries each time the game connects; Options → Remote API → Connect makes it reconnect now.
- **A `versionDrift` alert:** the game isn't the version this release was built for, usually because Steam updated it. The brain holds: it deploys nothing, restarts no Agent, and gives the hack loop no new instructions (only "Stop the hack loop" still gets through); loops already running keep running. Wait for a release built for the new version.
  - The alert says what differs. If the dashboard's Agent table still says "the pinned one" on its "Version" line, the game's API definitions differ under the same version: tell the developer.
- **A `supervisionGaveUp` alert:** the game was relaunched 3 times in an hour, or the supervisor's checks or launch commands kept failing. Check the game and Steam, then click "Resume supervision".
- **An `agentSilent` alert:** no heartbeat for over a minute. If it lasts, the supervisor relaunches the game after 5 minutes. If the game is running and the Agent isn't, `run agent/boot.js` in the terminal starts it.

## The owner's check

Retired by owner decision 45: M2's manual checklist ([#95](https://github.com/UnderMyBed/bitburner-agent/issues/95), [#94](https://github.com/UnderMyBed/bitburner-agent/issues/94)) is replaced by [the run report](#after-a-run-the-run-report), and supervision's rules are in [packages/brain](../packages/brain/README.md#supervision).
