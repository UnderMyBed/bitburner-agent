/**
 * Bladeburner (#359), slice B7 (#404): augmentations and installs on the Black Ops' route. The planner chooses (owner
 * decision 67): the rules propose keeping the cycle or installing now what A6 would install, each scored by B6's
 * estimate of the route's time to the destroy (./bladeburner-route.ts). Paths are `vendor/bitburner-src/src/`'s (v3.0.1).
 * - **What an install keeps:** all of Bladeburner. `prestigeAugmentation` resets only the action under way and rejoins
 *   the faction at rank 25 or more (`Prestige.ts:155-158`, `Bladeburner/Bladeburner.ts:259-273`), so the rank, the max
 *   rank and the skill points, the skills, the counts and levels, the cities' chaos, the stamina bonus Training built and
 *   the Black Ops done stand. A destroy clears it (`PersonObjects/Player/PlayerObjectGeneralMethods.ts:160`).
 * - **What it loses:** every stat's level to 1 and its experience to 0, hacking, the four combat stats and charisma
 *   (intelligence is kept), and the money to $1,000 (`PersonObjects/Player/PlayerObjectGeneralMethods.ts:79-101`). So
 *   the max stamina falls with the agility (`Bladeburner.ts:1329-1345`). The Bladeburners faction's reputation goes into
 *   its favour (`Faction/Faction.ts:77-85`); rank gained earns it again, 2 × the rank × `faction_rep` × (1 + favour/100)
 *   (`Bladeburner/Formulas.ts:46-49`, `data/Constants.ts:41`, credited only while a member, `Bladeburner.ts:1276-1282`).
 * - **What it gains:** each queued augmentation's multipliers, by product (`applyAugmentation`,
 *   `Augmentation/AugmentationHelpers.ts:39-50`; `mergeMultipliers`, `PersonObjects/Multipliers.ts:71-79`), no BitNode
 *   scaling them: the combat stats' level and experience multipliers, and Bladeburner's `bladeburner_success_chance`,
 *   `bladeburner_max_stamina` and `bladeburner_stamina_gain`. The Bladeburners faction sells 18
 *   (`Augmentation/Augmentations.ts:190-300` and on, core's `AUGMENTATIONS`): together ×1.92 on the success chance,
 *   ×1.17 to ×1.23 on the combat levels, ×1.21 on the max stamina and ×1.17 on its regain; The Blade's Simulacrum
 *   ($150b) moves none of them: its value is 0 on the route's estimate, its focus value left out (it lifts the one focus,
 *   `Bladeburner.ts:178-180`, so the gym or faction work could run beside the actions; the planner's, later).
 *   NeuroFlux Governor's levels add 1.01 each to the levels and experience.
 * - **The rebuild** (the install's time cost): the brain trains the four combat stats back to their levels before the
 *   install with Bladeburner's own Training (the brain's Bladeburner rule), 30 × `mults.<stat>_exp` of each of the four
 *   an attempt of 30 s, taken twice (`Bladeburner.ts:1094-1105`, then `PersonObjects/Person.ts:192-198`: core's
 *   `trainingExpPerAttempt`, the upstream quirk), all four at once; so the rebuild is the slowest stat's experience to its
 *   level at the multipliers after over that rate. Not the gym: Powerhouse Gym's 10 × `mults.<stat>_exp` a second, one
 *   stat at a time (`Work/Formulas.ts:108-121`, `Locations/data/LocationsMetadata.ts:322-328`, B1's, measured within 2%
 *   of its estimate in #367's suite) is 2.5 × mult a stat over the four against Training's mult², faster below a
 *   multiplier of 2.5, but it costs $2,400 a second and the player's one focus, and the install leaves $1,000. Training
 *   costs 0.1425 stamina an attempt (`Bladeburner.ts:1095`), under the natural regain's 0.255 at agility 1, so it never
 *   rests. Its time is game seconds (bonus time's ×5 left out: cautious).
 * - **The route after it** (`bladeburnerPersonAfterInstall`, `blackOpsInstallTiming`): the route's grown estimate
 *   (#408, ./bladeburner-growth.ts) at the install's person: the rank, skills and max levels kept, the combat stats at
 *   their levels before with their experience from 0 at the multipliers times the gain (so the actions' experience
 *   after it counts the gain), the success chance and stamina times the gain; the actions' and Black Ops' chances
 *   scaled by the competence there over the competence read, their times, ρ and the stamina computed there.
 * - **The choice:** keeping, the grown estimate now; installing now, the rebuild and the grown estimate after it; the
 *   least, a tie to keeping (an install is irreversible); installing now only with something to install. Both take the
 *   next one's rank by the growth's tail alone (the counts' stock now left out of both alike). While a rebuild is under
 *   way (`levels`, its targets, #407's review), both are priced at those levels: keeping finishes it (Training from the
 *   levels now) and then the grown estimate there; installing now rebuilds to them from 0 at the gain.
 * - **Its bias towards installing is gone** (#408): #407's review found B6's flat estimate made the route about 10³
 *   times too long, so an augmentation's share of it was overpriced against a rebuild that isn't (EsperTech's 7% of
 *   the route against a 133 h rebuild at combat 300, installed). On the grown estimate the route is 78.6 h there,
 *   EsperTech's value within the estimate's own step (−0.4%), and keeping is chosen; the Bladeburners' shop at combat
 *   100, its rebuild half an hour against 30 h saved, is installed (core's bladeburner-growth.test.ts).
 * Left out, and labelled:
 * - the grown estimate's own (./bladeburner-growth.ts), on both sides alike;
 * - hacking and charisma, which the install also resets: taken at 1 after it (nothing in the route rebuilds them on
 *   purpose), against installing; their weights are small (the contracts' charisma 0.1, hacking 0);
 * - the rank the actions gain during the rebuild (Training gains none, `Bladeburner.ts:1094-1105`), cautious;
 * - the Bladeburners faction's reputation lost to favour, which only the next purchases need, not the route;
 * - the money the install resets, and the hospital's: the route's time doesn't read them;
 * - the gym, the planner's choice of the player's one focus (#359), later.
 */
