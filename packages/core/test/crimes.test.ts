// The game's crimes (#156), checked against the pinned game's source: the names, in order, and the Work page's
// wording of each.
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { CRIME_NAMES, CRIMES } from "../src/crimes.ts";

const gameSource = (file: string) =>
  readFileSync(new URL(`../../../vendor/bitburner-src/src/${file}`, import.meta.url), "utf8");

test("CRIMES are the game's, in order, each with its Work page wording (`workName`)", () => {
  const enumBody = gameSource("Crime/Enums.ts");
  const crimeTypes = Object.fromEntries(
    [...enumBody.matchAll(/^\s+(\w+) = "([^"]+)",/gm)].map((match) => [match[1], match[2]]),
  );
  const crimes = gameSource("Crime/Crimes.ts");
  const fromGame = Object.fromEntries(
    [...crimes.matchAll(/\[CrimeType\.(\w+)\]: new Crime\(\s*"([^"]+)"/g)].map((match) => [
      crimeTypes[match[1] as string],
      { workName: match[2] },
    ]),
  );
  expect(CRIME_NAMES).toEqual(Object.values(crimeTypes));
  expect(CRIMES).toEqual(fromGame);
});
