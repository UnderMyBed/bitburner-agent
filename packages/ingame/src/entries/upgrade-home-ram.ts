// agent/<deploymentId>/upgrade-home-ram.js: a home worker that doubles home's RAM once through the game's page (#138),
// a `ui` effector like buy-program.js: there's no API for it before Singularity. Arguments: home's RAM (GB) when the
// brain asked, the tech vendor in the player's city, and when to give up (the game's `Date.now()`), so it ends within
// its Agent's round.
// - The game first: home with more RAM than that is done, without touching the page. So a repeat buys nothing more.
// - Never over an open dialog the dialog watcher leaves (a script's, the owner's): that's theirs to answer (#143).
// - The City, the vendor, "Upgrade 'home' RAM" while it can be bought (`Locations/ui/RamButton.tsx`: disabled when the
//   player can't afford it or home is at its limit). A purchase opens no dialog (`Server/ServerPurchases.ts:168`).
// - Once it has moved the page, it goes back to the Terminal, however it ends.
// RAM: `getServerMaxRam` 0.05 (ram-budget.json); the page costs nothing.
import type { NS } from "../ns.ts";
import { reportPageEffect } from "../page/page-effect.ts";

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const fromRam = Number(ns.args[0] ?? 0);
  const vendor = String(ns.args[1] ?? "");
  const deadlineMs = Number(ns.args[2] ?? 0);
  await reportPageEffect(ns, deadlineMs, {
    isDone: () => ns.getServerMaxRam("home") > fromRam,
    doing: "buy it through",
    steps: async (gamePage) =>
      (await gamePage.openCityLocation(vendor)) ??
      // Enabled only while the player can afford it: a disabled one's click handler would still run, and open a
      // dialog saying why not.
      (await gamePage.clickWhenThere(
        "//button[not(@disabled) and contains(normalize-space(), \"Upgrade 'home' RAM\")]",
        "home RAM upgrade to buy (is the money there?)",
      )),
    notDoneAfter: `home's RAM isn't more than ${fromRam} GB after upgrading it`,
  });
}