import { AUGMENTATIONS } from "./augmentation-data.ts";
import { NEUROFLUX_GOVERNOR } from "./augmentations.ts";
import { COMBAT_STATS, type CombatPerson, type CombatStat, skillExpFor } from "./bladeburner.ts";
import {
  BLADEBURNER_REST_SECONDS,
  BLADEBURNER_TRAINING,
  type BladeburnerActionInput,
  type BladeburnerPerson,
  trainingExpPerAttempt,
} from "./bladeburner-actions.ts";
import type { BladeburnerBlackOp } from "./bladeburner-black-ops.ts";
import { blackOpsRouteGrownEstimate } from "./bladeburner-growth.ts";

/** What an install gives the route (#404): each combat stat's level and experience multiplier, and Bladeburner's. */
export interface BladeburnerInstallGain {
  /** `mults.<stat>`'s factor, each combat stat. */
  levels: Record<CombatStat, number>;
  /** `mults.<stat>_exp`'s factor, each combat stat. */
  exp: Record<CombatStat, number>;
  successChance: number;
  maxStamina: number;
  staminaGain: number;
}

const each = (value: number) =>
  Object.fromEntries(COMBAT_STATS.map((stat) => [stat, value])) as Record<CombatStat, number>;

/** No install: every factor 1. */
export const NO_INSTALL_GAIN: Readonly<BladeburnerInstallGain> = {
  levels: each(1),
  exp: each(1),
  successChance: 1,
  maxStamina: 1,
  staminaGain: 1,
};

/**
 * The gain an install of NeuroFlux Governor's `neuroFluxLevels` and `augmentations` gives the route (#404): each
 * multiplier's product (`applyAugmentation`, `Augmentation/AugmentationHelpers.ts:39-50`; `mergeMultipliers`,
 * `PersonObjects/Multipliers.ts:71-79`), core's `AUGMENTATIONS`'. An unknown name throws.
 */
export function bladeburnerInstallGain(
  neuroFluxLevels: number,
  augmentations: readonly string[] = [],
): BladeburnerInstallGain {
  const gain: BladeburnerInstallGain = {
    levels: each(1),
    exp: each(1),
    successChance: 1,
    maxStamina: 1,
    staminaGain: 1,
  };
  const apply = (name: string, times: number) => {
    if (!Object.hasOwn(AUGMENTATIONS, name)) throw new RangeError(`no augmentation ${JSON.stringify(name)}`);
    const { multipliers } = AUGMENTATIONS[name] as { multipliers: Readonly<Record<string, number>> };
    const factor = (key: string) => (multipliers[key] ?? 1) ** times;
    for (const stat of COMBAT_STATS) {
      gain.levels[stat] *= factor(stat);
      gain.exp[stat] *= factor(`${stat}_exp`);
    }
    gain.successChance *= factor("bladeburner_success_chance");
    gain.maxStamina *= factor("bladeburner_max_stamina");
    gain.staminaGain *= factor("bladeburner_stamina_gain");
  };
  apply(NEUROFLUX_GOVERNOR, neuroFluxLevels);
  for (const name of augmentations) apply(name, 1);
  return gain;
}

