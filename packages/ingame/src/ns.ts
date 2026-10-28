// The NS API's types, from the pinned game's own definitions: tsconfig.json maps `@nsdefs` to
// vendor/bitburner-src/src/ScriptEditor/NetscriptDefinitions.d.ts. In-game scripts import NS from here.
import type { NS } from "@nsdefs";

export type { NS };
/** The game's faction names, as its definitions type them. Types only: they cost no RAM. */
export type FactionName = Parameters<NS["singularity"]["joinFaction"]>[0];
/** The game's city names, likewise. */
export type CityName = Parameters<NS["singularity"]["travelToCity"]>[0];
