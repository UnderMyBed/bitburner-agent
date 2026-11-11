// The hack loop's change log in levelling mode (#336): the verb is the operation the brain sent.
import { expect, test } from "vitest";
import { levellingText } from "../../src/agent/hack-loop.ts";

const deployed = {
  serversRunning: 3,
  threadsRunning: 2_400,
  byTarget: [{ target: "joesguns", serversRunning: 3, threadsRunning: 2_400, hackThreadsRunning: 0 }],
  problem: null,
};

test("levelling's line says the operation sent: growing or weakening, with the threads and servers running", () => {
  expect(levellingText(deployed, "joesguns", "grow")).toBe("levelling, 2400 threads growing joesguns on 3 servers");
  expect(levellingText(deployed, "joesguns", "weaken")).toBe("levelling, 2400 threads weakening joesguns on 3 servers");
  expect(levellingText({ ...deployed, byTarget: [] }, "joesguns", "weaken")).toBe(
    "levelling, 0 threads weakening joesguns on 0 servers",
  );
});
