import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { IndexedSymbol } from "../types.js";
import { discover } from "./discovery.js";
import { buildFileEntry } from "./indexer.js";
import { languageForPath, supportedExtensions } from "./languages.js";

const run = promisify(execFile);

export interface FileDiff {
  file: string;
  added: IndexedSymbol[];
  removed: IndexedSymbol[];
  signature: Array<{ before: IndexedSymbol; after: IndexedSymbol }>;
  /** Same id and signature, different source. */
  body: IndexedSymbol[];
}

/**
 * The indexable files that differ between a git ref and the working tree:
 * tracked changes and deletions, plus untracked files git does not ignore.
 *
 * Renames are reported as a deletion and an addition, because that is what
 * they are to a symbol id — the id is derived from the path.
 */
export async function changedFiles(
  root: string,
  ref: string,
): Promise<{ files: string[] } | { error: string }> {
  try {
    await git(root, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    return { error: `${root} is not inside a git repository, which orvix diff compares against` };
  }

  try {
    await git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  } catch {
    return { error: `git does not know the ref "${ref}"` };
  }

  const tracked = await git(root, ["diff", "--name-only", "--no-renames", "--relative", ref, "--"]);
  const untracked = await git(root, ["ls-files", "--others", "--exclude-standard"]);

  // Present files must pass the index's own ignore rules; a deleted one cannot
  // be walked, so its language is the only test left.
  const indexable = new Set(await discover(root, { extensions: supportedExtensions() }));
  const files = [...new Set([...lines(tracked), ...lines(untracked)])]
    .filter((file) => languageForPath(file) !== undefined)
    .filter((file) => indexable.has(file) || !existsSync(join(root, file)))
    .sort();

  return { files };
}

/**
 * Compares one file's symbols at the ref with the working tree, by id.
 *
 * Both versions go through the same extraction as indexing, so their ids are
 * exactly the ones the index hands out, and a symbol whose id survives is the
 * same symbol on both sides.
 */
export async function diffFile(root: string, ref: string, file: string): Promise<FileDiff> {
  const language = languageForPath(file)!;
  const [before, after] = await Promise.all([
    git(root, ["show", `${ref}:./${file}`]).catch(() => undefined),
    readFile(join(root, file), "utf8").catch(() => undefined),
  ]);

  const extract = async (source: string | undefined) =>
    source === undefined
      ? []
      : (await buildFileEntry(file, language, source, { mtimeMs: 0, size: 0 })).symbols;
  const [old, now] = await Promise.all([extract(before), extract(after)]);

  const current = new Map(now.map((symbol) => [symbol.id, symbol]));
  const previous = new Map(old.map((symbol) => [symbol.id, symbol]));
  const diff: FileDiff = { file, added: [], removed: [], signature: [], body: [] };

  for (const symbol of old) {
    const counterpart = current.get(symbol.id);
    if (!counterpart) diff.removed.push(symbol);
    else if (counterpart.signature !== symbol.signature) {
      diff.signature.push({ before: symbol, after: counterpart });
    } else if (slice(before!, symbol) !== slice(after!, counterpart)) {
      diff.body.push(counterpart);
    }
  }
  for (const symbol of now) if (!previous.has(symbol.id)) diff.added.push(symbol);

  return diff;
}

/** A symbol's source, with line endings normalised so a checkout's CRLF is not a change. */
function slice(source: string, symbol: IndexedSymbol): string {
  return source.slice(symbol.startByte, symbol.endByte).replace(/\r\n/g, "\n");
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

function lines(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
