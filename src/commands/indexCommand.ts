import { resolve } from "node:path";
import { allSymbols, buildIndex } from "../core/indexer.js";
import type { CommandResult } from "../query/session.js";

export interface IndexCommandOptions {
  json?: boolean;
}

/** `orvix index` — build or refresh the cache and report what changed. */
export async function runIndex(
  path: string,
  options: IndexCommandOptions = {},
): Promise<CommandResult> {
  const { index, stats, skippedFiles, graph } = await buildIndex(resolve(path));

  const summary = {
    files: Object.keys(index.files).length,
    symbols: allSymbols(index).length,
    edges: graph.edges.length,
    ambiguous: graph.ambiguous.length,
    ...stats,
    skippedFiles,
  };

  if (options.json) {
    return { output: JSON.stringify(summary, null, 2), ok: true };
  }

  const lines = [
    `${summary.files} files, ${summary.symbols} symbols, ${summary.edges} call edges`,
    `added ${stats.added}, updated ${stats.updated}, removed ${stats.removed}, unchanged ${stats.unchanged}`,
  ];

  if (stats.skipped > 0) {
    lines.push(`skipped ${stats.skipped}: ${skippedFiles.slice(0, 5).join(", ")}`);
  }
  if (graph.ambiguous.length > 0) {
    lines.push(`${graph.ambiguous.length} call sites too ambiguous to link`);
  }

  return { output: lines.join("\n"), ok: true };
}
