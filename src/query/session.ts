import { resolve } from "node:path";
import { readDirty } from "../core/state.js";
import { loadGraph, loadSymbols } from "../core/store.js";
import type { IndexedSymbol, PersistedGraph, SymbolTable } from "../types.js";

/** What a read command needs, and nothing that would pull in a parser. */
export interface QuerySession {
  root: string;
  symbols: SymbolTable;
  graph: PersistedGraph;
}

/** The shape every command hands back to whichever entry point invoked it. */
export interface CommandResult {
  output: string;
  ok: boolean;
}

/**
 * Opens a project for querying.
 *
 * In the ordinary case this reads the two projected files and stops. No
 * grammar is loaded, no call graph is built and no PageRank is run — all of
 * that happened at index time, which is what keeps a lookup's cost independent
 * of how large the project is.
 *
 * When the edit hook has marked files dirty, those files — and only those —
 * are reparsed first. The parser is reached through a dynamic import so it
 * stays out of this module's graph entirely: a query on a clean project must
 * never pay to load a grammar it will not use.
 */
export async function openQuery(path: string): Promise<QuerySession> {
  const root = resolve(path);

  const dirty = await readDirty(root);
  if (dirty.length > 0) {
    try {
      const { catchUp } = await import("../core/incremental.js");
      await catchUp(root);
    } catch {
      // A failed catch-up must not cost the answer. The index is merely stale,
      // the dirty log still names the files, and the Stop hook reconciles.
    }
  }

  const [symbols, graph] = await Promise.all([
    loadSymbols(root),
    loadGraph(root),
  ]);

  return { root, symbols, graph };
}

/** Every symbol in the table. */
export function allOf(session: QuerySession): IndexedSymbol[] {
  return Object.values(session.symbols.symbols);
}

export function rankOf(session: QuerySession, id: string): number {
  return session.symbols.ranks[id] ?? 0;
}

export function callersOf(session: QuerySession, id: string): string[] {
  return session.graph.callers[id] ?? [];
}

export function calleesOf(session: QuerySession, id: string): string[] {
  return session.graph.callees[id] ?? [];
}
