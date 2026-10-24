// Prints the top self-time functions from the newest .cpuprofile in ./prof.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const dir = path.resolve("prof");
const file = readdirSync(dir)
  .filter((f) => f.endsWith(".cpuprofile"))
  .map((f) => path.join(dir, f))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
const prof = JSON.parse(readFileSync(file, "utf8"));
const dt = new Map();
for (let i = 0; i < prof.samples.length; i++) dt.set(prof.samples[i], (dt.get(prof.samples[i]) ?? 0) + (prof.timeDeltas[i] ?? 0));
const self = new Map();
let total = 0;
for (const n of prof.nodes) {
  const t = dt.get(n.id) ?? 0;
  total += t;
  const cf = n.callFrame;
  const key = `${cf.functionName || "(anon)"} ${path.basename(cf.url || "")}:${cf.lineNumber + 1}`;
  self.set(key, (self.get(key) ?? 0) + t);
}
const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, Number(process.argv[2] ?? 25));
for (const [k, t] of top) console.log(`${((100 * t) / total).toFixed(1).padStart(5)}%  ${k}`);
