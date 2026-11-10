// The diagnostics' harness edits (#145, #149, #151, #155, #162, #164): state a test sets up that no player could,
// checked in the game's own save. `setMoney`, `joinFactionWithReputation`, `employWithReputation`,
// `giveInstalledAugmentation`, `gainHackingExp`, `gainCharismaExp`, `queueAugmentation` and (#330)
// `setGangMemberFigures`.
import { expect, test } from "vitest";
import type { Simulation } from "../src/simulation.ts";
import { decodeSave } from "./helpers/save-diff.ts";
import { useSimulations } from "./helpers/sim.ts";

const start = useSimulations();
const newGame = () => start({ seed: 1, epochMs: Date.UTC(2026, 0, 1), fixture: { kind: "new", tutorial: "skipped" } });

/**
 * The player, each faction's reputation, favor and discovery, and each company's reputation, as the game saves them
 * (`Faction/Factions.ts`, `Company/Companies.ts`).
 */
async function saved(sim: Simulation) {
  // biome-ignore lint/suspicious/noExplicitAny: a decoded save is untyped JSON.
  const save: Record<string, any> = decodeSave(await sim.save());
  const factions = typeof save.FactionsSave === "string" ? JSON.parse(save.FactionsSave) : save.FactionsSave;
  const companies = typeof save.CompaniesSave === "string" ? JSON.parse(save.CompaniesSave) : save.CompaniesSave;
  return {
    player: save.PlayerSave.data,
    factions: factions as Record<string, { playerReputation?: number; favor?: number }>,
    companies: companies as Record<string, { playerReputation?: number }>,
  };
}

test("joinFactionWithReputation: a member with that reputation, through the game's own join", async () => {
  const sim = await newGame();
  await sim.diagnostics.joinFactionWithReputation("Sector-12", 12_345);
  const { player, factions } = await saved(sim);
  expect(player.factions).toEqual(["Sector-12"]);
  expect(factions["Sector-12"]?.playerReputation).toBe(12_345);
});

test("joinFactionWithReputation and setMoney refuse what isn't a faction, or isn't a finite amount from 0", async () => {
  const sim = await newGame();
  await expect(sim.diagnostics.joinFactionWithReputation("The Gibson", 1)).rejects.toThrow(/no faction The Gibson/);
  await expect(sim.diagnostics.joinFactionWithReputation("CyberSec", -1)).rejects.toThrow(/reputation/);
  await expect(sim.diagnostics.joinFactionWithReputation("CyberSec", Number.NaN)).rejects.toThrow(/reputation/);
  await expect(sim.diagnostics.setMoney(-1)).rejects.toThrow(/money/);
  expect((await saved(sim)).player.factions).toEqual([]);
});

test("setFactionFavor (#225): the faction's favour, through the game's own setFavor; refused for no faction or no number", async () => {
  const sim = await newGame();
  await sim.diagnostics.joinFactionWithReputation("CyberSec", 0);
  await sim.diagnostics.setFactionFavor("CyberSec", 150);
  expect((await saved(sim)).factions.CyberSec?.favor).toBe(150);
  await expect(sim.diagnostics.setFactionFavor("The Gibson", 1)).rejects.toThrow(/no faction The Gibson/);
  await expect(sim.diagnostics.setFactionFavor("CyberSec", -1)).rejects.toThrow(/favour/);
  await expect(sim.diagnostics.setFactionFavor("CyberSec", Number.NaN)).rejects.toThrow(/favour/);
});

test("giveInstalledAugmentation: installed, as the game saves it, without its price; unknown or twice is refused", async () => {
  const sim = await newGame();
  const moneyBefore = (await saved(sim)).player.money;
  await sim.diagnostics.giveInstalledAugmentation("Neuroreceptor Management Implant");
  const { player } = await saved(sim);
  expect(JSON.stringify(player.augmentations)).toContain("Neuroreceptor Management Implant");
  expect(player.money).toBe(moneyBefore);
  await expect(sim.diagnostics.giveInstalledAugmentation("Gibson Implant")).rejects.toThrow(/no augmentation/);
  await expect(sim.diagnostics.giveInstalledAugmentation("Neuroreceptor Management Implant")).rejects.toThrow(
    /installed already/,
  );
});

test("gainHackingExp: the experience and the skill it makes, as the game saves them; a negative amount is refused", async () => {
  const sim = await newGame();
  await sim.diagnostics.gainHackingExp(500);
  const { player } = await saved(sim);
  expect(player.exp.hacking).toBe(500);
  // The game's own formula: floor(32 × ln(500 + 534.6) − 200) (`PersonObjects/formulas/skill.ts`).
  expect(player.skills.hacking).toBe(22);
  await expect(sim.diagnostics.gainHackingExp(-1)).rejects.toThrow(/exp/);
});

