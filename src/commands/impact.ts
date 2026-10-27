import { impactOf } from "../core/impact.js";
import { qualifiedName } from "../core/symbols.js";
import { renderList } from "../render/symbol.js";
import { openQuery, type CommandResult } from "../query/session.js";
import { resolveOrExplain } from "./lookupCommands.js";

export interface ImpactOptions {
  json?: boolean;
  depth?: string | number;
}

/** `orvix impact` — everything that reaches a symbol, and the tests among it. */
export async function runImpact(
  path: string,
  query: string,
  options: ImpactOptions = {},
): Promise<CommandResult> {
  const depth = options.depth === undefined ? Infinity : Number(options.depth);
  if (!(depth >= 1)) return { output: `--depth must be at least 1`, ok: false };

  const session = await openQuery(path);
  const found = resolveOrExplain(session, query);
  if ("failure" in found) return found.failure;

  const impact = impactOf(session.symbols, session.graph, found.symbol, depth);

  if (options.json) return { output: JSON.stringify(impact, null, 2), ok: true };

  const name = qualifiedName(found.symbol);
  if (impact.layers.length === 0 && impact.fileScope.length === 0) {
    return { output: `nothing in the index calls ${name}`, ok: true };
  }

  const dependants = impact.layers.reduce((total, layer) => total + layer.symbols.length, 0);
  const lines = [`${dependants} ${dependants === 1 ? "symbol reaches" : "symbols reach"} ${name}`];

  for (const layer of impact.layers) {
    lines.push(`depth ${layer.depth}`);
    for (const symbol of layer.symbols) {
      const channel = impact.via[symbol.id];
      const line = renderList([symbol], session.symbols, session.graph);
      lines.push(channel ? `${line}  ⇢ via "${channel}"` : line);
    }
  }
  if (impact.fileScope.length > 0) {
    lines.push(`called at file scope from`, ...impact.fileScope.map((file) => `  ${file}`));
  }
  lines.push(
    impact.tests.length > 0
      ? `tests that reach it\n${impact.tests.map((file) => `  ${file}`).join("\n")}`
      : `no test file reaches it through the call graph`,
  );

  return { output: lines.join("\n"), ok: true };
}
