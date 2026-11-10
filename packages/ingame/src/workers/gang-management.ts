// What `gang.js` does (#325), apart from its entry so a test can drive it with a stand-in NS: the brain's gang state
// done, then the gang read, with the NS API alone, which needs a gang but no Singularity (`NetscriptFunctions/
// Gang.ts:20-23`). With no gang formed, it reads that there's none.
// - The recruits first, in order, each name not a member yet, while the game takes them (`Gang.ts:336-354`): a refusal
//   is a problem, and none after it is tried (the respect only lets the next in after this one).
// - Then the ascensions (#328, G2), each member named while its ascension points are still the brain's reading
//   (core's `gangAscensionOrderStands`): the worker runs again on the same state 10 s later, and must not ascend it
//   twice. One the game refuses (`NetscriptFunctions/Gang.ts:284-290`: nothing when it can't ascend) is a problem.
// - Then the purchases (#330, G3), each while the order stands: the member still one, its ascension points still the
//   brain's reading (an ascension since would lose the item, `GangMember.ts:308-319`), the item not owned (the game
//   refuses it, `:355-356`), and the money less its cost (core's table × the gang's `equipmentCostMult`, `Gang.ts:
//   429-434`) at the state's `keepMoney` or more: the brain's holds for its other spending (none spent with null). A
//   stale order is skipped, not a problem: the brain's next reading, 10 s on, orders afresh. One the game refuses is.
// - Then the tasks, each member named, every time: setting a member's task again changes nothing in the game
//   (`GangMember.ts:91-98`), and the owner may have moved it. A name that isn't a member is skipped; a task the
//   gang's kind hasn't, or one the game refuses, is a problem, and that member's task is left as it was.
// - Then territory warfare (#332, G4), after the tasks so the crew is on it: with the brain's order, engaged while it
//   stands (core's `gangWarfareOrderStands`: the territory the clashes are expected to gain an update, from the powers
//   read now, `gangTerritoryPerUpdate`, above the brain's break-even), else disengaged; a stale order never keeps
//   clashes on. With none (an older brain), the game's flag is left alone. Set only when it differs.
// - Then the reading: the gang's information (its warfare flag and clash chance too, G4), each other gang's power,
//   territory and the win chance against it (core's `gangClashWinChance`), and each member's with its upgrades and
//   augmentations, in the game's order, and the `keepMoney` it was given, for the run report.
// RAM (`Netscript/RamCostGenerator.ts:271-298`): `gang.ascendMember` and `gang.purchaseEquipment` 4 GB each,
// `gang.getGangInformation`, `gang.getAllGangInformation` (G4), `gang.getMemberInformation`, `gang.recruitMember`,
// `gang.setMemberTask` and `gang.setTerritoryWarfare` (G4) 2 GB each,
// `gang.getMemberNames` 1 GB, `getServerMoneyAvailable` 0.1 GB (on home, the player's money); `gang.inGang`,
// `gang.getTaskNames` and `gang.getBonusTime` nothing. Nothing here may be named like an NS function
// (packages/ingame/README.md, "RAM"): the gang information's recruit threshold isn't read, as its property is named
// like one (1 GB); the brain computes it (core's `gangRecruitsAllowed`). The game's ascension result (2 GB) isn't
// asked for either: core computes it from the points read (`gangAscensionResult`), checked in the parity suite. Nor
// the equipment getters (2 GB each): core's table (`GANG_EQUIPMENT`), checked against them in the parity suite. Nor
// `gang.getChanceToWinClash` (4 GB, G4): core computes it from the powers read, checked against it there too.
import {
  GANG_STATS,
  type GangInformation,
  type GangMemberReading,
  type GangReading,
  type GangState,
  gangAscensionOrderStands,
  gangAscensionPointsOf,
  gangClashWinChance,
  gangEquipment,
  gangEquipmentCost,
  gangMemberOwns,
  gangTerritoryPerUpdate,
  gangWarfareOrderStands,
} from "@bitburner-agent/core";
import type { NS } from "../ns.ts";

