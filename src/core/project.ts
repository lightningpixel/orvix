import type {
  IndexedSymbol,
  OrvixIndex,
  PersistedGraph,
  SymbolTable,
} from "../types.js";
import { hashIdentity } from "./ids.js";
import { qualifiedName } from "./symbols.js";
import type { CallGraph } from "./resolve.js";

/** Bump whenever the projected shape changes; older caches are then discarded. */
export const PROJECTION_VERSION = 3;

/**
 * Most files that may reference one name before the name is called "wide".
 *
 * `refsByName` exists to answer "who might resolve differently now?", and for
 * an ordinary name that is a handful of files. But names like `get`, `push`
 * and `map` are referenced almost everywhere, and storing a full file list for
 * each turns a bounded index into a quadratic one — measured at 143 MB on a
 * 8 000-file project. Past the cap the list is dropped and the name is marked
 * wide, which costs a full re-resolve on the rare occasion such a name's
 * exported surface changes, and nothing at all otherwise.
 */
export const WIDE_REFERENCE_CAP = 64;

/** Marker stored in place of a file list for a name referenced too widely. */
export const WIDE = "*";

export interface Projection {
  symbols: SymbolTable;
  graph: PersistedGraph;
}

/**
 * Turns raw facts and a freshly resolved graph into the two files a query
 * reads.
 *
 * Everything expensive happens here, once per index run, so the query path is
 * left with a lookup: no graph construction, no PageRank, no call sites.
 */
export function projectIndex(
  index: OrvixIndex,
  graph: CallGraph,
  ranks: Map<string, number>,
): Projection {
  // Prototype-free throughout: symbol names come from real source, and
  // `constructor`, `toString` and `valueOf` are ordinary method names. On a
  // plain object those keys resolve to inherited functions rather than
  // undefined, so an accumulator would mistake Object.prototype for a bucket
  // it had already created.
  const symbols = bare<IndexedSymbol>();
  const byName = bare<string[]>();
  const byFile = bare<string[]>();
  const refsByName = bare<string[]>();
  const exportSig = bare<string>();

  for (const [file, entry] of Object.entries(index.files)) {
    byFile[file] = entry.symbols.map((symbol) => symbol.id);
    exportSig[file] = exportSignature(entry.symbols);

    for (const symbol of entry.symbols) {
      symbols[symbol.id] = symbol;

      push(byName, symbol.name.toLowerCase(), symbol.id);

      const qualified = qualifiedName(symbol).toLowerCase();
      if (qualified !== symbol.name.toLowerCase()) {
        push(byName, qualified, symbol.id);
      }
    }

    // Recorded per name rather than per resolved edge: an unresolved reference
    // is exactly the one that starts resolving when a new export appears, so
    // it has to stay reachable for invalidation.
    for (const reference of entry.references) {
      addReference(refsByName, reference.name, file);
    }
  }

  return {
    symbols: {
      version: PROJECTION_VERSION,
      symbols,
      byName,
      byFile,
      ranks: Object.fromEntries(ranks),
    },
    graph: {
      version: PROJECTION_VERSION,
      callers: fromSets(graph.callers),
      callees: fromSets(graph.callees),
      fileCallers: fromSets(graph.fileCallers),
      refsByName,
      exportSig,
      // Sorted so a partial rebuild, which appends its own findings to the
      // ones it kept, lands in the same order as a rebuild from nothing.
      ambiguous: [...graph.ambiguous].sort(
        (a, b) =>
          a.file.localeCompare(b.file) || a.line - b.line || a.name.localeCompare(b.name),
      ),
      unresolvedByFile: Object.fromEntries(graph.unresolvedByFile),
      unresolved: [...graph.unresolvedByFile.values()].reduce(
        (total, count) => total + count,
        0,
      ),
    },
  };
}

/**
 * A fingerprint of everything about a file that another file's resolution can
 * depend on: which names it exports, of what kind, with what signature.
 *
 * Deliberately blind to line and byte offsets, so editing a body — the common
 * case by far — leaves every caller alone.
 */
function exportSignature(symbols: IndexedSymbol[]): string {
  const surface = symbols
    .filter((symbol) => symbol.exported)
    .map((symbol) =>
      [qualifiedName(symbol), symbol.kind, symbol.signature].join(" "),
    )
    .sort()
    .join("");

  return hashIdentity(surface);
}

/** An object with no prototype, so every key lookup sees only what was put in. */
function bare<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/** Records that `file` references `name`, collapsing to WIDE past the cap. */
function addReference(
  target: Record<string, string[]>,
  name: string,
  file: string,
): void {
  const bucket = target[name];

  if (!bucket) {
    target[name] = [file];
    return;
  }
  if (bucket[0] === WIDE) return;
  if (bucket[bucket.length - 1] === file) return;

  if (bucket.length >= WIDE_REFERENCE_CAP) {
    target[name] = [WIDE];
    return;
  }

  bucket.push(file);
}

function push(
  target: Record<string, string[]>,
  key: string,
  value: string,
  options: { unique?: boolean } = {},
): void {
  const bucket = target[key];
  if (!bucket) {
    target[key] = [value];
    return;
  }
  if (options.unique && bucket[bucket.length - 1] === value) return;
  bucket.push(value);
}

function fromSets(source: Map<string, Set<string>>): Record<string, string[]> {
  const result = bare<string[]>();
  for (const [key, values] of source) result[key] = [...values].sort();
  return result;
}

/**
 * Serialises a projection with every object key sorted.
 *
 * Ordinary string keys keep insertion order in JavaScript, and incremental
 * reindexing reinserts a rebuilt file's symbols in a different order than a
 * full rebuild produces. Sorting is what lets the two be compared byte for
 * byte, which is how the incremental path is proved to agree with a rebuild.
 */
export function serialise(value: unknown): string {
  return JSON.stringify(value, (_key, raw) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;

    const source = raw as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = source[key];
    return sorted;
  });
}
