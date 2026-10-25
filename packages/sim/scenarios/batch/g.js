export async function main(ns) {
  ns.disableLog("ALL");
  await ns.grow(ns.args[0]);
}
