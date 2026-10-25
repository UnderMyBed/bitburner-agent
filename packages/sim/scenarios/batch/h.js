export async function main(ns) {
  ns.disableLog("ALL");
  await ns.hack(ns.args[0]);
}
