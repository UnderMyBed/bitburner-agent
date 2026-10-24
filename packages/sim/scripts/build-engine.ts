// npm run build:engine [-- --force]
import { buildEngine } from "../src/engine/build.ts";

const result = await buildEngine({ force: process.argv.includes("--force") });
if (result.skipped) {
  console.log("engine bundle is up to date");
} else if (result.report) {
  const { bytes, inputs, gameFiles, packages } = result.report;
  console.log(
    `engine bundle built: ${(bytes / 1e6).toFixed(1)} MB, ${inputs} inputs, ${gameFiles} game files, ${packages.length} packages`,
  );
}
