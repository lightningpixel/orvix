import type { IndexedSymbol, OrvixIndex } from "../types.js";
import { displayLength } from "../core/ids.js";
import { allSymbols } from "../core/indexer.js";
import type { CallGraph } from "../core/resolve.js";
import { estimateTokens } from "./tokens.js";

export interface MapRenderOptions {
  budget: number;
  /** Longest signature shown before it is elided. */
  maxSignature?: number;
}

const DEFAULT_MAX_SIGNATURE = 90;

/**
 * Renders the symbol map, trimmed to fit a token budget.
 *
 * The budget is honoured by construction rather than by truncating the final
 * string: candidate renderings are measured and the largest one that fits is
 * returned, so output is never cut mid-line.
 */
export function renderMap(
  index: OrvixIndex,
  graph: CallGraph,
  ranks: Map<string, number>,
  options: MapRenderOptions,
): string {
  const symbols = allSymbols(index);
  if (symbols.length === 0) return "no symbols indexed";

  const idWidth = displayLength(symbols.map((symbol) => symbol.id));
  const maxSignature = options.maxSignature ?? DEFAULT_MAX_SIGNATURE;

  // Most important first; the id breaks ties so output never depends on the
  // order files happened to be walked in.
  const byImportance = [...symbols].sort(
    (a, b) =>
      (ranks.get(b.id) ?? 0) - (ranks.get(a.id) ?? 0) || a.id.localeCompare(b.id),
  );

  const render = (count: number): string =>
    layout(byImportance.slice(0, count), symbols, graph, {
      idWidth,
      maxSignature,
    });

  return largestThatFits(render, symbols.length, options.budget);
}

/** Binary-searches the most symbols whose rendering still fits the budget. */
function largestThatFits(
  render: (count: number) => string,
  total: number,
  budget: number,
): string {
  let best = render(0);
  let low = 1;
  let high = total;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = render(middle);

    if (estimateTokens(candidate) <= budget) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return best;
}

interface LayoutOptions {
  idWidth: number;
  maxSignature: number;
}

function layout(
  selected: IndexedSymbol[],
  all: IndexedSymbol[],
  graph: CallGraph,
  options: LayoutOptions,
): string {
  const shown = new Set(selected.map((symbol) => symbol.id));

  const byFile = new Map<string, IndexedSymbol[]>();
  for (const symbol of all) {
    const bucket = byFile.get(symbol.file);
    if (bucket) bucket.push(symbol);
    else byFile.set(symbol.file, [symbol]);
  }

  const lines: string[] = [];
  let hiddenFiles = 0;
  let hiddenSymbols = 0;

  for (const file of [...byFile.keys()].sort()) {
    const inFile = byFile.get(file)!;
    const visible = inFile
      .filter((symbol) => shown.has(symbol.id))
      .sort((a, b) => a.startLine - b.startLine);

    if (visible.length === 0) {
      hiddenFiles += 1;
      hiddenSymbols += inFile.length;
      continue;
    }

    lines.push(file);
    for (const symbol of visible) lines.push(symbolLine(symbol, graph, options));

    const omitted = inFile.length - visible.length;
    if (omitted > 0) lines.push(`  … ${omitted} more`);
  }

  if (hiddenFiles > 0) {
    lines.push(`… ${hiddenFiles} files (${hiddenSymbols} symbols) not shown`);
  }

  return lines.join("\n");
}

function symbolLine(
  symbol: IndexedSymbol,
  graph: CallGraph,
  { idWidth, maxSignature }: LayoutOptions,
): string {
  const id = symbol.id.slice(0, idWidth);
  const marker = symbol.exported ? "*" : " ";
  const callers = graph.callers.get(symbol.id)?.size ?? 0;
  const inbound = callers > 0 ? ` ←${callers}` : "";

  return `  ${id} ${marker}${qualified(symbol, maxSignature)}  :${symbol.startLine}${inbound}`;
}

/** Methods carry their container, so a line is unambiguous on its own. */
function qualified(symbol: IndexedSymbol, maxSignature: number): string {
  const text = truncate(withContainer(symbol), maxSignature);
  return text;
}

/**
 * Inserts the container immediately before the method's own name.
 *
 * Prefixing the whole signature would work for TypeScript, whose method
 * signatures start with the name, but would render `Service.def run(self)`
 * for Python and `Router.func (r *Router) Handle(…)` for Go.
 */
function withContainer(symbol: IndexedSymbol): string {
  if (symbol.kind !== "method" || !symbol.container) return symbol.signature;

  const at = symbol.signature.indexOf(symbol.name);
  if (at === -1) return `${symbol.container}.${symbol.signature}`;

  return (
    symbol.signature.slice(0, at) +
    `${symbol.container}.` +
    symbol.signature.slice(at)
  );
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}
