import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { OrvixIndex } from "../types.js";

/** Bump whenever the stored shape changes; older caches are then discarded. */
export const INDEX_VERSION = 1;

export const CACHE_DIR = ".orvix";

export function indexPath(root: string): string {
  return join(root, CACHE_DIR, "index.json");
}

export function emptyIndex(): OrvixIndex {
  return { version: INDEX_VERSION, files: {} };
}

/**
 * Reads the cached index.
 *
 * A missing, unreadable, corrupt or outdated cache is not an error: it just
 * means everything has to be parsed again, which is always safe.
 */
export async function loadIndex(root: string): Promise<OrvixIndex> {
  let raw: string;
  try {
    raw = await readFile(indexPath(root), "utf8");
  } catch {
    return emptyIndex();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyIndex();
  }

  if (!isCurrentIndex(parsed)) return emptyIndex();
  return parsed;
}

export async function saveIndex(
  root: string,
  index: OrvixIndex,
): Promise<void> {
  const path = indexPath(root);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(index), "utf8");
}

function isCurrentIndex(value: unknown): value is OrvixIndex {
  if (typeof value !== "object" || value === null) return false;

  const candidate = value as Partial<OrvixIndex>;
  return (
    candidate.version === INDEX_VERSION &&
    typeof candidate.files === "object" &&
    candidate.files !== null
  );
}
