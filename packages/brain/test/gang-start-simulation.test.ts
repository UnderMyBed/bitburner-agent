// BN2's gang, its real start (#353, #352's findings): every other gang suite joins NiteSec by a harness edit
// (gang-simulation.test.ts), so here the path that edit stands in for runs, from BN2 with SF1.3 and SF4.3 as the
// campaign enters it, the brain's rules as on Steam (all on), the simulator's own effectors taken away so the Agent
// uses its workers as in a browser. Coverage only. The harness edits stand in for the hours before it:
// - hacking just under 202, avmnite-02h's lowest roll (`Server/data/servers.ts:1468-1486`: 202-220, 2 ports), at BN2's
//   `HackingLevelMultiplier` 0.8 (`BitNode/BitNode.tsx:577`) and SF1.3's ×1.28;
// - the TOR router and the two port openers it needs, BruteSSH.exe and FTPCrack.exe, bought with money given for them.
// Then the brain's own rules: the hack loop roots avmnite-02h and levels to its roll; A3 backdoors it (#195); NiteSec
// invites, asking nothing else (`Faction/FactionInfo.tsx:464-466`); A5 joins (#203); and in BN2, where no karma is
// needed (`PersonObjects/Player/PlayerObjectGangMethods.ts:16-18`), the gang rule forms the gang with NiteSec through
// the gate (`createGang`, ./src/gang.ts). CI runs seeds 1, 3 and 5; `GANG_START_SEEDS` (`1,2,3`, say) runs others.
// Measured on 2026-11-11: the path holds once the level is there, seconds a step; the cost is the level. Seeds 1, 2, 4
// and 6 formed the gang 18 min 41 s to 25 min 41 s after the edit (rolls 212, 219, 219, 220). Before #357 seeds 3 and 5
// installed first, as #343's install timing chased Daedalus's count (BN2 has no gang yet, so it counts): seed 3 at
// 30 min 26 s, at hacking 214 of its roll 218; seed 5 at 28 min 26 s, at 216 of 217. The level starts again, the
// servers re-rolled (seed 5's gang, given 90 minutes, formed 78 min in). Since #357 the planner weighs waiting for the
// gang against installing now before it, by the time to the gang formed (core's `gangFormingTiming`): the A/B below,
// the rules (`bn2Route` "rules", as before) against the planner, on seeds 3 and 5. An install before the gang fails
// the planner's runs here, loudly.
import { AGENT_SIM_EFFECTORS_GLOBAL, type SlowSnapshotData, type StaticSnapshotData } from "@bitburner-agent/core";
import { expect, test } from "vitest";
import { type GangView, gangSnapshotOf } from "../src/gang.ts";
import { runReport } from "../src/run-report.ts";
import { EPOCH_MS } from "./helpers/agent-in-simulation.ts";
import { type FreshGame, ownerRunsOnHome, useFreshStarts, withoutSimEffectors } from "./helpers/fresh-start.ts";

/** `GANG_START_SEEDS`: seeds 1 or more, comma separated; unset, seeds 1, 3 and 5 (CI). Anything else fails loudly. */
function gangStartSeeds(text: string | undefined): number[] {
  if (text === undefined) return [...CI_SEEDS];
  const seeds = text.split(",").map((each) => each.trim());
  if (!seeds.every((each) => /^[1-9]\d*$/.test(each))) {
    throw new Error(`GANG_START_SEEDS is ${JSON.stringify(text)}: give seeds 1 or more, comma separated`);
  }
  return seeds.map(Number);
}

/** CI's seeds: 1 (#353), and 3 and 5, where the rules installed before the gang (#357's A/B). */
const CI_SEEDS = [1, 3, 5] as const;
const freshStartOf = useFreshStarts();
const SEEDS = gangStartSeeds(process.env.GANG_START_SEEDS);
const BN2 = { kind: "bitnode", n: 2, sourceFiles: { 1: 3, 4: 3 } } as const;
const SERVER = "avmnite-02h";
const FACTION = "NiteSec";
/** The hacking level's multiplier: SF1.3's ×1.28 (`SourceFile/applySourceFile.ts:18`: 16 + 8 + 4%), BN2's 0.8. */
const LEVEL_MULT = 1.28 * 0.8;
/** The level the edit sets: under avmnite-02h's lowest roll, 202. */
const START_LEVEL = 201;
/** Hacking experience for the middle of `level` (`calculateSkill`: floor(m × (32 ln(exp + 534.6) − 200))). */
const expFor = (level: number) => Math.exp(((level + 0.5) / LEVEL_MULT + 200) / 32) - 534.6;
/** A new game's money (`PersonObjects/Player/PlayerObject.ts:56`, no donations here): the edit's left none over. */
const NEW_GAME_MONEY = 1_000;
/**
 * Virtual time from the edit to the gang formed, at most, by seed: levelling to the roll (up to 220), then seconds each.
 * Seed 1's 40 min (#353: 25 min 41 s measured). Seeds 3 and 5 (#357), measured on 2026-11-11 with the planner waiting
 * for the gang: seed 3's formed 34 min 41 s after the edit (roll 218), so 45 min; seed 5's 28 min 41 s (roll 217), so
 * 40 min, as seed 1's. Another seed: 40 min, as seed 1's.
 */
