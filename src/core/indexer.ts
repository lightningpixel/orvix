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
import { emptyIndex, loadIndex, saveIndex } from "./store.js";

export interface BuildResult {
  index: OrvixIndex;
  stats: IndexStats;
  /** Files that could not be indexed, so the caller can report them. */
  skippedFiles: string[];
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
    let facts;
    try {
      facts = await extract(source, language, path);
    } catch {
      stats.skipped += 1;
      skippedFiles.push(path);
      continue;
    }

    // A getter/setter pair or an overload set share file, name and kind, so
    // repeats are numbered. The first keeps the plain identity, which is what
    // keeps its id stable when a sibling is later added.
    const occurrences = new Map<string, number>();

    next.files[path] = {
      language: language.id,
      mtimeMs,
      size,
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
    };

    if (cached) stats.updated += 1;
    else stats.added += 1;
  }

  stats.removed = Object.keys(previous.files).filter(
    (path) => !(path in next.files),
  ).length;

  await saveIndex(root, next);
  return { index: next, stats, skippedFiles };
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

/** Every symbol in the index, in file order. */
export function allSymbols(index: OrvixIndex): IndexedSymbol[] {
  return Object.values(index.files).flatMap((entry: FileEntry) => entry.symbols);
}
