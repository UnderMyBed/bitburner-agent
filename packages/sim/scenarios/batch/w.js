export async function main(ns) {
  ns.disableLog("ALL");
  await ns.weaken(ns.args[0]);
}
