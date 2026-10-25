// RAM costs from the game's src/Netscript/RamCostGenerator.ts: the `RamCosts` tree flattened to function paths, with
// the cost constants and arithmetic resolved, and what changed between two versions.
import { closingIndex, normalize, splitTopLevel, stripComments } from "./scan.ts";

const ROOT = "RamCosts";

/** The bodies of the file's `const name = { … }` object literals, by name. */
function objectLiterals(text: string): Map<string, string> {
  const objects = new Map<string, string>();
  for (const match of text.matchAll(/(?:export\s+)?const\s+([\w$]+)(?:\s*:[^=]+)?\s*=\s*\{/g)) {
    const open = (match.index as number) + match[0].length - 1;
    objects.set(match[1] as string, text.slice(open + 1, closingIndex(text, open)));
  }
  return objects;
}

const unquote = (key: string) => key.replace(/^(["'])(.*)\1$/, "$2");

/** A number without floating-point noise: 0.15 * 5 is "0.75". */
const formatNumber = (n: number) => String(Number(n.toFixed(6)));

/**
 * A cost expression as a number, or as written if it isn't plain arithmetic once constants are substituted.
 * `SF4Cost(n)` (Singularity: more without Source-File 4) is shown as "n (SF4)".
 */
function resolve(expression: string, constants: Map<string, string>): string {
  const sf4 = /^SF4Cost\((.*)\)$/s.exec(expression);
  if (sf4) {
    const inner = resolve((sf4[1] as string).trim(), constants);
    return /^[\d.]+$/.test(inner) ? `${inner} (SF4)` : expression;
  }
  const substituted = expression.replace(/RamCostConstants\.([\w$]+)/g, (whole, name) => constants.get(name) ?? whole);
  if (!/^[\d.\s+\-*/()]+$/.test(substituted)) return expression;
  const value = Function(`"use strict"; return (${substituted});`)() as unknown;
  return typeof value === "number" && Number.isFinite(value) ? formatNumber(value) : expression;
}

/**
 * Every function's RAM cost, by its path under `ns` ("hack", "singularity.cat", "formulas.hacking.hackChance"), in
 * file order. Sections written as shorthand (`hacknet,`) are the file's own `const hacknet = { … }`.
 */
export function extractRamCosts(source: string): Map<string, string> {
  const objects = objectLiterals(stripComments(source));
  const constants = new Map<string, string>();
  for (const entry of splitTopLevel(objects.get("RamCostConstants") ?? "", ",")) {
    const [name, value] = entry.split(":").map((part) => part.trim());
    if (name && value) constants.set(name, resolve(value, constants));
  }
  const root = objects.get(ROOT);
  if (root === undefined) throw new Error(`no \`const ${ROOT} = { … }\` in the RAM cost source`);

  const costs = new Map<string, string>();
  const flatten = (body: string, prefix: string) => {
    for (const entry of splitTopLevel(body, ",")) {
      const spread = /^\.\.\.([\w$]+)$/.exec(entry);
      const colon = entry.indexOf(":");
      if (spread || colon === -1) {
        // `...section` or the shorthand `section`: a section defined elsewhere in the file.
        const name = spread ? (spread[1] as string) : entry;
        const section = objects.get(name);
        if (section === undefined) costs.set(`${prefix}${name}`, entry);
        else flatten(section, spread ? prefix : `${prefix}${name}.`);
        continue;
      }
      const key = unquote(entry.slice(0, colon).trim());
      const value = normalize(entry.slice(colon + 1));
      if (value.startsWith("{")) flatten(value.slice(1, closingIndex(value, 0)), `${prefix}${key}.`);
      else costs.set(`${prefix}${key}`, resolve(value, constants));
    }
  };
  flatten(root, "");
  return costs;
}

export interface RamCostChange {
  path: string;
  /** null if the function is new. */
  before: string | null;
  /** null if the function is gone. */
  after: string | null;
}

/** Functions added (in the newer file's order), then removed (in the older's), then changed (in the newer's). */
export function diffRamCosts(before: Map<string, string>, after: Map<string, string>): RamCostChange[] {
  const added = [...after].filter(([path]) => !before.has(path));
  const removed = [...before].filter(([path]) => !after.has(path));
  const changed = [...after].filter(([path, cost]) => before.has(path) && before.get(path) !== cost);
  return [
    ...added.map(([path, cost]) => ({ path, before: null, after: cost })),
    ...removed.map(([path, cost]) => ({ path, before: cost, after: null })),
    ...changed.map(([path, cost]) => ({ path, before: before.get(path) as string, after: cost })),
  ];
}
