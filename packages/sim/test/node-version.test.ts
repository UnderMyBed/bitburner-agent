import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { sfc32 } from "../src/host/rng.ts";
import { checkNodeVersion, nodeVersionError, parseNodeMajor, pinnedNodeMajor, REPO_ROOT } from "../src/node-version.ts";

/**
 * How V8's Array.prototype.sort treats a random comparator, `() => rnd() - rnd()` on [0, 1, …, n-1] with a fresh
 * sfc32(n) per length, as the legacy fork's go.js sorts its moves (packages/legacy/fork/go.js:1352-1353): how many
 * times it calls the comparator, and the order it leaves. The two V8s differ for 3 to 7 elements only (measured over
 * 0 to 80, 100, 150, 200, 361, 500 and 1000), which is what made the BN1 baseline's seeded games differ (#282). Steam's
 * Electron 41.4.0 is Chromium 146, so its V8 should be 14.6, Node 26's: inferred from the versions, not measured on
 * Steam's build. So the pin moved from Node 24 to 26 (the owner's call, 2026-11-07). Node 24's entry stays as the
 * record of the old pin. Node 26's was measured on 26.13.0 (V8 14.6.202.34), and measured again there for the move.
 */
const SORT_BY_NODE: Record<number, { v8: string; byLength: Record<number, { calls: number; order: string }> }> = {
  24: {
    v8: "13.6.",
    byLength: {
      2: { calls: 1, order: "10" },
      3: { calls: 2, order: "210" },
      4: { calls: 3, order: "0123" },
      5: { calls: 4, order: "01234" },
      6: { calls: 10, order: "501432" },
      7: { calls: 9, order: "0123645" },
      8: { calls: 16, order: "50163274" },
    },
  },
  26: {
    v8: "14.6.",
    byLength: {
      2: { calls: 1, order: "10" },
      3: { calls: 3, order: "120" },
      4: { calls: 4, order: "0132" },
      5: { calls: 6, order: "01423" },
      6: { calls: 10, order: "504312" },
      7: { calls: 12, order: "0612543" },
      8: { calls: 16, order: "50163274" },
    },
  },
};

/** The Node version in a mise.toml's `[tools]` table: `node = "26"` or `node = '26'`, comments and spacing aside. */
function miseNode(toml: string): string | undefined {
  let inTools = false;
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line.startsWith("[")) inTools = /^\[\s*tools\s*\]$/.test(line);
    else if (inTools) {
      const node = /^"?node"?\s*=\s*(["'])([^"']+)\1$/.exec(line);
      if (node) return node[2];
    }
  }
  return undefined;
}

/** Runs a script on this Node, made to report another version (`process.versions.node`) before the script loads. */
const OTHER_NODE = "99.0.0";
async function runAsOtherNode(script: string, args: string[]) {
  const pretend = `data:text/javascript,Object.defineProperty(process.versions,"node",{value:"${OTHER_NODE}"})`;
  return promisify(execFile)(process.execPath, ["--import", pretend, script, ...args], { cwd: REPO_ROOT }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (error: { code: number; stdout: string; stderr: string }) => error,
  );
}

function randomSorts(): Record<number, { calls: number; order: string }> {
  const byLength: Record<number, { calls: number; order: string }> = {};
  for (let n = 2; n <= 8; n++) {
    const rnd = sfc32(n);
    let calls = 0;
    const sorted = Array.from({ length: n }, (_, i) => i).sort(() => {
      calls++;
      return rnd() - rnd();
    });
    byLength[n] = { calls, order: sorted.join("") };
  }
  return byLength;
}

