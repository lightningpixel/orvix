import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  FileEntry,
  FileFacts,
  IndexStats,
  IndexedSymbol,
  OrvixIndex,
} from "../types.js";
import { discover } from "./discovery.js";
import { extractFile } from "./extract.js";
import { hashIdentity, symbolIdentity } from "./ids.js";
import {
  languageForPath,
  supportedExtensions,
  type LanguageDef,
} from "./languages.js";
import { packageResolver } from "./packages.js";
import { projectIndex } from "./project.js";
import { rankSymbols } from "./rank.js";
import { buildCallGraph, type CallGraph } from "./resolve.js";
import { emptyIndex, loadIndex, saveIndex, saveProjection } from "./store.js";
import { allSymbols } from "./symbols.js";

export { allSymbols };

export interface BuildResult {
  index: OrvixIndex;
  stats: IndexStats;
  /** Files that could not be indexed, so the caller can report them. */
  skippedFiles: string[];
  /** Derived here rather than per query, and written to disk alongside. */
  graph: CallGraph;
  ranks: Map<string, number>;
}

/**
 * How a file's facts are obtained. Injectable so the failure path — a grammar
 * that will not load, a missing query — can be exercised without contriving a
 * broken installation.
 */
export type Extractor = (
  source: string,
  language: LanguageDef,
  path: string,
) => Promise<FileFacts>;

export interface BuildOptions {
  extract?: Extractor;
  maxFiles?: number;
  maxBytes?: number;
}

/**
 * Refuse rather than crash. Indexing holds every file's symbols and call sites
 * in memory at once, so an unbounded walk — a project with no ignore rules
 * sitting on top of a virtualenv — ends in an out-of-memory abort with nothing
 * to show for it. Failing early says what to do about it instead.
 *
 * Both limits are needed: file count catches sprawling trees, total size
 * catches the few hundred generated files that are individually enormous.
 */
const MAX_FILES = 25_000;
const MAX_BYTES = 64 * 1024 * 1024;

/**
 * Brings the project's index up to date and writes it back.
 *
 * A file is reparsed only when its mtime or size differs from what the cache
 * recorded, so a repeat run over an unchanged project costs one stat() per
 * file rather than a full parse.
 */
export async function buildIndex(
  root: string,
  options: BuildOptions = {},
): Promise<BuildResult> {
  const extract = options.extract ?? ((source, language) => extractFile(source, language));
  const previous = await loadIndex(root);
  const next = emptyIndex();
  const stats: IndexStats = {
    added: 0,
    updated: 0,
    removed: 0,
    unchanged: 0,
    skipped: 0,
  };
  const skippedFiles: string[] = [];

  const paths = await discover(root, { extensions: supportedExtensions() });
  const candidates = await measure(root, paths);
  enforceLimits(candidates, options);

  for (const { path, mtimeMs, size } of candidates) {
    const language = languageForPath(path);
    if (!language) continue;

    const cached = previous.files[path];

    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
      next.files[path] = cached;
      stats.unchanged += 1;
      continue;
    }

    const source = await readFile(join(root, path), "utf8");

    // One unreadable file — a language registered before its query exists, a
    // grammar that fails to load — must not cost the whole index run.
    try {
      next.files[path] = await buildFileEntry(
        path,
        language,
        source,
        { mtimeMs, size },
        extract,
      );
    } catch {
      stats.skipped += 1;
      skippedFiles.push(path);
      continue;
    }

    if (cached) stats.updated += 1;
    else stats.added += 1;
  }

  stats.removed = Object.keys(previous.files).filter(
    (path) => !(path in next.files),
  ).length;

  // The graph and ranks are derived here, once, and written alongside the
  // facts. Deriving them per query was affordable at 226 symbols and is not at
  // 34 000: it made every lookup pay for the size of the project.
  const graph = buildCallGraph(next);
  const ranks = rankSymbols(next, graph);

  await saveIndex(root, next);
  await saveProjection(root, projectIndex(next, graph, ranks, packageResolver(root)));

  return { index: next, stats, skippedFiles, graph, ranks };
}

/**
 * Extracts one file's facts and turns them into an index entry.
 *
 * Shared with the incremental path so a file reindexed after an edit gets
 * exactly the same ids it would from a full build — which is what lets the two
 * be compared byte for byte.
 */
export async function buildFileEntry(
  path: string,
  language: LanguageDef,
  source: string,
  measured: { mtimeMs: number; size: number },
  extract: Extractor = (text, def) => extractFile(text, def),
): Promise<FileEntry> {
  const facts = await extract(source, language, path);

  // A getter/setter pair or an overload set share file, name and kind, so
  // repeats are numbered. The first keeps the plain identity, which is what
  // keeps its id stable when a sibling is later added.
  const occurrences = new Map<string, number>();

  return {
    language: language.id,
    mtimeMs: measured.mtimeMs,
    size: measured.size,
    symbols: facts.symbols.map((symbol): IndexedSymbol => {
      const identity = symbolIdentity(path, symbol);
      const seen = occurrences.get(identity) ?? 0;
      occurrences.set(identity, seen + 1);

      return {
        ...symbol,
        id: hashIdentity(seen === 0 ? identity : `${identity}#${seen + 1}`),
        file: path,
      };
    }),
    references: facts.references,
    imports: facts.imports,
    ...(facts.channels && facts.channels.length > 0 ? { channels: facts.channels } : {}),
  };
}

interface Candidate {
  path: string;
  mtimeMs: number;
  size: number;
}

async function measure(root: string, paths: string[]): Promise<Candidate[]> {
  const measured: Candidate[] = [];

  for (const path of paths) {
    const { mtimeMs, size } = await stat(join(root, path));
    measured.push({ path, mtimeMs, size });
  }

  return measured;
}

function enforceLimits(candidates: Candidate[], options: BuildOptions): void {
  const maxFiles = options.maxFiles ?? MAX_FILES;
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  const advice =
    "Add a .orvixignore listing the generated or vendored directories to skip.";

  if (candidates.length > maxFiles) {
    throw new Error(
      `${candidates.length} source files found, above the ${maxFiles} file limit. ${advice}`,
    );
  }

  const bytes = candidates.reduce((total, file) => total + file.size, 0);
  if (bytes > maxBytes) {
    throw new Error(
      `${Math.round(bytes / 1e6)} MB of source found, above the ${Math.round(maxBytes / 1e6)} MB limit. ${advice}`,
    );
  }
}
