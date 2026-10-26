# Setup

The one-time steps that make the agent run unattended on your Windows machine, with Bitburner on Steam ([#95](https://github.com/UnderMyBed/bitburner-agent/issues/95); architecture §10.1, §10.2). Afterwards, one scheduled task starts the brain at logon. The brain launches the game, deploys the in-game Agent, and keeps both going.

**You run these steps yourself.** They change your machine and your game. Claude builds the agent but never drives your game or your system.

## Before you start

- Windows, with Steam and Bitburner installed (Steam app 1812820).
- [Node.js 24](https://nodejs.org/), on your user or system `PATH`: the task runs without your PowerShell profile, so `node` set up only there isn't found.
- [PowerShell 7.2 or later](https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-windows) (`pwsh`), installed with winget or the MSI, not from the Microsoft Store. The task runs the `pwsh` you install it from, and a Store install moves to a new folder at every update. The installer refuses one.
- git.
- A folder on a non-system drive for the brain's data: its store, save backups and log ([ADR 0006](decisions/0006-tech-stack-and-compute.md)). Below it's `D:\bitburner-agent`.
- **One brain, one game.** The brain serves one game on the fixed ports 12525–12527. Don't run `npm run brain` yourself while the task runs, and don't point a second game at it.

## 1. Check out a release

Only tagged releases go to Steam (architecture §6). In a folder of your choice, check out the newest release tag. `v0.2.0`, the first with this setup, is the example below. For a release's own Steam soak ([#99](https://github.com/UnderMyBed/bitburner-agent/issues/99)) and the owner's check below, check out the candidate commit you were given instead.

```
git clone --recurse-submodules https://github.com/UnderMyBed/bitburner-agent.git
cd bitburner-agent
git checkout v0.2.0
git submodule update --init
npm ci
```

The brain needs the `vendor/bitburner-src` submodule: it checks the game's version against it, and stops at start if it's missing.

## 2. Install the brain's task

Run this from PowerShell 7 (`pwsh`), with an absolute data directory:

```
npm run setup:windows -- -DataDir D:\bitburner-agent
```

This registers one task, "bitburner-agent brain", for you. It runs at logon, at normal priority, with no time limit, also on battery. It runs `tools/setup/run-brain.ps1`, which runs the brain and restarts it 10 s after it stops for any reason.
- Add `-WhatIf` to see the task it would register without changing anything.
- Running it again replaces the task, so there is only ever one. Do this after an upgrade too, in case the task changed.
- To remove it: `npm run setup:windows -- -Uninstall`. That stops the task and removes it; end the brain's `node` afterwards if it's still running ([Stopping the brain for good](#stopping-the-brain-for-good)).

**A data directory from an earlier brain** may hold a `config.json` without fields added since: `saveBackupIntervalMinutes`, `saveBackupsKept`, `steamAppId`, `gameExecutable`. The brain then refuses to start, again every 10 s. Add them with their defaults ([the brain's README](../packages/brain/README.md#the-data-directory)) before starting the task, or use a new data directory.

Start it now, rather than at your next logon:

```
Start-ScheduledTask -TaskName 'bitburner-agent brain'
```

**What happens next.** The brain:
- builds the in-game code (a few seconds);
- creates `D:\bitburner-agent\config.json`, the first time;
- serves the dashboard at **http://127.0.0.1:12527/**;
- **launches Bitburner through Steam within 30 s**.

If the dashboard doesn't load within a minute, read the end of the log:

```
Get-Content D:\bitburner-agent\brain.log -Tail 40
```

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
   - Copy the origin from the event, without the ` (Remote File API)` the brain adds after it, into `allowedOrigins` in `D:\bitburner-agent\config.json`. Never add `(none)`: that's a connection with no origin at all, not a page.
   - Then restart the brain: [stop it](#stopping-the-brain-for-good) and start the task.
3. **Options → System:** set "Autoexec Script + Args" to `agent/boot.js`. Autoexec runs on every load of a saved game, so after this the Agent starts by itself.
4. **First start of the Agent:** in the game's terminal, type `run agent/boot.js` once. Autoexec can't do this first start: it ran when the game loaded, before the brain had deployed.

   The dashboard's **Agent** table shows "Connected: yes" with the deployment, and the tiers start arriving.
5. **Save the game** (Options → Save Game), or wait for an autosave. The game keeps its settings in the save, so settings changed after the last save are lost if the game is relaunched.

## 5. Resume supervision

Click **"Resume supervision"**. From now on the brain relaunches the game if it closes, or if the Agent goes silent for 5 minutes. It does so at most 3 times an hour; after that it stops and shows an alert.

The skeleton now runs unattended. A reboot or logon brings it all back: the task starts the brain, the brain launches the game, and autoexec starts the Agent.

## Day to day

- **The dashboard** at http://127.0.0.1:12527/ shows the Agent, the snapshots, gaps over the last 24 h, alerts and recent events ([packages/brain](../packages/brain/README.md#the-dashboard)).
- **Closing the game on purpose?** Pause supervision first, or it's relaunched within 30 s. A pause lasts until you resume it, even across brain restarts, so resume when you're done.
- **The brain's log** is `D:\bitburner-agent\brain.log`. It holds each brain start and restart (with the `node` used), the brain's startup lines and errors, and the bridge's events: connections, deploys, save backups, but not snapshots. The supervisor's relaunches and give-ups are on the dashboard, not in the log. The log isn't rotated yet.
- **Gaps over a window:** `npm run gaps -- --data-dir D:\bitburner-agent --since 2026-10-27T00:00:00Z` ([the gap report](../packages/brain/README.md#the-gap-report)).
- **Save backups** are in `D:\bitburner-agent\saves\E0\`: one every 30 minutes and one each time the game connects (on load and on reconnecting), the newest 96 kept. To restore one, follow [the steps](../packages/brain/README.md#save-backups). Stop the brain first, or copy the backup out. Backups are personal data: keep them out of any repository.

### Stopping the brain for good

Stop the task, then end the brain's `node` processes. Stopping the task ends `run-brain.ps1` but may leave the brain running; ending only `node` isn't enough, because `run-brain.ps1` starts it again in 10 s. Don't end `node` from Task Manager: a version manager's shim can show two `node.exe` processes, and other programs run `node` too. This ends just the brain's:

```
Stop-ScheduledTask -TaskName 'bitburner-agent brain'
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object CommandLine -like '*packages\brain\src\main.ts*' |
  ForEach-Object { Stop-Process -Id $_.ProcessId }
```

The game keeps running without it; close it yourself if you like. Start it again with `Start-ScheduledTask -TaskName 'bitburner-agent brain'`.

Stopping it this way lasts until your next logon. To keep it off across logons, also run `Disable-ScheduledTask -TaskName 'bitburner-agent brain'` (`Enable-ScheduledTask` undoes it), or remove the task.

## Upgrading to a new release

[Stop the brain](#stopping-the-brain-for-good), then:

```
git fetch --tags
git checkout v0.3.0
git submodule update --init
npm ci
npm run setup:windows -- -DataDir D:\bitburner-agent
Start-ScheduledTask -TaskName 'bitburner-agent brain'
```

The brain builds the new in-game code at start and deploys it when the game connects. The running Agent hands over to the new one by itself. Release notes say if `config.json` needs new fields.

## When something's wrong

- **The dashboard says "Brain unreachable", or doesn't load:** the brain isn't running, or keeps restarting. Read the end of `brain.log` (step 2). A `config.json` the brain doesn't accept names the field and what it should be; a config from an earlier brain may lack fields (step 2).
- **A `deployFailed` alert:** the brain couldn't deploy to the game. The alert and `brain.log` say why. It retries each time the game connects; Options → Remote API → Connect makes it reconnect now.
- **A `versionDrift` alert:** the game isn't the version this release was built for, usually because Steam updated it. The brain holds: it deploys nothing and restarts no Agent. Wait for a release built for the new version.
  - If the alert names the commit, for example `commit DEV`, tell the developer. It means Steam's build reports its version differently from what the release expects.
- **A `supervisionGaveUp` alert:** the game was relaunched 3 times in an hour, or the supervisor's checks or launch commands kept failing. Check the game and Steam, then click "Resume supervision".
- **An `agentSilent` alert:** no heartbeat for over a minute. If it lasts, the supervisor relaunches the game after 5 minutes. If the game is running and the Agent isn't, `run agent/boot.js` in the terminal starts it.

## The owner's check

Before relying on it, check on your machine, and record what you saw on [#95](https://github.com/UnderMyBed/bitburner-agent/issues/95) (and [#94](https://github.com/UnderMyBed/bitburner-agent/issues/94) for supervision):
- **Install:** run the install twice; Task Scheduler shows one "bitburner-agent brain" task. Log off and on: the brain starts and launches the game. Note whether a console window shows, or flashes, at logon.
- **The game's options** (step 4): the game connects, and the dashboard shows the Agent reporting. Steam's origin isn't logged when it's accepted: if it connected with the default `allowedOrigins`, record `file://`; otherwise record the origin you added.
- **The restart loop:** end the brain's `node` with the second command in [Stopping the brain for good](#stopping-the-brain-for-good) (not the task): the brain is back within a minute, and `brain.log` shows the restart and the `node` it used.
- **Stopping:** stop the task, and note whether the brain's `node` stopped with it or needed the second command.
- **Supervision (#94):**
  - close the game: within about 30 s it's relaunched (a `relaunch` event, cause `notRunning`), and the Agent reports again;
  - kill the Agent in the game's terminal (`kill agent/<id>/agent.js`, the deployment's folder): after about 5 minutes with no heartbeat, the game is killed and relaunched (cause `silent`), and the Agent comes back through autoexec;
  - pause supervision and close the game: it stays closed until you resume.
- **The game's commit:** note what the dashboard's Agent table shows on its "Game" line.
- **Removing:** `npm run setup:windows -- -Uninstall` stops and removes the task; check no brain `node` is left (the command above finds none). Then install again to carry on.
