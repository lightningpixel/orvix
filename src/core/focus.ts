import type { PersistedGraph, SymbolTable } from "../types.js";
import { lookupSymbol } from "./lookup.js";
import { pagerank } from "./rank.js";

/**
 * Turns what a caller named — ids, names, qualified names, files — into the
 * symbols to focus on.
 *
 * An ambiguous name seeds every symbol it matches. That is not the guess the
 * call graph refuses to make: no edge is drawn from it, it only decides which
 * corner of the project is shown first.
 */
export function focusSeeds(
  table: SymbolTable,
  targets: readonly string[],
): { seeds: string[]; unmatched: string[] } {
  const seeds = new Set<string>();
  const unmatched: string[] = [];

  for (const target of targets) {
    const inFile = table.byFile[target.replace(/\\/g, "/")];
    if (inFile && inFile.length > 0) {
      for (const id of inFile) seeds.add(id);
      continue;
    }

    const found = lookupSymbol(table, target);
    if (found.status === "found") seeds.add(found.symbol.id);
    else if (found.status === "ambiguous") {
      for (const symbol of found.matches) seeds.add(symbol.id);
    } else unmatched.push(target);
  }

  return { seeds: [...seeds].sort(), unmatched };
}

/**
 * Scores every symbol by closeness to the seeds.
 *
 * PageRank restarted only at the seeds, over edges taken in both directions:
 * the task's neighbourhood is what it calls and what calls it, and following
 * calls alone would leave a leaf like a parser with no neighbourhood at all.
 * A symbol with no path to any seed scores zero.
 *
 * Computed per query, unlike the global ranking, because the seeds are only
 * known at query time. It reads the persisted graph and nothing else.
 */
export function focusRanks(
  table: SymbolTable,
  graph: PersistedGraph,
  seeds: readonly string[],
): Map<string, number> {
  const ids = Object.keys(table.symbols);
  if (ids.length === 0 || seeds.length === 0) return new Map();

  const neighbours = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (a === b) return;
    let set = neighbours.get(a);
    if (!set) neighbours.set(a, (set = new Set()));
    set.add(b);
  };
  for (const [callee, callers] of Object.entries(graph.callers)) {
    for (const caller of callers) {
      link(callee, caller);
      link(caller, callee);
    }
  }

  const restart = new Map(seeds.map((id) => [id, 1 / seeds.length]));

  return pagerank({
    ids,
    restart,
    inbound: (id) => neighbours.get(id) ?? [],
    outDegree: (id) => neighbours.get(id)?.size ?? 0,
  });
}
