// npm run e2:build: builds the pinned game for E2 into .cache/e2/<commit>/ (packages/e2/README.md).
import { buildGame } from "../src/build.ts";
import { buildDirectory, GAME_ROOT, gameCommit } from "../src/paths.ts";

try {
  const commit = gameCommit();
  const outputDirectory = buildDirectory(commit);
  const { skipped, seconds } = buildGame({ gameRoot: GAME_ROOT, commit, outputDirectory });
  console.log(
    skipped ? `Already built: ${outputDirectory}` : `Built ${commit.slice(0, 9)} in ${seconds} s: ${outputDirectory}`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
