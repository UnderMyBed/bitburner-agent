// The `singularity` backend's donation (#225), for `singularity-donate-to-faction.js` (../entries/): a module of its
// own so its test can run it (an entry's bundle exports only `main`). The game's calls come in as functions, so the
// entry's RAM is only theirs.
// - The game first: the faction's reputation already the donation's is done, with nothing donated.
// - `donateToFaction` refuses what the page would (not a member, the gang's faction, one with no work, the money, the
//   favour: `NetscriptFunctions/Singularity.ts:925-964`), returning false.
import type { EffectorReport } from "@bitburner-agent/core";

export function donateThroughSingularity(
  game: { factionReputation: () => number; makeDonation: () => boolean },
  { faction, amount, reputation }: { faction: string; amount: number; reputation: number },
): EffectorReport {
  const report: EffectorReport = { done: game.factionReputation() >= reputation, problem: null };
  if (report.done) return report;
  const donated = game.makeDonation();
  report.done = game.factionReputation() >= reputation;
  if (!report.done) {
    report.problem = donated
      ? `${faction}'s reputation isn't ${reputation} after the donation`
      : `the game refused $${amount} to ${faction} (joined? its favour? the money? a gang's, or one with no work?)`;
  }
  return report;
}