const FORMED_WITHIN_MS: Record<number, number> = { 1: 40 * 60_000, 3: 45 * 60_000, 5: 40 * 60_000 };
const formedWithinMs = (seed: number) => FORMED_WITHIN_MS[seed] ?? 40 * 60_000;
/**
 * The rules' arm (#357's A/B): from the edit, 90 virtual minutes at most for the gang, the rules installing first (as
 * before #357, seed 5's gang formed 78 min in, seed 3's not by 90 min).
 */
const RULES_WITHIN_MS = 90 * 60_000;
/** A minute more: the gang's first readings, the report's checks on them. */
const AFTER_MS = 60_000;

test("GANG_START_SEEDS: seeds 1 or more, or unset for CI's 1, 3 and 5; an empty or odd entry fails loudly", () => {
  expect(gangStartSeeds(undefined)).toEqual([1, 3, 5]);
  expect(gangStartSeeds("1, 4")).toEqual([1, 4]);
  for (const odd of ["", "1,", "0", "2.5", "x"]) expect(() => gangStartSeeds(odd)).toThrow(/GANG_START_SEEDS/);
});

/**
 * The harness edit: hacking 201, the TOR router and BruteSSH.exe and FTPCrack.exe, then the effectors taken away.
 * Returns the virtual time of the edit.
 */
async function underNiteSec(game: FreshGame): Promise<number> {
  await game.simulation.diagnostics.gainHackingExp(expFor(START_LEVEL));
  // $200k, $500k and $1.5m (`Constants.ts:44`, `DarkWeb/DarkWebItems.ts:6-7`), then back to a new game's money.
  await game.simulation.diagnostics.setMoney(2_200_000);
  await ownerRunsOnHome(
    game,
    `export async function main(ns) {
  const sim = globalThis.${AGENT_SIM_EFFECTORS_GLOBAL};
  const bought = [sim.buyTorRouter(), sim.buyDarkwebProgram("BruteSSH.exe"), sim.buyDarkwebProgram("FTPCrack.exe")];
  for (const result of bought) if (!result.done) throw new Error(result.problem);
}`,
  );
  await game.simulation.diagnostics.setMoney(NEW_GAME_MONEY);
  const editedAtMs = game.game.clock.now();
  await withoutSimEffectors(game);
  return editedAtMs;
}

/** When each step of the path was first seen, in virtual ms from the edit. */
interface Steps {
  rooted?: number;
  levelled?: number;
  asked?: number;
  backdoored?: number;
  invited?: number;
  joined?: number;
  formed?: number;
}

