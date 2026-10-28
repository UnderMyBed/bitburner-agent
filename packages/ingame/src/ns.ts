// The NS API's types, from the pinned game's own definitions: tsconfig.json maps `@nsdefs` to
// vendor/bitburner-src/src/ScriptEditor/NetscriptDefinitions.d.ts. In-game scripts import NS from here.
import type { NS } from "@nsdefs";

export type { NS };
/** The game's faction names, as its definitions type them. Types only: they cost no RAM. */
export type FactionName = Parameters<NS["singularity"]["joinFaction"]>[0];
/** The game's augmentation names, likewise. */
export type AugmentationName = Parameters<NS["singularity"]["purchaseAugmentation"]>[1];
/** The game's company names and job fields, likewise. */
export type CompanyName = Parameters<NS["singularity"]["applyToCompany"]>[0];
export type JobField = Parameters<NS["singularity"]["applyToCompany"]>[1];
/** The game's crime names, likewise. */
export type CrimeType = Parameters<NS["singularity"]["commitCrime"]>[0];
/** The game's universities and their courses, and its gyms and their stats, likewise. */
export type UniversityLocationName = Parameters<NS["singularity"]["universityCourse"]>[0];
export type UniversityClassType = Parameters<NS["singularity"]["universityCourse"]>[1];
export type GymLocationName = Parameters<NS["singularity"]["gymWorkout"]>[0];
export type GymType = Parameters<NS["singularity"]["gymWorkout"]>[1];
/** The game's city names, likewise. */
export type CityName = Parameters<NS["singularity"]["travelToCity"]>[0];
