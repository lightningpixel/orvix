import { displayLength } from "../core/ids.js";
import { qualifiedName } from "../core/symbols.js";
import type { IndexedSymbol, PersistedGraph, SymbolTable } from "../types.js";

/**
 * Prints exactly one symbol's source, with a header locating it.
 *
 * This is the whole point of the index: the agent gets the twenty lines it
 * asked for instead of the eight hundred in the file.
 */
export function renderSource(symbol: IndexedSymbol, fileSource: string): string {
  const header = `${symbol.file}:${symbol.startLine}-${symbol.endLine}  ${qualifiedName(symbol)}  [${symbol.id}]`;
  const body = fileSource.slice(symbol.startByte, symbol.endByte);

  return `${header}\n${body}`;
}

/**
 * One line per symbol, for results that span files — search hits, callers,
 * callees. Unlike the map, each line carries its own file path.
 */
export function renderList(
  symbols: IndexedSymbol[],
  table: SymbolTable,
  graph: PersistedGraph,
): string {
  if (symbols.length === 0) return "none";

  const idWidth = displayLength(Object.keys(table.symbols));

  return symbols
    .map((symbol) => {
      const callers = graph.callers[symbol.id]?.length ?? 0;
      const inbound = callers > 0 ? ` ←${callers}` : "";
      const marker = symbol.exported ? "*" : " ";

      return `${symbol.id.slice(0, idWidth)} ${marker}${symbol.file}:${symbol.startLine} ${symbol.signature}${inbound}`;
    })
    .join("\n");
}
