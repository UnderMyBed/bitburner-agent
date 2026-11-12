// `useFreshStarts`'s `fixedAgentStart` (#341's second item): the Agent starts at `FIXED_AGENT_START_MS` after the
// page's boot, whatever ran before it, and the seeded draws start again at its first connection. Two fresh starts of
// the same seed, one whose owner's setup takes no time and one whose takes about 2 s (as a longer deploy would), reach
// the same game: the same money, experience and servers rooted, to the dollar, minutes on.

import { expect, test } from "vitest";
import { DEPLOY_WITHIN_MS } from "./helpers/brain-in-simulation.ts";
import { FIXED_AGENT_START_MS, useFreshStarts } from "./helpers/fresh-start.ts";

const freshStartOf = useFreshStarts();
const RUN_MS = 8 * 60_000;

test("the fixed start is past the deploy's timeout: any deploy, and the owner's setup after it, done by then", () => {
  expect(FIXED_AGENT_START_MS).toBeGreaterThan(DEPLOY_WITHIN_MS);
});

test("an owner's setup of no time and of about 2 s reach the same game, 8 minutes on", async () => {
  const states = [];
  for (const setupMs of [0, 2_000]) {
    const fresh = await freshStartOf({
      withDesiredState: true,
      fixedAgentStart: true,
      beforeAgent: async ({ game }) => {
        if (setupMs > 0) await game.run(setupMs);
      },
    });
    await fresh.game.run(RUN_MS);
    const player = fresh.medium()?.player as { money?: number; exp?: { hacking?: number } } | undefined;
    states.push({
      atMs: fresh.game.clock.now(),
      money: player?.money,
      hackingExp: player?.exp?.hacking,
      rooted: (fresh.medium()?.servers ?? []).filter((server) => server.hasAdminRights).map((each) => each.hostname),
    });
  }
  console.log(JSON.stringify(states));
  const [quick, slow] = states;
  expect(quick?.rooted.length).toBeGreaterThan(1);
  expect(quick?.hackingExp).toBeGreaterThan(0);
  expect(slow).toEqual(quick);
}, 120_000);
