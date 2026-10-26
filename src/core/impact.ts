import type { IndexedSymbol, PersistedGraph, SymbolTable } from "../types.js";

export interface ImpactLayer {
  /** 1 for direct callers, 2 for their callers, and so on. */
  depth: number;
  symbols: IndexedSymbol[];
}

export interface Impact {
  target: IndexedSymbol;
  layers: ImpactLayer[];
  /** Files calling the target or one of its dependants from file scope. */
  fileScope: string[];
  /** Test files among everything above, which is what to run after a change. */
  tests: string[];
}

/**
 * Everything that reaches a symbol, nearest first.
 *
 * A breadth-first walk up the caller edges, so each dependant is reported at
 * the shortest distance it has. It inherits the graph's refusal to guess: a
 * call too ambiguous to draw is not followed here either, which makes this a
 * floor on the real blast radius, never an inflated one.
 */
export function impactOf(
  table: SymbolTable,
  graph: PersistedGraph,
  target: IndexedSymbol,
  maxDepth: number = Infinity,
): Impact {
  const seen = new Set([target.id]);
  const layers: ImpactLayer[] = [];
  let frontier = [target.id];

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const caller of graph.callers[id] ?? []) {
        if (seen.has(caller)) continue;
        seen.add(caller);
        next.push(caller);
      }
    }

    const symbols = next
      .map((id) => table.symbols[id])
      .filter((symbol): symbol is IndexedSymbol => symbol !== undefined)
      .sort((a, b) => a.file.localeCompare(b.file) || a.startLine - b.startLine);
    if (symbols.length > 0) layers.push({ depth, symbols });
    frontier = next;
  }

  const fileScope = new Set<string>();
  for (const id of seen) {
    for (const file of graph.fileCallers[id] ?? []) fileScope.add(file);
  }

  const reached = new Set(fileScope);
  for (const layer of layers) for (const symbol of layer.symbols) reached.add(symbol.file);
  if (isTestFile(target.file)) reached.add(target.file);

  return {
    target,
    layers,
    fileScope: [...fileScope].sort(),
    tests: [...reached].filter(isTestFile).sort(),
  };
}

/**
 * Whether a path follows one of the common test-file conventions.
 *
 * Matched on whole path segments and name affixes, never on a bare substring,
 * so `latest/` and `contest.ts` are not mistaken for tests.
 */
export function isTestFile(path: string): boolean {
  const segments = path.split("/");
  const name = segments[segments.length - 1] ?? "";
  const directories = segments.slice(0, -1);

  if (directories.some((dir) => /^(tests?|__tests__|spec|specs)$/i.test(dir))) return true;
  if (directories.some((dir) => /\.Tests?$/.test(dir))) return true;

  return (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(name) ||
    /^test_.+\.pyi?$/.test(name) ||
    /_test\.(py|go)$/.test(name) ||
    /Tests?\.(java|cs)$/.test(name)
  );
}