/** Does `state` (the brain's) and reads the gang. */
export function gangManagement(ns: NS, state: GangState): GangReading {
  const problems: string[] = [];
  if (!ns.gang.inGang()) return { gang: null, members: [], problems };
  const memberNames = new Set(ns.gang.getMemberNames());
  for (const name of state.recruit) {
    if (memberNames.has(name)) continue;
    if (!ns.gang.recruitMember(name)) {
      problems.push(`the game didn't recruit ${name} (respect short, the name taken, or 12 members)`);
      break;
    }
    memberNames.add(name);
  }
  for (const order of state.ascend) {
    if (!memberNames.has(order.name)) continue;
    const points = gangAscensionPointsOf(ns.gang.getMemberInformation(order.name));
    if (!gangAscensionOrderStands(order, points)) continue;
    if (ns.gang.ascendMember(order.name) === undefined) problems.push(`the game didn't ascend ${order.name}`);
  }
  const { keepMoney } = state;
  if (state.buy.length > 0 && keepMoney !== null) {
    const { equipmentCostMult } = ns.gang.getGangInformation();
    for (const order of state.buy) {
      if (!memberNames.has(order.name)) continue;
      const member = ns.gang.getMemberInformation(order.name);
      if (!gangAscensionOrderStands(order, gangAscensionPointsOf(member))) continue;
      if (gangMemberOwns(member, order.equipment)) continue;
      const cost = gangEquipmentCost(gangEquipment(order.equipment), equipmentCostMult);
      // Negated, so a cost not a number (an older game's multiplier gone) buys nothing.
      if (!(ns.getServerMoneyAvailable("home") - cost >= keepMoney)) continue;
      if (!ns.gang.purchaseEquipment(order.name, order.equipment)) {
        problems.push(`the game didn't buy ${order.equipment} for ${order.name}`);
      }
    }
  }
  // The game answers true for a task this gang's kind hasn't, having left the member Unassigned
  // (`NetscriptFunctions/Gang.ts:200-207`): such a task is refused here, before it's set.
  const taskNames = ns.gang.getTaskNames();
  for (const [name, taskName] of Object.entries(state.tasks)) {
    if (!memberNames.has(name)) continue;
    if (!taskNames.includes(taskName)) problems.push(`${taskName} isn't a task of this gang, for ${name}`);
    else if (!ns.gang.setMemberTask(name, taskName)) problems.push(`the game didn't set ${name} to ${taskName}`);
  }
  // Territory warfare (G4), the other gangs read once, the game's order.
  const faction = ns.gang.getGangInformation().faction;
  const allGangs = ns.gang.getAllGangInformation();
  const others = Object.entries(allGangs)
    .filter(([name]) => name !== faction)
    .map(([name, figures]) => ({ faction: name, power: figures.power, territory: figures.territory }));
  const own = allGangs[faction];
  if (state.warfare !== null && own !== undefined) {
    const engage = gangWarfareOrderStands(state.warfare, gangTerritoryPerUpdate(own.power, own.territory, others));
    if (ns.gang.getGangInformation().territoryWarfareEngaged !== engage) ns.gang.setTerritoryWarfare(engage);
  }
  const information = ns.gang.getGangInformation();
  const gang: GangInformation = {
    faction: information.faction,
    isHacking: information.isHacking,
    respect: information.respect,
    wantedLevel: information.wantedLevel,
    wantedPenalty: information.wantedPenalty,
    territory: information.territory,
    respectGainRate: information.respectGainRate,
    moneyGainRate: information.moneyGainRate,
    wantedLevelGainRate: information.wantedLevelGainRate,
    power: information.power,
    equipmentCostMult: information.equipmentCostMult,
    territoryWarfareEngaged: information.territoryWarfareEngaged,
    territoryClashChance: information.territoryClashChance,
    otherGangs: others.map((other) => ({ ...other, winChance: gangClashWinChance(information.power, other.power) })),
    bonusTimeMs: ns.gang.getBonusTime(),
  };
  const members = ns.gang.getMemberNames().map((name) => {
    const figures = ns.gang.getMemberInformation(name) as unknown as Record<string, number>;
    const reading: Record<string, unknown> = {
      name,
      task: (figures as unknown as { task: string }).task,
      earnedRespect: figures.earnedRespect,
      respectGain: figures.respectGain,
      moneyGain: figures.moneyGain,
      wantedLevelGain: figures.wantedLevelGain,
    };
    for (const stat of GANG_STATS) {
      for (const key of [stat, `${stat}_exp`, `${stat}_mult`, `${stat}_asc_mult`, `${stat}_asc_points`]) {
        reading[key] = figures[key];
      }
    }
    // The equipment lists (G3), copies.
    for (const key of ["upgrades", "augmentations"]) reading[key] = [...(figures[key] as unknown as string[])];
    return reading as unknown as GangMemberReading;
  });
  return { gang, members, problems, keepMoney };
}
