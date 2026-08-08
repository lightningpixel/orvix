import { renderMap } from "../render/map.js";
import {
  allOf,
  callersOf,
  openQuery,
  rankOf,
  type CommandResult,
} from "../query/session.js";

export interface MapCommandOptions {
  budget?: string | number;
  json?: boolean;
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

  const session = await openQuery(path);

  if (options.json) {
    const symbols = allOf(session).map((symbol) => ({
      id: symbol.id,
      file: symbol.file,
      name: symbol.name,
      container: symbol.container,
      kind: symbol.kind,
      signature: symbol.signature,
      line: symbol.startLine,
      endLine: symbol.endLine,
      exported: symbol.exported,
      callers: callersOf(session, symbol.id).length,
      rank: rankOf(session, symbol.id),
    }));

    return { output: JSON.stringify(symbols, null, 2), ok: true };
  }

  return {
    output: renderMap(session.symbols, session.graph, { budget }),
    ok: true,
  };
}
