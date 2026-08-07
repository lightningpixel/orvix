import { allSymbols } from "../core/indexer.js";
import { buildCallGraph } from "../core/resolve.js";
import { openProject, type CommandResult } from "./session.js";

export interface IndexCommandOptions {
  json?: boolean;
}

/** `orvix index` — build or refresh the cache and report what changed. */
export async function runIndex(
  path: string,
  options: IndexCommandOptions = {},
): Promise<CommandResult> {
  const session = await openProject(path);
  const stats = session.stats!;
  const graph = buildCallGraph(session.index);

  const summary = {
    files: Object.keys(session.index.files).length,
    symbols: allSymbols(session.index).length,
    edges: graph.edges.length,
    ambiguous: graph.ambiguous.length,
    ...stats,
    skippedFiles: session.skippedFiles ?? [],
  };

  if (options.json) {
    return { output: JSON.stringify(summary, null, 2), ok: true };
  }

  const lines = [
    `${summary.files} files, ${summary.symbols} symbols, ${summary.edges} call edges`,
    `added ${stats.added}, updated ${stats.updated}, removed ${stats.removed}, unchanged ${stats.unchanged}`,
  ];

  if (stats.skipped > 0) {
    lines.push(
      `skipped ${stats.skipped}: ${summary.skippedFiles.slice(0, 5).join(", ")}`,
    );
  }
  if (graph.ambiguous.length > 0) {
    lines.push(`${graph.ambiguous.length} call sites too ambiguous to link`);
  }

  return { output: lines.join("\n"), ok: true };
}
