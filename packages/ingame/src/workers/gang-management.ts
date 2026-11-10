// What `gang.js` does (#325), apart from its entry so a test can drive it with a stand-in NS: the brain's gang state
// done, then the gang read, with the NS API alone, which needs a gang but no Singularity (`NetscriptFunctions/
// Gang.ts:20-23`). With no gang formed, it reads that there's none.
// - The recruits first, in order, each name not a member yet, while the game takes them (`Gang.ts:336-354`): a refusal
//   is a problem, and none after it is tried (the respect only lets the next in after this one).
// - Then the tasks, each member named, every time: setting a member's task again changes nothing in the game
//   (`GangMember.ts:91-98`), and the owner may have moved it. A name that isn't a member is skipped; a task the
//   gang's kind hasn't, or one the game refuses, is a problem, and that member's task is left as it was.
// - Then the reading: the gang's information, and each member's, in the game's order.
// RAM (`Netscript/RamCostGenerator.ts:271-298`): `gang.getGangInformation`, `gang.getMemberInformation`,
// `gang.recruitMember` and `gang.setMemberTask` 2 GB each, `gang.getMemberNames` 1 GB; `gang.inGang`,
// `gang.getTaskNames` and `gang.getBonusTime` nothing. Nothing here may be named like an NS function (packages/ingame/README.md, "RAM"): the
// gang information's recruit threshold isn't read, as its property is named like one (1 GB); the brain computes it
// (core's `gangRecruitsAllowed`).
import {
  GANG_STATS,
  type GangInformation,
  type GangMemberReading,
  type GangReading,
  type GangState,
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
  // The game answers true for a task this gang's kind hasn't, having left the member Unassigned
  // (`NetscriptFunctions/Gang.ts:200-207`): such a task is refused here, before it's set.
  const taskNames = ns.gang.getTaskNames();
  for (const [name, taskName] of Object.entries(state.tasks)) {
    if (!memberNames.has(name)) continue;
    if (!taskNames.includes(taskName)) problems.push(`${taskName} isn't a task of this gang, for ${name}`);
    else if (!ns.gang.setMemberTask(name, taskName)) problems.push(`the game didn't set ${name} to ${taskName}`);
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
      for (const key of [stat, `${stat}_exp`, `${stat}_mult`, `${stat}_asc_mult`]) reading[key] = figures[key];
    }
    return reading as unknown as GangMemberReading;
  });
  return { gang, members, problems };
}
