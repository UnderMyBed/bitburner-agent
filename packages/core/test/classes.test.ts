// The game's classes (#158), checked against the pinned game's source: the universities and gyms (their city, kind and
// cost multiplier), and the class types (the page's wording, the button that starts each, and its base cost); then
// the money guard's sums and the problems that hold a class back.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  CLASS_LOCATION_NAMES,
  CLASS_LOCATIONS,
  CLASS_MONEY_GUARD_SECONDS,
  CLASS_TYPE_NAMES,
  CLASS_TYPES,
  classCostPerSecond,
  classLabel,
  classStartProblem,
} from "../src/classes.ts";

const gameSource = (file: string) =>
  readFileSync(new URL(`../../../vendor/bitburner-src/src/${file}`, import.meta.url), "utf8");

/** An enum's members, `{ key: value }`, from the game's source. */
function enumMembers(file: string, name: string): Record<string, string> {
  const body = gameSource(file).split(`export enum ${name} {`)[1]?.split("}")[0] ?? "";
  return Object.fromEntries([...body.matchAll(/^\s+(\w+) = "([^"]+)",/gm)].map((match) => [match[1], match[2]]));
}

test("CLASS_LOCATIONS are the game's universities and gyms, each with its city, kind and cost multiplier", () => {
  const locationNames = enumMembers("Locations/Enums.ts", "LocationName");
  const cityNames = enumMembers("Locations/Enums.ts", "CityName");
  const blocks = gameSource("Locations/data/LocationsMetadata.ts").split(/\n {2}\{\n/);
  const fromGame = Object.fromEntries(
    blocks.flatMap((block) => {
      const type = block.match(/types: \[LocationType\.(Gym|University)\]/)?.[1];
      if (type === undefined) return [];
      const name = locationNames[block.match(/name: LocationName\.(\w+)/)?.[1] as string];
      const city = cityNames[block.match(/city: CityName\.(\w+)/)?.[1] as string];
      const costMult = Number(block.match(/costMult: ([\d.]+)/)?.[1]);
      return [[name, { city, kind: type === "Gym" ? "gym" : "university", costMult }]];
    }),
  );
  expect(Object.keys(fromGame)).toHaveLength(8);
  expect(CLASS_LOCATIONS).toEqual(fromGame);
  expect(CLASS_LOCATION_NAMES).toEqual(Object.keys(CLASS_LOCATIONS));
});

test("CLASS_TYPES are the game's, in order, each with the page's wording, its button and its base cost", () => {
  const university = enumMembers("Work/Enums.ts", "UniversityClassType");
  const gym = enumMembers("Work/Enums.ts", "GymType");
  const classes = gameSource("Work/ClassWork.tsx");
  const wording = Object.fromEntries(
    [
      ...classes.matchAll(
        /\[(UniversityClassType|GymType)\.(\w+)\]: \{\s*type: [\w.]+,\s*youAreCurrently: [`"]([^`"]+)[`"],\s*earnings: newWorkStats\(\{ (?:money: -(\d+), )?/g,
      ),
    ].map(([, enumName, key, youAreCurrently, money]) => [
      (enumName === "GymType" ? gym : university)[key as string],
      { youAreCurrently, moneyPerSecond: Number(money ?? 0) },
    ]),
  );
  const buttons = Object.fromEntries([
    ...[
      ...gameSource("Locations/ui/UniversityLocation.tsx").matchAll(
        /take\(UniversityClassType\.(\w+)\)\}>\s*([^(<]+\()/g,
      ),
    ].map(([, key, text]) => [university[key as string], { at: "university", button: text }]),
    ...[...gameSource("Locations/ui/GymLocation.tsx").matchAll(/train\(GymType\.(\w+)\)\}>\s*([^(<]+\()/g)].map(
      ([, key, text]) => [gym[key as string], { at: "gym", button: text }],
    ),
  ]);
  expect(CLASS_TYPE_NAMES).toEqual([...Object.values(university), ...Object.values(gym)]);
  for (const classType of CLASS_TYPE_NAMES) {
    expect(CLASS_TYPES[classType]).toMatchObject({ ...wording[classType], ...buttons[classType] });
  }
});

describe("the money guard and the city (#158)", () => {
  test("a class's cost a second is its base cost times the location's multiplier", () => {
    expect(classCostPerSecond({ location: "Rothman University", classType: "Computer Science" })).toBe(0);
    expect(classCostPerSecond({ location: "Rothman University", classType: "Data Structures" })).toBe(120);
    expect(classCostPerSecond({ location: "ZB Institute of Technology", classType: "Algorithms" })).toBe(1_600);
    expect(classCostPerSecond({ location: "Powerhouse Gym", classType: "str" })).toBe(2_400);
    expect(CLASS_MONEY_GUARD_SECONDS).toBe(600);
  });

  test("labels read plainly: the course, or the stat trained", () => {
    expect(classLabel({ location: "Rothman University", classType: "Networks" })).toBe(
      "Networks at Rothman University",
    );
    expect(classLabel({ location: "Iron Gym", classType: "dex" })).toBe("Dexterity training at Iron Gym");
  });

  test("in another city: held, saying to travel", () => {
    expect(
      classStartProblem({ location: "Crush Fitness Gym", classType: "str" }, { money: 1e12, city: "Sector-12" }),
    ).toBe("Crush Fitness Gym is in Aevum, and the player is in Sector-12 (travel there first)");
  });

  test("a paid class is held under 10 minutes of its cost, and started from exactly that; a free one never held", () => {
    const dataStructures = { location: "Rothman University", classType: "Data Structures" };
    expect(classStartProblem(dataStructures, { money: 71_999.5, city: "Sector-12" })).toBe(
      "Data Structures at Rothman University costs $120 a second: the Agent starts it with 10 minutes of that " +
        "($72,000) or more, and the player has $71,999",
    );
    expect(classStartProblem(dataStructures, { money: 72_000, city: "Sector-12" })).toBeNull();
    // Money run negative (the game allows it) reads with its sign first.
    expect(classStartProblem(dataStructures, { money: -3_720.5, city: "Sector-12" })).toMatch(
      /, and the player has -\$3,721$/,
    );
    const computerScience = { location: "Rothman University", classType: "Computer Science" };
    expect(classStartProblem(computerScience, { money: -5, city: "Sector-12" })).toBeNull();
  });
});
