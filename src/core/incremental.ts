import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { buildFileEntry, type Extractor } from "./indexer.js";
import { languageForPath } from "./languages.js";
import { WIDE, projectIndex } from "./project.js";
import { rankSymbols } from "./rank.js";
import { buildCallGraph, type CallGraph } from "./resolve.js";
import { clearDirty, readDirty } from "./state.js";
import {
  loadGraph,
  loadIndex,
  loadSymbols,
  saveIndex,
  saveProjection,
} from "./store.js";
import { qualifiedName } from "./symbols.js";
import type {
  IndexedSymbol,
  OrvixIndex,
  PersistedGraph,
  SymbolTable,
} from "../types.js";

export interface IncrementalResult {
  /** Files reparsed because they changed on disk. */
  reindexed: string[];
  /** Files removed from the index because they are gone. */
  removed: string[];
  /**
   * Files whose call sites were re-resolved. Always a superset of `reindexed`:
   * it also holds the callers pulled in because an exported name changed.
   */
  affected: string[];
}

export interface IncrementalOptions {
  extract?: Extractor;
  /** Recompute PageRank. Off by default — see the note in `reindex`. */
  rerank?: boolean;
}

/**
 * Brings the index up to date for a known set of files.
 *
 * Reparsing is limited to the files that changed, and re-resolution to those
 * plus whichever files could now resolve differently. The set of "could now
 * resolve differently" files is the whole point: reparsing only the edited
 * file leaves every caller pointing at the signature it used to have.
 *
 * PageRank is deliberately not recomputed. It costs 2.1 s on a 8 000-file
 * project — more than everything else here combined — and it only decides the
 * order `orvix map` prints symbols in. Nothing about `show`, `find` or
 * `who-calls` depends on it, so it is refreshed by a full `orvix index` and by
 * the background reconciliation rather than on the path a query waits for.
 */
export async function reindex(
  root: string,
  paths: readonly string[],
  options: IncrementalOptions = {},
): Promise<IncrementalResult> {
  const index = await loadIndex(root);
  const previousGraph = await loadGraph(root);
  const previousTable = await loadSymbols(root);

  const reindexed: string[] = [];
  const removed: string[] = [];
  const changedNames = new Set<string>();

  for (const path of paths) {
    const before = index.files[path];
    const language = languageForPath(path);
    if (!language) continue;

    let measured: { mtimeMs: number; size: number } | undefined;
    try {
      measured = await stat(join(root, path));
    } catch {
      measured = undefined;
    }

    // Gone from disk: drop it, and treat everything it exported as changed so
    // the files that called into it stop pointing at symbols that no longer
    // exist.
    if (!measured) {
      if (before) {
        collectNames(before.symbols, changedNames);
        delete index.files[path];
        removed.push(path);
      }
      continue;
    }

    if (
      before &&
      before.mtimeMs === measured.mtimeMs &&
      before.size === measured.size
    ) {
      continue;
    }

    const source = await readFile(join(root, path), "utf8");

    // One unreadable file must not cost the whole catch-up, exactly as in a
    // full build.
    let entry;
    try {
      entry = await buildFileEntry(path, language, source, measured, options.extract);
    } catch {
      continue;
    }

    if (before) collectNames(before.symbols, changedNames);
    collectNames(entry.symbols, changedNames);

    index.files[path] = entry;
    reindexed.push(path);
  }

  const touched = [...reindexed, ...removed];
  if (touched.length === 0) {
    return { reindexed, removed, affected: [] };
  }

  // A full build inserts files in discovery order, which is sorted. Mutating
  // the map appends a newly added file at the end instead, and everything
  // derived by walking it — the name index above all — then depends on the
  // order edits happened to arrive in. Restoring the canonical order is what
  // keeps an incrementally updated index identical to a rebuilt one.
  canonicalise(index);

  const affected = affectedFiles(index, previousGraph, touched, changedNames);
  const partial = buildCallGraph(index, { only: affected });

  // A deleted file is not in `affected` — it is not in the index at all any
  // more — but its symbols' edges still have to be torn out, so purging is
  // driven by every file that was touched, not just the ones still present.
  const purge = new Set([...affected, ...removed]);
  const merged = spliceGraph(previousGraph, previousTable, partial, affected, purge, index);

  const ranks = options.rerank
    ? rankSymbols(index, toCallGraph(merged))
    : carriedRanks(previousTable, index);

  const projected = projectIndex(index, toCallGraph(merged), ranks);

  await saveIndex(root, index);
  await saveProjection(root, projected);

  return { reindexed, removed, affected: [...affected] };
}

