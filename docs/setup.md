# Setup

How to run the agent against Bitburner on Steam, from a clone of this repository ([#95](https://github.com/UnderMyBed/bitburner-agent/issues/95), [#122](https://github.com/UnderMyBed/bitburner-agent/issues/122); architecture §10.1, §10.2). The brain runs from the repo, in a terminal, and is started again if it crashes. It launches the game, deploys the in-game Agent, and keeps both going while it runs.

**Nothing is installed.** There's no service, no scheduled task and no standalone binary (owner decision 30). Everything the brain writes goes in the repo's gitignored `.data/`: its config (with the control channel's token), the store, the in-game build and the save backups, unless you give it another data directory (below). npm's own download cache is the one exception. To stop it, stop the brain. To remove it, delete the clone, after copying out any save backups in `.data/saves/` you want to keep.

**You run these steps yourself.** They act on your game. Claude builds the agent but never drives your game or your system.

## Before you start

- Windows, with Steam and Bitburner installed (Steam app 1812820).
- [Node.js 24](https://nodejs.org/) and git.
- **One brain, one game.** The brain serves one game on the fixed ports 12525–12527: run one brain at a time, and don't point a second game at it.

## 1. Clone and bootstrap

Only tagged releases go to Steam (architecture §6). Clone the repository and check out the newest release tag. `v0.2.0`, the first with these steps, is the example below.

For [the owner's check](#the-owners-check) or a release's own Steam soak ([#99](https://github.com/UnderMyBed/bitburner-agent/issues/99)), check out the candidate commit instead. It's recorded on the milestone's review issue. Then follow [this page as it is on `main`](https://github.com/UnderMyBed/bitburner-agent/blob/main/docs/setup.md), not the copy in your checkout: docs fixed after the candidate are only there.

**Already have a clone?** Use it, except for the owner's check, which starts from a new one. Stop its brain if it's running, then follow [Upgrading to a new release](#upgrading-to-a-new-release) with the tag or commit you want. That ends with step 2's `npm run brain`, so carry on at step 3. Its `.data/`, if it has one, carries over: the config, the store and the save backups.

```
git clone https://github.com/UnderMyBed/bitburner-agent.git
cd bitburner-agent
git checkout v0.2.0
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

1. **A brand-new save:** click "Exit Tutorial" first. (From M3 the agent will do this itself, architecture §5.7.)
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

- **The dashboard** at http://127.0.0.1:12527/ shows the Agent, the snapshots, gaps over the last 24 h, alerts and recent events ([packages/brain](../packages/brain/README.md#the-dashboard)).
- **Closing the game on purpose?** Pause supervision first, or it's relaunched within 30 s. A pause lasts until you resume it, even across brain restarts, so resume when you're done.
- **Stopping:** Ctrl+C in the brain's terminal stops it for good (no restart). The game keeps running without it; close it yourself if you like.
- **Don't run `git clean -x` in this clone:** it deletes `.data/`, with the store and the save backups.
- **Gaps over a window:** `npm run gaps -- --since 2026-10-27T00:00:00Z` ([the gap report](../packages/brain/README.md#the-gap-report)). It also prints the page's heap over the window.
- **Save backups** are in `.data/saves/E0/`: one every 30 minutes and one each time the game connects (on load and on reconnecting), the newest 96 kept. To restore one, follow [the steps](../packages/brain/README.md#save-backups). Stop the brain first, or copy the backup out. Backups are personal data: `.data/` is gitignored, keep it that way.
- **Another data directory:** `npm run brain -- --data-dir <dir>` (or `BITBURNER_AGENT_DATA_DIR`), if you'd rather keep the data elsewhere.

## Upgrading to a new release

Stop the brain, then:

```
git fetch --tags
git checkout v0.3.0                 # or the candidate commit, for a check or a soak
npm run bootstrap
npm run brain
```

The brain builds the new in-game code at start and deploys it when the game connects. The running Agent hands over to the new one by itself. Release notes say if `config.json` needs new fields.

## When something's wrong

- **The dashboard says "Brain unreachable", or doesn't load:** the brain isn't running. If its terminal shows `brain runner:` restart lines, it's crashing at start: the lines before them say why. If the terminal was closed, start it again.
- **A `deployFailed` alert:** the brain couldn't deploy to the game. The alert and the brain's output say why. It retries each time the game connects; Options → Remote API → Connect makes it reconnect now.
- **A `versionDrift` alert:** the game isn't the version this release was built for, usually because Steam updated it. The brain holds: it deploys nothing and restarts no Agent. Wait for a release built for the new version.
  - If the alert names the commit, for example `commit DEV`, tell the developer. It means Steam's build reports its version differently from what the release expects.
- **A `supervisionGaveUp` alert:** the game was relaunched 3 times in an hour, or the supervisor's checks or launch commands kept failing. Check the game and Steam, then click "Resume supervision".
- **An `agentSilent` alert:** no heartbeat for over a minute. If it lasts, the supervisor relaunches the game after 5 minutes. If the game is running and the Agent isn't, `run agent/boot.js` in the terminal starts it.

## The owner's check

Before relying on it, check it on your machine, on the candidate commit (step 1). Do these checks in order, and record what you saw on [#95](https://github.com/UnderMyBed/bitburner-agent/issues/95) (checks 1–5) and [#94](https://github.com/UnderMyBed/bitburner-agent/issues/94) (check 6). Times are approximate: the supervisor looks every 30 s.

1. **From a new clone:** setup steps 1 and 2, in a new folder, even if you already have a clone. Stop any other clone's brain first: the ports are fixed. The brain starts, and if the game isn't open, it launches it about 30 s later (a `relaunch` event, cause `notRunning`). Note anything you had to install or set up outside the repo: there should be nothing beyond Node, git and Steam. Note, too, how long Steam took to open the game.
2. **Setting the game up:** setup steps 3 to 5. The game connects, and the dashboard shows the Agent reporting. Steam's origin isn't logged when it's accepted: if it connected with the default `allowedOrigins`, record `file://`; otherwise record the origin you added.
3. **The game's commit:** note what the dashboard's Agent table shows on its "Game" line.
4. **Stopping and starting the brain:** Ctrl+C, then `npm run brain` again. The game's Remote API reconnects within a few seconds (its reconnection delay is 5 s), and the Agent reports again.
5. **A brain crash:** in Task Manager, end the brain's own `node` process: the one whose command line has `packages\brain\src\main.ts`, not `start.ts`. To see command lines, open the Details page in the left-hand menu, right-click a column header, then Select columns → Command line. A `brain runner:` line says the brain exited and restarts in 5 s. The brain's own start lines follow, and the game reconnects.
6. **Supervision (#94).** Checks 6.1 and 6.2 each launch the game. With the brain's launch in check 1, that's 3 launches, the most allowed in an hour, so do check 6 once, in one go. If a launch within the hour would be a 4th (a part repeated, say), the supervisor gives up instead, with a `supervisionGaveUp` alert. That's the rate limit working: click "Resume supervision", which starts the count afresh, and carry on.
   1. **Close the game.** Within about 30 s it's relaunched (cause `notRunning`). Wait until the Agent reports again: autoexec starts it.
   2. **Kill the Agent** in the game's terminal: `kill agent/<id>/agent.js`, where `<id>` is the "Deployment" in the dashboard's Agent table. Once the Agent has been silent for 5 minutes, the game is killed and relaunched (cause `silent`), and the Agent comes back through autoexec. That's never sooner than 10 minutes after the last launch, which leaves 5 minutes for Steam to start the game and 5 for the Agent to boot. So expect it about 10 minutes after check 6.1's relaunch, or 5 minutes after you kill the Agent, whichever is later.
   3. **Pause supervision, then close the game.** Wait a couple of minutes: no `relaunch` event appears. Then start the game from Steam yourself, and once it's open, resume. (Resuming while it's still closed would launch it: a 4th launch if check 1 launched the game, so the supervisor would give up as above.)

**Afterwards,** the dashboard should show supervision running and the Agent connected. For a release's soak, that's the time to take `<start>` from. Leave it running for 24 h with the PC awake ([releasing step 2](releasing.md)).