/**
 * The person the route has after an install and its rebuild (#404): the combat stats at their levels now (the rebuild's
 * target), hacking and charisma at 1 (reset, `PlayerObjectGeneralMethods.ts:79-96`; not rebuilt on purpose, cautious),
 * intelligence kept, and Bladeburner's three multipliers times the gain.
 */
export function bladeburnerPersonAfterInstall(
  person: BladeburnerPerson,
  gain: BladeburnerInstallGain,
): BladeburnerPerson {
  return {
    skills: { ...person.skills, hacking: 1, charisma: 1 },
    mults: {
      ...person.mults,
      bladeburner_success_chance: person.mults.bladeburner_success_chance * gain.successChance,
      bladeburner_max_stamina: person.mults.bladeburner_max_stamina * gain.maxStamina,
      bladeburner_stamina_gain: person.mults.bladeburner_stamina_gain * gain.staminaGain,
    },
  };
}

/** `person` with each combat stat at least at `levels` (#407's review: a rebuild's targets). */
function personAtLevels(person: BladeburnerPerson, levels: Readonly<Record<CombatStat, number>>): BladeburnerPerson {
  const skills = { ...person.skills };
  for (const stat of COMBAT_STATS) skills[stat] = Math.max(skills[stat], levels[stat]);
  return { ...person, skills };
}

/** Training's experience a game second of one combat stat at its experience multiplier (`Bladeburner.ts:1094-1105`). */
export function trainingExpPerSecond(expMult: number): number {
  return trainingExpPerAttempt(expMult) / BLADEBURNER_REST_SECONDS[BLADEBURNER_TRAINING];
}

/** The rebuild (#404): game seconds by Training to the targets, and each combat stat's. */
export interface BladeburnerRebuild {
  seconds: number;
  byStat: Record<CombatStat, number>;
}

/**
 * Training's game seconds to each combat stat's `targets` level (#404): the experience it needs at `combat`'s level
 * multiplier times the gain (core's `skillExpFor`, `PersonObjects/formulas/skill.ts:17-34`), less the experience now
 * (none `fromZero`, an install's), over Training's rate at the experience multiplier times the gain
 * (`trainingExpPerSecond`); all four at once, so the slowest's. Infinity at a rate of 0.
 */
export function bladeburnerRebuildSeconds(
  combat: CombatPerson,
  {
    targets = combat.skills,
    gain = NO_INSTALL_GAIN,
    fromZero = false,
  }: { targets?: Readonly<Record<CombatStat, number>>; gain?: Readonly<BladeburnerInstallGain>; fromZero?: boolean },
): BladeburnerRebuild {
  const byStat = each(0);
  for (const stat of COMBAT_STATS) {
    const target = targets[stat];
    const needed = target <= 1 ? 0 : skillExpFor(target, combat.mults[stat] * gain.levels[stat]);
    const left = Math.max(0, needed - (fromZero ? 0 : combat.exp[stat]));
    const rate = trainingExpPerSecond(combat.mults[`${stat}_exp`] * gain.exp[stat]);
    byStat[stat] = left === 0 ? 0 : rate > 0 ? left / rate : Number.POSITIVE_INFINITY;
  }
  return { seconds: Math.max(...COMBAT_STATS.map((stat) => byStat[stat])), byStat };
}

/** The next Black Op as the route's estimate reads it (#398): the rank, the next one and its chance's range read. */
export interface BlackOpsRouteAt {
  rank: number;
  next: BladeburnerBlackOp;
  chanceRead: readonly [number, number];
}

/** The planner's install timing on the Black Ops' route (#404): each candidate's estimate, game seconds, and the choice. */
export interface BlackOpsInstallTiming {
  /** Keeping the cycle: the route's grown estimate now (#408; Infinity: never). */
  keepSeconds: number;
  /** The rebuild after installing now (`bladeburnerRebuildSeconds` from 0, at the gain). */
  rebuildSeconds: number;
  /** The route's grown estimate at the install's person, after the rebuild. */
  afterSeconds: number;
  /** Installing now: the rebuild and the estimate after it; null with nothing to install. */
  installNowSeconds: number | null;
  choice: "keep" | "install";
  /** The gain the install gives the route. */
  gain: BladeburnerInstallGain;
}

/** What the grown estimate reads beside B6's (#408): the BitNode's skill cost and the skill points unspent. */
export interface BlackOpsGrowthAt {
  costMultiplier: number;
  points?: number;
}

/**
 * `combat` with each stat at `levels` at least (#407's review: a rebuild's targets, its experience the least for them),
 * and its level and experience multipliers times `gain` (#408: an install's, its experience from 0).
 */
