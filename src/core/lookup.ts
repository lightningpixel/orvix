import type { IndexedSymbol, OrvixIndex } from "../types.js";
import { resolveId } from "./ids.js";
import { allSymbols } from "./indexer.js";

export type Lookup =
  | { status: "found"; symbol: IndexedSymbol }
  | { status: "ambiguous"; matches: IndexedSymbol[] }
  | { status: "unknown" };

/**
 * Resolves whatever an agent passed on the command line to a single symbol.
 *
 * Ids are tried first and names second, so an agent that has the map can use
 * the cheap handle, while one that does not can still ask for `validate` or
 * `Service.validate` by name.
 */
export function lookupSymbol(index: OrvixIndex, query: string): Lookup {
  const symbols = allSymbols(index);

  const byId = resolveId(
    symbols.map((symbol) => symbol.id),
    query,
  );

  if (byId.status === "found") {
    const symbol = symbols.find((candidate) => candidate.id === byId.id);
    if (symbol) return { status: "found", symbol };
  }

  if (byId.status === "ambiguous") {
    return {
      status: "ambiguous",
      matches: symbols.filter((symbol) => byId.matches.includes(symbol.id)),
    };
  }

  const needle = query.toLowerCase();
  const byName = symbols.filter(
    (symbol) =>
      symbol.name.toLowerCase() === needle ||
      qualifiedName(symbol).toLowerCase() === needle,
  );

  if (byName.length === 1) return { status: "found", symbol: byName[0]! };
  if (byName.length > 1) return { status: "ambiguous", matches: byName };
  return { status: "unknown" };
}

export function qualifiedName(symbol: IndexedSymbol): string {
  return symbol.container ? `${symbol.container}.${symbol.name}` : symbol.name;
}
