// npm run build -w @bitburner-agent/ingame: bundles the in-game scripts into dist/, with dist/manifest.json.
import { buildInGameBundles, DEFAULT_OUTPUT_DIRECTORY } from "./bundles.ts";

const manifest = await buildInGameBundles();
const files = Object.entries(manifest.files).map(([fileName, file]) => `${fileName} (${file.bytes} bytes)`);
console.log(`in-game build ${manifest.buildId} in ${DEFAULT_OUTPUT_DIRECTORY}: ${files.join(", ")}`);
