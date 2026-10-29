// node packages/sim/scripts/generate-game-data.ts
// Writes core's game data (#193) from the pinned game, read through the simulator's engine: every augmentation
// (packages/core/src/augmentation-data.ts), the BitNode multipliers on them, and every faction
// (packages/core/src/faction-data.ts). Rerun it after the game is bumped; packages/sim/test/game-data.test.ts fails
// until it is.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BITNODE_COUNT, PINNED_GAME } from "@bitburner-agent/core";
import { buildEngine } from "../src/engine/build.ts";
import type { GameAugmentation } from "../src/protocol.ts";
import { Simulation } from "../src/simulation.ts";

const CORE = new URL("../../core/src/", import.meta.url);
const REPO = fileURLToPath(new URL("../../../", import.meta.url));
/** Its multipliers are drawn by the game's clock (`Augmentation/CircadianModulator.ts:113`): not data. */
const RANDOM_MULTIPLIERS = "Unstable Circadian Modulator";

const header = (what: string) =>
  `// ${what}: generated from the pinned game (v${PINNED_GAME.versionString}) by\n` +
  "// packages/sim/scripts/generate-game-data.ts (#193). Don't edit it; rerun that. packages/sim/test/game-data.test.ts\n" +
  "// checks it against the engine.\n";

/** A value as TypeScript: JSON, with the engine's infinite numbers (`GameNumber`'s "Infinity") as `Infinity`. */
const literal = (value: unknown) => JSON.stringify(value, null, 2).replace(/: "Infinity"/g, ": Infinity");

function coreAugmentation(augmentation: GameAugmentation) {
  const random = augmentation.name === RANDOM_MULTIPLIERS;
  return {
    baseMoneyCost: augmentation.baseMoneyCost,
    baseRepCost: augmentation.baseRepCost,
    factions: augmentation.factions,
    prereqs: augmentation.prereqs,
    multipliers: random ? {} : augmentation.multipliers,
    isSpecial: augmentation.isSpecial,
    startingMoney: augmentation.startingMoney,
    programs: augmentation.programs,
    ...(random ? { randomMultipliers: true } : {}),
  };
}

await buildEngine();
const sim = await Simulation.start({
  seed: 1,
  epochMs: Date.UTC(2026, 0, 1),
  fixture: { kind: "new", tutorial: "skipped" },
});
try {
  const data = await sim.diagnostics.gameData();
  const bitNodes: Record<number, Record<string, number>> = {};
  for (let n = 1; n <= BITNODE_COUNT; n++) {
    const all = await sim.diagnostics.bitNodeMultipliers(n, 1);
    bitNodes[n] = {
      AugmentationMoneyCost: all.AugmentationMoneyCost as number,
      AugmentationRepCost: all.AugmentationRepCost as number,
      DaedalusAugsRequirement: all.DaedalusAugsRequirement as number,
      FactionWorkRepGain: all.FactionWorkRepGain as number,
    };
  }

  const augmentationFile = new URL("augmentation-data.ts", CORE);
  writeFileSync(
    augmentationFile,
    `${header("Every augmentation, and the BitNode multipliers on them")}` +
      `import type { AugmentationBitNodeMultipliers, AugmentationData } from "./augmentations.ts";\n\n` +
      "/** Every augmentation, by name, in the game's order (`Augmentation/Augmentations.ts`). */\n" +
      `export const AUGMENTATIONS: Record<string, AugmentationData> = ${literal(
        Object.fromEntries(
          data.augmentations.map((augmentation) => [augmentation.name, coreAugmentation(augmentation)]),
        ),
      )};\n\n` +
      "/** Each BitNode's multipliers on augmentations and faction work, at level 1 (`getBitNodeMultipliers`): BN12's change with it. */\n" +
      `export const AUGMENTATION_BITNODE_MULTIPLIERS: Record<number, AugmentationBitNodeMultipliers> = ${literal(bitNodes)};\n`,
  );

  const factionFile = new URL("faction-data.ts", CORE);
  writeFileSync(
    factionFile,
    `${header("Every faction")}` +
      `import type { FactionData } from "./factions.ts";\n\n` +
      "/** Every faction, by name, in the game's order (`Faction/Enums.ts`). */\n" +
      `export const FACTIONS: Record<string, FactionData> = ${literal(
        Object.fromEntries(data.factions.map(({ name, ...faction }) => [name, faction])),
      )};\n`,
  );

  // Biome's style, so a regeneration that changes nothing leaves no diff.
  const files = [fileURLToPath(augmentationFile), fileURLToPath(factionFile)];
  const biome = spawnSync(process.execPath, ["node_modules/@biomejs/biome/bin/biome", "format", "--write", ...files], {
    cwd: REPO,
    stdio: "inherit",
  });
  if (biome.status !== 0) throw new Error(`biome format exited ${biome.status}`);
  console.log(`wrote ${data.augmentations.length} augmentations and ${data.factions.length} factions`);
} finally {
  await sim.close();
}
