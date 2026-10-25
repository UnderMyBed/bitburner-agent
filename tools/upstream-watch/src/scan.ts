// Just enough lexing of TypeScript source to take declarations apart: comments, strings and brackets. The files read
// are the game's own, formatted by Prettier; this isn't a general parser.

const OPEN = "([{";
const CLOSE = ")]}";
const QUOTES = `"'\``;

/** The index just past the string literal starting at `start` (a quote character). */
export function stringEnd(text: string, start: number): number {
  const quote = text[start];
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === quote) return i + 1;
  }
  return text.length;
}

/** The source without comments. Line breaks inside block comments are kept, so the layout survives. */
export function stripComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const char = source[i] as string;
    if (QUOTES.includes(char)) {
      const end = stringEnd(source, i);
      out += source.slice(i, end);
      i = end;
    } else if (source.startsWith("//", i)) {
      const end = source.indexOf("\n", i);
      i = end === -1 ? source.length : end;
    } else if (source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += source.slice(i, stop).replace(/[^\n]/g, "");
      i = stop;
    } else {
      out += char;
      i++;
    }
  }
  return out;
}

/** The index of the bracket closing the one at `open`, skipping strings. Expects comments already stripped. */
export function closingIndex(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const char = text[i] as string;
    if (QUOTES.includes(char)) i = stringEnd(text, i) - 1;
    else if (OPEN.includes(char)) depth++;
    else if (CLOSE.includes(char) && --depth === 0) return i;
  }
  throw new SyntaxError(`unbalanced ${text[open]} at ${open}`);
}

/** `text` split at `separator` where it's outside brackets and strings; parts trimmed, empty ones dropped. */
export function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;
    if (QUOTES.includes(char)) i = stringEnd(text, i) - 1;
    else if (OPEN.includes(char)) depth++;
    else if (CLOSE.includes(char)) depth--;
    else if (char === separator && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}

/** Whitespace runs collapsed to one space, and none just inside brackets: formatting-only changes compare equal. */
export function normalize(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/([([{]) /g, "$1")
    .replace(/ ([)\]}])/g, "$1")
    .replace(/[,;] ?([)\]}])/g, "$1")
    .trim();
}
