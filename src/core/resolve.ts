import { posix } from "node:path";
import type { FileEntry, IndexedSymbol, OrvixIndex } from "../types.js";
import { supportedExtensions } from "./languages.js";

export interface CallEdge {
  /** Caller symbol id, or null when the call sits at file scope. */
  from: string | null;
  to: string;
}

/** A call site that matched several definitions, kept rather than guessed at. */
export interface AmbiguousCall {
  from: string | null;
  name: string;
  file: string;
  line: number;
  candidates: string[];
}

export interface CallGraph {
  edges: CallEdge[];
  /** callee id -> distinct caller ids. */
  callers: Map<string, Set<string>>;
  /** caller id -> distinct callee ids. */
  callees: Map<string, Set<string>>;
  ambiguous: AmbiguousCall[];
  /** Call sites naming something the project does not define. */
  unresolved: number;
}

/**
 * Extensions tried when an import has none, in priority order. Source
 * extensions come before compiled ones so `./b` from a TypeScript project
 * finds b.ts rather than a stale b.js.
 */
const RESOLUTION_ORDER = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
];

/** Stripped before trying RESOLUTION_ORDER, so `./b.js` can find `b.ts`. */
const STRIPPABLE = new Set(supportedExtensions());

/**
 * Matches call sites to the definitions they reach.
 *
 * Resolution is syntactic — tree-sitter gives names and imports, not types —
 * so it goes from most to least certain: a definition in the same file, then
 * one reached through an import, then a project-wide unique exported name.
 * When several definitions remain plausible, no edge is drawn and the call is
 * recorded in `ambiguous`; guessing would be worse than admitting the gap.
 */
export function buildCallGraph(index: OrvixIndex): CallGraph {
  const graph: CallGraph = {
    edges: [],
    callers: new Map(),
    callees: new Map(),
    ambiguous: [],
    unresolved: 0,
  };

  const exportedByName = groupExportedByName(index);

  for (const [file, entry] of Object.entries(index.files)) {
    const local = groupByName(entry.symbols);
    const imported = importedSymbols(index, file, entry);

    for (const reference of entry.references) {
      const from =
        reference.fromSymbol === null
          ? null
          : (entry.symbols[reference.fromSymbol]?.id ?? null);

      const reachable = (bucket: IndexedSymbol[] | undefined) => {
        const filtered = bucket?.filter((symbol) =>
          reference.viaMember
            ? symbol.kind === "method"
            : symbol.kind !== "method",
        );
        return filtered && filtered.length > 0 ? filtered : undefined;
      };

      const candidates =
        reachable(local.get(reference.name)) ??
        reachable(imported.get(reference.name)) ??
        reachable(exportedByName.get(reference.name));

      if (!candidates || candidates.length === 0) {
        graph.unresolved += 1;
        continue;
      }

      if (candidates.length > 1) {
        graph.ambiguous.push({
          from,
          name: reference.name,
          file,
          line: reference.line,
          candidates: candidates.map((symbol) => symbol.id).sort(),
        });
        continue;
      }

      const to = candidates[0]!.id;
      graph.edges.push({ from, to });

      if (from !== null) {
        addTo(graph.callers, to, from);
        addTo(graph.callees, from, to);
      }
    }
  }

  return graph;
}

function addTo(
  map: Map<string, Set<string>>,
  key: string,
  value: string,
): void {
  const existing = map.get(key);
  if (existing) existing.add(value);
  else map.set(key, new Set([value]));
}

function groupByName(symbols: IndexedSymbol[]): Map<string, IndexedSymbol[]> {
  const grouped = new Map<string, IndexedSymbol[]>();

  for (const symbol of symbols) {
    const bucket = grouped.get(symbol.name);
    if (bucket) bucket.push(symbol);
    else grouped.set(symbol.name, [symbol]);
  }

  return grouped;
}

function groupExportedByName(index: OrvixIndex): Map<string, IndexedSymbol[]> {
  const exported = Object.values(index.files).flatMap((entry) =>
    entry.symbols.filter((symbol) => symbol.exported),
  );

  return groupByName(exported);
}

/** Names this file imports, mapped to the definitions they point at. */
function importedSymbols(
  index: OrvixIndex,
  file: string,
  entry: FileEntry,
): Map<string, IndexedSymbol[]> {
  const resolved = new Map<string, IndexedSymbol[]>();

  for (const statement of entry.imports) {
    const target = resolveModule(index, file, statement.source);
    if (!target) continue;

    const exported = index.files[target]?.symbols.filter((s) => s.exported);
    if (!exported) continue;

    for (const name of statement.names) {
      const match = exported.filter((symbol) => symbol.name === name);
      if (match.length > 0) resolved.set(name, match);
    }
  }

  return resolved;
}

/**
 * Turns an import specifier into an indexed file path, or undefined for
 * anything outside the project (bare package names, node: builtins).
 */
function resolveModule(
  index: OrvixIndex,
  fromFile: string,
  specifier: string,
): string | undefined {
  if (!specifier.startsWith(".")) return undefined;

  const base = posix.normalize(
    posix.join(posix.dirname(fromFile), stripExtension(specifier)),
  );

  for (const candidate of candidatePaths(base)) {
    if (candidate in index.files) return candidate;
  }

  return undefined;
}

function stripExtension(specifier: string): string {
  const ext = posix.extname(specifier);
  return STRIPPABLE.has(ext.toLowerCase())
    ? specifier.slice(0, -ext.length)
    : specifier;
}

function* candidatePaths(base: string): Generator<string> {
  for (const ext of RESOLUTION_ORDER) yield `${base}${ext}`;
  for (const ext of RESOLUTION_ORDER) yield `${base}/index${ext}`;
}
