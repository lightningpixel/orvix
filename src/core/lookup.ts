import type { IndexedSymbol, SymbolTable } from "../types.js";
import { resolveId } from "./ids.js";
import { qualifiedName } from "./symbols.js";

export { qualifiedName };

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
 *
 * Names go through the prebuilt index rather than a scan: this runs on every
 * query, including from a hook, and walking every symbol to compare strings
 * made lookup cost track project size.
 */
export function lookupSymbol(table: SymbolTable, query: string): Lookup {
  const byId = resolveId(Object.keys(table.symbols), query);

  if (byId.status === "found") {
    const symbol = table.symbols[byId.id];
    if (symbol) return { status: "found", symbol };
  }

  if (byId.status === "ambiguous") {
    return { status: "ambiguous", matches: hydrate(table, byId.matches) };
  }

  const byName = table.byName[query.toLowerCase()];
  if (!byName || byName.length === 0) return { status: "unknown" };

  const matches = hydrate(table, byName);
  if (matches.length === 1) return { status: "found", symbol: matches[0]! };
  return { status: "ambiguous", matches };
}

function hydrate(table: SymbolTable, ids: string[]): IndexedSymbol[] {
  return ids
    .map((id) => table.symbols[id])
    .filter((symbol): symbol is IndexedSymbol => symbol !== undefined);
}
