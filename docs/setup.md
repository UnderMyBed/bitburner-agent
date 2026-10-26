# Setup

The one-time steps that make the agent run unattended on your Windows machine, with Bitburner on Steam ([#95](https://github.com/UnderMyBed/bitburner-agent/issues/95); architecture §10.1, §10.2). Afterwards, one scheduled task starts the brain at logon. The brain launches the game, deploys the in-game Agent, and keeps both going.

**You run these steps yourself.** They change your machine and your game. Claude builds the agent but never drives your game or your system.

## Before you start

- Windows, with Steam and Bitburner installed (Steam app 1812820).
- [Node.js 24](https://nodejs.org/), [PowerShell 7](https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-windows) (`pwsh`), and git.
- A folder on a non-system drive for the brain's data: its store, save backups and log ([ADR 0006](decisions/0006-tech-stack-and-compute.md)). Below it's `D:\bitburner-agent`.

## 1. Check out a release

Only tagged releases go to Steam (architecture §6). In a folder of your choice:

```
git clone --recurse-submodules https://github.com/UnderMyBed/bitburner-agent.git
cd bitburner-agent
git checkout v0.2.0
git submodule update --init
npm ci
```

The brain needs the `vendor/bitburner-src` submodule: it checks the game's version against it, and stops at start if it's missing.

## 2. Install the brain's task

```
npm run setup:windows -- -DataDir D:\bitburner-agent
```

This registers one task, "bitburner-agent brain", for you. It runs at logon, with no time limit, also on battery. It runs `tools/setup/run-brain.ps1`, which runs the brain and restarts it 10 s after it stops for any reason.
- Add `-WhatIf` to see what it would register without changing anything.
- Running it again replaces the task, so there is only ever one.
- To remove it: `npm run setup:windows -- -Uninstall`.

Start it now, rather than at your next logon:

```
Start-ScheduledTask -TaskName 'bitburner-agent brain'
```

**What happens next.** The brain:
- builds the in-game code (a few seconds);
- creates `D:\bitburner-agent\config.json`;
- serves the dashboard at **http://127.0.0.1:12527/**;
- **launches Bitburner through Steam within 30 s**.

## 3. Pause supervision while you set up

**Open http://127.0.0.1:12527/ and click "Pause supervision" straight away.** The brain kills and relaunches a game that has no Agent reporting for about 5 minutes. Until you've finished the steps below, no Agent reports.

## 4. Set the game up

1. **A brand-new save:** click "Exit Tutorial" first. (From M3 the agent will do this itself, architecture §5.7.)
2. **Options → Remote API:**
   - address `127.0.0.1` (not the default `localhost`: the brain listens on 127.0.0.1 only);
   - port `12525`;
   - reconnection delay `5` (above 0, so the game reconnects when the brain restarts);
   - then click **Connect**. Changing the settings alone doesn't connect.

   The dashboard's **Recent events** should show `deployed` (or `deploymentCurrent`) and a `saveBackup` within a few seconds.
3. **Options → System:** set autoexec to `agent/boot.js`. Autoexec runs on every load of a saved game, so after this the Agent starts by itself.
4. **First start of the Agent:** in the game's terminal, type `run agent/boot.js` once. Autoexec can't do this first start: it ran when the game loaded, before the brain had deployed.

   The dashboard's **Agent** table shows "Connected: yes" with the deployment, and the tiers start arriving.

If the dashboard lists rejected connections, the game's page sent an origin the brain doesn't allow. Add the origin the event shows to `allowedOrigins` in `D:\bitburner-agent\config.json`, then end and start the task. Steam's page is `file://` by default.

## 5. Resume supervision

Click **"Resume supervision"**. From now on the brain relaunches the game if it closes, or if the Agent goes silent for 5 minutes. It does so at most 3 times an hour; after that it stops and shows an alert.

The skeleton now runs unattended. A reboot or logon brings it all back: the task starts the brain, the brain launches the game, and autoexec starts the Agent.

## Day to day

- **The dashboard** at http://127.0.0.1:12527/ shows the Agent, the snapshots, gaps over the last 24 h, alerts and recent events ([packages/brain](../packages/brain/README.md#the-dashboard)).
- **Closing the game on purpose?** Pause supervision first, or it's relaunched within 30 s.
- **The brain's log** is `D:\bitburner-agent\brain.log`. It holds every brain start and restart, and every event except snapshots. It isn't rotated yet.
- **Gaps over a window:** `npm run gaps -- --data-dir D:\bitburner-agent --since 2026-10-27T00:00:00Z` ([the gap report](../packages/brain/README.md#the-gap-report)).
- **Save backups** are in `D:\bitburner-agent\saves\E0\`: one every 30 minutes and on each game load, the newest 96 kept. To restore one, follow [the steps](../packages/brain/README.md#save-backups). Stop the brain first, or copy the backup out. Backups are personal data: keep them out of any repository.
- **Stopping the brain for good:** stop the task, then end the brain's `node` if it's still running. Ending only the task may leave the brain running; ending only `node` isn't enough, because `run-brain.ps1` starts it again in 10 s:

  ```
  Stop-ScheduledTask -TaskName 'bitburner-agent brain'
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object CommandLine -like '*packages\brain\src\main.ts*' |
    ForEach-Object { Stop-Process -Id $_.ProcessId }
  ```

  The game keeps running without it; close it yourself if you like. Start it again with `Start-ScheduledTask -TaskName 'bitburner-agent brain'`.

## Upgrading to a new release

Stop the brain as above, then:

```
git fetch --tags
git checkout v0.3.0
git submodule update --init
npm ci
Start-ScheduledTask -TaskName 'bitburner-agent brain'
```

The brain builds the new in-game code at start and deploys it when the game connects. The running Agent hands over to the new one by itself. Release notes say if `config.json` needs new fields.

## When something's wrong

- **The brain keeps restarting:** read the end of `brain.log`. A `config.json` the brain doesn't accept names the field and what it should be.
  - A config written by an earlier brain may lack fields added since. Add them as the message says (the defaults are in [the brain's README](../packages/brain/README.md#the-data-directory)), or move the old data directory aside and start fresh.
- **A `versionDrift` alert:** the game isn't the version this release was built for, usually because Steam updated it. The brain holds: it deploys nothing and restarts no Agent. Wait for a release built for the new version.
  - If the alert names the commit, for example `commit DEV`, tell the developer. It means Steam's build reports its version differently from what the release expects.
- **A `supervisionGaveUp` alert:** the game was relaunched 3 times in an hour, or a launch command kept failing. Check the game and Steam, then click "Resume supervision".
- **An `agentSilent` alert:** no heartbeat for over a minute. If it lasts, the supervisor relaunches the game after 5 minutes. If the game is running and the Agent isn't, `run agent/boot.js` in the terminal starts it.

## The owner's check

Before relying on it, check on your machine, and record what you saw on [#95](https://github.com/UnderMyBed/bitburner-agent/issues/95) (and [#94](https://github.com/UnderMyBed/bitburner-agent/issues/94) for supervision):
- Install the task and log off and on: the brain starts and launches the game.
- Set the in-game options: the game connects, and the dashboard shows the Agent reporting. Note the origin Steam sent, from the dashboard's events or the brain's log.
- End the `node` process in Task Manager: the brain is back within a minute.
- Stop the task: note whether the brain's `node` stopped with it, or needed the second command in "Stopping the brain for good".
- Note what the dashboard shows for the game's commit (the Agent table's "Game" line).
