import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { Simulation } from "@bitburner-agent/sim";
import { afterAll, describe, expect, test } from "vitest";
import { FORK, FORK_DIR, forkFiles, forkManifest, gameFiles } from "../src/index.ts";

const EPOCH = Date.UTC(2026, 0, 1);
const MINUTE = 60_000;
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

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
    const { files } = forkManifest();
    expect(filesUnder(FORK_DIR)).toEqual(Object.keys(files).sort());
    for (const [file, hash] of Object.entries(files)) {
      expect(sha256(readFileSync(path.join(FORK_DIR, file))), file).toBe(hash);
    }
  });

  test("PROVENANCE.md records the manifest's source, commit, tree and file count", () => {
    const provenance = readFileSync(path.join(FORK_DIR, "../PROVENANCE.md"), "utf8");
    for (const value of [FORK.repository, FORK.commit, FORK.tree]) expect(provenance).toContain(value);
    expect(provenance).toContain(`| Files | ${Object.keys(forkManifest().files).length},`);
  });

  test("forkFiles() gives every file exactly: its text is the manifest's bytes", () => {
    const { files } = forkManifest();
    const vendored = forkFiles();
    expect(vendored.map((f) => f.path)).toEqual(Object.keys(files).sort());
    for (const file of vendored) expect(sha256(Buffer.from(file.content, "utf8")), file.path).toBe(files[file.path]);
    expect(vendored.find((f) => f.path === "LICENSE")?.content).toMatch(
      /^MIT License\s+Copyright \(c\) 2021 Alain Bryden/,
    );
  });

  test("gameFiles() is the scripts and the text files", () => {
    expect(gameFiles().every((f) => f.path.endsWith(".js") || f.path.endsWith(".txt"))).toBe(true);
    expect(gameFiles().map((f) => f.path)).toContain("reserve.txt");
    expect(gameFiles()).toHaveLength(forkFiles().filter((f) => /\.(js|txt)$/.test(f.path)).length);
  });
});

describe("the fork in the simulator", () => {
  const open: Simulation[] = [];
  afterAll(async () => {
    await Promise.all(open.map((sim) => sim.close()));
  });

  /** A new game with the fork's game files on home. */
  async function withFork(homeRamGb?: number): Promise<Simulation> {
    const sim = await Simulation.start({ seed: 1, epochMs: EPOCH, fixture: { kind: "new", tutorial: "skipped" } });
    open.push(sim);
    if (homeRamGb) await sim.diagnostics.setHomeRam(homeRamGb);
    for (const file of gameFiles()) await sim.writeFile("home", file.path, file.content);
    return sim;
  }

  test("every script parses and resolves its imports, and the game computes its RAM cost", async () => {
    // getScriptRam runs the game's RAM calculator: it parses the script and resolves its imports, without running it.
    const sim = await withFork();
    const scripts = gameFiles()
      .map((f) => f.path)
      .filter((p) => p.endsWith(".js"));
    await sim.writeFile(
      "home",
      "ram-check.js",
      `export async function main(ns) {
         ns.disableLog("ALL");
         ns.print("costs " + JSON.stringify(${JSON.stringify(scripts)}.map((f) => [f, ns.getScriptRam(f)])));
       }`,
    );
    const { pid } = await sim.run("home", "ram-check.js");
    await sim.advance(1000);
    const line = (await sim.logs(pid)).find((l) => l.startsWith("costs "));
    const costs = JSON.parse(line?.slice(6) ?? "[]") as [string, number][];
    expect(costs.map(([file]) => file)).toEqual(scripts);
    // Every script costs at least the 1.6 GB base; 0 means the game couldn't cost it.
    expect(costs.filter(([, ram]) => !(ram >= 1.6))).toEqual([]);
  });

  test("autopilot.js runs 10 virtual minutes, its managers too, without browser-global ReferenceErrors", async () => {
    // 64 GB, so autopilot can keep running and start its managers; with a new game's 8 GB it exits (see README).
    // --disable-casino: casino.js plays through the game's page and reloads the game, which a headless run can't.
    const sim = await withFork(64);
    const { pid, error } = await sim.run("home", "autopilot.js", { args: ["--disable-casino"] });
    expect(error).toBeUndefined();
    await sim.advance(10 * MINUTE);
    const running = (await sim.ps("home")).map((p) => p.filename);
    expect(running).toEqual(expect.arrayContaining(["autopilot.js", "daemon.js", "stockmaster.js", "go.js"]));
    const events = (await sim.events()).events;
    expect(JSON.stringify(events)).not.toMatch(/ReferenceError/);
    expect((await sim.logs(pid)).join("\n")).not.toMatch(/ReferenceError/);
    // stats.js reaches the page through eval("document") (stats.js:33), then adds its HUD to the game's own elements,
    // which a headless game doesn't render (no UI, by design): so it gets past `document` and fails on the HUD.
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "error",
        script: "stats.js",
        errorType: "TYPE",
        message: expect.stringContaining("addCSS"),
      }),
    );
  });
});
