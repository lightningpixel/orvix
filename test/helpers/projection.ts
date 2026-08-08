import { projectIndex } from "../../src/core/project.js";
import { rankSymbols } from "../../src/core/rank.js";
import { buildCallGraph } from "../../src/core/resolve.js";
import type { OrvixIndex, PersistedGraph, SymbolTable } from "../../src/types.js";

/**
 * Projects a hand-built index the way indexing does, so tests that already
 * have an OrvixIndex can exercise the query-side shapes without going through
 * disk.
 */
export function projectionOf(index: OrvixIndex): {
  table: SymbolTable;
  graph: PersistedGraph;
} {
  const resolved = buildCallGraph(index);
  const projected = projectIndex(index, resolved, rankSymbols(index, resolved));

  return { table: projected.symbols, graph: projected.graph };
}

export function tableOf(index: OrvixIndex): SymbolTable {
  return projectionOf(index).table;
}

export function graphOf(index: OrvixIndex): PersistedGraph {
  return projectionOf(index).graph;
}
