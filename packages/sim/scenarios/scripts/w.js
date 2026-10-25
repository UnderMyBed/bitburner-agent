// A batch worker: one weaken of the target given as its first argument.
export async function main(ns) {
  await ns.weaken(ns.args[0]);
}