test.each(SEEDS)(
  "seed %i: from BN2 at hacking 201 with two port openers, the brain backdoors avmnite-02h, joins NiteSec and forms the gang through the gate; the report passes",
  { timeout: 120_000 },
  async (seed) => {
    let editedAtMs = Number.NaN;
    const fresh = await freshStartOf({
      withDesiredState: true,
      fixture: BN2,
      seed,
      beforeAgent: async (game) => {
        editedAtMs = await underNiteSec(game);
      },
    });
    const { game, brain } = fresh;
    const controller = fresh.controller();
    const medium = () => fresh.medium();
    const slow = () => fresh.latest<SlowSnapshotData>("slow");
    const server = () => medium()?.servers.find((each) => each.hostname === SERVER);
    const hacking = () => (medium()?.player.skills as { hacking?: number } | undefined)?.hacking ?? 0;
    const required = () =>
      fresh.latest<StaticSnapshotData>("static")?.servers.find((each) => each.hostname === SERVER)
        ?.requiredHackingSkill;
    const joined = () => ((medium()?.player as { factions?: string[] } | undefined)?.factions ?? []).includes(FACTION);
    const invited = () => (slow()?.factions?.state?.invitations ?? []).some((each) => each === FACTION);

    // Each step until the gang is read: when each was first seen, the gang rule's stages in order with its dashboard
    // line, and the save backups taken by the join (the gate's, as for every join, ./irreversible-gate.ts).
    const steps: Steps = {};
    const stages: { stage: GangView["stage"]; line: string; atMs: number }[] = [];
    // Save backups made (with a file: not the failures) when the join and the gang were first seen.
    const backupsMade = () => brain.saveBackupEvents.filter((event) => "file" in event).length;
    let backupsAtJoin = Number.NaN;
    let backupsAtFormed = Number.NaN;
    // The hacking level at the first medium snapshot: the edit's.
    let firstHacking: number | undefined;
    // avmnite-02h's roll when the backdoor was asked for (#357: an install after the gang re-rolls it, `Prestige.ts:98`).
    let rollAsked: number | undefined;
    // The installs on the way (a reset recreates the servers, re-rolling avmnite-02h, and the hacking level starts
    // again: `Prestige.ts:69`, `:74`, `:98`): when, and at what level against which roll.
    const installs: { atMs: number; hacking: number; required: number | undefined }[] = [];
    let lastAugReset: number | undefined;
    let before: { hacking: number; required: number | undefined } = { hacking: 0, required: undefined };
    const see = (step: keyof Steps, seen: boolean) => {
      if (seen && steps[step] === undefined) steps[step] = game.clock.now() - editedAtMs;
    };
    const seconds = (ms: number | undefined) => (ms === undefined ? "never" : `${(ms / 1000).toFixed(0)} s`);
    const installed = (each: (typeof installs)[number]) =>
      `${seconds(each.atMs)}, at hacking ${each.hacking} of ${each.required}`;
    const progress = () =>
      `seed ${seed}: ${SERVER} needs ${required()}, hacking ${hacking()}; from the edit: ` +
      Object.entries(steps)
        .map(([step, ms]) => `${step} ${seconds(ms)}`)
        .join(", ") +
      `\nstages: ${stages.map((each) => `${each.stage} ${seconds(each.atMs)}`).join(", ")}` +
      `\ninstalls: ${installs.map(installed).join("; ") || "none"}`;
    const formedBy = game.runUntil(() => {
      const reset = slow()?.resetInfo?.lastAugReset;
      if (reset !== undefined && lastAugReset !== undefined && reset !== lastAugReset) {
        installs.push({ atMs: game.clock.now() - editedAtMs, ...before });
        throw new Error("an install before the gang formed (#357): the level for avmnite-02h starts again");
      }
      if (reset !== undefined) lastAugReset = reset;
      if (hacking() > 1) before = { hacking: hacking(), required: required() };
      if (firstHacking === undefined && medium() !== null) firstHacking = hacking();
      see("rooted", server()?.hasAdminRights === true);
      see("levelled", required() !== undefined && hacking() >= (required() as number));
      see(
        "asked",
        brain.logLines.some((line) => line.startsWith(`backdoor: asking for ${SERVER} `)),
      );
      see("backdoored", server()?.backdoorInstalled === true);
      see("invited", invited());
      see("joined", joined());
      if (steps.joined !== undefined && Number.isNaN(backupsAtJoin)) backupsAtJoin = backupsMade();
      if (steps.asked !== undefined) rollAsked ??= required();
      see("formed", gangSnapshotOf(medium()).kind === "gang");
      if (steps.formed !== undefined && Number.isNaN(backupsAtFormed)) backupsAtFormed = backupsMade();
      const { stage, line } = controller.gangView();
      if (stages.at(-1)?.stage !== stage) stages.push({ stage, line, atMs: game.clock.now() - editedAtMs });
      return steps.formed !== undefined;
    }, formedWithinMs(seed));
    // Not formed in time: how far the path got, and the brain's word on the stalled step, in the failure.
    await formedBy.catch((error: unknown) => {
      const said = brain.logLines.filter((line) => /backdoor|NiteSec|gang|install/i.test(line)).slice(-12);
      throw new Error([String(error), progress(), ...said].join("\n"));
    });
    await game.run(AFTER_MS);

    const window = { environment: "E1", sinceMs: EPOCH_MS, untilMs: game.clock.now() } as const;
    const { text, failures } = runReport(fresh.data.store, window, { verbose: true });
    const lines = text.split("\n");
    const section = text.slice(text.indexOf("7. The gang"), text.indexOf("Verdict"));
    console.log(progress());
    console.log(
      brain.logLines.filter((line) => /install chosen|planner's install timing|WAIT OVERDUE/.test(line)).join("\n"),
    );
    console.log(lines.filter((line) => /avmnite-02h|NiteSec/.test(line)).join("\n"));
    console.log(section);

    // The game's own terms: avmnite-02h's roll within 202-220, the level reached only by the brain's play, from the
    // edit's 201.
    expect(firstHacking).toBe(START_LEVEL);
    const level = rollAsked as number;
    expect(level).toBeGreaterThanOrEqual(202);
    expect(level).toBeLessThanOrEqual(220);
    expect(fresh.latest<StaticSnapshotData>("static")?.servers.find((each) => each.hostname === SERVER)).toMatchObject({
      numOpenPortsRequired: 2,
    });
    // Each step in the path's order: rooted, levelled, asked, backdoored, joined, formed (the invitation, between
    // the backdoor and the join, may come and go between two slow snapshots). Measured on 2026-11-11 (seed 1, the roll
    // 212), before #357: rooted at the first medium snapshot, 11 s after the edit; the level by the brain's play 24 min
    // 31 s after it; asked at once; backdoored 10 s later; invited 20 s, joined 10 s and the gang formed 30 s after that:
    // 25 min 41 s from the edit to the gang formed, 70 s of it after the level. Since #357 (the planner's wait for the
    // gang holds no money back for #343's countables): the level at 21 min 11 s, backdoored 10 s later, invited 40 s,
    // joined 10 s and formed 30 s after that, 22 min 41 s, 90 s after the level; seed 3 (roll 218) the level at 33 min
    // 41 s and formed 34 min 41 s; seed 5 (roll 217) 27 min 41 s and 28 min 41 s, 60 s each. No install on the way.
    const order: (keyof Steps)[] = ["rooted", "levelled", "asked", "backdoored", "joined", "formed"];
    for (const step of order) expect(steps[step], step).toBeDefined();
    const times = order.map((step) => steps[step] as number);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    if (steps.invited !== undefined) {
      expect(steps.invited).toBeGreaterThanOrEqual(steps.backdoored as number);
      expect(steps.invited).toBeLessThanOrEqual(steps.joined as number);
    }
    // Asked on the snapshot that showed the level (a medium snapshot every 10 s), and the rest in seconds.
    expect((steps.asked as number) - (steps.levelled as number)).toBeLessThanOrEqual(10_000);
    expect((steps.formed as number) - (steps.levelled as number)).toBeLessThan(2 * 60_000);

    // A3 asked once, at the roll, and saw it done.
    const asked = brain.logLines.filter((line) => line.startsWith(`backdoor: asking for ${SERVER} `));
    expect(asked).toEqual([
      expect.stringMatching(
        new RegExp(`^backdoor: asking for ${SERVER} \\(hacking \\d+, needs ${level}\\), for ${FACTION}'s invitation$`),
      ),
    ]);
    expect(brain.logLines).toContainEqual(
      expect.stringMatching(new RegExp(`^backdoor: ${SERVER} backdoored, \\d+ s after it was asked for$`)),
    );

    // The gang rule's stages (`GangRule.update`): unread, every gang faction hidden from the other rules
    // (`hiddenFactions`); read, none hidden, with no gang faction joined, then forming once NiteSec is; then managed,
    // the gang's own faction hidden alone. Never unread again once read.
    // Before them, not managed until the first slow snapshot says BN2.
    expect(stages.map((each) => each.stage)).toEqual(["notManaged", "waiting", "noFaction", "forming", "managed"]);
    expect(stages.find((each) => each.stage === "noFaction")?.line).toBe(
      "Gang: none yet: no gang faction joined (NiteSec comes with avmnite-02h's backdoor)",
    );
    expect(stages.find((each) => each.stage === "forming")?.line).toBe("Gang: forming with NiteSec");
    // Read before the first minute was out, as the report's unread check needs.
    expect(stages.find((each) => each.stage === "noFaction")?.atMs).toBeLessThan(60_000);
    const gang = gangSnapshotOf(medium());
    if (gang.kind !== "gang") throw new Error("no gang read");
    expect(gang.gang).toMatchObject({ faction: FACTION, isHacking: true });
    // Through the gate: its save backup, made after the join was seen and by the time the gang was.
    expect(backupsAtFormed).toBeGreaterThan(backupsAtJoin);

    // The run report: the backdoor and the join (Singularity's, with SF4.3) and the form (the page's: no Singularity
    // worker for it), each done; the gang formed with NiteSec; and PASS. The backdoor's first try finds it under way.
    expect(lines).toContainEqual(
      expect.stringMatching(/^ {4}backdoor\(avmnite-02h\): done after [12] tr(y|ies) \(singularity\); /),
    );
    // The simulator has no page, so no invitation dialog for the Agent to handle (backdoors-simulation's line).
    expect(lines).toContainEqual(
      expect.stringMatching(
        /^ {4}avmnite-02h: not backdoored at the window's start; backdoored by \S+; no invitation from NiteSec seen$/,
      ),
    );
    expect(lines).toContainEqual(
      expect.stringMatching(/^ {4}joinFaction\(NiteSec\): done after 1 try \(singularity\); /),
    );
    expect(text).toMatch(/\n {4}createGang\(NiteSec\): done after 1 try \(ui\); /);
    expect(section).toMatch(/\n {2}formed: with NiteSec, first seen /);
    expect(section).toContain("no gang formed with a gang faction joined for 5 min or more:\n    none");
    expect(section).toContain("the gang unread in BN2 for 5 min or more:\n    none");
    expect(failures).toEqual([]);
    expect(lines.at(-1)).toBe("Verdict: PASS");
  },
);

/**
 * #357's A/B, the rules' arm (`bn2Route` "rules": #343's install timing before the gang, as before #357): on seeds 3 and
 * 5 the install comes before the gang, the level reset and the servers re-rolled (`Prestige.ts:69`, `:74`, `:98`). The
 * planner's arm is the suite above, on the same seeds: no install, the gang at 34 min 41 s and 28 min 41 s.
 */
test.each([3, 5])(
  "seed %i, the rules (#357's A/B baseline): an install before the gang, short of avmnite-02h's level; the gang later or never",
  { timeout: 120_000 },
  async (seed) => {
    let editedAtMs = Number.NaN;
    const fresh = await freshStartOf({
      withDesiredState: true,
      fixture: BN2,
      seed,
      bn2Route: "rules",
      beforeAgent: async (game) => {
        editedAtMs = await underNiteSec(game);
      },
    });
    const { game } = fresh;
    const medium = () => fresh.medium();
    const hacking = () => (medium()?.player.skills as { hacking?: number } | undefined)?.hacking ?? 0;
    const required = () =>
      fresh.latest<StaticSnapshotData>("static")?.servers.find((each) => each.hostname === SERVER)
        ?.requiredHackingSkill;
    let lastAugReset: number | undefined;
    let before = { hacking: 0, required: undefined as number | undefined };
    let install: { atMs: number; hacking: number; required: number | undefined } | null = null;
    let formedAtMs: number | null = null;
    await game
      .runUntil(() => {
        const reset = fresh.latest<SlowSnapshotData>("slow")?.resetInfo?.lastAugReset;
        if (install === null && reset !== undefined && lastAugReset !== undefined && reset !== lastAugReset) {
          install = { atMs: game.clock.now() - editedAtMs, ...before };
        }
        if (reset !== undefined) lastAugReset = reset;
        if (install === null && hacking() > 1) before = { hacking: hacking(), required: required() };
        if (gangSnapshotOf(medium()).kind === "gang") formedAtMs = game.clock.now() - editedAtMs;
        return formedAtMs !== null;
      }, RULES_WITHIN_MS)
      .catch(() => {});
    const minutes = (ms: number | null) =>
      ms === null ? "none" : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
    const installed = install as { atMs: number; hacking: number; required: number | undefined } | null;
    console.log(
      `seed ${seed}, the rules: installed at ${minutes(installed?.atMs ?? null)}, hacking ${installed?.hacking} of ` +
        `${installed?.required}; the gang formed at ${minutes(formedAtMs)} (90 min at most)`,
    );
    // The install, before the gang, short of the roll: what #357's planner doesn't do on these seeds.
    expect(installed).not.toBeNull();
    expect(installed?.hacking as number).toBeLessThan(installed?.required as number);
    expect(formedAtMs === null || formedAtMs > (installed?.atMs as number)).toBe(true);
    // Measured on 2026-11-11: seed 3 installed at 30 min 26 s, at 214 of 218, and had no gang by 90 min; seed 5 at
    // 28 min 26 s, at 216 of 217, its gang at 78 min 6 s. Either way past the planner's bound for the seed (45 and 40
    // min; its gang at 34 min 41 s and 28 min 41 s).
    expect(formedAtMs === null || formedAtMs > formedWithinMs(seed)).toBe(true);
  },
);
