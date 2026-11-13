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
 *   ($150b) moves none of them: its value is 0 at flat competence, its focus value left out (it lifts the one focus,
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
 * - **The route after it** (`bladeburnerPersonAfterInstall`, `blackOpsInstallTiming`): B6's estimate
 *   (`blackOpsRouteEstimate`) at the install's person: the rank kept, the combat stats at their levels before, the
 *   success chance and stamina times the gain; the actions' and Black Ops' chances scaled by the competence there over
 *   the competence read, their times, ρ and the stamina computed there.
 * - **The choice:** keeping, B6's estimate now; installing now, the rebuild and the estimate after it; the least, a tie to
 *   keeping (an install is irreversible); installing now only with something to install. Both estimates take the next
 *   one's rank by the tail alone (the counts' stock now left out of both alike). While a rebuild is under way
 *   (`levels`, its targets, #407's review), both are priced at those levels: keeping finishes it (Training from the
 *   levels now) and then B6's estimate there; installing now rebuilds to them from 0 at the gain.
 * - **Biased towards installing, so untrusted until #408** (#407's review): B6's estimate holds the competence flat,
 *   which makes the route about 10³ times too long early on (the skill points a rank of 3 brings alone make it about
 *   ×1,000 faster by rank 400,000, the reviewer's figures), so each augmentation's share of it is overpriced by that
 *   factor against a rebuild that isn't: EsperTech's 7% of a realistic route of about 466 h is 33 h, against a 133 h
 *   rebuild at combat 300, yet it installs. BN6 is unplayable (./bitnodes.ts), so the campaign never runs this live; in
 *   a BN6 entered by hand it installs too eagerly. #408, the competence's growth in the estimate, is what corrects it.
 * Left out, and labelled:
 * - the competence's rise over the route on either side (B6's estimate holds it): the stats the actions and Training add
 *   after the rebuild, and the level multipliers' share of that later experience (×gain); on balance towards
 *   installing, as above;
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
import { type BlackOpsRouteTime, blackOpsRouteEstimate } from "./bladeburner-route.ts";

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
  /** Keeping the cycle: B6's estimate now (Infinity: never at the competence now). */
  keepSeconds: number;
  /** The rebuild after installing now (`bladeburnerRebuildSeconds` from 0, at the gain). */
  rebuildSeconds: number;
  /** B6's estimate at the install's person, after the rebuild. */
  afterSeconds: number;
  /** Installing now: the rebuild and the estimate after it; null with nothing to install. */
  installNowSeconds: number | null;
  choice: "keep" | "install";
  /** The gain the install gives the route. */
  gain: BladeburnerInstallGain;
}

/** B6's estimate at the input's person, or at `forecast`, the next one's rank by the tail alone (#404). */
function routeSeconds(
  input: Omit<BladeburnerActionInput, "target">,
  at: BlackOpsRouteAt,
  forecast?: BladeburnerPerson,
): BlackOpsRouteTime {
  return blackOpsRouteEstimate(forecast === undefined ? input : { ...input, forecast }, {
    ...at,
    firstToRankSeconds: null,
  });
}

/**
 * The planner's install timing on the Black Ops' route (#404, see above): keep (B6's estimate now) against install now
 * (the rebuild at `gain`, then B6's estimate at the person after it), the least chosen, a tie to keeping; installing
 * now only with something to install (`installable`). Game seconds.
 */
export function blackOpsInstallTiming({
  input,
  at,
  combat,
  gain,
  installable,
  levels,
}: {
  input: Omit<BladeburnerActionInput, "target">;
  at: BlackOpsRouteAt;
  combat: CombatPerson;
  gain: BladeburnerInstallGain;
  installable: boolean;
  /** A rebuild under way (#407's review): its targets, the levels both sides are priced at. Absent, the levels now. */
  levels?: Readonly<Record<CombatStat, number>>;
}): BlackOpsInstallTiming {
  const priced = levels === undefined ? input.person : personAtLevels(input.person, levels);
  // Keeping finishes a rebuild under way first (Training from the levels now), then the route at its targets.
  const finish = levels === undefined ? 0 : bladeburnerRebuildSeconds(combat, { targets: levels }).seconds;
  const keepSeconds = finish + routeSeconds(input, at, levels === undefined ? undefined : priced).seconds;
  const rebuildSeconds = bladeburnerRebuildSeconds(combat, {
    targets: levels ?? combat.skills,
    gain,
    fromZero: true,
  }).seconds;
  const afterSeconds = routeSeconds(input, at, bladeburnerPersonAfterInstall(priced, gain)).seconds;
  const installNowSeconds = installable ? rebuildSeconds + afterSeconds : null;
  const choice = installNowSeconds !== null && installNowSeconds < keepSeconds ? "install" : "keep";
  return { keepSeconds, rebuildSeconds, afterSeconds, installNowSeconds, choice, gain };
}

/**
 * Each augmentation's value on the route (#404): B6's estimate after an install of nothing (hacking and charisma at 1,
 * the combat stats rebuilt) less B6's estimate after an install of it alone (its gain, `bladeburnerInstallGain`), game
 * seconds saved, the rebuild left out (the install's, common to a set). 0 for one that moves none of the route's
 * multipliers; NaN where both are never.
 */
export function bladeburnerAugmentationValues({
  input,
  at,
  augmentations,
}: {
  input: Omit<BladeburnerActionInput, "target">;
  at: BlackOpsRouteAt;
  augmentations: readonly string[];
}): { augmentation: string; savedSeconds: number }[] {
  const now = routeSeconds(input, at, bladeburnerPersonAfterInstall(input.person, NO_INSTALL_GAIN)).seconds;
  return augmentations.map((augmentation) => {
    const gain = bladeburnerInstallGain(0, [augmentation]);
    const after = routeSeconds(input, at, bladeburnerPersonAfterInstall(input.person, gain)).seconds;
    return { augmentation, savedSeconds: now - after };
  });
}
