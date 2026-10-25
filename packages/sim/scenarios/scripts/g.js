// A batch worker: one grow of the target given as its first argument.
export async function main(ns) {
  await ns.grow(ns.args[0]);
}
