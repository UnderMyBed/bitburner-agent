/**
 * The game's classes (#158): university courses and gym workouts, where each is taught and what it costs, and the money
 * guard every backend applies before starting one. Shared by the in-game code and the brain; plain literals, as in
 * factions.ts.
 * - Each university and gym is in one city (`Locations/data/LocationsMetadata.ts`), reached from its City page only.
 * - A class costs its base money a second times the location's `costMult` (`calculateCost`, `Work/Formulas.ts:100-105`;
 *   10% off with the location's server backdoored, left out here, so the guard errs high). The game takes it every
 *   cycle, and lets the money go negative.
 */

/** Each university and gym: its city, what it teaches, and its cost multiplier. Universities first. */
export const CLASS_LOCATIONS: Record<string, { city: string; kind: "university" | "gym"; costMult: number }> = {
  "Summit University": { city: "Aevum", kind: "university", costMult: 4 },
  "Rothman University": { city: "Sector-12", kind: "university", costMult: 3 },
  "ZB Institute of Technology": { city: "Volhaven", kind: "university", costMult: 5 },
  "Crush Fitness Gym": { city: "Aevum", kind: "gym", costMult: 3 },
  "Snap Fitness Gym": { city: "Aevum", kind: "gym", costMult: 10 },
  "Iron Gym": { city: "Sector-12", kind: "gym", costMult: 1 },
  "Powerhouse Gym": { city: "Sector-12", kind: "gym", costMult: 20 },
  "Millenium Fitness Gym": { city: "Volhaven", kind: "gym", costMult: 7 },
};

/** Every university and gym, by the game's name. */
export const CLASS_LOCATION_NAMES = Object.keys(CLASS_LOCATIONS);

/**
 * Each class type, by the game's name (`UniversityClassType`, `GymType`: "str" for strength, as Singularity's
 * `gymWorkout` takes it; `Work/Enums.ts`), in the game's order: where it's taught, a plain name, how the Work page and
 * the overview word it (`youAreCurrently`, `Work/ClassWork.tsx:22-73`), the start of its button's text
 * (`Locations/ui/UniversityLocation.tsx:51-82`, `GymLocation.tsx:42-53`) and its base money a second.
 */
export const CLASS_TYPES: Record<
  string,
  { at: "university" | "gym"; name: string; youAreCurrently: string; button: string; moneyPerSecond: number }
> = {
  "Computer Science": {
    at: "university",
    name: "Computer Science",
    youAreCurrently: "studying Computer Science",
    button: "Study Computer Science (",
    moneyPerSecond: 0,
  },
  "Data Structures": {
    at: "university",
    name: "Data Structures",
    youAreCurrently: "taking a Data Structures course",
    button: "Take Data Structures course (",
    moneyPerSecond: 40,
  },
  Networks: {
    at: "university",
    name: "Networks",
    youAreCurrently: "taking a Networks course",
    button: "Take Networks course (",
    moneyPerSecond: 80,
  },
  Algorithms: {
    at: "university",
    name: "Algorithms",
    youAreCurrently: "taking an Algorithms course",
    button: "Take Algorithms course (",
    moneyPerSecond: 320,
  },
  Management: {
    at: "university",
    name: "Management",
    youAreCurrently: "taking a Management course",
    button: "Take Management course (",
    moneyPerSecond: 160,
  },
  Leadership: {
    at: "university",
    name: "Leadership",
    youAreCurrently: "taking a Leadership course",
    button: "Take Leadership course (",
    moneyPerSecond: 320,
  },
  str: {
    at: "gym",
    name: "Strength",
    youAreCurrently: "training your strength at a gym",
    button: "Train Strength (",
    moneyPerSecond: 120,
  },
  def: {
    at: "gym",
    name: "Defense",
    youAreCurrently: "training your defense at a gym",
    button: "Train Defense (",
    moneyPerSecond: 120,
  },
  dex: {
    at: "gym",
    name: "Dexterity",
    youAreCurrently: "training your dexterity at a gym",
    button: "Train Dexterity (",
    moneyPerSecond: 120,
  },
  agi: {
    at: "gym",
    name: "Agility",
    youAreCurrently: "training your agility at a gym",
    button: "Train Agility (",
    moneyPerSecond: 120,
  },
};

/** Every class type, by the game's name. */
export const CLASS_TYPE_NAMES = Object.keys(CLASS_TYPES);

/**
 * How long the money must last before a paid class is started (#158, the conservative choice, for the owner to
 * confirm): 10 minutes of its cost. A class already under way is left alone.
 */
export const CLASS_MONEY_GUARD_SECONDS = 600;

/** A class: where, and what. */
export interface ClassChoice {
  location: string;
  classType: string;
}

const locationOf = (location: string) =>
  (Object.hasOwn(CLASS_LOCATIONS, location) ? CLASS_LOCATIONS[location] : undefined) ?? null;
const typeOf = (classType: string) =>
  (Object.hasOwn(CLASS_TYPES, classType) ? CLASS_TYPES[classType] : undefined) ?? null;

/** The class's cost a second at its location, the backdoor's discount left out: 0 for an unknown one. */
export function classCostPerSecond({ location, classType }: ClassChoice): number {
  return (typeOf(classType)?.moneyPerSecond ?? 0) * (locationOf(location)?.costMult ?? 0);
}

/** The class in plain words: "Networks at Rothman University", "Dexterity training at Iron Gym". */
export function classLabel({ location, classType }: ClassChoice): string {
  const type = typeOf(classType);
  return `${type?.name ?? classType}${type?.at === "gym" ? " training" : ""} at ${location}`;
}

/** "$72,000", "-$3,721". */
const dollars = (amount: number) => `${amount < 0 ? "-" : ""}$${Math.abs(amount).toLocaleString("en-US")}`;

/**
 * Why the class isn't started for a player with `money` in `city`, or null: its location is in another city (the
 * owner queues a travel), or it costs more than the player's money covers for `CLASS_MONEY_GUARD_SECONDS`. Each backend
 * asks only before starting one.
 */
export function classStartProblem(
  choice: ClassChoice,
  { money, city }: { money: number; city: string },
): string | null {
  const location = locationOf(choice.location);
  if (location !== null && location.city !== city) {
    return `${choice.location} is in ${location.city}, and the player is in ${city} (travel there first)`;
  }
  const perSecond = classCostPerSecond(choice);
  const guard = perSecond * CLASS_MONEY_GUARD_SECONDS;
  // A free class is never held, whatever the money: a negative balance included.
  if (perSecond === 0 || money >= guard) return null;
  return (
    `${classLabel(choice)} costs ${dollars(perSecond)} a second: the Agent starts it with ` +
    `${CLASS_MONEY_GUARD_SECONDS / 60} minutes of that ` +
    `(${dollars(guard)}) or more, and the player has ${dollars(Math.floor(money))}`
  );
}
