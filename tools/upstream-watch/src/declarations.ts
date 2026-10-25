// The API surface of a declaration file (NetscriptDefinitions.d.ts): its top-level declarations and their members,
// and what changed between two versions.
import { closingIndex, normalize, splitTopLevel, stringEnd, stripComments, topLevelIndex } from "./scan.ts";

export interface Declaration {
  /** e.g. "interface NS", "type CityName". */
  key: string;
  /** The whole declaration, whitespace normalised; merged declarations joined by line breaks. */
  text: string;
  /** Interface, class or enum members, or an object type's, by name; null for other declarations. */
  members: Map<string, string> | null;
}

/** Declarations whose body ends at their closing brace, with no `;` after. */
const BLOCK = /^(?:export\s+)?(?:declare\s+)?(?:const\s+)?(?:interface|enum|namespace|module|class|global)\b/;
const NAMED =
  /^(?:export\s+)?(?:declare\s+)?(?:default\s+)?(?:abstract\s+)?(?:const\s+)?(interface|type|enum|function|const|let|var|class|namespace)\s+([\w$]+)/;

/** The top-level statements of comment-free source, each from its first character to its end. */
function statements(text: string): string[] {
  const found: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i] as string)) {
      i++;
      continue;
    }
    // A block declaration ends with its body; anything else at its `;`.
    const body = BLOCK.test(text.slice(i, i + 100)) ? topLevelIndex(text, "{", i) : -1;
    const semicolon = body === -1 ? topLevelIndex(text, ";", i) : -1;
    const end = body !== -1 ? closingIndex(text, body) + 1 : semicolon !== -1 ? semicolon + 1 : text.length;
    found.push(text.slice(i, end));
    i = end;
  }
  return found;
}

/**
 * A member's name: an identifier, a quoted key, an index signature, "get x" / "set x" for accessors, or "(call)" /
 * "(construct)" for signatures.
 */
function memberName(member: string): string {
  const bare = member.replace(/^(?:(?:readonly|static|public|private|protected|abstract|declare)\s+)+/, "");
  const accessor = /^(get|set)\s+([\w$]+)/.exec(bare);
  if (accessor) return `${accessor[1]} ${accessor[2]}`;
  if (bare.startsWith("[")) return bare.slice(0, closingIndex(bare, 0) + 1);
  if (bare.startsWith('"') || bare.startsWith("'")) return bare.slice(0, stringEnd(bare, 0));
  if (bare.startsWith("(") || bare.startsWith("<")) return "(call)";
  if (/^new\s*[(<]/.test(bare)) return "(construct)";
  return /^[\w$]+/.exec(bare)?.[0] ?? bare;
}

/** The members of a `{ … }` body, by name; overloads share a name, joined by line breaks. */
function membersOf(body: string, separator: ";" | ","): Map<string, string> {
  const members = new Map<string, string>();
  for (const member of splitTopLevel(body, separator).map(normalize)) appendTo(members, memberName(member), member);
  return members;
}

/** Adds `text` under `key`, after a line break if there's already text there. */
function appendTo(map: Map<string, string>, key: string, text: string): void {
  const earlier = map.get(key);
  map.set(key, earlier === undefined ? text : `${earlier}\n${text}`);
}

function declarationOf(statement: string): Declaration {
  const text = normalize(statement);
  const named = NAMED.exec(text);
  if (!named) return { key: `statement ${text.slice(0, 60)}`, text, members: null };
  const [, kind, name] = named as unknown as [string, string, string];
  let members: Map<string, string> | null = null;
  if (kind === "type") {
    // An object type: `type X = { … };`, the braces being the whole right-hand side.
    const value = text
      .slice(topLevelIndex(text, "=", named[0].length) + 1)
      .replace(/;$/, "")
      .trim();
    if (value.startsWith("{") && closingIndex(value, 0) === value.length - 1) {
      members = membersOf(value.slice(1, -1), ";");
    }
  } else if (kind === "interface" || kind === "class" || kind === "enum") {
    const open = topLevelIndex(text, "{", named[0].length);
    if (open !== -1) members = membersOf(text.slice(open + 1, closingIndex(text, open)), kind === "enum" ? "," : ";");
  }
  return { key: `${kind} ${name}`, text, members };
}

/** Every top-level declaration, by key, in file order. Declarations sharing a key (merged interfaces, overloads) merge. */
export function extractDeclarations(source: string): Map<string, Declaration> {
  const declarations = new Map<string, Declaration>();
  for (const statement of statements(stripComments(source))) {
    const declaration = declarationOf(statement);
    const earlier = declarations.get(declaration.key);
    if (!earlier) {
      declarations.set(declaration.key, declaration);
      continue;
    }
    earlier.text += `\n${declaration.text}`;
    if (declaration.members) {
      earlier.members ??= new Map();
      for (const [name, member] of declaration.members) appendTo(earlier.members, name, member);
    }
  }
  return declarations;
}

export interface ChangedDeclaration {
  key: string;
  /** Member names; all empty when only the declaration's own text changed (a union, an `extends` clause…). */
  added: string[];
  removed: string[];
  changed: string[];
}

export interface DeclarationDiff {
  /** Keys, in the newer file's order. */
  added: string[];
  /** Keys, in the older file's order. */
  removed: string[];
  changed: ChangedDeclaration[];
}

/** The keys only in `after`, only in `before`, and in both, each in its map's order (both: `after`'s). */
export function keyDiff<T>(before: Map<string, T>, after: Map<string, T>) {
  return {
    added: [...after.keys()].filter((key) => !before.has(key)),
    removed: [...before.keys()].filter((key) => !after.has(key)),
    both: [...after.keys()].filter((key) => before.has(key)),
  };
}

/** What changed from `before` to `after`. Formatting and comments don't count. */
export function diffDeclarations(before: Map<string, Declaration>, after: Map<string, Declaration>): DeclarationDiff {
  const { added, removed, both } = keyDiff(before, after);
  const changed: ChangedDeclaration[] = [];
  for (const key of both) {
    const old = before.get(key) as Declaration;
    const now = after.get(key) as Declaration;
    if (old.text === now.text) continue;
    // Members compare only between two bodies: an object type becoming an intersection has none to compare.
    if (!old.members || !now.members) {
      changed.push({ key, added: [], removed: [], changed: [] });
      continue;
    }
    const members = keyDiff(old.members, now.members);
    changed.push({
      key,
      added: members.added,
      removed: members.removed,
      changed: members.both.filter((name) => old.members?.get(name) !== now.members?.get(name)),
    });
  }
  return { added, removed, changed };
}