describe("the repo's Node pin (#282)", () => {
  test.each([
    ["26", 26],
    ["26\n", 26],
    ["v26", 26],
    ["26.13.0", 26],
    ["v24.22.1", 24],
  ])(".node-version %j is Node %i", (text, major) => {
    expect(parseNodeMajor(text)).toBe(major);
  });

  test.each(["", "lts/*", "node", "26.x"])(".node-version %j is refused, naming what it read", (text) => {
    expect(() => parseNodeMajor(text)).toThrow(/^\.node-version: expected a Node version/);
  });

  test("any version of the pinned major passes; another major is refused with what to do", () => {
    expect(nodeVersionError(26, "26.0.0")).toBeNull();
    expect(nodeVersionError(26, "v26.13.0")).toBeNull();
    expect(nodeVersionError(26, "24.22.1")).toBe(
      "Node v24.22.1 isn't the repo's Node 26 (.node-version). Seeded simulations differ between Node majors (#282), " +
        "so baseline, benchmark and scenario results are only recorded on Node 26. With mise, run from the repo: its " +
        "mise.toml selects Node 26 (docs/setup.md).",
    );
    expect(nodeVersionError(26, "28.1.0")).toMatch(/^Node v28\.1\.0 isn't the repo's Node 26/);
  });

  // The temporary repo pins a major other than the repo's, so this shows the given repo is read, not REPO_ROOT.
  test("checkNodeVersion reads the major from the given repo's .node-version", () => {
    const repo = mkdtempSync(path.join(tmpdir(), "node-pin-"));
    const other = pinnedNodeMajor() - 2;
    writeFileSync(path.join(repo, ".node-version"), `${other}\n`);
    expect(() => checkNodeVersion(repo, `${other}.1.0`)).not.toThrow();
    expect(() => checkNodeVersion(repo, `${pinnedNodeMajor()}.1.0`)).toThrow(
      `Node v${pinnedNodeMajor()}.1.0 isn't the repo's Node ${other} (.node-version).`,
    );
  });

  test("the repo's mise.toml selects the same Node major as .node-version, which mise doesn't read by default", () => {
    const node = miseNode(readFileSync(path.join(REPO_ROOT, "mise.toml"), "utf8"));
    expect(node).toBeDefined();
    expect(parseNodeMajor(node ?? "")).toBe(pinnedNodeMajor());
  });

  test.each([
    ['[tools]\nnode = "26"', "26"],
    ["# a comment\n[tools]\nnode='26.13.0' # pinned\n", "26.13.0"],
    ['[env]\nX = "1"\n[tools]\npython = "3"\n"node" = "24"', "24"],
    ['[tools]\npython = "3"\n[env]\nnode = "26"', undefined],
    ['node = "26"', undefined],
  ])("mise.toml %j gives node %j", (toml, node) => {
    expect(miseNode(toml)).toBe(node);
  });

  test.each([
    ["packages/sim/scripts/run-scenario.ts", ["packages/sim/scenarios/lean.json"]],
    ["packages/sim/scripts/bench.ts", ["--dry-run"]],
    ["packages/legacy/scripts/baseline.ts", ["--seeds", "1"]],
  ])("%s refuses another Node major with exit 2, before doing anything else", async (script, args) => {
    const { code, stdout, stderr } = await runAsOtherNode(script, args);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr.trim()).toBe(nodeVersionError(pinnedNodeMajor(), OTHER_NODE));
  });

  test("the tests run on the pinned Node, as CI's setup-node takes it from .node-version", () => {
    expect(nodeVersionError(pinnedNodeMajor())).toBeNull();
  });

  test("V8's sort calls a random comparator as the pinned Node's V8 does: why the pin matters", () => {
    const expected = SORT_BY_NODE[pinnedNodeMajor()];
    expect(expected, `no sort measurements for Node ${pinnedNodeMajor()}: add them to SORT_BY_NODE`).toBeDefined();
    expect(process.versions.v8.startsWith(expected?.v8 ?? "")).toBe(true);
    expect(randomSorts()).toEqual(expected?.byLength);
  });

  // Steam's Electron 41.4.0 is Chromium 146, whose V8 should be 14.6: inferred from the versions, not measured on
  // Steam's build (parity 4.17). If Steam's Electron moves to another V8, this is where the pin's choice is revisited.
  test("the pinned Node's V8 is the one Steam's Electron should have, so seeded games sort as Steam's do", () => {
    expect(SORT_BY_NODE[pinnedNodeMajor()]?.v8).toBe("14.6.");
  });

  // Documents the measurements recorded above, which the live sort test above checks on the pinned Node.
  test("the measurements recorded here: the two V8s differ for 3 to 7 elements and agree for 2 and 8", () => {
    const [node24, node26] = [SORT_BY_NODE[24]?.byLength ?? {}, SORT_BY_NODE[26]?.byLength ?? {}];
    for (const n of [2, 8]) expect(node24[n]).toEqual(node26[n]);
    for (const n of [3, 4, 5, 6, 7]) expect(node24[n]).not.toEqual(node26[n]);
  });
});
