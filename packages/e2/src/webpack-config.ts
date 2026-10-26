// The game's own webpack config (vendor/bitburner-src/webpack.config.js), in production mode, with three changes for
// E2, none to what it builds:
// - the output goes outside the submodule;
// - the minifier runs on one core: by default it uses every core but one, and the owner's rule for this machine's
//   test runs is one core. Its options otherwise stay webpack's defaults;
// - the separate typecheck process is dropped, another process besides: the pinned game's types are upstream's
//   business, and ours are checked by `npm run typecheck`.
// The webpack CLI can set the output path but not the other two, hence a config.
import { createRequire } from "node:module";
import path from "node:path";

/** The parts of a webpack config this changes. */
export interface GameWebpackConfig {
  mode?: string;
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
  const TerserPlugin = requireFromWebpack("terser-webpack-plugin") as new (options: object) => object;

  const config = gameConfig({}, { mode: "production" });
  // The CLI would set this from --mode; the config itself leaves it out.
  config.mode = "production";
  config.plugins = config.plugins.filter((plugin) => !(plugin instanceof ForkTsCheckerWebpackPlugin));
  // webpack's own default minimizer (lib/config/defaults.js: two compress passes), on one core.
  config.optimization.minimizer = [new TerserPlugin({ parallel: false, terserOptions: { compress: { passes: 2 } } })];
  // index.html is written one level up (the config's "../index.html"), so it lands in `outputDirectory` itself.
  config.output.path = path.join(outputDirectory, "dist");
  return config;
}
