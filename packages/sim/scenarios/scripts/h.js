// A batch worker: one hack of the target given as its first argument.
export async function main(ns) {
  await ns.hack(ns.args[0]);
}
