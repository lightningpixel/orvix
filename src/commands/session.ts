import { resolve } from "node:path";
import { buildIndex } from "../core/indexer.js";
import { rankSymbols } from "../core/rank.js";
import { buildCallGraph, type CallGraph } from "../core/resolve.js";
import { loadIndex } from "../core/store.js";
import type { IndexStats, OrvixIndex } from "../types.js";

/** What every read command needs: a current index and its derived graph. */
export interface Session {
  root: string;
  index: OrvixIndex;
  graph: CallGraph;
  ranks: Map<string, number>;
  stats?: IndexStats;
  skippedFiles?: string[];
}

export interface OpenOptions {
  /** Restat files and reparse the changed ones before answering. */
  refresh?: boolean;
}

/** The shape every command hands back to the CLI layer. */
export interface CommandResult {
  output: string;
  ok: boolean;
}

/**
 * Opens a project for querying.
 *
 * Refreshing is the default and costs one stat() per file: an answer from a
 * stale index is worse than a few milliseconds of checking. The call graph and
 * ranks are derived here rather than stored, so the cache on disk stays small
 * and can never disagree with the symbols it was built from.
 */
export async function openProject(
  path: string,
  options: OpenOptions = {},
): Promise<Session> {
  const root = resolve(path);

  if (options.refresh === false) {
    const index = await loadIndex(root);
    const graph = buildCallGraph(index);
    return { root, index, graph, ranks: rankSymbols(index, graph) };
  }

  const { index, stats, skippedFiles } = await buildIndex(root);
  const graph = buildCallGraph(index);

  return { root, index, graph, ranks: rankSymbols(index, graph), stats, skippedFiles };
}
