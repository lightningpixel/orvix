import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { OrvixIndex, PersistedGraph, SymbolTable } from "../types.js";
import { PROJECTION_VERSION, serialise, type Projection } from "./project.js";

/** Bump whenever the stored shape changes; older caches are then discarded. */
export const INDEX_VERSION = 2;

export const CACHE_DIR = ".orvix";

/**
 * The cache is split by who reads it.
 *
 * `facts.json` holds every call site and is only opened when reindexing.
 * `symbols.json` and `graph.json` are what a query reads, and between them
 * they are roughly a quarter of the whole — call sites outnumber symbols by
 * ten to one — so keeping them apart is what stops a lookup from paying for
 * the size of the project.
 */
export function indexPath(root: string): string {
  return join(root, CACHE_DIR, "facts.json");
}

export function symbolsPath(root: string): string {
  return join(root, CACHE_DIR, "symbols.json");
}

export function graphPath(root: string): string {
  return join(root, CACHE_DIR, "graph.json");
}

export function emptyIndex(): OrvixIndex {
  return { version: INDEX_VERSION, files: {} };
}

export function emptySymbols(): SymbolTable {
  return {
    version: PROJECTION_VERSION,
    symbols: {},
    byName: {},
    byFile: {},
    ranks: {},
  };
}

export function emptyGraph(): PersistedGraph {
  return {
    version: PROJECTION_VERSION,
    callers: {},
    callees: {},
    fileCallers: {},
    refsByName: {},
    exportSig: {},
    ambiguous: [],
    unresolvedByFile: {},
    unresolved: 0,
  };
}

/**
 * Reads the cached facts.
 *
 * A missing, unreadable, corrupt or outdated cache is not an error: it just
 * means everything has to be parsed again, which is always safe.
 */
export async function loadIndex(root: string): Promise<OrvixIndex> {
  return (
    (await readJson(indexPath(root), (value) => isVersioned(value, INDEX_VERSION) && hasFiles(value))) ??
    emptyIndex()
  );
}

export async function loadSymbols(root: string): Promise<SymbolTable> {
  const table = await readJson<SymbolTable>(symbolsPath(root), (value) =>
    isVersioned(value, PROJECTION_VERSION),
  );
  if (!table) return emptySymbols();

  harden(table, ["symbols", "byName", "byFile", "ranks"]);
  return table;
}

export async function loadGraph(root: string): Promise<PersistedGraph> {
  const graph = await readJson<PersistedGraph>(graphPath(root), (value) =>
    isVersioned(value, PROJECTION_VERSION),
  );
  if (!graph) return emptyGraph();

  harden(graph, ["callers", "callees", "fileCallers", "refsByName", "exportSig"]);
  return graph;
}

/**
 * Detaches Object.prototype from the parsed lookup tables.
 *
 * JSON.parse always returns plain objects, so `byName["toString"]` would come
 * back as an inherited function and a miss would read as a hit. Setting the
 * prototype is O(1) per table, unlike rebuilding them key by key — which
 * matters because this runs on every query.
 */
function harden<T extends object>(target: T, keys: (keyof T)[]): void {
  for (const key of keys) {
    const table = target[key];
    if (typeof table === "object" && table !== null) {
      Object.setPrototypeOf(table, null);
    }
  }
}

export async function saveIndex(
  root: string,
  index: OrvixIndex,
): Promise<void> {
  await write(indexPath(root), JSON.stringify(index));
}

/**
 * Writes the two files a query reads.
 *
 * Serialised with sorted keys so two runs over the same project produce
 * byte-identical output, which is what lets an incremental rebuild be checked
 * against a full one.
 */
export async function saveProjection(
  root: string,
  projection: Projection,
): Promise<void> {
  await write(symbolsPath(root), serialise(projection.symbols));
  await write(graphPath(root), serialise(projection.graph));
}

async function write(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
}

async function readJson<T>(
  path: string,
  valid: (value: unknown) => boolean,
): Promise<T | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  return valid(parsed) ? (parsed as T) : undefined;
}

function isVersioned(value: unknown, version: number): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { version?: unknown }).version === version
  );
}

function hasFiles(value: unknown): boolean {
  const files = (value as { files?: unknown }).files;
  return typeof files === "object" && files !== null;
}
