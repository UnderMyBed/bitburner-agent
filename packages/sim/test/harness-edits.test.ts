// The diagnostics' harness edits (#145, #149): state a test sets up that no player could, checked in the game's own
// save. `setMoney`, `joinFactionWithReputation`, `giveInstalledAugmentation` and `gainHackingExp`.
import { expect, test } from "vitest";
import type { Simulation } from "../src/simulation.ts";
import { decodeSave } from "./helpers/save-diff.ts";
import { useSimulations } from "./helpers/sim.ts";

const start = useSimulations();
const newGame = () => start({ seed: 1, epochMs: Date.UTC(2026, 0, 1), fixture: { kind: "new", tutorial: "skipped" } });

/** The player, and each faction's reputation, favor and discovery, as the game saves them (`Faction/Factions.ts`). */
async function saved(sim: Simulation) {
  // biome-ignore lint/suspicious/noExplicitAny: a decoded save is untyped JSON.
  const save: Record<string, any> = decodeSave(await sim.save());
  const factions = typeof save.FactionsSave === "string" ? JSON.parse(save.FactionsSave) : save.FactionsSave;
  return { player: save.PlayerSave.data, factions: factions as Record<string, { playerReputation?: number }> };
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
