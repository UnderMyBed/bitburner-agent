// The game's own webpack config (vendor/bitburner-src/webpack.config.js), in production mode, with three changes for
// E2: the output goes outside the submodule, the minifier runs on one core, and the separate typecheck process is
// dropped (the pinned game's types are upstream's business; ours are checked by `npm run typecheck`).
import { createRequire } from "node:module";
import path from "node:path";

/** The parts of a webpack config this changes. */
export interface GameWebpackConfig {
  plugins: object[];
  output: { path: string };
  optimization: { minimize?: boolean; minimizer?: unknown[] };
}

type GameConfigFunction = (env: Record<string, unknown>, argv: { mode: string }) => GameWebpackConfig;

/**
 * The game's production config with E2's changes. `gameRoot` is the submodule: the config and its plugins load from
 * its node_modules (`npm run setup:engine`). Run from `gameRoot`: the config reads the commit with git, and its entry
 * and template are relative to the working directory.
 */
export function e2WebpackConfig(gameRoot: string, outputDirectory: string): GameWebpackConfig {
  const requireFromGame = createRequire(path.join(gameRoot, "webpack.config.js"));
  const gameConfig = requireFromGame("./webpack.config.js") as GameConfigFunction;
  const ForkTsCheckerWebpackPlugin = requireFromGame("fork-ts-checker-webpack-plugin") as new () => object;
  // terser-webpack-plugin is webpack's own default minimizer, so it's found from webpack.
  const requireFromWebpack = createRequire(requireFromGame.resolve("webpack"));
  const TerserPlugin = requireFromWebpack("terser-webpack-plugin") as new (options: { parallel: boolean }) => object;

  const config = gameConfig({}, { mode: "production" });
  config.plugins = config.plugins.filter((plugin) => !(plugin instanceof ForkTsCheckerWebpackPlugin));
  config.optimization.minimizer = [new TerserPlugin({ parallel: false })];
  // index.html is written one level up (the config's "../index.html"), so it lands in `outputDirectory` itself.
  config.output.path = path.join(outputDirectory, "dist");
  return config;
}
