// The reference hack loop: weaken, grow or hack n00dles, whichever it needs.
export async function main(ns) {
  const target = "n00dles";
  ns.nuke(target);
  while (true) {
    if (ns.getServerSecurityLevel(target) > ns.getServerMinSecurityLevel(target) + 1) await ns.weaken(target);
    else if (ns.getServerMoneyAvailable(target) < ns.getServerMaxMoney(target) * 0.75) await ns.grow(target);
    else await ns.hack(target);
  }
}