test("gainCharismaExp (#155): the experience and the skill it makes, as the game saves them; a negative amount is refused", async () => {
  const sim = await newGame();
  await sim.diagnostics.gainCharismaExp(500);
  const { player } = await saved(sim);
  expect(player.exp.charisma).toBe(500);
  // The same formula as hacking's, so the same level: 22.
  expect(player.skills.charisma).toBe(22);
  await expect(sim.diagnostics.gainCharismaExp(-1)).rejects.toThrow(/exp/);
});

test("queueAugmentation: queued, not installed, as the game saves it, without its price; unknown or owned is refused", async () => {
  const sim = await newGame();
  const moneyBefore = (await saved(sim)).player.money;
  await sim.diagnostics.queueAugmentation("Neurotrainer I");
  await sim.diagnostics.queueAugmentation("NeuroFlux Governor");
  await sim.diagnostics.queueAugmentation("NeuroFlux Governor");
  const { player } = await saved(sim);
  expect(player.queuedAugmentations.map((each: { name: string }) => each.name)).toEqual([
    "Neurotrainer I",
    "NeuroFlux Governor",
    "NeuroFlux Governor",
  ]);
  expect(player.augmentations).toEqual([]);
  expect(player.money).toBe(moneyBefore);
  await expect(sim.diagnostics.queueAugmentation("Gibson Implant")).rejects.toThrow(/no augmentation/);
  await expect(sim.diagnostics.queueAugmentation("Neurotrainer I")).rejects.toThrow(/owned already/);
});

test("employWithReputation (#155): the job held and the company's reputation, as the game saves them; an unknown company or job, or a negative reputation, is refused", async () => {
  const sim = await newGame();
  await sim.diagnostics.employWithReputation("Carmichael Security", "IT Intern", 6_800);
  const { player, companies } = await saved(sim);
  expect(player.jobs).toEqual({ "Carmichael Security": "IT Intern" });
  expect(companies["Carmichael Security"]?.playerReputation).toBe(6_800);
  await expect(sim.diagnostics.employWithReputation("Gibson Corp", "IT Intern", 0)).rejects.toThrow(/no company/);
  await expect(sim.diagnostics.employWithReputation("Noodle Bar", "IT Intern", 0)).rejects.toThrow(/offers no job/);
  await expect(sim.diagnostics.employWithReputation("Noodle Bar", "Waiter", -1)).rejects.toThrow(/reputation/);
  expect((await saved(sim)).player.jobs).toEqual({ "Carmichael Security": "IT Intern" });
});

test("setGangMemberFigures (#330): the member's experience and points set, its levels from them; others refused", async () => {
  const sim = await start({
    seed: 1,
    epochMs: Date.UTC(2026, 0, 1),
    fixture: { kind: "bitnode", n: 2, sourceFiles: {} },
  });
  await expect(sim.diagnostics.setGangMemberFigures("a", { hack_exp: 1 })).rejects.toThrow(/no gang member a/);
  await sim.diagnostics.joinFactionWithReputation("NiteSec", 0);
  await sim.writeFile(
    "home",
    "form.js",
    'export async function main(ns) { ns.gang.createGang("NiteSec"); ns.gang.recruitMember("a"); }',
  );
  expect((await sim.run("home", "form.js")).error).toBeUndefined();
  await sim.diagnostics.setGangMemberFigures("a", { hack_exp: 1e6, hack_asc_points: 8e6 });
  const { player } = await saved(sim);
  const member = player.gang.data.members[0].data;
  expect(member).toMatchObject({ name: "a", hack_exp: 1e6, hack_asc_points: 8e6 });
  // Its level, as the game's process sets it (`GangMember.ts:70-85`): ×√(8e6 / 2,000) on 32 ln(1e6 + 534.5) − 200.
  expect(member.hack).toBe(Math.floor(Math.sqrt(8e6 / 2000) * (32 * Math.log(1e6 + 534.5) - 200)));
  await expect(sim.diagnostics.setGangMemberFigures("b", { hack_exp: 1 })).rejects.toThrow(/no gang member b/);
  await expect(sim.diagnostics.setGangMemberFigures("a", { hack: 1 })).rejects.toThrow(/isn't a gang member figure/);
  await expect(sim.diagnostics.setGangMemberFigures("a", { hack_exp: -1 })).rejects.toThrow(/finite and 0 or more/);
});
