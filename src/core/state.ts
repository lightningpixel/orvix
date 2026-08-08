import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CACHE_DIR } from "./store.js";

/**
 * The dirty log: files edited since the index was last brought up to date.
 *
 * Append-only, one path per line, rather than a JSON object. Appending is a
 * single syscall with no read-modify-write, so two hooks firing at once cannot
 * lose an entry between them — which a rewritten JSON file would.
 */
export function dirtyPath(root: string): string {
  return join(root, CACHE_DIR, "dirty");
}

export async function markDirty(
  root: string,
  files: readonly string[],
): Promise<void> {
  if (files.length === 0) return;

  const path = dirtyPath(root);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, files.map((file) => `${file}\n`).join(""), "utf8");
}

/** Every distinct path in the log, in the order first seen. */
export async function readDirty(root: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(dirtyPath(root), "utf8");
  } catch {
    return [];
  }

  const seen = new Set<string>();
  for (const line of raw.split("\n")) {
    const path = line.trim();
    if (path.length > 0) seen.add(path);
  }

  return [...seen];
}

export async function clearDirty(root: string): Promise<void> {
  await rm(dirtyPath(root), { force: true });
}
