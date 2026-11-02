// The `singularity` backend's donation (#225): its steps on a stand-in for the game's two calls. The simulator's
// effector-backends suite runs the worker itself against the engine.
import { expect, test } from "vitest";
import { donateThroughSingularity } from "../../src/workers/singularity-donation.ts";

/** The game: CyberSec's reputation, and what a donation does to it (refused: nothing). */
function game(reputation: number, { refuses = false, gives = 13_750 } = {}) {
  const state = { reputation, donations: 0 };
  return {
    state,
    calls: {
      factionReputation: () => state.reputation,
      makeDonation: () => {
        if (refuses) return false;
        state.donations += 1;
        state.reputation += gives;
        return true;
      },
    },
  };
}
const DONATION = { faction: "CyberSec", amount: 13_750_000_000, reputation: 18_750 };

test("short of the reputation: one donation, done once the reputation is there", () => {
  const { state, calls } = game(5_000);
  expect(donateThroughSingularity(calls, DONATION)).toEqual({ done: true, problem: null });
  expect(state.donations).toBe(1);
});

test("the reputation already there (a donation made before, its report lost): done, nothing donated", () => {
  const { state, calls } = game(18_750);
  expect(donateThroughSingularity(calls, DONATION)).toEqual({ done: true, problem: null });
  expect(state.donations).toBe(0);
});

test("refused, or donated and still short: not done, saying which", () => {
  expect(donateThroughSingularity(game(5_000, { refuses: true }).calls, DONATION)).toEqual({
    done: false,
    problem:
      "the game refused $13750000000 to CyberSec (joined? its favour? the money? a gang's, or one with no work?)",
  });
  expect(donateThroughSingularity(game(5_000, { gives: 1 }).calls, DONATION)).toEqual({
    done: false,
    problem: "CyberSec's reputation isn't 18750 after the donation",
  });
});
