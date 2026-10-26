// node packages/e2/scripts/run-game-webpack.ts <output directory>, run with the submodule as the working directory
// (src/build.ts does this): builds the game with e2WebpackConfig. Exits 1 if webpack reports errors.
import { createRequire } from "node:module";
import path from "node:path";
import { e2WebpackConfig } from "../src/webpack-config.ts";

const [outputDirectory] = process.argv.slice(2);
if (outputDirectory === undefined) throw new RangeError("usage: run-game-webpack.ts <output directory>");
const gameRoot = process.cwd();

interface Stats {
  hasErrors(): boolean;
  toString(options: object): string;
}
type Webpack = (
  config: object,
  callback: (error: Error | null, stats?: Stats) => void,
) => { close(cb: () => void): void };

const webpack = createRequire(path.join(gameRoot, "webpack.config.js"))("webpack") as Webpack;
const compiler = webpack(e2WebpackConfig(gameRoot, outputDirectory), (error, stats) => {
  if (error) {
    console.error(error);
    process.exitCode = 1;
  } else if (stats) {
    console.log(stats.toString({ all: false, errors: true, warnings: false, assets: false, timings: true }));
    if (stats.hasErrors()) process.exitCode = 1;
  }
  compiler.close(() => {});
});
