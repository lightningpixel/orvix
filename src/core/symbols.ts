import type { FileEntry, IndexedSymbol, OrvixIndex, RawSymbol } from "../types.js";

/**
 * Shape-only helpers over an index.
 *
 * Kept free of dependencies on purpose. These are needed by the query path,
 * and their previous home — the indexer — pulls in tree-sitter, so importing
 * them from there put a grammar runtime behind every lookup.
 */

/** Every symbol in the index, in file order. */
export function allSymbols(index: OrvixIndex): IndexedSymbol[] {
  return Object.values(index.files).flatMap((entry: FileEntry) => entry.symbols);
}

/** `Container.name` for a method or field, otherwise just the name. */
export function qualifiedName(
  symbol: Pick<RawSymbol, "name" | "container">,
): string {
  return symbol.container ? `${symbol.container}.${symbol.name}` : symbol.name;
}
