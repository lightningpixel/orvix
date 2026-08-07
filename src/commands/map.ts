import { allSymbols } from "../core/indexer.js";
import { renderMap } from "../render/map.js";
import { openProject, type CommandResult } from "./session.js";

export interface MapCommandOptions {
  budget?: string | number;
  json?: boolean;
  refresh?: boolean;
}

const DEFAULT_BUDGET = 2000;

/** `orvix map` — the symbol tree, ranked and fitted to a token budget. */
export async function runMap(
  path: string,
  options: MapCommandOptions = {},
): Promise<CommandResult> {
  const budget = Number(options.budget ?? DEFAULT_BUDGET);
  if (!Number.isFinite(budget) || budget <= 0) {
    return { output: `--budget must be a positive number`, ok: false };
  }

  const session = await openProject(path, { refresh: options.refresh });

  if (options.json) {
    const symbols = allSymbols(session.index).map((symbol) => ({
      id: symbol.id,
      file: symbol.file,
      name: symbol.name,
      container: symbol.container,
      kind: symbol.kind,
      signature: symbol.signature,
      line: symbol.startLine,
      endLine: symbol.endLine,
      exported: symbol.exported,
      callers: session.graph.callers.get(symbol.id)?.size ?? 0,
      rank: session.ranks.get(symbol.id) ?? 0,
    }));

    return { output: JSON.stringify(symbols, null, 2), ok: true };
  }

  return {
    output: renderMap(session.index, session.graph, session.ranks, { budget }),
    ok: true,
  };
}