/** Reindexes whatever the dirty log names, then empties it. */
export async function catchUp(
  root: string,
  options: IncrementalOptions = {},
): Promise<IncrementalResult | undefined> {
  const dirty = await readDirty(root);
  if (dirty.length === 0) return undefined;

  const result = await reindex(root, dirty, options);
  await clearDirty(root);
  return result;
}

/**
 * The files whose call sites have to be resolved again.
 *
 * A file that merely had its body edited only invalidates itself. A file whose
 * exported surface changed invalidates every file that mentions one of those
 * names — including files where the name resolved to nothing, because a name
 * that resolves to nothing today starts resolving the moment something exports
 * it.
 */
function affectedFiles(
  index: OrvixIndex,
  graph: PersistedGraph,
  touched: readonly string[],
  changedNames: ReadonlySet<string>,
): Set<string> {
  const affected = new Set(touched.filter((path) => path in index.files));

  for (const name of changedNames) {
    const referencing = graph.refsByName[name];

    // A name referenced too widely to track individually. Rare, and the only
    // safe answer is to re-resolve everything.
    if (referencing?.[0] === WIDE) return new Set(Object.keys(index.files));

    for (const file of referencing ?? []) {
      if (file in index.files) affected.add(file);
    }
  }

  return affected;
}

/**
 * Replaces the affected files' edges with freshly resolved ones.
 *
 * The old edges have to come out first, keyed by the symbols that owned them,
 * or a renamed callee leaves its former edge behind — the ghost edge this
 * whole mechanism exists to prevent.
 */
