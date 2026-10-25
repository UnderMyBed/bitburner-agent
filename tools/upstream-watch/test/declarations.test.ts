import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { diffDeclarations, extractDeclarations } from "../src/declarations.ts";

const PINNED = path.resolve(
  import.meta.dirname,
  "../../../vendor/bitburner-src/src/ScriptEditor/NetscriptDefinitions.d.ts",
);

const BEFORE = `
/** The game's API. A {@link NS} has "quotes" and // slashes in comments; { braces } too. */
export interface NS {
  /** Hacks. */
  hack(host: string, opts?: BasicHGWOptions): Promise<number>;
  // Overloads add up under one name.
  run(script: string, threads?: number): number;
  run(script: string, opts: RunOptions): number;
  readonly args: ScriptArg[];
  getPlayer(): Player;
  grow<T extends string>(host: T): Promise<number>;
}

interface Player {
  money: number;
  "quoted-key": string;
  [key: string]: unknown;
}

type CityName = "Aevum" | "Sector-12";

export type DarknetResult = { success: boolean; message: string };

/** @deprecated */
type Gone = number;
`;

const AFTER = `
export interface NS {
  hack(host: string, opts?: BasicHGWOptions): Promise<number>;
  run(script: string, threads?: number): number;
  run(script: string, opts: RunOptions): number;
  /** New in dev. */
  isFullPort(port: number): boolean;
  readonly args: ScriptArg[];
  getPlayer(): Player;
  grow<T extends string>(host: T, opts?: BasicHGWOptions): Promise<number>;
}

interface Player {
  money: number;
  "quoted-key": string;
  [key: string]: unknown;
}

type CityName = "Aevum" | "Sector-12" | "Volhaven";

export type DarknetResult = {
  success: boolean;
  message: string;
  code: number;
};

type Added = { a: 1 };
`;

describe("extractDeclarations", () => {
  const declarations = extractDeclarations(BEFORE);

  test("finds every top-level declaration by kind and name, ignoring comments and export", () => {
    expect([...declarations.keys()]).toEqual([
      "interface NS",
      "interface Player",
      "type CityName",
      "type DarknetResult",
      "type Gone",
    ]);
  });

  test("lists an interface's members by name, overloads together, generics and index signatures included", () => {
    const ns = declarations.get("interface NS");
    expect([...(ns?.members?.keys() ?? [])]).toEqual(["hack", "run", "args", "getPlayer", "grow"]);
    expect(ns?.members?.get("run")).toBe(
      "run(script: string, threads?: number): number\nrun(script: string, opts: RunOptions): number",
    );
    expect([...(declarations.get("interface Player")?.members?.keys() ?? [])]).toEqual([
      "money",
      '"quoted-key"',
      "[key: string]",
    ]);
  });

  test("an object type's members are listed too; other types have none", () => {
    expect([...(declarations.get("type DarknetResult")?.members?.keys() ?? [])]).toEqual(["success", "message"]);
    expect(declarations.get("type CityName")?.members).toBeNull();
    expect(declarations.get("type CityName")?.text).toBe('type CityName = "Aevum" | "Sector-12";');
  });

  test("reads the real pinned definitions: NS and its hack()", () => {
    const real = extractDeclarations(readFileSync(PINNED, "utf8"));
    expect(real.size).toBeGreaterThan(150);
    expect(real.get("interface NS")?.members?.get("hack")).toMatch(/^hack\(host\?: string/);
    expect(real.get("interface NS")?.members?.has("singularity")).toBe(true);
  });
});

describe("diffDeclarations", () => {
  test("reports added, removed and changed declarations, and which members changed", () => {
    expect(diffDeclarations(extractDeclarations(BEFORE), extractDeclarations(AFTER))).toEqual({
      added: ["type Added"],
      removed: ["type Gone"],
      changed: [
        { key: "interface NS", added: ["isFullPort"], removed: [], changed: ["grow"] },
        { key: "type CityName", added: [], removed: [], changed: [] },
        { key: "type DarknetResult", added: ["code"], removed: [], changed: [] },
      ],
    });
  });

  test("formatting and comments alone aren't changes", () => {
    // Prettier breaks a type over lines once it grows, adding a trailing separator.
    const reformatted = BEFORE.replaceAll("\n  ", "\n      ")
      .replace("/** Hacks. */", "/** Hacks, faster. */")
      .replace("{ success: boolean; message: string };", "{\n  success: boolean;\n  message: string;\n};");
    expect(diffDeclarations(extractDeclarations(BEFORE), extractDeclarations(reformatted))).toEqual({
      added: [],
      removed: [],
      changed: [],
    });
  });
});
