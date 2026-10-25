import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { Simulation } from "@bitburner-agent/sim";
import { afterAll, describe, expect, test } from "vitest";
import { FORK, FORK_DIR, forkFiles, forkManifest } from "../src/index.ts";

const EPOCH = Date.UTC(2026, 0, 1);
const MINUTE = 60_000;

/** Every file under `dir`, by its path relative to `dir`, with forward slashes. */
function filesUnder(dir: string, prefix = ""): string[] {
  return readdirSync(dir)
    .flatMap((name) =>
      statSync(path.join(dir, name)).isDirectory()
        ? filesUnder(path.join(dir, name), `${prefix}${name}/`)
        : [`${prefix}${name}`],
    )
    .sort();
}

describe("the vendored fork", () => {
  test("is exactly the recorded commit's files: the manifest matches the files, byte for byte", () => {
    const { commit, files } = forkManifest();
    expect(commit).toBe(FORK.commit);
    expect(filesUnder(FORK_DIR)).toEqual(Object.keys(files).sort());
    for (const [file, sha256] of Object.entries(files)) {
      expect(
        createHash("sha256")
          .update(readFileSync(path.join(FORK_DIR, file)))
          .digest("hex"),
        file,
      ).toBe(sha256);
    }
  });

  test("forkFiles() gives every file in the manifest, as text", () => {
    const files = forkFiles();
    expect(files.map((f) => f.path)).toEqual(Object.keys(forkManifest().files).sort());
    expect(files.find((f) => f.path === "LICENSE")?.content).toMatch(
      /^MIT License\s+Copyright \(c\) 2021 Alain Bryden/,
    );
  });
});

describe("the fork in the simulator", () => {
  const open: Simulation[] = [];
  afterAll(async () => {
    await Promise.all(open.map((sim) => sim.close()));
  });

  /** A new game with the fork's scripts (and its reserve.txt) on home. */
  async function withFork(): Promise<Simulation> {
    const sim = await Simulation.start({ seed: 1, epochMs: EPOCH, fixture: { kind: "new", tutorial: "skipped" } });
    open.push(sim);
    for (const file of forkFiles()) {
      if (file.path.endsWith(".js") || file.path.endsWith(".txt")) await sim.writeFile("home", file.path, file.content);
    }
    return sim;
  }

  test("every script compiles, and the game computes its RAM cost", async () => {
    const sim = await withFork();
    const scripts = forkFiles()
      .map((f) => f.path)
      .filter((p) => p.endsWith(".js"));
    await sim.writeFile(
      "home",
      "ram-check.js",
      `export async function main(ns) { for (const f of ${JSON.stringify(scripts)}) ns.print("ram " + f + " " + ns.getScriptRam(f)); }`,
    );
    const { pid } = await sim.run("home", "ram-check.js");
    await sim.advance(1000);
    const costs = (await sim.logs(pid))
      .map((line) => /ram (\S+) ([\d.]+)/.exec(line))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => [m[1], Number(m[2])] as const);
    expect(costs.map(([file]) => file)).toEqual(scripts);
    const uncosted = costs.filter(([, ram]) => !(ram >= 1.6));
    expect(uncosted).toEqual([]);
  });

  test("autopilot.js runs for 10 virtual minutes without browser-global ReferenceErrors", async () => {
    const sim = await withFork();
    const { pid, error } = await sim.run("home", "autopilot.js", { args: ["--disable-casino"] });
    expect(error).toBeUndefined();
    await sim.advance(10 * MINUTE);
    const events = JSON.stringify((await sim.events()).events);
    const logs = (await sim.logs(pid)).join("\n");
    expect(events).not.toMatch(/ReferenceError/);
    expect(logs).not.toMatch(/ReferenceError/);
    // And it got going. On a new game's 8 GB, without SF4, autopilot starts daemon.js and leaves it running: there
    // isn't the RAM to keep autopilot itself running (it says so in its log).
    expect((await sim.ps("home")).map((p) => p.filename)).toContain("daemon.js");
    expect(logs).toContain("Launched daemon.js");
  });
});
