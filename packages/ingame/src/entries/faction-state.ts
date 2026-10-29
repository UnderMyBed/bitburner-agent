// agent/<deploymentId>/faction-state.js: a home worker that reads the faction state from the game's page (#197), the
// `ui` backend's reader: each joined faction's reputation and favour, the invitations and the queued augmentations,
// which no NS call has before Singularity. The Agent runs it with each slow snapshot. Arguments: the read's context as
// JSON (`FactionReadContext`: the last reading, and what the Agent saw happen since), and when to give up (the game's
// `Date.now()`).
// - First, without moving the page: the worked faction's reputation from its prop, and the sidebar's counts. The pages
//   are opened only for what may have changed (../page/faction-state-page.ts, `pagesToOpen`); otherwise the last
//   reading stands, with that reputation, and the page isn't touched.
// - A page to open with no sidebar to reach it by (the BitVerse, an infiltration), and the player not on the Work page,
//   or with the casino open (leaving it mid-hand forfeits a blackjack bet): skipped this time, which isn't a problem.
// - Otherwise around the steps, `reportPageEffect` (../page/page-effect.ts): never over an owner's dialog, focused work
//   unfocused for them and focused again, and any other page gone back to as found (its sidebar item, or a faction's
//   own page), not left on the Terminal.
// RAM: `getPlayer` 0.5 + `getResetInfo` 1.0 (ram-budget.json); the page costs nothing.
import { type FactionState, NEUROFLUX_GOVERNOR } from "@bitburner-agent/core";
import type { NS } from "../ns.ts";
import {
  casinoShown,
  type FactionGameFacts,
  type FactionPageMemory,
  type FactionReadContext,
  factionStatePageProblems,
  focusedOnWork,
  readFactionStateOnPage,
  readMovesThePage,
  sidebarFacts,
  workedFactionReputation,
} from "../page/faction-state-page.ts";
import { openGamePage } from "../page/game-page.ts";
import { reportPageEffect } from "../page/page-effect.ts";
import { reportToAgent } from "../workers/report-to-agent.ts";

/** The context the Agent passed, or a first read's where it can't be read (a first read reads everything). */
function contextOf(text: unknown): FactionReadContext {
  try {
    const context = JSON.parse(String(text)) as FactionReadContext;
    if (typeof context === "object" && context !== null) return context;
  } catch {}
  return { memory: null, invitationAnswered: false, augmentationBought: false };
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const context = contextOf(ns.args[0]);
  const deadlineMs = Number(ns.args[1] ?? 0);
  const resetInfo = ns.getResetInfo();
  const game: FactionGameFacts = {
    joined: ns.getPlayer().factions,
    lastAugReset: resetInfo.lastAugReset,
    installedNeuroFluxLevel: resetInfo.ownedAugs.get(NEUROFLUX_GOVERNOR) ?? 0,
    nowMs: Date.now(),
  };
  const read: { state: FactionState | null; opened: string[]; memory: FactionPageMemory | null } = {
    state: null,
    opened: [],
    memory: null,
  };
  const reportAlso = () => ({ state: read.state, opened: read.opened, memory: read.memory });
  const gamePage = openGamePage(ns, deadlineMs);
  const worked = gamePage === null ? null : workedFactionReputation(gamePage);
  const facts = gamePage === null ? null : sidebarFacts(gamePage);
  if (gamePage !== null && facts !== null && !readMovesThePage(context, game, facts)) {
    // Nothing to open: the last reading, with the worked faction's reputation, and the page untouched.
    const problem = await readFactionStateOnPage(gamePage, context, game, worked, read);
    return reportToAgent(ns, { done: read.state !== null, problem, ...reportAlso() });
  }
  // Skipped, which isn't a problem: no sidebar to reach a page by, or the casino, where leaving loses a hand.
  const skipped =
    gamePage === null || facts === null
      ? null
      : casinoShown(gamePage)
        ? factionStatePageProblems.casino
        : !facts.sidebar && !focusedOnWork(gamePage)
          ? factionStatePageProblems.noSidebar
          : null;
  if (skipped !== null) {
    return reportToAgent(ns, { done: false, problem: null, skipped, state: context.memory?.state ?? null });
  }
  await reportPageEffect(ns, deadlineMs, {
    isDone: () => read.state !== null,
    doing: "read the faction state through",
    steps: (page, { wasFocused }) => readFactionStateOnPage(page, context, game, worked, read, { wasFocused }),
    // Never reported: the steps return null only once they've read it.
    notDoneAfter: "the faction state wasn't read",
    reportAlso,
    restoreFoundPage: true,
  });
}