function spliceGraph(
  previous: PersistedGraph,
  previousTable: SymbolTable,
  partial: CallGraph,
  affected: ReadonlySet<string>,
  purge: ReadonlySet<string>,
  index: OrvixIndex,
): PersistedGraph {
  const callers = new Map<string, Set<string>>();
  const callees = new Map<string, Set<string>>();

  for (const [id, list] of Object.entries(previous.callers)) {
    callers.set(id, new Set(list));
  }
  for (const [id, list] of Object.entries(previous.callees)) {
    callees.set(id, new Set(list));
  }

  // Every symbol that used to live in an affected file, whether or not it
  // still exists: its outgoing edges are stale by definition.
  for (const file of purge) {
    for (const id of previousTable.byFile[file] ?? []) {
      for (const target of callees.get(id) ?? []) {
        callers.get(target)?.delete(id);
      }
      callees.delete(id);
    }
  }

  // Symbols that vanished entirely must not linger as callers of anything.
  const live = new Set<string>();
  for (const entry of Object.values(index.files)) {
    for (const symbol of entry.symbols) live.add(symbol.id);
  }
  for (const [id, sources] of callers) {
    if (!live.has(id)) {
      callers.delete(id);
      continue;
    }
    for (const source of sources) if (!live.has(source)) sources.delete(source);
  }

  // File-scope calls are owned by their file rather than by a symbol, so an
  // affected file's are torn out by name and the dead targets dropped.
  const fileCallers = new Map<string, Set<string>>();
  for (const [id, files] of Object.entries(previous.fileCallers)) {
    if (!live.has(id)) continue;
    fileCallers.set(id, new Set(files.filter((file) => !purge.has(file))));
  }
  for (const [id, files] of partial.fileCallers) {
    const bucket = fileCallers.get(id) ?? new Set<string>();
    for (const file of files) bucket.add(file);
    fileCallers.set(id, bucket);
  }

  for (const [id, sources] of partial.callers) {
    const bucket = callers.get(id) ?? new Set<string>();
    for (const source of sources) bucket.add(source);
    callers.set(id, bucket);
  }
  for (const [id, targets] of partial.callees) {
    const bucket = callees.get(id) ?? new Set<string>();
    for (const target of targets) bucket.add(target);
    callees.set(id, bucket);
  }

  const keptAmbiguous = previous.ambiguous.filter(
    (call) => !affected.has(call.file) && call.file in index.files,
  );

  // Unresolved counts are replaced per affected file rather than carried, or
  // the project-wide total drifts a little further from the truth with every
  // edit until it means nothing.
  const unresolvedByFile: Record<string, number> = {};
  for (const [file, count] of Object.entries(previous.unresolvedByFile)) {
    if (!affected.has(file) && file in index.files) unresolvedByFile[file] = count;
  }
  for (const [file, count] of partial.unresolvedByFile) {
    unresolvedByFile[file] = count;
  }

  return {
    version: previous.version,
    // Emptied entries are dropped rather than left as empty arrays: a full
    // rebuild never creates a key it has no edges for, and the two have to
    // agree exactly.
    callers: fromSets(callers),
    callees: fromSets(callees),
    fileCallers: fromSets(fileCallers),
    refsByName: previous.refsByName,
    exportSig: previous.exportSig,
    ambiguous: [...keptAmbiguous, ...partial.ambiguous],
    unresolvedByFile,
    unresolved: Object.values(unresolvedByFile).reduce((a, b) => a + b, 0),
  };
}

function fromSets(source: Map<string, Set<string>>): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [id, values] of source) {
    if (values.size > 0) result[id] = [...values].sort();
  }
  return result;
}

/** Adapts the persisted shape back to what rank and projection expect. */
function toCallGraph(graph: PersistedGraph): CallGraph {
  const callers = new Map<string, Set<string>>();
  const callees = new Map<string, Set<string>>();

  for (const [id, list] of Object.entries(graph.callers)) callers.set(id, new Set(list));
  for (const [id, list] of Object.entries(graph.callees)) callees.set(id, new Set(list));
  const fileCallers = new Map<string, Set<string>>();
  for (const [id, list] of Object.entries(graph.fileCallers)) fileCallers.set(id, new Set(list));

  return {
    edges: [],
    callers,
    callees,
    fileCallers,
    ambiguous: graph.ambiguous,
    unresolved: graph.unresolved,
    unresolvedByFile: new Map(Object.entries(graph.unresolvedByFile)),
  };
}

/**
 * Keeps the ranks already computed, giving anything new the lowest existing
 * score rather than zero, so a new symbol sorts with its peers instead of
 * falling off the end of the map.
 */
function carriedRanks(
  table: SymbolTable,
  index: OrvixIndex,
): Map<string, number> {
  const existing = Object.values(table.ranks);
  const floor = existing.length > 0 ? Math.min(...existing) : 0;
  const ranks = new Map<string, number>();

  for (const entry of Object.values(index.files)) {
    for (const symbol of entry.symbols) {
      ranks.set(symbol.id, table.ranks[symbol.id] ?? floor);
    }
  }

  return ranks;
}

/** Reorders the index's files to match the order a full build produces. */
function canonicalise(index: OrvixIndex): void {
  const sorted = Object.keys(index.files).sort();
  const files: OrvixIndex["files"] = {};

  for (const path of sorted) files[path] = index.files[path]!;
  index.files = files;
}

/** The names another file's resolution could depend on. */
function collectNames(symbols: IndexedSymbol[], into: Set<string>): void {
  for (const symbol of symbols) {
    into.add(symbol.name);
    into.add(qualifiedName(symbol));
  }
}
