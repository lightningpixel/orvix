import { createHash } from "node:crypto";
import type { RawSymbol } from "../types.js";

/** Stored id width. Wide enough that a whole-project collision is implausible. */
const ID_LENGTH = 12;

/** Ids are shown at least this wide, git-style, and resolved by prefix. */
const MIN_DISPLAY_LENGTH = 4;

export type IdResolution =
  | { status: "found"; id: string }
  | { status: "ambiguous"; matches: string[] }
  | { status: "unknown" };

/**
 * The string a symbol's id is derived from.
 *
 * Deliberately excludes line numbers, byte offsets and the signature: editing
 * a function's body must not change its id, so an id an agent was given on an
 * earlier turn still points at the same symbol after the file is modified.
 */
export function symbolIdentity(file: string, symbol: RawSymbol): string {
  const qualified = symbol.container
    ? `${symbol.container}.${symbol.name}`
    : symbol.name;

  return `${file}::${qualified}::${symbol.kind}`;
}

export function hashIdentity(identity: string): string {
  const digest = createHash("sha1").update(identity, "utf8").digest();

  // Base36 keeps ids short and alphanumeric, so they survive being typed,
  // pasted and word-wrapped without escaping.
  return BigInt(`0x${digest.toString("hex")}`)
    .toString(36)
    .padStart(ID_LENGTH, "0")
    .slice(0, ID_LENGTH);
}

/** The shortest prefix width that keeps every id in the project distinct. */
export function displayLength(ids: string[]): number {
  const longest = Math.max(0, ...ids.map((id) => id.length));

  // Compared against distinct ids, not the raw count: an id that genuinely
  // appears twice can never be separated by widening, and treating that as
  // failure would push every id in the project to full width.
  const distinct = new Set(ids).size;

  for (let width = MIN_DISPLAY_LENGTH; width < longest; width += 1) {
    const prefixes = new Set(ids.map((id) => id.slice(0, width)));
    if (prefixes.size === distinct) return width;
  }

  return Math.max(MIN_DISPLAY_LENGTH, longest);
}

/**
 * Looks an id up by any prefix, so a short id quoted earlier keeps working
 * even after the project grows and ids are displayed wider.
 */
export function resolveId(ids: string[], prefix: string): IdResolution {
  const needle = prefix.toLowerCase();
  const matches = ids.filter((id) => id.startsWith(needle));

  if (matches.length === 1) return { status: "found", id: matches[0]! };
  if (matches.length === 0) return { status: "unknown" };
  return { status: "ambiguous", matches };
}
