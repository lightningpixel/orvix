import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildFileEntry } from "../core/indexer.js";
import { languageForPath, type LanguageDef } from "../core/languages.js";
import { parse } from "../core/parser.js";
import { qualifiedName } from "../core/symbols.js";
import { openQuery, type CommandResult } from "../query/session.js";
import type { IndexedSymbol } from "../types.js";
import { runEdited } from "./edited.js";
import { resolveOrExplain } from "./lookupCommands.js";

export interface ReplaceOptions {
  /** The symbol's new source, declaration included. */
  source: string;
  /** Without it, the change is only described. */
  write?: boolean;
}

/**
 * `orvix replace <id>` — swaps one symbol's source for new text.
 *
 * The counterpart of `show`: an edit tool has to be handed the old text back
 * verbatim to locate it, which costs as many output tokens as the code being
 * replaced. An id already says where the code is.
 *
 * It is the only command that writes to the project, so it is guarded three
 * ways. Nothing is written without `--write`. The symbol is located in the
 * file as it is on disk, never at the offsets the index recorded, which a
 * later edit may have moved. And a replacement that leaves the file unable to
 * parse is refused, unless the file did not parse to begin with.
 */
export async function runReplace(
  path: string,
  query: string,
  options: ReplaceOptions,
): Promise<CommandResult> {
  const replacement = options.source.replace(/\s+$/, "");
  if (replacement.trim().length === 0) {
    return { output: "the replacement is empty; nothing to write", ok: false };
  }

  const session = await openQuery(path);
  const found = resolveOrExplain(session, query);
  if ("failure" in found) return found.failure;

  const { file } = found.symbol;
  const language = languageForPath(file)!;
  const before = await readFile(join(session.root, file), "utf8");

  const current = await locate(file, language, before, found.symbol.id);
  if (!current) {
    return {
      output: `${qualifiedName(found.symbol)} is no longer in ${file}; run \`orvix index\` and look it up again`,
      ok: false,
    };
  }

  const text = withoutRepeatedLead(before, current.startByte, replacement);
  const after = before.slice(0, current.startByte) + text + before.slice(current.endByte);

  if ((await parsesCleanly(before, language)) && !(await parsesCleanly(after, language))) {
    return { output: `refused: ${file} would no longer parse with this replacement`, ok: false };
  }

  const survivor = await locate(file, language, after, current.id);
  const renamed = survivor
    ? ""
    : `\nnote: the replacement renames ${qualifiedName(current)}, so its id [${current.id.slice(0, 4)}] will not survive it`;
  const oldLines = current.endLine - current.startLine + 1;
  const newLines = text.split("\n").length;
  const where = `${qualifiedName(current)} in ${file}:${current.startLine}-${current.endLine}`;

  if (!options.write) {
    return {
      output: `would replace ${where} (${oldLines} lines with ${newLines}). Pass --write to apply.${renamed}`,
      ok: true,
    };
  }

  await writeFile(join(session.root, file), after, "utf8");
  const broken = await runEdited(session.root, file);

  return {
    output: [`replaced ${where} (${oldLines} lines with ${newLines})${renamed}`, broken.output]
      .filter((part) => part.length > 0)
      .join("\n\n"),
    ok: true,
  };
}

/**
 * Drops what the replacement repeats from just before the symbol's range.
 *
 * A range starts at the declaration — after `export`, `public` or `static`,
 * which belong to the enclosing statement — so text copied from the file
 * rather than from `orvix show` carries them twice.
 */
function withoutRepeatedLead(source: string, start: number, replacement: string): string {
  const lineStart = source.lastIndexOf("\n", start - 1) + 1;
  const lead = source.slice(lineStart, start).trimStart();
  const trimmed = replacement.trimStart();
  return lead.length > 0 && trimmed.startsWith(lead) ? trimmed.slice(lead.length) : replacement;
}

/** The symbol's range in this exact text, found by id. */
async function locate(
  file: string,
  language: LanguageDef,
  source: string,
  id: string,
): Promise<IndexedSymbol | undefined> {
  const entry = await buildFileEntry(file, language, source, { mtimeMs: 0, size: 0 });
  return entry.symbols.find((symbol) => symbol.id === id);
}

async function parsesCleanly(source: string, language: LanguageDef): Promise<boolean> {
  const tree = await parse(source, language);
  try {
    return !tree.rootNode.hasError;
  } finally {
    tree.delete();
  }
}

/** Where `orvix replace` reads its text: a file, or stdin when none is named. */
export async function readReplacement(file: string | undefined): Promise<string> {
  if (file) {
    await stat(file);
    return readFile(file, "utf8");
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
