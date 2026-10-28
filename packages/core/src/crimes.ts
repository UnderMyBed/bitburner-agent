/**
 * The game's crimes (#156): each `CrimeType` (`Crime/Enums.ts`), by the name the game and Singularity's `commitCrime`
 * use, and how the Work page words it ("You are attempting to shoplift", `workName` in `Crime/Crimes.ts`). Shared by
 * the in-game code and the brain; plain literals, as in factions.ts.
 */

/** Each crime, in the game's order, with the Work page's wording of it. */
export const CRIMES: Record<string, { workName: string }> = {
  Shoplift: { workName: "to shoplift" },
  "Rob Store": { workName: "to rob a store" },
  Mug: { workName: "to mug" },
  Larceny: { workName: "larceny" },
  "Deal Drugs": { workName: "to deal drugs" },
  "Bond Forgery": { workName: "to forge bonds" },
  "Traffick Arms": { workName: "to traffic arms" },
  Homicide: { workName: "homicide" },
  "Grand Theft Auto": { workName: "grand theft auto" },
  Kidnap: { workName: "to kidnap" },
  Assassination: { workName: "to assassinate" },
  Heist: { workName: "a heist" },
};

/** Every crime, by the game's name. */
export const CRIME_NAMES = Object.keys(CRIMES);
