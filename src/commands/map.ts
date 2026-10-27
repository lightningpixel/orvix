import { focusRanks, focusSeeds } from "../core/focus.js";
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
  /** Ids, names or files to centre the map on. */
  focus?: string[];
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

  let focus: Map<string, number> | undefined;
  if (options.focus && options.focus.length > 0) {
    const { seeds, unmatched } = focusSeeds(session.symbols, options.focus);
    if (seeds.length === 0) {
      return {
        output: `no symbol or file matches ${unmatched.map((t) => `"${t}"`).join(", ")}. Try \`orvix find ${unmatched[0]}\`.`,
        ok: false,
      };
    }
    focus = focusRanks(session.symbols, session.graph, seeds);
  }

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
      ...(focus ? { focus: focus.get(symbol.id) ?? 0 } : {}),
    }));
    if (focus) symbols.sort((a, b) => (b.focus ?? 0) - (a.focus ?? 0));

    return { output: JSON.stringify(symbols, null, 2), ok: true };
  }

  return {
    output: renderMap(session.symbols, session.graph, { budget, focus }),
    ok: true,
  };
}