function combatAt(
  combat: CombatPerson,
  levels: Readonly<Record<CombatStat, number>>,
  gain: Readonly<BladeburnerInstallGain> | null,
): CombatPerson {
  const skills = { ...combat.skills };
  const exp = { ...combat.exp };
  const mults = { ...combat.mults };
  for (const stat of COMBAT_STATS) {
    mults[stat] = combat.mults[stat] * (gain?.levels[stat] ?? 1);
    mults[`${stat}_exp`] = combat.mults[`${stat}_exp`] * (gain?.exp[stat] ?? 1);
    const level = gain === null ? Math.max(skills[stat], levels[stat]) : levels[stat];
    const least = level <= 1 ? 0 : skillExpFor(level, mults[stat]);
    skills[stat] = level;
    exp[stat] = gain === null ? Math.max(exp[stat], least) : least;
  }
  return { skills, exp, mults };
}

/**
 * The route's grown estimate (#408, ./bladeburner-growth.ts) at the input's person, or at `forecast` with its combat
 * figures `combat`; the next one's rank by the growth's tail alone (B5's stock now left out of both sides alike).
 */
function routeSeconds(
  input: Omit<BladeburnerActionInput, "target">,
  at: BlackOpsRouteAt,
  combat: CombatPerson,
  growth: BlackOpsGrowthAt,
  forecast?: BladeburnerPerson,
): number {
  return blackOpsRouteGrownEstimate(forecast === undefined ? input : { ...input, forecast }, at, {
    combat,
    costMultiplier: growth.costMultiplier,
    points: growth.points ?? 0,
  }).seconds;
}

/**
 * The planner's install timing on the Black Ops' route (#404, see above): keep (the grown estimate now, #408) against
 * install now (the rebuild at `gain`, then the grown estimate at the person after it, its experience from 0 at the
 * multipliers times the gain), the least chosen, a tie to keeping; installing now only with something to install
 * (`installable`). Game seconds.
 */
export function blackOpsInstallTiming({
  input,
  at,
  combat,
  gain,
  installable,
  levels,
  growth,
}: {
  input: Omit<BladeburnerActionInput, "target">;
  at: BlackOpsRouteAt;
  combat: CombatPerson;
  gain: BladeburnerInstallGain;
  installable: boolean;
  /** A rebuild under way (#407's review): its targets, the levels both sides are priced at. Absent, the levels now. */
  levels?: Readonly<Record<CombatStat, number>>;
  growth: BlackOpsGrowthAt;
}): BlackOpsInstallTiming {
  const priced = levels === undefined ? input.person : personAtLevels(input.person, levels);
  // Keeping finishes a rebuild under way first (Training from the levels now), then the route at its targets.
  const finish = levels === undefined ? 0 : bladeburnerRebuildSeconds(combat, { targets: levels }).seconds;
  const keepSeconds =
    finish +
    (levels === undefined
      ? routeSeconds(input, at, combat, growth)
      : routeSeconds(input, at, combatAt(combat, levels, null), growth, priced));
  const targets = levels ?? combat.skills;
  const rebuildSeconds = bladeburnerRebuildSeconds(combat, { targets, gain, fromZero: true }).seconds;
  const afterSeconds = routeSeconds(
    input,
    at,
    combatAt(combat, targets, gain),
    growth,
    bladeburnerPersonAfterInstall(priced, gain),
  );
  const installNowSeconds = installable ? rebuildSeconds + afterSeconds : null;
  const choice = installNowSeconds !== null && installNowSeconds < keepSeconds ? "install" : "keep";
  return { keepSeconds, rebuildSeconds, afterSeconds, installNowSeconds, choice, gain };
}

/**
 * Each augmentation's value on the route (#404): the grown estimate (#408) after an install of nothing (hacking and
 * charisma at 1, the combat stats rebuilt) less the grown estimate after an install of it alone (its gain,
 * `bladeburnerInstallGain`), game seconds saved, the rebuild left out (the install's, common to a set). 0 for one that
 * moves none of the route's multipliers; NaN where both are never.
 */
export function bladeburnerAugmentationValues({
  input,
  at,
  combat,
  growth,
  augmentations,
}: {
  input: Omit<BladeburnerActionInput, "target">;
  at: BlackOpsRouteAt;
  combat: CombatPerson;
  growth: BlackOpsGrowthAt;
  augmentations: readonly string[];
}): { augmentation: string; savedSeconds: number }[] {
  const after = (gain: BladeburnerInstallGain) =>
    routeSeconds(
      input,
      at,
      combatAt(combat, combat.skills, gain),
      growth,
      bladeburnerPersonAfterInstall(input.person, gain),
    );
  const now = after(NO_INSTALL_GAIN);
  return augmentations.map((augmentation) => ({
    augmentation,
    savedSeconds: now - after(bladeburnerInstallGain(0, [augmentation])),
  }));
}
