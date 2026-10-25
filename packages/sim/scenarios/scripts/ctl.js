// A batch controller, as in spike S1: every 200 ms it exec()s single-operation workers against n00dles, as many
// threads as fit. Exercises what a real batcher does: module imports mid-run, process churn, many timers at once.
// args: [maximum threads per worker, workers per tick]
export async function main(ns) {
  const target = "n00dles";
  ns.nuke(target);
  const [maxThreads, perTick] = ns.args.map(Number);
  while (true) {
    for (let i = 0; i < perTick; i++) {
      const free = ns.getServerMaxRam("home") - ns.getServerUsedRam("home");
      const security = ns.getServerSecurityLevel(target) - ns.getServerMinSecurityLevel(target);
      const money = ns.getServerMoneyAvailable(target) / ns.getServerMaxMoney(target);
      const worker = security > 1 ? "w.js" : money < 0.75 ? "g.js" : "h.js";
      const threads = Math.min(Math.floor(free / ns.getScriptRam(worker)), maxThreads);
      if (threads <= 0) break;
      // A random argument makes each worker unique: the game refuses to exec a duplicate of a running script.
      ns.exec(worker, "home", { threads }, target, Math.random());
    }
    await ns.sleep(200);
  }
}
