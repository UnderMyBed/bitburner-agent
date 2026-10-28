# M3's Steam smoke test

One run-through of M3's effectors on your own game on Steam, in an order an early save can follow. Each M3 slice was tested on the real game page in Chromium (E2) and in the simulator. Each slice's issue was then reopened for this check on the shipped game. This page gathers those checks into one sitting (plan [#140](https://github.com/UnderMyBed/bitburner-agent/issues/140), slice 13).

**You run every step yourself.** It's your game. Claude builds the agent but never drives your game or your system.

**For each step:** do what it says, and check you see what it describes. If it holds, close the issue named. If it doesn't, comment on that issue with what you saw and leave it open. Times are approximate: the Agent looks about every 30 s.

**Excluded: a real destroy of a BitNode.** It can't be undone: a destroy can't be tried on a copy and brought back, since saves never flow back to Steam, and BN1's red pill isn't reachable early on anyway. Destroying a BitNode is slice 11b (#175, #177): its simulator suite and E2, through the real page, cover the destroy itself and the restart after it. This checklist only checks that one is held before The Red Pill is installed (step 14), which sends nothing to the game.

## Before you start

- **The code:** `main` at or after [#183](https://github.com/UnderMyBed/bitburner-agent/pull/183)'s merge, which step 15 needs: M3's candidate commit, recorded on [#140](https://github.com/UnderMyBed/bitburner-agent/issues/140) and in [#181](https://github.com/UnderMyBed/bitburner-agent/pull/181). Follow [setup](setup.md) steps 1 to 5, or [upgrade](setup.md#upgrading-to-a-new-release) a clone you already have. On a brand-new save, step 0 below happens inside setup step 4.
- **Your save.** Never reset or edit your real save for this.
  - **Export it first** (Options → Export), and know that the brain's own backups are in `.data/saves/E0/` ([restoring one](../packages/brain/README.md#save-backups)).
  - **Step 16 installs every augmentation you've bought, and resets the run.** That wipes your money, your faction and company reputation (some of it becomes favor), your jobs, TOR and the programs, and every server but home, `pserv-0` included (`Prestige.ts:69-80`). On a save mid-run, do step 16 only when you'd install anyway.
- **A fresh or early save works best.** The class's money guard needs under $72k (a new game starts with $1,000). Later steps need more: $200k for each travel, $1.01m for home RAM, $4m for the augmentation. The hack loop earns it. On a later save, a step whose purchase you already own shows on the dashboard as done or skipped; check what it says, and move on.
- **Keep the sidebar's Hacking, Character, World and Help sections open.** They hold the Terminal, Factions, Augmentations, the City, the Job page and Options.
- **Intents** are queued in the dashboard's Intents section (http://127.0.0.1:12527/): pick the action, give its arguments as JSON, then "Queue it". **Work** is set in the dashboard's Work section.

## 0. The tutorial (only on a brand-new save)

[#168](https://github.com/UnderMyBed/bitburner-agent/issues/168). Skip this step on an existing save. It happens inside [setup](setup.md) step 4: leave the tutorial running at step 4.1 (don't click "Exit Tutorial" yet), do step 4.2 (the Remote API), then:

1. Type `run agent/boot.js` in the terminal. It's refused: "Please follow the tutorial or click 'Exit Tutorial' if you'd like to skip it".
2. Click **Exit Tutorial**, then carry on with setup steps 4.3 and 4.4. The Agent starts as setup says.

#168 is closed on its decision ([below](#decisions)). If this doesn't hold on a brand-new save, reopen it.

## 1. The hack loop

[#134](https://github.com/UnderMyBed/bitburner-agent/issues/134).

The dashboard reads "Hack loop: on, against n00dles, on N servers" (or another target), and the money goes up. Click "Stop the hack loop": the loops stop within a few seconds. Start it again, and leave it on for the rest of the run.

## 2. A class

[#158](https://github.com/UnderMyBed/bitburner-agent/issues/158). Right after step 1, while you're in Sector-12 (where a new game starts) and the money is still low.

1. In the Work section's class form, set **Rothman University / Computer Science** (free), then "Take it". Within about 30 s the Agent opens the City, then Rothman University, and clicks "Study Computer Science (free)". It leaves the class unfocused and goes back to the Terminal. The overview reads "You are studying Computer Science", and the Work row says "converged via ui".
2. Click the overview's "Focus": within 30 s it's unfocused again, without the class starting over.
3. With under $72,000, set **Iron Gym / Strength**: it isn't started, and the Work row gives the money guard's reason. With more money than that, it starts. (Past $72k already? Skip the refusal half.)
4. Set **Crush Fitness Gym / Strength** (in Aevum) while in Sector-12: not started, with a problem saying to travel there first.
5. Set **Rothman University / Computer Science** again: a gym left running costs $120 a second, and Computer Science is free and raises your hacking level toward CSEC's (step 6). Then click "Stop managing work": the class is left as it is.

Close #158 if that holds. Its money guard is decided ([below](#decisions)).

## 3. The hacking programs, in the background

[#136](https://github.com/UnderMyBed/bitburner-agent/issues/136). Needs $200k, then $500k. Steps 3 and 4 happen by themselves as the money comes in: carry on with the next steps, and check these when they happen.

The page switches to the City, buys the TOR router, and returns to the Terminal. Then `buy BruteSSH.exe` and the others are typed into the terminal as the money allows. The Agent's log names any problem.

## 4. Home RAM, in the background

[#138](https://github.com/UnderMyBed/bitburner-agent/issues/138). Needs $1.01m, with TOR and BruteSSH.exe owned (or "Stop buying programs" on).

The page goes to the City, clicks "Upgrade 'home' RAM" at your city's tech vendor, and comes back to the Terminal. Home goes from 8 GB to 16 GB. The dashboard's "Home RAM" section shows home's size and what the next upgrade waits for. "Stop upgrading home RAM" stops it.

## 5. Travel

[#141](https://github.com/UnderMyBed/bitburner-agent/issues/141). Needs $200k.

Queue `travel` with `{"city": "Aevum"}`. The page visits the Travel Agency, confirms, closes the alert, and comes back to the Terminal. The intent leaves the queue.

## 6. A backdoor on CSEC, and CyberSec's invitation

[#162](https://github.com/UnderMyBed/bitburner-agent/issues/162). Needs CSEC rooted (it needs one port: BruteSSH.exe, then the hack loop roots it) and your hacking level at CSEC's requirement (51 to 60).

1. Queue `backdoor` with `{"hostname": "CSEC"}`. Within a few seconds the terminal shows `home`, the `connect`s and `backdoor`, with its input greyed out while the backdoor runs.
2. Meanwhile, queue `buyProgram` with `{"program": "FTPCrack.exe"}` ($1.5m), or have a program purchase due: it says "terminal busy", then buys once the backdoor is done.
3. Within about 30 s of "Backdoor on 'CSEC' successful!", the Agent types `home`, and the intent leaves the queue.

**The dialogs ([#143](https://github.com/UnderMyBed/bitburner-agent/issues/143), first half):** CyberSec's invitation then arrives. The Agent answers it "Decide later", so it waits on the Factions page, and a `gameDialog` event shows on the dashboard.

Close #162 if that holds.

## 7. Joining CyberSec

[#147](https://github.com/UnderMyBed/bitburner-agent/issues/147).

Queue `joinFaction` with `{"faction": "CyberSec"}`. CyberSec has no enemies, so it goes at once. The game switches to Factions, clicks "Join!", and returns to the Terminal. You're in CyberSec, and the intent leaves the queue.

(A city faction, like Sector-12, would first say "not sent: waiting for …", and go out about 20 s later, after a `saveBackup` event. Not needed here.)

## 8. Faction work

[#151](https://github.com/UnderMyBed/bitburner-agent/issues/151). Leave it running until CyberSec's reputation reaches 1,000, for step 9.

1. In the Work section, set **CyberSec** and **hacking**, then "Work at it". Within 30 s the game shows the Work page: "You are currently carrying out hacking contracts for CyberSec". The Work row says "converged via ui".
2. Click "Do something else simultaneously" yourself: within 30 s the Agent focuses again, without restarting the work.
3. Queue `travel` with `{"city": "New Tokyo"}` (step 10 needs it): the Agent unfocuses, travels, and focuses again. New Tokyo has no tech vendor, so a home RAM upgrade waits there (the programs don't, once TOR is owned), and the dashboard says so.

Leave the work on for now. Close #151 after step 10's "Stop managing work".

## 9. A cheap augmentation

[#149](https://github.com/UnderMyBed/bitburner-agent/issues/149). Needs 1,000 CyberSec reputation and $4m. It's also what step 16 installs.

1. Queue `purchaseAugmentation` with `{"faction": "CyberSec", "augmentation": "Neurotrainer I", "level": 1}`.
2. The game switches to Factions, then CyberSec's augmentations, clicks Buy, confirms with Purchase, closes the "You purchased" alert, and returns to the Terminal (or the Work page, focused). The intent leaves the queue, and the Augmentations page lists it as purchased.
3. Queue it again: done at once, with nothing paid.

Close #149 if that holds.

## 10. Company work

[#153](https://github.com/UnderMyBed/bitburner-agent/issues/153). From New Tokyo (step 8).

1. In the Work section's company form, set **Noodle Bar / Waiter** (the defaults), then "Work there".
2. Within about 30 s the Agent opens the City and Noodle Bar, clicks "Apply to be a Waiter", closes the "Congratulations" alert, and clicks "Work". It ends on the Work page: "You are currently working as a Waiter at Noodle Bar". The Work row says "converged via ui".
3. Click "Do something else simultaneously". Within 30 s it's focused again, without a "You finished working for Noodle Bar" alert.
4. Queue `travel` with `{"city": "Aevum"}`, then click "Stop working" there. Within 30 s the Agent opens the sidebar's **Job** page and clicks Noodle Bar's "Work", from Aevum.
5. Optional: travel back to New Tokyo and set **Part-time Waiter**. It replaces Waiter, as the game does. The Agent applies and works it unfocused (no Work page), since focus gains nothing there. From another city it would say "no Noodle Bar in the city (is the player in its city?)".
6. Click "Stop managing work": the work is left as it is.

Close #153 if that holds; close #151 too (step 8). Promotions are step 15.

## 11. Crime

[#156](https://github.com/UnderMyBed/bitburner-agent/issues/156).

1. In the Work section's crime form, choose **Shoplift**, then "Commit it". Within about 30 s the Agent opens the City, then The Slums, and clicks "Shoplift (… chance of success)". It ends on the Work page reading "You are attempting to shoplift", and the Work row says "converged via ui".
2. Click "Do something else simultaneously" (the game goes to the City). Within 30 s it's focused again through the overview's "Focus", without going back to the Slums.
3. Choose **Larceny**: the Agent switches crimes. Leave it for over 90 s: it completes (karma drops), and the next one starts.
4. Click "Stop managing work": the crime is left as it is.

Close #156 if that holds. Then choose **Shoplift** again and "Commit it", for step 13.

## 12. A cloud server

[#159](https://github.com/UnderMyBed/bitburner-agent/issues/159). Needs $500k. No page is used: the game's API does it.

1. Queue `buyServer` with `{"hostname": "pserv-0", "ram": 8}`. Within a round or two it's done: `scan` from home lists `pserv-0`, `free` on it shows 8 GB, and $440k is gone.
2. Queue the same again: done at once, and nothing more is paid.
3. Queue `{"hostname": "n00dles", "ram": 8}`: refused, saying it's a game server's name. `{"hostname": "w0r1d_d43m0n", "ram": 8}`: refused before anything is bought.
4. Queue one you can't afford: `"ram": 1048576` costs about $57.7bn in BN1, so check your money is below that first. It's not done, and the problem gives the price. Cancel it.

Close #159 if that holds.

## 13. A reload, and safe mode

[#143](https://github.com/UnderMyBed/bitburner-agent/issues/143) (second half) and [#160](https://github.com/UnderMyBed/bitburner-agent/issues/160). The Shoplift set at the end of step 11 is the work.

1. **The dialogs:** save (Options → Save Game; F5 doesn't save), then reload the game (F5). After the load, the "Offline for…" alert closes by itself within a couple of seconds, and shows as a `gameDialog` event on the dashboard. Close #143 if that and step 6's invitation held.
2. **Stop the brain** (Ctrl+C). Within about 30 s, click "Do something else simultaneously" in the game. The Agent, with no brain, focuses the crime again. Its log (`tail agent/<deploymentId>/agent.js`, or the script's log window) says "safe mode: no brain: converging on its last desired state, without intents, until …", about 12 hours on.
3. Save, then reload the game (F5). After the reload, autoexec starts the Agent, which picks safe mode up again from `agent/desired-state.json` (`cat` it: the state, with no intents) and keeps the crime focused.
4. **Start the brain again** (`npm run brain`): the Agent reconnects, and the brain's state takes over.
5. To play by hand with the brain stopped: before stopping it, click "Stop managing work" (and stop the hack loop if you want it gone). Or afterwards, `rm agent/desired-state.json`, then `kill` the Agent ([setup](setup.md#day-to-day)).

Close #160 if that holds. Its four choices are decided ([below](#decisions)).

## 14. A destroy, held before The Red Pill

[#175](https://github.com/UnderMyBed/bitburner-agent/issues/175) and [#177](https://github.com/UnderMyBed/bitburner-agent/issues/177). Only the safe half: the brain holds the destroy, so nothing reaches the game. On a save where The Red Pill isn't installed (any early one), with the brain running again (step 13) and the Agent connected, and nothing else in the manual queue.

1. Queue `destroyBitNode` with `{"nextBitNode": 2}`.
2. Within about 10 s, its row (`destroyBitNode(2)`) reads "not sent: held: w0r1d_d43m0n isn't reachable: The Red Pill isn't installed", and stays so. Before the first medium snapshot it may briefly read "not sent: waiting for the guard to hold on 2 consecutive medium snapshots (0 so far)".
3. Leave it a minute. No backup is taken for it: no new `saveBackup` event in the dashboard's Recent events (the brain's own, every 30 minutes, aside). Nothing is typed into the terminal, and the game stays where it is.
4. Click its Cancel: it leaves the queue.

Close #175 and #177 if that holds. A real destroy isn't part of this smoke test, since it can't be undone (above).

## 15. A promotion (it takes a few hours: set it up and leave it)

[#155](https://github.com/UnderMyBed/bitburner-agent/issues/155). The Agent takes any promotion the game offers in the field it works (owner decision 44, [below](#decisions)). Noodle Bar's and Joe's Guns' jobs have one title each, so there's nothing to be promoted to there. The quickest is IT at **Carmichael Security**, in Sector-12: IT Intern wants hacking 75, and IT Analyst hacking 100 and 7,000 reputation with the company (`Company/data/CompanyPositionsMetadata.ts`, plus the company's offset of 74). Focused IT work earns that reputation at about your hacking level ÷ 240 a second, so 2½ hours at hacking 200, 5 hours at 100. Needs hacking 75 or more to start, and 100 for the promotion.

1. In Sector-12 (queue `travel` with `{"city": "Sector-12"}` if you're elsewhere), set **Carmichael Security / IT** in the Work section's company form, then "Work there". Within about 30 s the Agent clicks "Apply for IT Intern Job", closes the "Congratulations" alert, and works it focused: "You are currently working as a IT Intern at Carmichael Security". The Work page shows "Current Company Reputation" and how fast it grows.
2. Queue `travel` with `{"city": "Aevum"}`: the promotion needs no travel back. (Optional; it costs $200k.)
3. Every 10 minutes, the Agent opens the sidebar's **Job** page for a moment, where "Apply for IT Analyst Job" is greyed out until you qualify, and goes back to the Work page, focused, without restarting the work.
4. Leave it. Within 10 minutes of reaching 7,000 reputation, the Agent opens the Job page, clicks "Apply for IT Analyst Job", closes "Congratulations, you are now employed as a IT Analyst at Carmichael Security!", and is back on the Work page: "You are currently working as a IT Analyst at Carmichael Security", with no "You finished working for Carmichael Security" alert. The dashboard's Work row ends "; promoted from IT Intern to IT Analyst", Recent events has a `workPromotion` event, and the brain's terminal says "the Agent took a promotion at Carmichael Security: IT Intern to IT Analyst".
5. Click "Stop managing work": the work is left as it is.

Close #155 if that holds.

## 16. Installing the augmentation, and the restart (last: it resets the game)

[#167](https://github.com/UnderMyBed/bitburner-agent/issues/167) and [#164](https://github.com/UnderMyBed/bitburner-agent/issues/164); this also settles Q5, [#36](https://github.com/UnderMyBed/bitburner-agent/issues/36), on Steam. Needs step 9's Neurotrainer I bought and not yet installed, and the brain running.

1. Optional, to try the fallback instead: type something into the terminal and leave it there (don't press Enter).
2. Queue `installAugmentations` with `{}`. It can't be undone, so it waits for two medium snapshots and a save backup (about 20 s), then goes.
3. The Agent opens the Augmentations page and clicks "Install Augmentations", then "Confirm". The game resets. Within a few seconds a page timer closes the "You slowly drift to sleep…" alert and types `run /agent/boot.js` into the terminal. The terminal shows "Running script with 1 thread…", and the Agent reconnects to the brain.
   - **With the fallback (step 1):** the timer uses Options → "Force kill all active scripts" instead (a save and a reload, about 15 s after the install), and autoexec brings the Agent back.
4. On the dashboard, the install is off the queue (done), and the slow snapshot's installed augmentations include Neurotrainer I.
5. Queue it again, with nothing bought: done at once, and nothing resets.

Close #167 and #164 if that holds, and say on #36 that Q5's answer holds on Steam (and which path you saw).

## Decisions

The owner answered these on 2026-10-28, keeping each as built ([owner decisions](decisions/owner-decisions.md) 38 to 42), and gave 44 before it was built.

- **[#158](https://github.com/UnderMyBed/bitburner-agent/issues/158), the class money guard** (decision 38, [PR #163](https://github.com/UnderMyBed/bitburner-agent/pull/163)): a paid class starts only with 10 minutes of its cost in hand ($72,000 for Iron Gym), since the game would let the money go negative. One under way is left alone.
- **[#160](https://github.com/UnderMyBed/bitburner-agent/issues/160), safe mode** (decision 39, [PR #165](https://github.com/UnderMyBed/bitburner-agent/pull/165)):
  1. `ttlMs` is 12 hours, from the last moment connected to the brain that sent the state;
  2. taking over by hand with the brain stopped means `rm agent/desired-state.json`, then `kill` the Agent;
  3. a brain that connects and holds gets #134's rule: the Agent waits for that brain's word, and safe mode resumes only if it goes again;
  4. a holding brain's state passes `ttlMs` on, so the Agent keeps it in safe mode too.
- **[#168](https://github.com/UnderMyBed/bitburner-agent/issues/168), no tutorial page check** (decision 40, [PR #170](https://github.com/UnderMyBed/bitburner-agent/pull/170)): the tutorial stays your one click on a new game, and the Agent doesn't check the page for it. It can only run during the tutorial after your own Options → "Reset tutorial".
- **[#153](https://github.com/UnderMyBed/bitburner-agent/issues/153), part-time work unfocused** (decision 41, [PR #154](https://github.com/UnderMyBed/bitburner-agent/pull/154)): part-time jobs are worked unfocused, as classes are, since focus gains them nothing (`Work/CompanyWork.tsx:36`). It's the exception to decision 37.
- **[#162](https://github.com/UnderMyBed/bitburner-agent/issues/162), the backdoor** (decision 42, [PR #171](https://github.com/UnderMyBed/bitburner-agent/pull/171)): the terminal is sent `home` after a backdoor, even if you'd connected elsewhere first. A backdoor longer than about 2 minutes raises the "intent stuck" alert until it's done, as would a purchase held behind it.
- **[#155](https://github.com/UnderMyBed/bitburner-agent/issues/155), promotions** (decision 44, on Claude's recommendation): the Agent takes any promotion the game offers in the field of the company work, and the planner will choose the company and field, not the title. No travel: the Job page works from any city (step 15).
