// Starts many copies of the hack loop, each its own file (so each is its own module), 3 threads each.
// args: [copies]
export async function main(ns) {
  const [copies] = ns.args.map(Number);
  const source = ns.read("hack.js");
  for (let i = 1; i <= copies; i++) {
    const file = `hack-${i}.js`;
    ns.write(file, source, "w");
    if (ns.run(file, 3) === 0) throw new Error(`couldn't start ${file}`);
  }
}
